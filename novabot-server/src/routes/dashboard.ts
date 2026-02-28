/**
 * Dashboard REST endpoints — initial state load voor de React app.
 * Geen auth — alleen bedoeld voor lokaal netwerk.
 */
import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import { getAllDeviceSnapshots, getDeviceSnapshot, SENSORS, getGpsTrail, clearGpsTrail } from '../mqtt/sensorData.js';
import { isDeviceOnline, writeRawPublish } from '../mqtt/broker.js';
import { getRecentLogs } from '../dashboard/socketHandler.js';
import { requestMapList, requestMapOutline, publishToDevice, publishRawToDevice } from '../mqtt/mapSync.js';
import crypto from 'crypto';
import { generateMapZipFromDb, gpsToLocal, localToGps, parseMapZip, type GpsPoint } from '../mqtt/mapConverter.js';
import { existsSync, unlinkSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

interface DeviceRegistryRow {
  mqtt_client_id: string;
  sn: string | null;
  mac_address: string | null;
  mqtt_username: string | null;
  last_seen: string | null;
}

interface EquipmentRow {
  mower_sn: string;
  charger_sn: string | null;
  equipment_nick_name: string | null;
}

export const dashboardRouter = Router();

// GET /api/dashboard/devices — alle devices met online status en cached sensor waarden
// Toont alleen apparaten die gebonden zijn (in equipment tabel) of momenteel online zijn,
// gedepliceerd op SN (meest recente entry per SN)
dashboardRouter.get('/devices', (_req: Request, res: Response) => {
  const registry = db.prepare(`
    SELECT d.* FROM device_registry d
    INNER JOIN (
      SELECT sn, MAX(last_seen) as max_seen FROM device_registry
      WHERE sn IS NOT NULL GROUP BY sn
    ) latest ON d.sn = latest.sn AND d.last_seen = latest.max_seen
    ORDER BY d.last_seen DESC
  `).all() as DeviceRegistryRow[];

  const equipment = db.prepare('SELECT mower_sn, charger_sn, equipment_nick_name FROM equipment').all() as EquipmentRow[];

  // Verzamel alle gebonden SNs
  const boundSns = new Set<string>();
  for (const e of equipment) {
    if (e.mower_sn) boundSns.add(e.mower_sn);
    if (e.charger_sn) boundSns.add(e.charger_sn);
  }

  const snapshots = getAllDeviceSnapshots();

  // Filter: toon alleen gebonden apparaten of online apparaten
  const devices = registry
    .filter(d => boundSns.has(d.sn!) || isDeviceOnline(d.sn!))
    .map(d => ({
      sn: d.sn!,
      macAddress: d.mac_address,
      lastSeen: d.last_seen,
      online: isDeviceOnline(d.sn!),
      deviceType: d.sn!.startsWith('LFIC') ? 'charger' as const : 'mower' as const,
      nickname: equipment.find(e =>
        e.mower_sn === d.sn || e.charger_sn === d.sn
      )?.equipment_nick_name ?? null,
      sensors: snapshots[d.sn!] ?? {},
    }));

  res.json({ devices });
});

// DELETE /api/dashboard/devices/:sn — verwijder een device uit de registry
dashboardRouter.delete('/devices/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  db.prepare('DELETE FROM device_registry WHERE sn = ?').run(sn);
  res.json({ ok: true });
});

// GET /api/dashboard/devices/:sn — enkel device met volledige state
dashboardRouter.get('/devices/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const snapshot = getDeviceSnapshot(sn) ?? {};

  res.json({
    sn,
    online: isDeviceOnline(sn),
    deviceType: sn.startsWith('LFIC') ? 'charger' : 'mower',
    sensors: snapshot,
  });
});

// GET /api/dashboard/sensors — sensor metadata voor de frontend
dashboardRouter.get('/sensors', (_req: Request, res: Response) => {
  res.json({ sensors: SENSORS });
});

interface MapRow {
  map_id: string;
  mower_sn: string;
  map_name: string | null;
  map_type: string;
  map_area: string | null;
  map_max_min: string | null;
  file_name: string | null;
  file_size: number | null;
  created_at: string;
  updated_at: string;
}

// GET /api/dashboard/maps — alle kaarten (alle SNs)
dashboardRouter.get('/maps', (_req: Request, res: Response) => {
  const rows = db.prepare(
    'SELECT * FROM maps ORDER BY updated_at DESC'
  ).all() as MapRow[];

  const maps = rows.map(r => ({
    mapId: r.map_id,
    mowerSn: r.mower_sn,
    mapName: r.map_name,
    mapType: r.map_type ?? 'work',
    mapArea: r.map_area ? JSON.parse(r.map_area) : [],
    mapMaxMin: r.map_max_min ? JSON.parse(r.map_max_min) : null,
    createdAt: r.created_at,
  }));

  res.json({ maps });
});

// GET /api/dashboard/maps/:sn — kaarten voor een maaier (polygonen voor Leaflet)
dashboardRouter.get('/maps/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const rows = db.prepare(
    'SELECT * FROM maps WHERE mower_sn = ? ORDER BY updated_at DESC'
  ).all(sn) as MapRow[];

  const maps = rows.map(r => ({
    mapId: r.map_id,
    mapName: r.map_name,
    mapType: r.map_type ?? 'work',
    mapArea: r.map_area ? JSON.parse(r.map_area) : [],
    mapMaxMin: r.map_max_min ? JSON.parse(r.map_max_min) : null,
    createdAt: r.created_at,
  }));

  res.json({ maps });
});

// GET /api/dashboard/trail/:sn — GPS trail punten voor de kaart
dashboardRouter.get('/trail/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  res.json({ trail: getGpsTrail(sn) });
});

// DELETE /api/dashboard/trail/:sn — wis GPS trail
dashboardRouter.delete('/trail/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  clearGpsTrail(sn);
  res.json({ ok: true });
});

// GET /api/dashboard/logs — recente MQTT log entries
dashboardRouter.get('/logs', (_req: Request, res: Response) => {
  res.json({ logs: getRecentLogs() });
});

// POST /api/dashboard/maps/:sn/request — handmatig kaarten opvragen van maaier via MQTT
dashboardRouter.post('/maps/:sn/request', (req: Request, res: Response) => {
  const { sn } = req.params;
  if (!isDeviceOnline(sn)) {
    res.status(404).json({ error: 'Device is offline' });
    return;
  }
  requestMapList(sn);
  res.json({ ok: true, message: `get_map_list gestuurd naar ${sn}` });
});

// POST /api/dashboard/maps/:sn/request-outline — handmatig kaart outline opvragen
dashboardRouter.post('/maps/:sn/request-outline', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { mapId } = req.body as { mapId?: string };
  if (!mapId) {
    res.status(400).json({ error: 'mapId is vereist' });
    return;
  }
  if (!isDeviceOnline(sn)) {
    res.status(404).json({ error: 'Device is offline' });
    return;
  }
  requestMapOutline(sn, mapId);
  res.json({ ok: true, message: `get_map_outline gestuurd naar ${sn} voor kaart ${mapId}` });
});

// POST /api/dashboard/maps/:sn — nieuwe kaart aanmaken (getekend op dashboard)
dashboardRouter.post('/maps/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { mapName, mapArea, mapType } = req.body as {
    mapName?: string;
    mapArea?: Array<{ lat: number; lng: number }>;
    mapType?: string;
  };

  if (!mapArea || !Array.isArray(mapArea) || mapArea.length < 3) {
    res.status(400).json({ error: 'mapArea met minimaal 3 punten is vereist' });
    return;
  }

  const typeSlug = mapType && ['work', 'obstacle', 'unicom'].includes(mapType) ? mapType : 'work';
  const mapId = `dashboard_${typeSlug}_${Date.now()}`;
  const lats = mapArea.map(p => p.lat);
  const lngs = mapArea.map(p => p.lng);
  const bounds = {
    minLat: Math.min(...lats), maxLat: Math.max(...lats),
    minLng: Math.min(...lngs), maxLng: Math.max(...lngs),
  };

  db.prepare(`
    INSERT INTO maps (map_id, mower_sn, map_name, map_type, map_area, map_max_min, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(mapId, sn, mapName ?? null, typeSlug, JSON.stringify(mapArea), JSON.stringify(bounds));

  res.json({
    ok: true,
    map: {
      mapId,
      mapName: mapName ?? null,
      mapType: typeSlug,
      mapArea,
      mapMaxMin: bounds,
      createdAt: new Date().toISOString(),
    },
  });
});

// PATCH /api/dashboard/maps/:sn/:mapId — hernoem of bewerk een kaart
dashboardRouter.patch('/maps/:sn/:mapId', (req: Request, res: Response) => {
  const { sn, mapId } = req.params;
  const { mapName, mapArea } = req.body as {
    mapName?: string;
    mapArea?: Array<{ lat: number; lng: number }>;
  };

  const row = db.prepare('SELECT map_id FROM maps WHERE map_id = ? AND mower_sn = ?').get(mapId, sn);
  if (!row) {
    res.status(404).json({ error: 'Kaart niet gevonden' });
    return;
  }

  // Update polygon punten als meegegeven
  if (mapArea && Array.isArray(mapArea) && mapArea.length >= 3) {
    const lats = mapArea.map(p => p.lat);
    const lngs = mapArea.map(p => p.lng);
    const bounds = {
      minLat: Math.min(...lats), maxLat: Math.max(...lats),
      minLng: Math.min(...lngs), maxLng: Math.max(...lngs),
    };
    db.prepare('UPDATE maps SET map_area = ?, map_max_min = ?, updated_at = datetime(\'now\') WHERE map_id = ? AND mower_sn = ?')
      .run(JSON.stringify(mapArea), JSON.stringify(bounds), mapId, sn);
  }

  // Update naam als meegegeven
  if (mapName !== undefined) {
    db.prepare('UPDATE maps SET map_name = ?, updated_at = datetime(\'now\') WHERE map_id = ? AND mower_sn = ?')
      .run(mapName ?? null, mapId, sn);
  }

  res.json({ ok: true });
});

// DELETE /api/dashboard/maps/:sn/:mapId — verwijder een kaart
dashboardRouter.delete('/maps/:sn/:mapId', (req: Request, res: Response) => {
  const { sn, mapId } = req.params;

  const row = db.prepare('SELECT file_name FROM maps WHERE map_id = ? AND mower_sn = ?').get(mapId, sn) as { file_name: string | null } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Kaart niet gevonden' });
    return;
  }

  // Verwijder eventueel opgeslagen bestand
  if (row.file_name) {
    const filePath = path.resolve('storage/maps', row.file_name);
    if (existsSync(filePath)) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
  }

  db.prepare('DELETE FROM maps WHERE map_id = ? AND mower_sn = ?').run(mapId, sn);
  res.json({ ok: true });
});

// ── Map converter endpoints ──────────────────────────────────────

// POST /api/dashboard/maps/:sn/export-zip — genereer Novabot-compatibel ZIP van kaarten
dashboardRouter.post('/maps/:sn/export-zip', (req: Request, res: Response) => {
  const { sn } = req.params;
  const body = req.body as {
    chargingStation?: GpsPoint;
    chargingOrientation?: number;
  };

  // Charging station GPS positie is vereist
  if (!body.chargingStation?.lat || !body.chargingStation?.lng) {
    res.status(400).json({
      error: 'chargingStation {lat, lng} is vereist',
      hint: 'Gebruik de GPS positie van het laadstation uit de sensor data (latitude/longitude)',
    });
    return;
  }

  try {
    const zipPath = generateMapZipFromDb(
      sn,
      body.chargingStation,
      body.chargingOrientation ?? 0,
    );

    if (!zipPath) {
      res.status(404).json({ error: 'Geen kaarten gevonden voor dit apparaat' });
      return;
    }

    res.json({
      ok: true,
      zipPath,
      downloadUrl: `/api/dashboard/maps/${sn}/download-zip`,
    });
  } catch (err) {
    res.status(500).json({ error: 'ZIP generatie mislukt', details: String(err) });
  }
});

// GET /api/dashboard/maps/:sn/download-zip — download het gegenereerde ZIP bestand
dashboardRouter.get('/maps/:sn/download-zip', (req: Request, res: Response) => {
  const { sn } = req.params;
  const zipPath = path.resolve(`storage/maps/${sn}.zip`);

  if (!existsSync(zipPath)) {
    res.status(404).json({ error: 'ZIP niet gevonden — genereer eerst via POST export-zip' });
    return;
  }

  res.download(zipPath, `${sn}.zip`);
});

// POST /api/dashboard/maps/:sn/import-zip — importeer kaarten uit een Novabot ZIP
dashboardRouter.post('/maps/:sn/import-zip', (req: Request, res: Response) => {
  const { sn } = req.params;
  const body = req.body as {
    zipPath?: string;
    chargingStation?: GpsPoint;
  };

  if (!body.zipPath || !body.chargingStation?.lat || !body.chargingStation?.lng) {
    res.status(400).json({
      error: 'zipPath en chargingStation {lat, lng} zijn vereist',
    });
    return;
  }

  try {
    const result = parseMapZip(body.zipPath, body.chargingStation);
    if (!result) {
      res.status(400).json({ error: 'Kon ZIP niet parsen' });
      return;
    }

    // Sla werkgebieden op in database
    let imported = 0;
    for (const area of result.areas) {
      if (area.type !== 'work') continue;

      const mapId = `imported_map${area.mapIndex}_${Date.now()}`;
      const points = area.points;
      const lats = points.map(p => p.lat);
      const lngs = points.map(p => p.lng);
      const bounds = {
        minLat: Math.min(...lats),
        maxLat: Math.max(...lats),
        minLng: Math.min(...lngs),
        maxLng: Math.max(...lngs),
      };

      db.prepare(`
        INSERT INTO maps (map_id, mower_sn, map_name, map_area, map_max_min, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(map_id) DO UPDATE SET
          map_area = excluded.map_area,
          map_max_min = excluded.map_max_min,
          updated_at = datetime('now')
      `).run(
        mapId, sn,
        `Imported map${area.mapIndex}`,
        JSON.stringify(points),
        JSON.stringify(bounds),
      );
      imported++;
    }

    res.json({
      ok: true,
      imported,
      totalAreas: result.areas.length,
      chargingPose: result.chargingPose,
    });
  } catch (err) {
    res.status(500).json({ error: 'Import mislukt', details: String(err) });
  }
});

// ── Map calibratie endpoints ──────────────────────────────────────

interface CalibrationRow {
  mower_sn: string;
  offset_lat: number;
  offset_lng: number;
  rotation: number;
  scale: number;
  charger_lat: number | null;
  charger_lng: number | null;
  updated_at: string;
}

// GET /api/dashboard/calibration/:sn — haal calibratie op
dashboardRouter.get('/calibration/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const row = db.prepare(
    'SELECT * FROM map_calibration WHERE mower_sn = ?'
  ).get(sn) as CalibrationRow | undefined;

  res.json({
    calibration: row
      ? { offsetLat: row.offset_lat, offsetLng: row.offset_lng, rotation: row.rotation, scale: row.scale,
          chargerLat: row.charger_lat, chargerLng: row.charger_lng }
      : { offsetLat: 0, offsetLng: 0, rotation: 0, scale: 1, chargerLat: null, chargerLng: null },
  });
});

// PUT /api/dashboard/calibration/:sn — sla calibratie op
dashboardRouter.put('/calibration/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { offsetLat, offsetLng, rotation, scale, chargerLat, chargerLng } = req.body as {
    offsetLat?: number;
    offsetLng?: number;
    rotation?: number;
    scale?: number;
    chargerLat?: number | null;
    chargerLng?: number | null;
  };

  db.prepare(`
    INSERT INTO map_calibration (mower_sn, offset_lat, offset_lng, rotation, scale, charger_lat, charger_lng, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mower_sn) DO UPDATE SET
      offset_lat  = excluded.offset_lat,
      offset_lng  = excluded.offset_lng,
      rotation    = excluded.rotation,
      scale       = excluded.scale,
      charger_lat = excluded.charger_lat,
      charger_lng = excluded.charger_lng,
      updated_at  = datetime('now')
  `).run(sn, offsetLat ?? 0, offsetLng ?? 0, rotation ?? 0, scale ?? 1, chargerLat ?? null, chargerLng ?? null);

  res.json({ ok: true });
});

// POST /api/dashboard/maps/convert — converteer coördinaten (voor debugging)
dashboardRouter.post('/maps/convert', (req: Request, res: Response) => {
  const body = req.body as {
    direction: 'gps-to-local' | 'local-to-gps';
    origin: GpsPoint;
    points: Array<GpsPoint | { x: number; y: number }>;
  };

  if (!body.direction || !body.origin || !body.points) {
    res.status(400).json({ error: 'direction, origin, en points zijn vereist' });
    return;
  }

  if (body.direction === 'gps-to-local') {
    const result = (body.points as GpsPoint[]).map(p => gpsToLocal(p, body.origin));
    res.json({ points: result });
  } else {
    const result = (body.points as Array<{ x: number; y: number }>).map(p =>
      localToGps(p, body.origin)
    );
    res.json({ points: result });
  }
});

// ── MQTT command publishing ─────────────────────────────────────

// POST /api/dashboard/command/:sn — stuur een MQTT commando naar een apparaat
dashboardRouter.post('/command/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { command } = req.body as { command?: Record<string, unknown> };

  if (!command || typeof command !== 'object') {
    res.status(400).json({ error: 'command object is vereist' });
    return;
  }

  const { force } = req.query as { force?: string };
  if (!force && !isDeviceOnline(sn)) {
    res.status(404).json({ error: 'Device is offline' });
    return;
  }

  // Auto-encrypt voor LFIN-apparaten (maaiers) — firmware accepteert alleen AES-versleutelde payloads
  // Handmatige override: encrypt=true/false in body
  const { encrypt: doEncrypt, qos } = req.body as { encrypt?: boolean; qos?: number };
  const shouldEncrypt = doEncrypt !== undefined ? doEncrypt : sn.startsWith('LFIN');

  if (shouldEncrypt) {
    const KEY_PREFIX = 'abcdabcd1234';
    const IV = Buffer.from('abcd1234abcd1234', 'utf8');
    const key = Buffer.from(KEY_PREFIX + sn.slice(-4), 'utf8');
    const json = JSON.stringify(command);
    // Pad naar 16-byte grens met null bytes (AES block size)
    const plaintext = Buffer.from(json, 'utf8');
    const padded = Buffer.alloc(Math.ceil(plaintext.length / 16) * 16, 0);
    plaintext.copy(padded);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    console.log(`[DASHBOARD] Encrypted command (${json.length}B → ${encrypted.length}B) voor ${sn}: ${json}`);
    publishRawToDevice(sn, encrypted, (qos === 1 ? 1 : 0) as 0 | 1);
    res.json({ ok: true, command: Object.keys(command)[0], encrypted: true, size: encrypted.length });
  } else {
    publishToDevice(sn, command);
    res.json({ ok: true, command: Object.keys(command)[0] });
  }
});

// ── Direct TCP debug endpoint ───────────────────────────────────

// POST /api/dashboard/raw-tcp/:sn — stuur encrypted commando direct via TCP (bypass aedes)
dashboardRouter.post('/raw-tcp/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { command, qos } = req.body as { command?: Record<string, unknown>; qos?: number };

  if (!command) {
    res.status(400).json({ error: 'command is vereist' });
    return;
  }

  // Encrypt het commando
  const KEY_PREFIX = 'abcdabcd1234';
  const IV = Buffer.from('abcd1234abcd1234', 'utf8');
  const key = Buffer.from(KEY_PREFIX + sn.slice(-4), 'utf8');
  const json = JSON.stringify(command);
  const plaintext = Buffer.from(json, 'utf8');
  const padded = Buffer.alloc(Math.ceil(plaintext.length / 16) * 16, 0);
  plaintext.copy(padded);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

  console.log(`[RAW-TCP] Command: ${json} → ${encrypted.length}B encrypted`);

  const sent = writeRawPublish(sn, encrypted, (qos === 1 ? 1 : 0) as 0 | 1);
  if (sent) {
    res.json({ ok: true, command: Object.keys(command)[0], encrypted: true, size: encrypted.length, method: 'raw-tcp' });
  } else {
    res.status(404).json({ error: `Geen TCP socket voor ${sn}` });
  }
});

// ── Dashboard schedules ─────────────────────────────────────────

interface ScheduleRow {
  schedule_id: string;
  mower_sn: string;
  schedule_name: string | null;
  start_time: string;
  end_time: string | null;
  weekdays: string;
  enabled: number;
  map_id: string | null;
  map_name: string | null;
  cutting_height: number;
  path_direction: number;
  work_mode: number;
  task_mode: number;
  created_at: string;
  updated_at: string;
}

function scheduleRowToDto(r: ScheduleRow) {
  return {
    scheduleId: r.schedule_id,
    mowerSn: r.mower_sn,
    scheduleName: r.schedule_name,
    startTime: r.start_time,
    endTime: r.end_time,
    weekdays: JSON.parse(r.weekdays),
    enabled: r.enabled === 1,
    mapId: r.map_id,
    mapName: r.map_name,
    cuttingHeight: r.cutting_height,
    pathDirection: r.path_direction,
    workMode: r.work_mode,
    taskMode: r.task_mode,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// GET /api/dashboard/schedules/:sn — alle schedules voor een maaier
dashboardRouter.get('/schedules/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const rows = db.prepare(
    'SELECT * FROM dashboard_schedules WHERE mower_sn = ? ORDER BY start_time'
  ).all(sn) as ScheduleRow[];
  res.json({ schedules: rows.map(scheduleRowToDto) });
});

// POST /api/dashboard/schedules/:sn — nieuw schedule aanmaken
dashboardRouter.post('/schedules/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const body = req.body as {
    scheduleName?: string;
    startTime: string;
    endTime?: string;
    weekdays?: number[];
    mapId?: string;
    mapName?: string;
    cuttingHeight?: number;
    pathDirection?: number;
    workMode?: number;
    taskMode?: number;
  };

  if (!body.startTime) {
    res.status(400).json({ error: 'startTime is vereist' });
    return;
  }

  const scheduleId = uuidv4();
  db.prepare(`
    INSERT INTO dashboard_schedules
      (schedule_id, mower_sn, schedule_name, start_time, end_time, weekdays, enabled,
       map_id, map_name, cutting_height, path_direction, work_mode, task_mode)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    scheduleId, sn,
    body.scheduleName ?? null,
    body.startTime,
    body.endTime ?? null,
    JSON.stringify(body.weekdays ?? [1, 2, 3, 4, 5]),
    body.mapId ?? null,
    body.mapName ?? null,
    body.cuttingHeight ?? 40,
    body.pathDirection ?? 0,
    body.workMode ?? 0,
    body.taskMode ?? 0,
  );

  // Stuur timer_task naar maaier als die online is
  if (isDeviceOnline(sn)) {
    publishToDevice(sn, {
      timer_task: {
        task_id: scheduleId,
        start_time: body.startTime,
        end_time: body.endTime ?? '',
        map_id: body.mapId ?? '',
        map_name: body.mapName ?? '',
        repeat_type: 'WEEKLY',
        is_timer: true,
        work_mode: body.workMode ?? 0,
        task_mode: body.taskMode ?? 0,
        cov_direction: 0,
        path_direction: body.pathDirection ?? 0,
      },
    });

    // Stuur set_para_info voor cutting height en path direction
    publishToDevice(sn, {
      set_para_info: {
        cutGrassHeight: body.cuttingHeight ?? 40,
        defaultCuttingHeight: body.cuttingHeight ?? 40,
        target_height: body.cuttingHeight ?? 40,
        path_direction: body.pathDirection ?? 0,
      },
    });
  }

  const row = db.prepare('SELECT * FROM dashboard_schedules WHERE schedule_id = ?').get(scheduleId) as ScheduleRow;
  res.json({ ok: true, schedule: scheduleRowToDto(row) });
});

// PATCH /api/dashboard/schedules/:sn/:scheduleId — update schedule
dashboardRouter.patch('/schedules/:sn/:scheduleId', (req: Request, res: Response) => {
  const { sn, scheduleId } = req.params;
  const body = req.body as Record<string, unknown>;

  const existing = db.prepare('SELECT schedule_id FROM dashboard_schedules WHERE schedule_id = ? AND mower_sn = ?').get(scheduleId, sn);
  if (!existing) {
    res.status(404).json({ error: 'Schedule niet gevonden' });
    return;
  }

  db.prepare(`
    UPDATE dashboard_schedules SET
      schedule_name  = COALESCE(?, schedule_name),
      start_time     = COALESCE(?, start_time),
      end_time       = COALESCE(?, end_time),
      weekdays       = COALESCE(?, weekdays),
      enabled        = COALESCE(?, enabled),
      map_id         = COALESCE(?, map_id),
      map_name       = COALESCE(?, map_name),
      cutting_height = COALESCE(?, cutting_height),
      path_direction = COALESCE(?, path_direction),
      work_mode      = COALESCE(?, work_mode),
      task_mode      = COALESCE(?, task_mode),
      updated_at     = datetime('now')
    WHERE schedule_id = ? AND mower_sn = ?
  `).run(
    body.scheduleName ?? null,
    body.startTime ?? null,
    body.endTime ?? null,
    body.weekdays ? JSON.stringify(body.weekdays) : null,
    body.enabled !== undefined ? (body.enabled ? 1 : 0) : null,
    body.mapId ?? null,
    body.mapName ?? null,
    body.cuttingHeight ?? null,
    body.pathDirection ?? null,
    body.workMode ?? null,
    body.taskMode ?? null,
    scheduleId, sn,
  );

  const row = db.prepare('SELECT * FROM dashboard_schedules WHERE schedule_id = ?').get(scheduleId) as ScheduleRow;
  res.json({ ok: true, schedule: scheduleRowToDto(row) });
});

// DELETE /api/dashboard/schedules/:sn/:scheduleId — verwijder schedule
dashboardRouter.delete('/schedules/:sn/:scheduleId', (req: Request, res: Response) => {
  const { sn, scheduleId } = req.params;
  db.prepare('DELETE FROM dashboard_schedules WHERE schedule_id = ? AND mower_sn = ?').run(scheduleId, sn);
  res.json({ ok: true });
});

// POST /api/dashboard/schedules/:sn/:scheduleId/send — push schedule naar maaier via MQTT
dashboardRouter.post('/schedules/:sn/:scheduleId/send', (req: Request, res: Response) => {
  const { sn, scheduleId } = req.params;

  if (!isDeviceOnline(sn)) {
    res.status(404).json({ error: 'Device is offline' });
    return;
  }

  const row = db.prepare('SELECT * FROM dashboard_schedules WHERE schedule_id = ? AND mower_sn = ?').get(scheduleId, sn) as ScheduleRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Schedule niet gevonden' });
    return;
  }

  publishToDevice(sn, {
    timer_task: {
      task_id: row.schedule_id,
      start_time: row.start_time,
      end_time: row.end_time ?? '',
      map_id: row.map_id ?? '',
      map_name: row.map_name ?? '',
      repeat_type: 'WEEKLY',
      is_timer: true,
      work_mode: row.work_mode,
      task_mode: row.task_mode,
      cov_direction: 0,
      path_direction: row.path_direction,
    },
  });

  publishToDevice(sn, {
    set_para_info: {
      cutGrassHeight: row.cutting_height,
      defaultCuttingHeight: row.cutting_height,
      target_height: row.cutting_height,
      path_direction: row.path_direction,
    },
  });

  res.json({ ok: true, message: 'Schedule en parameters verstuurd naar maaier' });
});
