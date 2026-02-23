import { Router, Response } from 'express';
import { db } from '../../db/database.js';
import { authMiddleware } from '../../middleware/auth.js';
import { ok } from '../../types/index.js';

export const otaUpgradeRouter = Router();

// GET /api/nova-user/otaUpgrade/checkOtaNewVersion?version=
otaUpgradeRouter.get('/checkOtaNewVersion', authMiddleware, (req, res: Response) => {
  const currentVersion = req.query.version as string | undefined;

  // Return the latest version row if it is newer than what the device reports.
  // If you don't want to offer OTA updates, just return hasNewVersion: false.
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
});
