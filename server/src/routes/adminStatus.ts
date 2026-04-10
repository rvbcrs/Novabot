/**
 * Admin Status API — server health, users, devices, errors
 * Protected by authMiddleware + adminMiddleware
 */

import { Router, Response } from 'express';
import os from 'os';
import dns from 'dns';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { db } from '../db/database.js';
import { AuthRequest } from '../types/index.js';

export const adminStatusRouter = Router();

// Read version once at startup
import fs from 'fs';
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
  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
  const equipmentCount = (db.prepare('SELECT COUNT(*) as c FROM equipment').get() as { c: number }).c;
  const deviceCount = (db.prepare('SELECT COUNT(*) as c FROM device_registry').get() as { c: number }).c;
  const mapCount = (db.prepare('SELECT COUNT(*) as c FROM maps').get() as { c: number }).c;

  // DB file size
  let dbSize = 0;
  try {
    const dbPath = process.env.DB_PATH || 'novabot.db';
    const fs = require('fs');
    const stat = fs.statSync(dbPath);
    dbSize = stat.size;
  } catch {}

  // Current user info from JWT
  const currentUser = _req.userId
    ? db.prepare('SELECT email, is_admin, dashboard_access FROM users WHERE app_user_id = ?').get(_req.userId) as { email: string; is_admin: number; dashboard_access: number } | undefined
    : undefined;

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
  const users = db.prepare(`
    SELECT u.id, u.app_user_id, u.email, u.username, u.is_admin, u.dashboard_access, u.created_at,
           GROUP_CONCAT(DISTINCT e.mower_sn) as mower_sns,
           GROUP_CONCAT(DISTINCT e.charger_sn) as charger_sns
    FROM users u
    LEFT JOIN equipment e ON e.user_id = u.app_user_id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();

  // Also get all equipment (including unbound)
  const allEquipment = db.prepare(`
    SELECT mower_sn, charger_sn, user_id, equipment_nick_name
    FROM equipment
    ORDER BY created_at DESC
  `).all();

  // Count unbound equipment
  const unboundCount = allEquipment.filter((e: any) => !e.user_id).length;

  res.json({ users, allEquipment, unboundCount });
});

// GET /api/admin-status/devices — known Novabot devices with online status
adminStatusRouter.get('/devices', (_req: AuthRequest, res: Response) => {
  // Only show real Novabot devices (LFIN/LFIC/ESP32), not test clients
  const devices = db.prepare(`
    SELECT d.mqtt_client_id, d.sn,
           COALESCE(d.mac_address, f.mac_address) as mac_address,
           d.mqtt_username, MAX(d.last_seen) as last_seen, d.ip_address,
           e.equipment_id, e.user_id, e.equipment_nick_name,
           l.charger_address as lora_address, l.charger_channel as lora_channel,
           CASE WHEN julianday('now') - julianday(MAX(d.last_seen)) < 0.003 THEN 1 ELSE 0 END as is_online,
           CASE WHEN d.sn LIKE 'LFIC%' THEN 'charger'
                WHEN d.sn LIKE 'LFIN%' THEN 'mower'
                ELSE 'unknown' END as device_type,
           CASE WHEN e.user_id IS NOT NULL THEN 1 ELSE 0 END as is_bound
    FROM device_registry d
    LEFT JOIN equipment e ON (e.mower_sn = d.sn OR e.charger_sn = d.sn)
    LEFT JOIN device_factory f ON f.sn = d.sn
    LEFT JOIN equipment_lora_cache l ON l.sn = d.sn
    WHERE d.sn IS NOT NULL AND (d.sn LIKE 'LFIN%' OR d.sn LIKE 'LFIC%')
    GROUP BY d.sn
    ORDER BY is_online DESC, d.last_seen DESC
  `).all();

  res.json({ devices });
});

// POST /api/admin-status/bind-device — bind unbound device to current user
adminStatusRouter.post('/bind-device', (_req: AuthRequest, res: Response) => {
  const { sn } = _req.body as { sn?: string };
  if (!sn || !_req.userId) {
    res.status(400).json({ error: 'sn required' });
    return;
  }

  // Check if equipment exists
  const existing = db.prepare('SELECT equipment_id FROM equipment WHERE mower_sn = ? OR charger_sn = ?').get(sn, sn) as { equipment_id: string } | undefined;

  if (existing) {
    // Update existing — set user_id
    db.prepare('UPDATE equipment SET user_id = ? WHERE equipment_id = ?').run(_req.userId, existing.equipment_id);
  } else {
    // Create new equipment record
    const crypto = require('crypto');
    const equipmentId = crypto.randomUUID();
    const isCharger = sn.startsWith('LFIC');
    db.prepare(`
      INSERT INTO equipment (equipment_id, user_id, mower_sn, charger_sn, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(equipmentId, _req.userId, sn, isCharger ? sn : null);
  }

  console.log(`[Admin] Device ${sn} bound to user ${_req.userId}`);
  res.json({ ok: true });
});

// POST /api/admin-status/unbind-device — remove user_id from equipment (keep device)
adminStatusRouter.post('/unbind-device', (_req: AuthRequest, res: Response) => {
  const { sn } = _req.body as { sn?: string };
  if (!sn) { res.status(400).json({ error: 'sn required' }); return; }

  db.prepare('UPDATE equipment SET user_id = NULL WHERE mower_sn = ? OR charger_sn = ?').run(sn, sn);
  console.log('[Admin] Device ' + sn + ' unbound');
  res.json({ ok: true });
});

// POST /api/admin-status/pair-devices — pair mower with charger in equipment table
adminStatusRouter.post('/pair-devices', (_req: AuthRequest, res: Response) => {
  const { mowerSn, chargerSn } = _req.body as { mowerSn?: string; chargerSn?: string };
  if (!mowerSn || !chargerSn) { res.status(400).json({ error: 'mowerSn and chargerSn required' }); return; }

  try {
    const pairTx = db.transaction(() => {
      // Find existing records
      const chargerEquip = db.prepare('SELECT equipment_id, user_id FROM equipment WHERE charger_sn = ?')
        .get(chargerSn) as { equipment_id: string; user_id: string | null } | undefined;

      if (chargerEquip) {
        // DELETE standalone mower record FIRST (before UPDATE to avoid UNIQUE violation)
        db.prepare('DELETE FROM equipment WHERE mower_sn = ? AND equipment_id != ?')
          .run(mowerSn, chargerEquip.equipment_id);
        // Now safe to set mower_sn on the charger record
        db.prepare('UPDATE equipment SET mower_sn = ? WHERE equipment_id = ?')
          .run(mowerSn, chargerEquip.equipment_id);
        console.log(`[Admin] Paired mower ${mowerSn} with charger ${chargerSn} (into charger record)`);
      } else {
        const mowerEquip = db.prepare('SELECT equipment_id FROM equipment WHERE mower_sn = ?')
          .get(mowerSn) as { equipment_id: string } | undefined;
        if (mowerEquip) {
          // DELETE standalone charger record FIRST
          db.prepare('DELETE FROM equipment WHERE charger_sn = ? AND equipment_id != ?')
            .run(chargerSn, mowerEquip.equipment_id);
          db.prepare('UPDATE equipment SET charger_sn = ? WHERE equipment_id = ?')
            .run(chargerSn, mowerEquip.equipment_id);
        } else {
          // Neither has a record — create one
          const equipmentId = crypto.randomUUID();
          db.prepare(`INSERT INTO equipment (equipment_id, user_id, mower_sn, charger_sn, created_at)
            VALUES (?, ?, ?, ?, datetime('now'))`)
            .run(equipmentId, _req.userId, mowerSn, chargerSn);
        }
        console.log(`[Admin] Paired mower ${mowerSn} with charger ${chargerSn}`);
      }
    });
    pairTx();

    // Sync LoRa cache — both devices should share the same LoRa address
    // Use the charger's address as source of truth (charger reports its own LoRa)
    const chargerLora = db.prepare('SELECT charger_address, charger_channel FROM equipment_lora_cache WHERE sn = ?')
      .get(chargerSn) as { charger_address: string; charger_channel: string } | undefined;
    const mowerLora = db.prepare('SELECT charger_address, charger_channel FROM equipment_lora_cache WHERE sn = ?')
      .get(mowerSn) as { charger_address: string; charger_channel: string } | undefined;

    if (chargerLora && !mowerLora) {
      // Copy charger LoRa to mower
      db.prepare('INSERT OR REPLACE INTO equipment_lora_cache (sn, charger_address, charger_channel) VALUES (?, ?, ?)')
        .run(mowerSn, chargerLora.charger_address, chargerLora.charger_channel);
    } else if (mowerLora && !chargerLora) {
      // Copy mower LoRa to charger
      db.prepare('INSERT OR REPLACE INTO equipment_lora_cache (sn, charger_address, charger_channel) VALUES (?, ?, ?)')
        .run(chargerSn, mowerLora.charger_address, mowerLora.charger_channel);
    } else if (chargerLora && mowerLora && chargerLora.charger_address !== mowerLora.charger_address) {
      // Different addresses — use equipment table's charger_address as truth
      const equipAddr = db.prepare('SELECT charger_address, charger_channel FROM equipment WHERE mower_sn = ? OR charger_sn = ? LIMIT 1')
        .get(mowerSn, chargerSn) as { charger_address: number | null; charger_channel: number | null } | undefined;
      if (equipAddr?.charger_address) {
        db.prepare('UPDATE equipment_lora_cache SET charger_address = ?, charger_channel = ? WHERE sn = ?')
          .run(equipAddr.charger_address, equipAddr.charger_channel ?? 16, mowerSn);
        db.prepare('UPDATE equipment_lora_cache SET charger_address = ?, charger_channel = ? WHERE sn = ?')
          .run(equipAddr.charger_address, equipAddr.charger_channel ?? 16, chargerSn);
        console.log(`[Admin] Synced LoRa cache to address ${equipAddr.charger_address} for pair`);
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

  db.prepare('DELETE FROM device_registry WHERE sn = ?').run(sn);
  db.prepare('DELETE FROM equipment WHERE mower_sn = ? OR charger_sn = ?').run(sn, sn);
  db.prepare('DELETE FROM equipment_lora_cache WHERE sn = ?').run(sn);
  console.log('[Admin] Device ' + sn + ' removed');
  res.json({ ok: true });
});

// GET /api/admin-status/equipment — all equipment pairings
adminStatusRouter.get('/equipment', (_req: AuthRequest, res: Response) => {
  const raw = db.prepare(`
    SELECT e.*, u.email as user_email
    FROM equipment e
    LEFT JOIN users u ON u.app_user_id = e.user_id
    ORDER BY e.created_at DESC
  `).all() as Array<Record<string, unknown>>;

  // Fix display: if mower_sn starts with LFIC, it's actually a charger
  const equipment = raw.map((e) => {
    const mowerSn = e.mower_sn as string | null;
    const chargerSn = e.charger_sn as string | null;
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

  db.prepare(`UPDATE users SET ${role} = ? WHERE app_user_id = ?`)
    .run(enabled ? 1 : 0, userId);

  console.log(`[ADMIN] Set ${role}=${enabled ? 1 : 0} for user ${userId}`);
  res.json({ ok: true });
});

// POST /api/admin-status/delete-user — admin can delete a user
adminStatusRouter.post('/delete-user', (req: AuthRequest, res: Response) => {
  const { userId } = req.body as { userId: string };
  if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
  if (userId === req.userId) { res.status(400).json({ error: 'Cannot delete yourself' }); return; }

  db.prepare('DELETE FROM users WHERE app_user_id = ?').run(userId);
  db.prepare('UPDATE equipment SET user_id = NULL WHERE user_id = ?').run(userId);

  console.log(`[ADMIN] Deleted user ${userId}`);
  res.json({ ok: true });
});

// POST /api/admin-status/reset-password — admin can reset a user's password
adminStatusRouter.post('/reset-password', (req: AuthRequest, res: Response) => {
  const { userId, newPassword } = req.body as { userId: string; newPassword: string };
  if (!userId || !newPassword) { res.status(400).json({ error: 'userId and newPassword required' }); return; }
  if (newPassword.length < 6) { res.status(400).json({ error: 'Password must be at least 6 characters' }); return; }

  const bcrypt = require('bcrypt');
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE app_user_id = ?').run(hash, userId);

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

// GET /api/admin-status/dnsmasq — get dnsmasq status
adminStatusRouter.get('/dnsmasq', (_req: AuthRequest, res: Response) => {
  try {
    execSync('pgrep -x dnsmasq', { stdio: 'ignore' });
    res.json({ running: true });
  } catch {
    res.json({ running: false });
  }
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
      require('fs').writeFileSync('/etc/dnsmasq.conf', config);
      // Kill existing if running, then start
      try { execSync('pkill -x dnsmasq', { stdio: 'ignore' }); } catch { /* not running */ }
      execSync('dnsmasq', { stdio: 'ignore' });
      console.log(`[DNS] dnsmasq started: *.lfibot.com → ${serverIp}`);
      res.json({ ok: true, running: true, serverIp });
    } catch (err) {
      console.error(`[DNS] Failed to start dnsmasq:`, err);
      res.json({ ok: false, error: 'Failed to start dnsmasq. Is it installed?' });
    }
  } else {
    try {
      execSync('pkill -x dnsmasq', { stdio: 'ignore' });
      console.log('[DNS] dnsmasq stopped');
      res.json({ ok: true, running: false });
    } catch {
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
