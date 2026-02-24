import { Router, Response } from 'express';
import https from 'node:https';
import { db } from '../../db/database.js';
import { authMiddleware } from '../../middleware/auth.js';
import { ok } from '../../types/index.js';

export const otaUpgradeRouter = Router();

// GET /api/nova-user/otaUpgrade/checkOtaNewVersion?version=
otaUpgradeRouter.get('/checkOtaNewVersion', authMiddleware, (req, res: Response) => {
  const currentVersion = req.query.version as string | undefined;
  console.log(`[OTA] checkOtaNewVersion version=${currentVersion}`);

  // Probeer eerst de echte cloud te vragen (om firmware URL te achterhalen)
  const cloudPath = `/api/nova-user/otaUpgrade/checkOtaNewVersion?version=${encodeURIComponent(currentVersion ?? '')}`;
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

      // Stuur cloud response door naar de app
      try {
        const parsed = JSON.parse(body);
        res.json(parsed);
      } catch {
        // Cloud niet bereikbaar of ongeldig response — fallback naar lokale DB
        localFallback();
      }
    });
  });

  cloudReq.on('error', (err) => {
    console.log(`[OTA] Cloud niet bereikbaar: ${err.message} — lokale fallback`);
    localFallback();
  });

  cloudReq.end();

  function localFallback() {
    const latest = db.prepare(`
      SELECT * FROM ota_versions
      WHERE device_type = 'mower'
      ORDER BY id DESC LIMIT 1
    `).get() as { version: string; download_url: string | null; release_notes: string | null } | undefined;

    if (!latest || latest.version === currentVersion) {
      res.json(ok({ hasNewVersion: false }));
      return;
    }

    res.json(ok({
      hasNewVersion: true,
      newVersion: latest.version,
      downloadUrl: latest.download_url,
      releaseNotes: latest.release_notes,
    }));
  }
});
