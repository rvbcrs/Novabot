/**
 * BLE Provisioning Service for Novabot devices.
 *
 * Protocol ported from bootstrap/src/ble.ts (noble/Node.js) to react-native-ble-plx.
 *
 * CRITICAL: Command order matters!
 *   Charger: set_wifi_info → set_rtk_info → set_lora_info → set_mqtt_info → set_cfg_info
 *   Mower:   get_signal_info → set_wifi_info → set_lora_info → set_mqtt_info → set_cfg_info
 *
 * Charger IGNORES set_wifi_info if get_signal_info is sent first!
 */

import { BleManager, Device, Characteristic } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

// ── Constants ────────────────────────────────────────────────────────────────

const INTER_CHUNK_DELAY = 100; // ms between 20-byte chunks

// GATT UUIDs
const CHARGER_SERVICE = '00001234-0000-1000-8000-00805f9b34fb';
const CHARGER_WRITE   = '00002222-0000-1000-8000-00805f9b34fb';
const CHARGER_NOTIFY  = '00002222-0000-1000-8000-00805f9b34fb'; // same as write
const CHARGER_FLUSH   = '00003333-0000-1000-8000-00805f9b34fb'; // read to flush notifications

const MOWER_SERVICE = '00000201-0000-1000-8000-00805f9b34fb';
const MOWER_WRITE   = '00000011-0000-1000-8000-00805f9b34fb';
const MOWER_NOTIFY  = '00000021-0000-1000-8000-00805f9b34fb';

// LoRa defaults (same as official app — NEVER change)
const LORA = { addr: 718, channel: 15, hc: 20, lc: 14 };

// ── Types ────────────────────────────────────────────────────────────────────

export type DeviceType = 'charger' | 'mower';

export interface ScannedDevice {
  id: string;
  name: string;
  rssi: number;
  type: DeviceType | 'unknown';
}

export interface ProvisionParams {
  wifiSsid: string;
  wifiPassword: string;
  mqttAddr: string;
  mqttPort: number;
}

export type ProvisionPhase =
  | 'connecting' | 'discovering' | 'wifi' | 'rtk' | 'lora' | 'mqtt' | 'commit'
  | 'done' | 'error';

export type ProgressCallback = (phase: ProvisionPhase, message: string) => void;
export type LogCallback = (msg: string) => void;

let _logCb: LogCallback | null = null;
export function setBleLogCallback(cb: LogCallback | null): void { _logCb = cb; }
export { bleLog };
function bleLog(msg: string): void {
  console.log(msg);
  _logCb?.(msg);
}

// ── BLE Manager Singleton ────────────────────────────────────────────────────

let _manager: BleManager | null = null;

export function getBleManager(): BleManager {
  if (!_manager) _manager = new BleManager();
  return _manager;
}

export function destroyBleManager(): void {
  if (_manager) { _manager.destroy(); _manager = null; }
}

// ── Scan ─────────────────────────────────────────────────────────────────────

export function scanForDevices(
  durationMs: number,
  onDevice: (dev: ScannedDevice) => void,
  onDone: () => void,
): () => void {
  const mgr = getBleManager();
  const seen = new Set<string>();

  mgr.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
    if (error) { console.warn('[BLE] Scan error:', error.message); return; }
    if (!device?.name || seen.has(device.id)) return;
    seen.add(device.id);

    let type: DeviceType | 'unknown' = 'unknown';
    if (device.name === 'CHARGER_PILE') type = 'charger';
    if (device.name === 'NOVABOT' || device.name === 'Novabot') type = 'mower';

    onDevice({ id: device.id, name: device.name, rssi: device.rssi ?? -100, type });
  });

  const timer = setTimeout(() => {
    mgr.stopDeviceScan();
    onDone();
  }, durationMs);

  // Return cancel function
  return () => { clearTimeout(timer); mgr.stopDeviceScan(); };
}

// ── Provision ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function writeFrame(
  device: Device,
  serviceUuid: string,
  charUuid: string,
  json: string,
  withResponse: boolean,
): Promise<void> {
  bleLog(`[BLE] writeFrame: svc=${serviceUuid.substring(4,8)} char=${charUuid.substring(4,8)} withResp=${withResponse} len=${json.length}`);

  // ble_start marker
  const startB64 = Buffer.from('ble_start', 'utf8').toString('base64');
  bleLog(`[BLE]   ble_start b64="${startB64}"`);
  await device.writeCharacteristicWithoutResponseForService(serviceUuid, charUuid, startB64);
  bleLog(`[BLE]   ble_start OK`);
  await sleep(INTER_CHUNK_DELAY);

  // JSON data in 20-byte chunks
  const data = Buffer.from(json, 'utf8');
  const numChunks = Math.ceil(data.length / 20);
  bleLog(`[BLE]   Sending ${data.length} bytes in ${numChunks} chunks`);
  for (let offset = 0; offset < data.length; offset += 20) {
    // CRITICAL: Buffer.from() wrap needed — subarray returns Uint8Array in RN polyfill
    // and Uint8Array.toString('base64') produces comma-separated numbers, not base64
    const chunk = Buffer.from(data.subarray(offset, Math.min(offset + 20, data.length)));
    await device.writeCharacteristicWithoutResponseForService(
      serviceUuid, charUuid, chunk.toString('base64'),
    );
    await sleep(INTER_CHUNK_DELAY);
  }
  bleLog(`[BLE]   Chunks OK`);

  // ble_end marker
  const endB64 = Buffer.from('ble_end', 'utf8').toString('base64');
  await device.writeCharacteristicWithoutResponseForService(serviceUuid, charUuid, endB64);
  bleLog(`[BLE]   ble_end OK`);
  await sleep(INTER_CHUNK_DELAY);
}

async function sendCommand(
  device: Device,
  serviceUuid: string,
  writeCharUuid: string,
  notifyCharUuid: string,
  flushCharUuid: string | null,
  json: string,
  cmdName: string,
  timeoutMs: number,
  withResponse: boolean,
): Promise<{ ok: boolean; response: string }> {
  return new Promise(async (resolve) => {
    let responseBuffer = '';
    let collecting = false;
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; sub?.remove(); resolve({ ok: false, response: '' }); }
    }, timeoutMs);

    // Subscribe to notifications
    const sub = device.monitorCharacteristicForService(
      serviceUuid, notifyCharUuid,
      (_err: any, char: Characteristic | null) => {
        if (!char?.value || resolved) return;
        const raw = Buffer.from(char.value, 'base64');

        // Skip mower bb/cc telemetry
        if (raw.length >= 2 && ((raw[0] === 0x62 && raw[1] === 0x62) || (raw[0] === 0x63 && raw[1] === 0x63))) return;

        const str = raw.toString('utf8');
        bleLog(`[BLE] NOTIFY ${cmdName}: "${str.substring(0, 40)}${str.length > 40 ? '...' : ''}" (${raw.length}b)`);

        if (str === 'ble_start') { collecting = true; responseBuffer = ''; return; }
        if (str === 'ble_end' && collecting) {
          collecting = false;
          bleLog(`[BLE] RESPONSE ${cmdName}: ${responseBuffer.substring(0, 80)}`);
          if (responseBuffer.includes('_respond')) {
            const ok = responseBuffer.includes('"result":0') || responseBuffer.includes('"result":1');
            bleLog(`[BLE] ${cmdName} → ${ok ? 'OK' : 'FAIL'}: ${responseBuffer.substring(0, 60)}`);
            resolved = true;
            clearTimeout(timer);
            sub?.remove();
            resolve({ ok, response: responseBuffer });
          }
          return;
        }
        if (collecting) responseBuffer += str;
      },
    );

    // Send the command
    try {
      await writeFrame(device, serviceUuid, writeCharUuid, json, withResponse);

      // Flush: read from flush char to trigger CoreBluetooth notification delivery
      if (flushCharUuid) {
        await sleep(2000);
        try { await device.readCharacteristicForService(serviceUuid, flushCharUuid); } catch {}
      }
    } catch (err: any) {
      console.warn(`[BLE] Write error for ${cmdName}:`, err.message);
    }
  });
}

export async function provisionDevice(
  deviceId: string,
  deviceType: DeviceType,
  params: ProvisionParams,
  onProgress: ProgressCallback,
): Promise<boolean> {
  const mgr = getBleManager();

  try {
    // ── Connect ──────────────────────────────────────────────────
    onProgress('connecting', 'Connecting...');
    let device = await mgr.connectToDevice(deviceId, { timeout: 10000 });
    onProgress('discovering', 'Discovering services...');
    device = await device.discoverAllServicesAndCharacteristics();

    const isCharger = deviceType === 'charger';
    const svc = isCharger ? CHARGER_SERVICE : MOWER_SERVICE;
    const wChar = isCharger ? CHARGER_WRITE : MOWER_WRITE;
    const nChar = isCharger ? CHARGER_NOTIFY : MOWER_NOTIFY;
    const fChar = isCharger ? CHARGER_FLUSH : null;
    const withResp = false; // Always writeWithoutResponse — matches bootstrap (noble writeAsync(data, true))

    bleLog(`[BLE] Device: ${deviceType}, svc=${svc.substring(4,8)}, write=${wChar.substring(4,8)}, notify=${nChar.substring(4,8)}`);
    bleLog(`[BLE] WiFi: ${params.wifiSsid}, MQTT: ${params.mqttAddr}:${params.mqttPort}`);

    // List discovered services + characteristics
    const services = await device.services();
    for (const s of services) {
      const chars = await s.characteristics();
      bleLog(`[BLE] Service ${s.uuid.substring(4,8)}: ${chars.map(c => c.uuid.substring(4,8) + '(' + (c.isWritableWithoutResponse ? 'wNoR' : '') + (c.isWritableWithResponse ? 'wR' : '') + (c.isNotifiable ? 'n' : '') + (c.isReadable ? 'r' : '') + ')').join(', ')}`);
    }

    // Subscribe to notifications ONCE before all commands (like bootstrap does)
    let notifyBuffer = '';
    let notifyCollecting = false;
    let notifyResolve: ((resp: string) => void) | null = null;

    // Explicitly write CCCD descriptor to enable notifications (0x2902 → 01 00)
    // react-native-ble-plx should do this automatically, but let's be explicit
    try {
      const descriptorUuid = '00002902-0000-1000-8000-00805f9b34fb';
      const enableNotify = Buffer.from([0x01, 0x00]).toString('base64');
      await device.writeDescriptorForService(svc, nChar, descriptorUuid, enableNotify);
      bleLog(`[BLE] CCCD written manually (01 00) for ${nChar.substring(4,8)}`);
    } catch (e: any) {
      bleLog(`[BLE] CCCD manual write failed: ${e.message} — relying on monitor`);
    }

    const notifySub = device.monitorCharacteristicForService(
      svc, nChar,
      (_err: any, char: Characteristic | null) => {
        if (!char?.value) return;
        const raw = Buffer.from(char.value, 'base64');
        // Skip mower bb/cc telemetry
        if (raw.length >= 2 && ((raw[0] === 0x62 && raw[1] === 0x62) || (raw[0] === 0x63 && raw[1] === 0x63))) return;
        const str = raw.toString('utf8');
        bleLog(`[BLE] NOTIFY: "${str.substring(0, 40)}" (${raw.length}b)`);

        if (str === 'ble_start') { notifyCollecting = true; notifyBuffer = ''; return; }
        if (str === 'ble_end' && notifyCollecting) {
          notifyCollecting = false;
          if (notifyBuffer.includes('_respond') && notifyResolve) {
            bleLog(`[BLE] RESPONSE: ${notifyBuffer.substring(0, 60)}`);
            notifyResolve(notifyBuffer);
            notifyResolve = null;
          }
          return;
        }
        if (notifyCollecting) notifyBuffer += str;
      },
    );
    bleLog(`[BLE] Subscribed to notifications (single subscription)`);
    await sleep(500); // Let CCCD settle

    // Helper: send command using shared notification subscription
    async function cmd(json: string, cmdName: string, timeoutMs: number): Promise<{ ok: boolean; response: string }> {
      return new Promise(async (resolve) => {
        const timer = setTimeout(() => {
          bleLog(`[BLE] ${cmdName}: TIMEOUT (${timeoutMs}ms)`);
          notifyResolve = null;
          resolve({ ok: false, response: '' });
        }, timeoutMs);

        notifyResolve = (resp) => {
          clearTimeout(timer);
          const ok = resp.includes('"result":0') || resp.includes('"result":1');
          bleLog(`[BLE] ${cmdName} → ${ok ? 'OK' : 'FAIL'}`);
          resolve({ ok, response: resp });
        };

        await writeFrame(device, svc, wChar, json, false);

        // Flush: read from char 3333 to kick iOS CoreBluetooth notification delivery
        if (fChar) {
          await sleep(2000);
          try { await device.readCharacteristicForService(svc, fChar); } catch {}
        }
      });
    }

    // ── Command sequence (order is CRITICAL) ─────────────────────

    if (isCharger) {
      onProgress('wifi', `Setting WiFi (${params.wifiSsid})...`);
      await cmd(JSON.stringify({
        set_wifi_info: {
          sta: { ssid: params.wifiSsid, passwd: params.wifiPassword, encrypt: 0 },
          ap: { ssid: 'CHARGER_PILE', passwd: '12345678', encrypt: 0 },
        },
      }), 'set_wifi_info', 15000);
      await sleep(1000);

      onProgress('rtk', 'Setting RTK...');
      await cmd(JSON.stringify({ set_rtk_info: 0 }), 'set_rtk_info', 15000);
      await sleep(1000);
    } else {
      onProgress('wifi', 'Handshake...');
      await cmd(JSON.stringify({ get_signal_info: 0 }), 'get_signal_info', 5000);
      await sleep(1000);

      onProgress('wifi', `Setting WiFi (${params.wifiSsid})...`);
      await cmd(JSON.stringify({
        set_wifi_info: { ap: { ssid: params.wifiSsid, passwd: params.wifiPassword, encrypt: 0 } },
      }), 'set_wifi_info', 15000);
      await sleep(1000);
    }

    onProgress('lora', 'Configuring LoRa...');
    await cmd(JSON.stringify({ set_lora_info: LORA }), 'set_lora_info', 15000);
    await sleep(1000);

    onProgress('mqtt', `Setting MQTT (${params.mqttAddr})...`);
    await cmd(JSON.stringify({ set_mqtt_info: { addr: params.mqttAddr, port: params.mqttPort } }),
      'set_mqtt_info', 15000);
    await sleep(1000);

    onProgress('commit', 'Saving settings...');
    const cfgPayload = isCharger
      ? JSON.stringify({ set_cfg_info: 1 })
      : JSON.stringify({ set_cfg_info: { cfg_value: 1, tz: 'Europe/Amsterdam' } });
    await cmd(cfgPayload, 'set_cfg_info', 15000);

    // Cleanup subscription
    notifySub?.remove();

    // Device will reboot — disconnect is expected
    try { await device.cancelConnection(); } catch {}

    onProgress('done', 'Settings saved! Device reconnecting...');
    return true;
  } catch (err: any) {
    console.error('[BLE] Provision error:', err.message);
    onProgress('error', err.message);
    return false;
  }
}
