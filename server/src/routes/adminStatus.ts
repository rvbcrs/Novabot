/**
 * Admin Status API — server health, users, devices, errors
 * Protected by authMiddleware + adminMiddleware
 */

import { Router, Response } from 'express';
import os from 'os';
import { db } from '../db/database.js';
import { AuthRequest } from '../types/index.js';

export const adminStatusRouter = Router();

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
           d.mqtt_username, d.last_seen, d.ip_address,
           e.equipment_id, e.user_id, e.equipment_nick_name,
           CASE WHEN julianday('now') - julianday(d.last_seen) < 0.003 THEN 1 ELSE 0 END as is_online,
           CASE WHEN d.sn LIKE 'LFIC%' THEN 'charger'
                WHEN d.sn LIKE 'LFIN%' THEN 'mower'
                ELSE 'unknown' END as device_type,
           CASE WHEN e.user_id IS NOT NULL THEN 1 ELSE 0 END as is_bound
    FROM device_registry d
    LEFT JOIN equipment e ON (e.mower_sn = d.sn OR e.charger_sn = d.sn)
    LEFT JOIN device_factory f ON f.sn = d.sn
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
