/**
 * Dashboard REST endpoints — initial state load voor de React app.
 * Geen auth — alleen bedoeld voor lokaal netwerk.
 */
import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import { getAllDeviceSnapshots, getDeviceSnapshot, SENSORS, getGpsTrail, clearGpsTrail, deviceCache } from '../mqtt/sensorData.js';
import { isDeviceOnline, writeRawPublish, getBrokerDiagnostics } from '../mqtt/broker.js';
import { getRecentLogs } from '../dashboard/socketHandler.js';
import { requestMapList, requestMapOutline, publishToDevice, publishRawToDevice, publishEncryptedOnTopic, publishToTopic } from '../mqtt/mapSync.js';
import crypto from 'crypto';
import { generateMapZipFromDb, gpsToLocal, localToGps, parseMapZip, type GpsPoint } from '../mqtt/mapConverter.js';
import { existsSync, unlinkSync, readFileSync, readdirSync, createReadStream, statSync } from 'fs';
import { execSync } from 'child_process';
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
  mower_version: string | null;
  charger_version: string | null;
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

  const equipment = db.prepare('SELECT mower_sn, charger_sn, equipment_nick_name, mower_version, charger_version FROM equipment').all() as EquipmentRow[];

  // Verzamel alle gebonden SNs + versie lookup
  const boundSns = new Set<string>();
  const versionBySn = new Map<string, string>();
  // Eerste pass: directe koppelingen
  for (const e of equipment) {
    if (e.mower_sn) boundSns.add(e.mower_sn);
    if (e.charger_sn) boundSns.add(e.charger_sn);
    // Mower versie bij mower SN
    if (e.mower_sn?.startsWith('LFIN') && e.mower_version) {
      versionBySn.set(e.mower_sn, e.mower_version);
    }
    // Charger versie bij charger SN
    if (e.charger_sn && e.charger_version) {
      versionBySn.set(e.charger_sn, e.charger_version);
    }
  }
  // Tweede pass: charger_version uit maaier-rij toewijzen aan LFIC device
  for (const e of equipment) {
    if (!e.charger_version) continue;
    for (const sn of boundSns) {
      if (sn.startsWith('LFIC') && !versionBySn.has(sn)) {
        versionBySn.set(sn, e.charger_version);
      }
    }
  }

  const snapshots = getAllDeviceSnapshots();

  // Filter: toon alleen gebonden apparaten of online apparaten
  const devices = registry
    .filter(d => boundSns.has(d.sn!) || isDeviceOnline(d.sn!))
    .map(d => {
      const sensors = snapshots[d.sn!] ?? {};
      // Inject firmware versie uit equipment tabel als die niet al in sensors zit
      const dbVersion = versionBySn.get(d.sn!);
      if (dbVersion && !sensors.sw_version && !sensors.version) {
        sensors.version = dbVersion;
      }
      return {
        sn: d.sn!,
        macAddress: d.mac_address,
        lastSeen: d.last_seen,
        online: isDeviceOnline(d.sn!),
        deviceType: d.sn!.startsWith('LFIC') ? 'charger' as const : 'mower' as const,
        nickname: equipment.find(e =>
          e.mower_sn === d.sn || e.charger_sn === d.sn
        )?.equipment_nick_name ?? null,
        sensors,
      };
    });

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

  // Auto-encrypt voor LFI-apparaten — maaier (v6+) en charger (v0.4.0+) verwachten AES
  // Handmatige override: encrypt=true/false in body
  const { encrypt: doEncrypt, qos } = req.body as { encrypt?: boolean; qos?: number };
  const shouldEncrypt = doEncrypt !== undefined ? doEncrypt : sn.startsWith('LFI');

  // LED bridge: als het commando set_para_info met headlight bevat,
  // stuur ook een onversleuteld bericht naar novabot/cmd/<SN> zodat
  // led_bridge.py op de maaier de lamp direct via ROS kan aansturen.
  const paraInfo = command.set_para_info as Record<string, unknown> | undefined;
  if (paraInfo && 'headlight' in paraInfo) {
    const ledValue = Number(paraInfo.headlight);
    publishToTopic(`novabot/cmd/${sn}`, { led_set: ledValue });
    // Update sensor cache zodat dashboard direct de juiste state toont
    if (!deviceCache.has(sn)) deviceCache.set(sn, new Map());
    deviceCache.get(sn)!.set('headlight_active', String(ledValue));
  }

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

// ── Static firmware file serving ────────────────────────────────
import express from 'express';

const firmwareDir = process.env.FIRMWARE_PATH ?? path.resolve(__dirname, '../../firmware');
// Custom firmware download handler met uitgebreide logging
dashboardRouter.get('/firmware/:filename', (req: Request, res: Response) => {
  const filename = req.params.filename;
  const filePath = path.join(firmwareDir, filename);

  if (!existsSync(filePath)) {
    res.status(404).send('File not found');
    return;
  }

  const fileSize = statSync(filePath).size;
  const rangeHeader = req.headers.range;
  let start = 0;
  let end = fileSize - 1;
  let isResume = false;

  if (rangeHeader) {
    const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (rangeMatch) {
      start = parseInt(rangeMatch[1], 10);
      end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : fileSize - 1;

      if (start >= fileSize) {
        // Download is al compleet — stuur 416 Range Not Satisfiable (RFC 7233 §4.4)
        // Dit vertelt libcurl dat het bestand al volledig is → ota_client_node gaat door met MD5 check
        console.log(`\x1b[38;5;46m[OTA] ✓ Range ${rangeHeader} beyond EOF (${fileSize}B) — bestand al compleet, 416\x1b[0m`);
        res.writeHead(416, {
          'Content-Range': `bytes */${fileSize}`,
          'Content-Length': 0,
        });
        res.end();
        return;
      } else {
        isResume = true;
        console.log(`\x1b[38;5;208m[OTA] Resume download: bytes ${start}-${end}/${fileSize} (${((start/fileSize)*100).toFixed(1)}% al gedownload)\x1b[0m`);
      }
    }
  }

  const chunkSize = end - start + 1;
  console.log(`\x1b[38;5;208m[OTA] ⬇ Start serving ${filename}: ${chunkSize} bytes (${(chunkSize/1024/1024).toFixed(1)}MB) ${isResume ? 'RESUME' : 'FRESH'}\x1b[0m`);

  const headers: Record<string, string | number> = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': chunkSize,
    'Accept-Ranges': 'bytes',
  };

  if (isResume) {
    headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
    res.writeHead(206, headers);
  } else {
    res.writeHead(200, headers);
  }

  let bytesSent = 0;
  const stream = createReadStream(filePath, { start, end });
  const startTime = Date.now();
  let lastLog = 0;

  stream.on('data', (chunk) => {
    bytesSent += chunk.length;
    const now = Date.now();
    // Log elke 5 seconden
    if (now - lastLog > 5000) {
      const pct = (((start + bytesSent) / fileSize) * 100).toFixed(1);
      const elapsed = ((now - startTime) / 1000).toFixed(1);
      const speed = ((bytesSent / 1024 / 1024) / ((now - startTime) / 1000)).toFixed(1);
      console.log(`\x1b[38;5;208m[OTA] ⬇ ${pct}% (${(bytesSent/1024/1024).toFixed(1)}MB/${(chunkSize/1024/1024).toFixed(1)}MB) ${elapsed}s ${speed}MB/s\x1b[0m`);
      lastLog = now;
    }
  });

  stream.pipe(res);

  res.on('close', () => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalPct = (((start + bytesSent) / fileSize) * 100).toFixed(1);
    if (bytesSent >= chunkSize) {
      console.log(`\x1b[38;5;46m[OTA] ✓ Download COMPLEET: ${(bytesSent/1024/1024).toFixed(1)}MB in ${elapsed}s (${totalPct}%)\x1b[0m`);
    } else {
      console.log(`\x1b[38;5;196m[OTA] ✗ Download AFGEBROKEN op ${totalPct}% (${(bytesSent/1024/1024).toFixed(1)}MB/${(chunkSize/1024/1024).toFixed(1)}MB) na ${elapsed}s\x1b[0m`);
    }
  });

  stream.on('error', (err) => {
    console.log(`\x1b[38;5;196m[OTA] Stream error: ${err.message}\x1b[0m`);
    if (!res.headersSent) res.status(500).send('Stream error');
  });
});

// GET /api/dashboard/firmware-list — lijst alle firmware bestanden
dashboardRouter.get('/firmware-list', (_req: Request, res: Response) => {
  try {
    const files = readdirSync(firmwareDir).filter(f => !f.startsWith('.'));
    const list = files.map(f => {
      const filePath = path.join(firmwareDir, f);
      const hash = crypto.createHash('md5').update(readFileSync(filePath)).digest('hex');
      const stats = statSync(filePath);
      return { name: f, md5: hash, size: stats.size };
    });
    res.json({ ok: true, files: list });
  } catch {
    res.json({ ok: true, files: [] });
  }
});

// ── OTA Version Management ──────────────────────────────────────

// ── Firmware versie extractie uit binaire bestanden ─────────────────────────

/**
 * Extraheer firmware versie uit een ESP32-S3 charger binary (.bin).
 * De versie (bijv. "v0.3.6") is de 2e match van /^v\d+\.\d+/ in strings output.
 * (1e = ESP-IDF versie, 2e = firmware versie, 3e = sub-versie)
 */
function extractChargerVersion(binPath: string): string | null {
  try {
    const output = execSync(`strings "${binPath}"`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const matches = output.split('\n').filter(l => /^v\d+\.\d+\.\d+/.test(l));
    // 2e match is altijd de firmware versie
    return matches.length >= 2 ? matches[1].trim() : matches[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Extraheer firmware versie uit een maaier Debian pakket (.deb).
 * Leest novabot_version_code uit novabot_api.yaml in het pakket.
 */
function extractMowerVersion(debPath: string): string | null {
  try {
    const output = execSync(
      `ar p "${debPath}" data.tar.xz 2>/dev/null | tar -xJOf - ./install/novabot_api/share/novabot_api/config/novabot_api.yaml 2>/dev/null`,
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    const match = output.match(/novabot_version_code:\s*(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Extraheer firmware versie uit een lokaal firmware bestand.
 * Detecteert automatisch het type op basis van bestandsextensie.
 */
function extractFirmwareVersion(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  if (filePath.endsWith('.deb')) return extractMowerVersion(filePath);
  if (filePath.endsWith('.bin')) return extractChargerVersion(filePath);
  return null;
}

/**
 * Vergelijk twee semver-achtige versies. Retourneert:
 *  -1 als a < b, 0 als a == b, 1 als a > b
 */
function compareVersions(a: string, b: string): number {
  // Strip 'v' prefix en splits op . en -
  const normalize = (v: string) => v.replace(/^v/i, '').split(/[.\-]/).map(p => {
    const n = parseInt(p, 10);
    return isNaN(n) ? p : n;
  });
  const pa = normalize(a);
  const pb = normalize(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (typeof va === 'number' && typeof vb === 'number') {
      if (va < vb) return -1;
      if (va > vb) return 1;
    } else {
      const sa = String(va);
      const sb = String(vb);
      if (sa < sb) return -1;
      if (sa > sb) return 1;
    }
  }
  return 0;
}

interface OtaVersionRow {
  id: number;
  version: string;
  device_type: string;
  release_notes: string | null;
  download_url: string | null;
  md5: string | null;
  created_at: string;
}

// GET /api/dashboard/ota/versions — lijst alle OTA versies
dashboardRouter.get('/ota/versions', (_req: Request, res: Response) => {
  const rows = db.prepare(`SELECT * FROM ota_versions ORDER BY id DESC`).all() as OtaVersionRow[];
  res.json({ ok: true, versions: rows });
});

// POST /api/dashboard/ota/versions — voeg een OTA versie toe
dashboardRouter.post('/ota/versions', (req: Request, res: Response) => {
  const { version, device_type, download_url, release_notes, md5 } = req.body as {
    version: string;
    device_type?: string;
    download_url?: string;
    release_notes?: string;
    md5?: string;
  };

  // Auto-versie en md5 uit firmware bestand halen als download_url naar lokaal bestand wijst
  let resolvedVersion = version ?? null;
  let calculatedMd5 = md5 ?? null;
  let detectedDeviceType = device_type ?? null;

  if (download_url) {
    const match = download_url.match(/\/firmware\/(.+)$/);
    if (match) {
      const filePath = path.join(firmwareDir, match[1]);
      if (existsSync(filePath)) {
        // Auto-bereken md5
        if (!calculatedMd5) {
          calculatedMd5 = crypto.createHash('md5').update(readFileSync(filePath)).digest('hex');
          console.log(`\x1b[38;5;208m[OTA] Auto-berekende md5 voor ${match[1]}: ${calculatedMd5}\x1b[0m`);
        }
        // Auto-detecteer versie uit binair bestand
        const fileVersion = extractFirmwareVersion(filePath);
        if (fileVersion) {
          if (!resolvedVersion) {
            resolvedVersion = fileVersion;
            console.log(`\x1b[38;5;208m[OTA] Auto-gedetecteerde versie uit ${match[1]}: ${fileVersion}\x1b[0m`);
          } else if (resolvedVersion !== fileVersion) {
            console.warn(`\x1b[33m[OTA] ⚠ Opgegeven versie "${resolvedVersion}" wijkt af van bestandsversie "${fileVersion}" in ${match[1]}\x1b[0m`);
          }
        }
        // Auto-detecteer device type
        if (!detectedDeviceType) {
          detectedDeviceType = filePath.endsWith('.deb') ? 'mower' : 'charger';
        }
      }
    }
  }

  if (!resolvedVersion) {
    res.status(400).json({ error: 'version is vereist (of upload een firmware bestand met versie-info)' });
    return;
  }

  const result = db.prepare(`
    INSERT INTO ota_versions (version, device_type, download_url, release_notes, md5)
    VALUES (?, ?, ?, ?, ?)
  `).run(resolvedVersion, detectedDeviceType ?? 'charger', download_url ?? null, release_notes ?? null, calculatedMd5);

  console.log(`\x1b[38;5;208m[OTA] Versie toegevoegd: ${resolvedVersion} (${detectedDeviceType ?? 'charger'}) id=${result.lastInsertRowid}\x1b[0m`);
  res.json({ ok: true, id: result.lastInsertRowid, version: resolvedVersion, device_type: detectedDeviceType ?? 'charger', md5: calculatedMd5 });
});

// PATCH /api/dashboard/ota/versions/:id — bewerk een OTA versie
dashboardRouter.patch('/ota/versions/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { version, device_type, download_url, release_notes, md5 } = req.body as {
    version?: string;
    device_type?: string;
    download_url?: string;
    release_notes?: string;
    md5?: string;
  };

  const existing = db.prepare('SELECT id FROM ota_versions WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ error: 'OTA versie niet gevonden' });
    return;
  }

  // Auto-recalculate md5 als download_url wijzigt naar lokaal bestand
  let calculatedMd5 = md5 ?? null;
  if (download_url && !calculatedMd5) {
    const urlMatch = download_url.match(/\/firmware\/(.+)$/);
    if (urlMatch) {
      const filePath = path.join(firmwareDir, urlMatch[1]);
      if (existsSync(filePath)) {
        calculatedMd5 = crypto.createHash('md5').update(readFileSync(filePath)).digest('hex');
      }
    }
  }

  db.prepare(`
    UPDATE ota_versions SET
      version       = COALESCE(?, version),
      device_type   = COALESCE(?, device_type),
      download_url  = COALESCE(?, download_url),
      release_notes = COALESCE(?, release_notes),
      md5           = COALESCE(?, md5)
    WHERE id = ?
  `).run(version ?? null, device_type ?? null, download_url ?? null, release_notes ?? null, calculatedMd5, id);

  console.log(`\x1b[38;5;208m[OTA] Versie bijgewerkt: id=${id}${version ? ` version=${version}` : ''}\x1b[0m`);
  const row = db.prepare('SELECT * FROM ota_versions WHERE id = ?').get(id);
  res.json({ ok: true, version: row });
});

// DELETE /api/dashboard/ota/versions/:id — verwijder een OTA versie
dashboardRouter.delete('/ota/versions/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  db.prepare(`DELETE FROM ota_versions WHERE id = ?`).run(id);
  console.log(`\x1b[38;5;208m[OTA] Versie verwijderd: id=${id}\x1b[0m`);
  res.json({ ok: true });
});

// POST /api/dashboard/ota/trigger/:sn — stuur ota_upgrade_cmd naar apparaat
dashboardRouter.post('/ota/trigger/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { version_id } = req.body as { version_id?: number };

  if (!version_id) {
    res.status(400).json({ error: 'version_id is vereist' });
    return;
  }

  const otaVersion = db.prepare(`SELECT * FROM ota_versions WHERE id = ?`).get(version_id) as OtaVersionRow | undefined;
  if (!otaVersion) {
    res.status(404).json({ error: 'OTA versie niet gevonden' });
    return;
  }

  if (!otaVersion.download_url) {
    res.status(400).json({ error: 'Geen download URL geconfigureerd voor deze versie' });
    return;
  }

  // Versie-check: vergelijk met huidige firmware versie op apparaat
  const isChargerDevice = sn.startsWith('LFIC');
  const equipRow = isChargerDevice
    ? db.prepare('SELECT charger_version FROM equipment WHERE charger_sn = ? LIMIT 1').get(sn) as { charger_version: string | null } | undefined
    : db.prepare('SELECT mower_version FROM equipment WHERE mower_sn = ? LIMIT 1').get(sn) as { mower_version: string | null } | undefined;
  const currentVersion = isChargerDevice
    ? (equipRow as { charger_version: string | null } | undefined)?.charger_version
    : (equipRow as { mower_version: string | null } | undefined)?.mower_version;

  // Dashboard trigger is altijd een bewuste actie van de beheerder → versie-check is
  // alleen een waarschuwing, nooit een blokkade. De frontend stuurt force=true mee,
  // maar oudere builds doen dat niet, dus default naar true voor dashboard endpoint.
  const { force } = req.body as { force?: boolean };
  const forceOta = force !== false; // default true voor dashboard
  if (currentVersion && otaVersion.version) {
    const cmp = compareVersions(otaVersion.version, currentVersion);
    if (cmp <= 0) {
      const label = cmp === 0 ? 'gelijk aan' : 'ouder dan';
      console.warn(`\x1b[33m[OTA] ⚠ ${forceOta ? 'Force-flash' : 'Versie-check'}: ${otaVersion.version} is ${label} ${currentVersion} op ${sn}\x1b[0m`);
    }
  }

  // Verifieer ook de versie in het firmware bestand zelf (als lokaal beschikbaar)
  if (otaVersion.download_url) {
    const urlMatch = otaVersion.download_url.match(/\/firmware\/(.+)$/);
    if (urlMatch) {
      const filePath = path.join(firmwareDir, urlMatch[1]);
      const fileVersion = extractFirmwareVersion(filePath);
      if (fileVersion && fileVersion !== otaVersion.version) {
        console.warn(`\x1b[33m[OTA] ⚠ Versie mismatch: DB="${otaVersion.version}" maar bestand="${fileVersion}" (${urlMatch[1]})\x1b[0m`);
      }
    }
  }

  // Forceer http:// — lokale server heeft geen TLS, maaier kan geen https
  const downloadUrl = otaVersion.download_url!.replace(/^https:\/\//, 'http://');
  if (downloadUrl !== otaVersion.download_url) {
    console.warn(`\x1b[33m[OTA] ⚠ HTTPS→HTTP: ${otaVersion.download_url} → ${downloadUrl}\x1b[0m`);
  }

  console.log(`\x1b[38;5;208m[OTA] Trigger OTA voor ${sn}: versie=${otaVersion.version}${currentVersion ? ` (huidig: ${currentVersion})` : ''} url=${downloadUrl}\x1b[0m`);

  // GEEN set_cfg_info (timezone) sturen! mqtt_node zet type:"increment" als
  // timezone in geheugen zit. Zonder timezone → type:"full" → OTA werkt.

  // Beide apparaten krijgen nu AES-encrypted commando's (charger v0.4.0+ en maaier v6+)
  // publishToDevice() handelt AES encryptie automatisch af voor LFI* apparaten
  const isCharger = sn.startsWith('LFIC');
  if (isCharger) {
    // Charger ESP32: plat formaat — url/md5/version direct in ota_upgrade_cmd
    const otaCommand = {
      ota_upgrade_cmd: {
        url: downloadUrl,
        md5: otaVersion.md5 ?? '',
        version: otaVersion.version,
      },
    };
    publishToDevice(sn, otaCommand);
    console.log(`\x1b[38;5;208m[OTA] Encrypted ota_upgrade_cmd naar charger ${sn}\x1b[0m`);
  } else {
    // Maaier OTA: EXACT het formaat dat bewezen werkte via de app op 2 maart 2026.
    // Bron: broker.ts OTA-FIX log van het succesvolle app-OTA naar custom-5.
    // GEEN tz veld (mqtt_node zet anders type:"increment").
    const mowerOtaCommand = {
      ota_upgrade_cmd: {
        cmd: 'upgrade',
        type: 'full',
        content: 'app',
        url: downloadUrl,
        version: otaVersion.version,
        md5: otaVersion.md5 ?? '',
      },
    };
    publishToDevice(sn, mowerOtaCommand);
    console.log(`\x1b[38;5;208m[OTA] Encrypted ota_upgrade_cmd naar mower ${sn}: ${JSON.stringify(mowerOtaCommand)}\x1b[0m`);
  }

  res.json({ ok: true, command: 'ota_upgrade_cmd', version: otaVersion.version, target: sn });
});

// ── Camera proxy ──────────────────────────────────────────────────────────────

import http from 'http';

// GET /api/dashboard/camera/:sn/stream — proxy MJPEG stream van de maaier
dashboardRouter.get('/camera/:sn/stream', (req: Request, res: Response) => {
  const ip = req.query.ip as string;
  const port = parseInt(req.query.port as string) || 8000;

  if (!ip) {
    res.status(400).json({ error: 'ip query parameter is vereist' });
    return;
  }

  // Disable Express timeout — MJPEG stream is infinite
  req.setTimeout(0);
  res.setTimeout(0);

  const proxyReq = http.get(`http://${ip}:${port}/stream`, (proxyRes) => {
    // Forward headers — NO Connection:close (MJPEG needs keep-alive)
    res.writeHead(proxyRes.statusCode ?? 200, {
      'Content-Type': proxyRes.headers['content-type'] ?? 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.log(`[CAMERA] Proxy error voor ${ip}:${port}: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Camera niet bereikbaar', details: err.message });
    }
  });

  req.on('close', () => {
    proxyReq.destroy();
  });
});

// GET /api/dashboard/camera/:sn/snapshot — single JPEG snapshot
dashboardRouter.get('/camera/:sn/snapshot', (req: Request, res: Response) => {
  const ip = req.query.ip as string;
  const port = parseInt(req.query.port as string) || 8000;

  if (!ip) {
    res.status(400).json({ error: 'ip query parameter is vereist' });
    return;
  }

  http.get(`http://${ip}:${port}/snapshot`, (proxyRes) => {
    const chunks: Buffer[] = [];
    proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    proxyRes.on('end', () => {
      const body = Buffer.concat(chunks);
      res.writeHead(200, {
        'Content-Type': proxyRes.headers['content-type'] ?? 'image/jpeg',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    });
  }).on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Camera niet bereikbaar', details: err.message });
    }
  });
});

// ── MQTT diagnostiek ─────────────────────────────────────────────────────────

// GET /api/dashboard/mqtt-diag — broker state: connected clients, subscriptions, online devices
dashboardRouter.get('/mqtt-diag', (_req: Request, res: Response) => {
  const diag = getBrokerDiagnostics();
  res.json(diag);
});

// GET /api/dashboard/mqtt-logs — recente MQTT log entries (incl. forward tracking)
dashboardRouter.get('/mqtt-logs', (req: Request, res: Response) => {
  const typeFilter = req.query.type as string | undefined;
  let logs = getRecentLogs();
  if (typeFilter) logs = logs.filter(l => l.type === typeFilter);
  // Laatste 50 entries, meest recent eerst
  res.json(logs.slice(-50).reverse());
});

// POST /api/dashboard/mqtt-inject/:sn — publiceer een bericht op Dart/Receive_mqtt/<SN>
// Simuleert een device-response (bijv. ota_version_info_respond) om app te testen
dashboardRouter.post('/mqtt-inject/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { message } = req.body as { message?: Record<string, unknown> };
  if (!message) { res.status(400).json({ error: 'message required' }); return; }

  const topic = `Dart/Receive_mqtt/${sn}`;
  publishEncryptedOnTopic(topic, sn, message);
  res.json({ ok: true, topic, payload: JSON.stringify(message) });
});
