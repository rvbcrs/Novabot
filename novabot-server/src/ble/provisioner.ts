/**
 * BLE Provisioner for Novabot devices.
 *
 * Connects to a Novabot / CHARGER_PILE device via BLE GATT and sends
 * provisioning commands (WiFi, MQTT, LoRa, config) — exactly like the
 * Novabot app does during "Add Mower" / "Add Charging Station".
 *
 * GATT structure (varies by device):
 *   Charger (ESP32-S3):  Service 0x1234, Char 0x2222 (cmd) + 0x3333
 *   Mower (BCM43438):    Service 0x0201, Char 0x0011 (cmd) + 0x0021
 *
 * BLE frame protocol (same on both):
 *   1. Write "ble_start" marker
 *   2. Write JSON payload in ~20-byte chunks
 *   3. Write "ble_end" marker
 *   4. Wait for response on notify (same framing)
 */

import { pushBleLog, pauseBackgroundScan, resumeBackgroundScan } from './bleLogger.js';

type Noble = typeof import('@stoprocent/noble').default;
type Peripheral = import('@stoprocent/noble').Peripheral;
type Characteristic = import('@stoprocent/noble').Characteristic;

// Known GATT layouts per device type
// Charger: single command char handles both write and notify
// Mower: separate write (0011) and notify (0021) characteristics
const GATT_LAYOUTS = {
  charger: { service: '1234', writeChar: '2222', notifyChar: '2222' },
  mower:   { service: '0201', writeChar: '0011', notifyChar: '0021' },
} as const;

const CHUNK_SIZE = 20;
const INTER_CHUNK_DELAY = 30; // ms between chunks (matching firmware timing)
const RESPONSE_TIMEOUT = 10_000; // ms to wait for a BLE response

export interface ProvisionParams {
  /** Target BLE MAC address (e.g. "50:41:1C:39:BD:C1") */
  targetMac: string;
  /** WiFi SSID to connect to */
  wifiSsid: string;
  /** WiFi password */
  wifiPassword: string;
  /** MQTT broker address (default: nova-mqtt.ramonvanbruggen.nl) */
  mqttAddr?: string;
  /** MQTT broker port (default: 1883) */
  mqttPort?: number;
  /** LoRa address (default: 718) */
  loraAddr?: number;
  /** LoRa channel (default: 15) */
  loraChannel?: number;
  /** LoRa high channel bound (default: 20) */
  loraHc?: number;
  /** LoRa low channel bound (default: 14) */
  loraLc?: number;
  /** Timezone (default: Europe/Amsterdam) */
  timezone?: string;
  /** Device type: "mower" or "charger" — affects set_wifi_info format */
  deviceType?: 'mower' | 'charger';
}

export interface ProvisionResult {
  success: boolean;
  steps: StepResult[];
  error?: string;
}

interface StepResult {
  command: string;
  sent: unknown;
  response: unknown;
  ok: boolean;
}

let noble: Noble | null = null;

async function getNoble(): Promise<Noble> {
  if (noble) return noble;
  const mod = await import('@stoprocent/noble');
  noble = mod.default;
  return noble;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Write a BLE frame: ble_start + chunked payload + ble_end.
 * Each chunk is written with Write Without Response (no ACK).
 */
async function writeFrame(char: Characteristic, payload: string): Promise<void> {
  const startMarker = Buffer.from('ble_start', 'utf8');
  const endMarker = Buffer.from('ble_end', 'utf8');
  const data = Buffer.from(payload, 'utf8');

  // Write start marker
  await char.writeAsync(startMarker, true); // true = withoutResponse
  await sleep(INTER_CHUNK_DELAY);

  // Write payload in chunks
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const chunk = data.subarray(offset, Math.min(offset + CHUNK_SIZE, data.length));
    await char.writeAsync(chunk, true);
    await sleep(INTER_CHUNK_DELAY);
  }

  // Write end marker
  await char.writeAsync(endMarker, true);
  await sleep(INTER_CHUNK_DELAY);
}

/**
 * Wait for a complete BLE response frame (ble_start ... ble_end).
 * Returns the parsed JSON response.
 */
function waitForResponse(char: Characteristic, timeoutMs = RESPONSE_TIMEOUT): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let collecting = false;
    const timeout = setTimeout(() => {
      char.removeAllListeners('data');
      reject(new Error(`BLE response timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onData = (data: Buffer, _isNotify: boolean) => {
      const str = data.toString('utf8');

      if (str === 'ble_start') {
        collecting = true;
        buffer = '';
        return;
      }

      if (str === 'ble_end' && collecting) {
        collecting = false;
        clearTimeout(timeout);
        char.removeListener('data', onData);
        try {
          resolve(JSON.parse(buffer));
        } catch {
          resolve(buffer); // return raw string if not JSON
        }
        return;
      }

      if (collecting) {
        buffer += str;
      }
    };

    char.on('data', onData);
  });
}

/**
 * Send a BLE command and wait for the response.
 */
async function sendCommand(
  writeChar: Characteristic,
  notifyChar: Characteristic,
  payload: string,
  label: string,
  meta?: { deviceName: string; mac: string },
): Promise<{ response: unknown; ok: boolean }> {
  console.log(`[BLE-PROV] → ${label}: ${payload}`);

  // Log the write
  if (meta) {
    pushBleLog({
      ts: Date.now(), type: 'write', deviceName: meta.deviceName, mac: meta.mac,
      rssi: 0, service: '1234', characteristic: writeChar.uuid,
      data: payload, direction: '\u2192DEV',
    });
  }

  // Start listening BEFORE writing (to not miss the response)
  const responsePromise = waitForResponse(notifyChar);

  // Write the frame
  await writeFrame(writeChar, payload);

  // Wait for response
  const response = await responsePromise;
  console.log(`[BLE-PROV] ← ${label}:`, JSON.stringify(response));

  // Log the response
  if (meta) {
    pushBleLog({
      ts: Date.now(), type: 'notify', deviceName: meta.deviceName, mac: meta.mac,
      rssi: 0, service: '1234', characteristic: notifyChar.uuid,
      data: JSON.stringify(response), direction: '\u2190DEV',
    });
  }

  // Check result field
  const resp = response as { type?: string; message?: { result?: number } };
  const ok = resp?.message?.result === 0 || resp?.message?.result === undefined;
  return { response, ok };
}

/**
 * Provision a Novabot device via BLE.
 *
 * Scans for the target device, connects, and sends WiFi/MQTT/LoRa/config
 * commands in the correct order.
 */
export async function provisionDevice(params: ProvisionParams): Promise<ProvisionResult> {
  const {
    targetMac,
    wifiSsid,
    wifiPassword,
    mqttAddr = 'nova-mqtt.ramonvanbruggen.nl',
    mqttPort = 1883,
    loraAddr = 718,
    loraChannel = 15,
    loraHc = 20,
    loraLc = 14,
    timezone = 'Europe/Amsterdam',
    deviceType = 'mower',
  } = params;

  const steps: StepResult[] = [];
  const n = await getNoble();

  // Pause background BLE scan so it doesn't interfere
  await pauseBackgroundScan();

  // Wait for adapter
  if (n.state !== 'poweredOn') {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Bluetooth adapter timeout')), 5000);
      const onState = (state: string) => {
        if (state === 'poweredOn') { clearTimeout(t); n.removeListener('stateChange', onState); resolve(); }
      };
      n.on('stateChange', onState);
    });
  }

  // ── Step 1: Find the target device ──────────────────────────
  console.log(`[BLE-PROV] Scanning for BLE MAC ${targetMac}...`);
  const targetMacNorm = targetMac.toLowerCase().replace(/:/g, '');
  let targetPeripheral: Peripheral | null = null;

  await new Promise<void>((resolve, reject) => {
    const scanTimeout = setTimeout(() => {
      n.stopScanning();
      n.removeAllListeners('discover');
      reject(new Error(`Device ${targetMac} not found after 15s scan`));
    }, 15_000);

    n.on('discover', (peripheral: Peripheral) => {
      const mfgData = peripheral.advertisement?.manufacturerData;
      if (!mfgData || mfgData.length < 8) return;

      const companyId = mfgData.readUInt16LE(0);
      if (companyId !== 0x5566) return;

      const mac = Array.from(mfgData.subarray(2, 8))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      if (mac === targetMacNorm) {
        clearTimeout(scanTimeout);
        n.stopScanning();
        n.removeAllListeners('discover');
        const name = peripheral.advertisement?.localName ?? '?';
        console.log(`[BLE-PROV] Found target: ${name} (${targetMac}) RSSI=${peripheral.rssi}`);
        targetPeripheral = peripheral;
        resolve();
      }
    });

    n.startScanning([], true);
  });

  if (!targetPeripheral) {
    return { success: false, steps, error: 'Device not found' };
  }

  // ── Step 2: Connect ─────────────────────────────────────────
  const devName = (targetPeripheral as Peripheral).advertisement?.localName ?? '?';
  const bleMeta = { deviceName: devName, mac: targetMac };
  console.log('[BLE-PROV] Connecting...');
  await (targetPeripheral as Peripheral).connectAsync();
  console.log('[BLE-PROV] Connected!');
  pushBleLog({ ts: Date.now(), type: 'connect', deviceName: devName, mac: targetMac, rssi: (targetPeripheral as Peripheral).rssi ?? 0, direction: '' });

  // Small delay after connect to let GATT stabilize
  await sleep(500);

  try {
    // ── Step 3: Discover service + characteristics ───────────
    const layout = GATT_LAYOUTS[deviceType];
    console.log(`[BLE-PROV] Discovering services (expecting service=${layout.service}, write=${layout.writeChar}, notify=${layout.notifyChar})...`);

    // Discover all services — filtered discovery is unreliable across platforms
    const result = await (targetPeripheral as Peripheral).discoverAllServicesAndCharacteristicsAsync();
    console.log(`[BLE-PROV] Found ${result.services.length} service(s), ${result.characteristics.length} char(s)`);
    for (const s of result.services) {
      console.log(`[BLE-PROV]   Service: ${s.uuid}`);
    }
    for (const c of result.characteristics) {
      console.log(`[BLE-PROV]   Char: ${c.uuid} props=${JSON.stringify(c.properties)}`);
    }

    // Find write and notify characteristics
    const writeChar = result.characteristics.find(c => c.uuid === layout.writeChar);
    const notifyChar = result.characteristics.find(c => c.uuid === layout.notifyChar);

    if (!writeChar) {
      const availUuids = result.characteristics.map(c => `${c.uuid}(${c.properties.join('+')})`).join(', ');
      return { success: false, steps, error: `Write char ${layout.writeChar} not found. Available: ${availUuids}` };
    }
    if (!notifyChar) {
      const availUuids = result.characteristics.map(c => `${c.uuid}(${c.properties.join('+')})`).join(', ');
      return { success: false, steps, error: `Notify char ${layout.notifyChar} not found. Available: ${availUuids}` };
    }

    console.log(`[BLE-PROV] Using write=${writeChar.uuid}, notify=${notifyChar.uuid}`);

    // Subscribe to notifications on BOTH characteristics to catch responses
    const allNotifyChars = result.characteristics.filter(c => c.properties.includes('notify'));
    for (const c of allNotifyChars) {
      await c.subscribeAsync();
      // Raw data tap for debugging
      c.on('data', (data: Buffer) => {
        const hex = data.toString('hex');
        const str = data.toString('utf8');
        console.log(`[BLE-PROV] RAW notify on ${c.uuid}: hex=${hex} str=${JSON.stringify(str)} len=${data.length}`);
      });
      console.log(`[BLE-PROV] Subscribed to notifications on ${c.uuid}`);
    }

    // Small delay after subscribe
    await sleep(200);

    // ── Step 4: get_signal_info ────────────────────────────────
    {
      const payload = JSON.stringify({ get_signal_info: 0 });
      console.log(`[BLE-PROV] Sending get_signal_info on write char ${writeChar.uuid}...`);
      const { response, ok } = await sendCommand(writeChar, notifyChar, payload, 'get_signal_info', bleMeta);
      steps.push({ command: 'get_signal_info', sent: { get_signal_info: 0 }, response, ok });
      if (!ok) console.warn('[BLE-PROV] get_signal_info failed, continuing anyway');
    }

    // ── Step 5: set_wifi_info ──────────────────────────────────
    {
      // Mower: only "ap" sub-object
      // Charger: "sta" (home WiFi) + "ap" (own AP)
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
            ap: { ssid: targetMac.replace(/:/g, ''), passwd: '12345678', encrypt: 0 },
          },
        };
      }
      const payload = JSON.stringify(wifiPayload);
      const { response, ok } = await sendCommand(writeChar, notifyChar, payload, 'set_wifi_info', bleMeta);
      steps.push({ command: 'set_wifi_info', sent: wifiPayload, response, ok });
      if (!ok) {
        return { success: false, steps, error: 'set_wifi_info failed — check WiFi credentials' };
      }
    }

    // ── Step 6: set_lora_info ──────────────────────────────────
    {
      const loraPayload = {
        set_lora_info: { addr: loraAddr, channel: loraChannel, hc: loraHc, lc: loraLc },
      };
      const payload = JSON.stringify(loraPayload);
      const { response, ok } = await sendCommand(writeChar, notifyChar, payload, 'set_lora_info', bleMeta);
      steps.push({ command: 'set_lora_info', sent: loraPayload, response, ok });
      // LoRa might return assigned channel in value — log it
      const resp = response as { message?: { value?: number } };
      if (resp?.message?.value != null) {
        console.log(`[BLE-PROV] LoRa assigned channel: ${resp.message.value}`);
      }
    }

    // ── Step 7: set_mqtt_info ──────────────────────────────────
    {
      const mqttPayload = { set_mqtt_info: { addr: mqttAddr, port: mqttPort } };
      const payload = JSON.stringify(mqttPayload);
      const { response, ok } = await sendCommand(writeChar, notifyChar, payload, 'set_mqtt_info', bleMeta);
      steps.push({ command: 'set_mqtt_info', sent: mqttPayload, response, ok });
      if (!ok) {
        return { success: false, steps, error: 'set_mqtt_info failed' };
      }
    }

    // ── Step 8: set_cfg_info (commit) ──────────────────────────
    {
      // Mower: includes timezone; Charger: just cfg_value
      const cfgPayload = deviceType === 'mower'
        ? { set_cfg_info: { cfg_value: 1, tz: timezone } }
        : { set_cfg_info: 1 };
      const payload = JSON.stringify(cfgPayload);
      const { response, ok } = await sendCommand(writeChar, notifyChar, payload, 'set_cfg_info', bleMeta);
      steps.push({ command: 'set_cfg_info', sent: cfgPayload, response, ok });
      if (!ok) {
        return { success: false, steps, error: 'set_cfg_info failed — config not committed' };
      }
    }

    // Unsubscribe all
    for (const c of allNotifyChars) {
      try { await c.unsubscribeAsync(); } catch { /* ignore */ }
    }

    console.log('[BLE-PROV] Provisioning complete! Device should restart WiFi now.');
    return { success: true, steps };

  } finally {
    // Always disconnect
    try {
      await (targetPeripheral as Peripheral).disconnectAsync();
      pushBleLog({ ts: Date.now(), type: 'disconnect', deviceName: devName, mac: targetMac, rssi: 0, direction: '' });
      console.log('[BLE-PROV] Disconnected');
    } catch { /* ignore */ }
    // Resume background scan
    await resumeBackgroundScan();
  }
}

/**
 * Raw BLE diagnostic: connect, discover, write data, capture all notifications.
 * Used to test different protocols and find the right approach.
 */
export async function bleRawDiagnostic(
  targetMac: string,
  opts: { charUuid?: string; data?: string; writeToAll?: boolean; durationMs?: number; framed?: boolean },
): Promise<{ services: unknown[]; notifications: unknown[]; writeResults: unknown[] }> {
  const n = await getNoble();
  await pauseBackgroundScan();
  const targetMacNorm = targetMac.toLowerCase().replace(/:/g, '');
  const notifications: { charUuid: string; hex: string; utf8: string; ts: number }[] = [];
  const writeResults: { charUuid: string; dataHex: string; ok: boolean; error?: string }[] = [];

  // Wait for adapter
  if (n.state !== 'poweredOn') {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Bluetooth adapter timeout')), 5000);
      n.on('stateChange', (state: string) => {
        if (state === 'poweredOn') { clearTimeout(t); resolve(); }
      });
    });
  }

  // Scan for target
  console.log(`[BLE-RAW] Scanning for ${targetMac}...`);
  let peripheral: Peripheral | null = null;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => { n.stopScanning(); n.removeAllListeners('discover'); reject(new Error('Not found')); }, 10_000);
    n.on('discover', (p: Peripheral) => {
      const mfg = p.advertisement?.manufacturerData;
      if (!mfg || mfg.length < 8) return;
      if (mfg.readUInt16LE(0) !== 0x5566) return;
      const mac = Array.from(mfg.subarray(2, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
      if (mac === targetMacNorm) {
        clearTimeout(t); n.stopScanning(); n.removeAllListeners('discover');
        peripheral = p; resolve();
      }
    });
    n.startScanning([], true);
  });

  if (!peripheral) throw new Error('Device not found');

  // Connect
  const devName = (peripheral as Peripheral).advertisement?.localName ?? '?';
  console.log('[BLE-RAW] Connecting...');
  await (peripheral as Peripheral).connectAsync();
  pushBleLog({ ts: Date.now(), type: 'connect', deviceName: devName, mac: targetMac, rssi: (peripheral as Peripheral).rssi ?? 0, direction: '' });
  await sleep(500);

  try {
    // Discover all
    const result = await (peripheral as Peripheral).discoverAllServicesAndCharacteristicsAsync();
    const services = result.services.map(s => ({
      uuid: s.uuid,
      chars: result.characteristics
        .filter(c => (c as unknown as { _serviceUuid?: string })._serviceUuid === s.uuid)
        .map(c => ({ uuid: c.uuid, props: c.properties })),
    }));

    // If no service grouping works, just list all chars
    if (services.every(s => s.chars.length === 0)) {
      services.length = 0;
      services.push({
        uuid: 'all',
        chars: result.characteristics.map(c => ({ uuid: c.uuid, props: c.properties })),
      });
    }

    console.log(`[BLE-RAW] Found ${result.services.length} services, ${result.characteristics.length} chars`);

    // Subscribe to all notify chars
    for (const c of result.characteristics) {
      if (c.properties.includes('notify')) {
        await c.subscribeAsync();
        c.on('data', (buf: Buffer) => {
          const now = Date.now();
          notifications.push({
            charUuid: c.uuid,
            hex: buf.toString('hex'),
            utf8: buf.toString('utf8').replace(/[\x00-\x1f]/g, '.'),
            ts: now,
          });
          pushBleLog({
            ts: now, type: 'notify', deviceName: devName, mac: targetMac,
            rssi: 0, characteristic: c.uuid,
            data: buf.toString('hex'), direction: '\u2190DEV',
          });
        });
      }
    }

    // Wait a moment to capture baseline notifications
    await sleep(1500);
    const baselineCount = notifications.length;
    console.log(`[BLE-RAW] Captured ${baselineCount} baseline notifications`);

    // Write data if provided
    if (opts.data) {
      // Determine data to write
      const isHex = /^[0-9a-fA-F]+$/.test(opts.data) && opts.data.length % 2 === 0;
      const writeBuf = isHex ? Buffer.from(opts.data, 'hex') : Buffer.from(opts.data, 'utf8');

      // Determine which chars to write to
      const writeChars = opts.charUuid
        ? result.characteristics.filter(c => c.uuid === opts.charUuid)
        : opts.writeToAll
        ? result.characteristics.filter(c => c.properties.includes('writeWithoutResponse'))
        : [result.characteristics.find(c => c.properties.includes('writeWithoutResponse'))].filter(Boolean);

      for (const c of writeChars) {
        if (!c) continue;
        try {
          if (opts.framed) {
            // Framed mode: ble_start + chunked data + ble_end (as separate writes)
            const startMarker = Buffer.from('ble_start', 'utf8');
            const endMarker = Buffer.from('ble_end', 'utf8');
            await c.writeAsync(startMarker, true);
            await sleep(INTER_CHUNK_DELAY);
            for (let offset = 0; offset < writeBuf.length; offset += CHUNK_SIZE) {
              const chunk = writeBuf.subarray(offset, Math.min(offset + CHUNK_SIZE, writeBuf.length));
              await c.writeAsync(chunk, true);
              await sleep(INTER_CHUNK_DELAY);
            }
            await c.writeAsync(endMarker, true);
            await sleep(INTER_CHUNK_DELAY);
            console.log(`[BLE-RAW] Wrote FRAMED ${writeBuf.length}B to ${c.uuid} (ble_start + ${Math.ceil(writeBuf.length / CHUNK_SIZE)} chunks + ble_end)`);
          } else {
            // Raw mode: write data in chunks directly
            for (let offset = 0; offset < writeBuf.length; offset += CHUNK_SIZE) {
              const chunk = writeBuf.subarray(offset, Math.min(offset + CHUNK_SIZE, writeBuf.length));
              await c.writeAsync(chunk, true);
              await sleep(INTER_CHUNK_DELAY);
            }
            console.log(`[BLE-RAW] Wrote ${writeBuf.length}B to ${c.uuid}`);
          }
          writeResults.push({ charUuid: c.uuid, dataHex: writeBuf.toString('hex'), ok: true });
          pushBleLog({
            ts: Date.now(), type: 'write', deviceName: devName, mac: targetMac,
            rssi: 0, characteristic: c.uuid,
            data: writeBuf.toString('hex'), direction: '\u2192DEV',
          });
        } catch (err) {
          writeResults.push({ charUuid: c.uuid, dataHex: writeBuf.toString('hex'), ok: false, error: (err as Error).message });
          pushBleLog({
            ts: Date.now(), type: 'error', deviceName: devName, mac: targetMac,
            rssi: 0, characteristic: c.uuid,
            data: `Write failed: ${(err as Error).message}`, direction: '',
          });
        }
      }

      // Wait for responses
      await sleep(opts.durationMs ?? 3000);
    } else {
      // Just listen
      await sleep(opts.durationMs ?? 3000);
    }

    const afterCount = notifications.length;
    console.log(`[BLE-RAW] Captured ${afterCount - baselineCount} new notifications after write`);

    // Unsubscribe
    for (const c of result.characteristics) {
      if (c.properties.includes('notify')) {
        try { await c.unsubscribeAsync(); } catch { /* ignore */ }
      }
    }

    return { services, notifications, writeResults };
  } finally {
    try {
      await (peripheral as Peripheral).disconnectAsync();
      pushBleLog({ ts: Date.now(), type: 'disconnect', deviceName: devName, mac: targetMac, rssi: 0, direction: '' });
    } catch { /* ignore */ }
    console.log('[BLE-RAW] Disconnected');
    await resumeBackgroundScan();
  }
}
