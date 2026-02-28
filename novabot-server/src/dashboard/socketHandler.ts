/**
 * Dashboard Socket.io handler — stuurt real-time device updates naar browsers.
 */
import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { getAllDeviceSnapshots } from '../mqtt/sensorData.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { db } from '../db/database.js';
import { initBleLogger, sendBleLogHistory } from '../ble/bleLogger.js';

interface DeviceRegistryRow {
  sn: string | null;
  mac_address: string | null;
  last_seen: string | null;
}

// ── MQTT log buffer ─────────────────────────────────────────────

export interface MqttLogEntry {
  ts: number;
  type: 'connect' | 'disconnect' | 'subscribe' | 'publish' | 'error';
  clientId: string;
  clientType: 'APP' | 'DEV' | '?';
  sn: string | null;
  direction: '→DEV' | '←DEV' | '';
  topic: string;
  payload: string;
  encrypted: boolean;
}

const MAX_LOG_ENTRIES = 500;
const logBuffer: MqttLogEntry[] = [];

export function pushMqttLog(entry: MqttLogEntry): void {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.splice(0, logBuffer.length - MAX_LOG_ENTRIES);
  io?.emit('mqtt:log', entry);
}

export function getRecentLogs(): MqttLogEntry[] {
  return logBuffer;
}

// ── Socket.io server ─────────────────────────────────────────────

let io: SocketServer | null = null;

export function initDashboardSocket(httpServer: HttpServer): void {
  io = new SocketServer(httpServer, {
    cors: { origin: '*' },  // dev: Vite op :5173
    path: '/socket.io',
  });

  // Start BLE logger — uses io.emit for broadcasting
  initBleLogger((event, data) => io!.emit(event, data));

  io.on('connection', (socket) => {
    console.log(`[DASHBOARD] Client connected: ${socket.id}`);

    // Stuur volledige state snapshot bij connect
    // Zelfde filtering als REST /devices: alleen gebonden of online, gededupliceerd op SN
    const snapshots = getAllDeviceSnapshots();
    const registry = db.prepare(`
      SELECT d.sn, d.mac_address, d.last_seen FROM device_registry d
      INNER JOIN (
        SELECT sn, MAX(last_seen) as max_seen FROM device_registry
        WHERE sn IS NOT NULL GROUP BY sn
      ) latest ON d.sn = latest.sn AND d.last_seen = latest.max_seen
    `).all() as DeviceRegistryRow[];

    const equipment = db.prepare('SELECT mower_sn, charger_sn FROM equipment').all() as { mower_sn: string; charger_sn: string | null }[];
    const boundSns = new Set<string>();
    for (const e of equipment) {
      if (e.mower_sn) boundSns.add(e.mower_sn);
      if (e.charger_sn) boundSns.add(e.charger_sn);
    }

    const devices = registry
      .filter(r => boundSns.has(r.sn!) || isDeviceOnline(r.sn!))
      .map(r => ({
        sn: r.sn!,
        deviceType: r.sn!.startsWith('LFIC') ? 'charger' : 'mower',
        online: isDeviceOnline(r.sn!),
        sensors: snapshots[r.sn!] ?? {},
      }));

    socket.emit('state:snapshot', { devices });

    // Stuur recente log history bij connect
    socket.emit('mqtt:log:history', logBuffer);

    // Stuur recente BLE log history bij connect
    sendBleLogHistory((event, data) => socket.emit(event, data));

    socket.on('disconnect', () => {
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
