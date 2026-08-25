/**
 * Admin Status API — server health, users, devices, errors
 * Protected by authMiddleware + adminMiddleware
 */

import { Router, Response } from 'express';
import express from 'express';
import os from 'os';
import dns from 'dns';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { db } from '../db/database.js';
import { isDeviceOnline, banishSn, unbanSn, listBannedSns } from '../mqtt/broker.js';
import { awaitCommand, publishToDevice, publishToExtended, onExtendedResponse, offExtendedResponse, applyVerbatimToMower } from '../mqtt/mapSync.js';
import { userRepo, equipmentRepo, deviceRepo, mapRepo, otaVersionRepo, walkerBundleRepo, signalHistoryRepo } from '../db/repositories/index.js';
import type { WalkerBundleRow } from '../db/repositories/index.js';
import { AuthRequest } from '../types/index.js';
import { invalidateSetupCache } from '../middleware/setupGuard.js';
import { parseMapZip, MapArea } from '../mqtt/mapConverter.js';
import { startMdnsAdvertiser, stopMdnsAdvertiser, getActiveAdvertisement } from '../services/mdnsAdvertiser.js';
import { listBackups, backupPath, regenerateLatestZipFromBackup } from '../services/mapBackup.js';
import { getPolygonAnchor } from '../services/anchor.js';
import { markFrameUnvalidated } from '../services/frameValidation.js';
import { exportBundle, parseBundle, BundleValidationError, computeAnchorRebase, type ParsedBundle } from '../services/portableMap.js';
import { synthesizePortableFromWalker } from '../maps/walkerBundleImporter.js';
import { buildMaskOverlay, parsePgm } from '../maps/maskOverlay.js';
import { ImportStagingStore } from '../services/importStaging.js';
import { getDeviceHealth } from '../services/deviceHealth.js';
import { classifyBundle, type ClassifyResult } from '../services/bundleClassifier.js';
import { importAuditRepo } from '../db/repositories/importAudit.js';
import { deriveHeading } from '../services/driveCalibration.js';
import {
  getMowerFileCapability,
  MOWER_FILE_WRITE_UNSUPPORTED_CODE,
  MOWER_FILE_WRITE_UNSUPPORTED_MESSAGE,
} from '../services/mowerFileCapability.js';
import {
  deviceCache,
  getValidationTrail,
  clearValidationTrail,
  getLocalTrail,
} from '../mqtt/sensorData.js';
import { gpsToLocal, metersPerDegLat, metersPerDegLng } from '../mqtt/mapConverter.js';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import https from 'https';
import http from 'http';
import bcrypt from 'bcrypt';
import unzipper from 'unzipper';

export const MANIFEST_URL = 'https://downloads.ramonvanbruggen.nl/opennova-manifest.json';

interface FirmwareManifestEntry {
  version: string;
  device_type: string;
  url: string;
  md5?: string;
  sha256?: string;
  size?: number;
  signature?: string;
  signing_key_id?: string;
  signingKeyId?: string;
  keyId?: string;
  description?: string;
  filename?: string;
}

/**
 * Issue #26: the published manifest still references the legacy host
 * `download.ramonvanbruggen.nl/file/...` — both wrong:
 *   - `download.` (singular) host doesn't resolve DNS — must be plural
 *     `downloads.ramonvanbruggen.nl`.
 *   - The `/file/` path segment was a Backblaze public-bucket artifact;
 *     the live host serves files at the root (`/<filename>.deb`).
 *
 * Rewrite both at the server boundary so the URL works regardless of when
 * the manifest is regenerated.
 */
export function normaliseFirmwareDownloadUrl(url: string): string {
  return url
    .replace(
      /https?:\/\/download\.ramonvanbruggen\.nl/gi,
      'https://downloads.ramonvanbruggen.nl',
    )
    .replace(
      /https:\/\/downloads\.ramonvanbruggen\.nl\/file\//gi,
      'https://downloads.ramonvanbruggen.nl/',
    );
}

export const adminStatusRouter = Router();

const importStaging = new ImportStagingStore(
  path.resolve(process.env.STORAGE_PATH ?? './storage', 'imports'),
);
const bundleUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function mowerFileUnsupportedPayload(sn: string) {
  const capability = getMowerFileCapability(sn);
  return {
    ok: false,
    code: MOWER_FILE_WRITE_UNSUPPORTED_CODE,
    error: capability.reason ?? MOWER_FILE_WRITE_UNSUPPORTED_MESSAGE,
    targetSn: sn,
    ...capability,
  };
}

// Multer middleware exposed so index.ts can mount the same handler on a
// public (no-auth) path for the walker upload. Walker has no good way to
// hold a Bearer token, and the threat model is LAN-only — anyone on the
// LAN can already reach the walker's own HTTP server. Assign-to-mower
// downstream STILL requires admin auth, so a stray upload can't actually
// reach a mower without operator confirmation.
export const walkerBundleUploadMulter = bundleUpload.single('bundle');

// Walker bundle library — SN-agnostic store on disk. The walker uploads here
// once; the operator assigns the bundle to a specific mower later via the
// admin UI. Directory is created on first use so a fresh install doesn't
// need an extra bootstrap step.
const walkerBundlesDir = process.env.WALKER_BUNDLES_PATH ?? path.resolve(
  process.env.STORAGE_PATH ?? './storage',
  'walker-bundles',
);
try { fs.mkdirSync(walkerBundlesDir, { recursive: true }); } catch { /* ignore — handler will throw on write */ }


// Read version once at startup
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname_admin = dirname(fileURLToPath(import.meta.url));
let SERVER_VERSION = '?';
try { SERVER_VERSION = JSON.parse(fs.readFileSync(join(__dirname_admin, '../../package.json'), 'utf8')).version; } catch { /* ignore */ }

// GET /api/admin-status/overview
adminStatusRouter.get('/overview', (_req: AuthRequest, res: Response) => {
  const uptime = process.uptime();
  const mem = process.memoryUsage();

  // DB stats
  const userCount = userRepo.count();
  const equipmentCount = equipmentRepo.count();
  const deviceCount = deviceRepo.countAll();
  const mapCount = mapRepo.count();

  // DB file size
  let dbSize = 0;
  try {
    const dbPath = process.env.DB_PATH || 'novabot.db';
    const stat = fs.statSync(dbPath);
    dbSize = stat.size;
  } catch {}

  // Current user info from JWT
  const currentUser = _req.userId ? userRepo.findById(_req.userId) : undefined;

  res.json({
    server: {
      version: SERVER_VERSION,
      uptime: Math.round(uptime),
      uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      nodeVersion: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      memoryMB: Math.round(mem.rss / 1024 / 1024),
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      dbSizeMB: Math.round(dbSize / 1024 / 1024 * 10) / 10,
    },
    counts: {
      users: userCount,
      equipment: equipmentCount,
      devices: deviceCount,
      maps: mapCount,
    },
    currentUser: currentUser ? {
      email: currentUser.email,
      is_admin: currentUser.is_admin === 1,
      dashboard_access: currentUser.dashboard_access === 1,
    } : null,
  });
});

// GET /api/admin-status/users — all users with their equipment
adminStatusRouter.get('/users', (_req: AuthRequest, res: Response) => {
  const users = userRepo.listWithEquipmentSummary();

  // Also get all equipment (including unbound)
  const allEquipment = equipmentRepo.listAll();

  // Count unbound equipment
  const unboundCount = allEquipment.filter((e) => !e.user_id).length;

  res.json({ users, allEquipment, unboundCount });
});

// GET /api/admin-status/devices — known Novabot devices with online status
adminStatusRouter.get('/devices', (_req: AuthRequest, res: Response) => {
  const rows = deviceRepo.listAdminDevices();

  // Override is_online met de runtime broker state. De SQL threshold
  // (`julianday('now') - last_seen < 0.003` = 259s) is te traag voor een
  // fijne UX — na een abrupt power-off / WiFi drop blijft de UI tot
  // ~4 minuten "Online" tonen. De MQTT broker weet binnen 45s (stale
  // sweeper, zie broker.ts) dat het device stil is. Gebruik die als
  // waarheid zodat de admin UI in sync is met /device-sets.
  const devices = rows.map(r => ({
    ...r,
    is_online: r.sn && isDeviceOnline(r.sn) ? 1 : 0,
    health: r.sn ? getDeviceHealth(r.sn) : null,
  }));

  res.json({ devices });
});

// GET /api/admin-status/health/:sn — explicit single-device health probe
// (LoRa pair mismatch + mower_error). Same shape as `health` field on
// /devices, exposed separately for clients that only need one device.
adminStatusRouter.get('/health/:sn', (req: AuthRequest, res: Response) => {
  const { sn } = req.params;
  if (!sn) {
    res.status(400).json({ ok: false, error: 'sn required' });
    return;
  }
  res.json({ ok: true, health: getDeviceHealth(sn) });
});

// POST /api/admin-status/bind-device — bind unbound device to current user
adminStatusRouter.post('/bind-device', (_req: AuthRequest, res: Response) => {
  const { sn } = _req.body as { sn?: string };
  if (!sn || !_req.userId) {
    res.status(400).json({ error: 'sn required' });
    return;
  }

  // Check if equipment exists
  const existing = equipmentRepo.findBySn(sn);

  if (existing) {
    // Update existing — set user_id
    equipmentRepo.setUserId(existing.equipment_id, _req.userId);
  } else {
    // Create new equipment record
    const equipmentId = crypto.randomUUID();
    const isCharger = sn.startsWith('LFIC');
    equipmentRepo.create({
      equipment_id: equipmentId,
      user_id: _req.userId,
      mower_sn: sn,
      charger_sn: isCharger ? sn : null,
    });
  }

  console.log(`[Admin] Device ${sn} bound to user ${_req.userId}`);
  res.json({ ok: true });
});

// POST /api/admin-status/send-command — generic MQTT command sender
//
// Stuurt een Dart/Send_mqtt/<SN> command naar een device en (optioneel) wacht
// op het bijbehorende *_respond. Antwoord bevat ofwel de response-data, ofwel
// { sent: true } als noWait=true.
//
// Body: {
//   sn: string,                 // Doelapparaat (LFIN* of LFIC*)
//   command: string,            // bijv. "get_signal_info", "get_lora_info"
//   payload?: unknown,          // JSON payload, default null
//   timeoutMs?: number,         // max wachttijd voor respond, default 5000
//   noWait?: boolean            // true = fire-and-forget
// }
adminStatusRouter.post('/send-command', async (req: AuthRequest, res: Response) => {
  const { sn, command, payload, timeoutMs, noWait } = req.body as {
    sn?: string;
    command?: string;
    payload?: unknown;
    timeoutMs?: number;
    noWait?: boolean;
  };

  if (!sn || !command) {
    res.status(400).json({ error: 'sn and command required' });
    return;
  }
  if (!isDeviceOnline(sn)) {
    res.status(409).json({ error: 'device not online', sn });
    return;
  }

  try {
    if (noWait) {
      publishToDevice(sn, { [command]: payload ?? null });
      console.log(`[Admin] send-command (noWait) ${command} → ${sn}`);
      res.json({ ok: true, sent: true, sn, command });
      return;
    }

    console.log(`[Admin] send-command ${command} → ${sn} (await respond)`);
    const data = await awaitCommand(sn, command, payload ?? null, timeoutMs ?? 5000);
    res.json({ ok: true, sn, command, respond: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'send-command failed';
    console.warn(`[Admin] send-command ${command} → ${sn} failed: ${msg}`);
    res.status(504).json({ error: msg, sn, command });
  }
});

// POST /api/admin-status/banish-device — delete device fully + block MQTT
// reconnects for N minutes. Gebruikt door de "Delete + Banish" flow wanneer
// user een device wil re-provisionen via de officiële Novabot app. Zonder
// deze ban zou ons broker de device binnen 30s weer accepteren (DNS van
// mqtt.lfibot.com → onze server). Ban voorkomt dat + wist DB rijen zodat
// user een clean-slate kan bouwen. Na ban-expiry connect device normaal
// opnieuw.
adminStatusRouter.post('/banish-device', (_req: AuthRequest, res: Response) => {
  const { sn, minutes } = _req.body as { sn?: string; minutes?: number };
  if (!sn) { res.status(400).json({ error: 'sn required' }); return; }
  const durationMs = Math.max(1, Math.min(minutes ?? 120, 1440)) * 60 * 1000;

  // Full cascade delete — MAPS BLIJVEN (user-spec 2026-04-22). Zelfde
  // cleanup als /api/nova-user/equipment/unboundEquipment: wist equipment
  // + alle per-SN / per-equipment_id tabellen, maar laat maps/map_uploads/
  // map_calibration/virtual_walls staan.
  try {
    const equip = equipmentRepo.findBySn(sn);
    const mowerSn = equip?.mower_sn;
    const chargerSn = equip?.charger_sn;
    const equipmentIdStr = equip?.equipment_id;
    const snsToClean: string[] = [sn];
    if (mowerSn && !snsToClean.includes(mowerSn)) snsToClean.push(mowerSn);
    if (chargerSn && !snsToClean.includes(chargerSn)) snsToClean.push(chargerSn);

    const tx = db.transaction(() => {
      if (equipmentIdStr) {
        db.prepare('DELETE FROM equipment WHERE equipment_id = ?').run(equipmentIdStr);
        db.prepare('DELETE FROM cut_grass_plans WHERE equipment_id = ?').run(equipmentIdStr);
        try { db.prepare('DELETE FROM work_records WHERE equipment_id = ?').run(equipmentIdStr); } catch { /* ignore */ }
        try { db.prepare('DELETE FROM robot_messages WHERE equipment_id = ?').run(equipmentIdStr); } catch { /* ignore */ }
      }
      for (const s of snsToClean) {
        db.prepare('DELETE FROM equipment_lora_cache WHERE sn = ?').run(s);
        db.prepare('DELETE FROM device_registry WHERE sn = ?').run(s);
        try { db.prepare('DELETE FROM signal_history WHERE sn = ?').run(s); } catch { /* ignore */ }
        try { db.prepare('DELETE FROM device_settings WHERE sn = ?').run(s); } catch { /* ignore */ }
        try { db.prepare('DELETE FROM rain_sessions WHERE mower_sn = ?').run(s); } catch { /* ignore */ }
      }
      if (mowerSn) {
        try { db.prepare('DELETE FROM dashboard_schedules WHERE mower_sn = ?').run(mowerSn); } catch { /* ignore */ }
      }
      // MAPS/map_uploads/map_calibration/virtual_walls BLIJVEN INTACT.
    });
    tx();
    console.log(`[BAN] Full cascade delete voor ${sn} (equip=${equipmentIdStr}, SNs=[${snsToClean.join(',')}]) — maps preserved`);
  } catch (e) {
    console.log(`[BAN] Cascade error for ${sn}: ${e}`);
  }

  // 2. Voeg toe aan in-memory ban list + force-disconnect eventuele actieve sessie
  banishSn(sn, durationMs);

  res.json({ ok: true, sn, banExpiresInMs: durationMs });
});

// POST /api/admin-status/unbanish-device — release a banned SN early so het
// device weer normaal mag connecten. Zonder call expired de ban automatisch
// na de durationMs van banish-device.
adminStatusRouter.post('/unbanish-device', (_req: AuthRequest, res: Response) => {
  const { sn } = _req.body as { sn?: string };
  if (!sn) { res.status(400).json({ error: 'sn required' }); return; }
  unbanSn(sn);
  res.json({ ok: true, sn });
});

// GET /api/admin-status/banned-devices — lijst van actieve bans voor UI.
adminStatusRouter.get('/banned-devices', (_req: AuthRequest, res: Response) => {
  res.json({ banned: listBannedSns() });
});

// POST /api/admin-status/unbind-device — remove user_id from equipment (keep device)
adminStatusRouter.post('/unbind-device', (_req: AuthRequest, res: Response) => {
  const { sn } = _req.body as { sn?: string };
  if (!sn) { res.status(400).json({ error: 'sn required' }); return; }

  equipmentRepo.clearUserIdBySn(sn);
  console.log('[Admin] Device ' + sn + ' unbound');
  res.json({ ok: true });
});

// POST /api/admin-status/set-active-device — set which mower is active (shown in Novabot app)
adminStatusRouter.post('/set-active-device', (_req: AuthRequest, res: Response) => {
  const { sn } = _req.body as { sn?: string };
  if (!sn) { res.status(400).json({ error: 'sn required' }); return; }

  // Clear all is_active flags first, then set the selected one
  db.exec('UPDATE equipment SET is_active = 0');
  const eq = equipmentRepo.findBySn(sn);
  if (eq) {
    db.prepare('UPDATE equipment SET is_active = 1 WHERE equipment_id = ?').run(eq.equipment_id);
    // Also set the paired charger as active
    if (eq.charger_sn) {
      db.prepare('UPDATE equipment SET is_active = 1 WHERE charger_sn = ? AND equipment_id = ?').run(eq.charger_sn, eq.equipment_id);
    }
  }
  console.log('[Admin] Active device set to ' + sn);
  res.json({ ok: true });
});

// POST /api/admin-status/mdns-restart — restart the mDNS advertiser
adminStatusRouter.post('/mdns-restart', (_req: AuthRequest, res: Response) => {
  try {
    stopMdnsAdvertiser();
    startMdnsAdvertiser();
    const advertisement = getActiveAdvertisement();
    console.log('[Admin] mDNS advertiser restarted');
    res.json({
      ok: true,
      restartedAt: new Date().toISOString(),
      advertisement,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('[Admin] mDNS restart failed:', message);
    res.status(500).json({ ok: false, error: message });
  }
});

// POST /api/admin-status/deactivate-device — clear is_active for a specific
// mower (of alle als geen sn wordt meegegeven). Gebruikt door de dashboard
// "Deactivate" knop naast een active mower zodat de user een actieve
// mower expliciet kan uitzetten zonder direct een andere te activeren.
adminStatusRouter.post('/deactivate-device', (_req: AuthRequest, res: Response) => {
  const { sn } = _req.body as { sn?: string };
  if (sn) {
    const eq = equipmentRepo.findBySn(sn);
    if (eq) {
      db.prepare('UPDATE equipment SET is_active = 0 WHERE equipment_id = ?').run(eq.equipment_id);
      console.log('[Admin] Deactivated device ' + sn + ' (equipment ' + eq.equipment_id + ')');
    }
  } else {
    db.exec('UPDATE equipment SET is_active = 0');
    console.log('[Admin] Deactivated ALL devices');
  }
  res.json({ ok: true });
});

// POST /api/admin-status/pair-devices — pair mower with charger in equipment table
adminStatusRouter.post('/pair-devices', (_req: AuthRequest, res: Response) => {
  const { mowerSn, chargerSn } = _req.body as { mowerSn?: string; chargerSn?: string };
  if (!mowerSn || !chargerSn) { res.status(400).json({ error: 'mowerSn and chargerSn required' }); return; }

  try {
    const pairTx = db.transaction(() => {
      // Find existing records
      const chargerEquip = equipmentRepo.findByChargerSn(chargerSn);

      if (chargerEquip) {
        // DELETE standalone mower record FIRST (before UPDATE to avoid UNIQUE violation)
        equipmentRepo.deleteStandaloneMower(mowerSn, chargerEquip.equipment_id);
        // Now safe to set mower_sn on the charger record
        equipmentRepo.updateMowerSn(chargerEquip.equipment_id, mowerSn);
        console.log(`[Admin] Paired mower ${mowerSn} with charger ${chargerSn} (into charger record)`);
      } else {
        const mowerEquip = equipmentRepo.findByMowerSn(mowerSn);
        if (mowerEquip) {
          // DELETE standalone charger record FIRST
          equipmentRepo.deleteStandaloneCharger(chargerSn, mowerEquip.equipment_id);
          equipmentRepo.updateChargerSn(mowerEquip.equipment_id, chargerSn);
        } else {
          // Neither has a record — create one
          const equipmentId = crypto.randomUUID();
          equipmentRepo.create({
            equipment_id: equipmentId,
            user_id: _req.userId,
            mower_sn: mowerSn,
            charger_sn: chargerSn,
          });
        }
        console.log(`[Admin] Paired mower ${mowerSn} with charger ${chargerSn}`);
      }
    });
    pairTx();

    // Sync LoRa cache — both devices should share the same LoRa address
    // Use the charger's address as source of truth (charger reports its own LoRa)
    const chargerLora = equipmentRepo.getLoraCache(chargerSn);
    const mowerLora = equipmentRepo.getLoraCache(mowerSn);

    if (chargerLora?.charger_address && !mowerLora) {
      // Copy charger LoRa to mower
      equipmentRepo.setLoraCache(mowerSn, chargerLora.charger_address, chargerLora.charger_channel ?? '16');
    } else if (mowerLora?.charger_address && !chargerLora) {
      // Copy mower LoRa to charger
      equipmentRepo.setLoraCache(chargerSn, mowerLora.charger_address, mowerLora.charger_channel ?? '16');
    } else if (chargerLora?.charger_address && mowerLora?.charger_address && chargerLora.charger_address !== mowerLora.charger_address) {
      // Different addresses — use equipment table's charger_address as truth
      const equip = equipmentRepo.findBySn(mowerSn);
      if (equip?.charger_address) {
        equipmentRepo.syncLoraPair(mowerSn, chargerSn, equip.charger_address, equip.charger_channel ?? '16');
        console.log(`[Admin] Synced LoRa cache to address ${equip.charger_address} for pair`);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[Admin] Pair failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Pair failed' });
  }
});

// POST /api/admin-status/remove-device — delete device from device_registry + equipment
adminStatusRouter.post('/remove-device', (_req: AuthRequest, res: Response) => {
  const { sn } = _req.body as { sn?: string };
  if (!sn) { res.status(400).json({ error: 'sn required' }); return; }

  deviceRepo.deleteBySn(sn);
  equipmentRepo.deleteBySn(sn);
  equipmentRepo.deleteLoraCache(sn);
  console.log('[Admin] Device ' + sn + ' removed');
  res.json({ ok: true });
});

// GET /api/admin-status/equipment — all equipment pairings
adminStatusRouter.get('/equipment', (_req: AuthRequest, res: Response) => {
  const raw = equipmentRepo.listWithUserEmail();

  // Fix display: if mower_sn starts with LFIC, it's actually a charger
  const equipment = raw.map((e) => {
    const mowerSn = e.mower_sn;
    const chargerSn = e.charger_sn;
    const actualMowerSn = mowerSn?.startsWith('LFIN') ? mowerSn : null;
    const actualChargerSn = chargerSn?.startsWith('LFIC') ? chargerSn
      : mowerSn?.startsWith('LFIC') ? mowerSn : null;
    const deviceType = actualMowerSn ? 'Novabot' : 'Charging station';
    return { ...e, display_mower_sn: actualMowerSn, display_charger_sn: actualChargerSn, device_type: deviceType };
  });

  res.json({ equipment });
});

// POST /api/admin-status/set-role — update user roles
adminStatusRouter.post('/set-role', (req: AuthRequest, res: Response) => {
  const { userId, role, enabled } = req.body as { userId: string; role: string; enabled: boolean };
  if (!userId || !role) { res.status(400).json({ error: 'userId and role required' }); return; }

  const validRoles = ['is_admin', 'dashboard_access'];
  if (!validRoles.includes(role)) {
    res.status(400).json({ error: `Invalid role. Valid: ${validRoles.join(', ')}` });
    return;
  }

  userRepo.setRole(userId, role as 'is_admin' | 'dashboard_access', enabled);

  console.log(`[ADMIN] Set ${role}=${enabled ? 1 : 0} for user ${userId}`);
  res.json({ ok: true });
});

// POST /api/admin-status/delete-user — admin can delete a user
adminStatusRouter.post('/delete-user', (req: AuthRequest, res: Response) => {
  const { userId } = req.body as { userId: string };
  if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
  if (userId === req.userId) { res.status(400).json({ error: 'Cannot delete yourself' }); return; }

  userRepo.deleteById(userId);
  equipmentRepo.clearUserIdByUserId(userId);

  console.log(`[ADMIN] Deleted user ${userId}`);
  res.json({ ok: true });
});

// POST /api/admin-status/reset-password — admin can reset a user's password
adminStatusRouter.post('/reset-password', (req: AuthRequest, res: Response) => {
  const { userId, newPassword } = req.body as { userId: string; newPassword: string };
  if (!userId || !newPassword) { res.status(400).json({ error: 'userId and newPassword required' }); return; }
  if (newPassword.length < 6) { res.status(400).json({ error: 'Password must be at least 6 characters' }); return; }

  const hash = bcrypt.hashSync(newPassword, 10);
  userRepo.updatePassword(userId, hash);

  console.log(`[ADMIN] Password reset for user ${userId}`);
  res.json({ ok: true });
});

// GET /api/admin-status/dns-check — verify DNS configuration
// Checks if *.lfibot.com resolves to a private/local IP (= redirected, good)
// vs the Novabot cloud IPs (= not redirected, bad)
adminStatusRouter.get('/dns-check', async (_req: AuthRequest, res: Response) => {
  const serverIp = process.env.TARGET_IP ?? getLocalIp();
  const domains = ['mqtt.lfibot.com', 'app.lfibot.com'];

  const results = await Promise.all(domains.map(domain =>
    new Promise<{ domain: string; resolvedIp: string | null; ok: boolean; isLocal: boolean; error?: string }>(resolve => {
      dns.resolve4(domain, (err, addresses) => {
        if (err) {
          resolve({ domain, resolvedIp: null, ok: false, isLocal: false, error: err.code ?? err.message });
        } else {
          const ip = addresses[0] ?? null;
          // RFC1918 private ranges: 10.x, 172.16-31.x, 192.168.x
          const isLocal = ip ? /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip) : false;
          resolve({ domain, resolvedIp: ip, ok: isLocal, isLocal });
        }
      });
    })
  ));

  res.json({ serverIp, domains: results });
});

// A killed dnsmasq lingers as a <defunct> zombie because PID 1 (node, started
// via `exec` in the entrypoint) does not reap inherited orphans. A zombie holds
// no listening socket and serves no DNS, so it must NOT count as "running" —
// otherwise the admin Stop button looks stuck (pgrep keeps matching the zombie
// even after SIGKILL).
function dnsmasqLivePids(): string[] {
  let out = '';
  try { out = execSync('pgrep -x dnsmasq', { encoding: 'utf8' }); } catch { return []; }
  const pids = out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (pids.length === 0) return [];
  // /proc is Linux-only. Without it (e.g. macOS dev) trust pgrep; with it, drop
  // zombies by reading each PID's process State.
  let hasProc = false;
  try { hasProc = fs.existsSync('/proc/1/status'); } catch { hasProc = false; }
  if (!hasProc) return pids;
  return pids.filter((pid) => {
    try {
      const m = /^State:\s*(\S)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      return m ? m[1] !== 'Z' : true;
    } catch {
      return false; // /proc entry vanished — not a live process
    }
  });
}

// GET /api/admin-status/dnsmasq — get dnsmasq status
adminStatusRouter.get('/dnsmasq', (_req: AuthRequest, res: Response) => {
  res.json({ running: dnsmasqLivePids().length > 0 });
});

// POST /api/admin-status/dnsmasq — start or stop dnsmasq
adminStatusRouter.post('/dnsmasq', (req: AuthRequest, res: Response) => {
  const { enable } = req.body as { enable?: boolean };
  const serverIp = process.env.TARGET_IP ?? getLocalIp();
  const upstreamDns = process.env.UPSTREAM_DNS ?? '8.8.8.8';

  if (enable) {
    try {
      // Write dnsmasq config
      const config = `no-resolv\nserver=${upstreamDns}\naddress=/lfibot.com/${serverIp}\nlisten-address=0.0.0.0\nbind-interfaces\nno-hosts\n`;
      fs.writeFileSync('/etc/dnsmasq.conf', config);
      // Kill any dnsmasq we previously started (e.g. the entrypoint's), then give
      // the kernel a moment to release port 53 before we rebind it.
      try { execSync('pkill -x dnsmasq', { stdio: 'ignore' }); } catch { /* not running */ }
      try { execSync('sleep 0.5', { stdio: 'ignore' }); } catch { /* best effort */ }
      // CAPTURE stderr: dnsmasq daemonizes (exits 0) on success; on failure it
      // prints the REAL reason to stderr and exits non-zero. The old code used
      // stdio:'ignore' and then guessed "is it installed?" — which was almost
      // always wrong (the usual cause is port 53 already bound on the host).
      execSync('dnsmasq', { stdio: ['ignore', 'pipe', 'pipe'] });
      console.log(`[DNS] dnsmasq started: *.lfibot.com → ${serverIp}`);
      res.json({ ok: true, running: true, serverIp });
    } catch (err) {
      const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
      const detail = (e.stderr?.toString() || e.stdout?.toString() || e.message || '').trim();
      let error = detail || 'Failed to start dnsmasq.';
      if (/in use|EADDRINUSE|failed to create listening socket/i.test(detail)) {
        let holder = '';
        try {
          holder = execSync("ss -lntupH 'sport = :53' 2>/dev/null | head -n 3 || true")
            .toString().trim();
        } catch { /* ss may be unavailable */ }
        error = `Port 53 is already in use${holder ? ` by: ${holder}` : ''}. ` +
          'Another DNS service (e.g. systemd-resolved, or the host router) holds port 53. ' +
          'Free port 53 on the host, then try again.';
      } else if (/not found|No such file|command not found/i.test(detail)) {
        error = 'dnsmasq is not installed in this image.';
      }
      console.error(`[DNS] Failed to start dnsmasq: ${detail}`);
      res.json({ ok: false, error, detail });
    }
  } else {
    // SIGTERM, let dnsmasq exit, then VERIFY using LIVE (non-zombie) PIDs. A
    // killed dnsmasq lingers as a <defunct> zombie (PID 1 = node doesn't reap
    // orphans), so a plain pgrep would wrongly report it as still running and
    // the old code even returned running:false unconditionally. If a LIVE
    // process survives SIGTERM, escalate to SIGKILL; once only zombies (or
    // nothing) remain, it is truly stopped — the kernel has freed port 53.
    try { execSync('pkill -x dnsmasq', { stdio: 'ignore' }); } catch { /* none running */ }
    try { execSync('sleep 0.3', { stdio: 'ignore' }); } catch { /* best effort */ }
    if (dnsmasqLivePids().length > 0) {
      try { execSync('pkill -9 -x dnsmasq', { stdio: 'ignore' }); } catch { /* gone between checks */ }
      try { execSync('sleep 0.3', { stdio: 'ignore' }); } catch { /* best effort */ }
    }
    if (dnsmasqLivePids().length > 0) {
      console.error('[DNS] dnsmasq still running after SIGTERM + SIGKILL');
      res.json({ ok: false, running: true, error: 'dnsmasq did not stop (still running after SIGKILL).' });
    } else {
      console.log('[DNS] dnsmasq stopped');
      res.json({ ok: true, running: false });
    }
  }
});

function getLocalIp(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

// GET /api/admin-status/check-firmware-updates — compare remote manifest with local versions
adminStatusRouter.get('/check-firmware-updates', async (_req: AuthRequest, res: Response) => {
  try {
    const manifest = await fetchJson(MANIFEST_URL) as { firmwares?: FirmwareManifestEntry[] };
    const remoteFirmwares = manifest.firmwares || [];

    // Get locally installed versions
    const localVersions = otaVersionRepo.listAll();
    const localVersionSet = new Set(localVersions.map(v => v.version));

    // Per-device highest installed version. The Available Firmware panel
    // should only surface remote entries that are STRICTLY newer than
    // whatever is already on disk for that device — otherwise every
    // refresh listed every legacy entry (v6.0.2-custom-23, -24, -25, ...)
    // even after the operator had only kept the newest one locally.
    // Natural-sort comparator handles both `vX.Y.Z` semver (charger) and
    // `vX.Y.Z-custom-N` suffixes (mower).
    const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const maxInstalledByType = new Map<string, string>();
    for (const v of localVersions) {
      const cur = maxInstalledByType.get(v.device_type);
      if (!cur || cmp.compare(v.version, cur) > 0) {
        maxInstalledByType.set(v.device_type, v.version);
      }
    }

    const available = remoteFirmwares
      .filter(fw => {
        const localMax = maxInstalledByType.get(fw.device_type);
        if (!localMax) return true; // no local copy at all → show everything
        return cmp.compare(fw.version, localMax) > 0;
      })
      .map(fw => ({
        ...fw,
        // Issue #26: the published manifest still references the old
        // `download.ramonvanbruggen.nl` host (singular) which fails DNS
        // resolution; the live host is `downloads.ramonvanbruggen.nl`.
        // Defensive rewrite here so the Download button works regardless of
        // when the manifest is fixed.
        url: normaliseFirmwareDownloadUrl(fw.url),
        filename: fw.filename || fw.url.split('/').pop() || `firmware_${fw.version}`,
        installed: localVersionSet.has(fw.version),
      }))
      // Newest first — Intl.Collator numeric handles `custom-29` < `custom-30`
      // and `v6.0.2` < `v6.0.3` correctly. Without this the admin
      // "Firmware Updates" panel showed entries in manifest order so a
      // freshly built custom-30 landed under custom-29.
      .sort((a, b) => cmp.compare(b.version, a.version));

    res.json({
      available,
      installed: localVersions.map(v => ({
        version: v.version,
        device_type: v.device_type,
        md5: v.md5,
        sha256: v.sha256,
        size: v.size,
        signature: v.signature,
        keyId: v.signing_key_id,
      })),
    });
  } catch (err) {
    console.error('[Admin] Failed to check firmware updates:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch manifest' });
  }
});

// POST /api/admin-status/download-firmware — download firmware from remote URL and register locally
adminStatusRouter.post('/download-firmware', async (req: AuthRequest, res: Response) => {
  const {
    url: rawUrl,
    filename,
    version,
    device_type,
    md5,
    sha256,
    size,
    signature,
    description,
  } = req.body as {
    url?: string;
    filename?: string;
    version?: string;
    device_type?: string;
    md5?: string;
    sha256?: string;
    size?: number;
    signature?: string;
    description?: string;
  };
  const signingKeyId = (req.body as { signing_key_id?: string; signingKeyId?: string; keyId?: string }).signing_key_id
    ?? (req.body as { signingKeyId?: string }).signingKeyId
    ?? (req.body as { keyId?: string }).keyId
    ?? null;

  if (!rawUrl || !filename || !version || !device_type) {
    res.status(400).json({ error: 'url, filename, version, and device_type are required' });
    return;
  }
  // Defensive rewrite (issue #26) — see normaliseFirmwareDownloadUrl.
  const url = normaliseFirmwareDownloadUrl(rawUrl);

  // Resolve firmware directory (same as dashboard.ts)
  const firmwareDir = process.env.FIRMWARE_PATH ?? path.resolve(process.cwd(), 'firmware');
  fs.mkdirSync(firmwareDir, { recursive: true });

  const filePath = path.join(firmwareDir, filename);

  try {
    console.log(`[Admin] Downloading firmware ${version} from ${url}...`);

    // Download the file
    await downloadFile(url, filePath);

    // Verify MD5
    const fileBuffer = fs.readFileSync(filePath);
    const fileMd5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
    const fileSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const fileSize = fileBuffer.length;

    if (md5 && fileMd5 !== md5) {
      // Clean up failed download
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      res.status(400).json({ error: `MD5 mismatch: expected ${md5}, got ${fileMd5}` });
      return;
    }
    if (sha256 && fileSha256 !== sha256) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      res.status(400).json({ error: `SHA256 mismatch: expected ${sha256}, got ${fileSha256}` });
      return;
    }
    if (size && fileSize !== size) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      res.status(400).json({ error: `Size mismatch: expected ${size}, got ${fileSize}` });
      return;
    }

    // Build local download URL for OTA
    const targetIp = process.env.TARGET_IP ?? getLocalIp();
    const port = process.env.PORT ?? '3000';
    const localUrl = `http://${targetIp}:${port}/api/dashboard/firmware/${encodeURIComponent(filename)}`;

    // Write companion JSON metadata
    const metaPath = filePath.replace(/\.(deb|bin)$/, '.json');
    fs.writeFileSync(metaPath, JSON.stringify({
      version,
      device_type,
      filename,
      md5: fileMd5,
      sha256: fileSha256,
      size: fileSize,
      signature: signature || '',
      signing_key_id: signingKeyId,
      keyId: signingKeyId,
      description: description || '',
    }, null, 2));

    // syncFirmwareVersions() will pick it up via file watcher, but also create/update directly
    const existing = otaVersionRepo.listAll().find(v => v.version === version && v.device_type === device_type);
    if (existing) {
      otaVersionRepo.updateById(existing.id, {
        download_url: localUrl,
        md5: fileMd5,
        sha256: fileSha256,
        size: fileSize,
        signature: signature || null,
        signing_key_id: signingKeyId,
        release_notes: description || existing.release_notes,
      });
    } else {
      otaVersionRepo.create({
        version,
        device_type,
        download_url: localUrl,
        md5: fileMd5,
        sha256: fileSha256,
        size: fileSize,
        signature: signature || null,
        signing_key_id: signingKeyId,
        release_notes: description || null,
      });
    }

    console.log(`[Admin] Firmware ${version} downloaded and registered (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
    res.json({
      ok: true,
      version,
      localPath: filePath,
      md5: fileMd5,
      sha256: fileSha256,
      size: fileSize,
      signature: signature || null,
      keyId: signingKeyId,
    });
  } catch (err) {
    // Clean up on error
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    console.error('[Admin] Firmware download failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Download failed' });
  }
});

// Shared handler so the walker firmware binary is reachable both via the
// admin-router (legacy, bearer-auth) and via a public path mounted in
// index.ts. Firmware is already published openly on downloads.* and the
// threat model is LAN-only, so making OTA install auth-free matches the
// same logic applied to the walker-bundles upload — no point making
// users paste a JWT to download a publicly-available binary.
export function handleWalkerFirmwareBinary(req: express.Request, res: express.Response): void {
  const safe = path.basename(req.params.filename);
  if (!safe || safe.includes('..') || safe.startsWith('.') || safe.includes('/') || safe.includes('\\')) {
    res.status(400).json({ ok: false, error: 'invalid filename' });
    return;
  }
  const firmwareDir = process.env.FIRMWARE_PATH ?? path.resolve(process.cwd(), 'firmware');
  const filePath = path.join(firmwareDir, safe);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ ok: false, error: 'not found' });
    return;
  }
  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
  fs.createReadStream(filePath).pipe(res);
}

// GET /api/admin-status/walker-firmware/binary/:filename — legacy admin-auth
// path; kept for backwards compatibility with any operator-side tooling.
adminStatusRouter.get('/walker-firmware/binary/:filename', handleWalkerFirmwareBinary);

// ── Server self-update check ─────────────────────────────────────────────────

const HUB_TAGS_URL = 'https://hub.docker.com/v2/repositories/rvbcrs/opennova/tags?page_size=25&ordering=last_updated';
let _serverUpdateCache: { ts: number; payload: { current: string; latest: string | null; updateAvailable: boolean; lastUpdatedAt: string | null } } | null = null;

export interface ServerUpdatePayload {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  lastUpdatedAt: string | null;
}

/**
 * Compare the running version with the newest Docker Hub tag for
 * rvbcrs/opennova. Cached for 5 minutes so polling (admin panel + dashboard)
 * doesn't hammer Docker Hub. Shared by both the admin and dashboard routes.
 */
export async function checkServerUpdate(): Promise<ServerUpdatePayload> {
  if (_serverUpdateCache && Date.now() - _serverUpdateCache.ts < 5 * 60 * 1000) {
    return _serverUpdateCache.payload;
  }

  const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const data = await fetchJson(HUB_TAGS_URL) as { results?: Array<{ name: string; last_updated: string }> };
  const tags = data.results ?? [];
  // release.sh writes timestamp version tags like "2026.0505.0821" plus rolling
  // aliases ("latest", "beta"). Compare ONLY against real version tags — a
  // moving alias (e.g. beta on a beta device) would otherwise sort above the
  // numbers and read as a newer version. ponytail: regex is the whole guard.
  const versionTags = tags.filter(t => t.name && /^\d{4}\.\d{3,4}\.\d{3,4}$/.test(t.name));
  let latest: string | null = null;
  let lastUpdatedAt: string | null = null;
  for (const t of versionTags) {
    if (!latest || cmp.compare(t.name, latest) > 0) {
      latest = t.name;
      lastUpdatedAt = t.last_updated ?? null;
    }
  }
  const updateAvailable = !!(latest && cmp.compare(latest, SERVER_VERSION) > 0);
  const payload: ServerUpdatePayload = { current: SERVER_VERSION, latest, updateAvailable, lastUpdatedAt };
  _serverUpdateCache = { ts: Date.now(), payload };
  return payload;
}

// GET /api/admin-status/check-server-update — compare running version with newest Docker Hub tag.
adminStatusRouter.get('/check-server-update', async (_req: AuthRequest, res: Response) => {
  try {
    res.json(await checkServerUpdate());
  } catch (err) {
    console.error('[Admin] Failed to check server update:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to check update' });
  }
});

/** Fetch JSON from an HTTPS URL */
export function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: true }, (resp) => {
      if (resp.statusCode && resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        // Follow redirect
        fetchJson(resp.headers.location).then(resolve, reject);
        return;
      }
      if (resp.statusCode !== 200) {
        reject(new Error(`HTTP ${resp.statusCode} from ${url}`));
        resp.resume();
        return;
      }
      let data = '';
      resp.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
      resp.on('error', reject);
    }).on('error', reject);
  });
}

/** Download a file from HTTPS URL to local path */
export function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { rejectUnauthorized: true }, (resp: any) => {
      if (resp.statusCode && resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        downloadFile(resp.headers.location, destPath).then(resolve, reject);
        return;
      }
      if (resp.statusCode !== 200) {
        reject(new Error(`HTTP ${resp.statusCode} downloading firmware`));
        resp.resume();
        return;
      }
      const fileStream = fs.createWriteStream(destPath);
      resp.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(); });
      fileStream.on('error', (err: Error) => {
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
        reject(err);
      });
      resp.on('error', (err: Error) => {
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
        reject(err);
      });
    }).on('error', reject);
  });
}

// ── Map backup endpoints ──────────────────────────────────────────────────────

/** Derive the firmware-canonical slot name from a parsed MapArea. */
function areaCanonicalName(area: MapArea): string {
  switch (area.type) {
    case 'work':
      return `map${area.mapIndex}`;
    case 'obstacle':
      return `map${area.mapIndex}_${area.subIndex ?? 0}_obstacle`;
    case 'unicom':
      return `map${area.mapIndex}to${area.target ?? 'charge'}_unicom`;
  }
}

/** Derive the CSV filename for a MapArea. */
function areaCsvFile(area: MapArea): string {
  switch (area.type) {
    case 'work':
      return `map${area.mapIndex}_work.csv`;
    case 'obstacle':
      return `map${area.mapIndex}_${area.subIndex ?? 0}_obstacle.csv`;
    case 'unicom':
      return `map${area.mapIndex}to${area.target ?? 'charge'}_unicom.csv`;
  }
}

// GET /api/admin-status/map-backups/:sn — list available snapshots
adminStatusRouter.get('/map-backups/:sn', (req: AuthRequest, res: Response) => {
  const { sn } = req.params;
  res.json({ backups: listBackups(sn) });
});

// GET /api/admin-status/map-backups/:sn/:filename — download ZIP
adminStatusRouter.get('/map-backups/:sn/:filename', (req: AuthRequest, res: Response) => {
  const { sn, filename } = req.params;
  try {
    const p = backupPath(sn, filename);
    if (!fs.existsSync(p)) {
      res.status(404).json({ error: 'backup not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(p).pipe(res);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'invalid filename' });
  }
});

// GET /api/admin-status/map-backups/:sn/:filename/contents — inspect backup
adminStatusRouter.get('/map-backups/:sn/:filename/contents', (req: AuthRequest, res: Response) => {
  const { sn, filename } = req.params;
  try {
    const p = backupPath(sn, filename);
    if (!fs.existsSync(p)) {
      res.status(404).json({ error: 'backup not found' });
      return;
    }
    const parsed = parseMapZip(p);
    if (!parsed) {
      res.status(400).json({ error: 'failed to parse backup ZIP' });
      return;
    }

    type AreaEntry = { canonicalName: string; csvFile: string; pointCount: number; existsInDb: boolean };
    const work: AreaEntry[] = [];
    const obstacles: AreaEntry[] = [];
    const unicoms: AreaEntry[] = [];

    for (const area of parsed.areas) {
      const canonicalName = areaCanonicalName(area);
      const entry: AreaEntry = {
        canonicalName,
        csvFile: areaCsvFile(area),
        pointCount: area.points.length,
        existsInDb: !!mapRepo.findBySnAndCanonical(sn, canonicalName),
      };
      if (area.type === 'work') work.push(entry);
      else if (area.type === 'obstacle') obstacles.push(entry);
      else if (area.type === 'unicom') unicoms.push(entry);
    }

    res.json({
      work,
      obstacles,
      unicoms,
      chargingPose: parsed.chargingPose ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'unknown error' });
  }
});

// GET /api/admin-status/map-backups/:sn/:filename/polygons — full polygon geometry
//
// Same source data as /contents but returns the full {x, y} arrays so the
// admin map canvas can render the backup as a ghost overlay BEFORE the
// operator commits to a restore. /contents intentionally only returns
// metadata (point counts) so the dropdown UX stays cheap; this endpoint
// is hit on demand when a snapshot is selected for preview.
adminStatusRouter.get('/map-backups/:sn/:filename/polygons', (req: AuthRequest, res: Response) => {
  const { sn, filename } = req.params;
  try {
    const p = backupPath(sn, filename);
    if (!fs.existsSync(p)) {
      res.status(404).json({ error: 'backup not found' });
      return;
    }
    const parsed = parseMapZip(p);
    if (!parsed) {
      res.status(400).json({ error: 'failed to parse backup ZIP' });
      return;
    }

    const maps = parsed.areas
      .filter(a => Array.isArray(a.points) && a.points.length >= 2)
      .map(a => ({
        mapName: areaCanonicalName(a),
        canonicalName: areaCanonicalName(a),
        mapType: a.type,
        mapArea: a.points.map(pt => ({ x: pt.x, y: pt.y })),
      }));

    res.json({
      maps,
      chargingPose: parsed.chargingPose ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'unknown error' });
  }
});

// GET /api/admin-status/maps/:sn/mask-overlay?layer=whole|map0|map1...
//
// Reads the mower's LIVE occupancy grid (read_map_files) + dock pose and returns
// a colored RGBA reachability overlay PNG for the admin Map Viewer "what the
// mower sees" layer: occupied=red, free+reachable-from-dock=green, free-but-
// cut-off=blue. layer=whole -> map.pgm (Nav2 global map); layer=mapN -> per-zone
// coverage grid. The overlay is what Nav2 can actually route, so a blue patch
// means a zone the mower CANNOT reach.
adminStatusRouter.get('/maps/:sn/mask-overlay', async (req: AuthRequest, res: Response) => {
  const { sn } = req.params;
  const layer = String(req.query.layer ?? 'whole');
  if (!/^(whole|map\d+)$/.test(layer)) {
    res.status(400).json({ ok: false, error: 'layer must be "whole" or "mapN"' });
    return;
  }
  if (!isDeviceOnline(sn)) {
    res.status(409).json({ ok: false, error: 'mower offline — the mask is read live from the mower' });
    return;
  }
  const pgmName = layer === 'whole' ? 'map.pgm' : `${layer}.pgm`;
  const yamlName = layer === 'whole' ? 'map.yaml' : `${layer}.yaml`;

  const mowerData = await new Promise<{
    chargingPose?: { x: number; y: number; orientation: number };
    mapFilesText?: Record<string, string>;
    mapFilesB64?: Record<string, string>;
  }>((resolve) => {
    let settled = false;
    const handler = (data: Record<string, unknown>) => {
      const r = data.read_map_files_respond as {
        result?: number;
        csv_files?: Record<string, string>;
        map_files_text?: Record<string, string>;
        map_files_b64?: Record<string, string>;
      } | undefined;
      if (!r || settled) return;
      settled = true;
      offExtendedResponse(sn, handler);
      if (r.result !== 0) { resolve({}); return; }
      let chargingPose: { x: number; y: number; orientation: number } | undefined;
      const mi = r.csv_files?.['map_info.json'];
      if (mi) {
        try {
          const cp = (JSON.parse(mi) as { charging_pose?: { x: number; y: number; orientation: number } }).charging_pose;
          if (cp && Number.isFinite(cp.x) && Number.isFinite(cp.y)) chargingPose = cp;
        } catch { /* malformed map_info.json — skip */ }
      }
      resolve({ chargingPose, mapFilesText: r.map_files_text, mapFilesB64: r.map_files_b64 });
    };
    onExtendedResponse(sn, handler);
    publishToExtended(sn, { read_map_files: {} });
    setTimeout(() => { if (!settled) { settled = true; offExtendedResponse(sn, handler); resolve({}); } }, 20000);
  });

  // Layers the mower actually has (whole + each per-zone mapN.pgm) so the UI
  // can populate the selector from the live file set.
  const availableLayers = ['whole', ...Object.keys(mowerData.mapFilesB64 ?? {})
    .filter((k) => /^map\d+\.pgm$/.test(k))
    .map((k) => k.replace(/\.pgm$/, ''))
    .sort()];

  const b64 = mowerData.mapFilesB64?.[pgmName];
  if (!b64) {
    res.status(404).json({ ok: false, error: `${pgmName} not found on mower (no map yet, or unsupported firmware)`, availableLayers });
    return;
  }
  const grid = parsePgm(Buffer.from(b64, 'base64'));
  if (!grid) { res.status(500).json({ ok: false, error: `unparseable ${pgmName}` }); return; }

  // geometry from the matching yaml (fall back to map.yaml)
  const yamlText = mowerData.mapFilesText?.[yamlName] ?? mowerData.mapFilesText?.['map.yaml'] ?? '';
  const rm = /resolution:\s*([0-9.eE+-]+)/.exec(yamlText);
  const om = /origin:\s*\[\s*([0-9.eE+-]+)\s*,\s*([0-9.eE+-]+)/.exec(yamlText);
  const resM = rm ? parseFloat(rm[1]) : 0.05;
  const originX = om ? parseFloat(om[1]) : 0;
  const originY = om ? parseFloat(om[2]) : 0;

  // Reachability seed differs by layer:
  //  - whole (map.pgm): Nav2 routes here, so seed from the dock — green = where
  //    the mower can physically drive, blue = a cut-off island it can't reach.
  //  - mapN (per-zone coverage grid): the mower does NOT navigate this grid; it
  //    reaches the zone via the whole map, then coverage-plans inside the zone
  //    from its arrival point. The dock sits OUTSIDE non-dock zones (its disc is
  //    an isolated pocket in mapN.pgm), so a dock seed would paint ~all of the
  //    zone blue. Seed from the largest free component instead (dockPx=null) so
  //    green = the contiguous area the planner will actually cover.
  let dockPx: { x: number; y: number } | null = null;
  const cp = mowerData.chargingPose;
  if (layer === 'whole' && cp && resM > 0) {
    dockPx = {
      x: Math.trunc((cp.x - originX) / resM),
      y: (grid.H - 1) - Math.trunc((cp.y - originY) / resM),
    };
  }
  const { png, stats } = buildMaskOverlay(grid, dockPx);
  res.json({
    ok: true,
    layer,
    availableLayers,
    pngBase64: png.toString('base64'),
    geometry: { originX, originY, res: resM, W: grid.W, H: grid.H },
    stats,
  });
});

// POST /api/admin-status/map-backups/:sn/:filename/restore — selective DB restore
//
// Each item may carry an optional `overwrite` flag:
//   { canonicalName, type, overwrite?: boolean }
//
// Behaviour per item:
//   - Not in ZIP           → skippedNotInBackup++
//   - In ZIP, < 2 pts      → skippedNotInBackup++
//   - In ZIP, no DB row    → INSERT                   → restored++
//   - In ZIP, has DB row, overwrite=true  → DELETE + INSERT → overwritten++
//   - In ZIP, has DB row, overwrite falsy → skip            → skippedExisting++
adminStatusRouter.post('/map-backups/:sn/:filename/restore', (req: AuthRequest, res: Response) => {
  const { sn, filename } = req.params;
  const items = (req.body?.items ?? []) as Array<{ canonicalName: string; type: string; overwrite?: boolean }>;

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items array required' });
    return;
  }

  try {
    const p = backupPath(sn, filename);
    if (!fs.existsSync(p)) {
      res.status(404).json({ error: 'backup not found' });
      return;
    }
    const parsed = parseMapZip(p);
    if (!parsed) {
      res.status(400).json({ error: 'failed to parse backup ZIP' });
      return;
    }

    let restored = 0;
    let overwritten = 0;
    let skippedExisting = 0;
    let skippedNotInBackup = 0;

    for (const want of items) {
      // Find matching area in parsed ZIP
      const area = parsed.areas.find(a =>
        a.type === want.type && areaCanonicalName(a) === want.canonicalName,
      );
      if (!area || area.points.length < 2) { skippedNotInBackup++; continue; }

      // Check if a row with same (mower_sn, canonical_name) already exists
      const existing = mapRepo.findBySnAndCanonical(sn, want.canonicalName);

      if (existing) {
        if (want.overwrite === true) {
          // Delete the existing row then fall through to INSERT
          mapRepo.deleteByIdAndMower(existing.map_id, sn);
          overwritten++;
        } else {
          skippedExisting++;
          continue;
        }
      } else {
        restored++;
      }

      const mapId = uuidv4();
      const xs = area.points.map(pt => pt.x);
      const ys = area.points.map(pt => pt.y);

      mapRepo.create({
        map_id: mapId,
        mower_sn: sn,
        map_name: want.canonicalName,
        file_name: areaCsvFile(area),
        map_area: JSON.stringify(area.points),
        map_max_min: JSON.stringify({
          minX: Math.min(...xs), maxX: Math.max(...xs),
          minY: Math.min(...ys), maxY: Math.max(...ys),
        }),
        map_type: want.type,
        canonical_name: want.canonicalName,
      });
    }

    console.log(`[Admin] Map restore for ${sn}: ${restored} restored, ${overwritten} overwritten, ${skippedExisting} skippedExisting, ${skippedNotInBackup} skippedNotInBackup`);
    markFrameUnvalidated(sn);
    console.log(`[Admin] frame_unvalidated set for ${sn} after restore`);
    res.json({ ok: true, restored, overwritten, skippedExisting, skippedNotInBackup });
  } catch (err) {
    console.error('[Admin] Map restore failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'restore failed' });
  }
});

// POST /api/admin-status/map-backups/:sn/:filename/restore-and-realign
//
// One-click recovery (Novabot-uvf): orchestrates everything documented in
// docs/runbooks/charger-anchor-restore-runbook.md and the manual flow from
// 2026-05-02:
//   1. Full DB restore from selected backup ZIP (overwrites all rows).
//   2. Look up polygon anchor (first point of mapNtocharge_unicom).
//   3. Update map_calibration.charger_lat/lng with mower's live RTK GPS.
//   4. regenerateLatestZipFromBackup → enriched <SN>_latest.zip.
//   5. publishToExtended(sn, { sync_map: {} }) → mower pulls + applies.
//   6. Wait sync_map_respond ≤ 8 s.
//
// Spec: docs/superpowers/specs/2026-05-03-restore-and-realign-mower-from-zip.md
adminStatusRouter.post('/map-backups/:sn/:filename/restore-and-realign', async (req: AuthRequest, res: Response) => {
  const { sn, filename } = req.params;

  // ── 1. Validate backup + parse ──────────────────────────────────────────
  let backupAbsPath: string;
  try {
    backupAbsPath = backupPath(sn, filename);
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'bad filename' });
    return;
  }
  if (!fs.existsSync(backupAbsPath)) {
    res.status(404).json({ ok: false, error: 'backup not found' });
    return;
  }
  const parsed = parseMapZip(backupAbsPath);
  if (!parsed) {
    res.status(400).json({ ok: false, error: 'failed to parse backup ZIP' });
    return;
  }

  // ── 2. Full DB restore — overwrite all rows ─────────────────────────────
  let restored = 0;
  for (const area of parsed.areas) {
    if (area.points.length < 2) continue;
    const canonical = areaCanonicalName(area);
    if (!canonical) continue;

    const existing = mapRepo.findBySnAndCanonical(sn, canonical);
    if (existing) mapRepo.deleteByIdAndMower(existing.map_id, sn);

    const xs = area.points.map(pt => pt.x);
    const ys = area.points.map(pt => pt.y);
    mapRepo.create({
      map_id: uuidv4(),
      mower_sn: sn,
      map_name: canonical,
      file_name: areaCsvFile(area),
      map_area: JSON.stringify(area.points),
      map_max_min: JSON.stringify({
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys),
      }),
      map_type: area.type,
      canonical_name: canonical,
    });
    restored++;
  }

  // Map files are now restored; the frame is not yet validated against the
  // real charger. Lock go_to_charge until a successful re-dock, regardless of
  // whether the realign steps below succeed.
  markFrameUnvalidated(sn);
  console.log(`[Admin] frame_unvalidated set for ${sn} after restore-and-realign`);

  // ── 3. Resolve polygon anchor (must succeed for realign to be coherent) ─
  const sensors = deviceCache.get(sn);
  const anchor = getPolygonAnchor(sn, sensors);
  if (!anchor) {
    res.status(400).json({
      ok: false,
      error: 'Backup has no mapNtocharge_unicom — cannot anchor charger pose',
      restoredItems: restored,
    });
    return;
  }

  // ── 4. Read mower live GPS (mandatory) ──────────────────────────────────
  const lat = parseFloat(sensors?.get('gps_latitude') ?? '');
  const lng = parseFloat(sensors?.get('gps_longitude') ?? '');
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) {
    res.status(400).json({
      ok: false,
      error: 'Mower GPS not reported — wait for mower to be online + on dock + RTK FIX',
      restoredItems: restored,
    });
    return;
  }

  // ── 5. Update DB chargerGps to live reading ─────────────────────────────
  mapRepo.setChargerGps(sn, lat, lng);

  // ── 6. Regenerate enriched _latest.zip ──────────────────────────────────
  const regenPath = regenerateLatestZipFromBackup(sn);
  if (!regenPath) {
    res.status(500).json({
      ok: false,
      error: 'Failed to regenerate <SN>_latest.zip',
      restoredItems: restored,
      anchor,
    });
    return;
  }

  // ── 7. Trigger sync_map MQTT (must be online) ───────────────────────────
  if (!isDeviceOnline(sn)) {
    res.status(404).json({
      ok: false,
      error: 'Mower offline — sync_map cannot run',
      restoredItems: restored,
      anchor,
      gps: { lat, lng },
      note: 'Server-side state already restored; mower will pick up on next sync_map trigger',
    });
    return;
  }

  const syncResult = await new Promise<{ ok: boolean; respond?: Record<string, unknown>; timeout?: boolean }>((resolve) => {
    let settled = false;
    const handler = (data: Record<string, unknown>) => {
      const respond = data.sync_map_respond as Record<string, unknown> | undefined;
      if (!respond) return;
      if (settled) return;
      settled = true;
      offExtendedResponse(sn, handler);
      resolve({ ok: respond.result === 0, respond });
    };
    onExtendedResponse(sn, handler);
    publishToExtended(sn, { sync_map: {} });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      offExtendedResponse(sn, handler);
      resolve({ ok: false, timeout: true });
    }, 8000);
  });

  if (syncResult.timeout) {
    res.status(504).json({
      ok: false,
      error: 'Mower did not respond within 8s',
      restoredItems: restored,
      anchor,
      gps: { lat, lng },
      partial: true,
    });
    return;
  }

  // After sync_map writes the CSVs (and map.yaml/pgm/png from the ZIP if
  // those were included), trigger save_map type:1 as a safety net so the
  // mower re-renders the map artifacts from the freshly applied CSVs.
  // Stale restored ZIPs can carry mismatched yaml/pgm; this re-render
  // guarantees Errors 107/118 don't surface immediately after a restore.
  // Fire-and-forget — caller doesn't need the respond.
  if (syncResult.ok) {
    publishToDevice(sn, { save_map: { type: 1, mapName: 'map', totalArea: 0 } });
    console.log(`[Admin] restore-and-realign ${sn}: post-sync save_map type:1 dispatched to render map.yaml/pgm`);
    // Per-map slot files (map<N>.yaml/.pgm/.png) — mapping-node only
    // emits these inside a real edge-recording session; recovery callers
    // never go through that path. Mirror map.yaml/pgm/png into each
    // map<N> slot via the custom extended_commands handler so Nav2 can
    // resolve `start_navigation` lookups for any work-map without
    // hitting Error 107. Small delay so save_map type:1 finishes
    // writing map.yaml before we copy from it.
    setTimeout(() => {
      publishToExtended(sn, { regenerate_per_map_files: {} });
      console.log(`[Admin] restore-and-realign ${sn}: regenerate_per_map_files dispatched`);
    }, 3000);
  }

  console.log(
    `[Admin] restore-and-realign ${sn} from ${filename}: restored=${restored} anchor=(${anchor.x}, ${anchor.y}, ${anchor.orientation}) gps=(${lat}, ${lng}) syncOk=${syncResult.ok}`,
  );
  res.json({
    ok: syncResult.ok,
    restoredItems: restored,
    anchor,
    gps: { lat, lng },
    syncResult: syncResult.respond ?? null,
  });
});

// ── Portable map export ──────────────────────────────────────────────────────

// ── Portable backup vault (auto + manual snapshots) ────────────────────────
// GET    /maps/:sn/portable-backups                  — list
// POST   /maps/:sn/portable-backups                  — manual snapshot now
// GET    /maps/:sn/portable-backups/:filename        — download
// DELETE /maps/:sn/portable-backups/:filename        — remove
// POST   /maps/:sn/portable-backups/:filename/restore — apply via wizard
adminStatusRouter.get('/maps/:sn/portable-backups', async (req: AuthRequest, res: Response) => {
  const { listBackups } = await import('../services/portableBackup.js');
  res.json({ backups: listBackups(req.params.sn) });
});

adminStatusRouter.post('/maps/:sn/portable-backups', async (req: AuthRequest, res: Response) => {
  const { createBackup } = await import('../services/portableBackup.js');
  const { sn } = req.params;
  try {
    const entry = await createBackup(sn, 'manual');
    if (!entry) {
      // createBackup returns null when the mower didn't return its live map
      // files in time (or has no map in the DB). Don't blame "offline" when it
      // isn't — a corrupted/timed-out read_map_files on online mowers is the
      // OpenNova socket-lock bug, fixed in firmware custom-37+.
      const online = isDeviceOnline(sn);
      res.status(409).json({
        ok: false,
        online,
        error: online
          ? 'mower is online but did not return its map files in time. Its firmware may be missing the OpenNova socket-lock fix (update to custom-37 or newer), or it has no saved map yet.'
          : 'mower offline — a snapshot reads the live map files from the mower, so it must be online.',
      });
      return;
    }
    res.json({ ok: true, backup: entry });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// Rebuild a self-contained bundle from the DB polygons alone (no mower) using
// the faithful occupancy-grid generator. Powers the "Rebuild bundle" button and
// the auto-trigger after cloud re-import.
adminStatusRouter.post('/maps/:sn/portable-backups/rebuild', async (req: AuthRequest, res: Response) => {
  const { createBundleFromDb } = await import('../services/portableBackup.js');
  try {
    const entry = await createBundleFromDb(req.params.sn, 'rebuild-db');
    if (!entry) {
      res.status(409).json({ ok: false, error: 'rebuild failed (no work polygon or charger anchor in DB)' });
      return;
    }
    res.json({ ok: true, backup: entry });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// CSV-only import: upload a .zip of a csv_file/ folder (map*_work.csv,
// *_obstacle.csv, *_unicom.csv, map_info.json). Rasterizes + saves a restorable
// bundle without needing the mower or cloud.
adminStatusRouter.post(
  '/maps/:sn/portable-backups/from-csv-zip',
  bundleUpload.single('bundle'),
  async (req: AuthRequest, res: Response) => {
    if (!req.file) { res.status(400).json({ ok: false, error: 'zip file required (field "bundle")' }); return; }
    try {
      const dir = await unzipper.Open.buffer(req.file.buffer);
      const csvFiles: Record<string, string> = {};
      for (const f of dir.files) {
        if (f.type !== 'File') continue;
        const base = f.path.split('/').pop() ?? f.path;
        if (!base.endsWith('.csv') && base !== 'map_info.json') continue;
        csvFiles[base] = (await f.buffer()).toString('utf8');
      }
      if (Object.keys(csvFiles).length === 0) {
        res.status(400).json({ ok: false, error: 'zip contains no .csv / map_info.json files' });
        return;
      }
      const { createBundleFromCsvFiles } = await import('../services/portableBackup.js');
      const entry = await createBundleFromCsvFiles(req.params.sn, csvFiles, 'csv-import');
      if (!entry) { res.status(409).json({ ok: false, error: 'no map*_work.csv found in zip' }); return; }
      res.json({ ok: true, backup: entry });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  },
);

adminStatusRouter.get('/maps/:sn/portable-backups/:filename', async (req: AuthRequest, res: Response) => {
  const { readBackup } = await import('../services/portableBackup.js');
  const buf = readBackup(req.params.sn, req.params.filename);
  if (!buf) { res.status(404).json({ ok: false, error: 'not found' }); return; }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
  res.send(buf);
});

adminStatusRouter.delete('/maps/:sn/portable-backups/:filename', async (req: AuthRequest, res: Response) => {
  const { deleteBackup } = await import('../services/portableBackup.js');
  const ok = deleteBackup(req.params.sn, req.params.filename);
  res.json({ ok });
});

// Restore by piping the saved bundle through the existing import-portable
// staging + apply-verbatim path (the single restore path). Server-side fan-out
// keeps the wizard logic single-sourced.
adminStatusRouter.post('/maps/:sn/portable-backups/:filename/restore', async (req: AuthRequest, res: Response) => {
  const { sn, filename } = req.params;
  const { readBackup } = await import('../services/portableBackup.js');
  const buf = readBackup(sn, filename);
  if (!buf) { res.status(404).json({ ok: false, error: 'backup not found' }); return; }

  // Use parseBundle directly + spin up a staging session so /apply-verbatim
  // can run unchanged. Avoids duplicating the restore pipeline.
  let parsed;
  try { parsed = await parseBundle(buf); }
  catch (e) {
    if (e instanceof BundleValidationError) { res.status(400).json({ ok: false, error: e.message }); return; }
    throw e;
  }
  const existing = importStaging.getActive(sn);
  if (existing) {
    res.status(409).json({ ok: false, error: `active import already in progress (${existing.stagingId})` });
    return;
  }
  const session = importStaging.create(sn, {
    sourceSn: parsed.metadata.sourceSn,
    polygonAreaM2: parsed.polygon.areaM2,
  });
  const dir = path.join(process.env.STORAGE_PATH ?? './storage', 'imports', sn, session.stagingId);
  fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(parsed));
  const sourceSn = parsed.metadata?.sourceSn ?? null;
  const capability = getMowerFileCapability(sn);
  res.json({
    ok: true,
    stagingId: session.stagingId,
    state: session.state,
    exactRestore: parsedExactRestore(parsed),
    verbatimRestore: !!(parsed.mowerFiles?.csvFiles && Object.keys(parsed.mowerFiles.csvFiles).length > 0),
    sourceSn,
    sourceSnMatches: sourceSn === sn,
    ...capability,
    note: 'staging created — POST /apply-verbatim (single restore path; dock-cycle after)',
  });
});

// GET /api/admin-status/maps/:sn/export-portable
adminStatusRouter.get('/maps/:sn/export-portable', async (req: AuthRequest, res: Response) => {
  const sn = req.params.sn;
  const cal = mapRepo.getCalibration(sn);
  if (!cal?.charger_lat || !cal?.charger_lng) {
    res.status(409).json({ ok: false, error: 'no charger anchor in DB — sync_map first' });
    return;
  }
  const workRows = mapRepo.findAllByMowerSnAndType(sn, 'work').filter((w) => w.map_area);
  if (workRows.length === 0) { res.status(404).json({ ok: false, error: 'no work polygon' }); return; }
  const obstacles = mapRepo.findAllByMowerSnAndType(sn, 'obstacle');
  const unicom = mapRepo.findAllByMowerSnAndType(sn, 'unicom');

  // Fetch verbatim mower files (CSVs + charging_station.yaml + map_info.json
  // with REAL charging_pose) live via MQTT extended `read_map_files`. Falls
  // back gracefully when the mower is offline or doesn't have the handler:
  // bundle still ships with DB-derived polygons, just without the
  // exact-restore mower payload. Requires custom firmware (extended_commands.py).
  const mowerData = await new Promise<{
    csvFiles?: Record<string, string>;
    chargingStationYaml?: string;
    chargingPose?: { x: number; y: number; orientation: number };
    posJson?: string;
    mapFilesText?: Record<string, string>;
    mapFilesB64?: Record<string, string>;
  }>((resolve) => {
    let settled = false;
    const handler = (data: Record<string, unknown>) => {
      const r = data.read_map_files_respond as {
        result?: number;
        csv_files?: Record<string, string>;
        charging_station_yaml?: string;
        pos_json?: string | null;
        map_files_text?: Record<string, string>;
        map_files_b64?: Record<string, string>;
      } | undefined;
      if (!r) return;
      if (settled) return;
      settled = true;
      offExtendedResponse(sn, handler);
      if (r.result !== 0) {
        resolve({});
        return;
      }
      let chargingPose: { x: number; y: number; orientation: number } | undefined;
      const mapInfoStr = r.csv_files?.['map_info.json'];
      if (mapInfoStr) {
        try {
          const mi = JSON.parse(mapInfoStr) as { charging_pose?: { x: number; y: number; orientation: number } };
          if (mi.charging_pose
            && Number.isFinite(mi.charging_pose.x)
            && Number.isFinite(mi.charging_pose.y)
            && Number.isFinite(mi.charging_pose.orientation)) {
            chargingPose = mi.charging_pose;
          }
        } catch { /* malformed map_info.json — skip */ }
      }
      resolve({
        csvFiles: r.csv_files,
        chargingStationYaml: r.charging_station_yaml,
        chargingPose,
        posJson: r.pos_json ?? undefined,
        mapFilesText: r.map_files_text,
        mapFilesB64: r.map_files_b64,
      });
    };
    onExtendedResponse(sn, handler);
    publishToExtended(sn, { read_map_files: {} });
    // Bumped to 20 s so map.pgm + per-slot pgm/png base64 payload (~3 MB
    // on a 3-map mower) can fit on the wire without truncation.
    setTimeout(() => {
      if (settled) return;
      settled = true;
      offExtendedResponse(sn, handler);
      resolve({});
    }, 20000);
  });

  // Prefer the LIVE charging_pose (from map_info.json on disk) over the DB
  // field — DB has dual-meaning drift history (see polygon-rotation-bug.md).
  const fallbackOrient = mapRepo.getPolygonChargingOrientation(sn);
  const chargingPose = mowerData.chargingPose ?? {
    x: 0, y: 0, orientation: fallbackOrient ?? 0,
  };

  const zip = await exportBundle({
    sn,
    chargerLat: cal.charger_lat,
    chargerLng: cal.charger_lng,
    rtkQuality: null,
    chargingPose,
    workMaps: workRows.map((w, i) => ({
      canonical: w.canonical_name ?? `map${i}`,
      alias: w.map_name ?? `work${i}`,
      points: JSON.parse(w.map_area as string),
    })),
    obstacles: obstacles.filter((o) => o.map_area).map((o) => ({
      canonical: o.canonical_name ?? '',
      alias: o.map_name ?? '',
      points: JSON.parse(o.map_area as string),
    })),
    unicom: unicom.map((u) => {
      const canonical = (u.canonical_name ?? u.file_name ?? u.map_name ?? '').replace(/\.csv$/, '');
      return {
        canonical,
        targetMapName: bundleUnicomTargetName(canonical),
        points: u.map_area ? JSON.parse(u.map_area as string) : [],
      };
    }),
    csvFilesRaw: mowerData.csvFiles,
    chargingStationYaml: mowerData.chargingStationYaml,
    posJson: mowerData.posJson,
    mapFilesText: mowerData.mapFilesText,
    mapFilesB64: mowerData.mapFilesB64,
  });

  const fname = `${sn}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)}-portable.novabotmap`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(zip);
});

// Peek at metadata.json in a buffered ZIP to detect a walker-exported
// .novabundle. Walker bundles need a server-side Δ-rotate + rasterize
// pass before parseBundle accepts them, while regular mower exports
// (.novabotmap) flow straight through. We do this so the admin page
// can have ONE "Import bundle..." button instead of forcing operators
// to remember which device a file came from.
async function isWalkerBundleBuffer(buf: Buffer): Promise<boolean> {
  try {
    const dir = await unzipper.Open.buffer(buf);
    const meta = dir.files.find((f) => f.type === 'File' && f.path === 'metadata.json');
    if (!meta) return false;
    const raw = (await meta.buffer()).toString('utf8');
    const j = JSON.parse(raw) as Record<string, unknown>;
    return j.sourceType === 'walker';
  } catch {
    return false;
  }
}

function parsedExactRestore(parsed: ParsedBundle): boolean {
  return !!(parsed.mowerFiles && parsed.metadata?.originalChargingPose
    && Number.isFinite(parsed.metadata.originalChargingPose.orientation));
}

function parsedVerbatimRestore(parsed: ParsedBundle): boolean {
  return !!(parsed.mowerFiles && (
    parsed.mowerFiles.posJson ||
    (parsed.mowerFiles.mapFilesText && Object.keys(parsed.mowerFiles.mapFilesText).length > 0) ||
    (parsed.mowerFiles.mapFilesB64 && Object.keys(parsed.mowerFiles.mapFilesB64).length > 0)
  ));
}

function bundleUnicomTargetName(canonical: string): string {
  const inter = canonical.match(/^map\d+to(map\d+)_\d+_unicom$/);
  if (inter) return inter[1];
  if (/^map\d+tocharge_unicom$/.test(canonical)) return 'charge';
  const fallback = canonical.match(/^map\d+to(.+?)_?unicom$/);
  return fallback?.[1] ?? 'charge';
}

function importParsedBundleServerCopy(sn: string, parsed: ParsedBundle) {
  db.prepare(`DELETE FROM maps WHERE mower_sn = ?`).run(sn);
  const ins = db.prepare(
    `INSERT INTO maps (mower_sn, map_id, map_name, map_type, file_name, map_area, canonical_name) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const workPolys = parsed.polygons && parsed.polygons.length > 0
    ? parsed.polygons
    : [parsed.polygon];
  for (let i = 0; i < workPolys.length; i++) {
    const wp = workPolys[i];
    ins.run(sn, `imp_work_${i}`, wp.alias, 'work', `${wp.name}.csv`, JSON.stringify(wp.points), wp.name);
  }
  for (let i = 0; i < parsed.obstacles.length; i++) {
    const o = parsed.obstacles[i];
    ins.run(sn, `imp_obs_${i}`, o.alias, 'obstacle', `${o.name}.csv`, JSON.stringify(o.points), o.name);
  }
  for (let i = 0; i < parsed.unicom.length; i++) {
    const u = parsed.unicom[i];
    const mapArea = u.points.length >= 2 ? JSON.stringify(u.points) : null;
    ins.run(sn, `imp_uni_${i}`, u.targetMapName, 'unicom', `${u.name}.csv`, mapArea, u.name);
  }

  const origOrient = parsed.metadata?.originalChargingPose?.orientation;
  if (typeof origOrient === 'number' && Number.isFinite(origOrient)) {
    mapRepo.setPolygonChargingOrientation(sn, origOrient);
  }
  mapRepo.setPolygonOffset(sn, 0, 0);
  return {
    work: workPolys.length,
    obstacles: parsed.obstacles.length,
    unicom: parsed.unicom.length,
  };
}

async function writeLatestZipFromCsvFiles(sn: string, csvFiles?: Record<string, string>): Promise<number | null> {
  if (!csvFiles || Object.keys(csvFiles).length === 0) return null;
  const storage = path.resolve(process.env.STORAGE_PATH ?? './storage', 'maps');
  fs.mkdirSync(storage, { recursive: true });
  const tmpDir = path.join(storage, `tmp_server_copy_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
  const csvDir = path.join(tmpDir, 'csv_file');
  fs.mkdirSync(csvDir, { recursive: true });
  let written = 0;
  try {
    for (const [name, content] of Object.entries(csvFiles)) {
      const safeName = path.basename(name);
      if (!safeName || safeName !== name || safeName.includes('..')) continue;
      fs.writeFileSync(path.join(csvDir, safeName), content);
      written++;
    }
    if (written === 0) return null;
    const zipPath = path.join(storage, `${sn}_latest.zip`);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    const archiver = (await import('archiver')).default;
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(csvDir, 'csv_file');
      archive.finalize();
    });
    return fs.statSync(zipPath).size;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// POST /api/admin-status/maps/:sn/import-portable
adminStatusRouter.post(
  '/maps/:sn/import-portable',
  bundleUpload.single('bundle'),
  async (req: AuthRequest, res: Response) => {
    const sn = req.params.sn;
    if (!req.file) { res.status(400).json({ ok: false, error: 'bundle file required' }); return; }
    const active = importStaging.getActive(sn);
    if (active) {
      res.status(409).json({ ok: false, error: 'active import already in progress', stagingId: active.stagingId });
      return;
    }

    // Auto-detect walker bundles + transform them to a parseBundle-shaped
    // portable bundle on the fly. From here on the rest of the pipeline
    // (importStaging.create, apply-verbatim, dock-anchor refresh) treats
    // both bundle types identically.
    let bufferToParse: Buffer = req.file.buffer;
    let walkerSynth = false;
    if (await isWalkerBundleBuffer(req.file.buffer)) {
      const sensors = deviceCache.get(sn);
      const mx = parseFloat(sensors?.get('map_position_x') ?? '');
      const my = parseFloat(sensors?.get('map_position_y') ?? '');
      const mo = parseFloat(sensors?.get('map_position_orientation') ?? '');
      if (!Number.isFinite(mx) || !Number.isFinite(my) || !Number.isFinite(mo)) {
        res.status(409).json({
          ok: false,
          error: 'walker bundle requires a live map_position from the mower (online + docked)',
        });
        return;
      }
      try {
        const synth = await synthesizePortableFromWalker(req.file.buffer, {
          currentDockPose: { x: mx, y: my, orientation: mo },
          resolution: 0.05,
          marginM: 1.0,
        });
        bufferToParse = synth.portableZip;
        walkerSynth = true;
      } catch (err) {
        res.status(400).json({ ok: false, error: `walker bundle synth failed: ${(err as Error).message}` });
        return;
      }
    }

    let parsed;
    try { parsed = await parseBundle(bufferToParse); }
    catch (e) {
      if (e instanceof BundleValidationError) { res.status(400).json({ ok: false, error: e.message }); return; }
      throw e;
    }
    const session = importStaging.create(sn, {
      sourceSn: parsed.metadata.sourceSn,
      polygonAreaM2: parsed.polygon.areaM2,
    });
    // Persist the parsed bundle alongside state.json for later steps
    const dir = path.join(process.env.STORAGE_PATH ?? './storage', 'imports', sn, session.stagingId);
    fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(parsed));
    importAuditRepo.append({
      sn,
      staging_id: session.stagingId,
      from_state: '_NONE_',
      to_state: 'UPLOADED',
      reason: walkerSynth ? 'walker bundle synthesized' : null,
    });
    // Exact-restore = bundle ships verbatim mower files + valid charging_pose.
    // Verbatim-restore = full mower state ALSO ships (pos.json + map.yaml/pgm).
    const exactRestore = parsedExactRestore(parsed);
    const verbatimRestore = parsedVerbatimRestore(parsed);
    const sourceSnMatches = parsed.metadata?.sourceSn === sn;
    const capability = getMowerFileCapability(sn);
    res.json({
      ok: true,
      stagingId: session.stagingId,
      state: session.state,
      exactRestore,
      verbatimRestore,
      sourceSn: parsed.metadata?.sourceSn ?? null,
      sourceSnMatches,
      walkerSynth,
      ...capability,
    });
  },
);

// POST /api/admin-status/maps/:sn/import-walker-bundle
//
// Accepts a `.novabundle` exported by the RTK Walker. The walker captured
// polygons in its own session-local frame (origin = session start, +X = East,
// +Y = North). We need to align them with the mower's CURRENT local frame
// before handing the data off to the existing portable-bundle pipeline.
//
// Pipeline:
//   1. Read mower's live map_position from deviceCache (dock pose).
//   2. synthesizePortableFromWalker Δ-rotates + translates every walker point
//      against that pose and rasterizes a fresh map.pgm/map.yaml.
//   3. Pipe the synthetic ZIP through parseBundle and create a staging
//      session — identical shape to /import-portable so apply-verbatim
//      consumes it without modification.
adminStatusRouter.post(
  '/maps/:sn/import-walker-bundle',
  bundleUpload.single('bundle'),
  async (req: AuthRequest, res: Response) => {
    const sn = req.params.sn;
    if (!req.file) {
      res.status(400).json({ ok: false, error: 'bundle file required' });
      return;
    }
    const active = importStaging.getActive(sn);
    if (active) {
      res.status(409).json({
        ok: false,
        error: 'active import already in progress',
        stagingId: active.stagingId,
      });
      return;
    }

    // Read mower's live map_position from sensor cache.
    const sensors = deviceCache.get(sn);
    const mx = parseFloat(sensors?.get('map_position_x') ?? '');
    const my = parseFloat(sensors?.get('map_position_y') ?? '');
    const mo = parseFloat(sensors?.get('map_position_orientation') ?? '');
    if (!Number.isFinite(mx) || !Number.isFinite(my) || !Number.isFinite(mo)) {
      res.status(409).json({
        ok: false,
        error: 'no live map_position in sensor cache; is the mower online and docked?',
      });
      return;
    }
    const currentDockPose = { x: mx, y: my, orientation: mo };

    let synth;
    try {
      synth = await synthesizePortableFromWalker(req.file.buffer, {
        currentDockPose,
        resolution: 0.05,
        marginM: 1.0,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
      return;
    }

    // Pipe the synthetic bundle through the existing portable-bundle pipeline
    // so apply-verbatim sees it as just another .novabotmap.
    let parsed;
    try {
      parsed = await parseBundle(synth.portableZip);
    } catch (e) {
      if (e instanceof BundleValidationError) {
        res.status(400).json({ ok: false, error: e.message });
        return;
      }
      throw e;
    }
    const session = importStaging.create(sn, {
      sourceSn: `walker-${Date.now()}`,
      polygonAreaM2: parsed.polygon.areaM2,
    });
    const dir = path.join(process.env.STORAGE_PATH ?? './storage', 'imports', sn, session.stagingId);
    fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(parsed));
    importAuditRepo.append({
      sn,
      staging_id: session.stagingId,
      from_state: '_NONE_',
      to_state: 'UPLOADED',
      reason: 'walker bundle synthesized',
    });

    const capability = getMowerFileCapability(sn);
    res.json({
      ok: true,
      stagingId: session.stagingId,
      state: session.state,
      verbatimRestore: true,
      exactRestore: true,
      sourceSn: sn,
      sourceSnMatches: true,
      ...capability,
      note: 'walker bundle synthesized into portable bundle. POST /apply-verbatim next.',
      polygons: synth.transformedPolygons.map((p) => ({
        name: p.name,
        alias: p.alias,
        pointCount: p.points.length,
      })),
      transformedTo: currentDockPose,
    });
  },
);

// ── Walker bundle library — SN-agnostic store + assign-to-mower ────────────
//
// Flow: walker POSTs a `.novabundle` to /walker-bundles without knowing the
// target mower. The bundle lives on disk + a metadata row in `walker_bundles`.
// The admin UI lists everything and lets the operator pick a target mower,
// which feeds the bundle through the existing synthesizePortableFromWalker
// pipeline — same shape as /maps/:sn/import-walker-bundle, just without the
// walker having to know the SN at upload time.

interface WalkerBundleSummary {
  walkerId: string | null;
  polygons: number;
  obstacles: number;
  unicom: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number } | null;
}

async function inspectWalkerBundle(buf: Buffer): Promise<WalkerBundleSummary> {
  let dir;
  try {
    dir = await unzipper.Open.buffer(buf);
  } catch (err) {
    throw new Error(`not a valid ZIP: ${(err as Error).message}`);
  }
  const fileMap = new Map<string, string>();
  for (const f of dir.files) {
    if (f.type !== 'File') continue;
    if (!f.path.endsWith('.json')) continue;
    const raw = await f.buffer();
    fileMap.set(f.path, raw.toString('utf8'));
  }

  function parseArr(name: string): unknown[] {
    const raw = fileMap.get(name);
    if (raw == null) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  const polygons = parseArr('polygons.json');
  const obstacles = parseArr('obstacles.json');
  const unicom = parseArr('unicom.json');

  let walkerId: string | null = null;
  let bounds: WalkerBundleSummary['bounds'] = null;
  const metaRaw = fileMap.get('metadata.json');
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw) as Record<string, unknown>;
      if (typeof meta.walkerId === 'string') walkerId = meta.walkerId;
      const b = meta.boundsM as Record<string, unknown> | undefined;
      if (b && typeof b === 'object') {
        const minX = Number(b.minX);
        const maxX = Number(b.maxX);
        const minY = Number(b.minY);
        const maxY = Number(b.maxY);
        if ([minX, maxX, minY, maxY].every(Number.isFinite)) {
          bounds = { minX, maxX, minY, maxY };
        }
      }
    } catch { /* ignore — bundle without metadata.json still uploads */ }
  }

  return {
    walkerId,
    polygons: polygons.length,
    obstacles: obstacles.length,
    unicom: unicom.length,
    bounds,
  };
}

function walkerBundleToDto(row: WalkerBundleRow) {
  return {
    id: row.id,
    filename: row.filename,
    uploadedAt: row.uploaded_at,
    walkerId: row.walker_id,
    sizeBytes: row.size_bytes,
    polygons: row.polygon_count,
    obstacles: row.obstacle_count,
    unicom: row.unicom_count,
    bounds:
      row.bounds_min_x != null &&
      row.bounds_max_x != null &&
      row.bounds_min_y != null &&
      row.bounds_max_y != null
        ? {
            minX: row.bounds_min_x,
            maxX: row.bounds_max_x,
            minY: row.bounds_min_y,
            maxY: row.bounds_max_y,
          }
        : null,
    lastAssignedSn: row.last_assigned_sn,
    lastAssignedAt: row.last_assigned_at,
  };
}

// Walker bundle upload handler. Exposed so index.ts can mount this on a
// public path (no admin auth) for the walker. The previous admin-router
// mount stays disabled — uploads from the admin UI are not a real flow.
// Note: walker request hits multer first via walkerBundleUploadMulter.
export async function handleWalkerBundleUpload(req: express.Request, res: express.Response): Promise<void> {
  const upload = (req as express.Request & { file?: Express.Multer.File }).file;
  if (!upload) {
    res.status(400).json({ ok: false, error: 'bundle file required' });
    return;
  }

  let summary: WalkerBundleSummary;
  try {
    summary = await inspectWalkerBundle(upload.buffer);
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
    return;
  }

  // Unique filename = timestamp + 4-byte random hex; readable + collision-safe.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rnd = crypto.randomBytes(3).toString('hex');
  const safeWalker = summary.walkerId
    ? summary.walkerId.replace(/[^A-Za-z0-9_-]/g, '')
    : 'walker';
  const filename = `${stamp}_${safeWalker}_${rnd}.novabundle`;
  const filePath = path.join(walkerBundlesDir, filename);

  try {
    fs.mkdirSync(walkerBundlesDir, { recursive: true });
    fs.writeFileSync(filePath, upload.buffer);
  } catch (err) {
    res.status(500).json({ ok: false, error: `failed to persist bundle: ${(err as Error).message}` });
    return;
  }

  const id = walkerBundleRepo.create({
    filename,
    uploaded_at: new Date().toISOString(),
    walker_id: summary.walkerId,
    size_bytes: upload.size,
    polygon_count: summary.polygons,
    obstacle_count: summary.obstacles,
    unicom_count: summary.unicom,
    bounds_min_x: summary.bounds?.minX ?? null,
    bounds_max_x: summary.bounds?.maxX ?? null,
    bounds_min_y: summary.bounds?.minY ?? null,
    bounds_max_y: summary.bounds?.maxY ?? null,
  });

  const row = walkerBundleRepo.findById(id);
  res.json({
    ok: true,
    id,
    filename,
    size: upload.size,
    polygons: summary.polygons,
    obstacles: summary.obstacles,
    unicom: summary.unicom,
    walkerId: summary.walkerId,
    bundle: row ? walkerBundleToDto(row) : null,
  });
}

// GET /api/admin-status/walker-bundles — list every uploaded bundle.
adminStatusRouter.get('/walker-bundles', (_req: AuthRequest, res: Response) => {
  const rows = walkerBundleRepo.listAll();
  res.json({ bundles: rows.map(walkerBundleToDto) });
});

// GET /api/admin-status/walker-bundles/:id — stream the raw .novabundle.
adminStatusRouter.get('/walker-bundles/:id', (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ ok: false, error: 'invalid id' });
    return;
  }
  const row = walkerBundleRepo.findById(id);
  if (!row) {
    res.status(404).json({ ok: false, error: 'bundle not found' });
    return;
  }
  const safe = path.basename(row.filename);
  const filePath = path.join(walkerBundlesDir, safe);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ ok: false, error: 'bundle file missing on disk' });
    return;
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
  fs.createReadStream(filePath).pipe(res);
});

// DELETE /api/admin-status/walker-bundles/:id — remove disk file + DB row.
adminStatusRouter.delete('/walker-bundles/:id', (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ ok: false, error: 'invalid id' });
    return;
  }
  const row = walkerBundleRepo.findById(id);
  if (!row) {
    res.status(404).json({ ok: false, error: 'bundle not found' });
    return;
  }
  const safe = path.basename(row.filename);
  const filePath = path.join(walkerBundlesDir, safe);
  try { fs.unlinkSync(filePath); } catch { /* file already gone is fine */ }
  const removed = walkerBundleRepo.delete(id);
  res.json({ ok: removed });
});

// POST /api/admin-status/walker-bundles/:id/apply — pick the target mower for a
// stored bundle. Reads the file off disk, runs the same synthesize +
// parseBundle + create-staging pipeline the per-SN endpoint uses, and marks
// the DB row as assigned. Returns the staging shape so the admin page can
// continue straight into apply-verbatim.
adminStatusRouter.post(
  '/walker-bundles/:id/apply',
  async (req: AuthRequest, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ ok: false, error: 'invalid id' });
      return;
    }
    const sn = typeof req.body?.sn === 'string' ? req.body.sn.trim() : '';
    if (!sn) {
      res.status(400).json({ ok: false, error: 'sn required in body' });
      return;
    }
    const row = walkerBundleRepo.findById(id);
    if (!row) {
      res.status(404).json({ ok: false, error: 'bundle not found' });
      return;
    }

    // Target mower must be a real device on this server.
    const equipment = equipmentRepo.findBySn(sn);
    if (!equipment) {
      res.status(404).json({ ok: false, error: `mower ${sn} not bound on this server` });
      return;
    }

    const active = importStaging.getActive(sn);
    if (active) {
      res.status(409).json({
        ok: false,
        error: 'active import already in progress for that mower',
        stagingId: active.stagingId,
      });
      return;
    }

    const sensors = deviceCache.get(sn);
    const mx = parseFloat(sensors?.get('map_position_x') ?? '');
    const my = parseFloat(sensors?.get('map_position_y') ?? '');
    const mo = parseFloat(sensors?.get('map_position_orientation') ?? '');
    if (!Number.isFinite(mx) || !Number.isFinite(my) || !Number.isFinite(mo)) {
      res.status(409).json({
        ok: false,
        error: 'no live map_position in sensor cache; is the mower online and docked?',
      });
      return;
    }
    const currentDockPose = { x: mx, y: my, orientation: mo };

    const safe = path.basename(row.filename);
    const filePath = path.join(walkerBundlesDir, safe);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(filePath);
    } catch {
      res.status(404).json({ ok: false, error: 'bundle file missing on disk' });
      return;
    }

    let synth;
    try {
      synth = await synthesizePortableFromWalker(buf, {
        currentDockPose,
        resolution: 0.05,
        marginM: 1.0,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
      return;
    }

    let parsed;
    try {
      parsed = await parseBundle(synth.portableZip);
    } catch (e) {
      if (e instanceof BundleValidationError) {
        res.status(400).json({ ok: false, error: e.message });
        return;
      }
      throw e;
    }

    const session = importStaging.create(sn, {
      sourceSn: `walker-${row.id}`,
      polygonAreaM2: parsed.polygon.areaM2,
    });
    const stagingDir = path.join(
      process.env.STORAGE_PATH ?? './storage',
      'imports',
      sn,
      session.stagingId,
    );
    fs.writeFileSync(path.join(stagingDir, 'bundle.json'), JSON.stringify(parsed));
    importAuditRepo.append({
      sn,
      staging_id: session.stagingId,
      from_state: '_NONE_',
      to_state: 'UPLOADED',
      reason: `walker bundle library id=${row.id}`,
    });

    walkerBundleRepo.markAssigned(row.id, sn, new Date().toISOString());

    const capability = getMowerFileCapability(sn);
    res.json({
      ok: true,
      stagingId: session.stagingId,
      state: session.state,
      verbatimRestore: true,
      exactRestore: true,
      sourceSn: sn,
      sourceSnMatches: true,
      ...capability,
      note: 'walker bundle synthesized into portable bundle. POST /apply-verbatim next.',
      polygons: synth.transformedPolygons.map((p) => ({
        name: p.name,
        alias: p.alias,
        pointCount: p.points.length,
      })),
      transformedTo: currentDockPose,
      bundle: walkerBundleToDto({ ...row, last_assigned_sn: sn, last_assigned_at: new Date().toISOString() }),
    });
  },
);

// ── Portable map import — staged endpoints (Tasks 11-15) ────────────────────

// GET /api/admin-status/maps/:sn/import-portable/active
// NOTE: must be registered BEFORE /:stagingId/... routes to avoid Express
// matching "active" as a stagingId.
adminStatusRouter.get('/maps/:sn/import-portable/active', (req: AuthRequest, res: Response) => {
  const sn = req.params.sn;
  const active = importStaging.getActive(sn);
  if (!active) { res.json({ stagingId: null, state: null }); return; }
  // Surface exactRestore + verbatimRestore + sourceSn match so the wizard
  // can hide unnecessary steps and pick the right Apply path.
  let exactRestore = false;
  let verbatimRestore = false;
  let sourceSn: string | null = null;
  let sourceSnMatches = false;
  try {
    const dir = path.join(process.env.STORAGE_PATH ?? './storage', 'imports', sn, active.stagingId);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8')) as ParsedBundle;
    exactRestore = parsedExactRestore(parsed);
    verbatimRestore = parsedVerbatimRestore(parsed);
    sourceSn = parsed?.metadata?.sourceSn ?? null;
    sourceSnMatches = sourceSn === sn;
  } catch { /* bundle missing — leave flags false */ }
  const capability = getMowerFileCapability(sn);
  res.json({
    stagingId: active.stagingId,
    state: active.state,
    exactRestore,
    verbatimRestore,
    sourceSn,
    sourceSnMatches,
    ...capability,
  });
});

// GET /api/admin-status/maps/:sn/import-portable/:stagingId/inventory
//
// Lists every file in the staged bundle classified into work / obstacle /
// unicom / meta / dock categories, plus the same classification of files
// currently on the mower (via MQTT extended `read_map_files`). The import
// wizard's selective-apply step uses this to render checkboxes per
// category and detect collisions for add-only mode.
adminStatusRouter.get(
  '/maps/:sn/import-portable/:stagingId/inventory',
  async (req: AuthRequest, res: Response) => {
    const { sn, stagingId } = req.params;
    const session = importStaging.get(stagingId);
    if (!session || session.sn !== sn) {
      res.status(404).json({ ok: false, error: 'unknown staging session' });
      return;
    }

    const dir = path.join(process.env.STORAGE_PATH ?? './storage', 'imports', sn, stagingId);
    let bundle: { csvFiles: Record<string, string>; chargingStationYaml: string | null };
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8'));
      bundle = {
        csvFiles: (parsed.mowerFiles?.csvFiles as Record<string, string> | undefined) ?? {},
        chargingStationYaml: (parsed.mowerFiles?.chargingStationYaml as string | null | undefined) ?? null,
      };
    } catch (err) {
      res.status(500).json({ ok: false, error: `failed to read staging bundle: ${(err as Error).message}` });
      return;
    }

    const bundleClass = classifyBundle(bundle);

    // Mower-side enumeration is best-effort. Offline mower → empty list,
    // operator can still proceed in "replace" mode (overwrites whatever
    // is there). For "add-only" the UI should refuse to apply when the
    // mower list is empty (server-side enforcement happens at apply time
    // via a fresh read_map_files call against the live state).
    let mowerSide: ClassifyResult | null = null;
    if (isDeviceOnline(sn)) {
      const mowerData = await new Promise<{ csvFiles?: Record<string, string>; chargingStationYaml?: string | null }>(resolve => {
        let settled = false;
        const handler = (data: Record<string, unknown>) => {
          const r = data.read_map_files_respond as
            | { result?: number; csv_files?: Record<string, string>; charging_station_yaml?: string }
            | undefined;
          if (!r || settled) return;
          settled = true;
          offExtendedResponse(sn, handler);
          if (r.result !== 0) { resolve({}); return; }
          resolve({ csvFiles: r.csv_files, chargingStationYaml: r.charging_station_yaml ?? null });
        };
        onExtendedResponse(sn, handler);
        publishToExtended(sn, { read_map_files: {} });
        setTimeout(() => {
          if (settled) return;
          settled = true;
          offExtendedResponse(sn, handler);
          resolve({});
        }, 8000);
      });
      if (mowerData.csvFiles) {
        mowerSide = classifyBundle({
          csvFiles: mowerData.csvFiles,
          chargingStationYaml: mowerData.chargingStationYaml ?? null,
        });
      }
    }

    res.json({
      ok: true,
      stagingId,
      bundle: bundleClass,
      mower: mowerSide,
    });
  },
);

// POST /api/admin-status/maps/:sn/import-portable/:stagingId/start-drive
// Drive the mower 1 m backward off the dock and derive heading from RTK delta.
// No pre-RTK requirement: the act of driving away from the dock typically
// upgrades loc_quality from FLOAT to FIX once the mower clears the charger
// metal and gets clean sky. We snapshot start pose immediately (whatever
// quality is available), drive, then poll for RTK FIX up to 30 s before
// snapshotting end pose. If RTK never reaches 100, abort with reason.
adminStatusRouter.post(
  '/maps/:sn/import-portable/:stagingId/start-drive',
  async (req: AuthRequest, res: Response) => {
    const { sn, stagingId } = req.params;
    const session = importStaging.get(stagingId);
    if (!session || session.sn !== sn) {
      res.status(404).json({ ok: false, error: 'unknown staging session' });
      return;
    }
    if (session.state !== 'UPLOADED') {
      res.status(409).json({ ok: false, error: `wrong state ${session.state}` });
      return;
    }

    const sensors = deviceCache.get(sn);
    const startLat = parseFloat(sensors?.get('latitude') ?? '');
    const startLng = parseFloat(sensors?.get('longitude') ?? '');
    if (!Number.isFinite(startLat) || !Number.isFinite(startLng)) {
      res.status(409).json({ ok: false, error: 'no GPS for start_pose' });
      return;
    }

    // Don't transition yet — keep state in UPLOADED until we know the
    // drive + RTK lock actually succeeded. On failure we leave the staging
    // session intact so the operator can retry "Start drive" without
    // re-uploading the bundle.
    importAuditRepo.append({ sn, staging_id: stagingId, from_state: 'UPLOADED', to_state: 'UPLOADED', reason: 'drive started' });

    // Stock MQTT joystick wire format (matches socketHandler.ts):
    //   start_move:4 = backward direction enum
    //   mst array [x_w*100, y_v*100, 8] every 150ms (signed; -y = backward)
    //   start_move keepalive every 5 ticks
    //   stop_move:null on stop
    publishToDevice(sn, { start_move: 4 });
    await new Promise((r) => setTimeout(r, 200));
    const TICK_MS = 150;
    const TOTAL_TICKS = 20;
    const Y_V_BACKWARD = -50;
    for (let i = 0; i < TOTAL_TICKS; i++) {
      publishToDevice(sn, { mst: [0, Y_V_BACKWARD, 8] });
      if (i > 0 && i % 5 === 0) {
        publishToDevice(sn, { start_move: 4 });
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
    publishToDevice(sn, { stop_move: null });
    await new Promise((r) => setTimeout(r, 500));

    // Wait for RTK FIX before reading end pose. Polls the sensor cache every
    // 1 s for up to 30 s. If RTK never reaches 100 → bail out with the best
    // available quality so the operator can decide whether to retry.
    let waitedMs = 0;
    let endLocQ = parseInt(sensors?.get('loc_quality') ?? '', 10);
    while (endLocQ !== 100 && waitedMs < 30_000) {
      await new Promise((r) => setTimeout(r, 1000));
      waitedMs += 1000;
      endLocQ = parseInt(sensors?.get('loc_quality') ?? '', 10);
    }

    const endLat = parseFloat(sensors?.get('latitude') ?? '');
    const endLng = parseFloat(sensors?.get('longitude') ?? '');
    const heading = deriveHeading({ lat: startLat, lng: startLng }, { lat: endLat, lng: endLng });
    if (heading.shortDistance || endLocQ !== 100) {
      // Drive failed but recoverable: stay in UPLOADED, operator can retry.
      const reason = heading.shortDistance
        ? `drive distance ${heading.distanceM.toFixed(2)}m below 0.3m threshold`
        : `RTK FIX never reached after ${waitedMs / 1000}s wait (loc_quality=${endLocQ})`;
      importAuditRepo.append({ sn, staging_id: stagingId, from_state: 'UPLOADED', to_state: 'UPLOADED', reason });
      res.status(409).json({ ok: false, error: reason, recoverable: true });
      return;
    }

    // Mower drove backward → flip GPS heading by π to recover forward heading.
    const TWO_PI = Math.PI * 2;
    const forwardHeadingRad = ((heading.headingRad + Math.PI + Math.PI) % TWO_PI) - Math.PI;

    // Drive + RTK both OK: transition UPLOADED → AUTO_DOCK in one go.
    const updated = importStaging.transition(stagingId, 'AUTO_DOCK', {
      driveStart: { lat: startLat, lng: startLng },
      driveEnd: { lat: endLat, lng: endLng },
      derivedHeadingRad: forwardHeadingRad,
    });
    importAuditRepo.append({ sn, staging_id: stagingId, from_state: 'UPLOADED', to_state: 'AUTO_DOCK', reason: null });
    res.json({
      ok: true, state: updated.state,
      derivedHeadingRad: forwardHeadingRad,
      distanceM: heading.distanceM,
      rtkWaitMs: waitedMs,
    });
  },
);

// POST /api/admin-status/maps/:sn/import-portable/:stagingId/auto-dock
// Operator manually returns the mower to the dock (push or Control-tab
// joystick). Server verifies battery_state CHARGING + RTK FIX, snapshots
// the dock GPS as new charger anchor.
//
// We tried save_recharge_pos for ArUco-only auto-dock — firmware rejects
// it outside an active scan_map session (returns result:1 dis:0 immediately).
// go_to_charge requires a loaded polygon (Error 107 if csv_file/ wiped).
// Manual return is the only path that works in any state, so that's what
// the import flow uses today. ArUco automation can be revisited later if
// we find a firmware command that triggers it without scan-state.
adminStatusRouter.post(
  '/maps/:sn/import-portable/:stagingId/auto-dock',
  async (req: AuthRequest, res: Response) => {
    const { sn, stagingId } = req.params;
    const session = importStaging.get(stagingId);
    if (!session || session.sn !== sn) {
      res.status(404).json({ ok: false, error: 'unknown staging session' });
      return;
    }
    // Allow direct UPLOADED→ANCHOR_SET for exact-restore bundles (Δ rotation
    // from stored vs current charging_pose makes the drive-back step
    // unnecessary). Legacy bundles still go UPLOADED→AUTO_DOCK→ANCHOR_SET.
    if (session.state !== 'AUTO_DOCK' && session.state !== 'UPLOADED') {
      res.status(409).json({ ok: false, error: `wrong state ${session.state}` });
      return;
    }

    const sensors = deviceCache.get(sn);
    const batt = (sensors?.get('battery_state') ?? '').toUpperCase();
    const locQ = parseInt(sensors?.get('loc_quality') ?? '', 10);
    const lat = parseFloat(sensors?.get('latitude') ?? '');
    const lng = parseFloat(sensors?.get('longitude') ?? '');

    if (!batt.includes('CHARGING') && !batt.includes('FINISHED')) {
      res.status(409).json({
        ok: false, recoverable: true,
        error: `mower not on dock — battery_state=${batt || 'unknown'} (need CHARGING)`,
      });
      return;
    }
    if (locQ !== 100) {
      res.status(409).json({
        ok: false, recoverable: true,
        error: `RTK FIX required at dock — loc_quality=${locQ}`,
      });
      return;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(409).json({ ok: false, recoverable: true, error: 'no GPS in sensor cache' });
      return;
    }

    // Capture the mower's CURRENT map_position too — /confirm uses it to
    // translate the rebased polygon so the unicom anchor lines up with
    // where firmware reports the dock. Without this the polygon ends up
    // rotated correctly but shifted by whatever offset the original map
    // had between its (0,0) origin and the dock.
    const mx = parseFloat(sensors?.get('map_position_x') ?? '');
    const my = parseFloat(sensors?.get('map_position_y') ?? '');
    const mo = parseFloat(sensors?.get('map_position_orientation') ?? '');
    if (!Number.isFinite(mx) || !Number.isFinite(my)) {
      res.status(409).json({ ok: false, recoverable: true, error: 'no map_position in sensor cache' });
      return;
    }

    const updated = importStaging.transition(stagingId, 'ANCHOR_SET', {
      newCharger: { lat, lng },
      newDockMapPosition: { x: mx, y: my, orientation: Number.isFinite(mo) ? mo : 0 },
    });
    importAuditRepo.append({ sn, staging_id: stagingId, from_state: 'AUTO_DOCK', to_state: 'ANCHOR_SET', reason: null });
    res.json({
      ok: true, state: updated.state,
      newCharger: updated.context.newCharger,
    });
  },
);

// GET /api/admin-status/maps/:sn/import-portable/:stagingId/preview
// Returns a GeoJSON FeatureCollection of the rebased polygon for Leaflet overlay.
adminStatusRouter.get(
  '/maps/:sn/import-portable/:stagingId/preview',
  (req: AuthRequest, res: Response) => {
    const { sn, stagingId } = req.params;
    const session = importStaging.get(stagingId);
    if (!session || session.sn !== sn) {
      res.status(404).json({ ok: false, error: 'unknown' });
      return;
    }
    if (session.state !== 'ANCHOR_SET' && session.state !== 'PREVIEW_SHOWN') {
      res.status(409).json({ ok: false, error: `wrong state ${session.state}` });
      return;
    }
    const dir = path.join(process.env.STORAGE_PATH ?? './storage', 'imports', sn, stagingId);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8'));
    // Rotation is the DELTA between the new dock heading we just measured
    // and the old dock heading captured in the bundle metadata. Re-importing
    // on the same mower (same orientation as export) → delta ~0, polygon
    // stays put. Importing on a different machine where dock is rotated
    // 90° → delta = π/2. Using the full derivedHeadingRad would over-rotate
    // by `originalChargingPose.orientation`, which is what produced the
    // 85°/quarter-turn drift observed live on LFIN1231000211 2026-05-07.
    const origOrient = parsed.metadata?.originalChargingPose?.orientation ?? 0;
    // Live rotation override: ?rotateDeg=<deg> lets the operator preview
    // alternate orientations when the bundle's stored frame is mis-aligned
    // with real-world ENU. Without override falls back to delta math.
    const rotateOverrideDeg = req.query.rotateDeg !== undefined
      ? parseFloat(String(req.query.rotateDeg))
      : null;
    const theta = rotateOverrideDeg !== null && Number.isFinite(rotateOverrideDeg)
      ? (rotateOverrideDeg * Math.PI) / 180
      : (session.context.derivedHeadingRad ?? 0) - origOrient;
    // Live offset override: shifts polygon AFTER rotation+anchor-translate.
    // Use to nudge into place when bundle's polygon sits off real world by
    // a known displacement (e.g. mower remapped from a different start point).
    const offsetXm = req.query.offsetX !== undefined ? parseFloat(String(req.query.offsetX)) : 0;
    const offsetYm = req.query.offsetY !== undefined ? parseFloat(String(req.query.offsetY)) : 0;
    const anchor = session.context.newCharger!;
    // WGS84-aware m/deg — replaces flat 111320 constant (issue #53).
    const mLat = metersPerDegLat(anchor.lat);
    const mLng = metersPerDegLng(anchor.lat);
    // Rotate + translate so the unicom anchor lines up with the new charger
    // GPS — same math as /confirm, kept in lockstep so the on-screen
    // overlay matches what gets written to the DB.
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const firstUnicomRaw = (parsed.unicom[0]?.points?.[0] ?? { x: 0, y: 0 }) as { x: number; y: number };
    const rotatedAnchor = {
      x: firstUnicomRaw.x * cosT + firstUnicomRaw.y * sinT,
      y: -firstUnicomRaw.x * sinT + firstUnicomRaw.y * cosT,
    };
    const project = (pts: { x: number; y: number }[]): [number, number][] => {
      return pts.map((p) => {
        const rx = p.x * cosT + p.y * sinT - rotatedAnchor.x + offsetXm;
        const ry = -p.x * sinT + p.y * cosT - rotatedAnchor.y + offsetYm;
        return [anchor.lng + rx / mLng, anchor.lat + ry / mLat];
      });
    };
    const features: unknown[] = [];
    // Multi-map bundles (>= schema with polygons.json) expose every work
    // polygon in `parsed.polygons`. Older single-map bundles fall back to
    // the legacy `polygon` field — wrap into an array so the renderer
    // treats them uniformly.
    const workPolygons: Array<{ name: string; alias: string; points: { x: number; y: number }[] }> =
      Array.isArray(parsed.polygons) && parsed.polygons.length > 0 ? parsed.polygons : [parsed.polygon];
    for (const wp of workPolygons) {
      const workRing = project(wp.points);
      workRing.push(workRing[0]);
      features.push({ type: 'Feature', properties: { name: wp.alias, kind: 'work' }, geometry: { type: 'Polygon', coordinates: [workRing] } });
    }
    for (const o of parsed.obstacles) {
      const ring = project(o.points);
      ring.push(ring[0]);
      features.push({ type: 'Feature', properties: { name: o.alias, kind: 'obstacle' }, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    for (const u of parsed.unicom) {
      features.push({ type: 'Feature', properties: { name: u.targetMapName, kind: 'unicom' }, geometry: { type: 'LineString', coordinates: project(u.points) } });
    }
    importStaging.transition(stagingId, 'PREVIEW_SHOWN', {});
    importAuditRepo.append({ sn, staging_id: stagingId, from_state: session.state, to_state: 'PREVIEW_SHOWN', reason: null });
    res.json({ type: 'FeatureCollection', features });
  },
);

// POST /api/admin-status/maps/:sn/import-portable/:stagingId/confirm
// Final commit: write polygon to DB, push set_pos_origin + sync_map to mower.
adminStatusRouter.post(
  '/maps/:sn/import-portable/:stagingId/confirm',
  async (req: AuthRequest, res: Response) => {
    const { sn, stagingId } = req.params;
    const session = importStaging.get(stagingId);
    if (!session || session.sn !== sn) {
      res.status(404).json({ ok: false, error: 'unknown' });
      return;
    }
    if (session.state !== 'PREVIEW_SHOWN') {
      res.status(409).json({ ok: false, error: `wrong state ${session.state}` });
      return;
    }
    if (!getMowerFileCapability(sn).mowerFileApplySupported) {
      res.status(409).json(mowerFileUnsupportedPayload(sn));
      return;
    }

    importStaging.transition(stagingId, 'USER_CONFIRMED', {});
    importAuditRepo.append({ sn, staging_id: stagingId, from_state: 'PREVIEW_SHOWN', to_state: 'USER_CONFIRMED', reason: null });

    const dir = path.join(process.env.STORAGE_PATH ?? './storage', 'imports', sn, stagingId);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8'));
    // See /preview for theta-delta rationale. Same formula here so the
    // committed polygon matches what the operator approved. /preview can
    // override rotation via ?rotateDeg, so accept the same in /confirm body
    // (or query) — the operator commits whatever they previewed.
    const origOrient = parsed.metadata?.originalChargingPose?.orientation ?? 0;
    const rotateOverrideDegRaw = (req.body?.rotateDeg ?? req.query?.rotateDeg);
    const rotateOverrideDeg = rotateOverrideDegRaw !== undefined && rotateOverrideDegRaw !== null && rotateOverrideDegRaw !== ''
      ? parseFloat(String(rotateOverrideDegRaw))
      : null;
    const theta = rotateOverrideDeg !== null && Number.isFinite(rotateOverrideDeg)
      ? (rotateOverrideDeg * Math.PI) / 180
      : (session.context.derivedHeadingRad ?? 0) - origOrient;
    const offsetXmRaw = (req.body?.offsetX ?? req.query?.offsetX);
    const offsetYmRaw = (req.body?.offsetY ?? req.query?.offsetY);
    const offsetXm = offsetXmRaw !== undefined && offsetXmRaw !== null && offsetXmRaw !== '' ? parseFloat(String(offsetXmRaw)) : 0;
    const offsetYm = offsetYmRaw !== undefined && offsetYmRaw !== null && offsetYmRaw !== '' ? parseFloat(String(offsetYmRaw)) : 0;
    const anchor = session.context.newCharger!;
    const dockMP = session.context.newDockMapPosition;

    // Update charger anchor + orientation in DB. polygon_charging_orientation
    // holds the absolute new dock heading (not the rebase delta) — this is
    // what gets exported next time as `originalChargingPose.orientation`.
    mapRepo.setChargerGps(sn, anchor.lat, anchor.lng);
    mapRepo.setPolygonChargingOrientation(sn, session.context.derivedHeadingRad ?? 0);
    mapRepo.setPolygonOffset(sn, 0, 0);

    // Polygon rebase = rotation by derived θ + translation so the unicom
    // anchor lands exactly at the mower's current map_position at the dock.
    // Without the translation, the bundle's original "charger in old map
    // frame" coords (e.g. (-1.21, 0.48)) end up wherever the rotation moves
    // them to — typically NOT where the firmware's localization places
    // the dock — and mowing then drives off-target by the unmatched offset.
    const firstUnicomRaw = (parsed.unicom[0]?.points?.[0] ?? { x: 0, y: 0 }) as { x: number; y: number };
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const rotatedAnchor = {
      x: firstUnicomRaw.x * cos + firstUnicomRaw.y * sin,
      y: -firstUnicomRaw.x * sin + firstUnicomRaw.y * cos,
    };
    const tx = (dockMP?.x ?? 0) - rotatedAnchor.x + offsetXm;
    const ty = (dockMP?.y ?? 0) - rotatedAnchor.y + offsetYm;
    const rebase = (pts: { x: number; y: number }[]) =>
      computeAnchorRebase(pts, theta).map((p) => ({ x: p.x + tx, y: p.y + ty }));

    // Replace all polygon rows for this SN
    db.prepare(`DELETE FROM maps WHERE mower_sn = ?`).run(sn);
    const ins = db.prepare(
      `INSERT INTO maps (mower_sn, map_id, map_name, map_type, file_name, map_area, canonical_name) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
    const workPolygons: Array<{ name: string; alias: string; points: { x: number; y: number }[] }> =
      Array.isArray(parsed.polygons) && parsed.polygons.length > 0 ? parsed.polygons : [parsed.polygon];
    for (let wi = 0; wi < workPolygons.length; wi++) {
      const wp = workPolygons[wi];
      ins.run(sn, `imp_work_${wi}`, wp.alias, 'work', wp.name + '.csv', JSON.stringify(rebase(wp.points)), wp.name);
    }
    for (let i = 0; i < parsed.obstacles.length; i++) {
      const o = parsed.obstacles[i];
      ins.run(sn, `imp_obs_${i}`, o.alias, 'obstacle', o.name + '.csv', JSON.stringify(rebase(o.points)), o.name);
    }
    for (let i = 0; i < parsed.unicom.length; i++) {
      const u = parsed.unicom[i];
      ins.run(sn, `imp_uni_${i}`, u.targetMapName, 'unicom', u.name + '.csv', JSON.stringify(rebase(u.points)), u.name);
    }

    // Push new origin to mower then trigger sync_map
    publishToExtended(sn, { set_pos_origin: { lat: anchor.lat, lng: anchor.lng } });
    publishToExtended(sn, { sync_map: {} });

    // Synthesize map.png + map.yaml on the mower so start_navigation has a
    // raster to load. Portable import skips save_map type:1 (no real scan
    // session), and without these files coverage_planner aborts Error 107.
    // We pick the smallest empty raster that covers the rebased polygon
    // bbox + 2m margin and shift its origin so the polygon sits inside.
    const allPoints: { x: number; y: number }[] = [];
    for (const wp of workPolygons) allPoints.push(...rebase(wp.points));
    for (const o of parsed.obstacles) allPoints.push(...rebase(o.points));
    for (const u of parsed.unicom) allPoints.push(...rebase(u.points));
    if (allPoints.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of allPoints) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const margin = 2.0;
      const spanX = maxX - minX + 2 * margin;
      const spanY = maxY - minY + 2 * margin;
      const size = Math.max(spanX, spanY) > 30 ? 60 : 30;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const originX = cx - size / 2;
      const originY = cy - size / 2;
      publishToExtended(sn, {
        generate_empty_map: { origin_x: originX, origin_y: originY, size, index: 0 },
      });
    }

    // Exact-restore path: if the bundle ships with verbatim mower CSVs +
    // charging_station.yaml, push the transformed copies straight to disk
    // via the new MQTT extended write_map_files handler. This bypasses the
    // sync_map roundtrip and gives an identical-to-export firmware state
    // (modulo Δ rotation + translation aligning the polygon to the current
    // dock pose). Older bundles without these fields skip this block; the
    // legacy DB+sync_map path above remains the source of truth for them.
    const mowerFiles = parsed.mowerFiles as
      | { csvFiles: Record<string, string>; chargingStationYaml: string | null }
      | undefined;
    const origPose = parsed.metadata?.originalChargingPose as
      | { x: number; y: number; orientation: number }
      | undefined;
    if (mowerFiles && origPose && dockMP) {
      const dt = (dockMP.orientation ?? 0) - origPose.orientation;
      const cosDt = Math.cos(dt);
      const sinDt = Math.sin(dt);
      const transformPoint = (px: number, py: number): [number, number] => {
        const relX = px - origPose.x;
        const relY = py - origPose.y;
        const rx = relX * cosDt - relY * sinDt;
        const ry = relX * sinDt + relY * cosDt;
        return [rx + dockMP.x, ry + dockMP.y];
      };
      const transformedCsvs: Record<string, string> = {};
      for (const [fname, content] of Object.entries(mowerFiles.csvFiles)) {
        if (fname === 'map_info.json') {
          // Re-emit map_info with the NEW charging_pose so firmware sees
          // dock at its current frame position. Preserve other fields
          // (e.g. map<name>.csv map_size entries) verbatim.
          try {
            const mi = JSON.parse(content) as Record<string, unknown>;
            mi.charging_pose = {
              x: dockMP.x,
              y: dockMP.y,
              orientation: dockMP.orientation ?? 0,
            };
            transformedCsvs[fname] = JSON.stringify(mi, null, 3);
          } catch {
            transformedCsvs[fname] = content;
          }
          continue;
        }
        if (!fname.endsWith('.csv')) {
          transformedCsvs[fname] = content;
          continue;
        }
        // Point-data CSV — each line is "x,y" in OLD mower frame.
        const lines = content.split('\n');
        const out: string[] = [];
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) { out.push(''); continue; }
          const parts = line.split(',');
          if (parts.length < 2) { out.push(line); continue; }
          const px = parseFloat(parts[0]);
          const py = parseFloat(parts[1]);
          if (!Number.isFinite(px) || !Number.isFinite(py)) {
            out.push(line);
            continue;
          }
          const [nx, ny] = transformPoint(px, py);
          out.push(`${nx.toFixed(2)},${ny.toFixed(2)}`);
        }
        transformedCsvs[fname] = out.join('\n');
      }
      const newYaml = `charging_pose: [${dockMP.x}, ${dockMP.y}, ${dockMP.orientation ?? 0}]\n`;
      publishToExtended(sn, {
        write_map_files: {
          csv_files: transformedCsvs,
          charging_station_yaml: newYaml,
          restart_mapping: false,
        },
      });
    }

    importStaging.transition(stagingId, 'APPLIED', { applyResult: {} });
    importAuditRepo.append({ sn, staging_id: stagingId, from_state: 'USER_CONFIRMED', to_state: 'APPLIED', reason: null });
    res.json({
      ok: true,
      state: 'APPLIED',
      exactRestore: !!(mowerFiles && origPose && dockMP),
    });
  },
);

// POST /api/admin-status/maps/:sn/import-portable/:stagingId/import-server-copy
//
// Stock-safe restore path: update only the server DB + app-facing latest ZIP.
// This does NOT write any files to the mower, so mowing only works if the same
// map files already exist on the mower.
adminStatusRouter.post(
  '/maps/:sn/import-portable/:stagingId/import-server-copy',
  async (req: AuthRequest, res: Response) => {
    const { sn, stagingId } = req.params;
    const session = importStaging.get(stagingId);
    if (!session || session.sn !== sn) {
      res.status(404).json({ ok: false, error: 'unknown staging session' });
      return;
    }
    if (session.state !== 'UPLOADED') {
      res.status(409).json({ ok: false, error: `wrong state ${session.state}` });
      return;
    }

    const dir = path.join(process.env.STORAGE_PATH ?? './storage', 'imports', sn, stagingId);
    let parsed: ParsedBundle;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8')) as ParsedBundle;
    } catch (err) {
      res.status(500).json({ ok: false, error: `failed to read bundle: ${(err as Error).message}` });
      return;
    }

    try {
      const restored = importParsedBundleServerCopy(sn, parsed);
      const latestZipBytes = await writeLatestZipFromCsvFiles(sn, parsed.mowerFiles?.csvFiles);

      // First-restore ground-truth capture: a server-copy restore leaves the
      // mower untouched, so the maps on it are still the user's working set.
      // If there is no portable backup yet, snapshot the mower's ACTUAL current
      // files (read_map_files via MQTT) + DB polygons into a real .novabotmap
      // bundle — a recoverable ground-truth backup of the on-device map. Fire
      // and forget so it never blocks the restore response.
      // Only when the mower is ONLINE — createBackup reads its files live over
      // MQTT, so an offline attempt is pointless (and the in-flight read must
      // not outlive a request in tests, where the device is never online).
      try {
        const { listBackups, createBackup } = await import('../services/portableBackup.js');
        if (isDeviceOnline(sn) && listBackups(sn).length === 0) {
          void createBackup(sn, 'first-restore-ground-truth')
            .then((b) => { if (b) console.log(`[Admin] ${sn}: first-restore ground-truth bundle captured from mower: ${b.filename}`); })
            .catch((e) => console.warn(`[Admin] ${sn}: first-restore ground-truth capture failed:`, e));
        }
      } catch (e) {
        console.warn(`[Admin] ${sn}: ground-truth capture setup failed:`, e);
      }

      importStaging.transition(stagingId, 'APPLIED', {
        applyResult: { warning: 'server-copy-only; mower files were not written' },
      });
      importAuditRepo.append({
        sn,
        staging_id: stagingId,
        from_state: 'UPLOADED',
        to_state: 'APPLIED',
        reason: 'server-copy-only',
      });
      res.json({
        ok: true,
        state: 'APPLIED',
        mode: 'server-copy',
        restored,
        latestZipBytes,
        ...getMowerFileCapability(sn),
        message: 'Imported into the server/app copy only. Mower files were not written; mowing works only if these maps already exist on the mower.',
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: `server-copy import failed: ${(err as Error).message}` });
    }
  },
);

// POST /api/admin-status/maps/:sn/import-portable/:stagingId/apply-verbatim
//
// Same-mower full state restore. Pushes csv_files + charging_station.yaml +
// pos.json + map.yaml/pgm/png + per-slot mapN.yaml/pgm/png BACK to the
// mower UNCHANGED (no Δ rotation, no translation, no charging_pose
// override). The mower's pos.json anchors the local frame to UTM, so as
// long as we restore the SAME pos.json that was in effect when the bundle
// was captured, polygons sit at the same world coordinates and Nav2's
// costmap matches.
//
// Soft-blocks when bundle.metadata.sourceSn !== :sn unless ?force=1. pos.json is
// no longer pushed (the map is charger-relative and the dock-cycle re-anchors
// the frame), so cross-mower restore is generally safe — the gate is just a
// confirm so an accidental wrong-mower restore isn't silent.
adminStatusRouter.post(
  '/maps/:sn/import-portable/:stagingId/apply-verbatim',
  async (req: AuthRequest, res: Response) => {
    const { sn, stagingId } = req.params;
    const force = req.query.force === '1' || req.body?.force === true;
    const session = importStaging.get(stagingId);
    if (!session || session.sn !== sn) {
      res.status(404).json({ ok: false, error: 'unknown staging session' });
      return;
    }
    if (session.state !== 'UPLOADED') {
      res.status(409).json({ ok: false, error: `wrong state ${session.state}` });
      return;
    }

    const dir = path.join(process.env.STORAGE_PATH ?? './storage', 'imports', sn, stagingId);
    let parsed: {
      metadata?: {
        sourceSn?: string;
        originalChargingPose?: { x: number; y: number; orientation: number };
      };
      polygons?: Array<{ name: string; alias: string; points: { x: number; y: number }[] }>;
      polygon?: { name: string; alias: string; points: { x: number; y: number }[] };
      obstacles?: Array<{ name: string; alias: string; points: { x: number; y: number }[] }>;
      unicom?: Array<{ name: string; targetMapName: string; points: { x: number; y: number }[] }>;
      mowerFiles?: {
        csvFiles: Record<string, string>;
        chargingStationYaml: string | null;
        posJson?: string | null;
        mapFilesText?: Record<string, string>;
        mapFilesB64?: Record<string, string>;
      };
    };
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8'));
    } catch (err) {
      res.status(500).json({ ok: false, error: `failed to read bundle: ${(err as Error).message}` });
      return;
    }
    const mowerFiles = parsed.mowerFiles;
    if (!mowerFiles || !mowerFiles.csvFiles || Object.keys(mowerFiles.csvFiles).length === 0) {
      res.status(400).json({
        ok: false,
        error: 'bundle has no mowerFiles — was exported before the verbatim feature shipped',
      });
      return;
    }
    if (!getMowerFileCapability(sn).mowerFileApplySupported) {
      res.status(409).json(mowerFileUnsupportedPayload(sn));
      return;
    }

    // SN match check (verbatim is only safe on same mower because pos.json
    // is mower-specific — its UTM anchor is set by the mower's own GPS at
    // first provisioning).
    const sourceSn = parsed.metadata?.sourceSn;
    if (sourceSn && sourceSn !== sn && !force) {
      res.status(409).json({
        ok: false,
        error: `bundle was exported from ${sourceSn}, not ${sn}. The map is charger-relative and pos.json is left untouched, so this is generally safe (the dock-cycle re-anchors the frame). Pass force=1 to confirm.`,
        sourceSn,
        targetSn: sn,
      });
      return;
    }

    // Build write_map_files payload — verbatim, no transformation.
    // restart_mapping: false — killing novabot_mapping + coverage_planner
    // mid-flight leaks iceoryx shm chunks (pool sized 50). After a few
    // restart cycles the pool fills up, new nodes can't acquire chunks
    // and crash on init, triggering robot_decision Error 140. Verified
    // live LFIN2230700238 2026-05-21: apply-verbatim with restart_mapping
    // = true caused the cascade. Same restart_mapping:false mitigation used
    // (see comment at write_map_files call further up). Refresh of cached
    // polygons happens via the save_map type:1 trigger below — firmware
    // re-reads CSVs through its own native save flow without bouncing
    // novabot_mapping.
    //
    // pos.json EXCLUDED — stock robot_decision rewrites /userdata/pos.json
    // on every successful docking (open drop-in: mower/robot_decision.py
    // line 2309 `self.save_utm_origin()` after result.code==100 SUCCESS).
    // Restoring an old pos.json from a bundle clobbers the mower's current
    // UTM anchor, putting the local frame out of sync with the physical
    // world. Verified live LFIN2230700238 2026-05-21: apply-verbatim with
    // bundle pos.json restored caused localization to report (-1.67, 0.88)
    // while mower was physically on dock at (~0, 0.06). Let the mower's
    // own docking flow refresh pos.json instead.
    // Push verbatim — shared with the cloud-import map push so both routes
    // write to the mower identically (write_map_files + raster fallback,
    // pos.json untouched). restart_mapping:false avoids the iceoryx-shm leak.
    // The bundle ships a complete occupancy grid (whole map.pgm + every
    // mapN.pgm, generated server-side); write_map_files lands those on disk and
    // coverage_planner loads map_yaml fresh per task, so the restored raster is
    // used directly. The firmware's own save_map type:1 + regenerate_per_map_files
    // were only ever needed to GENERATE the raster on-device when the bundle
    // lacked one — applyVerbatimToMower only falls back to them in that case.
    const applyRes = applyVerbatimToMower(sn, mowerFiles);
    if (!applyRes.pushed) {
      // SAFETY GATE tripped: the raster set is structurally broken. Nothing was
      // pushed — the mower's existing (working) map is untouched. Do NOT mark
      // APPLIED or rewrite the DB; surface the failure so the operator can
      // rebuild a clean bundle instead of silently shipping garbage.
      importAuditRepo.append({
        sn,
        staging_id: stagingId,
        from_state: 'UPLOADED',
        to_state: 'UPLOADED',
        reason: `verbatim-restore BLOCKED by map validation: ${applyRes.validation.hardFailures.join('; ')}`,
      });
      console.error(`[Admin] apply-verbatim ${sn} BLOCKED by map validation — mower untouched:`, applyRes.validation.hardFailures);
      res.status(422).json({
        ok: false,
        state: 'BLOCKED',
        error: 'map_validation_failed',
        message: 'Geweigerd: de te herstellen kaart is structureel kapot (losgekoppelde zones of inconsistente afmetingen). De maaier is NIET aangeraakt.',
        failures: applyRes.validation.hardFailures,
        warnings: applyRes.validation.warnings,
      });
      return;
    }

    // Update server DB so dashboard map view reflects what's now on disk.
    // Polygon points come from the bundle untransformed (same frame as
    // CSVs we just shipped back).
    db.prepare(`DELETE FROM maps WHERE mower_sn = ?`).run(sn);
    const ins = db.prepare(
      `INSERT INTO maps (mower_sn, map_id, map_name, map_type, file_name, map_area, canonical_name) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const workPolys = parsed.polygons && parsed.polygons.length > 0
      ? parsed.polygons
      : (parsed.polygon ? [parsed.polygon] : []);
    for (let i = 0; i < workPolys.length; i++) {
      const wp = workPolys[i];
      ins.run(sn, `imp_work_${i}`, wp.alias, 'work', wp.name + '.csv',
        JSON.stringify(wp.points), wp.name);
    }
    for (let i = 0; i < (parsed.obstacles ?? []).length; i++) {
      const o = parsed.obstacles![i];
      ins.run(sn, `imp_obs_${i}`, o.alias, 'obstacle', o.name + '.csv',
        JSON.stringify(o.points), o.name);
    }
    for (let i = 0; i < (parsed.unicom ?? []).length; i++) {
      const u = parsed.unicom![i];
      ins.run(sn, `imp_uni_${i}`, u.targetMapName, 'unicom', u.name + '.csv',
        JSON.stringify(u.points), u.name);
    }

    // Keep DB's polygon_charging_orientation in sync with the bundle's
    // stored value (the mower's old dock heading in its own frame).
    const origOrient = parsed.metadata?.originalChargingPose?.orientation;
    if (typeof origOrient === 'number' && Number.isFinite(origOrient)) {
      mapRepo.setPolygonChargingOrientation(sn, origOrient);
    }
    mapRepo.setPolygonOffset(sn, 0, 0);

    importStaging.transition(stagingId, 'APPLIED', { applyResult: {} });
    // The map files are now applied but the frame is not yet anchored to the
    // real charger. Lock go_to_charge and trigger the app re-anchor wizard
    // until a successful ArUco dock re-anchors pos.json.
    markFrameUnvalidated(sn);
    console.log(`[Admin] frame_unvalidated set for ${sn} after apply-verbatim`);
    importAuditRepo.append({
      sn,
      staging_id: stagingId,
      from_state: 'UPLOADED',
      to_state: 'APPLIED',
      reason: force ? 'verbatim-restore (forced cross-SN)' : 'verbatim-restore same-SN',
    });
    res.json({
      ok: true,
      state: 'APPLIED',
      mode: 'verbatim',
      sourceSn,
      forced: !!force,
      written: {
        csvFiles: Object.keys(mowerFiles.csvFiles).length,
        posJson: false,
        mapFilesText: Object.keys(mowerFiles.mapFilesText ?? {}).length,
        mapFilesB64: Object.keys(mowerFiles.mapFilesB64 ?? {}).length,
        chargingStationYaml: !!mowerFiles.chargingStationYaml,
      },
      requires_dock_anchor_refresh: true,
    });
  },
);

// POST /api/admin-status/maps/:sn/refresh-dock-anchor
//
// After a restore (apply-verbatim) the mower's pos.json
// UTM anchor on disk no longer matches reality: the bundle's polygons are
// in their export-time local frame, but the mower's running localization
// has its own current frame. The only way to make these coincide is to
// force a fresh docking cycle — stock robot_decision calls
// save_utm_origin_info on each successful dock (verified in open
// drop-in: mower/robot_decision.py line 2309), rewriting pos.json with
// the current UTM-to-local anchor. The next boot then reads the fresh
// anchor and polygons land where they belong.
//
// Two modes:
//   - manual: caller drives the mower off-and-on themselves (lift + place,
//     or joystick). Server just returns an instruction text.
//   - auto: server drives the mower off dock via the manual-control MQTT
//     protocol (start_move:4 → mst back velocity → stop_move) then
//     triggers go_to_charge so the docking sequence runs end-to-end with
//     ArUco alignment. save_utm_origin fires automatically on SUCCESS.
//
// Response is immediate; the auto sequence runs async. Caller polls
// battery_state via /devices to see when 'Charging' returns.
adminStatusRouter.post(
  '/maps/:sn/refresh-dock-anchor',
  (req: AuthRequest, res: Response) => {
    const sn = req.params.sn;
    const mode = (req.body?.mode ?? '') as string;

    if (mode === 'manual') {
      console.log(`[Admin] refresh-dock-anchor ${sn}: manual mode acknowledged`);
      res.json({
        ok: true,
        mode: 'manual',
        instruction:
          "Pick the mower up briefly and place it back on the dock, OR use the joystick to drive ~1m off and back. The mower's own docking flow refreshes the UTM anchor on successful contact. Wait until battery_state = Charging before mowing.",
      });
      return;
    }

    if (mode !== 'auto') {
      res.status(400).json({ ok: false, error: "mode required: 'auto' or 'manual'" });
      return;
    }

    const sensors = deviceCache.get(sn);
    const battery = (sensors?.get('battery_state') ?? '').toUpperCase();
    const rs = String(sensors?.get('recharge_status') ?? '');
    const onDock = battery === 'CHARGING' || battery === 'FULL' || rs === '9' || rs === '1';
    if (!onDock) {
      res.status(409).json({
        ok: false,
        error: `auto mode requires mower currently on dock (charging). battery_state='${battery}', recharge_status='${rs}'`,
      });
      return;
    }

    // Respond immediately; the sequence runs over ~40s.
    res.json({
      ok: true,
      mode: 'auto',
      message: 'auto-redock sequence started: back 1m → stop → go_to_charge. Poll /devices for battery_state → Charging.',
      estimated_duration_s: 45,
    });

    // Fire-and-forget async sequence.
    (async () => {
      try {
        console.log(`[Admin] refresh-dock-anchor ${sn}: auto sequence start`);

        // 1. Enter manual mode, back direction.
        publishToDevice(sn, { start_move: 4 });
        await new Promise((r) => setTimeout(r, 300));

        // 2. Drive straight back ~1m using the EXACT manual-joystick format
        //    (socketHandler joystick:move): mst = List [x_w*100, y_v*100, 8],
        //    x_w=0 (no turn), y_v negative (backward), start_move keepalive
        //    every ~750ms, stop_move: null. The old { x_w:0.2, y_v:0 } object
        //    form commanded a turn -> mower veered diagonally.
        {
          const started = Date.now();
          let tick = 0;
          while (Date.now() - started < 5000) {
            publishToDevice(sn, { mst: [0, -20, 8] });
            tick++;
            if (tick % 5 === 0) publishToDevice(sn, { start_move: 4 });
            await new Promise((r) => setTimeout(r, 150));
          }
        }

        // 3. Exit manual mode.
        publishToDevice(sn, { stop_move: null });
        await new Promise((r) => setTimeout(r, 1500));

        // 4. Auto-redock — full ArUco-aligned approach. robot_decision
        //    fires save_utm_origin_info on SUCCESS (result.code == 100),
        //    rewriting /userdata/pos.json with the current UTM anchor.
        publishToDevice(sn, { go_to_charge: {} }, { bypassFrameGuard: true });
        console.log(`[Admin] refresh-dock-anchor ${sn}: go_to_charge dispatched (frame-guard bypassed)`);
      } catch (err) {
        console.error(`[Admin] refresh-dock-anchor ${sn}: sequence failed`, err);
      }
    })();
  },
);

// POST /api/admin-status/maps/:sn/import-portable/:stagingId/cancel
// Idempotent: returns 200 even if session is already gone.
adminStatusRouter.post(
  '/maps/:sn/import-portable/:stagingId/cancel',
  (req: AuthRequest, res: Response) => {
    const { sn, stagingId } = req.params;
    const session = importStaging.get(stagingId);
    if (!session || session.sn !== sn) {
      res.json({ ok: true });
      return;
    }
    importAuditRepo.append({ sn, staging_id: stagingId, from_state: session.state, to_state: 'CANCELLED', reason: 'user cancel' });
    importStaging.cancel(stagingId, 'user cancel');
    res.json({ ok: true });
  },
);

// ── Polygon-offset calibration endpoints ────────────────────────────────────
// These allow operators to nudge the mower's work polygon overlay without
// touching the underlying GPS calibration.  The offset is persisted in
// map_calibration and baked into the regenerated _latest.zip on every call.

// GET /api/admin-status/maps/:sn/polygon-offset
adminStatusRouter.get('/maps/:sn/polygon-offset', (req: AuthRequest, res: Response) => {
  const off = mapRepo.getPolygonOffset(req.params.sn);
  res.json({ dx_m: off.x, dy_m: off.y });
});

/**
 * GET /api/admin-status/position-trail/:sn
 *
 * Returns paired GPS + map_position samples (RTK FIX only) for the
 * polygon-offset validation overlay on the admin map.
 *
 * Query params:
 *   duration  — window in seconds (default 600 = last 10 min)
 *
 * Response:
 *   - mowerLocal:  array of {x, y, ts} from sensors.map_position_x/y
 *   - gpsLocal:    array of {x, y, ts} — GPS samples projected into the
 *                  same local frame using the map_calibration anchor +
 *                  the saved charging-pose orientation. Empty when no
 *                  charger anchor exists.
 *   - paired:      time-aligned pairs used for the offset suggestion
 *   - suggestion:  median (mowerLocal − gpsLocal) and sample stats
 */
adminStatusRouter.get('/position-trail/:sn', (req: AuthRequest, res: Response) => {
  const sn = req.params.sn;
  const durationSec = Math.max(
    10,
    Math.min(3600, parseInt(String(req.query.duration ?? ''), 10) || 600),
  );
  const samples = getValidationTrail(sn, durationSec * 1000);

  // Anchor + map-frame charger pose. The unicom CSV's first point is the
  // charger position in MAP FRAME (e.g. (-1.21, 0.48) for Achtertuin),
  // distinct from charger_lat/lng which is the charger's GPS location.
  // Both are needed to relate the two reference frames.
  const cal = mapRepo.getCalibration(sn);
  const chargerLat = cal?.charger_lat ?? null;
  const chargerLng = cal?.charger_lng ?? null;
  const polygonAnchor = getPolygonAnchor(sn);
  const chargerInMapX = polygonAnchor?.x ?? 0;
  const chargerInMapY = polygonAnchor?.y ?? 0;

  const mowerLocal = samples.map((p) => ({ x: p.mx, y: p.my, ts: p.ts }));

  // Step 1: project every GPS sample to UNROTATED metres relative to the
  // charger anchor (east, north). At this point the lime trail still lives
  // in GPS frame — it has the right shape but is rotated relative to the
  // map frame.
  const haveAnchor =
    chargerLat != null && chargerLng != null
    && Number.isFinite(chargerLat) && Number.isFinite(chargerLng);

  type UnrotPoint = { ex: number; ny: number; ts: number };
  const gpsUnrot: UnrotPoint[] = haveAnchor
    ? samples.map((p) => {
      const local = gpsToLocal(
        { lat: p.lat, lng: p.lng },
        { lat: chargerLat as number, lng: chargerLng as number },
        0, // unrotated — rotation is derived below
      );
      return { ex: local.x, ny: local.y, ts: p.ts };
    })
    : [];

  // Step 2: derive the GPS→map rotation from the data instead of trusting
  // the saved charging-pose theta (which is the dock heading, not the
  // mapping-start heading). The two frames differ only by a rotation
  // around the charger anchor PLUS the charger's position in map frame
  // (chargerInMap*). We solve:
  //
  //   R · (gps_unrot − mean_gps) ≈ (map − chargerInMap) − mean_mapAtCharger
  //
  // via the closed-form Kabsch / Wahba 2-D solution: given paired
  // centred vectors (u_i, v_i), the optimal rotation θ satisfies
  //   tan(θ) = Σ(u.x·v.y − u.y·v.x) / Σ(u.x·v.x + u.y·v.y)
  // (sum-of-cross-products vs sum-of-dot-products).
  let derivedTheta: number | null = null;
  let derivedThetaDeg: number | null = null;
  if (haveAnchor && gpsUnrot.length >= 10) {
    // Centre both clouds at their respective means so the rotation isn't
    // contaminated by translation error.
    const mapInChargerFrame = mowerLocal.map((p) => ({
      x: p.x - chargerInMapX,
      y: p.y - chargerInMapY,
    }));
    const meanGps = gpsUnrot.reduce(
      (a, b) => ({ ex: a.ex + b.ex, ny: a.ny + b.ny }),
      { ex: 0, ny: 0 },
    );
    meanGps.ex /= gpsUnrot.length;
    meanGps.ny /= gpsUnrot.length;
    const meanMap = mapInChargerFrame.reduce(
      (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
      { x: 0, y: 0 },
    );
    meanMap.x /= mapInChargerFrame.length;
    meanMap.y /= mapInChargerFrame.length;

    let sumCross = 0;
    let sumDot = 0;
    for (let i = 0; i < gpsUnrot.length; i++) {
      const u = { x: gpsUnrot[i].ex - meanGps.ex, y: gpsUnrot[i].ny - meanGps.ny };
      const v = { x: mapInChargerFrame[i].x - meanMap.x, y: mapInChargerFrame[i].y - meanMap.y };
      sumCross += u.x * v.y - u.y * v.x;
      sumDot   += u.x * v.x + u.y * v.y;
    }
    if (Math.abs(sumDot) + Math.abs(sumCross) > 1e-9) {
      derivedTheta = Math.atan2(sumCross, sumDot);
      derivedThetaDeg = derivedTheta * 180 / Math.PI;
    }
  }

  // Step 3: project gpsUnrot into MAP FRAME using either the data-derived
  // rotation or — when we don't have enough samples yet — falling back to
  // identity (0). DO NOT fall back to polygon_charging_orientation: that
  // field is the dock-heading-in-map-frame, NOT the ENU→map rotation.
  // Using it as a rotation reproduces the live-2026-05-08 symptom where
  // a 1 m N–S drive rendered as an E–W lime trail (≈π/2 over-rotated).
  // See research/documents/polygon-rotation-bug.md for the dual-meaning
  // history of this field.
  const savedTheta = mapRepo.getPolygonChargingOrientation(sn);
  const projectionTheta = derivedTheta ?? 0;
  const cos = Math.cos(projectionTheta);
  const sin = Math.sin(projectionTheta);
  const gpsLocal = gpsUnrot.map((p) => ({
    // R(θ) · (ex, ny) + (chargerInMapX, chargerInMapY)
    x: p.ex * cos - p.ny * sin + chargerInMapX,
    y: p.ex * sin + p.ny * cos + chargerInMapY,
    ts: p.ts,
  }));

  // Step 4: residuals after rotation+translation = real polygon drift
  // suggestion. With a correct rotation the median should drop close to
  // zero; the std-dev becomes a true RTK noise estimate (cm-scale).
  const paired = samples.map((p, i) => ({
    ts: p.ts,
    map: { x: mowerLocal[i].x, y: mowerLocal[i].y },
    gps: gpsLocal[i] ?? null,
  })).filter((row) => row.gps != null) as {
    ts: number;
    map: { x: number; y: number };
    gps: { x: number; y: number; ts: number };
  }[];

  let suggestion: {
    dx: number;
    dy: number;
    samples: number;
    stdevX: number;
    stdevY: number;
  } | null = null;

  if (paired.length >= 5) {
    const dxs = paired.map((p) => p.map.x - p.gps.x).sort((a, b) => a - b);
    const dys = paired.map((p) => p.map.y - p.gps.y).sort((a, b) => a - b);
    const median = (arr: number[]) => arr[Math.floor(arr.length / 2)];
    const dx = median(dxs);
    const dy = median(dys);
    const meanX = dxs.reduce((s, v) => s + v, 0) / dxs.length;
    const meanY = dys.reduce((s, v) => s + v, 0) / dys.length;
    const stdevX = Math.sqrt(dxs.reduce((s, v) => s + (v - meanX) ** 2, 0) / dxs.length);
    const stdevY = Math.sqrt(dys.reduce((s, v) => s + (v - meanY) ** 2, 0) / dys.length);
    suggestion = { dx, dy, samples: paired.length, stdevX, stdevY };
  }

  res.json({
    sn,
    durationSec,
    haveAnchor,
    mowerLocal,
    gpsLocal,
    suggestion,
    debug: {
      chargerLat,
      chargerLng,
      chargerInMap: { x: chargerInMapX, y: chargerInMapY },
      savedTheta,
      savedThetaDeg: savedTheta != null ? (savedTheta * 180 / Math.PI) : null,
      derivedTheta,
      derivedThetaDeg,
      projectionThetaDeg: projectionTheta * 180 / Math.PI,
      thetaSource: derivedTheta != null ? 'data-fit' : (savedTheta != null ? 'saved' : 'identity'),
      totalSamples: samples.length,
      firstSampleTs: samples.length ? samples[0].ts : null,
      lastSampleTs: samples.length ? samples[samples.length - 1].ts : null,
      latestSample: samples.length ? samples[samples.length - 1] : null,
    },
  });
});

/** Wipe the in-memory validation trail for a SN (admin "Clear" button). */
adminStatusRouter.post('/position-trail/:sn/clear', (req: AuthRequest, res: Response) => {
  clearValidationTrail(req.params.sn);
  res.json({ ok: true });
});

/**
 * GET /api/admin-status/live-position/:sn
 *
 * Lightweight endpoint for the admin map's live mower-dot tick. Returns
 * the latest reported map_position from the sensor cache plus the most
 * recent localTrail tail, so a polling client can plot the dot + recent
 * track without pulling the full validation set.
 */
adminStatusRouter.get('/live-position/:sn', (req: AuthRequest, res: Response) => {
  const sn = req.params.sn;
  const sensors = deviceCache.get(sn);
  const mx = parseFloat(sensors?.get('map_position_x') ?? '');
  const my = parseFloat(sensors?.get('map_position_y') ?? '');
  const mo = parseFloat(sensors?.get('map_position_orientation') ?? '');
  const recentTrail = getLocalTrail(sn).slice(-200);
  res.json({
    sn,
    pose: (Number.isFinite(mx) && Number.isFinite(my))
      ? { x: mx, y: my, orientation: Number.isFinite(mo) ? mo : 0 }
      : null,
    workStatus: sensors?.get('work_status') ?? null,
    locQuality: sensors?.get('loc_quality') ?? null,
    recentTrail,
  });
});

function wifiHeatmapWeight(rssi: number): number {
  const normalized = rssi > 0 ? -rssi : rssi;
  const weight = 1 - ((Math.abs(normalized) - 45) / 50);
  return Math.max(0.05, Math.min(1, Math.round(weight * 100) / 100));
}

/**
 * GET /api/admin-status/wifi-heatmap/:sn
 *
 * Positioned RSSI samples for the experimental admin deck.gl map. The data
 * lives in mower local coordinates so the browser can render it on top of the
 * existing polygon model without needing an internet basemap.
 */
adminStatusRouter.get('/wifi-heatmap/:sn', (req: AuthRequest, res: Response) => {
  const sn = req.params.sn;
  const rawHours = parseInt(String(req.query.hours ?? ''), 10);
  const hours = Math.max(1, Math.min(168, Number.isFinite(rawHours) ? rawHours : 24));
  const rows = signalHistoryRepo.findWifiHeatmapBySnWithinHours(sn, hours);

  res.json({
    sn,
    hours,
    points: rows.map((r) => ({
      ts: r.ts,
      wifiRssi: r.wifi_rssi > 0 ? -r.wifi_rssi : r.wifi_rssi,
      weight: wifiHeatmapWeight(r.wifi_rssi),
      battery: r.battery,
      locQuality: r.loc_quality,
      mapX: r.map_x,
      mapY: r.map_y,
      latitude: r.latitude,
      longitude: r.longitude,
    })),
  });
});

// POST /api/admin-status/maps/:sn/apply-polygon-offset is verhuisd naar
// dashboardRouter (POST /api/dashboard/maps/:sn/apply-offset, zie dashboard.ts) —
// het dashboard roept geen admin-routes aan.

// POST /api/admin-status/maps/:sn/reset-polygon-offset
adminStatusRouter.post('/maps/:sn/reset-polygon-offset', async (req: AuthRequest, res: Response) => {
  const { sn } = req.params;

  mapRepo.setPolygonOffset(sn, 0, 0);
  const regenPath = regenerateLatestZipFromBackup(sn);
  if (!regenPath) {
    res.status(400).json({ ok: false, error: 'No map data found for this mower — map the area first.', dx_m: 0, dy_m: 0 });
    return;
  }
  if (!isDeviceOnline(sn)) {
    res.status(404).json({
      ok: false, partial: true,
      error: 'Mower offline — sync_map not pushed; mower will pick up offset on next reconnect',
      dx_m: 0, dy_m: 0,
    });
    return;
  }

  const syncResult = await new Promise<{ ok: boolean; respond?: Record<string, unknown>; timeout?: boolean }>((resolve) => {
    let settled = false;
    const handler = (data: Record<string, unknown>) => {
      const respond = data.sync_map_respond as Record<string, unknown> | undefined;
      if (!respond) return;
      if (settled) return;
      settled = true;
      offExtendedResponse(sn, handler);
      resolve({ ok: respond.result === 0, respond });
    };
    onExtendedResponse(sn, handler);
    publishToExtended(sn, { sync_map: {} });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      offExtendedResponse(sn, handler);
      resolve({ ok: false, timeout: true });
    }, 30000);
  });

  if (syncResult.timeout) {
    res.status(504).json({
      ok: false, partial: true,
      error: 'Mower did not respond within 30s — sync may still complete in background',
      dx_m: 0, dy_m: 0,
    });
    return;
  }

  console.log(`[Admin] reset-polygon-offset ${sn}: syncOk=${syncResult.ok}`);
  res.json({ ok: syncResult.ok, dx_m: 0, dy_m: 0, syncResult: syncResult.respond ?? null });
});

// POST /api/admin-status/factory-reset — wipe all user data and return to setup
adminStatusRouter.post('/factory-reset', (_req: AuthRequest, res: Response) => {
  console.log('[Admin] FACTORY RESET initiated by', _req.userId);
  db.pragma('foreign_keys = OFF');
  const tables = ['users', 'equipment', 'maps', 'map_calibration', 'map_uploads', 'map_overlays',
    'device_settings', 'work_records', 'robot_messages', 'dashboard_schedules',
    'cut_grass_plans', 'email_codes', 'equipment_lora_cache', 'signal_history',
    'virtual_walls', 'rain_sessions', 'pin_unlock_state'];
  for (const table of tables) {
    try { db.exec(`DELETE FROM "${table}"`); } catch { /* table may not exist */ }
  }
  db.pragma('foreign_keys = ON');
  invalidateSetupCache();
  console.log('[Admin] Factory reset complete — all user data deleted');
  res.json({ ok: true });
});
