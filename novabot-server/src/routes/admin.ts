/**
 * Admin endpoints — alleen voor lokaal gebruik tijdens reverse engineering.
 * Geen auth vereist (draait achter eigen netwerk).
 */
import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import { DeviceRegistryRow } from '../types/index.js';

export const adminRouter = Router();

// GET /api/admin/devices  — toon alle bekende apparaten
adminRouter.get('/devices', (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT * FROM device_registry ORDER BY last_seen DESC').all() as DeviceRegistryRow[];
  res.json(rows);
});

// POST /api/admin/devices/:sn/mac  — registreer MAC handmatig na airport-scan
// Body: { macAddress: "AA:BB:CC:DD:EE:FF" }
adminRouter.post('/devices/:sn/mac', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { macAddress } = req.body as { macAddress?: string };

  if (!macAddress || !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(macAddress)) {
    res.status(400).json({ error: 'macAddress vereist in formaat AA:BB:CC:DD:EE:FF' });
    return;
  }

  const mac = macAddress.toUpperCase();

  // Upsert in device_registry op basis van SN (gebruik SN als pseudo-clientId als er nog geen rij is)
  const existing = db.prepare('SELECT * FROM device_registry WHERE sn = ?').get(sn) as DeviceRegistryRow | undefined;
  if (existing) {
    db.prepare('UPDATE device_registry SET mac_address = ?, last_seen = datetime(\'now\') WHERE sn = ?')
      .run(mac, sn);
  } else {
    db.prepare(`
      INSERT INTO device_registry (mqtt_client_id, sn, mac_address, mqtt_username, last_seen)
      VALUES (?, ?, ?, NULL, datetime('now'))
    `).run(`manual:${sn}`, sn, mac);
  }

  // Koppel ook terug aan equipment
  db.prepare('UPDATE equipment SET mac_address = ? WHERE (mower_sn = ? OR charger_sn = ?)')
    .run(mac, sn, sn);

  console.log(`[ADMIN] MAC geregistreerd: sn=${sn} mac=${mac}`);
  res.json({ sn, macAddress: mac, status: 'ok' });
});
