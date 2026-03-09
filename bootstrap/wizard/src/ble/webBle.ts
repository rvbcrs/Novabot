/**
 * Web Bluetooth BLE provisioning for Novabot mower.
 *
 * Uses the browser's Web Bluetooth API to connect to the mower via BLE
 * and redirect its MQTT connection to the local Docker server.
 *
 * Protocol matches the native provisioner (novabot-server/src/ble/provisioner.ts):
 *   Frame: ble_start → 20-byte JSON chunks (30ms delay) → ble_end
 *
 * Mower GATT layout:
 *   Service: 0x0201, Write: 0x0011, Notify: 0x0021
 *
 * Charger GATT layout (fallback):
 *   Service: 0x1234, Write: 0x2222, Notify: 0x2222
 */

// Known service/characteristic UUIDs (16-bit and 128-bit forms)
const KNOWN_SERVICES = [
  0x0201, 0x1234,
  '00000201-0000-1000-8000-00805f9b34fb',
  '00001234-0000-1000-8000-00805f9b34fb',
];

const CHUNK_SIZE = 20;
const INTER_CHUNK_DELAY = 30;
const RESPONSE_TIMEOUT = 15_000;
const INTER_COMMAND_DELAY = 1000;

// ── Types ────────────────────────────────────────────────────────────────────

export type BlePhase =
  | 'idle'
  | 'requesting'
  | 'connecting'
  | 'discovering'
  | 'wifi'
  | 'mqtt'
  | 'commit'
  | 'done'
  | 'error';

export interface BleStatus {
  phase: BlePhase;
  message: string;
  deviceName?: string;
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isWebBluetoothAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.bluetooth !== 'undefined' &&
    typeof navigator.bluetooth.requestDevice === 'function'
  );
}

/**
 * Write a BLE frame: ble_start → chunked payload → ble_end.
 */
async function writeFrame(
  char: BluetoothRemoteGATTCharacteristic,
  payload: string,
): Promise<void> {
  const encoder = new TextEncoder();

  console.log(`[BLE] writeFrame → char ${char.uuid}, payload: ${payload}`);

  await char.writeValueWithoutResponse(encoder.encode('ble_start'));
  await sleep(INTER_CHUNK_DELAY);

  const data = encoder.encode(payload);
  const numChunks = Math.ceil(data.length / CHUNK_SIZE);
  for (let i = 0; i < numChunks; i++) {
    const offset = i * CHUNK_SIZE;
    const chunk = data.slice(offset, Math.min(offset + CHUNK_SIZE, data.length));
    await char.writeValueWithoutResponse(chunk);
    await sleep(INTER_CHUNK_DELAY);
  }

  await char.writeValueWithoutResponse(encoder.encode('ble_end'));
  await sleep(INTER_CHUNK_DELAY);
  console.log(`[BLE] writeFrame done (${numChunks} chunks)`);
}

// ── Global notification collector ────────────────────────────────────────────
// Collects ble_start...ble_end frames from ANY subscribed characteristic.
// Filters responses by expected `type` field to drain stale responses from
// previous commands (the mower can delay responses by 5-10s, causing a "shift").

interface ResponseCollector {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  expectedType: string;
}

let _pendingResponse: ResponseCollector | null = null;
let _responseBuffer = '';
let _collecting = false;
const _decoder = new TextDecoder();

function onAnyNotification(event: Event): void {
  const char = event.target as BluetoothRemoteGATTCharacteristic;
  if (!char.value) return;

  const raw = new Uint8Array(char.value.buffer);
  // Strip null bytes — firmware sends "ble_start\0" and "ble_end\0"
  const str = _decoder.decode(char.value).replace(/\0/g, '');
  const hex = Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`[BLE] NOTIFY on ${char.uuid}: "${str}" (hex: ${hex}, len: ${raw.length})`);

  if (str === 'ble_start') {
    _collecting = true;
    _responseBuffer = '';
    return;
  }

  if (str === 'ble_end' && _collecting) {
    _collecting = false;
    console.log(`[BLE] Response frame complete: "${_responseBuffer}"`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(_responseBuffer);
    } catch {
      parsed = _responseBuffer;
    }

    if (_pendingResponse) {
      // Check if this response matches the expected type
      const respType = (parsed as { type?: string })?.type ?? '';
      if (respType && _pendingResponse.expectedType && !respType.includes(_pendingResponse.expectedType)) {
        // Stale response from a previous command — drain it and keep waiting
        console.log(`[BLE] Draining stale response: type="${respType}" (waiting for "${_pendingResponse.expectedType}")`);
        return;
      }

      clearTimeout(_pendingResponse.timeout);
      const pr = _pendingResponse;
      _pendingResponse = null;
      pr.resolve(parsed);
    }
    return;
  }

  if (_collecting) {
    _responseBuffer += str;
  }
}

function waitForAnyResponse(expectedType: string, timeoutMs = RESPONSE_TIMEOUT): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      _pendingResponse = null;
      reject(new Error(`BLE response timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    _pendingResponse = { resolve, reject, timeout, expectedType };
  });
}

/**
 * Send a BLE command and wait for the MATCHING response on ANY subscribed notify char.
 * Drains stale responses from previous commands by checking the `type` field.
 */
async function sendCommand(
  writeChar: BluetoothRemoteGATTCharacteristic,
  payload: string,
  label: string,
  timeoutMs = RESPONSE_TIMEOUT,
): Promise<{ response: unknown; ok: boolean }> {
  console.log(`[BLE] sendCommand: ${label} (timeout: ${timeoutMs}ms)`);

  // Expected response type: e.g. "set_wifi_info" → looks for "set_wifi_info" in type field
  const expectedType = label;

  // Start listening BEFORE writing
  const responsePromise = waitForAnyResponse(expectedType, timeoutMs);
  await writeFrame(writeChar, payload);
  const response = await responsePromise;
  console.log(`[BLE] ${label} response:`, JSON.stringify(response));

  const resp = response as { message?: { result?: number } } | null;
  const ok = resp?.message?.result === 0 || resp?.message?.result === undefined;
  return { response, ok };
}

// ── Main provisioning function ───────────────────────────────────────────────

export async function provisionMower(
  mqttAddr: string,
  mqttPort: number,
  onStatus: (status: BleStatus) => void,
  scanAll = false,
  wifiSsid?: string,
  wifiPassword?: string,
): Promise<boolean> {
  let server: BluetoothRemoteGATTServer | null = null;
  const subscribedChars: BluetoothRemoteGATTCharacteristic[] = [];

  // Reset global state
  _pendingResponse = null;
  _responseBuffer = '';
  _collecting = false;

  try {
    // ── Step 1: Request device ─────────────────────────────────────
    onStatus({ phase: 'requesting', message: '' });

    let device: BluetoothDevice;
    if (scanAll) {
      device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: KNOWN_SERVICES,
      });
    } else {
      device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'Novabot' },
          { namePrefix: 'novabot' },
          { namePrefix: 'LFIN' },
          { namePrefix: 'CHARGER' },
          { namePrefix: 'charger' },
        ],
        optionalServices: KNOWN_SERVICES,
      });
    }

    if (!device?.gatt) {
      onStatus({ phase: 'error', message: 'No device selected', error: 'cancelled' });
      return false;
    }

    const deviceName = device.name ?? 'Unknown';
    console.log(`[BLE] Selected: "${deviceName}" (id: ${device.id})`);

    // ── Step 2: Connect ────────────────────────────────────────────
    onStatus({ phase: 'connecting', message: `Verbinden met ${deviceName}...`, deviceName });
    server = await device.gatt.connect();
    console.log('[BLE] Connected!');
    await sleep(500);

    // ── Step 3: Full GATT discovery ────────────────────────────────
    onStatus({ phase: 'discovering', message: 'BLE services ontdekken...', deviceName });

    // Discover ALL accessible services
    let allServices: BluetoothRemoteGATTService[] = [];
    try {
      allServices = await server.getPrimaryServices();
    } catch {
      // getPrimaryServices() without args may fail — try known UUIDs
      console.log('[BLE] getPrimaryServices() failed, trying known UUIDs individually...');
      for (const uuid of KNOWN_SERVICES) {
        try {
          const svc = await server.getPrimaryService(uuid);
          allServices.push(svc);
        } catch { /* not available */ }
      }
    }

    console.log(`[BLE] Found ${allServices.length} service(s):`);

    // Discover all characteristics and find write + notify chars
    let writeChar: BluetoothRemoteGATTCharacteristic | null = null;
    let deviceType: 'mower' | 'charger' = 'mower';

    for (const svc of allServices) {
      console.log(`[BLE]   Service: ${svc.uuid}`);
      let chars: BluetoothRemoteGATTCharacteristic[] = [];
      try {
        chars = await svc.getCharacteristics();
      } catch (e) {
        console.log(`[BLE]     (failed to get characteristics: ${e})`);
        continue;
      }

      for (const c of chars) {
        const props = c.properties;
        const propList: string[] = [];
        if (props.broadcast) propList.push('broadcast');
        if (props.read) propList.push('read');
        if (props.writeWithoutResponse) propList.push('writeWithoutResponse');
        if (props.write) propList.push('write');
        if (props.notify) propList.push('notify');
        if (props.indicate) propList.push('indicate');
        console.log(`[BLE]     Char: ${c.uuid} [${propList.join(', ')}]`);

        // Subscribe to ALL notify characteristics
        if (props.notify) {
          try {
            await c.startNotifications();
            c.addEventListener('characteristicvaluechanged', onAnyNotification);
            subscribedChars.push(c);
            console.log(`[BLE]     → Subscribed to notifications on ${c.uuid}`);
          } catch (e) {
            console.log(`[BLE]     → Failed to subscribe ${c.uuid}: ${e}`);
          }
        }

        // Pick the write characteristic
        if (!writeChar && (props.writeWithoutResponse || props.write)) {
          writeChar = c;
        }
      }

      // Detect device type from service UUID
      const svcId = svc.uuid.toLowerCase();
      if (svcId.includes('1234')) {
        deviceType = 'charger';
      }
    }

    if (!writeChar) {
      throw new Error('No writable BLE characteristic found on this device');
    }
    if (subscribedChars.length === 0) {
      throw new Error('No notify BLE characteristic found on this device');
    }

    console.log(`[BLE] Using write char: ${writeChar.uuid}, subscribed to ${subscribedChars.length} notify char(s), type: ${deviceType}`);
    await sleep(200);

    // ── Step 3.5: get_signal_info (handshake, 5s timeout) ──────────
    // The noble provisioner sends this first as an "ice breaker".
    // Firmware often doesn't respond when already connected to WiFi.
    try {
      console.log('[BLE] Sending get_signal_info (handshake)...');
      const { response } = await sendCommand(
        writeChar,
        JSON.stringify({ get_signal_info: 0 }),
        'get_signal_info',
        5000,
      );
      console.log('[BLE] get_signal_info OK:', JSON.stringify(response));
    } catch (err) {
      console.warn('[BLE] get_signal_info no response (non-fatal, continuing)');
    }
    await sleep(INTER_COMMAND_DELAY);

    // ── Step 4: set_wifi_info (non-fatal, 15s timeout) ───────────────
    // Firmware may not respond to this when already on WiFi.
    // We send it anyway as some firmware versions require it before set_mqtt_info.
    if (wifiSsid) {
      onStatus({ phase: 'wifi', message: `WiFi instellen (${wifiSsid})...`, deviceName });

      let wifiPayload: unknown;
      if (deviceType === 'mower') {
        wifiPayload = {
          set_wifi_info: {
            ap: { ssid: wifiSsid, passwd: wifiPassword ?? '', encrypt: 0 },
          },
        };
      } else {
        // Charger: "sta" = home WiFi, "ap" = charger's own AP
        wifiPayload = {
          set_wifi_info: {
            sta: { ssid: wifiSsid, passwd: wifiPassword ?? '', encrypt: 0 },
            ap: { ssid: 'CHARGER_PILE', passwd: '12345678', encrypt: 0 },
          },
        };
      }

      try {
        const { ok: wifiOk, response: wifiResp } = await sendCommand(
          writeChar, JSON.stringify(wifiPayload), 'set_wifi_info', 15000,
        );
        if (wifiOk) {
          console.log('[BLE] set_wifi_info OK');
        } else {
          console.warn('[BLE] set_wifi_info result non-zero (continuing):', JSON.stringify(wifiResp));
        }
      } catch (err) {
        // Non-fatal — firmware may not respond when already on WiFi
        console.warn('[BLE] set_wifi_info no response (non-fatal, continuing to mqtt)');
      }
    }
    await sleep(INTER_COMMAND_DELAY);

    // ── Step 5: set_mqtt_info ──────────────────────────────────────
    onStatus({
      phase: 'mqtt',
      message: `MQTT instellen op ${mqttAddr}:${mqttPort}...`,
      deviceName,
    });

    const mqttPayload = JSON.stringify({
      set_mqtt_info: { addr: mqttAddr, port: mqttPort },
    });

    try {
      const { ok: mqttOk, response: mqttResp } = await sendCommand(writeChar, mqttPayload, 'set_mqtt_info');

      if (!mqttOk) {
        // result:1 is common — firmware may still accept the change after set_cfg_info commit.
        // Don't abort; log warning and continue to commit step.
        console.warn('[BLE] set_mqtt_info returned non-zero result (continuing to commit):', JSON.stringify(mqttResp));
      }
    } catch (err) {
      console.warn('[BLE] set_mqtt_info no response (non-fatal, continuing to commit)');
    }
    await sleep(INTER_COMMAND_DELAY);

    // ── Step 6: set_cfg_info (commit) ──────────────────────────────
    onStatus({ phase: 'commit', message: 'Instellingen opslaan...', deviceName });

    const cfgPayload = deviceType === 'mower'
      ? JSON.stringify({ set_cfg_info: { cfg_value: 1 } })
      : JSON.stringify({ set_cfg_info: 1 });

    try {
      const { ok: cfgOk, response: cfgResp } = await sendCommand(writeChar, cfgPayload, 'set_cfg_info');

      if (!cfgOk) {
        onStatus({
          phase: 'error',
          message: 'set_cfg_info failed',
          deviceName,
          error: JSON.stringify(cfgResp),
        });
        return false;
      }
    } catch (err) {
      // set_cfg_info often causes BLE disconnect (device restarts networking).
      // Timeout or GATT disconnect here is actually SUCCESS.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('timeout') || msg.includes('disconnect') || msg.includes('GATT') || msg.includes('NetworkError')) {
        console.log('[BLE] set_cfg_info caused disconnect (expected — device restarting)');
      } else {
        throw err;
      }
    }

    // ── Done! ──────────────────────────────────────────────────────
    onStatus({
      phase: 'done',
      message: 'MQTT address updated! Device is reconnecting...',
      deviceName,
    });
    return true;

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[BLE] Error:', message);

    if (message.includes('User cancelled') || message.includes('cancelled')) {
      onStatus({ phase: 'idle', message: '' });
      return false;
    }

    if (message.includes('NotFoundError') || message.includes('not found')) {
      onStatus({ phase: 'error', message: 'Geen Novabot gevonden.', error: message });
      return false;
    }

    if (message.includes('SecurityError') || message.includes('permission')) {
      onStatus({ phase: 'error', message: 'Bluetooth-toegang geweigerd.', error: message });
      return false;
    }

    if (message.includes('No writable') || message.includes('No notify') || message.includes('No compatible')) {
      onStatus({ phase: 'error', message: 'Geen compatibele BLE-service gevonden. Check de console (F12) voor details.', error: message });
      return false;
    }

    onStatus({ phase: 'error', message: `BLE fout: ${message}`, error: message });
    return false;

  } finally {
    // Unsubscribe all
    for (const c of subscribedChars) {
      try {
        c.removeEventListener('characteristicvaluechanged', onAnyNotification);
        await c.stopNotifications();
      } catch { /* ignore */ }
    }
    // Disconnect
    if (server?.connected) {
      try { server.disconnect(); } catch { /* ignore */ }
    }
    // Clean up global state
    if (_pendingResponse) {
      clearTimeout(_pendingResponse.timeout);
      _pendingResponse = null;
    }
  }
}
