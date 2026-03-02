import { Router, Response } from 'express';
import { db } from '../../db/database.js';
import { authMiddleware } from '../../middleware/auth.js';
import { ok } from '../../types/index.js';

export const otaUpgradeRouter = Router();

interface OtaVersionRow {
  id: number;
  version: string;
  device_type: string;
  release_notes: string | null;
  download_url: string | null;
  md5: string | null;
  created_at: string;
}

// GET /api/nova-user/otaUpgrade/checkOtaNewVersion?version=&equipmentType=&sn=
otaUpgradeRouter.get('/checkOtaNewVersion', authMiddleware, (req, res: Response) => {
  const currentVersion = req.query.version as string | undefined;
  const equipmentType = req.query.equipmentType as string | undefined;
  const sn = req.query.sn as string | undefined;

  // Bepaal device type uit equipmentType of sn
  const isCharger = equipmentType?.startsWith('LFIC') || sn?.startsWith('LFIC');
  const deviceType = isCharger ? 'charger' : 'mower';

  console.log(`\x1b[38;5;208m[OTA] checkOtaNewVersion version=${currentVersion} equipmentType=${equipmentType} sn=${sn} → deviceType=${deviceType}\x1b[0m`);

  // ── Lokale-eerst strategie: check eerst de lokale DB ──
  const latest = db.prepare(`
    SELECT * FROM ota_versions
    WHERE device_type = ?
    ORDER BY id DESC LIMIT 1
  `).get(deviceType) as OtaVersionRow | undefined;

  if (latest && latest.version !== currentVersion) {
    console.log(`\x1b[38;5;208m[OTA] Lokale versie gevonden: ${latest.version} (huidig: ${currentVersion}) — update beschikbaar\x1b[0m`);
    // Cloud-identiek formaat: upgradeFlag=1 = update beschikbaar
    res.json(ok({
      version: latest.version,
      upgradeType: 'serviceUpgrade',
      md5: latest.md5 ?? '',
      downloadUrl: latest.download_url,
      upgradeFlag: 1,
      environment: 'trial',
      dependenceSystemVersionList: null,
    }));
    return;
  }

  if (latest && latest.version === currentVersion) {
    console.log(`\x1b[38;5;208m[OTA] Lokale versie ${latest.version} is gelijk aan huidige — geen update\x1b[0m`);
    res.json(ok({ upgradeFlag: 0 }));
    return;
  }

  // Geen lokale versie gevonden — geen update (cloud is niet bereikbaar via DNS redirect)
  if (!latest) {
    console.log(`\x1b[38;5;208m[OTA] Geen lokale versie voor ${deviceType} — geen update\x1b[0m`);
    res.json(ok({ upgradeFlag: 0 }));
    return;
  }

  // Fallback: zou niet bereikt moeten worden, maar voor de zekerheid
  res.json(ok({ upgradeFlag: 0 }));
});
