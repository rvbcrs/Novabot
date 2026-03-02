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

  // ── Check lokale DB voor nieuwere versie ──
  const latest = db.prepare(`
    SELECT * FROM ota_versions
    WHERE device_type = ?
    ORDER BY id DESC LIMIT 1
  `).get(deviceType) as OtaVersionRow | undefined;

  if (latest && latest.version !== currentVersion) {
    // Zorg dat URL altijd http:// is (lokale server heeft geen TLS)
    const downloadUrl = latest.download_url?.replace(/^https:\/\//, 'http://') ?? '';
    console.log(`\x1b[38;5;208m[OTA] Update beschikbaar: ${latest.version} (huidig: ${currentVersion}) url=${downloadUrl}\x1b[0m`);
    res.json(ok({
      version: latest.version,
      downloadUrl,
      md5: latest.md5 ?? '',
      upgradeFlag: 1,
      releaseNotes: latest.release_notes,
    }));
    return;
  }

  // Geen update — retourneer null (cloud-identiek)
  console.log(`\x1b[38;5;208m[OTA] Geen update voor ${deviceType} (huidig: ${currentVersion})\x1b[0m`);
  res.json(ok(null));
});
