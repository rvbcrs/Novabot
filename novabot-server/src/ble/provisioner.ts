/**
 * BLE Provisioner for Novabot devices.
 *
 * provisionDevice() delegates to provision_noble_raw.mjs (noble, BlueZ D-Bus mode) via subprocess.
 * WiFi is disconnected before provisioning to reduce CYW43455 coexistence interference.
 * BlueZ must be running (not stopped).
 *
 * GATT structure (varies by device):
 *   Charger (ESP32-S3):  Service 0x1234, Char 0x2222 (cmd+notify)
 *   Mower (BCM43438):    Service 0x0201, Char 0x0011 (cmd) + 0x0021 (notify)
 */

import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { pushBleLog, pauseBackgroundScan, resumeBackgroundScan } from './bleLogger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = any;

const NOVABOT_COMPANY_ID = 0x5566;

export interface ProvisionParams {
  targetMac: string;
  wifiSsid: string;
  wifiPassword: string;
  mqttAddr?: string;
  mqttPort?: number;
  loraAddr?: number;
  loraChannel?: number;
  loraHc?: number;
  loraLc?: number;
  timezone?: string;
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getNobleRawScriptPath(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // dist/ble/ → src/ble/provision_noble_raw.mjs
  return path.join(process.cwd(), 'src', 'ble', 'provision_noble_raw.mjs');
}

function stopBluetooth(): void {
  try { execSync('systemctl stop bluetooth', { timeout: 5000, stdio: 'ignore' }); } catch { /* ignore */ }
}

function startBluetooth(): void {
  try { execSync('systemctl start bluetooth', { timeout: 5000, stdio: 'ignore' }); } catch { /* ignore */ }
  try { execSync('hciconfig hci0 up', { timeout: 3000, stdio: 'ignore' }); } catch { /* ignore */ }
}

/**
 * Disconnect WiFi (keep radio on) during BLE to reduce CYW43455 coexistence interference.
 * Uses nmcli device disconnect (NOT radio off) to avoid crashing the brcmfmac driver
 * which manages both WiFi and BT on the same CYW43455 chip.
 * RPi 5 uses Ethernet for server connectivity, so disconnecting WiFi doesn't break the server.
 */
function wifiOff(): void {
  console.log('[BLE-PROV] Disconnecting WiFi for BLE (radio stays on)...');
  try { execSync('nmcli device disconnect wlan0', { timeout: 10000, stdio: 'ignore' }); console.log('[BLE-PROV] WiFi disconnected'); } catch { console.log('[BLE-PROV] WiFi disconnect failed (non-fatal)'); }
}

function wifiOn(profile: string | undefined): void {
  if (!profile) return;
  try {
    execSync(`nmcli connection up "${profile}"`, { timeout: 20000, stdio: 'ignore' });
    console.log(`[BLE-PROV] WiFi reconnected (${profile})`);
  } catch {
    console.log(`[BLE-PROV] WiFi reconnect failed (non-fatal)`);
  }
}

/**
 * Run provision_noble_raw.mjs as a Node subprocess with NOBLE_BINDINGS=hci (raw HCI).
 * BlueZ is stopped before the subprocess starts and restarted after.
 */
async function runNobleRawProvisioner(params: ProvisionParams): Promise<ProvisionResult> {
  const scriptPath = getNobleRawScriptPath();
  const paramsJson = JSON.stringify(params);

  wifiOff();
  await sleep(1500);

  console.log(`[BLE-PROV] Running BlueZ provisioner: ${scriptPath}`);

  // Run btmon alongside noble to capture ALL HCI traffic at kernel level.
  // btmon uses HCI_MON socket (independent of noble's raw socket) — non-destructive tap.
  // This tells us: does the CYW43455 controller actually receive BLE notifications from the charger?
  // If btmon sees NTF packets → noble has a dispatch bug.
  // If btmon sees nothing → charger isn't sending / controller isn't receiving.
  const btmon = spawn('btmon', ['-i', 'hci0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let btmonLog = '';
  btmon.stdout.on('data', (d: Buffer) => { btmonLog += d.toString(); });
  btmon.stderr?.on('data', (d: Buffer) => { btmonLog += d.toString(); });

  return new Promise((resolve) => {
    const proc = spawn('node', [scriptPath, paramsJson], {
      env: { ...process.env },
      timeout: 240_000,
    });

    let stdout = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { console.log(d.toString().trimEnd()); });

    proc.on('close', (code) => {
      console.log(`[BLE-PROV] Noble raw process exited with code ${code}`);

      // Kill btmon and log relevant lines
      try { btmon.kill(); } catch { /* ignore */ }
      const btmonLines = btmonLog.split('\n').filter(l =>
        l.includes('Notify') || l.includes('NTF') || l.includes('Handle Value') ||
        l.includes('ATT') || l.includes('0x1b') || l.includes('notification')
      );
      if (btmonLines.length > 0) {
        console.log(`[BLE-PROV] btmon: ${btmonLines.length} ATT/notify lines (NOTIFICATIONS SEEN AT KERNEL LEVEL):`);
        btmonLines.slice(0, 30).forEach(l => console.log(`[btmon] ${l}`));
      } else {
        console.log(`[BLE-PROV] btmon: 0 notification lines seen — charger did NOT send notifications at HCI level`);
      }

      const out = stdout.trim();
      if (!out) {
        resolve({ success: false, steps: [], error: `Noble raw script no output (exit ${code})` });
        return;
      }
      try {
        resolve(JSON.parse(out) as ProvisionResult);
      } catch {
        resolve({ success: false, steps: [], error: `Invalid JSON: ${out.slice(0, 200)}` });
      }
    });

    proc.on('error', (err) => {
      try { btmon.kill(); } catch { /* ignore */ }
      resolve({ success: false, steps: [], error: `Failed to spawn noble raw: ${(err as Error).message}` });
    });
  });
}

/**
 * Provision a Novabot device via BLE.
 * Delegates to provision_noble_raw.mjs (noble, raw HCI) via subprocess.
 * BlueZ is stopped before provisioning and restarted after.
 */
export async function provisionDevice(params: ProvisionParams): Promise<ProvisionResult> {
  const devName = params.deviceType ?? 'device';
  pushBleLog({ ts: Date.now(), type: 'connect', deviceName: devName, mac: params.targetMac, rssi: 0, direction: '' });

  await pauseBackgroundScan();

  try {
    const result = await runNobleRawProvisioner(params);

    if (result.success) {
      console.log('[BLE-PROV] Provisioning successful!');
    } else {
      console.error('[BLE-PROV] Provisioning failed:', result.error);
    }

    pushBleLog({ ts: Date.now(), type: 'disconnect', deviceName: devName, mac: params.targetMac, rssi: 0, direction: '' });
    return result;

  } finally {
    console.log('[BLE-PROV] Restarting BlueZ...');
    startBluetooth();
    wifiOn(process.env.STA_WIFI_SSID);
    await sleep(1000);
    try { await Promise.race([resumeBackgroundScan(), sleep(5000)]); } catch { /* ignore */ }
  }
}

// ── Raw BLE diagnostic (noble-based, for dev use) ────────────────────────────

export async function bleRawDiagnostic(
  targetMac: string,
  opts: { charUuid?: string; data?: string; writeToAll?: boolean; durationMs?: number; framed?: boolean },
): Promise<{ services: unknown[]; notifications: unknown[]; writeResults: unknown[] }> {
  let noble: AnyObj = null;
  const notifications: { charUuid: string; hex: string; utf8: string; ts: number }[] = [];
  const writeResults: { charUuid: string; dataHex: string; ok: boolean; error?: string }[] = [];

  await pauseBackgroundScan();
  const targetMacNorm = targetMac.toLowerCase().replace(/:/g, '');

  try {
    const mod = await import('@stoprocent/noble');
    noble = mod.default;

    if (noble.state !== 'poweredOn') {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Bluetooth adapter timeout')), 5000);
        noble.on('stateChange', (state: string) => {
          if (state === 'poweredOn') { clearTimeout(t); resolve(); }
        });
      });
    }

    let peripheral: AnyObj = null;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { noble.stopScanning(); noble.removeAllListeners('discover'); reject(new Error('Not found')); }, 10_000);
      noble.on('discover', (p: AnyObj) => {
        const mfg = p.advertisement?.manufacturerData;
        const id = (p.id ?? p.uuid ?? '').toLowerCase().replace(/:/g, '');
        let matched = id === targetMacNorm;
        if (!matched && mfg && mfg.length >= 8 && mfg.readUInt16LE(0) === NOVABOT_COMPANY_ID) {
          const mac = Array.from(mfg.subarray(2, 8) as Uint8Array).map((b: number) => b.toString(16).padStart(2, '0')).join('');
          matched = mac === targetMacNorm;
        }
        if (matched) { clearTimeout(t); noble.stopScanning(); noble.removeAllListeners('discover'); peripheral = p; resolve(); }
      });
      noble.startScanning([], true);
    });

    if (!peripheral) throw new Error('Device not found');
    const devName = peripheral.advertisement?.localName ?? '?';
    await peripheral.connectAsync();
    pushBleLog({ ts: Date.now(), type: 'connect', deviceName: devName, mac: targetMac, rssi: peripheral.rssi ?? 0, direction: '' });
    await sleep(500);

    const result = await peripheral.discoverAllServicesAndCharacteristicsAsync();
    const services = result.services.map((s: AnyObj) => ({
      uuid: s.uuid,
      chars: result.characteristics
        .filter((c: AnyObj) => c._serviceUuid === s.uuid)
        .map((c: AnyObj) => ({ uuid: c.uuid, props: c.properties })),
    }));

    for (const c of result.characteristics as AnyObj[]) {
      if (c.properties.includes('notify')) {
        await c.subscribeAsync();
        c.on('data', (buf: Buffer) => {
          notifications.push({ charUuid: c.uuid, hex: buf.toString('hex'), utf8: buf.toString('utf8').replace(/[\x00-\x1f]/g, '.'), ts: Date.now() });
          pushBleLog({ ts: Date.now(), type: 'notify', deviceName: devName, mac: targetMac, rssi: 0, characteristic: c.uuid, data: buf.toString('hex'), direction: '\u2190DEV' });
        });
      }
    }

    await sleep(1500);

    if (opts.data) {
      const isHex = /^[0-9a-fA-F]+$/.test(opts.data) && opts.data.length % 2 === 0;
      const writeBuf = isHex ? Buffer.from(opts.data, 'hex') : Buffer.from(opts.data, 'utf8');
      const writeChars = opts.charUuid
        ? result.characteristics.filter((c: AnyObj) => c.uuid === opts.charUuid)
        : opts.writeToAll
        ? result.characteristics.filter((c: AnyObj) => c.properties.includes('writeWithoutResponse'))
        : [result.characteristics.find((c: AnyObj) => c.properties.includes('writeWithoutResponse'))].filter(Boolean);

      for (const c of writeChars as AnyObj[]) {
        if (!c) continue;
        try {
          await c.writeAsync(writeBuf, true);
          writeResults.push({ charUuid: c.uuid, dataHex: writeBuf.toString('hex'), ok: true });
        } catch (err) {
          writeResults.push({ charUuid: c.uuid, dataHex: writeBuf.toString('hex'), ok: false, error: (err as Error).message });
        }
      }
      await sleep(opts.durationMs ?? 3000);
    } else {
      await sleep(opts.durationMs ?? 3000);
    }

    for (const c of result.characteristics as AnyObj[]) {
      if (c.properties.includes('notify')) { try { await c.unsubscribeAsync(); } catch { /* ignore */ } }
    }

    try { await peripheral.disconnectAsync(); } catch { /* ignore */ }
    pushBleLog({ ts: Date.now(), type: 'disconnect', deviceName: devName, mac: targetMac, rssi: 0, direction: '' });

    return { services, notifications, writeResults };

  } finally {
    try { await Promise.race([resumeBackgroundScan(), sleep(5000)]); } catch { /* ignore */ }
  }
}
