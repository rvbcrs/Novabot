/**
 * Dashboard REST endpoints — initial state load voor de React app.
 * Geen auth — alleen bedoeld voor lokaal netwerk.
 */
import { Router, Request, Response } from 'express';
import {
  userRepo,
  equipmentRepo,
  deviceRepo,
  mapRepo,
  scheduleRepo,
  messageRepo,
  deviceSettingsRepo,
  signalHistoryRepo,
  virtualWallRepo,
  otaVersionRepo,
} from '../db/repositories/index.js';
import { getAllDeviceSnapshots, getDeviceSnapshot, SENSORS, getGpsTrail, clearGpsTrail, getLocalTrail, clearLocalTrail, deviceCache, translateValue, markPinVerified, getDockPose } from '../mqtt/sensorData.js';
import { isDeviceOnline, writeRawPublish, getBrokerDiagnostics } from '../mqtt/broker.js';
import { getRecentLogs, forwardToDashboard, onLogEntry, emitMapsChanged } from '../dashboard/socketHandler.js';
import { requestMapList, requestMapOutline, publishToDevice, publishRawToDevice, publishEncryptedOnTopic, publishToTopic, goToChargePayload, getNextCmdNum, patchLatestZipChargingPose, republishObstacleDetection } from '../mqtt/mapSync.js';
import { publishExtendedCommand } from '../mqtt/extendedCommands.js';
import { isFrameUnvalidated, markFrameUnvalidated, clearFrameUnvalidated, setReanchorRelocked, isReanchorRelocked } from '../services/frameValidation.js';
import { softRestartBlockedReason, sendSoftRestart } from '../services/softRestart.js';
import { gpsSpreadMeters, medianGps, type LatLng } from '../services/reanchorGps.js';
import { compareMapRowsByCanonical } from '../utils/mapOrder.js';
import crypto from 'crypto';
import { generateMapZipFromDb, gpsToLocal, localToGps, parseMapZip, type GpsPoint, type LocalPoint } from '../mqtt/mapConverter.js';
import { existsSync, unlinkSync, readFileSync, readdirSync, createReadStream, statSync, watch, mkdirSync, copyFileSync } from 'fs';
import { isDemoMode, setDemoMode as setDemo, getDemoStatus } from '../services/demoSimulator.js';
import { resolveMowerIp } from '../services/mowerIpDiscovery.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { tgm1ToDisplayTgr1 } from '../services/terrainGrid.js';
import { networkInterfaces } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { v4 as uuidv4 } from 'uuid';
import { getActiveAdvertisement, getCompetingServers } from '../services/mdnsAdvertiser.js';
import { getDeviceHealth } from '../services/deviceHealth.js';
import { getEditGeometry, saveDraft, discardDrafts, applyEdits, revertEdits } from '../services/mapEdit.js';
import {
  COVERAGE_PLANNER_RADIUS_KEY,
  DEFAULT_COVERAGE_PLANNER_RADIUS,
  MAX_COVERAGE_PLANNER_RADIUS,
  MIN_COVERAGE_PLANNER_RADIUS,
  coveragePlannerRadiusError,
  formatCoveragePlannerRadius,
  parseCoveragePlannerRadius,
  selectCoveragePlannerRadius,
} from '../services/coveragePlannerRadius.js';
import { ensureBetaFlashSafe } from '../services/firmwareSafety.js';
import { getMowerFileCapability } from '../services/mowerFileCapability.js';
import { getPolygonAnchor } from '../services/anchor.js';
import { selectParaRepush } from '../mqtt/paraRepush.js';
import { MOW_PARA_SETTLE_MS } from '../services/mowingService.js';

interface DeviceRegistryRow {
  mqtt_client_id: string;
  sn: string | null;
  mac_address: string | null;
  mqtt_username: string | null;
  last_seen: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface EquipmentRow {
  mower_sn: string;
  charger_sn: string | null;
  equipment_nick_name: string | null;
  mower_version: string | null;
  charger_version: string | null;
  mower_ip: string | null;
}

export const dashboardRouter = Router();

// Running server version (read once from package.json). Exposed on this OPEN
// router so the dashboard header can show which build is live without admin auth.
let DASHBOARD_SERVER_VERSION = '?';
try {
  DASHBOARD_SERVER_VERSION = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version;
} catch { /* ignore */ }
dashboardRouter.get('/version', (_req: Request, res: Response) => {
  res.json({ version: DASHBOARD_SERVER_VERSION });
});

// GET /api/dashboard/server-update — is a newer container image on Docker Hub?
// Mirrors the admin panel's /api/admin-status/check-server-update but is
// reachable from the dashboard (LAN unauthenticated / external authenticated).
// Reuses the admin module's checker (and its 5-minute Docker Hub cache).
dashboardRouter.get('/server-update', async (_req: Request, res: Response) => {
  try {
    const { checkServerUpdate } = await import('./adminStatus.js');
    res.json(await checkServerUpdate());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'update check failed' });
  }
});

// Load persisted device settings into in-memory sensor cache at startup.
// This ensures settings (cutting height, path direction, etc.) survive container restarts.
{
  const rows = deviceSettingsRepo.listAll();
  for (const row of rows) {
    if (!deviceCache.has(row.sn)) deviceCache.set(row.sn, new Map());
    deviceCache.get(row.sn)!.set(row.key, row.value);
  }
  if (rows.length > 0) console.log(`[SETTINGS] Loaded ${rows.length} persisted settings for ${new Set(rows.map(r => r.sn)).size} device(s)`);
}

// POST /api/dashboard/soft-restart/:sn — restart the mower's ROS stack via the
// firmware `soft_restart` command (systemctl restart novabot_launch.service).
// NOT an OS reboot: it resets iox-roudi (clears the iceoryx shm leak behind
// Error 140) and keeps mqtt_node alive so the mower stays online. Refused with
// 409 while the mower is actively mowing/working unless `{ force: true }`.
dashboardRouter.post('/soft-restart/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const force = (req.body as { force?: boolean } | undefined)?.force === true;
  const blocked = softRestartBlockedReason(sn);
  if (blocked && !force) {
    res.status(409).json({ ok: false, error: blocked });
    return;
  }
  sendSoftRestart(sn);
  console.log(`[soft-restart] ${sn}: soft_restart dispatched (force=${force}, ${blocked ?? 'idle/charging'})`);
  res.json({ ok: true, message: 'soft restart dispatched; the mower goes offline ~30-60s then returns' });
});

// GET /api/dashboard/system/health — mDNS advertiser state, server uptime, per-mower cache status
dashboardRouter.get('/system/health', (_req: Request, res: Response) => {
  const advertisement = getActiveAdvertisement();

  const allEquipment = equipmentRepo.listAll();
  const mowers = allEquipment
    .filter(eq => !!eq.mower_sn)
    .map(eq => {
      const cached = deviceCache.get(eq.mower_sn);
      return {
        sn: eq.mower_sn,
        online: !!cached && cached.size > 0,
        sensorKeys: cached?.size ?? 0,
      };
    });

  const uptimeSec = Math.floor(process.uptime());
  const startedAt = new Date(Date.now() - uptimeSec * 1000).toISOString();

  res.json({
    mdns: {
      running: advertisement !== null,
      advertisement,
    },
    server: { uptimeSec, startedAt },
    mowers,
  });
});

// GET /api/dashboard/system/lora-status/:sn — cached LoRa pair + drift flag
// drift = true when this device's pair does not match its paired counterpart.
// Mower and charger MUST be on identical address+channel; mismatch = Error 8.
dashboardRouter.get('/system/lora-status/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const own = equipmentRepo.getLoraCache(sn);
  if (!own) {
    res.status(404).json({ error: 'no_lora_cache' });
    return;
  }

  // Find peer SN: equipment row pairs mower_sn + charger_sn.
  // findBySn matches on either mower_sn or charger_sn.
  const eq = equipmentRepo.findBySn(sn);
  let peerSn: string | null = null;
  if (eq && eq.mower_sn && eq.charger_sn) {
    peerSn = eq.mower_sn === sn ? eq.charger_sn : eq.mower_sn;
  }

  const peer = peerSn ? equipmentRepo.getLoraCache(peerSn) : undefined;

  let drift = false;
  if (peer) {
    drift =
      own.charger_address !== peer.charger_address ||
      own.charger_channel !== peer.charger_channel;
  }

  res.json({
    sn,
    pair: { address: own.charger_address ?? null, channel: own.charger_channel ?? null },
    peer: peer
      ? { sn: peerSn, address: peer.charger_address ?? null, channel: peer.charger_channel ?? null }
      : { sn: peerSn, address: null, channel: null },
    drift,
  });
});

// GET /api/dashboard/system/logs — in-memory MQTT log buffer with optional filtering
dashboardRouter.get('/system/logs', (req: Request, res: Response) => {
  const all = getRecentLogs();
  const { type, sn, direction } = req.query as Record<string, string | undefined>;

  const tailRaw = req.query.tail;
  let tail = 200;
  if (typeof tailRaw === 'string') {
    const n = parseInt(tailRaw, 10);
    if (Number.isFinite(n) && n > 0 && n <= 500) tail = n;
  }

  let filtered = all;
  if (type) filtered = filtered.filter((l) => l.type === type);
  if (sn) filtered = filtered.filter((l) => l.sn === sn);
  if (direction) filtered = filtered.filter((l) => l.direction === direction);

  const sliced = filtered.slice(-tail);
  res.json({ logs: sliced });
});

// GET /api/dashboard/devices — alle devices met online status en cached sensor waarden
// Toont alleen apparaten die gebonden zijn (in equipment tabel) of momenteel online zijn,
// gedepliceerd op SN (meest recente entry per SN)
dashboardRouter.get('/devices', (_req: Request, res: Response) => {
  const registry = deviceRepo.listLatestBySn() as DeviceRegistryRow[];

  const equipment = equipmentRepo.listAll();

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
  const loraCache = equipmentRepo.listLoraCache();
  const loraBySn = new Map<string, { address: number | null; channel: number | null }>();
  for (const lc of loraCache) {
    loraBySn.set(lc.sn, {
      address: lc.charger_address != null ? Number(lc.charger_address) : null,
      channel: lc.charger_channel != null ? Number(lc.charger_channel) : null,
    });
  }

  // Persisted settings uit device_settings (voor set_para_info cache)
  const settingsRows = deviceSettingsRepo.listAll();
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
      // Bepaal paired_with: het SN van de tegenpartij in dezelfde equipment record
      let pairedWith: string | null = null;
      if (eqRow) {
        const mySn = d.sn!;
        if (mySn === eqRow.mower_sn && eqRow.charger_sn) pairedWith = eqRow.charger_sn;
        else if (mySn === eqRow.charger_sn && eqRow.mower_sn?.startsWith('LFIN')) pairedWith = eqRow.mower_sn;
      }

      return {
        sn: d.sn!,
        macAddress: d.mac_address,
        lastSeen: d.last_seen,
        online: isDeviceOnline(d.sn!) || isDemoMode(d.sn!),
        deviceType: d.sn!.startsWith('LFIC') ? 'charger' as const : 'mower' as const,
        is_bound: boundSns.has(d.sn!),
        paired_with: pairedWith,
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
  const boundSnRows = equipmentRepo.listBoundSnForExistingUsers();

  const boundSns = new Set<string>();
  for (const r of boundSnRows) {
    if (r.mower_sn)   boundSns.add(r.mower_sn);
    if (r.charger_sn) boundSns.add(r.charger_sn);
  }

  // Meest recent geziene entry per SN uit device_registry
  const registry = deviceRepo.listLatestBySn() as DeviceRegistryRow[];

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
dashboardRouter.post('/bind-device', async (req: Request, res: Response) => {
  const { sn, name } = req.body as { sn?: string; name?: string };
  if (!sn) { res.status(400).json({ ok: false, error: 'sn required' }); return; }

  // Haal de enige gebruiker op — maak er één aan als die niet bestaat
  let user = userRepo.findFirst();
  if (!user) {
    const bcrypt = await import('bcrypt');
    const appUserId = `local_${Date.now()}`;
    const hash = await bcrypt.hash('admin', 10);
    userRepo.createIfMissing(appUserId, 'admin@local', hash, 'admin');
    user = userRepo.findFirst();
    if (!user) { res.status(500).json({ ok: false, error: 'Could not create user' }); return; }
    // Same is_admin gap as setup.ts /skip — createIfMissing skips the
    // is_admin column. Flip it on the actual stored row so the admin
    // page works on the very first login after a factory reset.
    userRepo.setRole(user.app_user_id, 'is_admin', true);
    userRepo.setRole(user.app_user_id, 'dashboard_access', true);
    console.log(`[dashboard] bind-device: auto-created local admin account`);
  }

  const isCharger = sn.startsWith('LFIC');
  const existing = equipmentRepo.findBySn(sn);

  if (existing) {
    equipmentRepo.updateUserAndNickName(existing.equipment_id, user.app_user_id, name ?? null);
  } else {
    // Check of er een incompleet equipment record is (charger zonder mower of vice versa)
    // zodat we charger + mower automatisch in hetzelfde record zetten
    const incomplete = equipmentRepo.findIncompleteByUserId(user.app_user_id);
    if (incomplete && isCharger && !incomplete.charger_sn) {
      equipmentRepo.updateChargerSn(incomplete.equipment_id, sn);
      console.log(`[dashboard] bind-device: added charger ${sn} to existing record ${incomplete.equipment_id}`);
    } else if (incomplete && !isCharger && incomplete.charger_sn && !incomplete.mower_sn?.startsWith('LFIN')) {
      equipmentRepo.updateMowerSn(incomplete.equipment_id, sn);
      console.log(`[dashboard] bind-device: added mower ${sn} to existing record ${incomplete.equipment_id}`);
    } else {
      const equipmentId = uuidv4();
      equipmentRepo.create({
        equipment_id: equipmentId,
        user_id: user.app_user_id,
        mower_sn: isCharger ? null as unknown as string : sn,
        charger_sn: isCharger ? sn : null,
        nick_name: name ?? null,
      });
    }
  }

  // Auto-pair: zoek een tegenpartij (charger↔mower) die al gebonden is maar nog niet gepaird
  // Match op LoRa address als beschikbaar, anders pair met het enige ongepaarde device
  const myEq = equipmentRepo.findBySn(sn);
  if (myEq) {
    const allEq = equipmentRepo.findByUserId(user.app_user_id) ?? [];
    const myIsComplete = isCharger
      ? myEq.mower_sn?.startsWith('LFIN')
      : !!myEq.charger_sn;

    if (!myIsComplete) {
      // Zoek een ongepaarde tegenpartij
      let peerSn: string | null = null;

      // Methode 1: match op LoRa address
      const lora = equipmentRepo.getLoraCache(sn);
      if (lora?.charger_address) {
        const allLora = equipmentRepo.listLoraCache();
        const peer = allLora.find(l =>
          l.charger_address === lora.charger_address &&
          l.sn !== sn &&
          l.sn.startsWith(isCharger ? 'LFIN' : 'LFIC')
        );
        if (peer) peerSn = peer.sn;
      }

      // Methode 2: als er maar 1 ongepaarde tegenpartij is, pair direct
      if (!peerSn) {
        const candidates = allEq.filter(e => {
          if (isCharger) return e.mower_sn?.startsWith('LFIN') && !e.charger_sn;
          return e.charger_sn?.startsWith('LFIC') && !e.mower_sn?.startsWith('LFIN');
        });
        if (candidates.length === 1) {
          peerSn = isCharger ? candidates[0].mower_sn! : candidates[0].charger_sn!;
        }
      }

      if (peerSn) {
        const peerEq = equipmentRepo.findBySn(peerSn);
        if (peerEq && peerEq.equipment_id !== myEq.equipment_id) {
          // Merge records: houd de mower record, voeg charger toe
          const mowerEqId = isCharger ? peerEq.equipment_id : myEq.equipment_id;
          const chargerEqId = isCharger ? myEq.equipment_id : peerEq.equipment_id;
          const chargerSn = isCharger ? sn : peerSn;
          const mowerSn = isCharger ? peerSn : sn;
          equipmentRepo.updateChargerSn(mowerEqId, chargerSn);
          equipmentRepo.deleteById(chargerEqId);
          // Sync LoRa cache — mower krijgt IDENTIEKE addr+channel als charger.
          // De oude "mower = charger.channel - 1" regel is aantoonbaar onjuist
          // (bewezen 22 apr 2026, working-lora-pair: beide devices op addr=718
          // ch=17). Mower en charger zitten op HETZELFDE LoRa-paar.
          const loraData = equipmentRepo.getLoraCache(chargerSn);
          if (loraData?.charger_address) {
            equipmentRepo.setLoraCache(
              mowerSn,
              loraData.charger_address,
              loraData.charger_channel ?? '16',
            );
          }
          console.log(`[dashboard] bind-device: auto-paired ${mowerSn} + ${chargerSn}`);
        }
      }
    }
  }

  console.log(`[dashboard] bind-device: sn=${sn} name=${name ?? '-'} gebonden aan user ${user.app_user_id}`);
  res.json({ ok: true });
});

// DELETE /api/dashboard/devices/:sn — verwijder een device uit alle stores.
// Vroeger ruimde dit alleen device_registry op, waardoor de prullenbak in de
// Home tab niets leek te doen voor stale LoRa-cache rijen (LFIC0001 etc).
// Nu: device_registry + equipment_lora_cache, en bij volledige equipment row
// ook de equipment-link zodat een uitgebonden device geen zombie wordt.
dashboardRouter.delete('/devices/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  deviceRepo.deleteBySn(sn);
  equipmentRepo.deleteLoraCache(sn);
  res.json({ ok: true });
});

// PATCH /api/dashboard/equipment/:sn/nickname — hernoem maaier (geen JWT)
//
// OpenNova app gebruikt vrijwel alle endpoints onder /api/dashboard/*; de
// /api/nova-user/equipment/updateEquipmentNickName variant vereist JWT en
// failt op stale cached tokens. Dit endpoint is consistent met de rest van
// dashboard-API en werkt direct na een rebuild zonder re-login. Returns 404
// als de SN niet bestaat in equipment.
dashboardRouter.patch('/equipment/:sn/nickname', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { nickname } = req.body as { nickname?: string };
  const eq = equipmentRepo.findByMowerSn(sn);
  if (!eq) { res.status(404).json({ error: 'Equipment not found' }); return; }
  if (!eq.user_id) { res.status(409).json({ error: 'Equipment has no owner' }); return; }
  equipmentRepo.updateNickNameByMowerSnAndUser(sn, eq.user_id, (nickname ?? '').trim() || null);
  res.json({ ok: true });
});

// PATCH /api/dashboard/equipment/:sn/mower-ip — sla maaier IP op voor SSH upload
dashboardRouter.patch('/equipment/:sn/mower-ip', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { ip } = req.body as { ip: string };
  if (!ip || typeof ip !== 'string') { res.status(400).json({ error: 'ip required' }); return; }
  const changes = equipmentRepo.updateMowerIp(sn, ip.trim());
  if (changes === 0) { res.status(404).json({ error: 'Maaier niet gevonden in equipment' }); return; }
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
    health: getDeviceHealth(sn),
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

// GET /api/dashboard/maps — alle kaarten (alle SNs), lokale meters
dashboardRouter.get('/maps', (_req: Request, res: Response) => {
  const rows = mapRepo.listAll() as MapRow[];

  const maps = rows.map(r => {
    let mapArea: LocalPoint[] = [];
    let mapMaxMin: Record<string, number> | null = null;

    if (r.map_area) {
      mapArea = JSON.parse(r.map_area);
      const xs = mapArea.map(p => p.x);
      const ys = mapArea.map(p => p.y);
      mapMaxMin = {
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys),
      };
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
// Dashboard converteert lokaal→GPS voor Leaflet rendering.
dashboardRouter.get('/maps/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  // findByMowerSn orders by updated_at DESC; re-sort to canonical slot order
  // (map0, map1, map2, ...) so the app's zone carousel reads Zone1 first
  // instead of whichever zone was saved most recently.
  const rows = mapRepo.findByMowerSn(sn).sort(compareMapRowsByCanonical);

  // Charger GPS ophalen — dashboard gebruikt dit voor local→GPS conversie
  let chargerGps = mapRepo.getChargerGps(sn);

  if (!chargerGps) {
    // Auto-detect: when the mower is currently docked (recharge_status
    // contains "charging"), the mower's GPS is the charger's GPS by
    // definition. Persist once so subsequent requests already have it.
    //
    // We do NOT require map_position to be near (0,0) — `charging_pose`
    // is set during mapping and can be any local-frame value (verified
    // live: LFIN1231000211 reports charging_pose = (-1.23, 0.50)).
    const sensors = deviceCache.get(sn);
    if (sensors) {
      const lat = parseFloat(sensors.get('latitude') ?? '');
      const lng = parseFloat(sensors.get('longitude') ?? '');
      // recharge_status is stored RAW in deviceCache as the integer string
      // (e.g. '0' = not charging, '1' = charging, '9' = charging variant).
      // The translated display 'Charging (9)' is computed at API serialise
      // time, not in the cache. Treat any non-zero positive integer as
      // "currently docked".
      const rechargeRaw = sensors.get('recharge_status') ?? '';
      const rechargeNum = parseInt(rechargeRaw, 10);
      const atDock = Number.isFinite(rechargeNum) && rechargeNum > 0;

      // Never persist (0,0): a docked mower without an RTK fix reports null
      // island, and a stored (0,0) used to freeze the anchor (getChargerGps
      // now treats it as unset, but skipping the write avoids the churn).
      const isNullIsland = Math.abs(lat) < 1e-3 && Math.abs(lng) < 1e-3;
      if (atDock && Number.isFinite(lat) && Number.isFinite(lng) && !isNullIsland) {
        mapRepo.setChargerGps(sn, lat, lng);
        chargerGps = { lat, lng };
        console.log(`[MAP] Auto-detected charger GPS for ${sn} from mower-at-dock: ${lat}, ${lng}`);
      }
    }
  }

  const maps = rows.map(r => {
    let mapArea: LocalPoint[] = [];
    let mapMaxMin: Record<string, number> | null = null;

    if (r.map_area) {
      mapArea = JSON.parse(r.map_area);
      const xs = mapArea.map(p => p.x);
      const ys = mapArea.map(p => p.y);
      mapMaxMin = {
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys),
      };
    }

    return {
      mapId: r.map_id,
      mapName: r.map_name,
      mapType: r.map_type ?? 'work',
      // canonicalName carries the firmware slot identifier (map0, map1, ...).
      // Issue #14 / #18: app needs this to map a user-selected work map to the
      // correct firmware `area` bitmask weight (slot N → 10^N: map0=1, map1=10,
      // map2=100; summed for multi-map) — sorting by updated_at and using array
      // index causes "select front, mow trampo".
      canonicalName: r.canonical_name ?? null,
      // fileName surfaces to the dashboard for charge-vs-inter-map unicom
      // detection in the channel-count badge (issue #28). Falls back to
      // canonicalName when canonical_name is populated but the legacy row
      // never had a separate file_name.
      fileName: r.file_name ?? null,
      mapArea,
      mapMaxMin,
      createdAt: r.created_at,
    };
  });

  // Charger orientatie + chargingPose uit ZIP map_info.json
  let chargerOrientation = 0;
  let chargingPose: { x: number; y: number; orientation: number } | null = null;
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
          const cp = info.charging_pose;
          if (cp && typeof cp.x === 'number' && typeof cp.y === 'number') {
            chargingPose = {
              x: cp.x,
              y: cp.y,
              orientation: typeof cp.orientation === 'number' ? cp.orientation : 0,
            };
            chargerOrientation = chargingPose.orientation;
          } else {
            chargerOrientation = cp?.orientation ?? 0;
          }
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }

  // Fallback to live dockPose when the ZIP value is missing or stale (0,0,0).
  // Mower captures map_position_x/y/orientation while docked — ground truth,
  // matches what the app uses via DeviceState.dockPose. Old `<sn>_latest.zip`
  // files can still hold charging_pose:{0,0,0} from sessions before proper
  // mapping; the live sensor reflects reality.
  if (!chargingPose || (chargingPose.x === 0 && chargingPose.y === 0 && chargingPose.orientation === 0)) {
    const dock = getDockPose(sn);
    if (dock && (dock.x !== 0 || dock.y !== 0)) {
      chargingPose = { x: dock.x, y: dock.y, orientation: dock.orientation };
      if (chargerOrientation === 0) chargerOrientation = dock.orientation;
    }
  }

  res.json({
    maps,
    chargerGps: chargerGps ? { lat: chargerGps.lat, lng: chargerGps.lng } : null,
    chargerOrientation,
    chargingPose,
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

// GET /api/dashboard/terrain/:sn — display-hoogtegrid (gzip TGR1) voor de
// 3D-terreinviewer. 404 zolang er nog geen enkele sessie geüpload is.
dashboardRouter.get('/terrain/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  if (!/^LFI[A-Z]\d+$/.test(sn)) { res.status(400).json({ error: 'invalid sn' }); return; }
  const tgmPath = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain', `${sn}.tgm`);
  if (!fs.existsSync(tgmPath)) {
    res.status(404).json({ error: 'geen terrein voor deze maaier' });
    return;
  }
  let display: Buffer;
  try {
    display = tgm1ToDisplayTgr1(fs.readFileSync(tgmPath));
  } catch (err) {
    console.error(`[TERRAIN] corrupt TGM-bestand voor ${sn}:`, err);
    res.status(500).json({ error: 'terreindata kon niet gelezen worden' });
    return;
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Encoding', 'gzip');
  res.send(zlib.gzipSync(display));
});

// GET /api/dashboard/planned-path/:sn — planned mowing path
// Requests via MQTT: {get_map_plan_path: {map_name: "all"}}
// Response cached from get_map_plan_path_respond
// Returns array of sub-paths, each being an array of {x, y} local meter points
const plannedPathCache = new Map<string, Array<{ id: string; points: Array<{ x: number; y: number }> }>>();

dashboardRouter.get('/planned-path/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const cached = plannedPathCache.get(sn);
  // Cloud-identiek: NOOIT proactief commando's sturen naar de maaier.
  // get_map_plan_path verstoorde mapping sessies (add_scan_map) doordat
  // het continu gepolld werd en de maaier uit mapping mode haalde.
  res.json({ paths: cached && cached.length > 0 ? cached : [] });
});

/** Parse and cache planned path from MQTT respond or file */
export function handlePlannedPathRespond(sn: string, data: Record<string, unknown>): void {
  try {
    const paths = parsePlannedPathJson(data);
    plannedPathCache.set(sn, paths);
    console.log(`[PLAN-PATH] Cached ${paths.length} sub-paths for ${sn}`);
  } catch (err) {
    console.error(`[PLAN-PATH] Parse error:`, err);
  }
}

// GET /api/dashboard/preview-path/:sn — preview cover path
// Requests via MQTT: {get_preview_cover_path: {map_name: "all"}}
// Response cached from get_preview_cover_path_respond (via our broker intercept)
const previewPathCache = new Map<string, Array<{ id: string; points: Array<{ x: number; y: number }> }>>();
const previewPathMetaCache = new Map<string, { source: 'mower'; cachedAt: number }>();

dashboardRouter.get('/preview-path/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const cached = previewPathCache.get(sn);
  const meta = previewPathMetaCache.get(sn);
  res.json({
    paths: cached && cached.length > 0 ? cached : [],
    source: cached && cached.length > 0 ? (meta?.source ?? 'cache') : 'none',
    cachedAt: meta?.cachedAt,
    ageMs: meta ? Date.now() - meta.cachedAt : undefined,
  });
});

/**
 * Decode a get_preview_cover_path_respond / get_map_plan_path_respond `value`
 * into the raw path object (e.g. {"1":{"0":"x y,x y,..."}}).
 *
 * Stock mqtt_node returns the file as a byte array under `value.data`
 * (List<int> → UTF-8 → JSON — confirmed in the Novabot app, blutter v2.4.0).
 * Our extended_commands.py backchannel returns the parsed object directly.
 * Handle both shapes.
 */
function decodePreviewCoverValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.data)) {
    try {
      const json = Buffer.from(v.data as number[]).toString('utf-8');
      const parsed = JSON.parse(json);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return v;
}

export function handlePreviewPathRespond(sn: string, data: Record<string, unknown>): void {
  try {
    const paths = parsePlannedPathJson(data);
    previewPathCache.set(sn, paths);
    previewPathMetaCache.set(sn, { source: 'mower', cachedAt: Date.now() });
    console.log(`[PREVIEW-PATH] Cached ${paths.length} sub-paths for ${sn}`);
  } catch (err) {
    console.error(`[PREVIEW-PATH] Parse error:`, err);
  }
}

function storedCoveragePlannerRadius(sn: string) {
  return selectCoveragePlannerRadius(deviceSettingsRepo.findBySn(sn));
}

// GET /api/dashboard/coverage-planner-radius/:sn - persisted planner radius
// used by the mower's coverage planner.
dashboardRouter.get('/coverage-planner-radius/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const selected = storedCoveragePlannerRadius(sn);
  res.json({
    ok: true,
    radius: selected.radius,
    source: selected.source,
    defaultRadius: DEFAULT_COVERAGE_PLANNER_RADIUS,
    min: MIN_COVERAGE_PLANNER_RADIUS,
    max: MAX_COVERAGE_PLANNER_RADIUS,
  });
});

// PUT /api/dashboard/coverage-planner-radius/:sn - store the radius and
// dispatch an extended command so OpenNova firmware writes
// coverage_planner_params.yaml on the mower.
dashboardRouter.put('/coverage-planner-radius/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const body = (req.body ?? {}) as { radius?: unknown; force?: unknown; applyToMower?: unknown; apply_to_mower?: unknown };
  const radius = parseCoveragePlannerRadius(body.radius);
  if (radius === null) {
    res.status(400).json({ ok: false, error: coveragePlannerRadiusError() });
    return;
  }

  const formatted = formatCoveragePlannerRadius(radius);
  if (!deviceCache.has(sn)) deviceCache.set(sn, new Map());
  deviceCache.get(sn)!.set(COVERAGE_PLANNER_RADIUS_KEY, formatted);
  deviceSettingsRepo.upsert(sn, COVERAGE_PLANNER_RADIUS_KEY, formatted);
  forwardToDashboard(sn, new Map([[COVERAGE_PLANNER_RADIUS_KEY, formatted]]));

  const shouldApplyToMower = (body.applyToMower ?? body.apply_to_mower) !== false;
  if (shouldApplyToMower) {
    publishExtendedCommand(sn, {
      set_coverage_planner_radius: {
        radius,
        force: body.force === true,
      },
    });
  }

  res.json({
    ok: true,
    radius,
    key: COVERAGE_PLANNER_RADIUS_KEY,
    mowerCommand: shouldApplyToMower ? 'sent' : 'skipped',
  });
});

// POST /api/dashboard/native-preview-path/:sn — removed from the standard
// server. Keep an explicit 410 so stale browser bundles or old admin pages
// reveal themselves instead of silently looking like a valid mower preview.
dashboardRouter.post('/native-preview-path/:sn', (_req: Request, res: Response) => {
  res.status(410).json({
    ok: false,
    source: 'removed',
    error: 'native coverage preview has been removed; use /api/dashboard/refresh-preview-path/:sn for mower-generated preview',
  });
});

// ── SAFETY: never trigger generate_preview_cover_path while a coverage
// task is active. De maaier antwoordt dan met error 128 ("Cannot preview
// when cover task working!!!") en breekt de huidige maai-sessie af. Dit
// werd eens uitgelokt door een race tussen de app's idle-refresh effect en
// een reconnect waardoor activity kort op 'idle' stond. Server-side guard
// voorkomt dat nu hard, ongeacht wat de app verstuurt.
function isCoverageActive(sn: string): boolean {
  const sensors = deviceCache.get(sn);
  if (!sensors) return false;
  const msg = sensors.get('msg') ?? '';
  const batteryState = (sensors.get('battery_state') ?? '').toUpperCase();
  // The mower only error-128s a generate_preview while a coverage task is
  // ACTUALLY working (or paused). A charging / docked / idle / finished mower is
  // safe to preview — even when it still reports its LAST "Mode:COVERAGE" +
  // task_mode:1 long after the task ended. That lingering state (e.g. parked on
  // the dock at "Work: FINISHED", work_status:Ready) was the source of the
  // false-positive "coverage task active" 409s ("Couldn't compute the path"), so
  // we no longer infer active-ness from task_mode / work_status / Mode:COVERAGE —
  // only from a live working Work: state.
  if (batteryState === 'CHARGING' || batteryState === 'FULL') return false;
  // Case-sensitive "Work:" so it ignores the lower-case "Prev work:" field in the
  // same msg; \s* so "Work:RUNNING" and "Work: RUNNING" both match.
  return /Work:\s*(RUNNING|COVERING|NAVIGATING|MOVING|AVOIDING|BOUNDARY_COVERING|PAUSE)/.test(msg);
}

// POST /api/dashboard/refresh-preview-path/:sn
// Server-side trigger: stuurt generate_preview_cover_path naar mqtt_node,
// wacht kort, vraagt daarna via onze extended_commands backchannel de JSON
// (die we NIET via mqtt_node kunnen ophalen vanwege de buffer overflow bug).
// Vult previewPathCache. Retourneert de parsed paths.
//
// Wordt o.a. aangeroepen door de OpenNova app zodra de user een maai-sessie
// voorbereidt, zodat de echte preview lijntjes getoond worden i.p.v. de
// default rechte strepen in de richting van path_direction.
dashboardRouter.post('/refresh-preview-path/:sn', async (req: Request, res: Response) => {
  const { sn } = req.params;
  const body = (req.body ?? {}) as {
    map_ids?: number | number[];
    cov_direction?: number;
    specify_direction?: boolean;
    // Custom polygon (pattern shape or edge-offset boundary). When given, the
    // preview is generated for this polygon via SPECIFIED_AREA instead of a
    // saved map — so pattern/offset previews actually render.
    polygon_area?: Array<{ latitude: number; longitude: number }>;
    cov_mode?: number;
  };
  const mapIds = body.map_ids ?? 1;
  const polygonArea = Array.isArray(body.polygon_area) && body.polygon_area.length >= 3
    ? body.polygon_area
    : undefined;
  const rawCovDirection = typeof body.cov_direction === 'number' ? body.cov_direction : undefined;
  const rawSpecifyDirection = typeof body.specify_direction === 'boolean' ? body.specify_direction : undefined;

  let covDirection: number | undefined;
  if (rawSpecifyDirection !== false && rawCovDirection !== undefined && rawCovDirection >= 0) {
    const normalizedDirection = Math.round(rawCovDirection);
    if (!Number.isFinite(normalizedDirection) || normalizedDirection > 180) {
      res.status(400).json({ ok: false, error: 'cov_direction must be between 0 and 180 degrees' });
      return;
    }
    covDirection = normalizedDirection;
  } else if (rawSpecifyDirection === true) {
    res.status(400).json({ ok: false, error: 'specify_direction requires cov_direction between 0 and 180 degrees' });
    return;
  }

  if (!isDeviceOnline(sn)) {
    res.status(503).json({ ok: false, error: 'device offline' });
    return;
  }

  // HARD GUARD — generate_preview_cover_path during an active coverage
  // task crashes the session with error 128 on the mower. Never send it.
  if (isCoverageActive(sn)) {
    console.log(`[PREVIEW-REFRESH] BLOCKED for ${sn} — coverage task active (would trigger error 128)`);
    const paths = previewPathCache.get(sn) ?? [];
    const meta = previewPathMetaCache.get(sn);
    res.status(409).json({
      ok: false,
      source: 'cache',
      error: 'coverage task active — generate_preview would error-128 the mower',
      paths,
      count: paths.length,
      cachedAt: meta?.cachedAt,
      ageMs: meta ? Date.now() - meta.cachedAt : undefined,
    });
    return;
  }

  try {
    const startedAt = Date.now();
    const {
      publishToDevice,
      publishToExtended,
      onExtendedResponse,
      offExtendedResponse,
      onDeviceResponse,
      offDeviceResponse,
    } = await import('../mqtt/mapSync.js');

    // 1. Trigger preview generation. The coverage planner is single-threaded: a
    // generate fired while a previous one is still planning returns result:1
    // ("couldn't compute the path"). Retry a few times with a FRESH cmd_num (the
    // firmware dedups on cmd_num, so a same-number retry is silently ignored) and
    // a short backoff so the planner can free up — this is what makes the preview
    // reliable on the first press instead of needing 2-3 tries.
    const genBase: Record<string, unknown> = {};
    if (polygonArea) {
      // SPECIFIED_AREA: plan the preview over the supplied polygon (pattern/offset).
      genBase.cov_mode = body.cov_mode ?? 1;
      genBase.polygon_area = polygonArea;
    } else {
      genBase.map_ids = mapIds;
    }
    if (covDirection !== undefined) genBase.cov_direction = covDirection;
    if (rawSpecifyDirection !== undefined && covDirection !== undefined) {
      genBase.specify_direction = rawSpecifyDirection;
    }

    const MAX_GEN_ATTEMPTS = 3;
    const GEN_RETRY_BACKOFF_MS = Number(process.env.PREVIEW_GEN_RETRY_BACKOFF_MS ?? 1500);
    let cmdNum = 0;
    let generateAckMs = 0;
    let ack: { ok: boolean; error?: string; timeout?: boolean } = { ok: false };
    for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt++) {
      cmdNum = (Date.now() & 0x7fffffff) + attempt; // fresh per attempt — firmware dedups on cmd_num
      const genPayload: Record<string, unknown> = { ...genBase, cmd_num: cmdNum };
      const generateAck = new Promise<{ ok: boolean; error?: string; timeout?: boolean }>((resolve) => {
        const timer = setTimeout(() => {
          offDeviceResponse(sn, handler);
          resolve({ ok: true, timeout: true });
        }, 6000);
        const handler = (data: Record<string, unknown>) => {
          const wrapped = data.type === 'generate_preview_cover_path_respond'
            ? data.message
            : data['generate_preview_cover_path_respond'];
          if (!wrapped || typeof wrapped !== 'object') return;
          clearTimeout(timer);
          offDeviceResponse(sn, handler);
          const resp = wrapped as { result?: number; error?: string; msg?: string };
          if (resp.result === 0 || resp.result === undefined) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: resp.error ?? resp.msg ?? `generate_preview_cover_path result ${resp.result}` });
          }
        };
        onDeviceResponse(sn, handler);
      });

      const ackStartedAt = Date.now();
      publishToDevice(sn, { generate_preview_cover_path: genPayload });
      console.log(`[PREVIEW-REFRESH] generate_preview_cover_path sent to ${sn} (attempt ${attempt}/${MAX_GEN_ATTEMPTS}): ${JSON.stringify(genPayload)}`);

      // 2. Match the stock app ordering: wait for generate_preview_cover_path_respond
      // before asking for get_preview_cover_path. A dropped ack (timeout) is treated
      // as success and we try the file anyway (preserves the previous fallback).
      ack = await generateAck;
      generateAckMs = Date.now() - ackStartedAt;
      if (ack.ok) break;
      console.warn(`[PREVIEW-REFRESH] generate failed for ${sn} (attempt ${attempt}/${MAX_GEN_ATTEMPTS}): ${ack.error} — ${attempt < MAX_GEN_ATTEMPTS ? 'retrying after backoff (planner likely busy)' : 'giving up'}`);
      if (attempt < MAX_GEN_ATTEMPTS) await new Promise((r) => setTimeout(r, GEN_RETRY_BACKOFF_MS));
    }
    if (!ack.ok) {
      res.status(502).json({
        ok: false,
        source: 'mower',
        error: ack.error ?? 'preview generation failed',
        cmd_num: cmdNum,
        generateAckMs,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    if (ack.timeout) {
      console.warn(`[PREVIEW-REFRESH] generate_preview_cover_path ack timeout for ${sn}; trying preview file anyway`);
    }

    // 3. Fetch the preview path content.
    //
    // Stock firmware has NO extended_commands.py backchannel, so we fetch it
    // exactly the way the real Novabot app does (verified in blutter v2.4.0):
    // a plain-MQTT get_preview_cover_path, decoding the byte-array `value.data`
    // response. This is what makes the preview work on stock firmware at all.
    //
    // OpenNova/custom firmware keeps the extended_commands.py backchannel, which
    // reads the file in Python and sidesteps the stock mqtt_node buffer overflow
    // that triggers on very large preview files (>~8 KB serialised byte-by-byte).
    const fetchStartedAt = Date.now();
    const isOpenNova = getMowerFileCapability(sn).isOpenNova;
    const content = await new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => {
        offExtendedResponse(sn, extHandler);
        offDeviceResponse(sn, devHandler);
        resolve(null);
      // 15s (> the broker app-path budget of 10s in broker.ts) — a large preview
      // path serialises byte-by-byte and can take 8-10s; an 8s cap timed out the
      // dashboard refresh while the app path (10s) still succeeded.
      }, 15000);

      // Stock firmware: plain-MQTT get_preview_cover_path_respond. The mower may
      // wrap it as {type, message} (charger-style) or {get_preview_cover_path_respond}
      // (mower-style) — accept both, then decode the byte-array value.
      const devHandler = (data: Record<string, unknown>) => {
        const wrapped = data.type === 'get_preview_cover_path_respond'
          ? data.message
          : data['get_preview_cover_path_respond'];
        if (!wrapped || typeof wrapped !== 'object') return;
        clearTimeout(timer);
        offDeviceResponse(sn, devHandler);
        const resp = wrapped as { result?: number; value?: unknown };
        resolve(resp.result === 0 || resp.result === undefined ? decodePreviewCoverValue(resp.value) : null);
      };

      // OpenNova/custom firmware: extended_commands.py backchannel.
      const extHandler = (data: Record<string, unknown>) => {
        const resp = data['get_preview_cover_path_respond'] as { result?: number; value?: unknown } | undefined;
        if (!resp) return;
        clearTimeout(timer);
        offExtendedResponse(sn, extHandler);
        resolve(resp.result === 0 || resp.result === undefined ? decodePreviewCoverValue(resp.value) : null);
      };

      if (isOpenNova) {
        onExtendedResponse(sn, extHandler);
        publishToExtended(sn, { get_preview_cover_path: { map_name: 'all' } });
      } else {
        onDeviceResponse(sn, devHandler);
        publishToDevice(sn, { get_preview_cover_path: { map_name: 'all' } });
      }
    });
    const fetchMs = Date.now() - fetchStartedAt;
    if (!content) {
      res.status(504).json({
        ok: false,
        source: 'mower',
        error: 'preview path fetch timed out (15s) — the map may be large/slow to serialise, or the mower did not return the path in time',
        cmd_num: cmdNum,
        ackTimeout: ack.timeout === true,
        generateAckMs,
        fetchMs,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    handlePreviewPathRespond(sn, content);
    const paths = previewPathCache.get(sn) ?? [];
    const meta = previewPathMetaCache.get(sn);
    if (paths.length === 0) {
      console.warn(`[PREVIEW-REFRESH] Empty preview path for ${sn} after generate cmd=${cmdNum} ackTimeout=${ack.timeout === true} fetchMs=${fetchMs}`);
      res.status(502).json({
        ok: false,
        source: 'mower',
        error: 'mower returned an empty preview path',
        paths,
        count: paths.length,
        cmd_num: cmdNum,
        ackTimeout: ack.timeout === true,
        generateAckMs,
        fetchMs,
        durationMs: Date.now() - startedAt,
        cachedAt: meta?.cachedAt,
      });
      return;
    }
    res.json({
      ok: true,
      source: 'mower',
      paths,
      count: paths.length,
      cmd_num: cmdNum,
      ackTimeout: ack.timeout === true,
      generateAckMs,
      fetchMs,
      durationMs: Date.now() - startedAt,
      cachedAt: meta?.cachedAt,
    });
  } catch (err) {
    console.error(`[PREVIEW-REFRESH] Error:`, err);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// POST /api/dashboard/refresh-plan-path/:sn — zelfde patroon voor live plan path.
// Gebruik tijdens mowing als je de echte paden (niet de preview) wil ophalen.
dashboardRouter.post('/refresh-plan-path/:sn', async (req: Request, res: Response) => {
  const { sn } = req.params;
  if (!isDeviceOnline(sn)) {
    res.status(503).json({ ok: false, error: 'device offline' });
    return;
  }
  try {
    const {
      publishToDevice, onDeviceResponse, offDeviceResponse,
      publishToExtended, onExtendedResponse, offExtendedResponse,
    } = await import('../mqtt/mapSync.js');
    // Stock firmware: plain-MQTT get_map_plan_path (like the app). OpenNova/custom
    // firmware: extended_commands.py backchannel (sidesteps the mqtt_node overflow
    // on large plan files). Same split as the preview fetch above.
    const isOpenNova = getMowerFileCapability(sn).isOpenNova;
    const content = await new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => {
        offExtendedResponse(sn, extHandler);
        offDeviceResponse(sn, devHandler);
        resolve(null);
      // 15s — a large plan path can take 8-10s, and the broker app-path allows 10s.
      }, 15000);
      const devHandler = (data: Record<string, unknown>) => {
        const wrapped = data.type === 'get_map_plan_path_respond'
          ? data.message
          : data['get_map_plan_path_respond'];
        if (!wrapped || typeof wrapped !== 'object') return;
        clearTimeout(timer);
        offDeviceResponse(sn, devHandler);
        const resp = wrapped as { result?: number; value?: unknown };
        resolve(resp.result === 0 || resp.result === undefined ? decodePreviewCoverValue(resp.value) : null);
      };
      const extHandler = (data: Record<string, unknown>) => {
        const resp = data['get_map_plan_path_respond'] as { result?: number; value?: unknown } | undefined;
        if (!resp) return;
        clearTimeout(timer);
        offExtendedResponse(sn, extHandler);
        resolve(resp.result === 0 || resp.result === undefined ? decodePreviewCoverValue(resp.value) : null);
      };
      if (isOpenNova) {
        onExtendedResponse(sn, extHandler);
        publishToExtended(sn, { get_map_plan_path: { map_name: 'all' } });
      } else {
        onDeviceResponse(sn, devHandler);
        publishToDevice(sn, { get_map_plan_path: { map_name: 'all' } });
      }
    });
    if (!content) {
      res.status(504).json({ ok: false, error: 'no plan path response within timeout' });
      return;
    }
    handlePlannedPathRespond(sn, content);
    const paths = plannedPathCache.get(sn) ?? [];
    res.json({ ok: true, paths, count: paths.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/** Parse {"1": {"0": "x y,x y,...", "100": "x y,..."}} format to array of sub-paths */
function parsePlannedPathJson(data: Record<string, unknown>): Array<{ id: string; points: Array<{ x: number; y: number }> }> {
  const paths: Array<{ id: string; points: Array<{ x: number; y: number }> }> = [];
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
  return paths;
}

// POST /api/dashboard/sensor-override/:sn — manually set sensor values (for local preferences)
// Writes to both in-memory cache (instant) AND device_settings DB (persistent across restarts).
dashboardRouter.post('/sensor-override/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const overrides = req.body as Record<string, string>;
  if (!overrides || typeof overrides !== 'object') { res.status(400).json({ error: 'body required' }); return; }
  const cache = deviceCache.get(sn);
  if (!cache) { deviceCache.set(sn, new Map()); }
  const snCache = deviceCache.get(sn)!;
  for (const [k, v] of Object.entries(overrides)) {
    snCache.set(k, String(v));
    // Persist to DB so settings survive container restart
    deviceSettingsRepo.upsert(sn, k, String(v));
  }
  res.json({ ok: true });
});

// GET /api/dashboard/device-settings/:sn — read the user's SAVED settings
// (device_settings table, written by the sensor-override POST above). The app's
// Mower Settings screen reads these as the source of truth because the mower
// firmware does NOT persist set_para_info over a reconnect — it reverts to
// provisioning defaults, so the LIVE sensor frame can't be trusted to reflect
// what the user actually chose. Returns a flat key->value map.
dashboardRouter.get('/device-settings/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const rows = deviceSettingsRepo.findBySn(sn);
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;
  res.json({ ok: true, settings });
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
// Accepteert lokale meters {x,y} direct (dashboard converteert GPS→lokaal zelf)
// OF GPS {lat,lng} voor backwards compatibility (wordt geconverteerd)
dashboardRouter.post('/maps/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const { mapName, mapArea, mapType } = req.body as {
    mapName?: string;
    mapArea?: Array<{ x?: number; y?: number; lat?: number; lng?: number }>;
    mapType?: string;
  };

  if (!mapArea || !Array.isArray(mapArea) || mapArea.length < 3) {
    res.status(400).json({ error: 'mapArea met minimaal 3 punten is vereist' });
    return;
  }

  // Detecteer of input lokale meters of GPS is
  const isLocal = mapArea[0] && 'x' in mapArea[0] && mapArea[0].x !== undefined;
  let localPoints: LocalPoint[];

  if (isLocal) {
    localPoints = mapArea.map(p => ({ x: p.x!, y: p.y! }));
  } else {
    // GPS input — converteer naar lokaal
    const chargerGps = mapRepo.getChargerGps(sn);
    if (!chargerGps) {
      res.status(400).json({ error: 'Charger positie onbekend — plaats eerst de charger op de kaart' });
      return;
    }
    localPoints = mapArea.map(p => gpsToLocal({ lat: p.lat!, lng: p.lng! }, chargerGps));
  }

  const bounds = {
    minX: Math.min(...localPoints.map(p => p.x)),
    maxX: Math.max(...localPoints.map(p => p.x)),
    minY: Math.min(...localPoints.map(p => p.y)),
    maxY: Math.max(...localPoints.map(p => p.y)),
  };

  const typeSlug = mapType && ['work', 'obstacle', 'unicom'].includes(mapType) ? mapType : 'work';
  const mapId = `dashboard_${typeSlug}_${Date.now()}`;

  mapRepo.create({
    map_id: mapId,
    mower_sn: sn,
    map_name: mapName ?? null,
    map_type: typeSlug,
    map_area: JSON.stringify(localPoints),
    map_max_min: JSON.stringify(bounds),
  });

  res.json({
    ok: true,
    map: {
      mapId,
      mapName: mapName ?? null,
      mapType: typeSlug,
      mapArea: localPoints,
      mapMaxMin: bounds,
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
    mapArea?: Array<{ x?: number; y?: number; lat?: number; lng?: number }>;
  };

  const row = mapRepo.findByIdAndMower(mapId, sn);
  if (!row) {
    res.status(404).json({ error: 'Kaart niet gevonden' });
    return;
  }

  // Update polygon punten als meegegeven
  // Accepteert lokale meters {x,y} direct OF GPS {lat,lng} (backwards compat)
  if (mapArea && Array.isArray(mapArea) && mapArea.length >= 3) {
    const isLocal = 'x' in mapArea[0] && mapArea[0].x !== undefined;
    let localPoints: LocalPoint[];

    if (isLocal) {
      localPoints = mapArea.map(p => ({ x: p.x!, y: p.y! }));
    } else {
      const chargerGps = mapRepo.getChargerGps(sn);
      if (!chargerGps) {
        res.status(400).json({ error: 'Charger positie onbekend' });
        return;
      }
      localPoints = mapArea.map(p => gpsToLocal({ lat: p.lat!, lng: p.lng! }, chargerGps));
    }

    const bounds = {
      minX: Math.min(...localPoints.map(p => p.x)),
      maxX: Math.max(...localPoints.map(p => p.x)),
      minY: Math.min(...localPoints.map(p => p.y)),
      maxY: Math.max(...localPoints.map(p => p.y)),
    };
    mapRepo.updateAreaAndBoundsByIdAndMower(
      mapId,
      sn,
      JSON.stringify(localPoints),
      JSON.stringify(bounds),
    );
  }

  // Update naam als meegegeven
  if (mapName !== undefined) {
    mapRepo.updateNameByIdAndMower(mapId, sn, mapName ?? null);
  }

  res.json({ ok: true });

  // Auto-push naar maaier als polygon is gewijzigd
  if (mapArea) autoPushMapsInBackground(sn);
});

// DELETE /api/dashboard/maps/:sn/:mapId — verwijder een kaart (incl. bijbehorende obstakels en unicom-kanalen)
dashboardRouter.delete('/maps/:sn/:mapId', (req: Request, res: Response) => {
  const { sn, mapId } = req.params;

  const row = mapRepo.findByIdAndMower(mapId, sn);
  if (!row) {
    res.status(404).json({ error: 'Kaart niet gevonden' });
    return;
  }

  // Block delete when mower offline: otherwise the server-side DB row is
  // gone but the mower's csv_file/ still holds the map, so the next
  // sync_map upload silently re-creates it ("ghost map" reappearing
  // after a fresh mapping session — live bug observed sandstroem
  // 2026-05-13). The delete_map MQTT command has to actually reach the
  // mower to clean its disk; without that we end up with a permanent
  // desync. Force the operator to wait until the mower is reachable.
  const force = req.query.force === '1' || (req.body as { force?: boolean })?.force === true;
  if (!isDeviceOnline(sn) && !force) {
    res.status(409).json({
      error: 'mower offline — delete needs an online mower so it can wipe the map from disk',
      offline: true,
      mowerSn: sn,
    });
    return;
  }

  const deleted = mapRepo.deleteWithCascade(mapId, sn);

  // STORAGE_PATH env var lands the ZIPs under e.g. /data/storage/maps in Docker.
  // The old code used a cwd-relative path (./storage/maps) which silently
  // skipped unlink when the server runs from /app/server, leaving orphaned
  // ZIPs on disk after a delete.
  const mapsStorage = path.resolve(process.env.STORAGE_PATH ?? './storage', 'maps');
  const removedFiles = new Set<string>();
  for (const d of deleted) {
    if (!d.file_name || removedFiles.has(d.file_name)) continue;
    // Alleen unlinken als het bestand niet nog door een andere (niet-verwijderde) row wordt gedeeld
    const stillReferenced = mapRepo.findByMowerSn(sn).some(r => r.file_name === d.file_name);
    if (stillReferenced) continue;
    removedFiles.add(d.file_name);
    const filePath = path.join(mapsStorage, d.file_name);
    if (existsSync(filePath)) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
    // Also drop the `<SN>_latest.zip` pointer when we wipe the last map row,
    // otherwise queryEquipmentMap keeps serving a stale ZIP with the deleted map.
    const remaining = mapRepo.findByMowerSn(sn);
    if (remaining.length === 0) {
      const latest = path.join(mapsStorage, `${sn}_latest.zip`);
      if (existsSync(latest)) {
        try { unlinkSync(latest); } catch { /* ignore */ }
      }
    }
  }

  // Clear in-memory caches so the app stops drawing the deleted map's
  // coverage / preview paths and live trail. Without this the MapScreen
  // keeps the planned-path overlay (the grey ghost shape) until the
  // server is restarted.
  plannedPathCache.delete(sn);
  previewPathCache.delete(sn);
  clearLocalTrail(sn);
  clearGpsTrail(sn);

  console.log(`[DELETE] ${sn}: cascade verwijderd ${deleted.length} row(s) (root: ${row.map_name ?? row.file_name ?? mapId})`);
  res.json({ ok: true, deleted: deleted.length });

  // Tell the mower to drop the map from its own state. Without this the
  // firmware keeps reporting map_num=1 + current_map_ids=1, the sensor
  // cache stays stale, and HomeScreen / coverage checks keep behaving as
  // if the map still exists even though the DB is empty.
  //
  // Payload shape matches the official Novabot app's delete flow
  // (blutter: lawn_page/logic.dart → {delete_map:{map_name:"map0"}}).
  // We use row.map_name when present, else fall back to 'map0'.
  if (isDeviceOnline(sn) && row.map_name) {
    const mapName = row.map_name;
    publishToDevice(sn, { delete_map: { map_name: mapName, cmd_num: getNextCmdNum(sn) } });
    console.log(`[DELETE] ${sn}: delete_map MQTT sent for ${mapName}`);
  }

  // Notify connected dashboard/app clients so they can refetch without
  // waiting for the next mower sensor update.
  emitMapsChanged(sn, mapId);

  // Auto-push naar maaier (bijgewerkte kaarten zonder de verwijderde)
  autoPushMapsInBackground(sn);
});

// ── Map editing (spec: 2026-06-10-map-obstacle-editing-design.md) ──────────
dashboardRouter.get('/maps/:sn/edit/geometry', (req: Request, res: Response) => {
  try {
    res.json(getEditGeometry(req.params.sn));
  } catch (err) {
    console.error('[MAP-EDIT] geometry', req.params.sn, err);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

dashboardRouter.put('/maps/:sn/edit/draft', (req: Request, res: Response) => {
  try {
    const { canonical, mapType, parentMap, points, deleted } = req.body as {
      canonical?: string; mapType?: 'work' | 'obstacle'; parentMap?: string;
      points?: { x: number; y: number }[]; deleted?: boolean;
    };
    const result = saveDraft(req.params.sn, { canonical, mapType, parentMap, points, deleted });
    if (!result.ok) { res.status(400).json({ ok: false, error: result.error }); return; }
    res.json({ ok: true, canonical: result.canonical });
  } catch (err) {
    console.error('[MAP-EDIT] draft', req.params.sn, err);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

dashboardRouter.delete('/maps/:sn/edit/drafts', (req: Request, res: Response) => {
  try {
    discardDrafts(req.params.sn);
    res.json({ ok: true });
  } catch (err) {
    console.error('[MAP-EDIT] drafts', req.params.sn, err);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

dashboardRouter.post('/maps/:sn/edit/apply', async (req: Request, res: Response) => {
  try {
    const result = await applyEdits(req.params.sn);
    if (!result.ok) {
      const status = result.reason === 'validation' ? 422
        : result.reason === 'no_changes' ? 400
        : result.reason === 'offline' || result.reason === 'busy' || result.reason === 'not_docked' || result.reason === 'locked' ? 409 : 502;
      const body = result.reason === 'not_docked'
        ? { ...result, error: 'Kaart wijzigen kan alleen als de maaier op het dock staat te laden.', msgKey: 'mapEditErrNotDocked' }
        : result;
      res.status(status).json(body);
      return;
    }
    res.json(result);
  } catch (err) {
    console.error(`[MAP-EDIT] apply ${req.params.sn}:`, err);
    res.status(500).json({ ok: false, reason: 'bundle_failed', error: (err as Error).message });
  }
});

dashboardRouter.post('/maps/:sn/edit/revert', async (req: Request, res: Response) => {
  try {
    const result = await revertEdits(req.params.sn);
    if (!result.ok) {
      const status = result.reason === 'no_version' ? 404
        : result.reason === 'offline' || result.reason === 'busy' || result.reason === 'not_docked' || result.reason === 'locked' ? 409 : 502;
      const body = result.reason === 'not_docked'
        ? { ...result, error: 'Kaart terugzetten kan alleen als de maaier op het dock staat te laden.', msgKey: 'mapEditErrNotDocked' }
        : result;
      res.status(status).json(body);
      return;
    }
    res.json(result);
  } catch (err) {
    console.error(`[MAP-EDIT] revert ${req.params.sn}:`, err);
    res.status(500).json({ ok: false, reason: 'bundle_failed', error: (err as Error).message });
  }
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

// GET /api/dashboard/maps/:sn/download-zip — download ZIP (auto-genereer als nodig)
dashboardRouter.get('/maps/:sn/download-zip', (req: Request, res: Response) => {
  const { sn } = req.params;
  let zipPath = path.resolve(`storage/maps/${sn}.zip`);

  // Auto-genereer als de ZIP niet bestaat of verouderd is
  if (!existsSync(zipPath)) {
    try {
      const generated = generateMapZipFromDb(sn, 0);
      if (!generated) {
        res.status(404).json({ error: 'Geen kaarten gevonden voor dit apparaat' });
        return;
      }
      zipPath = generated;
    } catch (err) {
      res.status(500).json({ error: 'ZIP generatie mislukt', details: String(err) });
      return;
    }
  }

  res.download(zipPath, `${sn}.zip`);
});

// ── Sync-pull: mower-initiated map fetch (replaces SFTP push) ────────────────
// The mower's extended_commands.py polls / gets pinged on MQTT and calls this
// endpoint to pick up the latest ZIP. No SSH needed — the mower downloads over
// plain HTTP inside the same LAN as its MQTT broker.

// GET /api/dashboard/maps/:sn/sync-info — cheap HEAD-like check, returns MD5 +
// charger GPS so the mower can decide whether to re-download and generate pos.json.
//
// Also returns the polygon's canonical `charging_pose` (Novabot-aev) when
// available — used by the mower's extended sync_map handler to write
// charging_station.yaml after restore-and-realign. Old mowers ignore unknown
// fields, so this is backwards-compatible.
dashboardRouter.get('/maps/:sn/sync-info', async (req: Request, res: Response) => {
  const { sn } = req.params;
  try {
    // Match /sync-zip: prefer the enriched ZIP so the md5 we advertise here
    // matches the bytes the mower will actually pull. Without this the mower
    // sees stale-ETag mismatches and downloads twice (or worse, returns 304
    // when content actually changed).
    const { regenerateLatestZipFromBackup } = await import('../services/mapBackup.js');
    const zipPath = regenerateLatestZipFromBackup(sn) ?? generateMapZipFromDb(sn, 0);
    if (!zipPath) { res.status(404).json({ error: 'no maps' }); return; }

    const { createHash } = await import('crypto');
    const { readFileSync } = await import('fs');
    const md5 = createHash('md5').update(readFileSync(zipPath)).digest('hex');

    // Charger GPS (live cache → map_calibration → mower snapshot)
    const eqRow = equipmentRepo.findByMowerSn(sn);
    let charger: GpsPoint | null = null;
    if (eqRow?.charger_sn) {
      const snap = getDeviceSnapshot(eqRow.charger_sn);
      const lat = parseFloat(snap?.latitude ?? '');
      const lng = parseFloat(snap?.longitude ?? '');
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) charger = { lat, lng };
    }
    if (!charger) charger = mapRepo.getChargerGps(sn);
    if (!charger) {
      const mowerSnap = getDeviceSnapshot(sn);
      const lat = parseFloat(mowerSnap?.latitude ?? '');
      const lng = parseFloat(mowerSnap?.longitude ?? '');
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) charger = { lat, lng };
    }

    // Polygon anchor (canonical charger pose from unicom CSV first point).
    // When present, posJson is offset so `mower at charger → map_position == anchor`,
    // and `charging_pose` is published for the mower to write into yaml.
    const { getPolygonAnchor } = await import('../services/anchor.js');
    const anchor = getPolygonAnchor(sn, deviceCache.get(sn));

    res.json({
      md5,
      sizeBytes: readFileSync(zipPath).length,
      posJson: charger ? generatePosJson(charger, anchor ? { x: anchor.x, y: anchor.y } : null) : null,
      charging_pose: anchor
        ? { x: anchor.x, y: anchor.y, orientation: anchor.orientation }
        : null,
      // Mower will hit /api/dashboard/maps/:sn/sync-zip to pull the bytes
      zipUrl: `/api/dashboard/maps/${encodeURIComponent(sn)}/sync-zip`,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/dashboard/maps/:sn/sync-zip — actual ZIP bytes with MD5 ETag.
// Mower sends If-None-Match to skip download when unchanged.
//
// Use the *enriched* ZIP from regenerateLatestZipFromBackup (which writes
// the polygon-derived charger anchor into csv_file/map_info.json) when
// available. Falls back to the bare generateMapZipFromDb output (which
// hard-codes charging_pose to (0, 0, theta) — the legacy "charger is the
// origin" assumption that breaks novabot_mapping when the actual dock pose
// is non-zero, e.g. -1.21, 0.48 on LFIN1231000211).
dashboardRouter.get('/maps/:sn/sync-zip', async (req: Request, res: Response) => {
  const { sn } = req.params;
  try {
    const { regenerateLatestZipFromBackup } = await import('../services/mapBackup.js');
    const enrichedPath = regenerateLatestZipFromBackup(sn);
    const zipPath = enrichedPath ?? generateMapZipFromDb(sn, 0);
    if (!zipPath) { res.status(404).json({ error: 'no maps' }); return; }

    const { createHash } = await import('crypto');
    const { readFileSync } = await import('fs');
    const buf = readFileSync(zipPath);
    const md5 = createHash('md5').update(buf).digest('hex');
    const etag = `"${md5}"`;

    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader('ETag', etag);
    res.setHeader('X-Map-Md5', md5);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(buf.length));
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── UTM conversie voor pos.json ──────────────────────────────────────────────
function generatePosJson(
  charger: GpsPoint,
  anchor?: { x: number; y: number } | null,
): Record<string, unknown> {
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

  const xCharger = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T ** 2 + 72 * C - 58 * ePrime2) * A ** 5 / 120) + 500000;
  const yCharger = k0 * (M + N * Math.tan(latRad) * (A ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24 + (61 - 58 * T + T ** 2 + 600 * C - 330 * ePrime2) * A ** 6 / 720));

  // Default behaviour: utm_origin = charger UTM, wgs84_origin = charger lat/lng.
  // When an anchor is supplied the map_frame origin is offset from the charger
  // by -anchor (so when mower is physically at the charger, its map_position
  // reads as `anchor` instead of (0, 0)). This is the polygon-anchor restore
  // path used by /restore-and-realign — keeps the polygon's coordinate system
  // intact even after RTK reference drift.
  const utmX = xCharger - (anchor?.x ?? 0);
  const utmY = yCharger - (anchor?.y ?? 0);

  // Reverse-project (utmX, utmY) → lat/lng. Use a small linear approximation
  // around the charger pose: dy ≈ d_lat * 111132m, dx ≈ d_lng * 111132m * cos(lat).
  // For typical anchor offsets (≤ 5 m) this matches Snyder reverse to <1cm
  // — far below RTK noise floor. Skipping the full reverse series keeps the
  // function a single page of math.
  let originLat = lat;
  let originLng = lng;
  if (anchor && (anchor.x !== 0 || anchor.y !== 0)) {
    const M_PER_DEG_LAT = 111132.954;
    const M_PER_DEG_LNG = 111132.954 * Math.cos(latRad);
    originLat = lat - (anchor.y / M_PER_DEG_LAT);
    originLng = lng - (anchor.x / M_PER_DEG_LNG);
  }

  return {
    time_stamp: Date.now() / 1000,
    utm_origin: { utm_zone: zone, x: utmX, y: utmY, z: 0 },
    wgs84_origin: { latitude: originLat, longitude: originLng },
  };
}

// ── Auto-push kaarten naar maaier (fire-and-forget) ─────────────────────────
// Wordt aangeroepen na map create/update/delete zodat de maaier altijd up-to-date is.
// Zoekt zelf de charger GPS op via dezelfde fallback chain als de endpoint.
async function autoPushMapsInBackground(sn: string): Promise<void> {
  // Update the on-disk "<SN>_latest.zip" and ping the mower over MQTT — the
  // mower's extended_commands.py handles the actual pull + install. This path
  // is SSH-free and works regardless of mower IP/mDNS availability.
  try {
    const zipPath = generateMapZipFromDb(sn, 0);
    if (zipPath) {
      const mapsStorage = path.resolve(process.env.STORAGE_PATH ?? './storage', 'maps');
      const latest = path.join(mapsStorage, `${sn}_latest.zip`);
      try { copyFileSync(zipPath, latest); } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn(`[AUTO-PUSH] ZIP regenerate fout voor ${sn}:`, err);
  }

  // MQTT kick: extended_commands.py on the mower subscribes to
  // novabot/extended/<SN> and will pull the new ZIP from our sync-info/sync-zip
  // endpoints. No SSH, no mower-IP lookup needed.
  try {
    const { publishToExtended } = await import('../mqtt/mapSync.js');
    publishToExtended(sn, { sync_map: {} });
    console.log(`[AUTO-PUSH] MQTT sync_map kick sent to ${sn}`);
  } catch (err) {
    console.warn(`[AUTO-PUSH] MQTT trigger fout voor ${sn}:`, err);
  }
}

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
  const workMaps = mapRepo.findByMowerSnAndType(sn, 'work');
  const mapName = workMaps[0]?.map_name || 'map0';

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

// Re-anchor the charger pose from the mower's live localization. Reads the
// latest map_position from the sensor cache, validates it hard (no 0/0/0, no
// bad localization state, no report_state_robot x==y bug), pushes
// `recalibrate_charging_pose` to the mower (rewrites map_info.json in csv_file/
// + x3_csv_file/), and on success ALSO patches the server's `<sn>_latest.zip`
// map_info.json + persists the theta. The ZIP patch is essential: the app's
// queryEquipmentMap sources the charger MARKER from that ZIP, not the DB, so
// without it the app keeps drawing the stale charger after recalibration.
// Shared by the operator endpoint and the re-anchor 'dock' action.
async function recalibrateChargingPoseFromCache(
  sn: string,
  opts: { force?: boolean },
): Promise<{ ok: boolean; httpStatus: number; body: Record<string, unknown>; pose?: { x: number; y: number; theta: number } }> {
  if (!isDeviceOnline(sn)) {
    return { ok: false, httpStatus: 404, body: { ok: false, error: 'Device is offline' } };
  }

  const sensors = deviceCache.get(sn);
  if (!sensors) {
    return { ok: false, httpStatus: 404, body: { ok: false, error: 'No sensor data cached for this mower' } };
  }

  // CRITICAL — use `map_position_*` from report_state_timer_data, NOT
  // `x/y/theta` from report_state_robot. Stock mqtt_node has a bug where
  // report_state_robot.y mirrors x verbatim (both fields equal), which
  // corrupts the charger pose (y becomes wrong). Verified live on
  // LFIN1231000211 (2026-04-23): robot.x==robot.y, but
  // timer_data.localization.map_position reports distinct x/y.
  const xRaw = sensors.get('map_position_x');
  const yRaw = sensors.get('map_position_y');
  const thetaRaw = sensors.get('map_position_orientation');
  if (xRaw == null || yRaw == null || thetaRaw == null) {
    return { ok: false, httpStatus: 400, body: {
      ok: false,
      error: 'Mower map_position not yet reported — need a report_state_timer_data message first. Try again in ~5s.',
    } };
  }
  const x = Number(xRaw);
  const y = Number(yRaw);
  const theta = Number(thetaRaw);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(theta)) {
    return { ok: false, httpStatus: 400, body: { ok: false, error: `Invalid pose: x=${xRaw} y=${yRaw} theta=${thetaRaw}` } };
  }

  // Critical — refuse (0, 0, 0). Stock firmware reports map_position as
  // (0, 0, 0) when localization_state is "Not initialized" (placeholder
  // value). Writing that as the charger pose corrupts the map frame and
  // makes the mower drive off-target. Live evidence:
  //   sensors{ localization_state: "Not initialized", map_position_*: 0 }
  // Reproduced 2026-05-02 on LFIN1231000211.
  if (x === 0 && y === 0 && theta === 0) {
    return { ok: false, httpStatus: 400, body: {
      ok: false,
      error: 'Mower reported (0, 0, 0) — placeholder for uninitialized localization. Drive the mower a short distance off the dock so localization initializes (heading discovery), let it return to dock, then retry.',
      hint: 'Stock firmware needs a drive-back cycle before localization is valid. While docked at boot, map_position is always zero.',
    } };
  }

  // Hard guard on localization state — refuse known-bad states. Stock
  // firmware reports a mix of literal strings (NOT_INITIALIZED, INITIALIZING,
  // INITIALIZED, LOST) and free-form labels (RUNNING) depending on the
  // active node. The server's translateLocalization() only normalises a
  // subset; anything else passes through verbatim. We allow-pass anything
  // that is NOT explicitly bad — combined with the (0, 0, 0) refusal above
  // this is sufficient (a real localized pose is non-zero).
  const locState = (sensors.get('localization_state') ?? '').toString();
  const locBad = /^(not[ _]?initialized|initializing|lost|failed|error)$/i.test(locState) || locState === '';
  if (locBad) {
    return { ok: false, httpStatus: 400, body: {
      ok: false,
      error: `Mower localization is "${locState || 'unknown'}". Pose values are not trustworthy yet. Drive the mower briefly off the dock, return, then retry.`,
      localization_state: locState,
    } };
  }

  // Defensive: if somehow x and y are bit-identical the caller hit the
  // report_state_robot bug upstream. Refuse the write.
  if (xRaw === yRaw && x !== 0) {
    return { ok: false, httpStatus: 400, body: {
      ok: false,
      error: `Suspicious pose — x and y are exactly equal (${x}). Mower firmware is reporting bogus localization. Wait for a fresh timer_data update and retry.`,
    } };
  }

  // Safety: caller must confirm by passing force=true OR mower must be docked.
  const batteryState = (sensors.get('battery_state') ?? '').toUpperCase();
  const onDockNow = batteryState === 'CHARGING';
  if (!onDockNow && !opts.force) {
    return { ok: false, httpStatus: 400, body: {
      ok: false,
      error: `Battery state is '${batteryState}', not CHARGING. Put mower on dock first, or POST with {"force": true} to override.`,
      batteryState,
    } };
  }

  // Wire up extended-response listener BEFORE publishing to avoid race.
  const { publishToExtended, onExtendedResponse, offExtendedResponse } = await import('../mqtt/mapSync.js');

  const result = await new Promise<{ ok: boolean; respond?: Record<string, unknown>; timeout?: boolean }>((resolve) => {
    let settled = false;
    const handler = (data: Record<string, unknown>) => {
      const respond = data.recalibrate_charging_pose_respond as Record<string, unknown> | undefined;
      if (!respond) return;
      if (settled) return;
      settled = true;
      offExtendedResponse(sn, handler);
      resolve({ ok: respond.result === 0, respond });
    };
    onExtendedResponse(sn, handler);
    publishToExtended(sn, { recalibrate_charging_pose: { x, y, theta } });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      offExtendedResponse(sn, handler);
      resolve({ ok: false, timeout: true });
    }, 8000);
  });

  console.log(`[CALIBRATE-POSE] ${sn}: x=${x} y=${y} theta=${theta} result=${JSON.stringify(result)}`);
  if (result.timeout) {
    return { ok: false, httpStatus: 504, body: { ok: false, error: 'Mower did not respond within 8s', pose: { x, y, theta } }, pose: { x, y, theta } };
  }

  let zipPatched = false;
  if (result.ok) {
    // Persist the operator-confirmed theta so subsequent sync_map / regenerate
    // calls do NOT clobber the mower yaml with a freshly-drifted live IMU
    // reading. Without this, getPolygonAnchor falls back to the live sensor
    // value, which differs by tens of degrees on every reboot / drive cycle
    // and makes the mower miss the dock or drive into off-polygon obstacles.
    mapRepo.setPolygonChargingOrientation(sn, theta);
    // Sync the app-facing charger marker (read from `<sn>_latest.zip`, not the
    // DB polygon) so queryEquipmentMap immediately reflects the re-anchor.
    zipPatched = patchLatestZipChargingPose(sn, { x, y, orientation: theta });
    console.log(`[CALIBRATE-POSE] ${sn}: latest-zip charging_pose patched=${zipPatched}`);
  }

  return {
    ok: result.ok,
    httpStatus: 200,
    body: { ok: result.ok, pose: { x, y, theta }, zipPatched, respond: result.respond },
    pose: { x, y, theta },
  };
}

// POST /api/dashboard/maps/:sn/recalibrate-charging-pose — overschrijf
// map_info.json charging_pose met de huidige gerapporteerde mower pose.
// Gebruik scenario: na ZIP-restore of post-heading-discovery blijkt het
// map-frame gedraaid/verschoven t.o.v. de fysieke charger. Mower duwt
// fysiek op dock, battery_state == CHARGING, dan triggert user dit endpoint.
// Server leest de laatste x/y/theta uit de sensor cache en stuurt
// extended_command `recalibrate_charging_pose` met die waarden. De mower
// schrijft het naar csv_file/ én x3_csv_file/ map_info.json.
dashboardRouter.post('/maps/:sn/recalibrate-charging-pose', async (req: Request, res: Response) => {
  const { sn } = req.params;
  const { force } = req.body as { force?: boolean };
  const out = await recalibrateChargingPoseFromCache(sn, { force: force === true });
  res.status(out.httpStatus).json(out.body);
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

      mapRepo.create({
        map_id: mapId,
        mower_sn: sn,
        map_name: `Imported map${area.mapIndex}`,
        map_area: JSON.stringify(points),
        map_max_min: JSON.stringify(bounds),
      });
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

      mapRepo.create({
        map_id: mapId,
        mower_sn: sn,
        map_name: `Uploaded map ${area.mapIndex}`,
        map_area: JSON.stringify(points),
        map_max_min: JSON.stringify(bounds),
      });
      imported++;
    }

    // Also import obstacles
    for (const area of result.areas) {
      if (area.type === 'work') continue;
      const mapId = `uploaded_${area.type}${area.mapIndex}_${Date.now()}`;
      mapRepo.create({
        map_id: mapId,
        mower_sn: sn,
        map_name: `${area.type} ${area.mapIndex}`,
        map_type: area.type,
        map_area: JSON.stringify(area.points),
      });
      imported++;
    }

    console.log(`[MAP-IMPORT] Uploaded ZIP for ${sn}: ${imported} areas imported`);
    res.json({ ok: true, imported, totalAreas: result.areas.length, chargingPose: result.chargingPose });
  } catch (err) {
    res.status(500).json({ error: 'Upload import mislukt', details: String(err) });
  }
});

// ── Map calibratie endpoints ──────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  const row = mapRepo.getCalibration(sn);

  res.json({
    calibration: row
      ? { offsetLat: row.offset_lat, offsetLng: row.offset_lng, rotation: row.rotation, scale: row.scale,
          chargerLat: row.charger_lat, chargerLng: row.charger_lng,
          gpsChargerLat: row.gps_charger_lat, gpsChargerLng: row.gps_charger_lng }
      : { offsetLat: 0, offsetLng: 0, rotation: 0, scale: 1,
          chargerLat: null, chargerLng: null, gpsChargerLat: null, gpsChargerLng: null },
  });
});

// GET /api/dashboard/mdns-conflict — detect a SECOND OpenNova server advertising
// the same opennovabot.local on the LAN (e.g. a local `npm run dev` box). Mowers
// resolve mDNS before DNS, so a competitor can silently steal them. The dashboard
// renders a banner when competitors[] is non-empty.
dashboardRouter.get('/mdns-conflict', (_req: Request, res: Response) => {
  const adv = getActiveAdvertisement();
  res.json({
    self: adv?.ip ?? null,
    hostnames: adv?.hostnames ?? [],
    competitors: getCompetingServers(),
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
    const oldChargerGps = mapRepo.getChargerGps(sn);

    if (oldChargerGps) {
      const oldOrigin: GpsPoint = oldChargerGps;
      const newOrigin: GpsPoint = { lat: chargerLat, lng: chargerLng };

      const allMaps = mapRepo.findWithArea(sn);

      for (const row of allMaps) {
        try {
          const oldLocal: LocalPoint[] = JSON.parse(row.map_area!);
          if (!Array.isArray(oldLocal) || oldLocal.length < 2) continue;

          // local(old charger) → GPS → local(new charger)
          const newLocal = oldLocal.map(p => gpsToLocal(localToGps(p, oldOrigin), newOrigin));
          const bounds = {
            minX: Math.min(...newLocal.map(p => p.x)),
            maxX: Math.max(...newLocal.map(p => p.x)),
            minY: Math.min(...newLocal.map(p => p.y)),
            maxY: Math.max(...newLocal.map(p => p.y)),
          };
          mapRepo.updateAreaAndBoundsById(
            row.map_id,
            JSON.stringify(newLocal),
            JSON.stringify(bounds),
          );
          mapsRecalculated++;
        } catch { /* skip corrupt rows */ }
      }
      console.log(`[Calibration] Charger relocated for ${sn}: ${mapsRecalculated} maps recalculated`);
    }
  }

  mapRepo.setCalibration(sn, {
    offset_lat: offsetLat ?? 0,
    offset_lng: offsetLng ?? 0,
    rotation: rotation ?? 0,
    scale: scale ?? 1,
    charger_lat: chargerLat ?? null,
    charger_lng: chargerLng ?? null,
    gps_charger_lat: gpsChargerLat ?? null,
    gps_charger_lng: gpsChargerLng ?? null,
  });

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
// POST /api/dashboard/reanchor/:sn  body: { action?: 'auto' | 'verify' | 'drive' | 'spin' | 'dock' }
// Post-restore re-anchor. After a bundle import the saved map frame no longer
// agrees with the live UTM frame, so frame_unvalidated is set and nav is blocked
// until the frame is re-anchored on the dock.
//
// 'auto' (the wizard's one-button path) orchestrates the whole sequence on the
// server and reports progress via GET /reanchor/:sn/status:
//   1. precheck      — mower must be on the dock (charging) AND on a real RTK Fixed
//   2. reanchor_pos  — write /userdata/pos.json origin = the docked Fixed GPS
//                      (precise WGS84->UTM, no lock) + /load_utm_origin_info live
//                      (no localization restart). Sent over the extended channel.
//   3. relock        — drive ~1m straight back so localization re-inits and
//                      re-locks against the freshly loaded origin
//   4. wait re-lock  — poll until localization RUNNING + RTK Fixed
//   5. dock          — auto_recharge (visual ArUco dock, no map-frame guide pose)
//   6. verify        — the docked map_position must land within ~0.4 m of the
//                      origin; only then is frame_unvalidated cleared. Otherwise
//                      the flag stays set and the wizard offers the manual backup.
//
// Manual backup (when re-lock or docking times out): the app keeps the joystick
// available, and 'verify' re-runs step 6 alone after the operator has joysticked
// the mower back onto the dock — clearing the flag only if it lands on the origin.
//
// Why this works (Ghidra + live-verified, see
// research/documents/reanchor-polygon-charging-pose-diagnosis.md): localization is
// GPS/RTK only (no ArUco input). reanchor_pos sets the origin to the dock's GPS,
// /load_utm_origin_info makes it authoritative, and the drive-off + wait-for-Fixed
// makes localization re-lock against it, so the docked position matches the
// canonical charger pose. We deliberately do NOT recalibrate the charging_pose
// from the live docked position (that bakes a wrong pose in when the frame is bad,
// e.g. RTK Float while charging), and do NOT use go_to_charge (it GPS-navigates to
// where the still-unvalidated frame *thinks* the charger is). The legacy
// 'drive' / 'spin' / 'dock' single-step actions remain for diagnostics.
// Movement uses the exact joystick mst List format [x_w*100, y_v*100, 8]
// (x_w angular, y_v linear) + start_move keepalive.

// ── auto re-anchor progress (polled by the wizard) ──────────────
type ReanchorPhase = 'idle' | 'check' | 'anchor' | 'relock' | 'wait' | 'needs_drive' | 'needs_position' | 'dock' | 'verify' | 'done' | 'error';
// `message` stays Dutch (the dashboard + back-compat with apps that predate
// msgKey). `msgKey` is a stable i18n key the app translates (en/nl/de/fr),
// interpolated with pose ({{x}},{{y}}) and dist ({{dist}}).
interface ReanchorStat { phase: ReanchorPhase; message: string; msgKey?: string; ok?: boolean; error?: string; pose?: { x: number; y: number }; dist?: number; ts: number; }
const reanchorStatus = new Map<string, ReanchorStat>();
// The "has re-locked since the re-anchor began" lifecycle latch lives in
// frameValidation (persisted, shared) via setReanchorRelocked / isReanchorRelocked.
function setReanchor(sn: string, phase: ReanchorPhase, message: string, extra: Partial<ReanchorStat> = {}): void {
  reanchorStatus.set(sn, { phase, message, ts: Date.now(), ...extra });
  console.log(`[reanchor-auto] ${sn}: [${phase}] ${message}${extra.error ? ` (err=${extra.error})` : ''}`);
}

// Live readers off the device cache used by both the auto flow and verify.
// "Currently physically on the dock." battery_state === 'FULL' is intentionally
// NOT accepted here: a full battery keeps reporting FULL for a while after the
// mower undocks, which would let the verify / retry-auto gates fire while the
// mower is off the dock (it then writes pos.json or verifies against a stale
// frame from the wrong place). recharge_status 9 (docked / charging finished)
// and battery CHARGING only hold while the mower is actually on the dock.
function reanchorOnDock(sn: string): boolean {
  const s = deviceCache.get(sn);
  const b = (s?.get('battery_state') ?? '').toUpperCase();
  const r = String(s?.get('recharge_status') ?? '');
  return b === 'CHARGING' || r === '9' || r === '1' || r.startsWith('Charging');
}
function reanchorRtkFixed(sn: string): boolean {
  const s = deviceCache.get(sn);
  const fq = s?.get('rtk_fix_quality');
  const rtk = s?.get('rtk');
  // deviceCache stores the RAW relay value: the GGA quality code (4 = RTK
  // Fixed, 5 = RTK Float), not the display label. translateValue maps it to
  // the same 'RTK Fixed' string the app shows, so compare on the translated
  // value (translateValue is a passthrough if it's already a label). Mowers
  // without the LoRa relay only expose the rtk bool, so accept that as fallback.
  if (fq != null && fq !== '') return translateValue('rtk_fix_quality', fq) === 'RTK Fixed';
  return rtk === 'true';
}
function reanchorMapPos(sn: string): { x: number; y: number } {
  const s = deviceCache.get(sn);
  return { x: parseFloat(s?.get('map_position_x') ?? 'NaN'), y: parseFloat(s?.get('map_position_y') ?? 'NaN') };
}
const REANCHOR_TOLERANCE_M = 0.4; // docked map_position must land this close to the dock anchor
// Stability gate: the origin GPS must SETTLE before we anchor on it. A single
// instantaneous reading can be mid-wander, which puts the dock in the wrong
// place. We require a window of consecutive Fixed readings that agree within the
// spread threshold and anchor on their median; if it never settles we refuse
// (clear error) rather than anchor on a wandering fix.
const REANCHOR_STABLE_SPREAD_M = 0.10;     // window must agree within this (m)
const REANCHOR_STABLE_WINDOW = 8;          // consecutive Fixed samples that must agree
const REANCHOR_STABLE_TIMEOUT_MS = 30000;  // give up waiting for a stable fix
const REANCHOR_STABLE_STEP_MS = 1000;      // sample cadence
const REANCHOR_ANCHOR_RETRIES = 3;         // resend reanchor_pos on a failed/timed-out load

// Self-verify the docked frame: if map_position is within tolerance of the DOCK
// ANCHOR (first point of map0tocharge_unicom — the charger's position in the
// polygon frame), clear frame_unvalidated; otherwise leave it set.
//
// NOT (0,0): reanchor_pos subtracts the anchor from the origin so a docked
// mower lands ON the anchor. Measuring against (0,0) rejected every correctly
// anchored frame whose anchor is >0.4m from origin — including the known-good
// LFIN1231000211 (anchor (0.13,-0.52), docked (0.09,-0.51) = 4cm from anchor
// but 0.52m from origin).
function reanchorVerifyAndClear(sn: string): { ok: boolean; pose: { x: number; y: number }; dist: number } {
  const pose = reanchorMapPos(sn);
  const anchor = getPolygonAnchor(sn, deviceCache.get(sn));
  const dist = Math.hypot(pose.x - (anchor?.x ?? 0), pose.y - (anchor?.y ?? 0));
  const ok = Number.isFinite(dist) && dist <= REANCHOR_TOLERANCE_M;
  if (ok) clearFrameUnvalidated(sn);
  return { ok, pose, dist };
}

// Wait for the docked RTK to SETTLE, then return the median lat/lng of a stable
// window to anchor on. Returns an error instead when the fix never settles
// within the timeout (anchoring on a wandering RTK is what puts the dock in the
// wrong place). The window resets whenever the fix drops or leaves Fixed, so we
// never average across a gap. Emits live 'anchor' progress with the live spread.
async function reanchorStableGps(
  sn: string,
  sleep: (ms: number) => Promise<unknown>,
): Promise<LatLng | { error: 'no_gps' | 'unstable'; spread: number }> {
  const win: LatLng[] = [];
  const t0 = Date.now();
  let sawGps = false;
  let lastSpread = NaN;
  while (Date.now() - t0 < REANCHOR_STABLE_TIMEOUT_MS) {
    const s = deviceCache.get(sn);
    const lat = parseFloat(s?.get('latitude') ?? s?.get('gps_latitude') ?? 'NaN');
    const lng = parseFloat(s?.get('longitude') ?? s?.get('gps_longitude') ?? 'NaN');
    if (Number.isFinite(lat) && Number.isFinite(lng) && reanchorRtkFixed(sn)) {
      sawGps = true;
      win.push({ lat, lng });
      if (win.length > REANCHOR_STABLE_WINDOW) win.shift();
      if (win.length === REANCHOR_STABLE_WINDOW) {
        lastSpread = gpsSpreadMeters(win);
        setReanchor(sn, 'anchor', `Stabiliteit controleren op de dock (±${(lastSpread * 100).toFixed(0)} cm)...`, { msgKey: 'reanchorMsgStability', dist: lastSpread });
        if (lastSpread <= REANCHOR_STABLE_SPREAD_M) return medianGps(win);
      } else {
        setReanchor(sn, 'anchor', 'Stabiliteit controleren op de dock...', { msgKey: 'reanchorMsgStability' });
      }
    } else {
      win.length = 0; // fix dropped or not Fixed — don't average across the gap
    }
    await sleep(REANCHOR_STABLE_STEP_MS);
  }
  if (!sawGps) return { error: 'no_gps', spread: NaN };
  return { error: 'unstable', spread: Number.isFinite(lastSpread) ? lastSpread : NaN };
}

// Full server-side orchestration for action:'auto'. Fire-and-forget; the wizard
// polls GET /reanchor/:sn/status. Each phase updates reanchorStatus.
async function runAutoReanchor(sn: string): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const poll = async (cond: () => boolean, timeoutMs: number, stepMs = 2000): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { if (cond()) return true; await sleep(stepMs); }
    return cond();
  };
  try {
    // 1. precheck — on the dock + a real RTK Fixed
    setReanchor(sn, 'check', 'Controle: maaier op de dock en RTK Fixed?', { msgKey: 'reanchorMsgCheck' });
    if (!reanchorOnDock(sn)) {
      setReanchor(sn, 'error', 'Maaier staat niet op de dock (laden). Dok hem eerst, dan opnieuw.', { error: 'not_docked', msgKey: 'reanchorMsgErrNotDocked' });
      return;
    }
    if (!reanchorRtkFixed(sn)) {
      setReanchor(sn, 'error', 'Nog geen RTK Fixed. Wacht tot de fix Fixed is en probeer opnieuw.', { error: 'not_fixed', msgKey: 'reanchorMsgErrNotFixed' });
      return;
    }

    // A fresh re-anchor write invalidates any prior relock: verify must wait for
    // the new origin to be re-locked (off-dock -> RUNNING + Fixed -> re-docked).
    setReanchorRelocked(sn, false);

    // 2. reanchor_pos — origin = the docked Fixed GPS, loaded live (no restart).
    // First WAIT for the RTK to settle (a single reading can be mid-wander), then
    // anchor on the median of a stable window. The live RTK position is cached
    // under 'latitude'/'longitude' (from the mower's location report); the
    // mower-side reanchor_pos converts the WGS84 origin to UTM.
    setReanchor(sn, 'anchor', 'Stabiliteit controleren op de dock...', { msgKey: 'reanchorMsgStability' });
    const stable = await reanchorStableGps(sn, sleep);
    if ('error' in stable) {
      if (stable.error === 'no_gps') {
        setReanchor(sn, 'error', 'Geen geldige GPS-coordinaten van de maaier.', { error: 'no_gps', msgKey: 'reanchorMsgErrNoGps' });
      } else {
        const cm = Number.isFinite(stable.spread) ? (stable.spread * 100).toFixed(0) : '?';
        setReanchor(sn, 'error', `RTK te onrustig op de dock (zwabbert ±${cm} cm). Wacht op een rustige Fixed en probeer opnieuw.`, { error: 'rtk_unstable', dist: stable.spread, msgKey: 'reanchorMsgErrUnstable' });
      }
      return;
    }
    const { lat, lng } = stable;
    setReanchor(sn, 'anchor', 'Dockpositie opslaan...', { msgKey: 'reanchorMsgAnchor' });
    const { publishToExtended, onExtendedResponse, offExtendedResponse } = await import('../mqtt/mapSync.js');
    // Resend on a failed/timed-out load: pos.json is (re)written each attempt with
    // the SAME stable origin, only the load_utm_origin_info reload is flaky. The
    // mower retries that ROS call itself too; this is the outer safety net.
    let anchored = false;
    for (let attempt = 1; attempt <= REANCHOR_ANCHOR_RETRIES && !anchored; attempt++) {
      anchored = await new Promise<boolean>((resolve) => {
        let settled = false;
        const handler = (data: Record<string, unknown>): void => {
          const resp = data.reanchor_pos_respond as { result?: number } | undefined;
          if (!resp || settled) return;
          settled = true;
          offExtendedResponse(sn, handler);
          resolve(resp.result === 0);
        };
        onExtendedResponse(sn, handler);
        publishToExtended(sn, { reanchor_pos: { lat, lng } });
        setTimeout(() => { if (!settled) { settled = true; offExtendedResponse(sn, handler); resolve(false); } }, 15000);
      });
      if (!anchored && attempt < REANCHOR_ANCHOR_RETRIES) {
        setReanchor(sn, 'anchor', `Dockpositie opslaan (poging ${attempt + 1})...`, { msgKey: 'reanchorMsgAnchor' });
        await sleep(2000);
      }
    }
    if (!anchored) {
      setReanchor(sn, 'error', 'De maaier bevestigde de nieuwe dockpositie niet op tijd. Probeer opnieuw.', { error: 'reanchor_failed', msgKey: 'reanchorMsgErrAnchorFailed' });
      return;
    }

    // 3-4. relock — drive off the dock, then wait for the localization to reach
    // RUNNING + Fixed. A single ~1m straight drive usually gives the GPS-track
    // heading the localization needs, but live testing showed 1m is sometimes not
    // enough (localization stays "Not initialized"). The 360-spin escalation was
    // unreliable (the mower never completed the turn), so instead we ASK the user
    // to nudge the mower ~1m further straight back with the joystick while we keep
    // polling, and continue automatically the moment it locks. Each poll re-checks
    // so we stop as soon as RUNNING + Fixed is reached.
    const relockOk = () =>
      (deviceCache.get(sn)?.get('localization_state') ?? '') === 'RUNNING' && reanchorRtkFixed(sn);
    const pollRelock = (ms: number) => poll(relockOk, ms, 1500);
    // Drive straight back. untilOffDock: stop as soon as the mower leaves the
    // dock (first leg ≈ 1m); otherwise drive the full window (the extra leg).
    const driveBack = async (ms: number, untilOffDock: boolean): Promise<void> => {
      publishToDevice(sn, { start_move: 4 });
      await sleep(300);
      const t0 = Date.now();
      let tick = 0;
      while (Date.now() - t0 < ms) {
        publishToDevice(sn, { mst: [0, -50, 8] }); // x_w=0 (straight), y_v=-0.50 (backward)
        tick++;
        if (tick % 5 === 0) publishToDevice(sn, { start_move: 4 });
        await sleep(150);
        if (untilOffDock && Date.now() - t0 > 4000 && !reanchorOnDock(sn)) break;
      }
      publishToDevice(sn, { stop_move: null });
    };

    setReanchor(sn, 'relock', 'Achteruit rijden om te re-locken...', { msgKey: 'reanchorMsgRelockBack' });
    publishToDevice(sn, { quit_mapping_mode: { value: 1, cmd_num: getNextCmdNum(sn) } });
    await sleep(500);
    await driveBack(12000, true);

    setReanchor(sn, 'wait', 'Wachten op re-lock (RUNNING + Fixed)...', { msgKey: 'reanchorMsgWaitRelock' });
    let isRelocked = await pollRelock(15000);
    if (!isRelocked) {
      // Not locked after the auto drive-back. Hand control to the user: ask them
      // to drive ~1m further straight back with the joystick. Keep polling for a
      // long window and continue automatically as soon as the localization locks.
      setReanchor(sn, 'needs_drive', 'Nog niet gelockt. Rij met de joystick nog ~1 m recht achteruit; ik ga automatisch verder zodra de localisatie lockt.', { msgKey: 'reanchorMsgNeedsDrive' });
      isRelocked = await pollRelock(90000);
    }
    if (!isRelocked) {
      setReanchor(sn, 'error', 'Nog steeds geen lock na extra achteruit rijden. Rij handmatig met de joystick terug naar de dock en start de automatische re-anchor opnieuw.', { error: 'relock_timeout', msgKey: 'reanchorMsgErrRelockTimeout' });
      return;
    }
    // Relock confirmed: the mower left the dock and reached RUNNING + Fixed, so the
    // new origin is now the live localization frame. Verify becomes meaningful once
    // it is re-docked.
    setReanchorRelocked(sn, true);

    // 4b. needs_position — PAUSE the auto flow. The visual ArUco dock only homes
    // in reliably from close range, straight in front of the dock; auto-docking
    // from wherever the mower ended up after the drive-back never succeeds. So we
    // hand control to the user: drive the mower to ~50 cm directly in front of the
    // dock, then press "Start docken" (POST action:'continue_dock' -> runReanchorDock
    // below). We do NOT auto-attempt the dock here.
    setReanchor(sn, 'needs_position', 'Re-lock gelukt. Rij de maaier nu zelf recht voor de dock, op ~50 cm afstand. Druk daarna op "Start docken".', { msgKey: 'reanchorMsgNeedsPosition' });
  } catch (err) {
    setReanchor(sn, 'error', `Onverwachte fout: ${err instanceof Error ? err.message : String(err)}`, { error: 'exception', msgKey: 'reanchorMsgErrException' });
  }
}

// Dock + self-verify continuation of the auto re-anchor. Triggered by POST
// action:'continue_dock' once the user has manually positioned the mower ~50 cm
// straight in front of the dock (the visual ArUco dock only homes in from close
// range, so the auto flow does NOT attempt this by itself).
async function runReanchorDock(sn: string): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const poll = async (cond: () => boolean, timeoutMs: number, stepMs = 2000): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { if (cond()) return true; await sleep(stepMs); }
    return cond();
  };
  try {
    // 5. dock — visual ArUco dock (no map-frame guide pose). suppressReanchorArm:
    // the passive docked-report clear must not fire here — step 6's self-verify
    // (docked map_position must land on the origin) is the sole authority.
    setReanchor(sn, 'dock', 'Docken (visuele ArUco)...', { msgKey: 'reanchorMsgDock' });
    publishToDevice(sn, { quit_mapping_mode: { value: 1, cmd_num: getNextCmdNum(sn) } });
    await sleep(500);
    // Record the charge pose FIRST, exactly like the Novabot app's post-mapping
    // dock (build_map_page/logic.dart _saveChargePosition -> save_recharge_pos,
    // sent right before the <0.5 m auto_recharge). Without it the docker logs
    // "No charge pose set" and falls back to a COLD visual search (step back +
    // rotate to find the marker), which fails at ~0.5 m. With the pose set it does
    // the short guided forward dock instead. The mower is <0.5 m in front of the
    // dock and the frame is relocked, so the recorded pose is correct — same
    // precondition as the mapping flow. awaitCommand sends save_recharge_pos and
    // resolves on save_recharge_pos_respond (20 s, matching the app's timeout).
    const { awaitCommand } = await import('../mqtt/mapSync.js');
    try {
      await awaitCommand(sn, 'save_recharge_pos', { mapName: 'map0', map0: '', cmd_num: getNextCmdNum(sn) }, 20000);
      console.log(`[reanchor] ${sn}: save_recharge_pos acknowledged (charge pose set)`);
    } catch (e) {
      // Respond missed/late — proceed anyway; the pose may still have been set.
      console.warn(`[reanchor] ${sn}: save_recharge_pos respond timeout (${e instanceof Error ? e.message : String(e)}); docking anyway`);
    }
    await sleep(1000); // let the charge pose settle before docking
    publishToDevice(sn, { auto_recharge: { cmd_num: getNextCmdNum(sn) } }, { suppressReanchorArm: true });
    const docked = await poll(() => reanchorOnDock(sn), 150000, 3000);
    if (!docked) {
      setReanchor(sn, 'error', 'Docken duurde te lang. Dok handmatig met de joystick en druk Verifieer.', { error: 'dock_timeout', msgKey: 'reanchorMsgErrDockTimeout' });
      return;
    }

    // 6. verify — docked map_position must land on the origin, else keep the flag
    await sleep(4000); // let map_position settle after docking
    setReanchor(sn, 'verify', 'Controle: gedockt op de origin?', { msgKey: 'reanchorMsgVerify' });
    const v = reanchorVerifyAndClear(sn); // clears frame_unvalidated + relock latch on ok
    if (v.ok) {
      setReanchor(sn, 'done', `Geslaagd. Gedockt op (${v.pose.x.toFixed(2)}, ${v.pose.y.toFixed(2)}) m.`, { ok: true, pose: v.pose, msgKey: 'reanchorMsgDone' });
    } else {
      setReanchor(sn, 'error', `Buiten tolerantie: dock op (${v.pose.x.toFixed(2)}, ${v.pose.y.toFixed(2)}) m, ${Number.isFinite(v.dist) ? v.dist.toFixed(2) : '?'} m van origin. Probeer opnieuw.`, { error: 'verify_failed', pose: v.pose, dist: v.dist, msgKey: 'reanchorMsgErrVerifyFailed' });
    }
  } catch (err) {
    setReanchor(sn, 'error', `Onverwachte fout: ${err instanceof Error ? err.message : String(err)}`, { error: 'exception', msgKey: 'reanchorMsgErrException' });
  }
}

// GET /api/dashboard/reanchor/:sn/status — auto re-anchor progress for the wizard.
// Augmented with LIVE gating booleans the app uses to enable/disable buttons:
//   onDock   — mower physically on the dock right now (strict, no battery-FULL)
//   rtkFixed — real RTK Fixed right now
//   relocked — has completed off-dock -> RUNNING+Fixed since the re-anchor began
// (verify requires relocked && onDock; retry-auto requires onDock && rtkFixed).
dashboardRouter.get('/reanchor/:sn/status', (req: Request, res: Response) => {
  const { sn } = req.params;
  const stored = reanchorStatus.get(sn) ?? { phase: 'idle' as ReanchorPhase, message: '', ts: 0 };
  res.json({
    ok: true,
    status: {
      ...stored,
      onDock: reanchorOnDock(sn),
      rtkFixed: reanchorRtkFixed(sn),
      relocked: isReanchorRelocked(sn),
    },
  });
});

dashboardRouter.post('/reanchor/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const action = ((req.body as { action?: string })?.action) ?? 'auto';

  // 'invalidate' — operator-triggered frame invalidation. Marks the frame
  // unvalidated IN-PROCESS (no DB write + restart needed) so the app's re-anchor
  // wizard opens and a fresh re-anchor can run. Intentionally works regardless
  // of the current flag: the whole point is to let the user re-invalidate and
  // redo the re-anchor when the previous one didn't hold. Must run BEFORE the
  // "already validated" guard below.
  if (action === 'invalidate') {
    markFrameUnvalidated(sn);
    console.log(`[reanchor] ${sn}: frame marked unvalidated by operator (manual invalidate)`);
    res.json({ ok: true, action, message: 'frame marked unvalidated — open the re-anchor wizard' });
    return;
  }

  if (!isFrameUnvalidated(sn)) {
    res.status(409).json({ ok: false, error: 'frame is already validated; no re-anchor needed' });
    return;
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Strict, shared "on the dock now" — battery FULL alone does NOT count (it
  // lingers after undocking). Same rule used by the auto flow and verify gate.
  const onDock = () => reanchorOnDock(sn);

  // 'auto' — the wizard's one-button path. Fire-and-forget; the wizard polls
  // GET /reanchor/:sn/status for progress (see runAutoReanchor above).
  if (action === 'auto') {
    if (!onDock()) {
      res.status(409).json({ ok: false, error: 'auto re-anchor must start with the mower on the dock (charging).' });
      return;
    }
    if (!reanchorRtkFixed(sn)) {
      res.status(409).json({ ok: false, error: 'auto re-anchor needs a real RTK Fixed; wait for the fix to go Fixed.' });
      return;
    }
    setReanchor(sn, 'check', 'Re-anchor gestart...', { msgKey: 'reanchorMsgStarted' });
    res.json({ ok: true, action, message: 'auto re-anchor started; poll GET /reanchor/:sn/status' });
    void runAutoReanchor(sn);
    return;
  }

  // 'verify' — manual backup. After the operator joysticks the mower back onto
  // the dock, re-run the docked-on-origin check alone and clear the flag if it
  // passes. Does not move the mower.
  // Gated on the lifecycle: verify is only meaningful once the mower has left the
  // dock, re-locked (RUNNING + RTK Fixed) against the new origin, AND is back on
  // the dock. Verifying before the relock tests a stale frame; verifying off-dock
  // checks the wrong position entirely.
  if (action === 'verify') {
    if (!isReanchorRelocked(sn)) {
      res.status(409).json({ ok: false, error: 'verify needs the re-anchor cycle first: the mower must have left the dock, reached RUNNING + RTK Fixed, then re-docked.' });
      return;
    }
    if (!onDock()) {
      res.status(409).json({ ok: false, error: 'verify must run with the mower back on the dock.' });
      return;
    }
    res.json({ ok: true, action, message: 'verifying docked position against origin' });
    (async () => {
      setReanchor(sn, 'verify', 'Controle: gedockt op de origin?', { msgKey: 'reanchorMsgVerify' });
      if (!onDock()) {
        setReanchor(sn, 'error', 'Maaier staat niet op de dock. Dok hem eerst.', { error: 'not_docked', msgKey: 'reanchorMsgErrNotDocked' });
        return;
      }
      await sleep(3000); // let map_position settle
      const v = reanchorVerifyAndClear(sn);
      if (v.ok) {
        setReanchor(sn, 'done', `Geslaagd. Gedockt op (${v.pose.x.toFixed(2)}, ${v.pose.y.toFixed(2)}) m.`, { ok: true, pose: v.pose, msgKey: 'reanchorMsgDone' });
      } else {
        setReanchor(sn, 'error', `Buiten tolerantie: dock op (${v.pose.x.toFixed(2)}, ${v.pose.y.toFixed(2)}) m, ${Number.isFinite(v.dist) ? v.dist.toFixed(2) : '?'} m van origin.`, { error: 'verify_failed', pose: v.pose, dist: v.dist, msgKey: 'reanchorMsgErrVerifyFailed' });
      }
    })();
    return;
  }

  if (action === 'drive') {
    if (!onDock()) {
      res.status(409).json({ ok: false, error: 'drive must start with the mower on the dock (charging). Drive it onto the dock first.' });
      return;
    }
    res.json({ ok: true, action, message: 'driving ~1m off the dock; wait for RTK Fixed then POST action:dock' });
    (async () => {
      const BACK_MST = [0, -50, 8]; // x_w=0 (straight), y_v=-0.50 (backward)
      try {
        publishToDevice(sn, { quit_mapping_mode: { value: 1, cmd_num: getNextCmdNum(sn) } });
        await sleep(500);
        publishToDevice(sn, { start_move: 4 });
        await sleep(300);
        const started = Date.now();
        let tick = 0;
        while (Date.now() - started < 12000) {
          publishToDevice(sn, { mst: BACK_MST });
          tick++;
          if (tick % 5 === 0) publishToDevice(sn, { start_move: 4 });
          await sleep(150);
          if (Date.now() - started > 4000 && !onDock()) break;
        }
        publishToDevice(sn, { stop_move: null });
        console.log(`[reanchor] ${sn}: drove off dock (off=${!onDock()})`);
      } catch (err) { console.error(`[reanchor] ${sn}: drive failed`, err); }
    })();
    return;
  }

  if (action === 'spin') {
    res.json({ ok: true, action, message: 'spinning ~360 to help acquire an RTK fix' });
    (async () => {
      const SPIN_MST = [50, 0, 8]; // x_w=+0.50 (rotate right), y_v=0
      try {
        publishToDevice(sn, { start_move: 2 }); // 2 = rotate right
        await sleep(300);
        const started = Date.now();
        let tick = 0;
        while (Date.now() - started < 11000) {
          publishToDevice(sn, { mst: SPIN_MST });
          tick++;
          if (tick % 5 === 0) publishToDevice(sn, { start_move: 2 });
          await sleep(150);
        }
        publishToDevice(sn, { stop_move: null });
        console.log(`[reanchor] ${sn}: 360 spin done`);
      } catch (err) { console.error(`[reanchor] ${sn}: spin failed`, err); }
    })();
    return;
  }

  // 'continue_dock' — the auto flow paused at 'needs_position'. The operator has
  // joysticked the mower to ~50 cm straight in front of the dock; now run the full
  // dock + self-verify continuation (runReanchorDock). Fire-and-forget; the wizard
  // keeps polling GET /reanchor/:sn/status.
  if (action === 'continue_dock') {
    res.json({ ok: true, action, message: 'continuing auto re-anchor: visual ArUco dock + self-verify' });
    void runReanchorDock(sn);
    return;
  }

  if (action === 'dock') {
    res.json({ ok: true, action, message: 'visual ArUco dock via auto_recharge; the docked report clears frame_unvalidated' });
    (async () => {
      try {
        publishToDevice(sn, { quit_mapping_mode: { value: 1, cmd_num: getNextCmdNum(sn) } });
        await sleep(500);
        // auto_recharge = the local visual ArUco dock (same as post-mapping), NOT
        // go_to_charge — see the route comment above. Purely visual: it homes on
        // the charger's QR/ArUco marker nearby instead of GPS-navigating to the
        // (wrong, unvalidated) map-frame charger pose.
        publishToDevice(sn, { auto_recharge: { cmd_num: getNextCmdNum(sn) } });
        console.log(`[reanchor] ${sn}: quit_mapping + auto_recharge (visual ArUco dock) dispatched`);
        // The docked report (recharge_status 9) clears frame_unvalidated via
        // noteDockState (armed by auto_recharge). We intentionally do NOT
        // recalibrate the charging_pose here: the real re-anchor is the
        // localization re-deriving its UTM origin on a CLEAN RTK Fixed (the
        // drive-off + wait-for-Fixed), after which the docked position naturally
        // matches the canonical charger pose. Writing charging_pose from the live
        // docked map_position is unsafe — if the frame is bad (e.g. the rover is
        // on RTK Float, which happens while charging on LFIN2230700238), it bakes
        // a ~2 m-off pose into the marker. See
        // research/documents/reanchor-polygon-charging-pose-diagnosis.md.
      } catch (err) { console.error(`[reanchor] ${sn}: dock failed`, err); }
    })();
    return;
  }

  res.status(400).json({ ok: false, error: `unknown action '${action}'` });
});

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
  // Stock v5.x mower firmware has NO AES decryption — encrypted commands
  // are silently dropped at the firmware layer, which surfaced as
  // start_cov_task vanishing into the void (issue #45: mower flickered
  // to "100% done" because the start_cov_task MQTT never reached
  // mqtt_node's handler). Detect via the sw_version sensor and force
  // plaintext for those mowers. Same rule the OTA trigger already uses.
  let isV5StockMower = false;
  if (sn.startsWith('LFIN')) {
    const sensors = deviceCache.get(sn);
    const fwVersion = sensors?.get('sw_version') || sensors?.get('mower_version') || sensors?.get('version') || '';
    isV5StockMower = fwVersion.startsWith('v5.') || fwVersion.startsWith('5.');
  }
  const shouldEncrypt = doEncrypt !== undefined
    ? doEncrypt
    : sn.startsWith('LFI') && !isV5StockMower;

  // set_para_info: bewaar alle settings in sensor cache + SQLite zodat dashboard
  // de juiste state toont (maaier retourneert GEEN get_para_info_respond)
  const paraInfo = command.set_para_info as Record<string, unknown> | undefined;
  if (paraInfo) {
    if (!deviceCache.has(sn)) deviceCache.set(sn, new Map());
    const cache = deviceCache.get(sn)!;
    const changes = new Map<string, string>();
    for (const [key, val] of Object.entries(paraInfo)) {
      if (val === undefined || val === null) continue;
      const strVal = String(val);
      cache.set(key, strVal);
      changes.set(key, strVal);
      deviceSettingsRepo.upsert(sn, key, strVal);
    }
    // Push naar dashboard zodat UI direct update
    forwardToDashboard(sn, changes);
    // Objectdetectie-cadans: stuur de nieuwe stand direct door naar de maaier
    // (extended_commands.py zet daarop de detectie-cadans tijdens maaien).
    if ('obstacle_avoidance_sensitivity' in paraInfo) republishObstacleDetection(sn);
    // LED bridge: stuur ook naar novabot/cmd/<SN> voor led_bridge.py
    if ('headlight' in paraInfo) {
      publishToTopic(`novabot/cmd/${sn}`, { led_set: Number(paraInfo.headlight) });
    }
  }

  // set_lora_info: cache addr/channel in equipment_lora_cache zodat dashboard
  // LoRa config kan tonen in de device chip dropdown
  const loraInfo = command.set_lora_info as { addr?: number; channel?: number } | undefined;
  if (loraInfo && (loraInfo.addr != null || loraInfo.channel != null)) {
    equipmentRepo.upsertLoraCachePreserving(
      sn,
      loraInfo.addr != null ? String(loraInfo.addr) : null,
      loraInfo.channel != null ? String(loraInfo.channel) : null,
    );
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
  } else if (sn.startsWith('LFI')) {
    // Issue #16: when the operator passes `encrypt: false` for an LFI* SN,
    // bypass publishToDevice — its own LFI auto-encrypt branch would
    // silently re-encrypt and the override would never reach the wire.
    // waltervl hit exactly this on stock v5.x firmware.
    const json = JSON.stringify(command);
    publishRawToDevice(sn, Buffer.from(json, 'utf8'), (qos === 1 ? 1 : 0) as 0 | 1);
    console.log(`[DASHBOARD] Raw (unencrypted) command voor ${sn}: ${json}`);
    res.json({ ok: true, command: Object.keys(command)[0], encrypted: false, demo: isDemoMode(sn) });
  } else {
    // Non-LFI device — publishToDevice is safe (no auto-encrypt branch
    // triggers) and keeps the demo interceptor + standard publish path.
    publishToDevice(sn, command);
    res.json({ ok: true, command: Object.keys(command)[0], demo: isDemoMode(sn) });
  }
});

// POST /api/dashboard/reapply-para/:sn — re-send the saved para block before a mow.
//
// The mower does NOT persist set_para_info over a reconnect, so a task can start
// with reset defaults (most critically perception_level 0 = obstacle avoidance
// OFF, and path_direction 0). The app (StartMowSheet) and the scheduler
// (mowingService) already re-apply the full saved block right before every mow;
// the dashboard's start_navigation went out raw and skipped this. This endpoint
// closes that gap so a dashboard-initiated mow behaves identically: it re-sends
// the FULL saved block (selectParaRepush — a partial block would reset the
// omitted fields to 0), then waits MOW_PARA_SETTLE_MS so the mower has processed
// it before the caller fires start_navigation. No-op when nothing is saved.
dashboardRouter.post('/reapply-para/:sn', async (req: Request, res: Response) => {
  const { sn } = req.params;
  if (!isDemoMode(sn) && !isDeviceOnline(sn)) {
    res.status(404).json({ ok: false, error: 'Device is offline' });
    return;
  }
  const para = selectParaRepush(deviceSettingsRepo.findBySn(sn));
  if (!para) {
    res.json({ ok: true, applied: false });
    return;
  }
  publishToDevice(sn, { set_para_info: para });
  await new Promise((r) => setTimeout(r, MOW_PARA_SETTLE_MS));
  res.json({ ok: true, applied: true, para });
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
  path_direction: number | null;
}

// GET /api/dashboard/work-records/:sn — maaigeschiedenis
dashboardRouter.get('/work-records/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;

  // saveCutGrassRecord stores rows under equipment.equipment_id (UUID) when
  // a paired equipment row exists, otherwise falls back to the SN literal.
  // The OpenNova app passes the SN here directly, so resolve to UUID first
  // and keep the SN as a fallback for charger-only / unbound mowers.
  const equip = equipmentRepo.findByMowerSn(sn);
  const equipmentId = equip?.equipment_id ?? sn;

  const total = messageRepo.countWorkRecordsByEquipmentId(equipmentId);
  const rows = messageRepo.findWorkRecordsByEquipmentId(equipmentId, limit, offset) as WorkRecordRow[];

  // Resolve `mapNames` (firmware slot index, e.g. "1") to the user's
  // alias from the maps table (e.g. "Achtertuin"). The mower posts
  // either a single index, a comma/space-separated list (multi-map
  // session), or a JSON array — handle all three so future firmware
  // tweaks don't silently break the display. Falls back to the raw
  // value when no DB row matches the slot.
  const workMaps = mapRepo.findByMowerSnAndType(sn, 'work');
  const aliasByCanonical = new Map<string, string>();
  for (const m of workMaps) {
    if (m.canonical_name && m.map_name) {
      aliasByCanonical.set(m.canonical_name, m.map_name);
    }
  }
  // Firmware encodes the per-task map selection as a DECIMAL POSITIONAL
  // BITMASK (per docs/reference/MOWING-FLOW.md): each map slot N is the digit
  // at 10^N, so map0=1, map1=10, map2=100, and combinations sum (11=map0+map1,
  // 111=all three). saveCutGrassRecord stores that value verbatim in
  // `map_names`. Decode every non-zero digit to its slot and show the user's
  // alias (e.g. "111" → "Achtertuin, Voortuin, Zijkant"), mirroring the app.
  // Legacy single-map records may carry 200 for map2 (digit 2 at position 2 →
  // slot 2), which this decoder still handles correctly.
  function slotsFromAreaToken(tok: string): number[] | null {
    if (!/^\d+$/.test(tok)) return null;
    const slots: number[] = [];
    for (let i = 0; i < tok.length; i++) {
      const digit = tok.charCodeAt(tok.length - 1 - i) - 48; // position i = 10^i
      if (digit !== 0) slots.push(i);
    }
    return slots;
  }
  function resolveMapNames(raw: string | null | undefined): string | null {
    if (raw == null || raw === '') return null;
    const tokens = (() => {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch { /* not JSON, fall through */ }
      return String(raw).split(/[\s,]+/).filter(Boolean);
    })();
    const friendly = tokens.flatMap(tok => {
      // Token shapes we accept:
      //   "1"/"10"/"100"/"111"/"200" → firmware bitmask → one name per set bit
      //   "map0"/"map1"              → already canonical
      //   "Achtertuin"              → already an alias (older rows may store this)
      const slots = slotsFromAreaToken(tok);
      if (slots && slots.length > 0) {
        return slots.map(s => aliasByCanonical.get(`map${s}`) ?? `map${s}`);
      }
      if (/^map\d+$/i.test(tok)) {
        return [aliasByCanonical.get(tok.toLowerCase()) ?? tok];
      }
      return [aliasByCanonical.get(tok) ?? tok];
    });
    return friendly.join(', ');
  }

  res.json({
    records: rows.map(r => ({
      recordId: r.record_id,
      dateTime: r.date_time,
      workTime: r.work_time,
      workArea: r.work_area_m2,
      cutGrassHeight: r.cut_grass_height,
      pathDirection: r.path_direction,
      mapNames: resolveMapNames(r.map_names),
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

  const rows = signalHistoryRepo.findBySnWithinHours(sn, hours) as Array<{
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
  interval_days: number;
  interval_anchor_date: string | null;
  timezone: string | null;
  trigger_count: number;
  skip_date: string | null;
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
    intervalDays: r.interval_days ?? 0,
    intervalAnchorDate: r.interval_anchor_date,
    timezone: r.timezone ?? null,
    skipDate: r.skip_date ?? null,
    // Richting die de VOLGENDE run daadwerkelijk gebruikt. Bij alternate
    // rotatie is dat base + trigger_count×step — de kaarten toonden eerst
    // altijd de basisrichting, wat elke dag "60°" liet zien terwijl de
    // runner allang doorroteerde.
    nextPathDirection: r.alternate_direction === 1
      ? (r.path_direction + (r.trigger_count ?? 0) * (r.alternate_step ?? 90)) % 180
      : r.path_direction,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// GET /api/dashboard/schedules/:sn — alle schedules voor een maaier
//
// Per row enriched with live status fields so the app's Schedules tab can
// show at a glance which schedule (if any) is currently mowing or paused
// because of rain. Without this the user sees a flat list and has to
// cross-reference time-of-day in their head.
//
//   currentlyRunning  — true when this schedule fired in the last 12h AND
//                       the mower is in timer-task mode AND not on the
//                       dock. Picks the most recent fired schedule when
//                       multiple are eligible (e.g. legacy duplicates).
//   rainPausedAt      — ISO timestamp when the rain monitor paused this
//                       schedule's session, null otherwise.
dashboardRouter.get('/schedules/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const rows = scheduleRepo.findByMowerSnOrderByStartTime(sn) as ScheduleRow[];

  // Build "rain-paused" lookup by schedule_id.
  const rainBySchedule = new Map<string, string>();  // schedule_id → paused_at
  for (const s of getActiveRainSessions(sn)) {
    if (s.state === 'paused') rainBySchedule.set(s.schedule_id, s.paused_at);
  }

  // Detect "currently mowing" schedule by combining live mower state
  // with last_triggered_at. Mower must be (a) in timer-task mode and
  // (b) not docked / charging for it to count as actively running.
  const snap = getDeviceSnapshot(sn);
  const taskMode = parseInt(snap?.task_mode ?? '0', 10);
  const onDock = snap?.battery_state === 'CHARGING' || snap?.charging === '1';
  const isTimerRunning = taskMode === 1 && !onDock;
  let activeScheduleId: string | null = null;
  if (isTimerRunning) {
    const RECENT_MS = 12 * 60 * 60 * 1000;  // 12h window
    let latest = 0;
    for (const r of rows) {
      if (!r.last_triggered_at) continue;
      const t = Date.parse(r.last_triggered_at + 'Z');
      if (Number.isNaN(t)) continue;
      if (Date.now() - t > RECENT_MS) continue;
      if (t > latest) { latest = t; activeScheduleId = r.schedule_id; }
    }
  }

  const enriched = rows.map(r => {
    const dto = scheduleRowToDto(r);
    return {
      ...dto,
      currentlyRunning: r.schedule_id === activeScheduleId,
      rainPausedAt: rainBySchedule.get(r.schedule_id) ?? null,
    };
  });
  res.json({ schedules: enriched });
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
    // #51: "every N days" alternative to weekdays. intervalDays > 0
    // makes the schedule fire on intervalAnchorDate, intervalAnchorDate +
    // N, +2N, … The mower's own timer_task only understands WEEKLY, so
    // schedules in interval mode are driven entirely by the server-side
    // scheduleRunner (rain_pause=true path).
    intervalDays?: number;
    intervalAnchorDate?: string;
    // IANA zone van de browser/app die het schema aanmaakt. De server-side
    // runner vuurt start_time in DEZE zone; null = container-TZ (legacy).
    timezone?: string;
  };

  if (!body.startTime) {
    res.status(400).json({ error: 'startTime is vereist' });
    return;
  }

  const scheduleId = uuidv4();
  scheduleRepo.create({
    schedule_id: scheduleId,
    mower_sn: sn,
    schedule_name: body.scheduleName ?? null,
    start_time: body.startTime,
    end_time: body.endTime ?? null,
    weekdays: JSON.stringify(body.weekdays ?? [1, 2, 3, 4, 5]),
    enabled: 1,
    map_id: body.mapId ?? null,
    map_name: body.mapName ?? null,
    cutting_height: body.cuttingHeight ?? 40,
    path_direction: body.pathDirection ?? 0,
    work_mode: body.workMode ?? 0,
    task_mode: body.taskMode ?? 0,
    alternate_direction: body.alternateDirection ? 1 : 0,
    alternate_step: body.alternateStep ?? 90,
    edge_offset: body.edgeOffset ?? 0,
    rain_pause: body.rainPause ? 1 : 0,
    rain_threshold_mm: body.rainThresholdMm ?? 0.5,
    rain_threshold_probability: body.rainThresholdProbability ?? 50,
    rain_check_hours: body.rainCheckHours ?? 2,
    interval_days: body.intervalDays ?? 0,
    interval_anchor_date: body.intervalAnchorDate ?? null,
    timezone: body.timezone ?? null,
  });

  // Stuur timer_task naar maaier als die online is — maar NIET als rain_pause
  // actief is OF als interval_days mode aan staat (mower's timer_task is
  // strictly WEEKLY, interval scheduling lives server-side via the runner).
  if (isDeviceOnline(sn) && !body.rainPause && !(body.intervalDays && body.intervalDays > 0)) {
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

  const row = scheduleRepo.findById(scheduleId) as ScheduleRow;
  res.json({ ok: true, schedule: scheduleRowToDto(row) });
});

// PATCH /api/dashboard/schedules/:sn/:scheduleId — update schedule
dashboardRouter.patch('/schedules/:sn/:scheduleId', (req: Request, res: Response) => {
  const { sn, scheduleId } = req.params;
  const body = req.body as Record<string, unknown>;

  const existing = scheduleRepo.findByIdAndMower(scheduleId, sn);
  if (!existing) {
    res.status(404).json({ error: 'Schedule niet gevonden' });
    return;
  }

  scheduleRepo.updateByIdAndMower(scheduleId, sn, {
    schedule_name: body.scheduleName as string | undefined,
    start_time: body.startTime as string | undefined,
    end_time: body.endTime as string | undefined,
    weekdays: body.weekdays ? JSON.stringify(body.weekdays as number[]) : undefined,
    enabled: body.enabled !== undefined ? ((body.enabled as boolean) ? 1 : 0) : undefined,
    map_id: body.mapId as string | undefined,
    map_name: body.mapName as string | undefined,
    cutting_height: body.cuttingHeight as number | undefined,
    path_direction: body.pathDirection as number | undefined,
    work_mode: body.workMode as number | undefined,
    task_mode: body.taskMode as number | undefined,
    alternate_direction: body.alternateDirection !== undefined ? ((body.alternateDirection as boolean) ? 1 : 0) : undefined,
    alternate_step: body.alternateStep as number | undefined,
    edge_offset: body.edgeOffset as number | undefined,
    rain_pause: body.rainPause !== undefined ? ((body.rainPause as boolean) ? 1 : 0) : undefined,
    rain_threshold_mm: body.rainThresholdMm as number | undefined,
    rain_threshold_probability: body.rainThresholdProbability as number | undefined,
    rain_check_hours: body.rainCheckHours as number | undefined,
    interval_days: body.intervalDays as number | undefined,
    interval_anchor_date: body.intervalAnchorDate as string | undefined,
    timezone: body.timezone as string | undefined,
    skip_date: body.skipDate !== undefined ? (body.skipDate as string | null) : undefined,
  });

  const row = scheduleRepo.findById(scheduleId) as ScheduleRow;
  res.json({ ok: true, schedule: scheduleRowToDto(row) });
});

// DELETE /api/dashboard/schedules/:sn/:scheduleId — verwijder schedule
dashboardRouter.delete('/schedules/:sn/:scheduleId', (req: Request, res: Response) => {
  const { sn, scheduleId } = req.params;
  scheduleRepo.deleteByIdAndMower(scheduleId, sn);
  res.json({ ok: true });
});

// POST /api/dashboard/schedules/:sn/:scheduleId/send — push schedule naar maaier via MQTT
dashboardRouter.post('/schedules/:sn/:scheduleId/send', (req: Request, res: Response) => {
  const { sn, scheduleId } = req.params;

  if (!isDeviceOnline(sn)) {
    res.status(404).json({ error: 'Device is offline' });
    return;
  }

  const row = scheduleRepo.findByIdAndMower(scheduleId, sn) as ScheduleRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Schedule niet gevonden' });
    return;
  }

  // Bereken effectieve richting (met alternerende rotatie). trigger_count,
  // niet work_records: de maaier stuurt geen scheduleId in zijn records,
  // dus die count was altijd 0 (richting roteerde nooit).
  let effectiveDirection = row.path_direction;
  if (row.alternate_direction === 1) {
    const count = row.trigger_count ?? 0;
    // Modulo 180: maairichting is een lijn-oriëntatie (240° == 60°).
    effectiveDirection = (row.path_direction + count * (row.alternate_step ?? 90)) % 180;
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

// POST /api/dashboard/rain-ignore-session/:sn — user vinkte "Negeer regen
// deze sessie" aan in StartMowSheet. Server slaat per-mower vlag op die de
// rain monitor doet skippen tot de sessie eindigt (work_status terug naar
// idle). Body: { active: boolean }.
dashboardRouter.post('/rain-ignore-session/:sn', async (req: Request, res: Response) => {
  const { setRainIgnoreSession } = await import('../services/rainMonitor.js');
  const { active } = req.body as { active?: boolean };
  setRainIgnoreSession(req.params.sn, !!active);
  res.json({ ok: true, active: !!active });
});

// GET /api/dashboard/rain-ignore-session/:sn — zodat de RainOverlay banner
// kan tonen dat regen genegeerd wordt deze sessie.
dashboardRouter.get('/rain-ignore-session/:sn', async (req: Request, res: Response) => {
  const { isRainIgnoredForSession } = await import('../services/rainMonitor.js');
  res.json({ active: isRainIgnoredForSession(req.params.sn) });
});

// GET /api/dashboard/rain-sessions — alle actieve rain sessions
dashboardRouter.get('/rain-sessions', (_req: Request, res: Response) => {
  const sessions = getActiveRainSessions();
  res.json({ sessions });
});

// GET /api/dashboard/rain-settings/:sn — per-mower auto-pause settings
dashboardRouter.get('/rain-settings/:sn', async (req: Request, res: Response) => {
  const { rainSettingsRepo } = await import('../db/repositories/index.js');
  res.json(rainSettingsRepo.getEffective(req.params.sn));
});

// PUT /api/dashboard/rain-settings/:sn — update per-mower auto-pause settings
dashboardRouter.put('/rain-settings/:sn', async (req: Request, res: Response) => {
  const { rainSettingsRepo } = await import('../db/repositories/index.js');
  const body = req.body as {
    enabled?: boolean;
    thresholdMm?: number;
    thresholdProbability?: number;
    lookaheadHours?: number;
  };
  // Clamp to sane ranges so a fat-fingered input can't disable detection.
  const clamp = (v: number | undefined, lo: number, hi: number) =>
    v === undefined ? undefined : Math.max(lo, Math.min(hi, v));
  rainSettingsRepo.set(req.params.sn, {
    enabled: body.enabled,
    thresholdMm: clamp(body.thresholdMm, 0, 10),
    thresholdProbability: clamp(body.thresholdProbability, 0, 100),
    lookaheadHours: clamp(body.lookaheadHours, 0.25, 6),
  });
  res.json(rainSettingsRepo.getEffective(req.params.sn));
});

// GET /api/dashboard/seam-fix/:sn — per-mower border seam-fix config (app)
dashboardRouter.get('/seam-fix/:sn', async (req: Request, res: Response) => {
  const { seamFixRepo } = await import('../db/repositories/index.js');
  res.json(seamFixRepo.getEffective(req.params.sn));
});

// PUT /api/dashboard/seam-fix/:sn — update config + push it to the mower now
dashboardRouter.put('/seam-fix/:sn', async (req: Request, res: Response) => {
  const { seamFixRepo } = await import('../db/repositories/index.js');
  const { republishSeamFix } = await import('../mqtt/mapSync.js');
  const body = req.body as { enabled?: boolean; edgeMarginCm?: number };
  seamFixRepo.set(req.params.sn, {
    enabled: body.enabled,
    edgeMarginCm: body.edgeMarginCm === undefined ? undefined : Math.max(0, Math.min(30, body.edgeMarginCm)),
  });
  await republishSeamFix(req.params.sn);   // set_seam_fix -> mower (writes /userdata/lfi/seam_fix.json)
  res.json(seamFixRepo.getEffective(req.params.sn));
});

// GET /api/dashboard/rain-forecast/:sn — regen voorspelling voor een maaier
//
// GPS resolutie cascade — Open-Meteo grid is ~1km, dus iedere bron in de
// buurt van de maaier voldoet:
//   1. mapRepo.getChargerGps()    — door gebruiker op kaart geplaatst (precies)
//   2. live mower GPS-snapshot     — werkt zelfs zonder calibration (de maaier
//                                    rapporteert lat/lng via report_state_timer)
//   3. live charger GPS-snapshot  — fallback als de maaier geen fix heeft
// Zonder deze cascade returnt het endpoint `{available:false}` zodra een
// gebruiker net een nieuwe maaier paireert maar nog geen charger op de kaart
// heeft geplaatst — exact het scenario waarbij Walter / Ramon "geen regen
// warning" zien terwijl het buiten plenst.
dashboardRouter.get('/rain-forecast/:sn', async (req: Request, res: Response) => {
  const { sn } = req.params;

  let lat: number | null = null;
  let lng: number | null = null;

  const chargerGps = mapRepo.getChargerGps(sn);
  if (chargerGps) {
    lat = chargerGps.lat;
    lng = chargerGps.lng;
  } else {
    const tryLive = (snap: Record<string, string> | null | undefined) => {
      if (!snap) return false;
      const la = parseFloat(snap.latitude ?? '');
      const ln = parseFloat(snap.longitude ?? '');
      if (!isNaN(la) && !isNaN(ln) && la !== 0 && ln !== 0) {
        lat = la; lng = ln;
        return true;
      }
      return false;
    };
    if (!tryLive(getDeviceSnapshot(sn))) {
      const eqRow = equipmentRepo.findByMowerSn(sn);
      if (eqRow?.charger_sn) tryLive(getDeviceSnapshot(eqRow.charger_sn));
    }
  }

  if (lat == null || lng == null) {
    res.json({ available: false });
    return;
  }
  try {
    const forecast = await getWeatherForecast(lat, lng);
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

// POST /api/dashboard/equipment/set-active — zet actief equipment voor de user
// van de opgegeven mower. Alleen is_active=1 equipment is zichtbaar voor de
// officiële Novabot-app (userEquipmentList/getEquipmentBySN), zodat die maar
// één mower+charger pair tegelijk ziet. OpenNova zelf kan via dashboard-routes
// alle pairs bedienen.
dashboardRouter.post('/equipment/set-active', (req: Request, res: Response) => {
  const { sn } = req.body as { sn?: string };
  if (!sn || typeof sn !== 'string') {
    res.status(400).json({ ok: false, error: 'sn required' });
    return;
  }
  const ok = equipmentRepo.setActiveByMowerSn(sn);
  if (!ok) {
    res.status(404).json({ ok: false, error: 'mower_sn not bound to a user' });
    return;
  }
  console.log(`[Equipment] Active set to ${sn}`);
  res.json({ ok: true, activeMowerSn: sn });
});

// GET /api/dashboard/equipment/active?user=<user_id> — huidige actieve SN
dashboardRouter.get('/equipment/active', (req: Request, res: Response) => {
  const userId = String(req.query.user ?? '');
  if (!userId) {
    res.status(400).json({ ok: false, error: 'user query param required' });
    return;
  }
  const sn = equipmentRepo.getActiveMowerSn(userId);
  res.json({ ok: true, activeMowerSn: sn });
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
  const walls = virtualWallRepo.findByMowerSn(req.params.sn);
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
  virtualWallRepo.create(wallId, sn, wallName ?? null, lat1, lng1, lat2, lng2);

  // Sync alle enabled walls naar maaier
  syncVirtualWalls(sn);
  res.json({ ok: true, wallId });
});

// DELETE /api/dashboard/virtual-walls/:sn/:wallId — verwijder een virtual wall
dashboardRouter.delete('/virtual-walls/:sn/:wallId', (req: Request, res: Response) => {
  const { sn, wallId } = req.params;
  virtualWallRepo.deleteByIdAndMower(wallId, sn);
  syncVirtualWalls(sn);
  res.json({ ok: true });
});

/** Sync alle enabled virtual walls naar de maaier via MQTT */
function syncVirtualWalls(sn: string): void {
  const walls = virtualWallRepo.findEnabledByMowerSn(sn) as Array<{ lat1: number; lng1: number; lat2: number; lng2: number }>;

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

// POST /api/dashboard/mapping-preflight/:sn — read-only health gate before map
// actions. Sends mapping_preflight to extended_commands.py and waits for the
// respond, returning { verdict: ok|warn|block, checks, reasons }. Consumed by
// the app's Create-Map flow (block hard-stops, warn is advisory).
dashboardRouter.post('/mapping-preflight/:sn', async (req: Request, res: Response) => {
  const { sn } = req.params;
  if (!isDeviceOnline(sn)) {
    res.status(503).json({ ok: false, error: 'device offline' });
    return;
  }
  try {
    const { publishToExtended, onExtendedResponse, offExtendedResponse } =
      await import('../mqtt/mapSync.js');
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const onResp = (data: Record<string, unknown>) => {
        if (data.mapping_preflight_respond) {
          offExtendedResponse(sn, onResp);
          clearTimeout(timer);
          resolve(data.mapping_preflight_respond as Record<string, unknown>);
        }
      };
      const timer = setTimeout(() => {
        offExtendedResponse(sn, onResp);
        reject(new Error('timeout waiting for mapping_preflight_respond (stock firmware?)'));
      }, 8000);
      onExtendedResponse(sn, onResp);
      publishToExtended(sn, { mapping_preflight: {} });
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(504).json({ ok: false, error: (e as Error)?.message ?? String(e) });
  }
});

// ── Static firmware file serving ────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

export function getOtaBaseUrl(): string {
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
  const dbVersions = otaVersionRepo.findByDownloadUrlLike('%/api/dashboard/firmware/%') as OtaVersionRow[];

  // Map DB entries by filename extracted from URL
  const dbByFilename = new Map<string, OtaVersionRow>();
  for (const row of dbVersions) {
    const match = row.download_url?.match(/\/firmware\/([^/]+)$/);
    if (match) dbByFilename.set(decodeURIComponent(match[1]), row);
  }

  const validDbIds = new Set<number>();

  for (const filename of files) {
    const filePath = path.join(firmwareDir, filename);
    const fileBuffer = readFileSync(filePath);
    const md5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const size = fileBuffer.length;
    const downloadUrl = `${baseUrl}/api/dashboard/firmware/${encodeURIComponent(filename)}`;

    // Read metadata from companion .json if available
    const meta = readFirmwareMeta(filePath);
    const version = meta?.version ?? extractFirmwareVersion(filePath) ?? filename.replace(/\.(bin|deb)$/, '');
    const deviceType = meta?.device_type
      ?? (filename.endsWith('.deb') ? 'mower'
          : filename.startsWith('walker_firmware_') ? 'walker'
          : 'charger');
    const signature = meta?.signature ?? null;
    const signingKeyId = meta?.signing_key_id ?? meta?.signingKeyId ?? meta?.keyId ?? null;

    const existing = dbByFilename.get(filename);
    if (existing) {
      validDbIds.add(existing.id);
      if (
        existing.md5 !== md5
        || existing.sha256 !== sha256
        || existing.size !== size
        || existing.signature !== signature
        || existing.signing_key_id !== signingKeyId
      ) {
        // File or companion metadata changed.
        otaVersionRepo.updateById(existing.id, {
          version,
          device_type: deviceType,
          md5,
          sha256,
          size,
          signature,
          signing_key_id: signingKeyId,
          download_url: downloadUrl,
        });
        console.log(`\x1b[38;5;208m[OTA] Auto-updated: ${filename} (${version})\x1b[0m`);
      } else if (existing.download_url !== downloadUrl || existing.version !== version) {
        // URL or version changed — update
        otaVersionRepo.updateById(existing.id, {
          version,
          device_type: deviceType,
          download_url: downloadUrl,
        });
      }
    } else {
      // New file — auto-register
      otaVersionRepo.create({
        version,
        device_type: deviceType,
        download_url: downloadUrl,
        md5,
        sha256,
        size,
        signature,
        signing_key_id: signingKeyId,
      });
      console.log(`\x1b[38;5;208m[OTA] Auto-registered: ${filename} (${version}, ${deviceType})\x1b[0m`);
    }
  }

  // Remove DB entries for deleted files
  for (const row of dbVersions) {
    if (!validDbIds.has(row.id)) {
      const match = row.download_url?.match(/\/firmware\/([^/]+)$/);
      otaVersionRepo.deleteById(row.id);
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

// GET /api/dashboard/firmware/check-updates — fetch cloud manifest, return
// versions newer than what's installed locally, sorted newest-first.
// Open path (no admin gate) so the mobile app can show the same panel as
// the dashboard's Firmware tab — both poll the same logic via this single
// helper exported from adminStatus.ts.
dashboardRouter.get('/firmware-check-updates', async (_req: Request, res: Response) => {
  try {
    const { MANIFEST_URL, fetchJson, normaliseFirmwareDownloadUrl } = await import('./adminStatus.js');
    const manifest = await fetchJson(MANIFEST_URL) as { firmwares?: Array<FirmwareMeta & { version: string; device_type: string; url: string; filename?: string }> };
    const remoteFirmwares = manifest.firmwares || [];
    const localVersions = otaVersionRepo.listAll();
    const localVersionSet = new Set(localVersions.map((v: { version: string }) => v.version));
    const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const maxInstalledByType = new Map<string, string>();
    for (const v of localVersions) {
      const cur = maxInstalledByType.get(v.device_type);
      if (!cur || cmp.compare(v.version, cur) > 0) maxInstalledByType.set(v.device_type, v.version);
    }
    const available = remoteFirmwares
      .filter(fw => {
        const localMax = maxInstalledByType.get(fw.device_type);
        if (!localMax) return true;
        return cmp.compare(fw.version, localMax) > 0;
      })
      .map(fw => ({
        ...fw,
        url: normaliseFirmwareDownloadUrl(fw.url),
        filename: fw.filename || fw.url.split('/').pop() || `firmware_${fw.version}`,
        installed: localVersionSet.has(fw.version),
      }))
      .sort((a, b) => cmp.compare(b.version, a.version));
    res.json({
      available,
      installed: localVersions.map((v: OtaVersionRow) => ({
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
    console.error('[Dashboard] check-firmware-updates failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch manifest' });
  }
});

// POST /api/dashboard/firmware/download — pull a firmware from the remote
// manifest into the local firmware/ directory and register it in the OTA
// versions table so the OTA flow can pick it up.
dashboardRouter.post('/firmware-download', async (req: Request, res: Response) => {
  const { url: rawUrl, filename, version, device_type, md5, sha256, size, signature, description } = req.body as {
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
  const signingKeyId = (req.body as FirmwareMeta).signing_key_id
    ?? (req.body as FirmwareMeta).signingKeyId
    ?? (req.body as FirmwareMeta).keyId
    ?? null;
  if (!rawUrl || !filename || !version || !device_type) {
    res.status(400).json({ error: 'url, filename, version, and device_type are required' });
    return;
  }
  try {
    const { downloadFile, normaliseFirmwareDownloadUrl } = await import('./adminStatus.js');
    const url = normaliseFirmwareDownloadUrl(rawUrl);
    mkdirSync(firmwareDir, { recursive: true });
    const filePath = path.join(firmwareDir, filename);
    await downloadFile(url, filePath);
    const fileBuffer = readFileSync(filePath);
    const fileMd5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
    const fileSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const fileSize = fileBuffer.length;
    if (md5 && fileMd5 !== md5) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
      res.status(400).json({ error: `MD5 mismatch: expected ${md5}, got ${fileMd5}` });
      return;
    }
    if (sha256 && fileSha256 !== sha256) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
      res.status(400).json({ error: `SHA256 mismatch: expected ${sha256}, got ${fileSha256}` });
      return;
    }
    if (size && fileSize !== size) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
      res.status(400).json({ error: `Size mismatch: expected ${size}, got ${fileSize}` });
      return;
    }
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
    const port = process.env.PORT ?? '3000';
    const localUrl = `http://${process.env.TARGET_IP ?? '127.0.0.1'}:${port}/api/dashboard/firmware/${encodeURIComponent(filename)}`;
    const existing = otaVersionRepo.listAll().find((v: { version: string; device_type: string }) => v.version === version && v.device_type === device_type);
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
    res.json({
      ok: true,
      version,
      md5: fileMd5,
      sha256: fileSha256,
      size: fileSize,
      signature: signature || null,
      keyId: signingKeyId,
    });
  } catch (err) {
    console.error('[Dashboard] firmware download failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Download failed' });
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
 * Returns companion metadata or null.
 */
function readFirmwareMeta(filePath: string): FirmwareMeta | null {
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
  // eslint-disable-next-line no-useless-escape
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
  sha256: string | null;
  signature: string | null;
  size: number | null;
  signing_key_id: string | null;
  created_at: string;
}

interface FirmwareMeta {
  version?: string;
  device_type?: string;
  description?: string;
  md5?: string;
  sha256?: string;
  signature?: string;
  size?: number;
  signing_key_id?: string;
  signingKeyId?: string;
  keyId?: string;
}

// POST /api/dashboard/ota/sync — forceer firmware directory sync
dashboardRouter.post('/ota/sync', (_req: Request, res: Response) => {
  syncFirmwareVersions();
  const rows = otaVersionRepo.listAll() as OtaVersionRow[];
  res.json({ ok: true, synced: rows.length });
});

// GET /api/dashboard/ota/versions — lijst alle OTA versies
dashboardRouter.get('/ota/versions', (_req: Request, res: Response) => {
  const rows = otaVersionRepo.listAll() as OtaVersionRow[];
  res.json({ ok: true, versions: rows });
});

// POST /api/dashboard/ota/versions — voeg een OTA versie toe
dashboardRouter.post('/ota/versions', (req: Request, res: Response) => {
  const { version, device_type, download_url, release_notes, md5, sha256, size, signature } = req.body as {
    version: string;
    device_type?: string;
    download_url?: string;
    release_notes?: string;
    md5?: string;
    sha256?: string;
    size?: number;
    signature?: string;
  };
  const signingKeyId = (req.body as FirmwareMeta).signing_key_id
    ?? (req.body as FirmwareMeta).signingKeyId
    ?? (req.body as FirmwareMeta).keyId
    ?? null;

  // Auto-versie en md5 uit firmware bestand halen als download_url naar lokaal bestand wijst
  let resolvedVersion = version ?? null;
  let calculatedMd5 = md5 ?? null;
  let calculatedSha256 = sha256 ?? null;
  let calculatedSize = size ?? null;
  let detectedDeviceType = device_type ?? null;

  if (download_url) {
    const match = download_url.match(/\/firmware\/(.+)$/);
    if (match) {
      const filePath = path.join(firmwareDir, match[1]);
      if (existsSync(filePath)) {
        const fileBuffer = readFileSync(filePath);
        // Auto-bereken hashes
        if (!calculatedMd5) {
          calculatedMd5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
          console.log(`\x1b[38;5;208m[OTA] Auto-berekende md5 voor ${match[1]}: ${calculatedMd5}\x1b[0m`);
        }
        if (!calculatedSha256) calculatedSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        if (!calculatedSize) calculatedSize = fileBuffer.length;
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

  const id = otaVersionRepo.create({
    version: resolvedVersion,
    device_type: detectedDeviceType ?? 'charger',
    download_url: download_url ?? null,
    release_notes: release_notes ?? null,
    md5: calculatedMd5,
    sha256: calculatedSha256,
    size: calculatedSize,
    signature: signature ?? null,
    signing_key_id: signingKeyId,
  });

  console.log(`\x1b[38;5;208m[OTA] Versie toegevoegd: ${resolvedVersion} (${detectedDeviceType ?? 'charger'}) id=${id}\x1b[0m`);
  res.json({
    ok: true,
    id,
    version: resolvedVersion,
    device_type: detectedDeviceType ?? 'charger',
    md5: calculatedMd5,
    sha256: calculatedSha256,
    size: calculatedSize,
    signature: signature ?? null,
    keyId: signingKeyId,
  });
});

// PATCH /api/dashboard/ota/versions/:id — bewerk een OTA versie
dashboardRouter.patch('/ota/versions/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { version, device_type, download_url, release_notes, md5, sha256, size, signature } = req.body as {
    version?: string;
    device_type?: string;
    download_url?: string;
    release_notes?: string;
    md5?: string;
    sha256?: string;
    size?: number;
    signature?: string;
  };
  const signingKeyId = (req.body as FirmwareMeta).signing_key_id
    ?? (req.body as FirmwareMeta).signingKeyId
    ?? (req.body as FirmwareMeta).keyId;

  const existing = otaVersionRepo.findById(id);
  if (!existing) {
    res.status(404).json({ error: 'OTA versie niet gevonden' });
    return;
  }

  // Auto-recalculate md5 als download_url wijzigt naar lokaal bestand
  let calculatedMd5 = md5;
  let calculatedSha256 = sha256;
  let calculatedSize = size;
  if (download_url && (!calculatedMd5 || !calculatedSha256 || !calculatedSize)) {
    const urlMatch = download_url.match(/\/firmware\/(.+)$/);
    if (urlMatch) {
      const filePath = path.join(firmwareDir, urlMatch[1]);
      if (existsSync(filePath)) {
        const fileBuffer = readFileSync(filePath);
        calculatedMd5 = crypto.createHash('md5').update(fileBuffer).digest('hex');
        if (!calculatedSha256) calculatedSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        if (!calculatedSize) calculatedSize = fileBuffer.length;
      }
    }
  }

  otaVersionRepo.updateById(id, {
    version,
    device_type,
    download_url,
    release_notes,
    md5: calculatedMd5,
    sha256: calculatedSha256,
    size: calculatedSize,
    signature,
    signing_key_id: signingKeyId,
  });

  console.log(`\x1b[38;5;208m[OTA] Versie bijgewerkt: id=${id}${version ? ` version=${version}` : ''}\x1b[0m`);
  const row = otaVersionRepo.findById(id);
  res.json({ ok: true, version: row });
});

// DELETE /api/dashboard/ota/versions/:id — verwijder een OTA versie + firmware bestand
dashboardRouter.delete('/ota/versions/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const version = otaVersionRepo.findById(id);
  if (version?.download_url) {
    // Extract filename from download URL and delete the file
    const filename = version.download_url.split('/').pop();
    if (filename) {
      const firmwarePath = path.resolve(process.env.FIRMWARE_PATH ?? path.join(process.env.STORAGE_PATH ?? './storage', 'firmware'));
      const filePath = path.join(firmwarePath, filename);
      console.log(`[OTA] Deleting firmware file: ${filePath}`);
      try { fs.unlinkSync(filePath); console.log(`[OTA] Deleted: ${filePath}`); } catch (e) { console.warn(`[OTA] Failed to delete ${filePath}:`, (e as Error).message); }
      const jsonPath = filePath.replace(/\.(deb|bin)$/, '.json');
      try { fs.unlinkSync(jsonPath); console.log(`[OTA] Deleted: ${jsonPath}`); } catch (e) { console.warn(`[OTA] Failed to delete ${jsonPath}:`, (e as Error).message); }
    }
  }
  otaVersionRepo.deleteById(id);
  console.log(`\x1b[38;5;208m[OTA] Versie + bestand verwijderd: id=${id}\x1b[0m`);
  res.json({ ok: true });
});

// POST /api/dashboard/ota/trigger/:sn — stuur ota_upgrade_cmd naar apparaat
dashboardRouter.post('/ota/trigger/:sn', async (req: Request, res: Response) => {
  const { sn } = req.params;
  let gate: Awaited<ReturnType<typeof ensureBetaFlashSafe>> | undefined;
  const { version_id } = req.body as { version_id?: number };

  if (!version_id) {
    res.status(400).json({ error: 'version_id is vereist' });
    return;
  }

  const otaVersion = otaVersionRepo.findById(version_id) as OtaVersionRow | undefined;
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
    ? equipmentRepo.findByChargerSn(sn)
    : equipmentRepo.findByMowerSn(sn);
  const currentVersion = isChargerDevice
    ? equipRow?.charger_version
    : equipRow?.mower_version;

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

  // Forceer http:// — lokale server heeft geen TLS, maaier kan geen https.
  // Voor lokaal-gehoste firmware (/api/dashboard/firmware/...) altijd
  // herbouwen via getOtaBaseUrl() (TARGET_IP/PORT env). NOOIT req.headers.host
  // gebruiken: als admin via publieke FQDN binnenkomt (opennova.ramonvanbruggen.nl),
  // route die door Cloudflare/NPM met 301 https-redirect — mower curl heeft
  // geen FOLLOWLOCATION en download faalt.
  let downloadUrl = otaVersion.download_url!.replace(/^https:\/\//, 'http://');
  const filenameMatch = downloadUrl.match(/\/api\/dashboard\/firmware\/(.+)$/);
  if (filenameMatch) {
    const rebuilt = `${getOtaBaseUrl()}/api/dashboard/firmware/${filenameMatch[1]}`;
    if (rebuilt !== downloadUrl) {
      console.warn(`\x1b[33m[OTA] ⚠ URL host rewrite (LAN): ${downloadUrl} → ${rebuilt}\x1b[0m`);
      downloadUrl = rebuilt;
    }
  } else if (downloadUrl !== otaVersion.download_url) {
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
    // Charger v0.3.6 has NO AES — send plaintext. v0.4.0+ has AES.
    const chargerVersion = fwVersion || '';
    const chargerNeedsPlain = !chargerVersion.includes('0.4') && !chargerVersion.includes('0.5');
    if (chargerNeedsPlain) {
      const topic = `Dart/Send_mqtt/${sn}`;
      publishToTopic(topic, otaCommand);
      console.log(`\x1b[38;5;208m[OTA] PLAIN ota_upgrade_cmd naar charger ${sn} (${chargerVersion || 'unknown version'})\x1b[0m`);
    } else {
      publishToDevice(sn, otaCommand);
      console.log(`\x1b[38;5;208m[OTA] Encrypted ota_upgrade_cmd naar charger ${sn}\x1b[0m`);
    }
  } else {
    // ── BETA gate: custom/opennova firmware must have a fresh backup first ──
    try {
      gate = await ensureBetaFlashSafe(sn, otaVersion.version, { force: forceOta });
    } catch (err) {
      console.error(`\x1b[31m[OTA] BETA gate error voor ${sn}:\x1b[0m`, err);
      res.status(500).json({ error: 'BETA_GATE_ERROR', detail: 'Kon backup-gate niet uitvoeren' });
      return;
    }
    if (!gate.allowed) {
      console.warn(`\x1b[31m[OTA] BETA flash geblokkeerd voor ${sn}: ${gate.detail}\x1b[0m`);
      res.status(409).json({ error: gate.error, detail: gate.detail });
      return;
    }
    if (gate.backup) {
      console.log(`\x1b[38;5;208m[OTA] BETA backup ok (${gate.reason}): ${gate.backup.filename}\x1b[0m`);
    }

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

  res.json({
    ok: true,
    command: 'ota_upgrade_cmd',
    version: otaVersion.version,
    target: sn,
    backup: gate && gate.allowed ? gate.backup : null,
  });
});

// ── LoRa address allocation ──────────────────────────────────────

// GET /api/dashboard/lora/next-address — get next free LoRa address for a new charger
// (Legacy: type-agnostic next free addr. Blijft staan voor bestaande callers,
// maar nieuwe code zou /lora/resolve?type=... moeten gebruiken voor pair-aware
// auto-assign.)
dashboardRouter.get('/lora/next-address', (_req: Request, res: Response) => {
  const usedAddresses = new Set(equipmentRepo.listUsedLoraAddresses());
  // Start at 718 (Novabot default), find next unused
  let nextAddr = 718;
  while (usedAddresses.has(nextAddr)) {
    nextAddr++;
  }

  res.json({ address: nextAddr, channel: 16, hc: 20, lc: 14 });
});

// GET /api/dashboard/lora/resolve?type=charger|mower — authoritative address
// resolution voor provisioning, pair-aware per user-spec 2026-04-21
// (bijgewerkt 22 apr 2026):
//
//   CHARGER: address = max(bestaande charger addrs) + 1 (start 718 als leeg),
//            channel = default 16
//   MOWER:   zoek "orphan" charger (charger in cache zonder gepaarde mower op
//            hetzelfde addr). address = orphan.addr, channel = orphan.channel
//            (zelfde addr EN zelfde channel — live geverifieerd 22 apr 2026:
//            beide devices op addr=718 ch=17, werkend RTK-paar).
//            Als geen orphan: address = max(bestaande mower addrs) + 1,
//            channel = 16 (zelfde default als charger).
//
// Returns { ok, address, channel, hc, lc, basis } waarbij `basis` uitlegt welke
// regel getriggerd is — handig voor UI weergave en debugging.
dashboardRouter.get('/lora/resolve', (req: Request, res: Response) => {
  const type = String(req.query.type ?? '').toLowerCase();
  if (type !== 'charger' && type !== 'mower') {
    res.status(400).json({ ok: false, error: 'type=charger|mower required' });
    return;
  }

  // Categorize cache entries by SN prefix. Entries met "CHARGER_PILE" of
  // andere generieke BLE-namen worden genegeerd (vervuiling door iOS anon-UUID
  // registraties, zie ble-provisioning-facts.md).
  //
  // KRITIEK — de cache bevat historisch ook "ghost" rijen van devices die
  // nooit meer online komen (zoals test-mowers uit oude cloud imports).
  // Zonder die eruit te filteren zou een orphan charger niet als orphan
  // gezien worden als er een ghost-mower aan dezelfde addr "gepaird"
  // bleef. Vandaar: alleen mower-rijen meetellen die ook echt bestaan
  // (bound aan een user in de equipment tabel, OF recent online gezien
  // via MQTT). Dit matcht het `/device-sets` filter (seenSns || boundSns).
  //
  // PENDING_CHARGER_* / PENDING_MOWER_* tellen ook mee — anders zouden
  // parallelle provisionings dezelfde addr krijgen.
  const cache = equipmentRepo.listLoraCache();
  const toRow = (r: { sn: string; charger_address: string | null; charger_channel: string | null }) => ({
    sn: r.sn,
    addr: r.charger_address != null ? Number(r.charger_address) : NaN,
    channel: r.charger_channel != null ? Number(r.charger_channel) : NaN,
  });

  // Actieve-SN set: bound aan een user OF recent online via MQTT.
  const activeSns = new Set<string>();
  for (const eq of equipmentRepo.listBoundSnForExistingUsers()) {
    if (eq.mower_sn) activeSns.add(eq.mower_sn);
    if (eq.charger_sn) activeSns.add(eq.charger_sn);
  }
  try {
    for (const row of deviceRepo.listLatestBySn()) {
      if (row.sn) activeSns.add(row.sn);
    }
  } catch { /* ignore */ }

  const isActiveOrPending = (sn: string, typePrefix: 'LFIC' | 'LFIN', pendingType: 'CHARGER' | 'MOWER'): boolean => {
    if (sn.startsWith(`PENDING_${pendingType}_`)) return true;
    if (!sn.startsWith(typePrefix)) return false;
    return activeSns.has(sn);
  };

  const chargerRows = cache
    .filter((r: { sn: string }) => isActiveOrPending(r.sn, 'LFIC', 'CHARGER'))
    .map(toRow)
    .filter((r: { addr: number }) => Number.isFinite(r.addr));
  const mowerRows = cache
    .filter((r: { sn: string }) => isActiveOrPending(r.sn, 'LFIN', 'MOWER'))
    .map(toRow)
    .filter((r: { addr: number }) => Number.isFinite(r.addr));

  // Helper om na resolve ook direct een PENDING row in de cache te zetten,
  // zodat (a) volgende /lora/resolve calls dezelfde addr niet opnieuw geven
  // en (b) we later de row promoten naar de echte SN zodra het device
  // voor het eerst online komt via MQTT. De "claim" logic zit in broker.ts
  // `authenticate` → `onlineBySn.add`. Een onclaimed pending wordt na 10
  // min opgeruimd door de sweeper hieronder.
  const reservePending = (typeUpper: 'CHARGER' | 'MOWER', addr: number, ch: number): string => {
    const pendingSn = `PENDING_${typeUpper}_${Date.now()}_${addr}`;
    try {
      equipmentRepo.setLoraCache(pendingSn, String(addr), String(ch));
    } catch (e) {
      console.log(`[LORA] Could not reserve pending ${pendingSn}: ${e}`);
    }
    return pendingSn;
  };

  if (type === 'charger') {
    // Symmetrisch met mower-branch: zoek eerst een orphan mower — een mower
    // waarvoor geen charger op dezelfde addr bestaat. Dan weten we dat deze
    // user eerder een mower heeft geprovisioneerd en nu een (her)provisioning
    // van de charger doet. Charger pakt dan mower's bestaande addr+channel,
    // zodat het pair niet drift op max+1. Dit voorkomt bug waarbij een her-
    // geprovisioneerde charger op 719 eindigt terwijl de gebonden mower op 718
    // blijft — wat Error 8 (LoRa comm fail) + Error 132 veroorzaakt.
    const chargerAddrs = new Set(chargerRows.map(r => r.addr));
    const orphanMower = mowerRows.find(m => !chargerAddrs.has(m.addr));

    if (orphanMower) {
      const addr = orphanMower.addr;
      const ch = Number.isFinite(orphanMower.channel) ? orphanMower.channel : 16;
      const pendingSn = reservePending('CHARGER', addr, ch);
      res.json({
        ok: true, address: addr, channel: ch, hc: 20, lc: 14,
        basis: `paired-with-orphan-${orphanMower.sn}`,
        pendingSn,
      });
      return;
    }

    const usedChargerAddrs = new Set(chargerRows.map(r => r.addr));
    let addr = 718;
    while (usedChargerAddrs.has(addr)) addr++;
    const basis = chargerRows.length === 0 ? 'first-charger' : 'charger-incremented';
    const pendingSn = reservePending('CHARGER', addr, 16);
    res.json({ ok: true, address: addr, channel: 16, hc: 20, lc: 14, basis, pendingSn });
    return;
  }

  // type === 'mower'
  // Orphan charger = charger zonder pair (geen mower-rij met hetzelfde addr)
  const mowerAddrs = new Set(mowerRows.map(r => r.addr));
  const orphanCharger = chargerRows.find(c => !mowerAddrs.has(c.addr));

  if (orphanCharger) {
    const addr = orphanCharger.addr;
    // Mower krijgt HETZELFDE channel als de charger (niet channel-1, zie boven).
    const ch = Number.isFinite(orphanCharger.channel) ? orphanCharger.channel : 16;
    const pendingSn = reservePending('MOWER', addr, ch);
    res.json({
      ok: true, address: addr, channel: ch, hc: 20, lc: 14,
      basis: `paired-with-orphan-${orphanCharger.sn}`,
      pendingSn,
    });
    return;
  }

  // Geen orphan charger → neem hoogste mower addr + 1, channel default 16
  // (zelfde als charger default, mower+charger staan altijd op identiek paar).
  const maxMowerAddr = mowerRows.length > 0 ? Math.max(...mowerRows.map(r => r.addr)) : 717;
  const addr = maxMowerAddr + 1;
  const pendingSn = reservePending('MOWER', addr, 16);
  res.json({
    ok: true, address: addr, channel: 16, hc: 20, lc: 14,
    basis: mowerRows.length === 0 ? 'first-mower' : 'mower-incremented-no-orphan',
    pendingSn,
  });
});

// GET /api/dashboard/lora/pending — list unclaimed pending reservations.
// Gebruikt door de dashboard "Provisioning pending" sectie zodat users
// direct na een BLE-provisioning zien dat hun maaier gereserveerd is in
// de DB, zelfs voordat het device voor het eerst online komt. Auto-cleanup
// na 10 min via de sweeper hieronder.
dashboardRouter.get('/lora/pending', (_req: Request, res: Response) => {
  try {
    const cache = equipmentRepo.listLoraCache();
    const now = Date.now();
    const pending = cache
      .filter((r: { sn: string }) => r.sn.startsWith('PENDING_'))
      .map((r: { sn: string; charger_address: string | null; charger_channel: string | null }) => {
        const parts = r.sn.split('_');
        const typeUpper = parts[1] ?? 'UNKNOWN';
        const tsMs = parts.length >= 3 ? parseInt(parts[2], 10) : 0;
        const ageSeconds = Number.isFinite(tsMs) ? Math.floor((now - tsMs) / 1000) : null;
        return {
          pendingSn: r.sn,
          type: typeUpper.toLowerCase(),
          address: r.charger_address != null ? Number(r.charger_address) : null,
          channel: r.charger_channel != null ? Number(r.charger_channel) : null,
          createdAt: Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : null,
          ageSeconds,
        };
      })
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    res.json({ ok: true, pending });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// DELETE /api/dashboard/lora/pending/:pendingSn — cancel een pending
// provisioning handmatig (user klikt Cancel op de dashboard card als hij
// doorheeft dat de mower nooit online komt).
dashboardRouter.delete('/lora/pending/:pendingSn', (req: Request, res: Response) => {
  const { pendingSn } = req.params;
  if (!pendingSn.startsWith('PENDING_')) {
    res.status(400).json({ ok: false, error: 'only PENDING_* sns allowed' });
    return;
  }
  equipmentRepo.deleteLoraCache(pendingSn);
  console.log(`[LORA] Manual cancel pending ${pendingSn}`);
  res.json({ ok: true });
});

// Pending cleanup sweeper — ruim placeholders ouder dan 10 min op. Als
// een provisioning-sessie is afgebroken of het device nooit online komt,
// moet z'n LoRa-reservering na een redelijke tijd teruggeven worden.
setInterval(() => {
  try {
    const cache = equipmentRepo.listLoraCache();
    const now = Date.now();
    for (const row of cache as Array<{ sn: string }>) {
      if (!row.sn.startsWith('PENDING_')) continue;
      const parts = row.sn.split('_');
      const tsMs = parts.length >= 3 ? parseInt(parts[2], 10) : 0;
      if (!Number.isFinite(tsMs)) continue;
      if (now - tsMs > 10 * 60 * 1000) {
        console.log(`[LORA] Cleanup pending ${row.sn} (age > 10 min)`);
        equipmentRepo.deleteLoraCache(row.sn);
      }
    }
  } catch { /* ignore */ }
}, 60_000);

// GET /api/dashboard/lora/check?addr=718&channel=16 — check whether a given
// LoRa addr/channel is already in use. Returns the SNs of conflicting devices.
// Gebruikt door de provisioning-UI om een waarschuwing te tonen voordat de
// user een address kiest dat al op een bestaand apparaat draait (observed
// 2026-04-21: accidentally re-provisioned test mower to a conflicting addr
// because BLE scan showed anonymized iOS UUIDs instead of MAC/SN).
dashboardRouter.get('/lora/check', (req: Request, res: Response) => {
  const addr = parseInt(String(req.query.addr ?? ''), 10);
  const channel = req.query.channel != null
    ? parseInt(String(req.query.channel), 10)
    : null;
  if (!Number.isFinite(addr) || addr < 0) {
    res.status(400).json({ ok: false, error: 'addr required' });
    return;
  }
  const rows = equipmentRepo.listLoraCache()
    .filter((r: { sn: string }) => !r.sn.startsWith('PENDING_')) // placeholders niet in user-facing conflict lijst
    .filter((r: { charger_address: number | null | string; charger_channel: number | null | string; sn: string }) => {
      const rowAddr = r.charger_address != null ? Number(r.charger_address) : null;
      const rowCh = r.charger_channel != null ? Number(r.charger_channel) : null;
      if (rowAddr !== addr) return false;
      if (channel != null && rowCh != null && rowCh !== channel) return false;
      return true;
    })
    .map((r: { sn: string; charger_address: number | null | string; charger_channel: number | null | string }) => ({
      sn: r.sn,
      addr: r.charger_address != null ? Number(r.charger_address) : null,
      channel: r.charger_channel != null ? Number(r.charger_channel) : null,
    }));
  res.json({ ok: true, conflicts: rows, inUse: rows.length > 0 });
});

// GET /api/dashboard/device-sets — group devices into charger↔mower sets based on LoRa address
dashboardRouter.get('/device-sets', (_req: Request, res: Response) => {
  // Devices that have ever connected via MQTT (real-world presence).
  const deviceRows = deviceRepo.listLatestBySn()
    .filter(row => row.sn != null)
    .map(row => ({
      sn: row.sn as string,
      mac_address: row.mac_address,
      last_seen: row.last_seen,
    }));
  const seenSns = new Set(deviceRows.map(r => r.sn));

  // Devices that the user has explicitly bound (equipment table).
  const boundSns = new Set<string>();
  for (const eq of equipmentRepo.listBoundSnForExistingUsers()) {
    if (eq.mower_sn) boundSns.add(eq.mower_sn);
    if (eq.charger_sn) boundSns.add(eq.charger_sn);
  }

  // Filter LoRa cache to skip "ghosts" — entries that have a LoRa cache row but
  // never appeared in MQTT registry AND aren't bound. These are leftovers from
  // (a) previous test data lekkage vóór de vitest isolation fix and (b) the
  // hardcoded INSERT OR IGNORE seeds we removed in database.ts. Without this
  // filter every fresh install would have shown phantom paired sets.
  const loraRows = equipmentRepo.listLoraCache()
    .filter(row => seenSns.has(row.sn) || boundSns.has(row.sn))
    .map(row => ({
      sn: row.sn,
      charger_address: row.charger_address != null ? Number(row.charger_address) : null,
      charger_channel: row.charger_channel != null ? Number(row.charger_channel) : null,
    }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

  const sets: Array<{
    loraAddress: number | null;
    charger: { sn: string; online: boolean } | null;
    mower: { sn: string; online: boolean } | null;
  }> = [];

  // LoRa-cache pairings first (most authoritative — set during BLE provisioning)
  for (const [addr, pair] of byAddr) {
    sets.push({
      loraAddress: addr,
      charger: pair.charger ? { sn: pair.charger, online: isDeviceOnline(pair.charger) } : null,
      mower: pair.mower ? { sn: pair.mower, online: isDeviceOnline(pair.mower) } : null,
    });
  }

  // Fall back: equipment table pairing. When the LoRa cache hasn't been
  // populated (or got wiped) but the user has a real charger↔mower binding
  // in the equipment table, group them as one set so they show up paired
  // in the Home tab instead of as two lonely cards.
  for (const eq of equipmentRepo.listBoundSnForExistingUsers()) {
    if (!eq.mower_sn || !eq.charger_sn) continue;
    if (paired.has(eq.mower_sn) || paired.has(eq.charger_sn)) continue;
    paired.add(eq.mower_sn);
    paired.add(eq.charger_sn);
    sets.push({
      loraAddress: null,
      charger: { sn: eq.charger_sn, online: isDeviceOnline(eq.charger_sn) },
      mower: { sn: eq.mower_sn, online: isDeviceOnline(eq.mower_sn) },
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
  const loraRow = equipmentRepo.getLoraCache(chargerSn);

  if (!loraRow) {
    res.status(404).json({ error: 'Charger not found in LoRa cache — provision charger first' });
    return;
  }

  // Check if mower already has its own equipment record
  const mowerEquip = equipmentRepo.findByMowerSn(mowerSn);

  // Check if charger has an equipment record
  const chargerEquip = equipmentRepo.findBySn(chargerSn);

  // If mower has its own record, delete it first (will be merged into charger's record)
  if (mowerEquip && (!chargerEquip || mowerEquip.equipment_id !== chargerEquip?.equipment_id)) {
    equipmentRepo.deleteById(mowerEquip.equipment_id);
    console.log(`[pair] Removed mower's standalone equipment record ${mowerEquip.equipment_id}`);
  }

  if (chargerEquip && chargerEquip.mower_sn === chargerSn) {
    // Charger is stored as mower_sn (charger-first flow) — update to add mower
    equipmentRepo.swapChargerFirstToPaired(chargerEquip.equipment_id, mowerSn);
    console.log(`[pair] Paired mower ${mowerSn} with charger ${chargerSn} (updated existing record)`);
  } else if (chargerEquip) {
    // Charger already has a record — set mower + charger SNs
    equipmentRepo.setMowerAndChargerSn(chargerEquip.equipment_id, mowerSn, chargerSn);
    console.log(`[pair] Paired mower ${mowerSn} with charger ${chargerSn} (into existing charger record)`);
  } else {
    // No equipment record for either — create one with both
    const equipmentId = `EQ_${Date.now()}`;
    equipmentRepo.create({
      equipment_id: equipmentId,
      mower_sn: mowerSn,
      charger_sn: chargerSn,
      charger_address: loraRow.charger_address,
      charger_channel: loraRow.charger_channel,
    });
    console.log(`[pair] Created equipment ${equipmentId}: mower=${mowerSn} charger=${chargerSn}`);
  }

  // Copy LoRa address to mower's lora_cache entry
  equipmentRepo.setLoraCache(mowerSn, String(loraRow.charger_address), String(loraRow.charger_channel));

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
      const resp = data.get_lora_info_respond as { addr?: number; channel?: number };
      if (resp?.addr != null && resp?.channel != null) {
        equipmentRepo.setLoraCache(mowerSn, String(resp.addr), String(resp.channel));
        console.log(`[LORA] Mower ${mowerSn} reported addr=${resp.addr} ch=${resp.channel}`);
      }
      res.json(resp);
    }
  };

  onExtendedResponse(mowerSn, handler);
  publishToExtended(mowerSn, { get_lora_info: {} });
});

// POST /api/dashboard/lora/query-charger/:chargerSn — ask charger for its LoRa config via MQTT
dashboardRouter.post('/lora/query-charger/:chargerSn', async (req: Request, res: Response) => {
  const { chargerSn } = req.params;
  const { publishToDevice, onDeviceResponse, offDeviceResponse } = await import('../mqtt/mapSync.js');

  let resolved = false;
  const timeout = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      offDeviceResponse(chargerSn, handler);
      res.status(504).json({ error: 'Charger did not respond (timeout)' });
    }
  }, 10000);

  const handler = (data: Record<string, unknown>) => {
    if (resolved) return;
    // Charger reply: {"type":"get_lora_info_respond","message":{"result":0,"value":{addr,channel,hc,lc}}}
    if (data.type === 'get_lora_info_respond') {
      resolved = true;
      clearTimeout(timeout);
      offDeviceResponse(chargerSn, handler);
      res.json(data.message);
    }
  };

  onDeviceResponse(chargerSn, handler);
  publishToDevice(chargerSn, { get_lora_info: null });
});

// POST /api/dashboard/opennova/detect/:mowerSn — probe mower for OpenNova firmware
dashboardRouter.post('/opennova/detect/:mowerSn', async (req: Request, res: Response) => {
  const { mowerSn } = req.params;
  const { publishToExtended, onExtendedResponse, offExtendedResponse } = await import('../mqtt/mapSync.js');

  let resolved = false;
  const timeout = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      offExtendedResponse(mowerSn, handler);
      // No response = stock firmware (silently ignored)
      res.json({ isOpenNova: false });
    }
  }, 5000);

  const handler = (data: Record<string, unknown>) => {
    if (resolved) return;
    if (data.is_opennova_respond) {
      resolved = true;
      clearTimeout(timeout);
      offExtendedResponse(mowerSn, handler);
      equipmentRepo.setOpenNova(mowerSn);
      res.json({ isOpenNova: true, version: (data.is_opennova_respond as { version?: string })?.version });
    }
  };

  onExtendedResponse(mowerSn, handler);
  publishToExtended(mowerSn, { is_opennova: {} });
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
  equipmentRepo.setLoraCache(mowerSn, String(addr), String(channel));

  console.log(`[lora] Set mower ${mowerSn} LoRa: addr=${addr} channel=${channel}`);
  res.json({ ok: true, addr, channel });
});

// GET /api/dashboard/lora/for-charger/:chargerSn — get LoRa params for a specific charger
dashboardRouter.get('/lora/for-charger/:chargerSn', (req: Request, res: Response) => {
  const { chargerSn } = req.params;
  const row = equipmentRepo.getLoraCache(chargerSn);

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
  equipmentRepo.setLoraCache(sn, String(address), String(channel ?? 16));
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

// POST /api/dashboard/error/:sn/clear — clear latched error_status (e.g. 126 recharge failed)
// Stock firmware latches error_status until state machine resets. cancel_recharge
// (ROS service /robot_decision/cancel_recharge, mapped to MQTT `stop_to_charge`) clears
// the recharge-failed latch. We also send `clear_error: {}` for custom-firmware paths
// and optimistically wipe error fields in sensor cache so UI updates immediately.
dashboardRouter.post('/error/:sn/clear', (req: Request, res: Response) => {
  const { sn } = req.params;
  if (!isDeviceOnline(sn)) {
    res.status(404).json({ error: 'Device is offline' });
    return;
  }

  publishToDevice(sn, { stop_to_charge: {} });
  publishToDevice(sn, { clear_error: {} });

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
      console.log(`[ErrorClear] Cleared error fields in cache for ${sn}`);
    }
  }

  res.json({ ok: true });
});

// ── Camera proxy ──────────────────────────────────────────────────────────────

import http from 'http';

// GET /api/dashboard/camera/:sn/info — retourneert directe maaier camera URLs
// App gebruikt dit om direct met de maaier te verbinden (geen proxy/Cloudflare).
// Trigger mDNS discovery bij eerste call zodat een onbekende mower zichzelf
// kan vinden zonder dat de gebruiker handmatig een IP moet invoeren.
dashboardRouter.get('/camera/:sn/info', async (req: Request, res: Response) => {
  const sn = req.params.sn;
  const port = parseInt(req.query.port as string) || 8000;
  const queryIp = req.query.ip as string | undefined;
  const ip = queryIp ?? (await resolveMowerIp(sn, { awaitDiscovery: true }));
  if (!ip) {
    res.status(404).json({ error: 'Maaier IP onbekend' });
    return;
  }
  res.json({
    ip,
    port,
    streamUrl: `http://${ip}:${port}/stream`,
    snapshotUrl: `http://${ip}:${port}/snapshot`,
  });
});

// GET /api/dashboard/camera/:sn/stream — proxy MJPEG stream van de maaier
dashboardRouter.get('/camera/:sn/stream', async (req: Request, res: Response) => {
  let ip = req.query.ip as string | undefined;
  const port = parseInt(req.query.port as string) || 8000;

  if (!ip) {
    ip = (await resolveMowerIp(req.params.sn, { awaitDiscovery: true })) ?? undefined;
    if (!ip) {
      res.status(404).json({ error: 'Maaier IP onbekend' });
      return;
    }
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
dashboardRouter.get('/camera/:sn/snapshot', async (req: Request, res: Response) => {
  let ip = req.query.ip as string | undefined;
  const port = parseInt(req.query.port as string) || 8000;

  if (!ip) {
    ip = (await resolveMowerIp(req.params.sn, { awaitDiscovery: true })) ?? undefined;
    if (!ip) {
      res.status(404).json({ error: 'Maaier IP onbekend' });
      return;
    }
  }

  const topic = req.query.topic as string || 'front';
  const upstream = http.get(`http://${ip}:${port}/snapshot?topic=${encodeURIComponent(topic)}`, (proxyRes) => {
    const ctype = proxyRes.headers['content-type'] ?? '';
    // The mower activates cameras on-demand; during cold-start / topic-not-ready
    // it can answer 200 with an HTML error page. Passing that through as
    // image/jpeg gave the browser a broken blob it set as <img> and never
    // recovered from (black tile + broken icon). Only forward a real image;
    // anything else → 502 so the client's retry / "unavailable" path engages
    // and self-heals once the camera is warm.
    const isImage = proxyRes.statusCode === 200 && /^image\//i.test(ctype);
    if (!isImage) {
      proxyRes.resume(); // drain
      if (!res.headersSent) {
        res.status(502).json({ error: 'Camera niet gereed', upstreamStatus: proxyRes.statusCode ?? 0, upstreamType: ctype });
      }
      return;
    }
    const chunks: Buffer[] = [];
    proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    proxyRes.on('end', () => {
      const body = Buffer.concat(chunks);
      // Guard against a 200 with an empty/garbage body (also breaks <img>).
      if (body.length < 100 && !res.headersSent) {
        res.status(502).json({ error: 'Camera lege frame' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': ctype || 'image/jpeg',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    });
  });
  upstream.setTimeout(8000, () => {
    upstream.destroy(new Error('camera timeout'));
  });
  upstream.on('error', (err) => {
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
  const users = userRepo.listBasic();

  if (users.length === 0) {
    res.json({ hasAccount: false });
    return;
  }

  const user = users[0];
  const equipment = equipmentRepo.findByUserId(user.app_user_id);

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
  const count = userRepo.count();
  res.json({ hasUsers: count > 0 });
});

// POST /api/dashboard/setup/create-user — maak de eerste gebruiker aan (alleen als DB leeg is)
dashboardRouter.post('/setup/create-user', async (req: Request, res: Response) => {
  const { email, password, username } = req.body as { email?: string; password?: string; username?: string };

  if (!email || !password) {
    res.status(400).json({ ok: false, error: 'Email en wachtwoord zijn verplicht' });
    return;
  }

  const count = userRepo.count();
  if (count > 0) {
    res.status(409).json({ ok: false, error: 'Er bestaat al een gebruiker. Gebruik de inlogpagina.' });
    return;
  }

  const bcrypt = await import('bcrypt');
  const hash = await bcrypt.hash(password, 10);
  const appUserId = uuidv4();

  userRepo.create(appUserId, email.trim().toLowerCase(), hash, username?.trim() ?? '');

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
  const existingUser = userRepo.findByEmail(normalizedEmail);

  let appUserId: string;
  let userId: number;

  if (existingUser) {
    // Update wachtwoord als de gebruiker al bestaat
    const hash = await bcrypt.hash(password, 10);
    userRepo.updatePassword(existingUser.app_user_id, hash);
    appUserId = existingUser.app_user_id;
    userId = existingUser.id;
    console.log(`[admin/import] Bestaande gebruiker bijgewerkt: ${normalizedEmail}`);
  } else {
    const hash = await bcrypt.hash(password, 10);
    appUserId = uuidv4();
    userRepo.create(appUserId, normalizedEmail, hash, deviceName ?? '');
    userId = (userRepo.findById(appUserId) as { id: number }).id;
    console.log(`[admin/import] Nieuwe gebruiker aangemaakt: ${normalizedEmail}`);
  }

  // 2. Seed equipment_lora_cache voor het laadstation
  if (charger.address != null && charger.channel != null) {
    equipmentRepo.setLoraCache(charger.sn, String(charger.address), String(charger.channel));
  }

  // 3. Maak charger equipment record aan (of update bestaande)
  const existingCharger = equipmentRepo.findByMowerSn(charger.sn);

  if (existingCharger) {
    equipmentRepo.updateDashboardImportCharger(
      existingCharger.equipment_id,
      appUserId,
      charger.address != null ? String(charger.address) : null,
      charger.channel != null ? String(charger.channel) : null,
      charger.mac ?? null,
      deviceName ?? null,
    );
    console.log(`[admin/import] Charger ${charger.sn} bijgewerkt`);
  } else {
    const equipmentId = uuidv4();
    equipmentRepo.create({
      equipment_id: equipmentId,
      user_id: appUserId,
      mower_sn: charger.sn,
      charger_sn: null,
      equipment_type_h: charger.sn.slice(0, 5),
      nick_name: deviceName ?? null,
      charger_address: charger.address != null ? String(charger.address) : null,
      charger_channel: charger.channel != null ? String(charger.channel) : null,
      mac_address: charger.mac ?? null,
    });
    console.log(`[admin/import] Charger ${charger.sn} aangemaakt`);
  }

  // 4. Maak mower equipment record aan (als mower SN beschikbaar)
  if (mower?.sn) {
    const existingMower = equipmentRepo.findByMowerSn(mower.sn);

    if (existingMower) {
      equipmentRepo.updateDashboardImportMower(
        existingMower.equipment_id,
        appUserId,
        charger.sn,
        mower.mac ?? null,
        mower.version ?? null,
        deviceName ?? null,
      );
      console.log(`[admin/import] Maaier ${mower.sn} bijgewerkt`);
    } else {
      const equipmentId = uuidv4();
      equipmentRepo.create({
        equipment_id: equipmentId,
        user_id: appUserId,
        mower_sn: mower.sn,
        charger_sn: charger.sn,
        equipment_type_h: mower.sn.slice(0, 5),
        nick_name: deviceName ?? null,
        mac_address: mower.mac ?? null,
        mower_version: mower.version ?? null,
      });
      console.log(`[admin/import] Maaier ${mower.sn} aangemaakt`);
    }
  }

  // 5. Best-effort: pull historic mowing records from the LFI cloud
  // so the OpenNova app's Records tab is populated immediately. Wraps
  // its own try block — any failure here is non-fatal.
  let workRecordsImported = 0;
  if (mower?.sn) {
    try {
      const { encryptCloudPassword, callLfiCloud } = await import('../services/lfiCloud.js');
      const { importCloudWorkRecords } = await import('../services/cloudWorkRecordsImport.js');
      const encryptedPw = encryptCloudPassword(password);
      const loginResp = await callLfiCloud('POST', '/api/nova-user/appUser/login', {
        email, password: encryptedPw, imei: 'imei',
      });
      const loginVal = (loginResp as Record<string, unknown>).value as Record<string, unknown> | undefined;
      const cloudToken = loginVal?.accessToken as string | undefined;
      const cloudAppUserId = loginVal?.appUserId as number | string | undefined;
      if (cloudToken && cloudAppUserId != null) {
        const equip = equipmentRepo.findByMowerSn(mower.sn);
        const equipmentId = equip?.equipment_id ?? mower.sn;
        const result = await importCloudWorkRecords(
          cloudToken, cloudAppUserId, appUserId, equipmentId,
        );
        workRecordsImported = result.inserted;
      }
    } catch (recErr) {
      console.warn('[admin/import] Work-records import failed (non-fatal):', recErr);
    }
  }

  res.json({
    ok: true,
    userId,
    email: normalizedEmail,
    chargerSn: charger.sn,
    mowerSn: mower?.sn ?? null,
    workRecordsImported,
  });
});

// ── POST /api/dashboard/admin/cloud-resync — settings re-import ─────────────
//
// Differs from /admin/import: never recreates devices, always merges
// maps (existing local edits preserved), dedups work records on
// recordId. Used from the OpenNova app's Settings → Cloud sync flow
// when the user wants to backfill new history without nuking local
// state.
//
// Body: { email, password, mowerSn? }   (mowerSn defaults to the first
//   mower bound to the matching local user)
dashboardRouter.post('/admin/cloud-resync', async (req: Request, res: Response) => {
  const { email, password, mowerSn } = req.body as {
    email?: string;
    password?: string;
    mowerSn?: string;
  };
  if (!email || !password) {
    res.status(400).json({ ok: false, error: 'email + password required' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const localUser = userRepo.findByEmail(normalizedEmail);
  if (!localUser) {
    res.status(404).json({ ok: false, error: 'No local user with that email — run /admin/import first.' });
    return;
  }

  // Pick a mower SN: explicit param wins, otherwise first owned mower.
  const owned = equipmentRepo.findByUserId(localUser.app_user_id);
  const mowerSnResolved = mowerSn
    ?? owned.find(e => e.mower_sn?.startsWith('LFIN'))?.mower_sn
    ?? owned[0]?.mower_sn
    ?? null;
  if (!mowerSnResolved) {
    res.status(400).json({ ok: false, error: 'No mower bound to this account.' });
    return;
  }

  let workRecordsImported = 0;
  let duplicates = 0;
  try {
    const { encryptCloudPassword, callLfiCloud } = await import('../services/lfiCloud.js');
    const { importCloudWorkRecords } = await import('../services/cloudWorkRecordsImport.js');
    const encryptedPw = encryptCloudPassword(password);
    const loginResp = await callLfiCloud('POST', '/api/nova-user/appUser/login', {
      email, password: encryptedPw, imei: 'imei',
    });
    const loginVal = (loginResp as Record<string, unknown>).value as Record<string, unknown> | undefined;
    const cloudToken = loginVal?.accessToken as string | undefined;
    const cloudAppUserId = loginVal?.appUserId as number | string | undefined;
    if (!cloudToken || cloudAppUserId == null) {
      res.status(401).json({ ok: false, error: 'Cloud login failed.' });
      return;
    }
    const equip = equipmentRepo.findByMowerSn(mowerSnResolved);
    const equipmentId = equip?.equipment_id ?? mowerSnResolved;
    const result = await importCloudWorkRecords(
      cloudToken, cloudAppUserId, localUser.app_user_id, equipmentId,
    );
    workRecordsImported = result.inserted;
    duplicates = result.duplicates;
  } catch (err) {
    console.error('[admin/cloud-resync] failed:', err);
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'cloud-resync failed',
    });
    return;
  }

  res.json({ ok: true, mowerSn: mowerSnResolved, workRecordsImported, duplicates });
});

// ── Remote Debug — log relay ────────────────────────────────────

// SENDER: user's server stuurt logs naar een remote relay URL
let _relayUrl: string | null = null;
let _relayBatch: unknown[] = [];
let _relayTimer: ReturnType<typeof setInterval> | null = null;

// Load persisted relay URL at startup
try {
  const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : '/data';
  const savedUrl = fs.readFileSync(path.join(dataDir, '.remote_debug_url'), 'utf8').trim();
  if (savedUrl) {
    _relayUrl = savedUrl;
    onLogEntry((entry) => { _relayBatch.push(entry); });
    _relayTimer = setInterval(async () => {
      if (!_relayUrl || _relayBatch.length === 0) return;
      const batch = _relayBatch.splice(0);
      // Attach all known mower SNs to the batch
      const mowerSns = [...new Set(batch.map((e: any) => e.sn).filter(Boolean))];
      try {
        await fetch(_relayUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ logs: batch, sns: mowerSns, ts: Date.now() }),
          signal: AbortSignal.timeout(5000),
        });
      } catch { /* relay unavailable, drop batch */ }
    }, 2000);
    console.log(`[REMOTE-DEBUG] Relay auto-started → ${savedUrl}`);
  }
} catch { /* no saved URL */ }

dashboardRouter.post('/remote-debug/start', (req: Request, res: Response) => {
  const { relayUrl } = req.body as { relayUrl?: string };
  if (!relayUrl) { res.json({ ok: false, error: 'relayUrl required' }); return; }

  _relayUrl = relayUrl;
  _relayBatch = [];

  // Persist URL so it survives restarts
  try {
    const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : '/data';
    fs.writeFileSync(path.join(dataDir, '.remote_debug_url'), relayUrl);
  } catch { /* ignore */ }

  // Register log listener
  onLogEntry((entry) => {
    _relayBatch.push(entry);
  });

  // Flush batch every 2 seconds
  if (_relayTimer) clearInterval(_relayTimer);
  _relayTimer = setInterval(async () => {
    if (!_relayUrl || _relayBatch.length === 0) return;
    const batch = _relayBatch.splice(0);
    const mowerSns = [...new Set(batch.map((e: any) => e.sn).filter(Boolean))];
    try {
      await fetch(_relayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs: batch, sns: mowerSns, ts: Date.now() }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* relay unavailable, drop batch */ }
  }, 2000);

  console.log(`[REMOTE-DEBUG] Relay started → ${relayUrl}`);
  res.json({ ok: true });
});

dashboardRouter.post('/remote-debug/stop', (_req: Request, res: Response) => {
  _relayUrl = null;
  onLogEntry(null);
  if (_relayTimer) { clearInterval(_relayTimer); _relayTimer = null; }
  _relayBatch = [];
  // Remove persisted URL
  try {
    const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : '/data';
    fs.unlinkSync(path.join(dataDir, '.remote_debug_url'));
  } catch { /* ignore */ }
  console.log('[REMOTE-DEBUG] Relay stopped');
  res.json({ ok: true });
});

dashboardRouter.get('/remote-debug/status', (_req: Request, res: Response) => {
  res.json({ active: !!_relayUrl, url: _relayUrl });
});

// RECEIVER: ontvangt logs van remote instances, georganiseerd per SN
const _remoteLogsBySn = new Map<string, unknown[]>();
const MAX_REMOTE_LOGS = 2000;

/** Derive a serial number from a log entry's clientId / topic when the
 * sender forgot to populate `.sn`. Stock MQTT clientIds carry the SN
 * (LFINxxxxxxxxxxxx_xxxx) and the broker topics include it
 * (Dart/Send_mqtt/<SN>). Without this fallback an entry with `sn:null`
 * gets bucketed under "unknown" and the UI hides it. */
function _deriveSnFromEntry(entry: any): string | null {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.sn && typeof entry.sn === 'string') return entry.sn;
  const m1 = typeof entry.clientId === 'string' && entry.clientId.match(/LFI[CN]\d\d{4}\d{5}/);
  if (m1) return m1[0];
  const m2 = typeof entry.topic === 'string' && entry.topic.match(/LFI[CN]\d\d{4}\d{5}/);
  if (m2) return m2[0];
  return null;
}

/** Resolve a raw SN (mower or charger) to the bound MOWER SN. Charger
 * entries get rerouted under their bound mower so the operator sees a
 * single device per physical setup instead of separate mower + charger
 * tiles. Falls back to the raw SN when no mapping is known. Mower SNs
 * are returned unchanged. */
function _resolveToMowerSn(raw: string | null): string | null {
  if (!raw) return raw;
  if (raw.startsWith('LFIN')) return raw;
  if (raw.startsWith('LFIC')) {
    try {
      const eq = equipmentRepo.findByChargerSn(raw);
      if (eq?.mower_sn) return eq.mower_sn;
    } catch { /* DB lookup failed — fall through to raw */ }
  }
  return raw;
}

dashboardRouter.post('/remote-debug/receive', (req: Request, res: Response) => {
  const { logs, sns } = req.body as { logs?: unknown[]; sns?: string[] };
  if (!Array.isArray(logs)) { res.json({ ok: false }); return; }

  for (const entry of logs) {
    const rawSn = _deriveSnFromEntry(entry);
    const resolved = _resolveToMowerSn(rawSn);
    const key = resolved || (sns?.[0] ? _resolveToMowerSn(sns[0]) : null) || 'unknown';
    if (!_remoteLogsBySn.has(key)) _remoteLogsBySn.set(key, []);
    const buf = _remoteLogsBySn.get(key)!;
    buf.push(entry);
    if (buf.length > MAX_REMOTE_LOGS) buf.splice(0, buf.length - MAX_REMOTE_LOGS);
  }

  const total = [..._remoteLogsBySn.values()].reduce((n, b) => n + b.length, 0);
  res.json({ ok: true, devices: _remoteLogsBySn.size, buffered: total });
});

// GET /remote-debug/devices — list mower SNs with log counts.
//
// Only LFIN* buckets are surfaced. Charger logs (LFIC*) are rerouted
// to their bound mower during /receive so they merge into the mower's
// stream instead of showing up as a separate tile. "unknown" can be
// inspected via ?all=1 when the operator needs to debug entries the
// receiver couldn't tag with an SN.
dashboardRouter.get('/remote-debug/devices', (req: Request, res: Response) => {
  const all = req.query.all === '1';
  const devices = [..._remoteLogsBySn.entries()]
    .filter(([sn]) => all || sn.startsWith('LFIN'))
    .map(([sn, logs]) => ({
      sn,
      count: logs.length,
      lastTs: logs.length > 0 ? (logs[logs.length - 1] as any).ts : null,
    }))
    .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  res.json({ devices });
});

// GET /remote-debug/logs?sn=X&since=N|sinceTs=ms — logs for a specific SN
//
// Two cursor modes:
//   - since=N      : legacy index cursor (caller tracks count). Breaks once
//                    the server's per-SN ring buffer drops older entries —
//                    `slice(N)` then walks past array end and returns
//                    nothing forever after.
//   - sinceTs=ms   : preferred timestamp cursor; survives buffer drops and
//                    SN switches. New dashboard polling uses this.
dashboardRouter.get('/remote-debug/logs', (req: Request, res: Response) => {
  const sn = req.query.sn as string | undefined;
  const sinceTsRaw = req.query.sinceTs;
  const sinceTs = sinceTsRaw !== undefined ? parseInt(String(sinceTsRaw), 10) : null;
  const since = parseInt(req.query.since as string || '0', 10);

  const collect = (): unknown[] => {
    const all: unknown[] = [];
    if (sn) {
      for (const [key, buf] of _remoteLogsBySn.entries()) {
        if (key === sn || key.startsWith('LFIC') || key === 'unknown') {
          all.push(...buf);
        }
      }
    } else {
      for (const buf of _remoteLogsBySn.values()) all.push(...buf);
    }
    all.sort((a: unknown, b: unknown) => ((a as { ts?: number }).ts ?? 0) - ((b as { ts?: number }).ts ?? 0));
    return all;
  };

  const all = collect();
  if (sinceTs !== null && Number.isFinite(sinceTs)) {
    res.json({ logs: all.filter(e => ((e as { ts?: number }).ts ?? 0) > sinceTs) });
  } else {
    res.json({ logs: all.slice(since) });
  }
});

dashboardRouter.delete('/remote-debug/logs', (req: Request, res: Response) => {
  const sn = req.query.sn as string | undefined;
  if (sn) {
    _remoteLogsBySn.delete(sn);
  } else {
    _remoteLogsBySn.clear();
  }
  res.json({ ok: true });
});
