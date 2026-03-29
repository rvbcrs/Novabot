/**
 * Admin endpoints — alleen voor lokaal gebruik tijdens reverse engineering.
 * Geen auth vereist (draait achter eigen netwerk).
 */
import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import { DeviceRegistryRow } from '../types/index.js';
import { scanForDevices, isBleAvailable } from '../ble/scanner.js';
import { provisionDevice, provisionBatch, type ProvisionParams } from '../ble/provisioner.js';
import { getAllRecentBleDevices, isBackgroundScanActive } from '../ble/bleLogger.js';

export const adminRouter = Router();

// GET /api/admin/ble-nearby  — returns ALL BLE devices seen in the last 60s by background scanner
adminRouter.get('/ble-nearby', (_req: Request, res: Response) => {
  res.json({ scanning: isBackgroundScanActive(), devices: getAllRecentBleDevices() });
});

// GET /api/admin/ble-scan  — scan for nearby Novabot BLE devices
// Returns devices with BLE MAC extracted from manufacturer data (0x5566)
adminRouter.get('/ble-scan', async (req: Request, res: Response) => {
  if (!isBleAvailable()) {
    res.status(503).json({ error: 'Bluetooth not available on this server' });
    return;
  }

  const duration = Math.min(Math.max(Number(req.query.duration) || 5, 1), 15) * 1000;

  try {
    const devices = await scanForDevices(duration);
    res.json({ devices });
  } catch (err) {
    const msg = (err as Error).message;
    console.error('[BLE] Scan error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── Async BLE provisioning (CYW43455 WiFi+BLE coexistence causes brief WiFi drops) ──
// POST starts the job and returns immediately; GET /ble-provision/status polls result.
let bleProvJob: { id: string; status: 'running' | 'done' | 'error'; result?: unknown; startedAt: number } | null = null;

adminRouter.post('/ble-provision', async (req: Request, res: Response) => {
  if (!isBleAvailable()) {
    res.status(503).json({ error: 'Bluetooth not available on this server' });
    return;
  }

  if (bleProvJob?.status === 'running') {
    res.status(409).json({ error: 'Provisioning already in progress' });
    return;
  }

  const { targetMac, wifiSsid, wifiPassword, mqttAddr, mqttPort, loraAddr, loraChannel, loraHc, loraLc, timezone, deviceType } = req.body as Partial<ProvisionParams>;

  if (!targetMac || !wifiSsid || !wifiPassword) {
    res.status(400).json({ error: 'targetMac, wifiSsid, and wifiPassword are required' });
    return;
  }

  if (!/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(targetMac)) {
    res.status(400).json({ error: 'targetMac must be in format AA:BB:CC:DD:EE:FF' });
    return;
  }

  const jobId = `prov-${Date.now()}`;
  bleProvJob = { id: jobId, status: 'running', startedAt: Date.now() };
  console.log(`[ADMIN] BLE provisioning started for ${targetMac} (${deviceType || 'mower'}) job=${jobId}`);

  // Fire and forget — wizard polls status
  provisionDevice({
    targetMac, wifiSsid, wifiPassword, mqttAddr, mqttPort,
    loraAddr, loraChannel, loraHc, loraLc, timezone, deviceType,
  }).then(result => {
    bleProvJob = { id: jobId, status: 'done', result, startedAt: bleProvJob!.startedAt };
  }).catch(err => {
    const msg = (err as Error).message || String(err);
    console.error('[ADMIN] BLE provisioning error:', msg);
    bleProvJob = { id: jobId, status: 'error', result: { success: false, error: msg }, startedAt: bleProvJob!.startedAt };
  });

  res.json({ started: true, jobId });
});

adminRouter.get('/ble-provision/status', (_req: Request, res: Response) => {
  if (!bleProvJob) {
    res.json({ status: 'idle' });
    return;
  }
  const elapsed = Math.round((Date.now() - bleProvJob.startedAt) / 1000);
  res.json({ status: bleProvJob.status, jobId: bleProvJob.id, elapsed, result: bleProvJob.result ?? null });
});

// POST /api/admin/ble-provision-batch — provision multiple devices, WiFi off/on once
adminRouter.post('/ble-provision-batch', async (req: Request, res: Response) => {
  if (!isBleAvailable()) {
    res.status(503).json({ error: 'Bluetooth not available on this server' });
    return;
  }
  if (bleProvJob?.status === 'running') {
    res.status(409).json({ error: 'Provisioning already in progress' });
    return;
  }

  const { devices } = req.body as { devices: Partial<ProvisionParams>[] };
  if (!devices || !Array.isArray(devices) || devices.length === 0) {
    res.status(400).json({ error: 'devices array required' });
    return;
  }

  const jobId = `batch-${Date.now()}`;
  bleProvJob = { id: jobId, status: 'running', startedAt: Date.now() };
  console.log(`[ADMIN] BLE batch provisioning: ${devices.length} devices, job=${jobId}`);

  provisionBatch(devices as ProvisionParams[]).then(results => {
    const allOk = results.every(r => r.success);
    bleProvJob = { id: jobId, status: 'done', result: { success: allOk, devices: results }, startedAt: bleProvJob!.startedAt };
  }).catch(err => {
    const msg = (err as Error).message || String(err);
    console.error('[ADMIN] BLE batch error:', msg);
    bleProvJob = { id: jobId, status: 'error', result: { success: false, error: msg }, startedAt: bleProvJob!.startedAt };
  });

  res.json({ started: true, jobId });
});

// POST /api/admin/ble-raw  — raw BLE diagnostic: connect, write data, capture responses
// Body: { targetMac, charUuid?, data?, writeToAll?, durationMs? }
adminRouter.post('/ble-raw', async (req: Request, res: Response) => {
  if (!isBleAvailable()) {
    res.status(503).json({ error: 'Bluetooth not available on this server' });
    return;
  }

  const { targetMac, charUuid, data, writeToAll, durationMs = 5000, framed } = req.body as {
    targetMac: string;
    charUuid?: string;
    data?: string;  // hex string or utf8 string
    writeToAll?: boolean;
    durationMs?: number;
    framed?: boolean;  // true = wrap with ble_start/ble_end markers
  };

  if (!targetMac) {
    res.status(400).json({ error: 'targetMac required' });
    return;
  }

  try {
    const { bleRawDiagnostic } = await import('../ble/provisioner.js');
    const result = await bleRawDiagnostic(targetMac, {
      charUuid,
      data,
      writeToAll: writeToAll ?? false,
      durationMs: Math.min(durationMs, 15000),
      framed: framed ?? false,
    });
    res.json(result);
  } catch (err) {
    const msg = (err as Error).message || String(err);
    console.error('[ADMIN] BLE raw error:', msg);
    res.status(500).json({ error: msg });
  }
});

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
