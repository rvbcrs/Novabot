/**
 * BLE Traffic Logger — captures all Novabot BLE activity and:
 * 1. Streams it to the dashboard via Socket.io (real-time)
 * 2. Writes it to a log file on disk (for offline comparison)
 *
 * Log files are written to novabot-server/logs/ble_<timestamp>.log
 * in the same directory as the proxy logger files.
 *
 * Two log sources:
 * 1. Background passive scanner — advertisements from Novabot devices
 * 2. GATT operations — writes/reads/notifies from provisioner/raw diagnostic
 *
 * Other modules call pushBleLog() to add entries.
 */

import fs from 'fs';
import path from 'path';

type Noble = typeof import('@stoprocent/noble').default;
type Peripheral = import('@stoprocent/noble').Peripheral;

export interface BleLogEntry {
  ts: number;
  type: 'advertisement' | 'connect' | 'disconnect' | 'write' | 'notify' | 'read' | 'error';
  deviceName: string;
  mac: string;
  rssi: number;
  service?: string;
  characteristic?: string;
  data?: string;
  direction?: '\u2192DEV' | '\u2190DEV' | '';
}

// ── File logger ───────────────────────────────────────────────────

let fileStream: fs.WriteStream | null = null;

function initFileLogger(): void {
  const logsDir = path.resolve(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const mode = process.env.PROXY_MODE === 'cloud' ? 'cloud' : 'local';
  const logFile = path.join(logsDir, `ble_${mode}_${ts}.log`);

  fileStream = fs.createWriteStream(logFile, { flags: 'a' });
  console.log(`[BLE-LOG] File logging active → ${logFile}`);

  // Header
  fileStream.write(`# BLE Traffic Log — started ${now.toISOString()}\n`);
  fileStream.write(`# Format: timestamp | type | direction | device | mac | rssi | service | char | data\n`);
  fileStream.write(`#${'─'.repeat(120)}\n`);

  process.on('exit', () => fileStream?.end());
}

function writeToFile(entry: BleLogEntry): void {
  if (!fileStream) return;
  const ts = new Date(entry.ts).toISOString();
  const dir = entry.direction || '   ';
  const svc = entry.service ? `svc:${entry.service}` : '';
  const chr = entry.characteristic ? `chr:${entry.characteristic}` : '';
  const rssi = entry.type === 'advertisement' ? `${entry.rssi}dBm` : '';
  const parts = [
    ts,
    entry.type.toUpperCase().padEnd(13),
    dir.padEnd(4),
    entry.deviceName.padEnd(16),
    entry.mac.padEnd(18),
    rssi.padEnd(8),
    svc.padEnd(10),
    chr.padEnd(10),
    entry.data ?? '',
  ];
  fileStream.write(parts.join(' | ').trimEnd() + '\n');
}

// ── Log buffer ────────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 500;
const logBuffer: BleLogEntry[] = [];

/** Socket.io emit function — set by initBleLogger() */
let emitFn: ((event: string, data: unknown) => void) | null = null;

export function pushBleLog(entry: BleLogEntry): void {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.splice(0, logBuffer.length - MAX_LOG_ENTRIES);
  emitFn?.('ble:log', entry);
  writeToFile(entry);
}

export function getRecentBleLogs(): BleLogEntry[] {
  return logBuffer;
}

// ── Recent BLE device cache (for MAC lookup by other modules) ─────

interface RecentBleDevice {
  mac: string;
  rssi: number;
  lastSeen: number;
  name: string;
}

/**
 * Map of normalized device type → most recent BLE advertisement.
 * Keys: 'novabot' (mower), 'charger' (charger_pile).
 * If multiple devices of same type, keeps the one with strongest RSSI
 * (most likely the device closest to us / being provisioned).
 */
const recentBleDevices = new Map<string, RecentBleDevice>();

/**
 * Look up the most recently seen BLE MAC for a device type.
 * @param type - 'novabot' for mower, 'charger' for charger/charger_pile
 * @returns BLE MAC string (e.g. "50:41:1C:39:BD:C1") or null
 */
export function getBleMacForType(type: 'novabot' | 'charger'): string | null {
  const dev = recentBleDevices.get(type);
  if (!dev) return null;
  // Only return if seen within last 60 seconds
  if (Date.now() - dev.lastSeen > 60_000) return null;
  return dev.mac;
}

/**
 * Get all recently seen BLE devices (within last 60s).
 * Useful for listing available devices when user has multiple.
 */
export function getRecentBleDevices(): RecentBleDevice[] {
  const cutoff = Date.now() - 60_000;
  return Array.from(recentBleDevices.values()).filter(d => d.lastSeen > cutoff);
}

/** All BLE devices seen (any name) — id → device */
const allBleDevices = new Map<string, RecentBleDevice & { novabot: boolean }>();

/**
 * Get ALL recently seen BLE devices (within last 60s), not just Novabot ones.
 * Used by wizard console to show what the RPi can see.
 */
export function getAllRecentBleDevices(): (RecentBleDevice & { novabot: boolean })[] {
  const cutoff = Date.now() - 5 * 60_000; // 5 minutes
  return Array.from(allBleDevices.values())
    .filter(d => d.lastSeen > cutoff)
    .sort((a, b) => b.rssi - a.rssi);
}

// ── Background advertisement scanner ──────────────────────────────

const NOVABOT_COMPANY_ID = 0x5566;
const TARGET_PREFIXES = ['novabot', 'charger_pile', 'charger'];

let noble: Noble | null = null;
let bgScanActive = false;

export function isBackgroundScanActive(): boolean { return bgScanActive; }
/** Suppress duplicate advertisements within this window (ms) */
const DEDUP_WINDOW = 2000;
const lastSeen = new Map<string, number>();

/** Console log dedup for ALL devices — suppress repeats within 30s */
const CONSOLE_DEDUP = 30_000;
const consoleLastSeen = new Map<string, number>();

/**
 * Initialize the BLE logger. Call once with the Socket.io emit function.
 * Starts background BLE scanning for advertisements.
 */
export function initBleLogger(emit: (event: string, data: unknown) => void): void {
  emitFn = emit;
  initFileLogger();
  if (process.env.DISABLE_BLE === '1' || !process.env.SETUP_WIZARD_PATH) {
    console.log('[BLE-LOG] BLE scan disabled (RPi wizard not configured)');
    return;
  }
  startBackgroundScan().catch(err => {
    console.warn('[BLE-LOG] Background scan failed to start:', err.message);
  });
}

/**
 * Send recent log history to a newly connected dashboard client.
 */
export function sendBleLogHistory(emit: (event: string, data: unknown) => void): void {
  emit('ble:log:history', logBuffer);
}

const onDiscover = (peripheral: Peripheral) => {
    const localName = peripheral.advertisement?.localName ?? '';
    const nameLower = localName.toLowerCase();
    const devId = peripheral.id ?? peripheral.uuid ?? '??';
    const rssi = peripheral.rssi ?? 0;

    // Track ALL devices in allBleDevices cache + console log (deduped per 30s)
    const isNovabot = TARGET_PREFIXES.some(p => nameLower.startsWith(p));
    const consoleKey = devId;
    const nowAll = Date.now();

    // Update all-devices cache (always)
    const existing = allBleDevices.get(devId);
    if (!existing || rssi > existing.rssi || nowAll - existing.lastSeen > 5_000) {
      allBleDevices.set(devId, { mac: devId, rssi, lastSeen: nowAll, name: localName || '(no name)', novabot: isNovabot });
    }

    if (!consoleLastSeen.has(consoleKey) || nowAll - consoleLastSeen.get(consoleKey)! >= CONSOLE_DEDUP) {
      consoleLastSeen.set(consoleKey, nowAll);
      if (isNovabot) {
        console.log(`[BLE-SCAN] *** ${localName || '(no name)'} | id=${devId} | ${rssi}dBm ***`);
      } else {
        console.log(`[BLE-SCAN]     ${localName || '(no name)'} | id=${devId} | ${rssi}dBm`);
      }
    }

    // Only process/log Novabot devices further
    if (!isNovabot) return;

    // Extract MAC from manufacturer data
    const mfgData = peripheral.advertisement?.manufacturerData;
    let mac = '';
    if (mfgData && mfgData.length >= 8) {
      const companyId = mfgData.readUInt16LE(0);
      if (companyId === NOVABOT_COMPANY_ID) {
        mac = Array.from(mfgData.subarray(2, 8))
          .map(b => b.toString(16).padStart(2, '0').toUpperCase())
          .join(':');
      }
    }
    if (!mac) {
      // Fallback: use peripheral UUID (CoreBluetooth identifier)
      mac = peripheral.uuid ?? peripheral.id ?? '??';
    }

    // Deduplicate: skip if same device seen within window
    const key = mac;
    const now = Date.now();
    const prev = lastSeen.get(key);
    if (prev && now - prev < DEDUP_WINDOW) return;
    lastSeen.set(key, now);

    // Build log entry
    const dataHex = mfgData ? mfgData.toString('hex') : '';
    const serviceUuids = peripheral.advertisement?.serviceUuids ?? [];

    // Update recent BLE device cache for MAC lookup
    if (mac && mac !== '??' && mac.includes(':')) {
      const typeKey = nameLower.startsWith('novabot') ? 'novabot'
        : (nameLower.startsWith('charger') ? 'charger' : null);
      if (typeKey) {
        const existing = recentBleDevices.get(typeKey);
        const rssi = peripheral.rssi ?? -999;
        // Update if: no existing entry, same device, or this one has stronger RSSI
        if (!existing || existing.mac === mac || rssi > existing.rssi) {
          recentBleDevices.set(typeKey, { mac, rssi, lastSeen: now, name: localName });
        }
      }
    }

    pushBleLog({
      ts: now,
      type: 'advertisement',
      deviceName: localName || '(unknown)',
      mac,
      rssi: peripheral.rssi ?? 0,
      service: serviceUuids.length > 0 ? serviceUuids.join(',') : undefined,
      data: dataHex || undefined,
      direction: '',
    });
  };

async function startBackgroundScan(): Promise<void> {
  if (bgScanActive) return;

  try {
    const mod = await import('@stoprocent/noble');
    noble = mod.default;
  } catch (err) {
    console.warn('[BLE-LOG] Noble not available:', (err as Error).message);
    return;
  }

  // Wait for adapter to be powered on
  if (noble.state !== 'poweredOn') {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Bluetooth adapter timeout')), 8000);
      const onState = (state: string) => {
        if (state === 'poweredOn') {
          clearTimeout(timeout);
          noble!.removeListener('stateChange', onState);
          resolve();
        }
      };
      noble!.on('stateChange', onState);
    });
  }

  noble.on('discover', onDiscover);

  try {
    await noble.startScanningAsync([], true); // allow duplicates for RSSI updates
    bgScanActive = true;
    console.log('[BLE-LOG] Background advertisement scanner started');
  } catch (err) {
    console.warn('[BLE-LOG] Failed to start scanning:', (err as Error).message);
  }

  // Clean up dedup map periodically
  setInterval(() => {
    const cutoff = Date.now() - DEDUP_WINDOW * 5;
    for (const [k, v] of lastSeen) {
      if (v < cutoff) lastSeen.delete(k);
    }
  }, 30_000);
}

/**
 * Temporarily pause background scanning (for provisioner/raw diagnostic).
 */
export async function pauseBackgroundScan(): Promise<void> {
  if (!noble) return;
  try {
    noble.removeAllListeners('discover'); // remove background listener so provisioner has clean slate
    await noble.stopScanningAsync();
    bgScanActive = false;
    console.log('[BLE-LOG] Background scan paused');
  } catch { /* ignore */ }
}

/**
 * Resume background scanning after provisioner/raw diagnostic is done.
 */
export async function resumeBackgroundScan(): Promise<void> {
  if (!noble) return;
  bgScanActive = false; // force reset — BlueZ may have been restarted
  try {
    // After BlueZ restart, noble needs time to re-detect the adapter
    if (noble.state !== 'poweredOn') {
      console.log(`[BLE-LOG] Waiting for adapter (state: ${noble.state})...`);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Adapter timeout')), 8000);
        const onState = (state: string) => {
          if (state === 'poweredOn') {
            clearTimeout(timeout);
            noble!.removeListener('stateChange', onState);
            resolve();
          }
        };
        noble!.on('stateChange', onState);
      });
    }
    noble.on('discover', onDiscover); // re-attach background listener
    await noble.startScanningAsync([], true);
    bgScanActive = true;
    console.log('[BLE-LOG] Background scan resumed');
  } catch (err) {
    console.warn('[BLE-LOG] Failed to resume scanning:', (err as Error).message);
  }
}
