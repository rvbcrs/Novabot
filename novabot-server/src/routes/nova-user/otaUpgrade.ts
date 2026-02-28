import { Router, Response } from 'express';
import https from 'node:https';
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

  console.log(`[OTA] checkOtaNewVersion version=${currentVersion} equipmentType=${equipmentType} sn=${sn} → deviceType=${deviceType}`);

  // ── Lokale-eerst strategie: check eerst de lokale DB ──
  const latest = db.prepare(`
    SELECT * FROM ota_versions
    WHERE device_type = ?
    ORDER BY id DESC LIMIT 1
  `).get(deviceType) as OtaVersionRow | undefined;

  if (latest && latest.version !== currentVersion) {
    console.log(`[OTA] Lokale versie gevonden: ${latest.version} (huidig: ${currentVersion}) — skip cloud`);
    res.json(ok({
      version: latest.version,
      downloadUrl: latest.download_url,
      md5: latest.md5 ?? '',
      upgradeFlag: 1,
      releaseNotes: latest.release_notes,
    }));
    return;
  }

  if (latest && latest.version === currentVersion) {
    console.log(`[OTA] Lokale versie ${latest.version} is gelijk aan huidige — check cloud`);
  }

  // ── Fallback: cloud proxying ──
  const cloudPath = `/api/nova-user/otaUpgrade/checkOtaNewVersion?version=${encodeURIComponent(currentVersion ?? '')}`
    + (equipmentType ? `&upgradeType=serviceUpgrade&equipmentType=${encodeURIComponent(equipmentType)}` : '')
    + (sn ? `&sn=${encodeURIComponent(sn)}` : '');
  const authHeader = req.headers['authorization'] as string | undefined;

  const cloudReq = https.request({
    hostname: '47.253.145.99',
    port: 443,
    path: cloudPath,
    method: 'GET',
    headers: {
      'host': 'app.lfibot.com',
      'content-type': 'application/json',
      ...(authHeader ? { 'authorization': authHeader } : {}),
    },
    servername: 'app.lfibot.com',
    rejectUnauthorized: false,
  }, (cloudRes) => {
    const chunks: Buffer[] = [];
    cloudRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    cloudRes.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      console.log(`[OTA] Cloud response: ${body}`);

      try {
        const parsed = JSON.parse(body);
        res.json(parsed);
      } catch {
        console.log('[OTA] Cloud response ongeldig — geen update');
        res.json(ok({ upgradeFlag: 0 }));
      }
    });
  });

  cloudReq.on('error', (err) => {
    console.log(`[OTA] Cloud niet bereikbaar: ${err.message} — geen update`);
    res.json(ok({ upgradeFlag: 0 }));
  });

  cloudReq.end();
});
