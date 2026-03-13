/**
 * BLE diagnostic module for Novabot devices using @stoprocent/noble.
 *
 * Extended from bootstrap/src/ble.ts with:
 *   - Persistent connections (don't disconnect after each command)
 *   - Diagnostic get_* commands (get_signal_info, get_lora_info, get_dev_info, etc.)
 *   - Multi-device connection support
 *
 * Protocol:
 *   Frame: ble_start → 20-byte JSON chunks (30ms delay) → ble_end
 *
 * Device GATT layouts:
 *   Mower:   Service 0x0201, Write 0x0011, Notify 0x0021
 *   Charger: Service 0x1234, Write 0x2222, Notify 0x2222
 */

type Noble = typeof import('@stoprocent/noble');
type Peripheral = import('@stoprocent/noble').Peripheral;
type Characteristic = import('@stoprocent/noble').Characteristic;

const GATT_LAYOUTS = {
  charger: { service: '1234', writeChar: '2222', notifyChar: '2222' },
  mower:   { service: '0201', writeChar: '0011', notifyChar: '0021' },
} as const;

const CHUNK_SIZE = 20;
const INTER_CHUNK_DELAY = 30;
const RESPONSE_TIMEOUT = 10_000;
const NOVABOT_COMPANY_ID = 0x5566;

// Noble is imported as a namespace (not default export)
// eslint-disable-next-line @typescript-eslint/no-var-requires
let noble: Noble | null = null;
let _scanning = false;

// ── Connected device registry ───────────────────────────────────────────────

export interface ConnectedDevice {
  mac: string;
  name: string;
  type: 'charger' | 'mower' | 'unknown';
  peripheral: Peripheral;
  writeChar: Characteristic;
  allNotifyChars: Characteristic[];
}

const connectedDevices = new Map<string, ConnectedDevice>();

// Per-device command mutex — only one BLE command at a time per device.
// The charger is very slow (~10s per response) and concurrent commands
// cause response-matching chaos.
const deviceLocks = new Map<string, Promise<unknown>>();

async function withDeviceLock<T>(mac: string, fn: () => Promise<T>): Promise<T> {
  const key = normalizeMac(mac);
  const prev = deviceLocks.get(key) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>(r => { resolve = r; });
  deviceLocks.set(key, next);
  await prev;
  try {
    return await fn();
  } finally {
    resolve!();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getNoble(): Promise<Noble> {
  if (noble) return noble;
  // Dynamic import — noble has native bindings, may fail if BT not available
  // In CJS mode, import() wraps the module as { default: <module> }
  const mod = await import('@stoprocent/noble');
  noble = ((mod as { default?: Noble }).default ?? mod) as Noble;
  return noble;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeMac(mac: string): string {
  return mac.toLowerCase().replace(/:/g, '');
}

// ── Public API ──────────────────────────────────────────────────────────────

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

export interface DiagnosticResult {
  command: string;
  ok: boolean;
  response: unknown;
  error?: string;
}

/**
 * Check if native Bluetooth is available and powered on.
 */
export async function getBleStatus(): Promise<BleStatusResult> {
  try {
    const n = await getNoble();
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
 * Scan for Novabot BLE devices. Emits events via callback.
 */
export async function scanDevices(
  onDevice: (device: ScannedDevice) => void,
  onDone: (count: number) => void,
  durationMs = 15000,
): Promise<void> {
  if (_scanning) {
    console.log('[BLE] Scan already in progress');
    return;
  }

  const n = await getNoble();

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
  const peripheralMap = new Map<string, Peripheral>();

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

    let type: 'charger' | 'mower' | 'unknown' = 'unknown';
    const nameLower = name.toLowerCase();
    if (nameLower.includes('charger') || nameLower.includes('lfic')) {
      type = 'charger';
    } else if (nameLower.includes('novabot') || nameLower.includes('lfin')) {
      type = 'mower';
    }

    // Cache peripheral IMMEDIATELY so connect works while scan is still running
    _peripheralCache.set(normalizeMac(mac), peripheral);

    if (!seen.has(mac)) {
      seen.add(mac);
      console.log(`[BLE] Found: ${name} (${mac}) RSSI=${rssi} type=${type}`);
    }

    onDevice({ mac, name, rssi, type });
  };

  n.on('discover', onDiscover);

  console.log(`[BLE] Starting scan (${durationMs}ms)...`);
  await n.startScanningAsync([], true);

  setTimeout(async () => {
    if (!_scanning) return;
    _scanning = false;
    n.removeListener('discover', onDiscover);
    try { await n.stopScanningAsync(); } catch { /* ignore */ }
    console.log(`[BLE] Scan complete, found ${seen.size} device(s)`);
    onDone(seen.size);
  }, durationMs);
}

// Cache peripherals from scan for later connect
const _peripheralCache = new Map<string, Peripheral>();

/**
 * Stop an active BLE scan.
 */
export async function stopScan(): Promise<void> {
  if (!_scanning || !noble) return;
  _scanning = false;
  noble.removeAllListeners('discover');
  try { await noble.stopScanningAsync(); } catch { /* ignore */ }
  // Give noble time to fully stop before starting new operations
  await sleep(500);
  console.log('[BLE] Scan stopped');
}

/**
 * Connect to a Novabot device and keep the connection open.
 */
export async function connectDevice(mac: string): Promise<ConnectedDevice> {
  const macNorm = normalizeMac(mac);

  // Already connected?
  const existing = connectedDevices.get(macNorm);
  if (existing) return existing;

  // Stop any active scan first
  if (_scanning) await stopScan();

  const n = await getNoble();
  let peripheral = _peripheralCache.get(macNorm);
  console.log(`[BLE] Cache has ${_peripheralCache.size} peripheral(s), looking for ${macNorm}: ${peripheral ? 'found' : 'not found'}`);

  // If not in cache, do a short scan to find it
  if (!peripheral) {
    console.log(`[BLE] Device ${mac} not in cache, scanning...`);
    await new Promise<void>((resolve, reject) => {
      const scanTimeout = setTimeout(() => {
        n.stopScanning();
        n.removeAllListeners('discover');
        reject(new Error(`Device ${mac} not found after 15s scan`));
      }, 15_000);

      n.on('discover', (p: Peripheral) => {
        const mfgData = p.advertisement?.manufacturerData;
        if (!mfgData || mfgData.length < 8) return;
        if (mfgData.readUInt16LE(0) !== NOVABOT_COMPANY_ID) return;

        const foundMac = Array.from(mfgData.subarray(2, 8))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');

        if (foundMac === macNorm) {
          clearTimeout(scanTimeout);
          n.stopScanning();
          n.removeAllListeners('discover');
          peripheral = p;
          resolve();
        }
      });

      n.startScanning([], true);
    });
  }

  if (!peripheral) throw new Error(`Device ${mac} not found`);

  // Connect
  const devName = peripheral.advertisement?.localName ?? '?';
  console.log(`[BLE] Connecting to ${devName} (${mac})...`);
  await peripheral.connectAsync();
  console.log('[BLE] Connected!');
  await sleep(500);

  // Determine device type
  let type: 'charger' | 'mower' | 'unknown' = 'unknown';
  const nameLower = devName.toLowerCase();
  if (nameLower.includes('charger') || nameLower.includes('lfic')) {
    type = 'charger';
  } else if (nameLower.includes('novabot') || nameLower.includes('lfin')) {
    type = 'mower';
  }

  // Discover services
  const result = await peripheral.discoverAllServicesAndCharacteristicsAsync();
  console.log(`[BLE] Found ${result.services.length} service(s), ${result.characteristics.length} char(s)`);
  for (const s of result.services) {
    console.log(`[BLE]   Service: ${s.uuid}`);
  }
  for (const c of result.characteristics) {
    console.log(`[BLE]   Char: ${c.uuid} props=${JSON.stringify(c.properties)}`);
  }

  // Find the right layout
  const layoutKey = type === 'charger' ? 'charger' : 'mower';
  const layout = GATT_LAYOUTS[layoutKey];

  const writeChar = result.characteristics.find(c => c.uuid === layout.writeChar);
  if (!writeChar) {
    const avail = result.characteristics.map(c => `${c.uuid}(${c.properties.join('+')})`).join(', ');
    await peripheral.disconnectAsync();
    throw new Error(`Write char ${layout.writeChar} not found. Available: ${avail}`);
  }

  // Subscribe to ALL notify characteristics
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

  // Handle disconnect
  peripheral.on('disconnect', () => {
    console.log(`[BLE] Device ${mac} disconnected`);
    connectedDevices.delete(macNorm);
  });

  const device: ConnectedDevice = {
    mac: mac.toUpperCase(),
    name: devName,
    type,
    peripheral,
    writeChar,
    allNotifyChars,
  };

  connectedDevices.set(macNorm, device);
  return device;
}

/**
 * Disconnect a connected device.
 */
export async function disconnectDevice(mac: string): Promise<void> {
  const macNorm = normalizeMac(mac);
  const device = connectedDevices.get(macNorm);
  if (!device) return;

  try {
    await device.peripheral.disconnectAsync();
    console.log(`[BLE] Disconnected ${mac}`);
  } catch { /* ignore */ }

  connectedDevices.delete(macNorm);
}

/**
 * Get a connected device.
 */
export function getConnectedDevice(mac: string): ConnectedDevice | undefined {
  return connectedDevices.get(normalizeMac(mac));
}

/**
 * Get all connected devices.
 */
export function getConnectedDevices(): ConnectedDevice[] {
  return Array.from(connectedDevices.values());
}

// ── Diagnostic Commands ─────────────────────────────────────────────────────

/**
 * Send a BLE command to a connected device and return the response.
 */
/**
 * Internal: send BLE command without acquiring the device mutex.
 * Used by readAllDiagnostics which holds the mutex for the entire session.
 */
async function sendDiagnosticCommandInternal(
  mac: string,
  command: string,
  payload: unknown,
  timeoutMs = RESPONSE_TIMEOUT,
): Promise<DiagnosticResult> {
  const device = connectedDevices.get(normalizeMac(mac));
  if (!device) {
    return { command, ok: false, response: null, error: 'Device not connected' };
  }

  try {
    const json = JSON.stringify({ [command]: payload });
    const { response, ok } = await sendCommandInternal(
      device.writeChar,
      device.allNotifyChars,
      json,
      command,
      timeoutMs,
    );
    return { command, ok, response };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { command, ok: false, response: null, error: msg };
  }
}

/**
 * Send a BLE command to a connected device and return the response.
 * Acquires a per-device mutex to prevent concurrent BLE commands.
 */
export async function sendDiagnosticCommand(
  mac: string,
  command: string,
  payload: unknown,
  timeoutMs = RESPONSE_TIMEOUT,
): Promise<DiagnosticResult> {
  return withDeviceLock(mac, () =>
    sendDiagnosticCommandInternal(mac, command, payload, timeoutMs),
  );
}

/**
 * Read signal info (WiFi RSSI + GPS/RTK status) — works on charger.
 */
export async function readSignalInfo(mac: string): Promise<DiagnosticResult> {
  return sendDiagnosticCommand(mac, 'get_signal_info', 0, 8000);
}

/**
 * Read LoRa info (address, channel, HC, LC) — works on charger.
 */
export async function readLoraInfo(mac: string): Promise<DiagnosticResult> {
  return sendDiagnosticCommand(mac, 'get_lora_info', 0, 8000);
}

/**
 * Read device info (SN, firmware version, hardware version) — works on charger.
 */
export async function readDevInfo(mac: string): Promise<DiagnosticResult> {
  return sendDiagnosticCommand(mac, 'get_dev_info', 0, 8000);
}

/**
 * Read config info (committed = 1, not committed = 0) — works on charger.
 */
export async function readCfgInfo(mac: string): Promise<DiagnosticResult> {
  return sendDiagnosticCommand(mac, 'get_cfg_info', 0, 8000);
}

/**
 * Read WiFi RSSI — works on charger.
 */
export async function readWifiRssi(mac: string): Promise<DiagnosticResult> {
  return sendDiagnosticCommand(mac, 'get_wifi_rssi', 0, 8000);
}

/**
 * Read ALL diagnostics from a connected device.
 *
 * Charger (ESP32-S3): Only supports get_signal_info via BLE.
 * Other get_* commands are silently ignored by the charger firmware.
 * LoRa and device info must be queried via MQTT instead.
 *
 * Mower: supports all get_* commands.
 */
export async function readAllDiagnostics(mac: string): Promise<DiagnosticResult[]> {
  const device = connectedDevices.get(normalizeMac(mac));
  const isCharger = device?.type === 'charger' || device?.type === 'unknown';

  if (isCharger) {
    // Charger only responds to get_signal_info via BLE.
    // Send it directly — no point querying commands the charger ignores.
    const result = await sendDiagnosticCommand(mac, 'get_signal_info', 0, 15000);
    return [result];
  }

  // Mower: query all diagnostics sequentially
  const results: DiagnosticResult[] = [];
  const commands: Array<{ cmd: string; timeout: number }> = [
    { cmd: 'get_signal_info', timeout: 8000 },
    { cmd: 'get_dev_info', timeout: 8000 },
    { cmd: 'get_lora_info', timeout: 8000 },
    { cmd: 'get_cfg_info', timeout: 8000 },
    { cmd: 'get_wifi_rssi', timeout: 8000 },
  ];

  for (const { cmd, timeout } of commands) {
    results.push(await sendDiagnosticCommand(mac, cmd, 0, timeout));
    await sleep(500);
  }

  return results;
}

// ── Provisioning Commands ───────────────────────────────────────────────────

export interface ProvisionWifiParams {
  ssid: string;
  password: string;
  deviceType: 'mower' | 'charger';
}

export interface ProvisionLoraParams {
  addr: number;
  channel: number;
  hc?: number;
  lc?: number;
}

export interface ProvisionMqttParams {
  addr: string;
  port: number;
}

export async function setWifi(mac: string, params: ProvisionWifiParams): Promise<DiagnosticResult> {
  let payload: unknown;
  if (params.deviceType === 'mower') {
    payload = { ap: { ssid: params.ssid, passwd: params.password, encrypt: 0 } };
  } else {
    payload = {
      sta: { ssid: params.ssid, passwd: params.password, encrypt: 0 },
      ap: { ssid: 'CHARGER_PILE', passwd: '12345678', encrypt: 0 },
    };
  }
  return sendDiagnosticCommand(mac, 'set_wifi_info', payload, 15000);
}

export async function setLora(mac: string, params: ProvisionLoraParams): Promise<DiagnosticResult> {
  return sendDiagnosticCommand(mac, 'set_lora_info', {
    addr: params.addr,
    channel: params.channel,
    hc: params.hc ?? 20,
    lc: params.lc ?? 14,
  }, 15000);
}

export async function setMqtt(mac: string, params: ProvisionMqttParams): Promise<DiagnosticResult> {
  return sendDiagnosticCommand(mac, 'set_mqtt_info', {
    addr: params.addr,
    port: params.port,
  }, 15000);
}

export async function commitConfig(mac: string, deviceType: 'mower' | 'charger'): Promise<DiagnosticResult> {
  const payload = deviceType === 'mower'
    ? { cfg_value: 1, tz: 'Europe/Amsterdam' }
    : 1;
  return sendDiagnosticCommand(mac, 'set_cfg_info', payload, 15000);
}

// ── BLE Frame Protocol ──────────────────────────────────────────────────────

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

        const respType = (parsed as { type?: string })?.type ?? '';
        if (respType && !respType.includes(expectedType)) {
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

async function sendCommandInternal(
  writeChar: Characteristic,
  allNotifyChars: Characteristic[],
  payload: string,
  label: string,
  timeoutMs = RESPONSE_TIMEOUT,
): Promise<{ response: unknown; ok: boolean }> {
  console.log(`[BLE] → ${label}: ${payload}`);

  const responsePromise = waitForResponse(allNotifyChars, label, timeoutMs);
  await writeFrame(writeChar, payload);
  const response = await responsePromise;
  console.log(`[BLE] ← ${label}:`, JSON.stringify(response));

  const resp = response as { message?: { result?: number } } | null;
  // Novabot BLE: result:0 = success, result:1 = acknowledged/applied (NOT an error!)
  const result = resp?.message?.result;
  const ok = result === 0 || result === 1 || result === undefined;
  return { response, ok };
}
