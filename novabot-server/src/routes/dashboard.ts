/**
 * Dashboard REST endpoints — initial state load voor de React app.
 * Geen auth — alleen bedoeld voor lokaal netwerk.
 */
import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import { getAllDeviceSnapshots, getDeviceSnapshot, SENSORS, getGpsTrail, clearGpsTrail } from '../mqtt/sensorData.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { getRecentLogs } from '../dashboard/socketHandler.js';
import { requestMapList, requestMapOutline } from '../mqtt/mapSync.js';
import { generateMapZipFromDb, gpsToLocal, localToGps, parseMapZip, type GpsPoint } from '../mqtt/mapConverter.js';
import { existsSync, unlinkSync } from 'fs';
import path from 'path';

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
dashboardRouter.get('/devices', (_req: Request, res: Response) => {
  const registry = db.prepare(
    'SELECT * FROM device_registry WHERE sn IS NOT NULL ORDER BY last_seen DESC'
  ).all() as DeviceRegistryRow[];

  const equipment = db.prepare('SELECT mower_sn, charger_sn, equipment_nick_name FROM equipment').all() as EquipmentRow[];

  const snapshots = getAllDeviceSnapshots();

  const devices = registry.map(d => ({
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
  map_area: string | null;
  map_max_min: string | null;
  file_name: string | null;
  file_size: number | null;
  created_at: string;
  updated_at: string;
}

// GET /api/dashboard/maps/:sn — kaarten voor een maaier (polygonen voor Leaflet)
dashboardRouter.get('/maps/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const rows = db.prepare(
    'SELECT * FROM maps WHERE mower_sn = ? ORDER BY updated_at DESC'
  ).all(sn) as MapRow[];

  const maps = rows.map(r => ({
    mapId: r.map_id,
    mapName: r.map_name,
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
    INSERT INTO maps (map_id, mower_sn, map_name, map_area, map_max_min, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(mapId, sn, mapName ?? null, JSON.stringify(mapArea), JSON.stringify(bounds));

  res.json({
    ok: true,
    map: {
      mapId,
      mapName: mapName ?? null,
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
      ? { offsetLat: row.offset_lat, offsetLng: row.offset_lng, rotation: row.rotation, scale: row.scale }
      : { offsetLat: 0, offsetLng: 0, rotation: 0, scale: 1 },
  });
});

// PUT /api/dashboard/calibration/:sn — sla calibratie op
dashboardRouter.put('/calibration/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { offsetLat, offsetLng, rotation, scale } = req.body as {
    offsetLat?: number;
    offsetLng?: number;
    rotation?: number;
    scale?: number;
  };

  db.prepare(`
    INSERT INTO map_calibration (mower_sn, offset_lat, offset_lng, rotation, scale, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mower_sn) DO UPDATE SET
      offset_lat = excluded.offset_lat,
      offset_lng = excluded.offset_lng,
      rotation   = excluded.rotation,
      scale      = excluded.scale,
      updated_at = datetime('now')
  `).run(sn, offsetLat ?? 0, offsetLng ?? 0, rotation ?? 0, scale ?? 1);

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
