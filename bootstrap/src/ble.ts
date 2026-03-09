/**
 * Native BLE provisioning for Novabot devices using @stoprocent/noble.
 *
 * Uses the laptop's native Bluetooth stack (CoreBluetooth on macOS, BlueZ on Linux)
 * for reliable BLE communication — much more stable than Web Bluetooth.
 *
 * Protocol matches the Novabot app and novabot-server/src/ble/provisioner.ts:
 *   Frame: ble_start → 20-byte JSON chunks (30ms delay) → ble_end
 *
 * Device GATT layouts:
 *   Mower:   Service 0x0201, Write 0x0011, Notify 0x0021
 *   Charger: Service 0x1234, Write 0x2222, Notify 0x2222
 */

import type { Server as IOServer } from 'socket.io';

type Noble = typeof import('@stoprocent/noble').default;
type Peripheral = import('@stoprocent/noble').Peripheral;
type Characteristic = import('@stoprocent/noble').Characteristic;

// GATT layouts per device type
const GATT_LAYOUTS = {
  charger: { service: '1234', writeChar: '2222', notifyChar: '2222' },
  mower:   { service: '0201', writeChar: '0011', notifyChar: '0021' },
} as const;

const CHUNK_SIZE = 20;
const INTER_CHUNK_DELAY = 30;
const RESPONSE_TIMEOUT = 10_000;
const NOVABOT_COMPANY_ID = 0x5566;

let noble: Noble | null = null;
let _scanning = false;

async function getNoble(): Promise<Noble> {
  if (noble) return noble;
  const mod = await import('@stoprocent/noble');
  noble = mod.default;
  return noble;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Public API ──────────────────────────────────────────────────────────────────

export interface BleStatusResult {
  available: boolean;
  state: string;
}

export interface ScannedDevice {
  mac: string;
  name: string;
  rssi: number;
  type: 'charger' | 'mower' | 'unknown';
}

export interface ProvisionParams {
  targetMac: string;
  wifiSsid: string;
  wifiPassword: string;
  mqttAddr: string;
  mqttPort: number;
  deviceType: 'mower' | 'charger';
}

/**
 * Check if native Bluetooth is available and powered on.
 * Waits up to 3 seconds for noble to transition from 'unknown' to 'poweredOn'.
 */
export async function getBleStatus(): Promise<BleStatusResult> {
  try {
    const n = await getNoble();

    // Noble starts in 'unknown' state and transitions to 'poweredOn' after ~1s.
    // Wait briefly so the frontend gets the real state, not 'unknown'.
    if (n.state !== 'poweredOn') {
      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => {
            n.removeListener('stateChange', onState);
            reject(new Error('timeout'));
          }, 3000);
          const onState = (state: string) => {
            if (state === 'poweredOn') {
              clearTimeout(t);
              n.removeListener('stateChange', onState);
              resolve();
            }
          };
          n.on('stateChange', onState);
          // Already transitioned while we were setting up?
          if (n.state === 'poweredOn') {
            clearTimeout(t);
            n.removeListener('stateChange', onState);
            resolve();
          }
        });
      } catch {
        // Timeout — return whatever state we have
      }
    }

    return { available: true, state: n.state };
  } catch {
    return { available: false, state: 'unavailable' };
  }
}

/**
 * Scan for Novabot BLE devices. Results are emitted via Socket.io.
 */
export async function scanDevices(io: IOServer, durationMs = 10000): Promise<void> {
  if (_scanning) {
    console.log('[BLE] Scan already in progress');
    return;
  }

  const n = await getNoble();

  // Wait for adapter to be ready
  if (n.state !== 'poweredOn') {
    console.log(`[BLE] Waiting for Bluetooth adapter (state: ${n.state})...`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        n.removeAllListeners('stateChange');
        reject(new Error(`Bluetooth adapter not ready (state: ${n.state})`));
      }, 5000);
      const onState = (state: string) => {
        if (state === 'poweredOn') {
          clearTimeout(t);
          n.removeListener('stateChange', onState);
          resolve();
        }
      };
      n.on('stateChange', onState);
    });
  }

  _scanning = true;
  const seen = new Set<string>();

  const onDiscover = (peripheral: Peripheral) => {
    const mfgData = peripheral.advertisement?.manufacturerData;
    if (!mfgData || mfgData.length < 8) return;

    const companyId = mfgData.readUInt16LE(0);
    if (companyId !== NOVABOT_COMPANY_ID) return;

    const mac = Array.from(mfgData.subarray(2, 8))
      .map(b => b.toString(16).padStart(2, '0').toUpperCase())
      .join(':');

    const name = peripheral.advertisement?.localName ?? 'Unknown';
    const rssi = peripheral.rssi ?? -999;

    // Determine device type from name
    let type: 'charger' | 'mower' | 'unknown' = 'unknown';
    const nameLower = name.toLowerCase();
    if (nameLower.includes('charger') || nameLower.includes('lfic')) {
      type = 'charger';
    } else if (nameLower.includes('novabot') || nameLower.includes('lfin')) {
      type = 'mower';
    }

    const device: ScannedDevice = { mac, name, rssi, type };

    if (!seen.has(mac)) {
      seen.add(mac);
      console.log(`[BLE] Found: ${name} (${mac}) RSSI=${rssi} type=${type}`);
    }

    io.emit('ble-scan-result', device);
  };

  n.on('discover', onDiscover);

  console.log(`[BLE] Starting scan (${durationMs}ms)...`);
  await n.startScanningAsync([], true); // allow duplicates for RSSI updates

  // Stop after duration
  setTimeout(async () => {
    if (!_scanning) return;
    _scanning = false;
    n.removeListener('discover', onDiscover);
    try { await n.stopScanningAsync(); } catch { /* ignore */ }
    console.log(`[BLE] Scan complete, found ${seen.size} device(s)`);
    io.emit('ble-scan-done', { count: seen.size });
  }, durationMs);
}

/**
 * Stop an active BLE scan.
 */
export async function stopScan(): Promise<void> {
  if (!_scanning || !noble) return;
  _scanning = false;
  noble.removeAllListeners('discover');
  try { await noble.stopScanningAsync(); } catch { /* ignore */ }
  console.log('[BLE] Scan stopped');
}

/**
 * Provision a Novabot device via native BLE.
 */
export async function provisionDevice(params: ProvisionParams, io: IOServer): Promise<boolean> {
  const { targetMac, wifiSsid, wifiPassword, mqttAddr, mqttPort, deviceType } = params;

  const n = await getNoble();

  // Stop any active scan
  if (_scanning) await stopScan();

  // Ensure adapter is ready
  if (n.state !== 'poweredOn') {
    io.emit('ble-progress', { phase: 'error', error: 'Bluetooth adapter not ready' });
    return false;
  }

  const targetMacNorm = targetMac.toLowerCase().replace(/:/g, '');
  let targetPeripheral: Peripheral | null = null;

  try {
    // ── Step 1: Find target device ──────────────────────────────
    io.emit('ble-progress', { phase: 'connecting', message: 'Scanning for device...' });
    console.log(`[BLE] Scanning for MAC ${targetMac}...`);

    await new Promise<void>((resolve, reject) => {
      const scanTimeout = setTimeout(() => {
        n.stopScanning();
        n.removeAllListeners('discover');
        reject(new Error(`Device ${targetMac} not found after 15s scan`));
      }, 15_000);

      n.on('discover', (peripheral: Peripheral) => {
        const mfgData = peripheral.advertisement?.manufacturerData;
        if (!mfgData || mfgData.length < 8) return;
        if (mfgData.readUInt16LE(0) !== NOVABOT_COMPANY_ID) return;

        const mac = Array.from(mfgData.subarray(2, 8))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');

        if (mac === targetMacNorm) {
          clearTimeout(scanTimeout);
          n.stopScanning();
          n.removeAllListeners('discover');
          targetPeripheral = peripheral;
          resolve();
        }
      });

      n.startScanning([], true);
    });

    if (!targetPeripheral) {
      io.emit('ble-progress', { phase: 'error', error: 'Device not found' });
      return false;
    }

    // ── Step 2: Connect ─────────────────────────────────────────
    const devName = (targetPeripheral as Peripheral).advertisement?.localName ?? '?';
    io.emit('ble-progress', { phase: 'connecting', message: `Connecting to ${devName}...` });
    console.log(`[BLE] Connecting to ${devName}...`);

    await (targetPeripheral as Peripheral).connectAsync();
    console.log('[BLE] Connected!');
    await sleep(500);

    // ── Step 3: Discover services ───────────────────────────────
    io.emit('ble-progress', { phase: 'discovering', message: 'Discovering services...' });

    const layout = GATT_LAYOUTS[deviceType];
    const result = await (targetPeripheral as Peripheral).discoverAllServicesAndCharacteristicsAsync();

    console.log(`[BLE] Found ${result.services.length} service(s), ${result.characteristics.length} char(s)`);
    for (const s of result.services) {
      console.log(`[BLE]   Service: ${s.uuid}`);
    }
    for (const c of result.characteristics) {
      console.log(`[BLE]   Char: ${c.uuid} props=${JSON.stringify(c.properties)}`);
    }

    const writeChar = result.characteristics.find(c => c.uuid === layout.writeChar);
    const notifyChar = result.characteristics.find(c => c.uuid === layout.notifyChar);

    if (!writeChar) {
      const avail = result.characteristics.map(c => `${c.uuid}(${c.properties.join('+')})`).join(', ');
      throw new Error(`Write char ${layout.writeChar} not found. Available: ${avail}`);
    }
    if (!notifyChar) {
      const avail = result.characteristics.map(c => `${c.uuid}(${c.properties.join('+')})`).join(', ');
      throw new Error(`Notify char ${layout.notifyChar} not found. Available: ${avail}`);
    }

    // Subscribe to ALL notify characteristics (responses come on writeChar for mower!)
    const allNotifyChars = result.characteristics.filter(c => c.properties.includes('notify'));
    for (const c of allNotifyChars) {
      await c.subscribeAsync();
      c.on('data', (data: Buffer) => {
        const hex = data.toString('hex');
        const str = data.toString('utf8').replace(/\0/g, '');
        console.log(`[BLE] RAW notify on ${c.uuid}: hex=${hex} str="${str}" len=${data.length}`);
      });
      console.log(`[BLE] Subscribed to notifications on ${c.uuid}`);
    }
    await sleep(500);

    // ── Step 4: get_signal_info (handshake, non-fatal) ──────────
    try {
      io.emit('ble-progress', { phase: 'handshake', message: 'Handshake...' });
      const { response } = await sendCommand(writeChar, allNotifyChars,
        JSON.stringify({ get_signal_info: 0 }), 'get_signal_info', 5000);
      console.log('[BLE] get_signal_info OK:', JSON.stringify(response));
    } catch {
      console.warn('[BLE] get_signal_info no response (non-fatal, continuing)');
    }
    await sleep(1000); // Give mower time to process

    // ── Step 5: set_wifi_info (non-fatal on timeout) ────────────
    io.emit('ble-progress', { phase: 'wifi', message: `Setting WiFi (${wifiSsid})...` });

    let wifiPayload: unknown;
    if (deviceType === 'mower') {
      wifiPayload = {
        set_wifi_info: {
          ap: { ssid: wifiSsid, passwd: wifiPassword, encrypt: 0 },
        },
      };
    } else {
      wifiPayload = {
        set_wifi_info: {
          sta: { ssid: wifiSsid, passwd: wifiPassword, encrypt: 0 },
          ap: { ssid: 'CHARGER_PILE', passwd: '12345678', encrypt: 0 },
        },
      };
    }

    try {
      const { ok, response } = await sendCommand(writeChar, allNotifyChars,
        JSON.stringify(wifiPayload), 'set_wifi_info', 15000);
      if (ok) {
        console.log('[BLE] set_wifi_info OK');
      } else {
        console.warn('[BLE] set_wifi_info result non-zero (continuing):', JSON.stringify(response));
      }
    } catch {
      console.warn('[BLE] set_wifi_info no response (non-fatal, continuing to mqtt)');
    }
    await sleep(1000); // Give mower time to process

    // ── Step 6: set_lora_info ────────────────────────────────────
    // The official app sends this before set_mqtt_info. Without it,
    // set_mqtt_info may return result:1 (rejected).
    io.emit('ble-progress', { phase: 'lora', message: 'Setting LoRa...' });
    const loraPayload = JSON.stringify({
      set_lora_info: { addr: 718, channel: 15, hc: 20, lc: 14 },
    });
    try {
      const { ok: loraOk, response: loraResp } = await sendCommand(
        writeChar, allNotifyChars, loraPayload, 'set_lora_info', 15000);
      if (loraOk) {
        const resp = loraResp as { message?: { value?: number } };
        if (resp?.message?.value != null) {
          console.log(`[BLE] LoRa assigned channel: ${resp.message.value}`);
        }
      } else {
        console.warn('[BLE] set_lora_info returned non-zero (continuing):', JSON.stringify(loraResp));
      }
    } catch {
      console.warn('[BLE] set_lora_info no response (non-fatal, continuing)');
    }
    await sleep(1000); // Give device time to process

    // ── Step 7: set_mqtt_info ───────────────────────────────────
    io.emit('ble-progress', { phase: 'mqtt', message: `Setting MQTT (${mqttAddr}:${mqttPort})...` });

    const mqttPayload = JSON.stringify({ set_mqtt_info: { addr: mqttAddr, port: mqttPort } });
    try {
      const { ok: mqttOk, response: mqttResp } = await sendCommand(
        writeChar, allNotifyChars, mqttPayload, 'set_mqtt_info', 15000);
      if (mqttOk) {
        console.log('[BLE] set_mqtt_info OK — MQTT address accepted!');
      } else {
        console.warn('[BLE] set_mqtt_info returned non-zero result (continuing to commit):', JSON.stringify(mqttResp));
      }
    } catch {
      console.warn('[BLE] set_mqtt_info no response (non-fatal, continuing to commit)');
    }
    await sleep(1000); // Give device time to process

    // ── Step 8: set_cfg_info (commit) ───────────────────────────
    io.emit('ble-progress', { phase: 'commit', message: 'Saving settings...' });

    // Charger: { set_cfg_info: 1 }
    // Mower: { set_cfg_info: { cfg_value: 1, tz: "Europe/Amsterdam" } }
    // Note: tz in BLE set_cfg_info is safe — the OTA bug is only about tz in MQTT ota_upgrade_cmd
    const cfgPayload = deviceType === 'mower'
      ? JSON.stringify({ set_cfg_info: { cfg_value: 1, tz: 'Europe/Amsterdam' } })
      : JSON.stringify({ set_cfg_info: 1 });

    try {
      const { ok: cfgOk, response: cfgResp } = await sendCommand(
        writeChar, allNotifyChars, cfgPayload, 'set_cfg_info', 15000);
      if (!cfgOk) {
        io.emit('ble-progress', { phase: 'error', error: `set_cfg_info failed: ${JSON.stringify(cfgResp)}` });
        return false;
      }
    } catch (err) {
      // set_cfg_info often causes BLE disconnect (device restarts networking).
      // Timeout or GATT disconnect here is actually SUCCESS.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('timeout') || msg.includes('disconnect') || msg.includes('GATT') || msg.includes('not connected')) {
        console.log('[BLE] set_cfg_info caused disconnect (expected — device restarting)');
      } else {
        throw err;
      }
    }

    // ── Done! ───────────────────────────────────────────────────
    console.log('[BLE] Provisioning complete!');
    io.emit('ble-progress', { phase: 'done', message: 'Settings saved! Device reconnecting...' });
    return true;

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[BLE] Error:', message);
    io.emit('ble-progress', { phase: 'error', error: message });
    return false;

  } finally {
    // Unsubscribe and disconnect
    if (targetPeripheral) {
      try {
        await (targetPeripheral as Peripheral).disconnectAsync();
        console.log('[BLE] Disconnected');
      } catch { /* ignore */ }
    }
  }
}

// ── BLE Frame Protocol ──────────────────────────────────────────────────────────

/**
 * Write a BLE frame: ble_start → chunked payload → ble_end.
 */
async function writeFrame(char: Characteristic, payload: string): Promise<void> {
  const startMarker = Buffer.from('ble_start', 'utf8');
  const endMarker = Buffer.from('ble_end', 'utf8');
  const data = Buffer.from(payload, 'utf8');

  await char.writeAsync(startMarker, true);
  await sleep(INTER_CHUNK_DELAY);

  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const chunk = data.subarray(offset, Math.min(offset + CHUNK_SIZE, data.length));
    await char.writeAsync(chunk, true);
    await sleep(INTER_CHUNK_DELAY);
  }

  await char.writeAsync(endMarker, true);
  await sleep(INTER_CHUNK_DELAY);
}

/**
 * Wait for a complete BLE response frame (ble_start ... ble_end) on ANY of the given chars.
 * Filters by expectedType to drain stale responses from previous commands.
 *
 * IMPORTANT: For the mower, responses arrive on writeChar (0011), not notifyChar (0021).
 * We listen on all provided chars to handle both mower and charger layouts.
 */
function waitForResponse(
  chars: Characteristic[],
  expectedType: string,
  timeoutMs = RESPONSE_TIMEOUT,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let collecting = false;

    const cleanup = () => {
      for (const c of chars) c.removeListener('data', onData);
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`BLE response timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onData = (data: Buffer) => {
      const str = data.toString('utf8').replace(/\0/g, '');

      if (str === 'ble_start') {
        collecting = true;
        buffer = '';
        return;
      }

      if (str === 'ble_end' && collecting) {
        collecting = false;
        let parsed: unknown;
        try {
          parsed = JSON.parse(buffer);
        } catch {
          parsed = buffer;
        }

        // Check if this is the response we're waiting for
        const respType = (parsed as { type?: string })?.type ?? '';
        if (respType && !respType.includes(expectedType)) {
          // Stale response from a previous command — drain it and keep waiting
          console.log(`[BLE] Draining stale response: ${respType} (waiting for ${expectedType})`);
          return;
        }

        clearTimeout(timeout);
        cleanup();
        resolve(parsed);
        return;
      }

      if (collecting) {
        buffer += str;
      }
    };

    for (const c of chars) c.on('data', onData);
  });
}

/**
 * Send a BLE command and wait for the matching response.
 * Listens on ALL notify chars (responses come on writeChar for mower, same char for charger).
 */
async function sendCommand(
  writeChar: Characteristic,
  allNotifyChars: Characteristic[],
  payload: string,
  label: string,
  timeoutMs = RESPONSE_TIMEOUT,
): Promise<{ response: unknown; ok: boolean }> {
  console.log(`[BLE] → ${label}: ${payload}`);

  // Expected response type: e.g. "set_wifi_info" → looks for "set_wifi_info" in type field
  const expectedType = label;

  const responsePromise = waitForResponse(allNotifyChars, expectedType, timeoutMs);
  await writeFrame(writeChar, payload);
  const response = await responsePromise;
  console.log(`[BLE] ← ${label}:`, JSON.stringify(response));

  const resp = response as { message?: { result?: number } } | null;
  const ok = resp?.message?.result === 0 || resp?.message?.result === undefined;
  return { response, ok };
}
