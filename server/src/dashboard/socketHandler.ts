/**
 * Dashboard Socket.io handler — stuurt real-time device updates naar browsers.
 */
import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { getAllDeviceSnapshots } from '../mqtt/sensorData.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { db } from '../db/database.js';
import { initBleLogger, sendBleLogHistory } from '../ble/bleLogger.js';
import { setOutlineEmitter, publishToDevice } from '../mqtt/mapSync.js';

// Callback om demo mode status te checken (geregistreerd door demoSimulator)
let demoModeChecker: ((sn: string) => boolean) | null = null;
export function setDemoModeChecker(fn: (sn: string) => boolean): void {
  demoModeChecker = fn;
}

interface DeviceRegistryRow {
  sn: string | null;
  mac_address: string | null;
  last_seen: string | null;
}

// ── MQTT log buffer ─────────────────────────────────────────────

export interface MqttLogEntry {
  ts: number;
  type: 'connect' | 'disconnect' | 'subscribe' | 'publish' | 'error' | 'forward';
  clientId: string;
  clientType: 'APP' | 'DEV' | '?';
  sn: string | null;
  direction: '→DEV' | '←DEV' | '→APP' | '';
  topic: string;
  payload: string;
  encrypted: boolean;
}

const MAX_LOG_ENTRIES = 500;
const logBuffer: MqttLogEntry[] = [];

// Remote debug log relay callback
let _logListener: ((entry: MqttLogEntry) => void) | null = null;
export function onLogEntry(fn: ((entry: MqttLogEntry) => void) | null): void {
  _logListener = fn;
}

export function pushMqttLog(entry: MqttLogEntry): void {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.splice(0, logBuffer.length - MAX_LOG_ENTRIES);
  io?.emit('mqtt:log', entry);
  _logListener?.(entry);
}

export function getRecentLogs(): MqttLogEntry[] {
  return logBuffer;
}

// ── Socket.io server ─────────────────────────────────────────────

let io: SocketServer | null = null;

export function initDashboardSocket(httpServer: HttpServer): void {
  io = new SocketServer(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN || true },  // true = same-origin; set CORS_ORIGIN="*" for dev
    path: '/socket.io',
  });

  // Stuur live kaart-outlines naar dashboard tijdens actief mappen
  setOutlineEmitter((sn, points, localPoints) => io!.emit('map:outline', { sn, points, localPoints, timestamp: Date.now() }));

  // Start BLE logger — uses io.emit for broadcasting
  initBleLogger((event, data) => io!.emit(event, data));

  io.on('connection', (socket) => {
    console.log(`[DASHBOARD] Client connected: ${socket.id}`);

    // Build snapshot helper — reused for initial connect + request:snapshot
    function buildSnapshot() {
      const snapshots = getAllDeviceSnapshots();
      const registry = db.prepare(`
        SELECT d.sn, d.mac_address, d.last_seen FROM device_registry d
        INNER JOIN (
          SELECT sn, MAX(last_seen) as max_seen FROM device_registry
          WHERE sn IS NOT NULL GROUP BY sn
        ) latest ON d.sn = latest.sn AND d.last_seen = latest.max_seen
      `).all() as DeviceRegistryRow[];

      const equipment = db.prepare(
        'SELECT mower_sn, charger_sn, equipment_nick_name, mower_version, charger_version, mac_address FROM equipment'
      ).all() as {
        mower_sn: string;
        charger_sn: string | null;
        equipment_nick_name: string | null;
        mower_version: string | null;
        charger_version: string | null;
        mac_address: string | null;
      }[];
      const boundSns = new Set<string>();
      // Per-SN nickname so the home tile can show "Botty" instead of the bare
      // SN. Both the mower and the paired charger get the same nickname so
      // either device row in the snapshot carries it.
      const nickBySn = new Map<string, string>();
      // Per-SN firmware version so the app's OTA screen can show the charger
      // version (mower version comes via sensors.sw_version; charger only
      // reports via ota_version_info_respond which is stored in equipment).
      const versionBySn = new Map<string, string>();
      // Per-SN BLE MAC so the app can filter scan results when 2+ mowers are
      // within range — without this, scanForDevices picks whichever mower
      // advertises first, potentially driving the WRONG mower in mapping mode.
      // Source: equipment.mac_address (per CLAUDE.md "BLE MAC backfill —
      // KRITIEK"). Falls back to device_registry.mac_address if equipment
      // row is missing the MAC.
      const macBySn = new Map<string, string>();
      for (const e of equipment) {
        if (e.mower_sn) {
          boundSns.add(e.mower_sn);
          if (e.equipment_nick_name) nickBySn.set(e.mower_sn, e.equipment_nick_name);
          if (e.mower_version) versionBySn.set(e.mower_sn, e.mower_version);
          if (e.mac_address) macBySn.set(e.mower_sn, e.mac_address);
        }
        if (e.charger_sn) {
          boundSns.add(e.charger_sn);
          if (e.equipment_nick_name) nickBySn.set(e.charger_sn, e.equipment_nick_name);
          if (e.charger_version) versionBySn.set(e.charger_sn, e.charger_version);
        }
      }

      return registry
        .filter(r => boundSns.has(r.sn!) || isDeviceOnline(r.sn!) || demoModeChecker?.(r.sn!))
        .map(r => ({
          sn: r.sn!,
          deviceType: r.sn!.startsWith('LFIC') ? 'charger' : 'mower',
          online: isDeviceOnline(r.sn!) || demoModeChecker?.(r.sn!) === true,
          sensors: snapshots[r.sn!] ?? {},
          nickname: nickBySn.get(r.sn!) ?? null,
          firmwareVersion: versionBySn.get(r.sn!) ?? null,
          // Equipment MAC takes precedence; fall back to registry MAC if absent.
          macAddress: macBySn.get(r.sn!) ?? r.mac_address ?? null,
        }));
    }

    // Send snapshot on connect
    socket.emit('state:snapshot', { devices: buildSnapshot() });

    // Allow clients to request a fresh snapshot
    socket.on('request:snapshot', () => {
      socket.emit('state:snapshot', { devices: buildSnapshot() });
    });

    // Stuur recente log history bij connect
    socket.emit('mqtt:log:history', logBuffer);

    // Stuur recente BLE log history bij connect
    sendBleLogHistory((event, data) => socket.emit(event, data));

    // ── Joystick: server-side tight loop for smooth motor control ──
    // Browser sends desired velocity; server handles the high-frequency MQTT sending.
    // This eliminates browser setInterval jitter and network round-trip variability.
    let joystickInterval: ReturnType<typeof setInterval> | null = null;
    let joystickSn = '';
    let joystickStopped = true;
    let joystickHoldType = 3;
    let currentMst = { x_w: 0, y_v: 0, z_g: 0 };

    socket.on('joystick:start', (data: { sn: string; holdType: number }) => {
      if (!data?.sn) return;
      joystickSn = data.sn;
      joystickStopped = false;
      joystickHoldType = data.holdType || 3;
      console.log(`[JOYSTICK] START sn=${data.sn} holdType=${joystickHoldType}`);
      publishToDevice(data.sn, { start_move: joystickHoldType });
    });

    socket.on('joystick:move', (data: { sn: string; holdType: number; mst: { x_w: number; y_v: number; z_g: number } }) => {
      if (!data?.sn || joystickStopped) return;
      joystickSn = data.sn;
      currentMst = data.mst;

      // Change direction only when holdType actually changes — send start_move immediately
      if (data.holdType !== joystickHoldType) {
        joystickHoldType = data.holdType;
        publishToDevice(data.sn, { start_move: joystickHoldType });
      }

      // Start repeating interval once (mst every 150ms, start_move keepalive every 750ms)
      if (!joystickInterval) {
        let tick = 0;
        joystickInterval = setInterval(() => {
          if (joystickStopped) return;
          // Official Flutter app sends mst as List<int>: [v*100, w*100, 8]
          publishToDevice(joystickSn, { mst: [
            Math.round(currentMst.x_w * 100),
            Math.round(currentMst.y_v * 100),
            8,
          ] });
          tick++;
          if (tick % 5 === 0) {
            publishToDevice(joystickSn, { start_move: joystickHoldType });
          }
        }, 150);
      }
    });

    socket.on('joystick:stop', (data: { sn: string }) => {
      console.log(`[JOYSTICK] STOP sn=${data?.sn}`);
      joystickStopped = true;
      if (joystickInterval) { clearInterval(joystickInterval); joystickInterval = null; }
      currentMst = { x_w: 0, y_v: 0, z_g: 0 };
      joystickHoldType = 0;
      if (data?.sn) publishToDevice(data.sn, { stop_move: null });
    });

    // Legacy: direct command passthrough
    socket.on('joystick:cmd', (data: { sn: string; command: Record<string, unknown> }) => {
      if (!data?.sn || !data?.command) return;
      publishToDevice(data.sn, data.command);
    });

    socket.on('disconnect', () => {
      // Clean up joystick interval on disconnect (safety)
      if (joystickInterval) { clearInterval(joystickInterval); joystickInterval = null; }
      if (joystickSn) publishToDevice(joystickSn, { stop_move: null });
      console.log(`[DASHBOARD] Client disconnected: ${socket.id}`);
    });
  });
}

/**
 * Stuur gewijzigde sensordata naar alle verbonden dashboard clients.
 */
export function forwardToDashboard(sn: string, changes: Map<string, string> | null): void {
  if (!io || !changes || changes.size === 0) return;

  const fields: Record<string, string> = {};
  for (const [field, value] of changes) {
    fields[field] = value;
  }

  io.emit('device:update', { sn, fields, timestamp: Date.now() });
}

export function emitDeviceOnline(sn: string): void {
  io?.emit('device:online', { sn, timestamp: Date.now() });
}

export function emitDeviceOffline(sn: string): void {
  io?.emit('device:offline', { sn, timestamp: Date.now() });
}

export function emitDeviceBound(sn: string): void {
  io?.emit('device:bound', { sn, timestamp: Date.now() });
}

export function emitDevicePaired(mowerSn: string, chargerSn: string): void {
  io?.emit('device:paired', { mowerSn, chargerSn, timestamp: Date.now() });
}

export function emitTrailClear(sn: string): void {
  io?.emit('trail:clear', { sn, timestamp: Date.now() });
}

export function emitMapsChanged(sn: string, mapId?: string): void {
  io?.emit('maps:changed', { sn, mapId, timestamp: Date.now() });
}

/** Forward MQTT _respond messages to app (mapping flow, etc.) */
export function emitCommandRespond(sn: string, command: string, data: unknown): void {
  io?.emit('command:respond', { sn, command, data, timestamp: Date.now() });
}

/** Stuur afgelegde maai-banen naar dashboard (demo simulator) */
export function emitCoveredLanes(sn: string, lanes: Array<{ lat1: number; lng1: number; lat2: number; lng2: number }>): void {
  io?.emit('mow:lanes', { sn, lanes, timestamp: Date.now() });
}

export function emitOtaEvent(sn: string, eventType: 'state' | 'version', data: unknown): void {
  io?.emit('ota:event', { sn, eventType, data, timestamp: Date.now() });
}

export function emitScheduleEvent(event: string, data: Record<string, unknown>): void {
  io?.emit(event, { ...data, timestamp: Date.now() });
}

export function emitPinEvent(sn: string, data: unknown): void {
  io?.emit('pin:event', { sn, data, timestamp: Date.now() });
}

export function emitExtendedEvent(sn: string, command: string, data: unknown): void {
  io?.emit('extended:response', { sn, command, data, timestamp: Date.now() });
}
