/**
 * Dashboard REST endpoints — initial state load voor de React app.
 * Geen auth — alleen bedoeld voor lokaal netwerk.
 */
import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import { getAllDeviceSnapshots, getDeviceSnapshot, SENSORS, getGpsTrail, clearGpsTrail, getLocalTrail, clearLocalTrail, deviceCache, translateValue, markPinVerified } from '../mqtt/sensorData.js';
import { isDeviceOnline, writeRawPublish, getBrokerDiagnostics } from '../mqtt/broker.js';
import { getRecentLogs, forwardToDashboard } from '../dashboard/socketHandler.js';
import { requestMapList, requestMapOutline, publishToDevice, publishRawToDevice, publishEncryptedOnTopic, publishToTopic, goToChargePayload, getNextCmdNum } from '../mqtt/mapSync.js';
import crypto from 'crypto';
import { generateMapZipFromDb, gpsToLocal, localToGps, parseMapZip, type GpsPoint, type LocalPoint } from '../mqtt/mapConverter.js';
import { existsSync, unlinkSync, readFileSync, readdirSync, createReadStream, statSync, watch, mkdirSync, copyFileSync } from 'fs';
import { isDemoMode, setDemoMode as setDemo, getDemoStatus } from '../services/demoSimulator.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { networkInterfaces } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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
  mower_ip: string | null;
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

  const equipment = db.prepare('SELECT mower_sn, charger_sn, equipment_nick_name, mower_version, charger_version, mower_ip FROM equipment').all() as EquipmentRow[];

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

  // LoRa config uit equipment_lora_cache
  const loraCache = db.prepare('SELECT sn, charger_address, charger_channel FROM equipment_lora_cache').all() as { sn: string; charger_address: number | null; charger_channel: number | null }[];
  const loraBySn = new Map<string, { address: number | null; channel: number | null }>();
  for (const lc of loraCache) {
    loraBySn.set(lc.sn, { address: lc.charger_address, channel: lc.charger_channel });
  }

  // Persisted settings uit device_settings (voor set_para_info cache)
  const settingsRows = db.prepare('SELECT sn, key, value FROM device_settings').all() as { sn: string; key: string; value: string }[];
  const settingsBySn = new Map<string, Map<string, string>>();
  for (const row of settingsRows) {
    if (!settingsBySn.has(row.sn)) settingsBySn.set(row.sn, new Map());
    settingsBySn.get(row.sn)!.set(row.key, row.value);
  }

  // Filter: toon alleen gebonden apparaten of online/demo apparaten
  const devices = registry
    .filter(d => boundSns.has(d.sn!) || isDeviceOnline(d.sn!) || isDemoMode(d.sn!))
    .map(d => {
      const sensors = snapshots[d.sn!] ?? {};
      // Inject firmware versie uit equipment tabel als die niet al in sensors zit
      const dbVersion = versionBySn.get(d.sn!);
      if (dbVersion && !sensors.sw_version && !sensors.version) {
        sensors.version = dbVersion;
      }
      const eqRow = equipment.find(e => e.mower_sn === d.sn || e.charger_sn === d.sn);
      // Inject LoRa config uit equipment_lora_cache
      // Charger: directe lookup. Maaier: via gekoppelde charger SN.
      let lora = loraBySn.get(d.sn!);
      if (!lora && eqRow?.charger_sn) {
        lora = loraBySn.get(eqRow.charger_sn);
      }
      if (lora) {
        if (lora.address != null) sensors.lora_address = String(lora.address);
        if (lora.channel != null) sensors.lora_channel = String(lora.channel);
      }
      // Inject persisted settings (set_para_info cache) als fallback
      const persisted = settingsBySn.get(d.sn!);
      if (persisted) {
        for (const [key, val] of persisted) {
          if (!(key in sensors)) sensors[key] = val;
        }
      }
      return {
        sn: d.sn!,
        macAddress: d.mac_address,
        lastSeen: d.last_seen,
        online: isDeviceOnline(d.sn!) || isDemoMode(d.sn!),
        deviceType: d.sn!.startsWith('LFIC') ? 'charger' as const : 'mower' as const,
        nickname: eqRow?.equipment_nick_name ?? null,
        mowerIp: d.sn!.startsWith('LFIN') ? (eqRow?.mower_ip ?? null) : null,
        sensors,
      };
    });

  res.json({ devices });
});

// GET /api/dashboard/unbound-devices — apparaten die verbonden zijn maar nog niet aan een account gekoppeld
dashboardRouter.get('/unbound-devices', (_req: Request, res: Response) => {
  // Alle SNs die al in equipment zitten én gekoppeld zijn aan een bestaande gebruiker.
  // Equipment met een verwijzing naar een niet-bestaand account (verwijderd account) telt als ongebonden.
  const boundSnRows = db.prepare(`
    SELECT mower_sn, charger_sn FROM equipment
    WHERE user_id IS NOT NULL
      AND user_id IN (SELECT app_user_id FROM users)
  `).all() as { mower_sn: string; charger_sn: string | null }[];

  const boundSns = new Set<string>();
  for (const r of boundSnRows) {
    if (r.mower_sn)   boundSns.add(r.mower_sn);
    if (r.charger_sn) boundSns.add(r.charger_sn);
  }

  // Meest recent geziene entry per SN uit device_registry
  const registry = db.prepare(`
    SELECT d.* FROM device_registry d
    INNER JOIN (
      SELECT sn, MAX(last_seen) as max_seen FROM device_registry
      WHERE sn IS NOT NULL GROUP BY sn
    ) latest ON d.sn = latest.sn AND d.last_seen = latest.max_seen
    ORDER BY d.last_seen DESC
  `).all() as DeviceRegistryRow[];

  const unbound = registry
    .filter(d => d.sn && !boundSns.has(d.sn))
    .map(d => ({
      sn: d.sn!,
      deviceType: d.sn!.startsWith('LFIC') ? 'charger' as const : 'mower' as const,
      online: isDeviceOnline(d.sn!),
      lastSeen: d.last_seen,
    }));

  res.json({ devices: unbound });
});

// POST /api/dashboard/bind-device — koppel een device aan het account (enkelvoudige gebruiker)
dashboardRouter.post('/bind-device', (req: Request, res: Response) => {
  const { sn, name } = req.body as { sn?: string; name?: string };
  if (!sn) { res.status(400).json({ ok: false, error: 'sn required' }); return; }

  // Haal de enige gebruiker op (single-user setup)
  const user = db.prepare('SELECT app_user_id FROM users LIMIT 1').get() as { app_user_id: string } | undefined;
  if (!user) { res.status(400).json({ ok: false, error: 'Geen gebruiker gevonden' }); return; }

  const existing = db.prepare(
    'SELECT equipment_id, user_id FROM equipment WHERE mower_sn = ? OR charger_sn = ?'
  ).get(sn, sn) as { equipment_id: string; user_id: string | null } | undefined;

  if (existing) {
    // Bijwerken: user_id koppelen + eventueel naam
    db.prepare(`
      UPDATE equipment SET user_id = ?, equipment_nick_name = COALESCE(?, equipment_nick_name)
      WHERE equipment_id = ?
    `).run(user.app_user_id, name ?? null, existing.equipment_id);
  } else {
    // Nieuw record aanmaken
    const equipmentId = uuidv4();
    const isCharger = sn.startsWith('LFIC');
    db.prepare(`
      INSERT INTO equipment (equipment_id, user_id, mower_sn, equipment_type_h, equipment_nick_name)
      VALUES (?, ?, ?, ?, ?)
    `).run(equipmentId, user.app_user_id, sn, isCharger ? 'charger' : 'mower', name ?? null);
  }

  console.log(`[dashboard] bind-device: sn=${sn} name=${name ?? '-'} gebonden aan user ${user.app_user_id}`);
  res.json({ ok: true });
});

// DELETE /api/dashboard/devices/:sn — verwijder een device uit de registry
dashboardRouter.delete('/devices/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  db.prepare('DELETE FROM device_registry WHERE sn = ?').run(sn);
  res.json({ ok: true });
});

// PATCH /api/dashboard/equipment/:sn/mower-ip — sla maaier IP op voor SSH upload
dashboardRouter.patch('/equipment/:sn/mower-ip', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { ip } = req.body as { ip: string };
  if (!ip || typeof ip !== 'string') { res.status(400).json({ error: 'ip required' }); return; }
  const result = db.prepare('UPDATE equipment SET mower_ip = ? WHERE mower_sn = ?').run(ip.trim(), sn);
  if (result.changes === 0) { res.status(404).json({ error: 'Maaier niet gevonden in equipment' }); return; }
  res.json({ ok: true });
});

// GET /api/dashboard/devices/:sn — enkel device met volledige state
dashboardRouter.get('/devices/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const snapshot = getDeviceSnapshot(sn) ?? {};

  res.json({
    sn,
    online: isDeviceOnline(sn) || isDemoMode(sn),
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

  // Charger GPS per maaier ophalen voor local→GPS conversie
  const chargerCache = new Map<string, GpsPoint | null>();
  function getChargerGps(mowerSn: string): GpsPoint | null {
    if (chargerCache.has(mowerSn)) return chargerCache.get(mowerSn)!;
    const cal = db.prepare('SELECT charger_lat, charger_lng FROM map_calibration WHERE mower_sn = ?')
      .get(mowerSn) as { charger_lat: number | null; charger_lng: number | null } | undefined;
    const result = cal?.charger_lat && cal?.charger_lng
      ? { lat: cal.charger_lat, lng: cal.charger_lng } : null;
    chargerCache.set(mowerSn, result);
    return result;
  }

  const maps = rows.map(r => {
    let mapArea: GpsPoint[] = [];
    let mapMaxMin: Record<string, number> | null = null;

    if (r.map_area) {
      const chargerGps = getChargerGps(r.mower_sn);
      if (chargerGps) {
        const localPoints: LocalPoint[] = JSON.parse(r.map_area);
        mapArea = localPoints.map(p => localToGps(p, chargerGps));
        const lats = mapArea.map(p => p.lat);
        const lngs = mapArea.map(p => p.lng);
        mapMaxMin = {
          minLat: Math.min(...lats), maxLat: Math.max(...lats),
          minLng: Math.min(...lngs), maxLng: Math.max(...lngs),
        };
      }
    }

    return {
      mapId: r.map_id,
      mowerSn: r.mower_sn,
      mapName: r.map_name,
      mapType: r.map_type ?? 'work',
      mapArea,
      mapMaxMin,
      createdAt: r.created_at,
    };
  });

  res.json({ maps });
});

// GET /api/dashboard/maps/:sn — kaarten voor een maaier
// Retourneert lokale meter coördinaten (charger = 0,0) + charger GPS voor conversie.
// ?coords=gps forceert GPS output (voor Leaflet dashboard).
dashboardRouter.get('/maps/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const wantGps = req.query.coords === 'gps';
  const rows = db.prepare(
    'SELECT * FROM maps WHERE mower_sn = ? ORDER BY updated_at DESC'
  ).all(sn) as MapRow[];

  // Charger GPS ophalen
  const cal = db.prepare('SELECT charger_lat, charger_lng FROM map_calibration WHERE mower_sn = ?')
    .get(sn) as { charger_lat: number | null; charger_lng: number | null } | undefined;
  const chargerGps: GpsPoint | null = cal?.charger_lat && cal?.charger_lng
    ? { lat: cal.charger_lat, lng: cal.charger_lng } : null;

  const maps = rows.map(r => {
    let mapArea: Array<{ x: number; y: number } | GpsPoint> = [];
    let mapMaxMin: Record<string, number> | null = null;

    if (r.map_area) {
      const localPoints: LocalPoint[] = JSON.parse(r.map_area);

      if (wantGps && chargerGps) {
        // GPS output voor Leaflet dashboard
        const gpsPoints = localPoints.map(p => localToGps(p, chargerGps));
        mapArea = gpsPoints;
        const lats = gpsPoints.map(p => p.lat);
        const lngs = gpsPoints.map(p => p.lng);
        mapMaxMin = {
          minLat: Math.min(...lats), maxLat: Math.max(...lats),
          minLng: Math.min(...lngs), maxLng: Math.max(...lngs),
        };
      } else {
        // Lokale meters (default) — charger = (0,0)
        mapArea = localPoints;
        const xs = localPoints.map(p => p.x);
        const ys = localPoints.map(p => p.y);
        mapMaxMin = {
          minX: Math.min(...xs), maxX: Math.max(...xs),
          minY: Math.min(...ys), maxY: Math.max(...ys),
        };
      }
    }

    return {
      mapId: r.map_id,
      mapName: r.map_name,
      mapType: r.map_type ?? 'work',
      mapArea,
      mapMaxMin,
      createdAt: r.created_at,
    };
  });

  // Charger orientatie uit ZIP map_info.json
  let chargerOrientation = 0;
  const STORAGE_PATH = path.resolve(process.env.STORAGE_PATH ?? './storage', 'maps');
  const latestZip = path.join(STORAGE_PATH, `${sn}_latest.zip`);
  if (fs.existsSync(latestZip)) {
    try {
      const tmpDir = path.join(STORAGE_PATH, `tmp_orient_${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        execSync(`unzip -o -q "${latestZip}" "csv_file/map_info.json" -d "${tmpDir}"`);
        const infoPath = path.join(tmpDir, 'csv_file', 'map_info.json');
        if (fs.existsSync(infoPath)) {
          const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
          chargerOrientation = info.charging_pose?.orientation ?? 0;
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }

  res.json({
    maps,
    chargerGps: chargerGps ? { lat: chargerGps.lat, lng: chargerGps.lng } : null,
    chargerOrientation,
  });
});

// GET /api/dashboard/trail/:sn — trail punten voor de kaart
// ?coords=local retourneert lokale meters (default), ?coords=gps retourneert GPS
dashboardRouter.get('/trail/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  if (req.query.coords === 'gps') {
    res.json({ trail: getGpsTrail(sn) });
  } else {
    res.json({ trail: getLocalTrail(sn) });
  }
});

// DELETE /api/dashboard/trail/:sn — wis trail
dashboardRouter.delete('/trail/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  clearGpsTrail(sn);
  clearLocalTrail(sn);
  res.json({ ok: true });
});

// GET /api/dashboard/planned-path/:sn — planned mowing path
// Requests via MQTT: {get_map_plan_path: {map_name: "all"}}
// Response cached from get_map_plan_path_respond
// Returns array of sub-paths, each being an array of {x, y} local meter points
const plannedPathCache = new Map<string, Array<{ id: string; points: Array<{ x: number; y: number }> }>>();

dashboardRouter.get('/planned-path/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const cached = plannedPathCache.get(sn);
  if (cached && cached.length > 0) {
    res.json({ paths: cached });
  } else {
    // Request from mower via MQTT (only works while mowing)
    if (isDeviceOnline(sn)) {
      publishToDevice(sn, { get_map_plan_path: { map_name: 'all' } });
      console.log(`[PLAN-PATH] Requested get_map_plan_path from ${sn}`);
    }
    res.json({ paths: [] });
  }
});

/** Parse and cache planned path from MQTT respond or file */
export function handlePlannedPathRespond(sn: string, data: Record<string, unknown>): void {
  try {
    const paths: Array<{ id: string; points: Array<{ x: number; y: number }> }> = [];
    // Format: {"1": {"0": "x y,x y,...", "100": "x y,..."}}
    for (const mapKey of Object.keys(data)) {
      const subPaths = data[mapKey];
      if (typeof subPaths !== 'object' || !subPaths) continue;
      for (const subKey of Object.keys(subPaths as Record<string, string>)) {
        const pointsStr = (subPaths as Record<string, string>)[subKey];
        if (typeof pointsStr !== 'string') continue;
        const points = pointsStr.split(',').map(p => {
          const parts = p.trim().split(/\s+/).map(Number);
          return { x: parts[0], y: parts[1] };
        }).filter(p => !isNaN(p.x) && !isNaN(p.y));
        if (points.length >= 2) {
          paths.push({ id: `${mapKey}_${subKey}`, points });
        }
      }
    }
    plannedPathCache.set(sn, paths);
    console.log(`[PLAN-PATH] Cached ${paths.length} sub-paths for ${sn}`);
  } catch (err) {
    console.error(`[PLAN-PATH] Parse error:`, err);
  }
}

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

  // Charger GPS nodig voor GPS→lokaal conversie
  const cal = db.prepare('SELECT charger_lat, charger_lng FROM map_calibration WHERE mower_sn = ?')
    .get(sn) as { charger_lat: number | null; charger_lng: number | null } | undefined;
  if (!cal?.charger_lat || !cal?.charger_lng) {
    res.status(400).json({ error: 'Charger positie onbekend — plaats eerst de charger op de kaart' });
    return;
  }
  const chargerGps: GpsPoint = { lat: cal.charger_lat, lng: cal.charger_lng };

  // Converteer GPS→lokaal vóór opslag
  const localPoints = mapArea.map(p => gpsToLocal(p, chargerGps));
  const bounds = {
    minX: Math.min(...localPoints.map(p => p.x)),
    maxX: Math.max(...localPoints.map(p => p.x)),
    minY: Math.min(...localPoints.map(p => p.y)),
    maxY: Math.max(...localPoints.map(p => p.y)),
  };

  const typeSlug = mapType && ['work', 'obstacle', 'unicom'].includes(mapType) ? mapType : 'work';
  const mapId = `dashboard_${typeSlug}_${Date.now()}`;

  db.prepare(`
    INSERT INTO maps (map_id, mower_sn, map_name, map_type, map_area, map_max_min, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(mapId, sn, mapName ?? null, typeSlug, JSON.stringify(localPoints), JSON.stringify(bounds));

  res.json({
    ok: true,
    map: {
      mapId,
      mapName: mapName ?? null,
      mapType: typeSlug,
      mapArea,        // Retourneer GPS voor frontend (ongewijzigd)
      mapMaxMin: {    // GPS bounds voor frontend
        minLat: Math.min(...mapArea.map(p => p.lat)), maxLat: Math.max(...mapArea.map(p => p.lat)),
        minLng: Math.min(...mapArea.map(p => p.lng)), maxLng: Math.max(...mapArea.map(p => p.lng)),
      },
      createdAt: new Date().toISOString(),
    },
  });

  // Auto-push naar maaier in de achtergrond
  autoPushMapsInBackground(sn);
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

  // Update polygon punten als meegegeven — converteer GPS→lokaal
  if (mapArea && Array.isArray(mapArea) && mapArea.length >= 3) {
    const cal = db.prepare('SELECT charger_lat, charger_lng FROM map_calibration WHERE mower_sn = ?')
      .get(sn) as { charger_lat: number | null; charger_lng: number | null } | undefined;
    if (!cal?.charger_lat || !cal?.charger_lng) {
      res.status(400).json({ error: 'Charger positie onbekend' });
      return;
    }
    const chargerGps: GpsPoint = { lat: cal.charger_lat, lng: cal.charger_lng };
    const localPoints = mapArea.map(p => gpsToLocal(p, chargerGps));
    const bounds = {
      minX: Math.min(...localPoints.map(p => p.x)),
      maxX: Math.max(...localPoints.map(p => p.x)),
      minY: Math.min(...localPoints.map(p => p.y)),
      maxY: Math.max(...localPoints.map(p => p.y)),
    };
    db.prepare('UPDATE maps SET map_area = ?, map_max_min = ?, updated_at = datetime(\'now\') WHERE map_id = ? AND mower_sn = ?')
      .run(JSON.stringify(localPoints), JSON.stringify(bounds), mapId, sn);
  }

  // Update naam als meegegeven
  if (mapName !== undefined) {
    db.prepare('UPDATE maps SET map_name = ?, updated_at = datetime(\'now\') WHERE map_id = ? AND mower_sn = ?')
      .run(mapName ?? null, mapId, sn);
  }

  res.json({ ok: true });

  // Auto-push naar maaier als polygon is gewijzigd
  if (mapArea) autoPushMapsInBackground(sn);
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

  // Auto-push naar maaier (bijgewerkte kaarten zonder de verwijderde)
  autoPushMapsInBackground(sn);
});

// ── Map converter endpoints ──────────────────────────────────────

// POST /api/dashboard/maps/:sn/export-zip — genereer Novabot-compatibel ZIP van kaarten
dashboardRouter.post('/maps/:sn/export-zip', (req: Request, res: Response) => {
  const { sn } = req.params;
  const body = req.body as {
    chargingOrientation?: number;
  };

  try {
    const zipPath = generateMapZipFromDb(
      sn,
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

// ── UTM conversie voor pos.json ──────────────────────────────────────────────
function generatePosJson(charger: GpsPoint): Record<string, unknown> {
  const { lat, lng } = charger;
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const e2 = 2 * f - f * f;
  const ePrime2 = e2 / (1 - e2);
  const k0 = 0.9996;

  const zone = Math.floor((lng + 180) / 6) + 1;
  const lng0 = (zone - 1) * 6 - 180 + 3;

  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;
  const lng0Rad = (lng0 * Math.PI) / 180;

  const N = a / Math.sqrt(1 - e2 * Math.sin(latRad) ** 2);
  const T = Math.tan(latRad) ** 2;
  const C = ePrime2 * Math.cos(latRad) ** 2;
  const A = Math.cos(latRad) * (lngRad - lng0Rad);

  const M = a * (
    (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * latRad
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * latRad)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * latRad)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * latRad)
  );

  const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T ** 2 + 72 * C - 58 * ePrime2) * A ** 5 / 120) + 500000;
  const y = k0 * (M + N * Math.tan(latRad) * (A ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24 + (61 - 58 * T + T ** 2 + 600 * C - 330 * ePrime2) * A ** 6 / 720));

  return {
    time_stamp: Date.now() / 1000,
    utm_origin: { utm_zone: zone, x, y, z: 0 },
    wgs84_origin: { latitude: lat, longitude: lng },
  };
}

// ── Auto-push kaarten naar maaier (fire-and-forget) ─────────────────────────
// Wordt aangeroepen na map create/update/delete zodat de maaier altijd up-to-date is.
// Zoekt zelf de charger GPS op via dezelfde fallback chain als de endpoint.
function autoPushMapsInBackground(sn: string): void {
  // Zoek charger GPS: live cache → map_calibration
  let chargerGps: GpsPoint | null = null;

  const eqRow = db.prepare('SELECT charger_sn FROM equipment WHERE mower_sn = ?').get(sn) as { charger_sn: string | null } | undefined;
  if (eqRow?.charger_sn) {
    const snap = getDeviceSnapshot(eqRow.charger_sn);
    const lat = parseFloat(snap?.latitude ?? '');
    const lng = parseFloat(snap?.longitude ?? '');
    if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
      chargerGps = { lat, lng };
    }
  }
  if (!chargerGps) {
    const cal = db.prepare('SELECT charger_lat, charger_lng FROM map_calibration WHERE mower_sn = ?').get(sn) as { charger_lat: number | null; charger_lng: number | null } | undefined;
    if (cal?.charger_lat && cal?.charger_lng) {
      chargerGps = { lat: cal.charger_lat, lng: cal.charger_lng };
    }
  }
  // Fallback: maaier GPS (staat waarschijnlijk op charger)
  if (!chargerGps) {
    const mowerSnap = getDeviceSnapshot(sn);
    const lat = parseFloat(mowerSnap?.latitude ?? '');
    const lng = parseFloat(mowerSnap?.longitude ?? '');
    if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
      chargerGps = { lat, lng };
    }
  }

  if (!chargerGps) {
    console.log(`[AUTO-PUSH] Geen charger GPS beschikbaar voor ${sn}, skip push`);
    return;
  }

  // Controleer of maaier IP bekend is
  const ipRow = db.prepare(
    `SELECT e.mower_ip, d.ip_address as detected_ip
     FROM equipment e
     LEFT JOIN device_registry d ON d.sn = e.mower_sn AND d.ip_address IS NOT NULL
     WHERE e.mower_sn = ?
     ORDER BY d.last_seen DESC LIMIT 1`
  ).get(sn) as { mower_ip: string | null; detected_ip: string | null } | undefined;

  const isPrivateIp = (addr: string) =>
    /^10\./.test(addr) || /^172\.(1[6-9]|2\d|3[01])\./.test(addr) || /^192\.168\./.test(addr);
  const ip = ipRow?.mower_ip
    ?? (ipRow?.detected_ip && isPrivateIp(ipRow.detected_ip) ? ipRow.detected_ip : null);

  if (!ip) {
    console.log(`[AUTO-PUSH] Maaier IP onbekend voor ${sn}, skip push`);
    return;
  }

  // Fire-and-forget: roep push-to-mower endpoint aan via interne fetch
  const port = process.env.PORT ?? '3000';
  const url = `http://127.0.0.1:${port}/api/dashboard/maps/${encodeURIComponent(sn)}/push-to-mower`;
  console.log(`[AUTO-PUSH] Trigger push naar maaier ${sn} (${ip})...`);
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chargingStation: chargerGps }),
  }).then(r => {
    if (r.ok) console.log(`[AUTO-PUSH] Kaarten gepusht naar ${sn}`);
    else r.text().then(t => console.warn(`[AUTO-PUSH] Push mislukt voor ${sn}: ${t}`));
  }).catch(err => console.warn(`[AUTO-PUSH] Push fout voor ${sn}:`, err));
}

// POST /api/dashboard/maps/:sn/push-to-mower — upload kaarten via SSH/SFTP naar de maaier
dashboardRouter.post('/maps/:sn/push-to-mower', async (req: Request, res: Response) => {
  const { sn } = req.params;
  const body = req.body as { chargingStation?: GpsPoint; chargingOrientation?: number };

  // Haal maaier IP op:
  // 1. Handmatig geconfigureerd in equipment.mower_ip (altijd bruikbaar)
  // 2. Auto-detect uit device_registry.ip_address — alleen als het een privé-IP is
  //    (niet in Docker: Docker NATt alles naar een publiek CDN-IP)
  const isPrivateIp = (addr: string) =>
    /^10\./.test(addr) || /^172\.(1[6-9]|2\d|3[01])\./.test(addr) || /^192\.168\./.test(addr);

  const ipRow = db.prepare(
    `SELECT e.mower_ip, d.ip_address as detected_ip
     FROM equipment e
     LEFT JOIN device_registry d ON d.sn = e.mower_sn AND d.ip_address IS NOT NULL
     WHERE e.mower_sn = ?
     ORDER BY d.last_seen DESC LIMIT 1`
  ).get(sn) as { mower_ip: string | null; detected_ip: string | null } | undefined;

  const ip = ipRow?.mower_ip
    ?? (ipRow?.detected_ip && isPrivateIp(ipRow.detected_ip) ? ipRow.detected_ip : null);

  if (!ip) {
    res.status(404).json({ error: 'Maaier IP onbekend — stel het in via het apparaat paneel (klik op de maaier chip → SSH IP veld)' });
    return;
  }
  console.log(`[SSH] Maaier IP: ${ip} (${ipRow?.mower_ip ? 'handmatig' : 'auto-detect'}`);

  // Haal laadstation GPS op — prioriteit: live sensor cache → map_calibration → request body
  let chargingStation = body.chargingStation;

  if (!chargingStation?.lat || !chargingStation?.lng) {
    // 1. Zoek de charger SN die bij deze maaier hoort
    const eqRow = db.prepare('SELECT charger_sn FROM equipment WHERE mower_sn = ?').get(sn) as { charger_sn: string | null } | undefined;
    if (eqRow?.charger_sn) {
      const snap = getDeviceSnapshot(eqRow.charger_sn);
      const lat = parseFloat(snap?.latitude ?? '');
      const lng = parseFloat(snap?.longitude ?? '');
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        chargingStation = { lat, lng };
        console.log(`[SSH] Charger GPS uit live cache: ${lat}, ${lng} (${eqRow.charger_sn})`);
      }
    }
  }

  if (!chargingStation?.lat || !chargingStation?.lng) {
    // 2. Fallback: handmatig ingevoerde charger positie uit map_calibration
    const cal = db.prepare('SELECT charger_lat, charger_lng FROM map_calibration WHERE mower_sn = ?').get(sn) as { charger_lat: number | null; charger_lng: number | null } | undefined;
    if (cal?.charger_lat && cal?.charger_lng) {
      chargingStation = { lat: cal.charger_lat, lng: cal.charger_lng };
      console.log(`[SSH] Charger GPS uit map_calibration: ${cal.charger_lat}, ${cal.charger_lng}`);
    }
  }

  if (!chargingStation?.lat || !chargingStation?.lng) {
    res.status(400).json({ error: 'Laadstation GPS onbekend — laadstation moet online zijn of handmatig geplaatst worden op de kaart' });
    return;
  }

  // Genereer ZIP
  let zipPath: string | null;
  try {
    zipPath = generateMapZipFromDb(sn, body.chargingOrientation ?? 0);
  } catch (err) {
    res.status(500).json({ error: `ZIP generatie mislukt: ${err}` });
    return;
  }
  if (!zipPath) {
    // Geen kaarten meer — verwijder ALLE kaartbestanden op de maaier
    // 1. Stuur MQTT delete_map om in-memory kaartdata in novabot_mapping te wissen
    publishToDevice(sn, { delete_map: { map_name: 'map0', map_type: 0 } });
    console.log(`[DELETE] MQTT delete_map gestuurd naar ${sn}`);

    // 2. Verwijder alle bestanden in de map directory via SSH
    //    (map0.pgm, map0.yaml, map0.png, *.zip, csv_file/, x3_csv_file/, covered_path/, planned_path/)
    try {
      const { Client } = await import('ssh2');
      const cleanOp = new Promise<void>((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
          const cmd = 'rm -rf /userdata/lfi/maps/home0/*';
          conn.exec(cmd, (err, stream) => {
            if (err) { conn.end(); reject(err); return; }
            stream.on('close', () => { conn.end(); resolve(); });
            stream.on('data', () => {});
            stream.stderr.on('data', () => {});
          });
        });
        conn.on('error', reject);
        conn.connect({ host: ip, port: 22, username: 'root', password: 'novabot', readyTimeout: 8000 });
      });
      await Promise.race([cleanOp, new Promise<void>((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))]);
      console.log(`[SSH] Alle kaartbestanden verwijderd op maaier ${sn}`);
    } catch (err) {
      console.warn(`[SSH] Kon kaartbestanden niet verwijderen op maaier:`, err);
    }
    // Verwijder ook _latest.zip
    try {
      const mapsStorage = path.resolve(process.env.STORAGE_PATH ?? './storage', 'maps');
      const latestZip = path.join(mapsStorage, `${sn}_latest.zip`);
      if (existsSync(latestZip)) unlinkSync(latestZip);
    } catch { /* ignore */ }
    res.json({ ok: true, cleared: true });
    return;
  }

  // Bewaar een kopie als _latest.zip zodat de app de kaart kan ophalen via queryEquipmentMap
  try {
    const mapsStorage = path.resolve(process.env.STORAGE_PATH ?? './storage', 'maps');
    mkdirSync(mapsStorage, { recursive: true });
    copyFileSync(zipPath, path.join(mapsStorage, `${sn}_latest.zip`));
    console.log(`[SSH] ZIP kopie opgeslagen als ${sn}_latest.zip voor queryEquipmentMap`);
  } catch (err) {
    console.warn(`[SSH] Kon ZIP kopie niet opslaan:`, err);
  }

  // SSH verbinding en SFTP upload
  try {
    const { Client } = await import('ssh2');
    const safeZipPath = zipPath as string;

    const sshOp = new Promise<void>((resolve, reject) => {
      const conn = new Client();

      conn.on('ready', () => {
        console.log(`[SSH] Verbonden met ${ip}, start SFTP`);
        // 1. Upload ZIP via SFTP
        conn.sftp((sftpErr, sftp) => {
          if (sftpErr) { conn.end(); reject(sftpErr); return; }
          console.log(`[SSH] SFTP subsystem gereed, start upload`);

          const remote = '/tmp/novabot_maps.zip';
          const writeStream = sftp.createWriteStream(remote);
          const readStream = createReadStream(safeZipPath);

          // Gebruik een flag: 'close' én 'finish' kunnen allebei vuren, run maar één keer
          let cmdStarted = false;
          const runCmd = () => {
            if (cmdStarted) return;
            cmdStarted = true;
            console.log(`[SSH] Upload klaar, start unzip commando`);
            // 2. Verwijder oude kaarten en pak ZIP uit naar BEIDE directories
            // csv_file = app-formaat (voor upload/download)
            // x3_csv_file = intern formaat (novabot_mapping leest hieruit voor coverage tasks)
            // 2b. Genereer pos.json (UTM referentie) zodat localization GPS→lokaal kan mappen
            const posJson = generatePosJson(chargingStation!);
            const posJsonEscaped = JSON.stringify(posJson).replace(/'/g, "'\\''");
            const cmd = [
              'rm -rf /userdata/lfi/maps/home0/csv_file',
              'rm -rf /userdata/lfi/maps/home0/x3_csv_file',
              `unzip -o -q ${remote} -d /userdata/lfi/maps/home0`,
              'cp -r /userdata/lfi/maps/home0/csv_file /userdata/lfi/maps/home0/x3_csv_file',
              `rm ${remote}`,
              `echo '${posJsonEscaped}' > /userdata/pos.json`,
            ].join(' && ');

            conn.exec(cmd, (execErr, stream) => {
              if (execErr) { conn.end(); reject(execErr); return; }
              let stderr = '';
              stream.on('data', () => { /* drain stdout */ });
              stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
              stream.on('close', (code: number) => {
                console.log(`[SSH] Unzip klaar, exit code: ${code}`);
                if (code !== 0) {
                  conn.end();
                  reject(new Error(`SSH commando mislukt (code ${code}): ${stderr}`));
                  return;
                }

                // 3. Herstart alleen novabot_mapping (niet hele maaier rebooten!)
                // novabot_mapping leest map_info.json bij start en publiceert
                // generate_map_file_name naar mqtt_node via CycloneDDS/loopback.
                console.log(`[SSH] Herstart novabot_mapping...`);
                const restartCmd = [
                  '(pkill -f "novabot_mapping_launch.py" || true)',
                  'sleep 1',
                  '(killall -9 novabot_mapping 2>/dev/null || true)',
                  'sleep 1',
                  '. /opt/ros/galactic/setup.bash',
                  '. /root/novabot/install/setup.bash',
                  'export LD_LIBRARY_PATH=/usr/lib/hbmedia/:/usr/lib/hbbpu/:/usr/lib/sensorlib:$LD_LIBRARY_PATH',
                  'export LD_LIBRARY_PATH=/usr/local/lib:/usr/lib/aarch64-linux-gnu:/usr/bpu:/usr/opencv_world_4.6/lib:$LD_LIBRARY_PATH',
                  'export ROS_LOG_DIR=/root/novabot/data/ros2_log',
                  'export ROS_LOCALHOST_ONLY=1',
                  'nohup ros2 launch novabot_mapping novabot_mapping_launch.py >> $ROS_LOG_DIR/novabot_mapping_restart.log 2>&1 </dev/null &',
                ].join(' && ');

                conn.exec(restartCmd, (restartErr, restartStream) => {
                  if (restartErr) {
                    console.error(`[SSH] Restart exec fout: ${restartErr.message}`);
                    conn.end();
                    resolve(); // Upload was succesvol, restart is bonus
                    return;
                  }
                  restartStream.on('data', () => {});
                  restartStream.stderr.on('data', () => {});
                  restartStream.on('close', () => {
                    console.log(`[SSH] novabot_mapping herstart geïnitieerd`);
                    conn.end();
                    resolve();
                  });
                });
              });
            });
          };

          // ssh2 SFTP WriteStream emits 'close' of 'finish' afhankelijk van versie
          writeStream.once('close', runCmd);
          writeStream.once('finish', runCmd);
          writeStream.on('error', (e: Error) => { conn.end(); reject(e); });
          readStream.on('error', (e: Error) => { conn.end(); reject(e); });
          readStream.pipe(writeStream);
        });
      });

      conn.on('error', reject);

      conn.connect({
        host: ip,
        port: 22,
        username: 'root',
        password: 'novabot',
        readyTimeout: 8000,
      });
    });

    // Voeg een overall timeout toe zodat de request nooit eeuwig hangt
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('SSH upload timeout (35s)')), 35000)
    );
    await Promise.race([sshOp, timeout]);

    // Na ~5s herstart novabot_mapping en publiceert map data naar mqtt_node.
    // Stuur na 8s een get_map_list om de nieuwe kaarten op te halen.
    setTimeout(() => requestMapList(sn), 8000);

    // Maaier staat op het laadstation — sla huidige positie op als charger positie
    setTimeout(() => {
      publishToDevice(sn, { save_recharge_pos: { mapName: 'map0', map0: '', cmd_num: getNextCmdNum(sn) } });
      console.log(`[SSH] save_recharge_pos gestuurd naar ${sn} (maaier op charger)`);
    }, 10000);

    console.log(`[SSH] Kaarten geüpload + novabot_mapping herstart op ${sn} (${ip})`);
    res.json({ ok: true, ip, sn });
  } catch (err) {
    console.error(`[SSH] Upload mislukt naar ${sn} (${ip}):`, err);
    res.status(500).json({ error: `SSH upload mislukt: ${err instanceof Error ? err.message : err}` });
  }
});

// POST /api/dashboard/maps/:sn/dock-and-save — stuur maaier naar station (go_to_charge + ArUco)
// en sla charger positie op zodra de maaier gedockt is.
// Gebruikt na autonomous mapping: maaier staat in het veld, moet terug naar station.
dashboardRouter.post('/maps/:sn/dock-and-save', (req: Request, res: Response) => {
  const { sn } = req.params;
  const MAX_WAIT = 5 * 60 * 1000; // 5 min
  const POLL_INTERVAL = 5000;
  const start = Date.now();

  // Stuur go_to_charge — maaier navigeert via GPS + ArUco QR scan voor final approach
  publishToDevice(sn, goToChargePayload(sn));
  console.log(`[CHARGER] go_to_charge gestuurd naar ${sn}, wacht op docking...`);

  const check = () => {
    const snap = getDeviceSnapshot(sn);
    const state = snap?.battery_state;
    if (state === 'CHARGING' || state === 'FULL') {
       publishToDevice(sn, { save_recharge_pos: { mapName: 'map0', map0: '', cmd_num: getNextCmdNum(sn) } });
      console.log(`[CHARGER] Maaier ${sn} gedockt, save_recharge_pos gestuurd`);
      res.json({ ok: true, waited: Date.now() - start });
      return;
    }
    if (Date.now() - start > MAX_WAIT) {
      console.warn(`[CHARGER] Timeout: maaier ${sn} niet op station na ${MAX_WAIT / 1000}s`);
      res.json({ ok: false, error: 'timeout', waited: MAX_WAIT });
      return;
    }
    setTimeout(check, POLL_INTERVAL);
  };
  // Geef maaier 3s om te beginnen met navigeren
  setTimeout(check, 3000);
});

// POST /api/dashboard/maps/:sn/calibrate-charger — ArUco kalibratie
// Maaier staat op station → start_run undockt (enige commando dat werkt) →
// stop_run stopt maaien → go_to_charge keert terug via GPS + ArUco.
// Geteste alternatieven die NIET werken terwijl docked:
//   - start_move: firmware blokkeert handmatige besturing op laadstation
//   - start_navigation: crasht ROS nav stack (localization niet geïnitialiseerd)
//   - start_assistant_build_map: commando ontvangen maar maaier beweegt niet
// start_run is het ENIGE commando dat de maaier van het dock laat rijden.
// Mesjes draaien ~5s maar dat is onvermijdelijk.
dashboardRouter.post('/maps/:sn/calibrate-charger', (req: Request, res: Response) => {
  const { sn } = req.params;

  // Zoek een beschikbare map voor start_run
  const mapRow = db.prepare(
    `SELECT map_name FROM maps WHERE mower_sn = ? AND map_type = 'work' LIMIT 1`
  ).get(sn) as { map_name: string } | undefined;
  const mapName = mapRow?.map_name || 'map0';

  // 1. Save huidige positie als charger (maaier staat op station)
  publishToDevice(sn, { save_recharge_pos: { mapName, map0: '', cmd_num: getNextCmdNum(sn) } });
  console.log(`[CALIBRATE] save_recharge_pos gestuurd naar ${sn}`);

  // 2. start_run — maaier undockt automatisch (enige werkende methode)
  setTimeout(() => {
    publishToDevice(sn, {
      start_run: {
        mapName,
        cutGrassHeight: 5,
        workArea: mapName,
        startWay: 'app',
        schedule: false,
        scheduleId: '',
        mapNames: [mapName]
      }
    });
    console.log(`[CALIBRATE] start_run gestuurd naar ${sn} (map: ${mapName}) — maaier undockt`);

    // 3. Na 8s: stop maaien (maaier is ~1m van dock, mesjes stoppen)
    setTimeout(() => {
      publishToDevice(sn, { stop_run: {} });
      console.log(`[CALIBRATE] stop_run naar ${sn}, wacht 3s...`);

      // 4. Na 3s: terug naar charger via go_to_charge (GPS + ArUco scan)
      setTimeout(() => {
        publishToDevice(sn, goToChargePayload(sn));
        console.log(`[CALIBRATE] go_to_charge naar ${sn} — ArUco scan tijdens return`);
      }, 3000);
    }, 8000);
  }, 1000);

  res.json({ ok: true });
});

// POST /api/dashboard/maps/:sn/import-zip — importeer kaarten uit een Novabot ZIP
dashboardRouter.post('/maps/:sn/import-zip', (req: Request, res: Response) => {
  const { sn } = req.params;
  const body = req.body as {
    zipPath?: string;
  };

  if (!body.zipPath) {
    res.status(400).json({ error: 'zipPath is vereist' });
    return;
  }

  try {
    const result = parseMapZip(body.zipPath);
    if (!result) {
      res.status(400).json({ error: 'Kon ZIP niet parsen' });
      return;
    }

    // Sla werkgebieden op — lokale coördinaten direct uit CSV
    let imported = 0;
    for (const area of result.areas) {
      if (area.type !== 'work') continue;

      const mapId = `imported_map${area.mapIndex}_${Date.now()}`;
      const points = area.points;
      const bounds = {
        minX: Math.min(...points.map(p => p.x)),
        maxX: Math.max(...points.map(p => p.x)),
        minY: Math.min(...points.map(p => p.y)),
        maxY: Math.max(...points.map(p => p.y)),
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

// POST /api/dashboard/maps/:sn/upload-zip — upload + import kaarten uit base64 ZIP
dashboardRouter.post('/maps/:sn/upload-zip', async (req: Request, res: Response) => {
  const { sn } = req.params;
  const { data } = req.body as { data?: string }; // base64 encoded ZIP

  if (!data) {
    res.status(400).json({ error: 'data (base64 ZIP) is vereist' });
    return;
  }

  try {
    const tmpPath = `/tmp/map_upload_${sn}_${Date.now()}.zip`;
    const { writeFileSync, unlinkSync } = await import('fs');
    writeFileSync(tmpPath, Buffer.from(data, 'base64'));

    const result = parseMapZip(tmpPath);
    unlinkSync(tmpPath); // cleanup

    if (!result) {
      res.status(400).json({ error: 'Kon ZIP niet parsen' });
      return;
    }

    let imported = 0;
    for (const area of result.areas) {
      if (area.type !== 'work') continue;
      const mapId = `uploaded_map${area.mapIndex}_${Date.now()}`;
      const points = area.points;
      const bounds = {
        minX: Math.min(...points.map((p: any) => p.x)),
        maxX: Math.max(...points.map((p: any) => p.x)),
        minY: Math.min(...points.map((p: any) => p.y)),
        maxY: Math.max(...points.map((p: any) => p.y)),
      };

      db.prepare(`
        INSERT INTO maps (map_id, mower_sn, map_name, map_area, map_max_min, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(map_id) DO UPDATE SET
          map_area = excluded.map_area,
          map_max_min = excluded.map_max_min,
          updated_at = datetime('now')
      `).run(mapId, sn, `Uploaded map ${area.mapIndex}`, JSON.stringify(points), JSON.stringify(bounds));
      imported++;
    }

    // Also import obstacles
    for (const area of result.areas) {
      if (area.type === 'work') continue;
      const mapId = `uploaded_${area.type}${area.mapIndex}_${Date.now()}`;
      db.prepare(`
        INSERT INTO maps (map_id, mower_sn, map_name, map_type, map_area, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(map_id) DO UPDATE SET
          map_area = excluded.map_area, updated_at = datetime('now')
      `).run(mapId, sn, `${area.type} ${area.mapIndex}`, area.type, JSON.stringify(area.points));
      imported++;
    }

    console.log(`[MAP-IMPORT] Uploaded ZIP for ${sn}: ${imported} areas imported`);
    res.json({ ok: true, imported, totalAreas: result.areas.length, chargingPose: result.chargingPose });
  } catch (err) {
    res.status(500).json({ error: 'Upload import mislukt', details: String(err) });
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
  gps_charger_lat: number | null;
  gps_charger_lng: number | null;
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
          chargerLat: row.charger_lat, chargerLng: row.charger_lng,
          gpsChargerLat: row.gps_charger_lat, gpsChargerLng: row.gps_charger_lng }
      : { offsetLat: 0, offsetLng: 0, rotation: 0, scale: 1,
          chargerLat: null, chargerLng: null, gpsChargerLat: null, gpsChargerLng: null },
  });
});

// PUT /api/dashboard/calibration/:sn — sla calibratie op
// relocateCharger=true: charger fysiek verplaatst → herbereken alle map lokale coördinaten
dashboardRouter.put('/calibration/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { offsetLat, offsetLng, rotation, scale, chargerLat, chargerLng,
    gpsChargerLat, gpsChargerLng, relocateCharger } = req.body as {
    offsetLat?: number;
    offsetLng?: number;
    rotation?: number;
    scale?: number;
    chargerLat?: number | null;
    chargerLng?: number | null;
    gpsChargerLat?: number | null;
    gpsChargerLng?: number | null;
    relocateCharger?: boolean;
  };

  // Als relocateCharger=true EN er is een oude + nieuwe charger positie:
  // herbereken alle map_area van local(old) → GPS → local(new)
  let mapsRecalculated = 0;
  if (relocateCharger && chargerLat != null && chargerLng != null) {
    const oldCal = db.prepare('SELECT charger_lat, charger_lng FROM map_calibration WHERE mower_sn = ?')
      .get(sn) as { charger_lat: number | null; charger_lng: number | null } | undefined;

    if (oldCal?.charger_lat != null && oldCal?.charger_lng != null) {
      const oldOrigin: GpsPoint = { lat: oldCal.charger_lat, lng: oldCal.charger_lng };
      const newOrigin: GpsPoint = { lat: chargerLat, lng: chargerLng };

      const allMaps = db.prepare(
        'SELECT map_id, map_area FROM maps WHERE mower_sn = ? AND map_area IS NOT NULL'
      ).all(sn) as Array<{ map_id: string; map_area: string }>;

      const updateStmt = db.prepare(
        'UPDATE maps SET map_area = ?, map_max_min = ?, updated_at = datetime(\'now\') WHERE map_id = ?'
      );

      for (const row of allMaps) {
        try {
          const oldLocal: LocalPoint[] = JSON.parse(row.map_area);
          if (!Array.isArray(oldLocal) || oldLocal.length < 2) continue;

          // local(old charger) → GPS → local(new charger)
          const newLocal = oldLocal.map(p => gpsToLocal(localToGps(p, oldOrigin), newOrigin));
          const bounds = {
            minX: Math.min(...newLocal.map(p => p.x)),
            maxX: Math.max(...newLocal.map(p => p.x)),
            minY: Math.min(...newLocal.map(p => p.y)),
            maxY: Math.max(...newLocal.map(p => p.y)),
          };
          updateStmt.run(JSON.stringify(newLocal), JSON.stringify(bounds), row.map_id);
          mapsRecalculated++;
        } catch { /* skip corrupt rows */ }
      }
      console.log(`[Calibration] Charger relocated for ${sn}: ${mapsRecalculated} maps recalculated`);
    }
  }

  db.prepare(`
    INSERT INTO map_calibration (mower_sn, offset_lat, offset_lng, rotation, scale, charger_lat, charger_lng, gps_charger_lat, gps_charger_lng, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mower_sn) DO UPDATE SET
      offset_lat  = excluded.offset_lat,
      offset_lng  = excluded.offset_lng,
      rotation    = excluded.rotation,
      scale       = excluded.scale,
      charger_lat = excluded.charger_lat,
      charger_lng = excluded.charger_lng,
      gps_charger_lat = excluded.gps_charger_lat,
      gps_charger_lng = excluded.gps_charger_lng,
      updated_at  = datetime('now')
  `).run(sn, offsetLat ?? 0, offsetLng ?? 0, rotation ?? 0, scale ?? 1,
    chargerLat ?? null, chargerLng ?? null, gpsChargerLat ?? null, gpsChargerLng ?? null);

  // Na charger relocatie: push bijgewerkte maps naar maaier
  if (mapsRecalculated > 0) {
    autoPushMapsInBackground(sn);
  }

  res.json({ ok: true, mapsRecalculated });
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

// ── Demo/simulatie modus ────────────────────────────────────────

dashboardRouter.post('/demo/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { enabled } = req.body as { enabled: boolean };
  setDemo(sn, !!enabled);
  res.json({ ok: true, ...getDemoStatus(sn) });
});

dashboardRouter.get('/demo/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  res.json({ sn, ...getDemoStatus(sn) });
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
  if (!force && !isDemoMode(sn) && !isDeviceOnline(sn)) {
    res.status(404).json({ error: 'Device is offline' });
    return;
  }

  // Auto-encrypt voor LFI-apparaten — maaier (v6+) en charger (v0.4.0+) verwachten AES
  // Handmatige override: encrypt=true/false in body
  const { encrypt: doEncrypt, qos } = req.body as { encrypt?: boolean; qos?: number };
  const shouldEncrypt = doEncrypt !== undefined ? doEncrypt : sn.startsWith('LFI');

  // set_para_info: bewaar alle settings in sensor cache + SQLite zodat dashboard
  // de juiste state toont (maaier retourneert GEEN get_para_info_respond)
  const paraInfo = command.set_para_info as Record<string, unknown> | undefined;
  if (paraInfo) {
    if (!deviceCache.has(sn)) deviceCache.set(sn, new Map());
    const cache = deviceCache.get(sn)!;
    const changes = new Map<string, string>();
    const upsert = db.prepare(
      `INSERT INTO device_settings (sn, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(sn, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    for (const [key, val] of Object.entries(paraInfo)) {
      if (val === undefined || val === null) continue;
      const strVal = String(val);
      cache.set(key, strVal);
      changes.set(key, strVal);
      upsert.run(sn, key, strVal);
    }
    // Push naar dashboard zodat UI direct update
    forwardToDashboard(sn, changes);
    // LED bridge: stuur ook naar novabot/cmd/<SN> voor led_bridge.py
    if ('headlight' in paraInfo) {
      publishToTopic(`novabot/cmd/${sn}`, { led_set: Number(paraInfo.headlight) });
    }
  }

  // set_lora_info: cache addr/channel in equipment_lora_cache zodat dashboard
  // LoRa config kan tonen in de device chip dropdown
  const loraInfo = command.set_lora_info as { addr?: number; channel?: number } | undefined;
  if (loraInfo && (loraInfo.addr != null || loraInfo.channel != null)) {
    const upsertLora = db.prepare(
      `INSERT INTO equipment_lora_cache (sn, charger_address, charger_channel) VALUES (?, ?, ?)
       ON CONFLICT(sn) DO UPDATE SET charger_address = COALESCE(excluded.charger_address, charger_address),
                                     charger_channel = COALESCE(excluded.charger_channel, charger_channel)`
    );
    upsertLora.run(sn, loraInfo.addr != null ? String(loraInfo.addr) : null, loraInfo.channel != null ? String(loraInfo.channel) : null);
    // Push naar dashboard
    const loraChanges = new Map<string, string>();
    if (loraInfo.addr != null) loraChanges.set('lora_address', String(loraInfo.addr));
    if (loraInfo.channel != null) loraChanges.set('lora_channel', String(loraInfo.channel));
    forwardToDashboard(sn, loraChanges);
    console.log(`[DASHBOARD] Cached LoRa config for ${sn}: addr=${loraInfo.addr} channel=${loraInfo.channel}`);
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
    res.json({ ok: true, command: Object.keys(command)[0], encrypted: true, size: encrypted.length, demo: isDemoMode(sn) });
  } else {
    publishToDevice(sn, command);
    res.json({ ok: true, command: Object.keys(command)[0], demo: isDemoMode(sn) });
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

// ── Work records (mowing history) ────────────────────────────────

interface WorkRecordRow {
  record_id: string;
  user_id: string;
  equipment_id: string | null;
  work_record_date: string;
  work_status: string | null;
  work_time: number | null;
  work_area_m2: number | null;
  cut_grass_height: number | null;
  map_names: string | null;
  start_way: string | null;
  schedule_id: string | null;
  week: string | null;
  date_time: string | null;
}

// GET /api/dashboard/work-records/:sn — maaigeschiedenis
dashboardRouter.get('/work-records/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;

  const total = (db.prepare(
    'SELECT COUNT(*) as cnt FROM work_records WHERE equipment_id = ?'
  ).get(sn) as { cnt: number }).cnt;

  const rows = db.prepare(
    'SELECT * FROM work_records WHERE equipment_id = ? ORDER BY work_record_date DESC LIMIT ? OFFSET ?'
  ).all(sn, limit, offset) as WorkRecordRow[];

  res.json({
    records: rows.map(r => ({
      recordId: r.record_id,
      dateTime: r.date_time,
      workTime: r.work_time,
      workArea: r.work_area_m2,
      cutGrassHeight: r.cut_grass_height,
      mapNames: r.map_names,
      workStatus: r.work_status,
      startWay: r.start_way,
      workRecordDate: r.work_record_date,
    })),
    total,
  });
});

// ── Signal history ──────────────────────────────────────────────

// GET /api/dashboard/signal-history/:sn — signaal historie grafieken
dashboardRouter.get('/signal-history/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const hours = Math.min(parseInt(req.query.hours as string) || 24, 168); // max 7 dagen

  const rows = db.prepare(
    `SELECT ts, battery, wifi_rssi, rtk_sat, loc_quality, cpu_temp
     FROM signal_history
     WHERE sn = ? AND ts >= datetime('now', ? || ' hours')
     ORDER BY ts ASC`
  ).all(sn, String(-hours)) as Array<{
    ts: string; battery: number | null; wifi_rssi: number | null;
    rtk_sat: number | null; loc_quality: number | null; cpu_temp: number | null;
  }>;

  res.json({
    history: rows.map(r => ({
      ts: r.ts,
      battery: r.battery,
      wifiRssi: r.wifi_rssi,
      rtkSat: r.rtk_sat,
      locQuality: r.loc_quality,
      cpuTemp: r.cpu_temp,
    })),
  });
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
  alternate_direction: number;
  alternate_step: number;
  edge_offset: number;
  rain_pause: number;
  rain_threshold_mm: number;
  rain_threshold_probability: number;
  rain_check_hours: number;
  last_triggered_at: string | null;
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
    alternateDirection: r.alternate_direction === 1,
    alternateStep: r.alternate_step ?? 90,
    edgeOffset: r.edge_offset ?? 0,
    rainPause: r.rain_pause === 1,
    rainThresholdMm: r.rain_threshold_mm ?? 0.5,
    rainThresholdProbability: r.rain_threshold_probability ?? 50,
    rainCheckHours: r.rain_check_hours ?? 2,
    lastTriggeredAt: r.last_triggered_at,
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
    alternateDirection?: boolean;
    alternateStep?: number;
    edgeOffset?: number;
    rainPause?: boolean;
    rainThresholdMm?: number;
    rainThresholdProbability?: number;
    rainCheckHours?: number;
  };

  if (!body.startTime) {
    res.status(400).json({ error: 'startTime is vereist' });
    return;
  }

  const scheduleId = uuidv4();
  db.prepare(`
    INSERT INTO dashboard_schedules
      (schedule_id, mower_sn, schedule_name, start_time, end_time, weekdays, enabled,
       map_id, map_name, cutting_height, path_direction, work_mode, task_mode,
       alternate_direction, alternate_step, edge_offset,
       rain_pause, rain_threshold_mm, rain_threshold_probability, rain_check_hours)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    body.alternateDirection ? 1 : 0,
    body.alternateStep ?? 90,
    body.edgeOffset ?? 0,
    body.rainPause ? 1 : 0,
    body.rainThresholdMm ?? 0.5,
    body.rainThresholdProbability ?? 50,
    body.rainCheckHours ?? 2,
  );

  // Stuur timer_task naar maaier als die online is — maar NIET als rain_pause actief is
  // (dan beheert de server-side scheduleRunner het starten)
  if (isDeviceOnline(sn) && !body.rainPause) {
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
      alternate_direction = COALESCE(?, alternate_direction),
      alternate_step      = COALESCE(?, alternate_step),
      edge_offset         = COALESCE(?, edge_offset),
      rain_pause          = COALESCE(?, rain_pause),
      rain_threshold_mm   = COALESCE(?, rain_threshold_mm),
      rain_threshold_probability = COALESCE(?, rain_threshold_probability),
      rain_check_hours    = COALESCE(?, rain_check_hours),
      updated_at     = datetime('now')
    WHERE schedule_id = ? AND mower_sn = ?
  `).run(
    body.scheduleName ?? null,
    body.startTime ?? null,
    body.endTime ?? null,
    body.weekdays ? JSON.stringify(body.weekdays as number[]) : null,
    body.enabled !== undefined ? (body.enabled ? 1 : 0) : null,
    body.mapId ?? null,
    body.mapName ?? null,
    body.cuttingHeight ?? null,
    body.pathDirection ?? null,
    body.workMode ?? null,
    body.taskMode ?? null,
    body.alternateDirection !== undefined ? (body.alternateDirection ? 1 : 0) : null,
    body.alternateStep ?? null,
    body.edgeOffset ?? null,
    body.rainPause !== undefined ? (body.rainPause ? 1 : 0) : null,
    body.rainThresholdMm ?? null,
    body.rainThresholdProbability ?? null,
    body.rainCheckHours ?? null,
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

  // Bereken effectieve richting (met alternerende rotatie)
  let effectiveDirection = row.path_direction;
  if (row.alternate_direction === 1) {
    // Tel hoeveel keer dit schema al getriggerd is (via last_triggered_at count)
    const triggerCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM work_records WHERE schedule_id = ?`
    ).get(row.schedule_id) as { cnt: number } | undefined;
    const count = triggerCount?.cnt ?? 0;
    effectiveDirection = (row.path_direction + count * (row.alternate_step ?? 90)) % 360;
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
      path_direction: effectiveDirection,
    },
  });

  publishToDevice(sn, {
    set_para_info: {
      cutGrassHeight: row.cutting_height,
      defaultCuttingHeight: row.cutting_height,
      target_height: row.cutting_height,
      path_direction: effectiveDirection,
    },
  });

  res.json({ ok: true, message: 'Schedule en parameters verstuurd naar maaier', effectiveDirection });
});

// ── Weather forecast (proxy for Open-Meteo) ────────────────────

const weatherCache = new Map<string, { data: unknown; cachedAt: number }>();
const WEATHER_CACHE_TTL = 15 * 60 * 1000; // 15 minuten

dashboardRouter.get('/weather/:lat/:lng', async (req: Request, res: Response) => {
  const { lat, lng } = req.params;
  const cacheKey = `${parseFloat(lat).toFixed(2)}_${parseFloat(lng).toFixed(2)}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < WEATHER_CACHE_TTL) {
    res.json(cached.data);
    return;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=precipitation,precipitation_probability&forecast_days=1&timezone=auto`;
    const resp = await fetch(url);
    if (!resp.ok) {
      res.status(502).json({ error: 'Weather API error' });
      return;
    }
    const data = await resp.json();
    weatherCache.set(cacheKey, { data, cachedAt: Date.now() });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Weather fetch failed' });
  }
});

// ── Rain Sessions (actieve regenpauze sessies) ──────────────────

import { getActiveRainSessions } from '../services/rainMonitor.js';
import { getWeatherForecast } from '../services/weatherService.js';

// GET /api/dashboard/rain-sessions/:sn — actieve rain sessions voor een maaier
dashboardRouter.get('/rain-sessions/:sn', (req: Request, res: Response) => {
  const sessions = getActiveRainSessions(req.params.sn);
  res.json({ sessions });
});

// GET /api/dashboard/rain-sessions — alle actieve rain sessions
dashboardRouter.get('/rain-sessions', (_req: Request, res: Response) => {
  const sessions = getActiveRainSessions();
  res.json({ sessions });
});

// GET /api/dashboard/rain-forecast/:sn — regen voorspelling voor een maaier
dashboardRouter.get('/rain-forecast/:sn', async (req: Request, res: Response) => {
  const { sn } = req.params;
  // Haal charger GPS op
  const cal = db.prepare('SELECT charger_lat, charger_lng FROM map_calibration WHERE mower_sn = ?').get(sn) as { charger_lat: number | null; charger_lng: number | null } | undefined;
  if (!cal?.charger_lat || !cal?.charger_lng) {
    res.json({ available: false });
    return;
  }
  try {
    const forecast = await getWeatherForecast(cal.charger_lat, cal.charger_lng);
    const now = new Date();
    // Zoek het eerste droge uur (neerslag < 0.1mm EN kans < 30%)
    let clearAt: string | null = null;
    for (const h of forecast.hourly) {
      const t = new Date(h.time);
      if (t <= now) continue;
      if (h.precipitation < 0.1 && h.precipitationProbability < 30) {
        clearAt = h.time;
        break;
      }
    }
    // Komende uren met regen
    const upcoming = forecast.hourly
      .filter(h => new Date(h.time) > now)
      .slice(0, 6)
      .map(h => ({
        time: h.time,
        mm: h.precipitation,
        prob: h.precipitationProbability,
      }));
    res.json({ available: true, clearAt, upcoming });
  } catch {
    res.json({ available: false });
  }
});

// ── Extended Mower Commands (bestaande firmware + extended node) ─────────

import { publishExtendedCommand } from '../mqtt/extendedCommands.js';

// POST /api/dashboard/navigate-to/:sn — stuur maaier naar GPS positie
dashboardRouter.post('/navigate-to/:sn', (req: Request, res: Response) => {
  const sn = req.params.sn;
  const { latitude, longitude, angle = 0 } = req.body as { latitude?: number; longitude?: number; angle?: number };
  if (latitude == null || longitude == null) {
    res.status(400).json({ ok: false, error: 'latitude and longitude required' });
    return;
  }
  publishToDevice(sn, { navigate_to_position: { latitude, longitude, angle } });
  res.json({ ok: true, command: 'navigate_to_position' });
});

// POST /api/dashboard/stop-navigation/:sn — stop navigatie
dashboardRouter.post('/stop-navigation/:sn', (req: Request, res: Response) => {
  publishToDevice(req.params.sn, { stop_navigation: { cmd_num: getNextCmdNum(req.params.sn) } });
  res.json({ ok: true, command: 'stop_navigation' });
});

// POST /api/dashboard/patrol/:sn — start randmaaien (patrol mode)
dashboardRouter.post('/patrol/:sn', (req: Request, res: Response) => {
  publishToDevice(req.params.sn, { start_patrol: null });
  res.json({ ok: true, command: 'start_patrol' });
});

// POST /api/dashboard/stop-patrol/:sn — stop randmaaien
dashboardRouter.post('/stop-patrol/:sn', (req: Request, res: Response) => {
  publishToDevice(req.params.sn, { stop_patrol: null });
  res.json({ ok: true, command: 'stop_patrol' });
});

// POST /api/dashboard/charge-threshold/:sn — stel auto-charge drempel in
dashboardRouter.post('/charge-threshold/:sn', (req: Request, res: Response) => {
  const { threshold } = req.body as { threshold?: number };
  if (threshold == null) { res.status(400).json({ ok: false, error: 'threshold required' }); return; }
  publishToDevice(req.params.sn, { auto_charge_threshold: { threshold } });
  res.json({ ok: true, command: 'auto_charge_threshold' });
});

// POST /api/dashboard/max-speed/:sn — stel max navigatie snelheid in
dashboardRouter.post('/max-speed/:sn', (req: Request, res: Response) => {
  const { speed } = req.body as { speed?: number };
  if (speed == null) { res.status(400).json({ ok: false, error: 'speed required' }); return; }
  publishToDevice(req.params.sn, { set_navigation_max_speed: { speed } });
  res.json({ ok: true, command: 'set_navigation_max_speed' });
});

// POST /api/dashboard/preview-path/:sn — genereer maaipad preview
dashboardRouter.post('/preview-path/:sn', (req: Request, res: Response) => {
  const sn = req.params.sn;
  const { polygonArea, covDirection = 0, covMode = 1 } = req.body as {
    polygonArea?: Array<{ latitude: number; longitude: number }>;
    covDirection?: number;
    covMode?: number;
  };
  if (!polygonArea || polygonArea.length < 3) {
    res.status(400).json({ ok: false, error: 'polygonArea with at least 3 points required' });
    return;
  }
  publishToDevice(sn, {
    generate_preview_cover_path: {
      cov_mode: covMode,
      polygon_area: polygonArea,
      cov_direction: covDirection,
    },
  });
  res.json({ ok: true, command: 'generate_preview_cover_path' });
});

// ── Virtual Walls (no-go zones) ─────────────────────────────────

// GET /api/dashboard/virtual-walls/:sn — haal alle virtual walls op
dashboardRouter.get('/virtual-walls/:sn', (req: Request, res: Response) => {
  const walls = db.prepare(
    'SELECT * FROM virtual_walls WHERE mower_sn = ? ORDER BY created_at DESC'
  ).all(req.params.sn);
  res.json({ walls });
});

// POST /api/dashboard/virtual-walls/:sn — maak een virtual wall + sync naar maaier
dashboardRouter.post('/virtual-walls/:sn', (req: Request, res: Response) => {
  const sn = req.params.sn;
  const { wallName, lat1, lng1, lat2, lng2 } = req.body as {
    wallName?: string; lat1?: number; lng1?: number; lat2?: number; lng2?: number;
  };
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) {
    res.status(400).json({ ok: false, error: 'lat1, lng1, lat2, lng2 required' });
    return;
  }
  const wallId = uuidv4();
  db.prepare(
    'INSERT INTO virtual_walls (wall_id, mower_sn, wall_name, lat1, lng1, lat2, lng2) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(wallId, sn, wallName ?? null, lat1, lng1, lat2, lng2);

  // Sync alle enabled walls naar maaier
  syncVirtualWalls(sn);
  res.json({ ok: true, wallId });
});

// DELETE /api/dashboard/virtual-walls/:sn/:wallId — verwijder een virtual wall
dashboardRouter.delete('/virtual-walls/:sn/:wallId', (req: Request, res: Response) => {
  const { sn, wallId } = req.params;
  db.prepare('DELETE FROM virtual_walls WHERE wall_id = ? AND mower_sn = ?').run(wallId, sn);
  syncVirtualWalls(sn);
  res.json({ ok: true });
});

/** Sync alle enabled virtual walls naar de maaier via MQTT */
function syncVirtualWalls(sn: string): void {
  const walls = db.prepare(
    'SELECT lat1, lng1, lat2, lng2 FROM virtual_walls WHERE mower_sn = ? AND enabled = 1'
  ).all(sn) as Array<{ lat1: number; lng1: number; lat2: number; lng2: number }>;

  publishToDevice(sn, {
    update_virtual_wall: {
      virtual_wall: walls.map(w => ({
        latitude1: w.lat1, longitude1: w.lng1,
        latitude2: w.lat2, longitude2: w.lng2,
      })),
    },
  });
}

// ── Extended Commands (via firmware Python node) ────────────────

// POST /api/dashboard/extended/:sn — stuur commando naar extended_commands.py
dashboardRouter.post('/extended/:sn', (req: Request, res: Response) => {
  const sn = req.params.sn;
  const command = req.body as Record<string, unknown>;
  if (!command || Object.keys(command).length === 0) {
    res.status(400).json({ ok: false, error: 'command required' });
    return;
  }
  publishExtendedCommand(sn, command);
  res.json({ ok: true, command: Object.keys(command)[0] });
});

// ── Static firmware file serving ────────────────────────────────
import express from 'express';

const firmwareDir = process.env.FIRMWARE_PATH ?? path.resolve(__dirname, '../../firmware');

// ── Auto-sync firmware directory → ota_versions DB ─────────────────────────

function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      // Eerste niet-interne IPv4 adres (bijv. 192.168.0.177)
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function getOtaBaseUrl(): string {
  if (process.env.OTA_BASE_URL) return process.env.OTA_BASE_URL.replace(/\/$/, '');
  if (process.env.TARGET_IP) {
    const port = parseInt(process.env.PORT ?? '80', 10);
    return port === 80 ? `http://${process.env.TARGET_IP}` : `http://${process.env.TARGET_IP}:${port}`;
  }
  // Auto-detect: gebruik lokaal IP + poort zodat maaier direct kan downloaden
  const ip = getLocalIp();
  const port = parseInt(process.env.PORT ?? '3000', 10);
  return port === 80 ? `http://${ip}` : `http://${ip}:${port}`;
}

function syncFirmwareVersions(): void {
  if (!existsSync(firmwareDir)) return;

  const baseUrl = getOtaBaseUrl();
  const files = readdirSync(firmwareDir).filter(f =>
    !f.startsWith('.') && (f.endsWith('.bin') || f.endsWith('.deb')),
  );

  // All auto-registered versions (identified by URL pattern)
  const dbVersions = db.prepare(
    `SELECT * FROM ota_versions WHERE download_url LIKE '%/api/dashboard/firmware/%'`,
  ).all() as OtaVersionRow[];

  // Map DB entries by filename extracted from URL
  const dbByFilename = new Map<string, OtaVersionRow>();
  for (const row of dbVersions) {
    const match = row.download_url?.match(/\/firmware\/([^/]+)$/);
    if (match) dbByFilename.set(decodeURIComponent(match[1]), row);
  }

  const validDbIds = new Set<number>();

  for (const filename of files) {
    const filePath = path.join(firmwareDir, filename);
    const md5 = crypto.createHash('md5').update(readFileSync(filePath)).digest('hex');
    const downloadUrl = `${baseUrl}/api/dashboard/firmware/${encodeURIComponent(filename)}`;

    // Read metadata from companion .json if available
    const meta = readFirmwareMeta(filePath);
    const version = meta?.version ?? extractFirmwareVersion(filePath) ?? filename.replace(/\.(bin|deb)$/, '');
    const deviceType = meta?.device_type ?? (filename.endsWith('.deb') ? 'mower' : 'charger');

    const existing = dbByFilename.get(filename);
    if (existing) {
      validDbIds.add(existing.id);
      if (existing.md5 !== md5) {
        // File changed — update version + md5
        db.prepare(`UPDATE ota_versions SET version = ?, device_type = ?, md5 = ?, download_url = ? WHERE id = ?`)
          .run(version, deviceType, md5, downloadUrl, existing.id);
        console.log(`\x1b[38;5;208m[OTA] Auto-updated: ${filename} (${version})\x1b[0m`);
      } else if (existing.download_url !== downloadUrl || existing.version !== version) {
        // URL or version changed — update
        db.prepare(`UPDATE ota_versions SET version = ?, device_type = ?, download_url = ? WHERE id = ?`)
          .run(version, deviceType, downloadUrl, existing.id);
      }
    } else {
      // New file — auto-register
      db.prepare(`INSERT INTO ota_versions (version, device_type, download_url, md5) VALUES (?, ?, ?, ?)`)
        .run(version, deviceType, downloadUrl, md5);
      console.log(`\x1b[38;5;208m[OTA] Auto-registered: ${filename} (${version}, ${deviceType})\x1b[0m`);
    }
  }

  // Remove DB entries for deleted files
  for (const row of dbVersions) {
    if (!validDbIds.has(row.id)) {
      const match = row.download_url?.match(/\/firmware\/([^/]+)$/);
      db.prepare(`DELETE FROM ota_versions WHERE id = ?`).run(row.id);
      console.log(`\x1b[38;5;208m[OTA] Auto-removed: ${match ? decodeURIComponent(match[1]) : row.version}\x1b[0m`);
    }
  }
}

let syncTimeout: ReturnType<typeof setTimeout> | null = null;

export function initFirmwareSync(): void {
  // Ensure firmware directory exists
  if (!existsSync(firmwareDir)) {
    try { mkdirSync(firmwareDir, { recursive: true }); } catch { /* ignore */ }
  }

  // Initial sync
  syncFirmwareVersions();

  // Watch for changes with 1s debounce
  try {
    watch(firmwareDir, { persistent: false }, () => {
      if (syncTimeout) clearTimeout(syncTimeout);
      syncTimeout = setTimeout(() => syncFirmwareVersions(), 1000);
    });
    console.log(`[OTA] Watching firmware directory: ${firmwareDir}`);
  } catch (err) {
    console.warn(`[OTA] Could not watch firmware directory: ${err}`);
  }
}

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
    const files = readdirSync(firmwareDir).filter(f => !f.startsWith('.') && !f.endsWith('.json'));
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
/**
 * Read companion .json metadata for a firmware file (OpenNova builds).
 * Returns { version, device_type, description, md5 } or null.
 */
function readFirmwareMeta(filePath: string): { version?: string; device_type?: string; description?: string; md5?: string } | null {
  const jsonPath = filePath.replace(/\.(bin|deb)$/, '.json');
  if (!existsSync(jsonPath)) return null;
  try {
    return JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function extractChargerVersion(binPath: string): string | null {
  try {
    const output = execSync(`strings "${binPath}"`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const lines = output.split('\n');
    // Primary: OpenNova firmware embeds "OPENNOVA_FW=v1.2.3" marker
    for (const line of lines) {
      const m = line.match(/^OPENNOVA_FW=(v\d+\.\d+\.\d+\S*)/);
      if (m) return m[1];
    }
    // Fallback: original Novabot charger — find version strings, skip ESP-IDF (v4.x/v5.x)
    const versions = lines.filter(l => /^v\d+\.\d+\.\d+/.test(l) && !/^v[45]\.\d+/.test(l));
    return versions[0]?.trim() ?? null;
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
  // Primary: check for companion .json metadata (OpenNova builds)
  const jsonPath = filePath.replace(/\.(bin|deb)$/, '.json');
  if (existsSync(jsonPath)) {
    try {
      const meta = JSON.parse(readFileSync(jsonPath, 'utf8'));
      if (meta.version) return meta.version;
    } catch { /* fall through */ }
  }
  if (filePath.endsWith('.deb')) {
    const fromDeb = extractMowerVersion(filePath);
    if (fromDeb) return fromDeb;
  } else if (filePath.endsWith('.bin')) {
    const fromBin = extractChargerVersion(filePath);
    if (fromBin) return fromBin;
  }
  // Fallback: extract version from filename (e.g. mower_firmware_v6.0.2-custom-8.deb → v6.0.2-custom-8)
  const basename = path.basename(filePath);
  const vMatch = basename.match(/(v\d+\.\d+\.\d+(?:[-.]\S+?)?)\.(?:bin|deb)$/i);
  return vMatch ? vMatch[1] : null;
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

  // Detect firmware version to decide encryption
  // v5.x firmware has NO AES decryption → must send plain JSON
  // v6.x+ firmware HAS AES → must send encrypted
  const snapshots = getAllDeviceSnapshots();
  const deviceSensors = snapshots[sn] ?? {};
  const fwVersion = deviceSensors.sw_version || deviceSensors.version || deviceSensors.mower_version || '';
  const needsPlaintext = fwVersion.startsWith('v5.') || fwVersion.startsWith('5.');

  const isCharger = sn.startsWith('LFIC');
  if (isCharger) {
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

    if (needsPlaintext) {
      // v5.x: send UNENCRYPTED — firmware cannot decrypt AES
      const topic = `Dart/Send_mqtt/${sn}`;
      publishToTopic(topic, mowerOtaCommand);
      console.log(`\x1b[38;5;208m[OTA] PLAIN (v5.x) ota_upgrade_cmd naar mower ${sn}: ${JSON.stringify(mowerOtaCommand)}\x1b[0m`);
    } else {
      // v6.x+: send AES encrypted
      publishToDevice(sn, mowerOtaCommand);
      console.log(`\x1b[38;5;208m[OTA] Encrypted ota_upgrade_cmd naar mower ${sn}: ${JSON.stringify(mowerOtaCommand)}\x1b[0m`);
    }
  }

  res.json({ ok: true, command: 'ota_upgrade_cmd', version: otaVersion.version, target: sn });
});

// ── LoRa address allocation ──────────────────────────────────────

// GET /api/dashboard/lora/next-address — get next free LoRa address for a new charger
dashboardRouter.get('/lora/next-address', (_req: Request, res: Response) => {
  const rows = db.prepare(
    'SELECT charger_address FROM equipment_lora_cache WHERE charger_address IS NOT NULL'
  ).all() as { charger_address: number }[];

  const usedAddresses = new Set(rows.map(r => Number(r.charger_address)));
  // Start at 718 (Novabot default), find next unused
  let nextAddr = 718;
  while (usedAddresses.has(nextAddr)) {
    nextAddr++;
  }

  res.json({ address: nextAddr, channel: 16, hc: 20, lc: 14 });
});

// GET /api/dashboard/device-sets — group devices into charger↔mower sets based on LoRa address
dashboardRouter.get('/device-sets', (_req: Request, res: Response) => {
  // Get all LoRa pairings
  const loraRows = db.prepare('SELECT sn, charger_address, charger_channel FROM equipment_lora_cache').all() as
    { sn: string; charger_address: number | null; charger_channel: number | null }[];

  // Get all known devices with online status
  const deviceRows = db.prepare(`
    SELECT d.sn, d.mac_address, d.last_seen FROM device_registry d
    INNER JOIN (
      SELECT sn, MAX(last_seen) as max_seen FROM device_registry
      WHERE sn IS NOT NULL GROUP BY sn
    ) latest ON d.sn = latest.sn AND d.last_seen = latest.max_seen
  `).all() as { sn: string; mac_address: string | null; last_seen: string }[];

  const allSns = new Set(deviceRows.map(r => r.sn));

  // Group by LoRa address
  const byAddr = new Map<number, { charger: string | null; mower: string | null }>();
  const paired = new Set<string>();

  for (const r of loraRows) {
    if (r.charger_address == null) continue;
    const addr = Number(r.charger_address);
    if (!byAddr.has(addr)) byAddr.set(addr, { charger: null, mower: null });
    const set = byAddr.get(addr)!;
    if (r.sn.startsWith('LFIC')) set.charger = r.sn;
    else set.mower = r.sn;
    paired.add(r.sn);
  }

  // Build sets
  const sets: Array<{
    loraAddress: number | null;
    charger: { sn: string; online: boolean } | null;
    mower: { sn: string; online: boolean } | null;
  }> = [];

  for (const [addr, pair] of byAddr) {
    sets.push({
      loraAddress: addr,
      charger: pair.charger ? { sn: pair.charger, online: isDeviceOnline(pair.charger) } : null,
      mower: pair.mower ? { sn: pair.mower, online: isDeviceOnline(pair.mower) } : null,
    });
  }

  // Add unpaired devices
  for (const d of deviceRows) {
    if (paired.has(d.sn)) continue;
    if (!d.sn.startsWith('LFI')) continue;
    const isCharger = d.sn.startsWith('LFIC');
    sets.push({
      loraAddress: null,
      charger: isCharger ? { sn: d.sn, online: isDeviceOnline(d.sn) } : null,
      mower: !isCharger ? { sn: d.sn, online: isDeviceOnline(d.sn) } : null,
    });
  }

  res.json({ sets });
});

// POST /api/dashboard/pair-mower — pair an unpaired mower with an existing charger
dashboardRouter.post('/pair-mower', (req: Request, res: Response) => {
  const { mowerSn, chargerSn } = req.body as { mowerSn?: string; chargerSn?: string };
  if (!mowerSn || !chargerSn) {
    res.status(400).json({ error: 'mowerSn and chargerSn required' });
    return;
  }

  // Get charger's LoRa address from cache
  const loraRow = db.prepare(
    'SELECT charger_address, charger_channel FROM equipment_lora_cache WHERE sn = ?'
  ).get(chargerSn) as { charger_address: number; charger_channel: number } | undefined;

  if (!loraRow) {
    res.status(404).json({ error: 'Charger not found in LoRa cache — provision charger first' });
    return;
  }

  // Check if mower already has its own equipment record
  const mowerEquip = db.prepare(
    'SELECT equipment_id FROM equipment WHERE mower_sn = ?'
  ).get(mowerSn) as { equipment_id: string } | undefined;

  // Check if charger has an equipment record
  const chargerEquip = db.prepare(
    'SELECT equipment_id, user_id, mower_sn FROM equipment WHERE mower_sn = ? OR charger_sn = ?'
  ).get(chargerSn, chargerSn) as { equipment_id: string; user_id: string | null; mower_sn: string } | undefined;

  // If mower has its own record, delete it first (will be merged into charger's record)
  if (mowerEquip && (!chargerEquip || mowerEquip.equipment_id !== chargerEquip?.equipment_id)) {
    db.prepare('DELETE FROM equipment WHERE equipment_id = ?').run(mowerEquip.equipment_id);
    console.log(`[pair] Removed mower's standalone equipment record ${mowerEquip.equipment_id}`);
  }

  if (chargerEquip && chargerEquip.mower_sn === chargerSn) {
    // Charger is stored as mower_sn (charger-first flow) — update to add mower
    db.prepare(
      'UPDATE equipment SET charger_sn = mower_sn, mower_sn = ? WHERE equipment_id = ?'
    ).run(mowerSn, chargerEquip.equipment_id);
    console.log(`[pair] Paired mower ${mowerSn} with charger ${chargerSn} (updated existing record)`);
  } else if (chargerEquip) {
    // Charger already has a record — set mower + charger SNs
    db.prepare(
      'UPDATE equipment SET mower_sn = ?, charger_sn = ? WHERE equipment_id = ?'
    ).run(mowerSn, chargerSn, chargerEquip.equipment_id);
    console.log(`[pair] Paired mower ${mowerSn} with charger ${chargerSn} (into existing charger record)`);
  } else {
    // No equipment record for either — create one with both
    const equipmentId = `EQ_${Date.now()}`;
    db.prepare(`
      INSERT INTO equipment (equipment_id, mower_sn, charger_sn, charger_address, charger_channel)
      VALUES (?, ?, ?, ?, ?)
    `).run(equipmentId, mowerSn, chargerSn, loraRow.charger_address, loraRow.charger_channel);
    console.log(`[pair] Created equipment ${equipmentId}: mower=${mowerSn} charger=${chargerSn}`);
  }

  // Copy LoRa address to mower's lora_cache entry
  db.prepare(`
    INSERT OR REPLACE INTO equipment_lora_cache (sn, charger_address, charger_channel)
    VALUES (?, ?, ?)
  `).run(mowerSn, loraRow.charger_address, loraRow.charger_channel);

  console.log(`[pair] Mower ${mowerSn} paired with charger ${chargerSn} (LoRa addr=${loraRow.charger_address} ch=${loraRow.charger_channel})`);
  res.json({ ok: true, loraAddress: loraRow.charger_address });
});

// POST /api/dashboard/lora/query-mower/:mowerSn — ask mower for its LoRa config via MQTT
dashboardRouter.post('/lora/query-mower/:mowerSn', async (req: Request, res: Response) => {
  const { mowerSn } = req.params;
  const { publishToExtended, onExtendedResponse, offExtendedResponse } = await import('../mqtt/mapSync.js');

  let resolved = false;
  const timeout = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      offExtendedResponse(mowerSn, handler);
      res.status(504).json({ error: 'Mower did not respond (timeout)' });
    }
  }, 10000);

  const handler = (data: Record<string, unknown>) => {
    if (resolved) return;
    if (data.get_lora_info_respond) {
      resolved = true;
      clearTimeout(timeout);
      offExtendedResponse(mowerSn, handler);
      res.json(data.get_lora_info_respond);
    }
  };

  onExtendedResponse(mowerSn, handler);
  publishToExtended(mowerSn, { get_lora_info: {} });
});

// POST /api/dashboard/lora/set-mower/:mowerSn — set mower LoRa config via MQTT
dashboardRouter.post('/lora/set-mower/:mowerSn', async (req: Request, res: Response) => {
  const { mowerSn } = req.params;
  const { addr, channel, hc, lc } = req.body as { addr: number; channel: number; hc?: number; lc?: number };

  if (addr == null || channel == null) {
    res.status(400).json({ error: 'addr and channel required' });
    return;
  }

  const { publishToExtended } = await import('../mqtt/mapSync.js');
  publishToExtended(mowerSn, { set_lora_info: { addr, channel, hc: hc ?? 20, lc: lc ?? 14 } });

  // Update local LoRa cache
  db.prepare(`
    INSERT OR REPLACE INTO equipment_lora_cache (sn, charger_address, charger_channel)
    VALUES (?, ?, ?)
  `).run(mowerSn, addr, channel);

  console.log(`[lora] Set mower ${mowerSn} LoRa: addr=${addr} channel=${channel}`);
  res.json({ ok: true, addr, channel });
});

// GET /api/dashboard/lora/for-charger/:chargerSn — get LoRa params for a specific charger
dashboardRouter.get('/lora/for-charger/:chargerSn', (req: Request, res: Response) => {
  const { chargerSn } = req.params;
  const row = db.prepare(
    'SELECT charger_address, charger_channel FROM equipment_lora_cache WHERE sn = ?'
  ).get(chargerSn) as { charger_address: number; charger_channel: number } | undefined;

  if (row) {
    res.json({ address: row.charger_address, channel: row.charger_channel, hc: 20, lc: 14 });
  } else {
    res.status(404).json({ error: 'Charger not found in LoRa cache' });
  }
});

// POST /api/dashboard/lora/register — register LoRa params after charger provisioning
dashboardRouter.post('/lora/register', (req: Request, res: Response) => {
  const { sn, address, channel } = req.body as { sn?: string; address?: number; channel?: number };
  if (!sn || address == null) {
    res.status(400).json({ error: 'sn and address required' });
    return;
  }
  db.prepare(`
    INSERT INTO equipment_lora_cache (sn, charger_address, charger_channel)
    VALUES (?, ?, ?)
    ON CONFLICT(sn) DO UPDATE SET charger_address = ?, charger_channel = ?
  `).run(sn, address, channel ?? 16, address, channel ?? 16);
  console.log(`[LoRa] Registered ${sn}: addr=${address} ch=${channel ?? 16}`);
  res.json({ ok: true });
});

// ── PIN Code Management ─────────────────────────────────────────

// POST /api/dashboard/pin/:sn/query — vraag huidige PIN op (cfg_value=0)
dashboardRouter.post('/pin/:sn/query', (req: Request, res: Response) => {
  const { sn } = req.params;
  if (!isDeviceOnline(sn)) {
    res.status(404).json({ error: 'Device is offline' });
    return;
  }
  publishToDevice(sn, { dev_pin_info: { cfg_value: 0, code: '0000' } });
  console.log(`[PIN] Query PIN voor ${sn}`);
  res.json({ ok: true, action: 'query', cfg_value: 0 });
});

// POST /api/dashboard/pin/:sn/set — stel nieuwe PIN in (cfg_value=1)
dashboardRouter.post('/pin/:sn/set', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { code } = req.body as { code?: string };
  if (!code || code.length !== 4 || !/^\d{4}$/.test(code)) {
    res.status(400).json({ error: 'PIN moet 4 cijfers zijn' });
    return;
  }
  if (!isDeviceOnline(sn)) {
    res.status(404).json({ error: 'Device is offline' });
    return;
  }
  publishToDevice(sn, { dev_pin_info: { cfg_value: 1, code } });
  console.log(`[PIN] Set PIN voor ${sn}: ${code}`);
  res.json({ ok: true, action: 'set', cfg_value: 1 });
});

// POST /api/dashboard/pin/:sn/verify — verifieer PIN en unlock maaier (cfg_value=2)
// Vereist gepatchte STM32 firmware (v3.6.7+) met type=2 + type=3 support.
// Stuurt PIN naar chassis MCU; als correct → scherm gaat naar home (unlock).
// extended_commands.py stuurt automatisch type=3 clear_error commands na succesvolle verify
// om te voorkomen dat tilt/lift detectie het error scherm opnieuw toont.
dashboardRouter.post('/pin/:sn/verify', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { code } = req.body as { code?: string };
  if (!code || code.length !== 4 || !/^\d{4}$/.test(code)) {
    res.status(400).json({ error: 'PIN moet 4 cijfers zijn' });
    return;
  }
  if (!isDeviceOnline(sn)) {
    res.status(404).json({ error: 'Device is offline' });
    return;
  }
  // NIET via MQTT dev_pin_info! mqtt_node's C++ ChassisPinCodeSet action client
  // vindt de action server NOOIT (21s timeout) en rapporteert dan error_status=151.
  // Dit VEROORZAAKT de PIN lock error die alle commando's blokkeert.
  // ALLEEN via extended_commands.py → pin_verify_ros2.py → ROS2 action (bewezen werkend).
  publishExtendedCommand(sn, { verify_pin: { code } });
  console.log(`[PIN] Verify PIN voor ${sn}: ${code} (alleen via extended_commands.py ROS2)`);

  // Activeer cooldown: gedurende 60s worden inkomende error_status updates
  // die PIN-gerelateerd zijn genegeerd (voorkomt dat LoRa/report de error terugzet)
  markPinVerified(sn);

  // Optimistisch error fields clearen in sensor cache — de PIN wordt
  // via serial geverifieerd (extended_commands.py), geen MQTT response verwacht.
  // Zonder dit blijft de dashboard PIN overlay staan totdat de charger
  // een nieuwe up_status_info stuurt (kan minuten duren via LoRa).
  const snCache = deviceCache.get(sn);
  if (snCache) {
    const errorFields = ['error_status', 'error_msg', 'error_code'];
    const cleared = new Map<string, string>();
    for (const f of errorFields) {
      if (snCache.has(f)) {
        snCache.set(f, '0');
        cleared.set(f, translateValue(f, '0'));
      }
    }
    if (cleared.size > 0) {
      forwardToDashboard(sn, cleared);
      console.log(`[PIN] Cleared error fields in cache for ${sn}`);
    }
  }

  res.json({ ok: true, action: 'verify', cfg_value: 2 });
});

// POST /api/dashboard/pin/:sn/raw — stuur raw cfg_value (voor testing)
dashboardRouter.post('/pin/:sn/raw', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { cfg_value, code } = req.body as { cfg_value?: number; code?: string };
  if (cfg_value === undefined || typeof cfg_value !== 'number') {
    res.status(400).json({ error: 'cfg_value (number) is vereist' });
    return;
  }
  if (!code || code.length !== 4 || !/^\d{4}$/.test(code)) {
    res.status(400).json({ error: 'PIN moet 4 cijfers zijn' });
    return;
  }
  if (!isDeviceOnline(sn)) {
    res.status(404).json({ error: 'Device is offline' });
    return;
  }
  publishToDevice(sn, { dev_pin_info: { cfg_value, code } });
  console.log(`[PIN] Raw PIN command voor ${sn}: cfg_value=${cfg_value}, code=${code}`);
  res.json({ ok: true, action: 'raw', cfg_value });
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

  const topic = req.query.topic as string || 'front';
  const proxyReq = http.get(`http://${ip}:${port}/stream?topic=${encodeURIComponent(topic)}`, (proxyRes) => {
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
  let ip = req.query.ip as string | undefined;
  const port = parseInt(req.query.port as string) || 8000;

  // Auto-resolve mower IP als niet meegegeven
  if (!ip) {
    const sn = req.params.sn;
    const isPrivateIp = (addr: string) =>
      /^10\./.test(addr) || /^172\.(1[6-9]|2\d|3[01])\./.test(addr) || /^192\.168\./.test(addr);
    const ipRow = db.prepare(
      `SELECT e.mower_ip, d.ip_address as detected_ip
       FROM equipment e
       LEFT JOIN device_registry d ON d.sn = e.mower_sn AND d.ip_address IS NOT NULL
       WHERE e.mower_sn = ?
       ORDER BY d.last_seen DESC LIMIT 1`
    ).get(sn) as { mower_ip: string | null; detected_ip: string | null } | undefined;
    ip = ipRow?.mower_ip
      ?? (ipRow?.detected_ip && isPrivateIp(ipRow.detected_ip) ? ipRow.detected_ip : undefined);
    if (!ip) {
      res.status(404).json({ error: 'Maaier IP onbekend' });
      return;
    }
  }

  const topic = req.query.topic as string || 'front';
  http.get(`http://${ip}:${port}/snapshot?topic=${encodeURIComponent(topic)}`, (proxyRes) => {
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

// ── Setup / DNS info ──────────────────────────────────────────────────────────

// GET /api/dashboard/setup/info — server info voor setup wizard
// CORS headers nodig: DNS test fetcht via app.lfibot.com (andere origin dan dashboard IP)
dashboardRouter.get('/setup/info', (_req: Request, res: Response) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({
    targetIp: process.env.TARGET_IP ?? null,
    dnsEnabled: process.env.DISABLE_DNS !== 'true',
    port: parseInt(process.env.PORT ?? '80', 10),
    mqttPort: 1883,
  });
});

// GET /api/dashboard/setup/ca-cert — download het lokale CA certificaat (voor Novabot app)
dashboardRouter.get('/setup/ca-cert', (_req: Request, res: Response) => {
  const certPath = '/data/certs/server.crt';
  if (!existsSync(certPath)) {
    res.status(404).json({ error: 'Cert nog niet gegenereerd — herstart de container' });
    return;
  }
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="opennova-ca.crt"');
  createReadStream(certPath).pipe(res);
});

// GET /api/dashboard/admin/accounts — return existing accounts + their devices (bootstrap wizard)
dashboardRouter.get('/admin/accounts', (_req: Request, res: Response) => {
  const users = db.prepare('SELECT app_user_id, email, username FROM users').all() as
    { app_user_id: string; email: string; username: string | null }[];

  if (users.length === 0) {
    res.json({ hasAccount: false });
    return;
  }

  const user = users[0];
  const equipment = db.prepare('SELECT mower_sn, charger_sn, mower_version, charger_version FROM equipment WHERE user_id = ?')
    .all(user.app_user_id) as { mower_sn: string; charger_sn: string | null; mower_version: string | null; charger_version: string | null }[];

  const devices: { type: string; sn: string; version?: string }[] = [];
  const seen = new Set<string>();
  for (const eq of equipment) {
    if (eq.charger_sn?.startsWith('LFIC') && !seen.has(eq.charger_sn)) {
      seen.add(eq.charger_sn);
      devices.push({ type: 'charger', sn: eq.charger_sn, version: eq.charger_version ?? undefined });
    }
    if (eq.mower_sn?.startsWith('LFIN') && !seen.has(eq.mower_sn)) {
      seen.add(eq.mower_sn);
      devices.push({ type: 'mower', sn: eq.mower_sn, version: eq.mower_version ?? undefined });
    }
  }

  res.json({ hasAccount: true, email: user.email, username: user.username, devices });
});

// GET /api/dashboard/setup/status — check of er al een gebruiker aangemaakt is
// CORS nodig: cert-check doet een cross-origin fetch (http → https, andere scheme = andere origin)
dashboardRouter.get('/setup/status', (_req: Request, res: Response) => {
  res.set('Access-Control-Allow-Origin', '*');
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  res.json({ hasUsers: row.count > 0 });
});

// POST /api/dashboard/setup/create-user — maak de eerste gebruiker aan (alleen als DB leeg is)
dashboardRouter.post('/setup/create-user', async (req: Request, res: Response) => {
  const { email, password, username } = req.body as { email?: string; password?: string; username?: string };

  if (!email || !password) {
    res.status(400).json({ ok: false, error: 'Email en wachtwoord zijn verplicht' });
    return;
  }

  const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  if (row.count > 0) {
    res.status(409).json({ ok: false, error: 'Er bestaat al een gebruiker. Gebruik de inlogpagina.' });
    return;
  }

  const bcrypt = await import('bcrypt');
  const hash = await bcrypt.hash(password, 10);
  const appUserId = uuidv4();

  db.prepare(`
    INSERT INTO users (app_user_id, email, password, username, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(appUserId, email.trim().toLowerCase(), hash, username?.trim() ?? '');

  console.log(`[SETUP] Eerste gebruiker aangemaakt: ${email}`);
  res.json({ ok: true });
});

// ── POST /api/dashboard/admin/import — import apparaten vanuit LFI cloud ──────
// Geen JWT auth: alleen bedoeld voor lokaal netwerk (bootstrap wizard).
// Maakt een lokale gebruiker aan en registreert de maaier + laadstation in de DB.
dashboardRouter.post('/admin/import', async (req: Request, res: Response) => {
  const { email, password, deviceName, charger, mower } = req.body as {
    email?: string;
    password?: string;
    deviceName?: string;
    charger?: { sn: string; address?: number; channel?: number; mac?: string };
    mower?: { sn: string; mac?: string; version?: string };
  };

  if (!email || !password || !charger?.sn) {
    res.status(400).json({ ok: false, error: 'email, password en charger.sn zijn verplicht' });
    return;
  }

  const bcrypt = await import('bcrypt');

  // 1. Maak of update gebruiker
  const normalizedEmail = email.trim().toLowerCase();
  const existingUser = db.prepare('SELECT app_user_id, id FROM users WHERE email = ?')
    .get(normalizedEmail) as { app_user_id: string; id: number } | undefined;

  let appUserId: string;
  let userId: number;

  if (existingUser) {
    // Update wachtwoord als de gebruiker al bestaat
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET password = ? WHERE app_user_id = ?')
      .run(hash, existingUser.app_user_id);
    appUserId = existingUser.app_user_id;
    userId = existingUser.id;
    console.log(`[admin/import] Bestaande gebruiker bijgewerkt: ${normalizedEmail}`);
  } else {
    const hash = await bcrypt.hash(password, 10);
    appUserId = uuidv4();
    db.prepare(`
      INSERT INTO users (app_user_id, email, password, username, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(appUserId, normalizedEmail, hash, deviceName ?? '');
    userId = (db.prepare('SELECT id FROM users WHERE app_user_id = ?').get(appUserId) as { id: number }).id;
    console.log(`[admin/import] Nieuwe gebruiker aangemaakt: ${normalizedEmail}`);
  }

  // 2. Seed equipment_lora_cache voor het laadstation
  if (charger.address != null && charger.channel != null) {
    const existingCache = db.prepare('SELECT sn FROM equipment_lora_cache WHERE sn = ?')
      .get(charger.sn);
    if (existingCache) {
      db.prepare('UPDATE equipment_lora_cache SET charger_address = ?, charger_channel = ? WHERE sn = ?')
        .run(String(charger.address), String(charger.channel), charger.sn);
    } else {
      db.prepare('INSERT INTO equipment_lora_cache (sn, charger_address, charger_channel) VALUES (?, ?, ?)')
        .run(charger.sn, String(charger.address), String(charger.channel));
    }
  }

  // 3. Maak charger equipment record aan (of update bestaande)
  const existingCharger = db.prepare('SELECT equipment_id FROM equipment WHERE mower_sn = ?')
    .get(charger.sn) as { equipment_id: string } | undefined;

  if (existingCharger) {
    db.prepare(`
      UPDATE equipment
      SET user_id = ?, charger_address = COALESCE(?, charger_address),
          charger_channel = COALESCE(?, charger_channel),
          mac_address = COALESCE(?, mac_address),
          equipment_nick_name = COALESCE(?, equipment_nick_name)
      WHERE equipment_id = ?
    `).run(appUserId, charger.address != null ? String(charger.address) : null,
           charger.channel != null ? String(charger.channel) : null,
           charger.mac ?? null, deviceName ?? null, existingCharger.equipment_id);
    console.log(`[admin/import] Charger ${charger.sn} bijgewerkt`);
  } else {
    const equipmentId = uuidv4();
    db.prepare(`
      INSERT INTO equipment
        (equipment_id, user_id, mower_sn, charger_sn, equipment_type_h, equipment_nick_name,
         charger_address, charger_channel, mac_address)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `).run(equipmentId, appUserId, charger.sn, charger.sn.slice(0, 5),
           deviceName ?? null,
           charger.address != null ? String(charger.address) : null,
           charger.channel != null ? String(charger.channel) : null,
           charger.mac ?? null);
    console.log(`[admin/import] Charger ${charger.sn} aangemaakt`);
  }

  // 4. Maak mower equipment record aan (als mower SN beschikbaar)
  if (mower?.sn) {
    const existingMower = db.prepare('SELECT equipment_id FROM equipment WHERE mower_sn = ?')
      .get(mower.sn) as { equipment_id: string } | undefined;

    if (existingMower) {
      db.prepare(`
        UPDATE equipment
        SET user_id = ?, charger_sn = COALESCE(?, charger_sn),
            mac_address = COALESCE(?, mac_address),
            mower_version = COALESCE(?, mower_version),
            equipment_nick_name = COALESCE(?, equipment_nick_name)
        WHERE equipment_id = ?
      `).run(appUserId, charger.sn, mower.mac ?? null, mower.version ?? null,
             deviceName ?? null, existingMower.equipment_id);
      console.log(`[admin/import] Maaier ${mower.sn} bijgewerkt`);
    } else {
      const equipmentId = uuidv4();
      db.prepare(`
        INSERT INTO equipment
          (equipment_id, user_id, mower_sn, charger_sn, equipment_type_h, equipment_nick_name,
           mac_address, mower_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(equipmentId, appUserId, mower.sn, charger.sn, mower.sn.slice(0, 5),
             deviceName ?? null, mower.mac ?? null, mower.version ?? null);
      console.log(`[admin/import] Maaier ${mower.sn} aangemaakt`);
    }
  }

  res.json({
    ok: true,
    userId,
    email: normalizedEmail,
    chargerSn: charger.sn,
    mowerSn: mower?.sn ?? null,
  });
});
