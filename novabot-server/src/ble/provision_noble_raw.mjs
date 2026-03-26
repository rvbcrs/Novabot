#!/usr/bin/env node
/**
 * Noble-based BLE provisioner using BlueZ D-Bus (default noble on Linux).
 *
 * BlueZ must be running. WiFi must be disconnected first to reduce
 * CYW43455 coexistence interference (handled by provisioner.ts).
 *
 * Usage: node provision_noble_raw.mjs '<json_params>'
 * Output: JSON result on stdout, logs on stderr
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const CHUNK_SIZE = 20;
const INTER_CHUNK_DELAY = 100;
const RESPONSE_TIMEOUT = 10_000;
const NOVABOT_COMPANY_ID = 0x5566;

const GATT_LAYOUTS = {
  charger: { service: '1234', writeChar: '2222', notifyChar: '2222' },
  mower:   { service: '0201', writeChar: '0011', notifyChar: '0021' },
};

function log(msg) { process.stderr.write(`[BLE-PROV] ${msg}\n`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function writeFrame(char, payload) {
  await char.writeAsync(Buffer.from('ble_start', 'utf8'), true);
  await sleep(INTER_CHUNK_DELAY);
  const data = Buffer.from(payload, 'utf8');
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    await char.writeAsync(data.subarray(i, i + CHUNK_SIZE), true);
    await sleep(INTER_CHUNK_DELAY);
  }
  await char.writeAsync(Buffer.from('ble_end', 'utf8'), true);
  await sleep(INTER_CHUNK_DELAY);
}

function waitForResponse(chars, expectedType, timeoutMs = RESPONSE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let buffer = '', collecting = false;
    const cleanup = () => { for (const c of chars) c.removeListener('data', onData); };
    const t = setTimeout(() => { cleanup(); reject(new Error(`BLE timeout after ${timeoutMs}ms`)); }, timeoutMs);
    const onData = (data) => {
      const s = data.toString('utf8').replace(/\0/g, '');
      if (s === 'ble_start') { collecting = true; buffer = ''; return; }
      if (s === 'ble_end' && collecting) {
        collecting = false;
        let parsed;
        try { parsed = JSON.parse(buffer); } catch { parsed = buffer; }
        const respType = parsed?.type ?? '';
        if (respType && !respType.includes(expectedType)) {
          log(`Draining stale: ${respType}`);
          return;
        }
        clearTimeout(t); cleanup(); resolve(parsed);
        return;
      }
      if (collecting) buffer += s;
    };
    for (const c of chars) c.on('data', onData);
  });
}

async function sendCommand(writeChar, notifyChars, payload, label, timeoutMs = RESPONSE_TIMEOUT) {
  log(`→ ${label}: ${payload}`);
  const resp = waitForResponse(notifyChars, label, timeoutMs);
  try {
    await writeFrame(writeChar, payload);
  } catch (err) {
    resp.catch(() => {}); // suppress unhandled rejection from orphaned promise
    throw err;
  }
  const response = await resp;
  log(`← ${label}: ${JSON.stringify(response)}`);
  const ok = response?.message?.result === 0 || response?.message?.result == null;
  return { response, ok };
}

async function main() {
  const params = JSON.parse(process.argv[2] || '{}');
  const {
    targetMac, wifiSsid, wifiPassword,
    mqttAddr = 'mqtt.lfibot.com', mqttPort = 1883,
    loraAddr = 718, loraChannel = 15, loraHc = 20, loraLc = 14,
    timezone = 'Europe/Amsterdam', deviceType = 'mower',
  } = params;

  const steps = [];

  // Load noble — BlueZ D-Bus mode (default on Linux)
  const noblePath = path.join(__dirname, '..', '..', 'node_modules', '@stoprocent', 'noble', 'index.js');
  const noble = require(noblePath);

  // Wait for adapter
  if (noble.state !== 'poweredOn') {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('BT adapter timeout')), 8000);
      noble.on('stateChange', s => {
        if (s === 'poweredOn') { clearTimeout(t); noble.removeAllListeners('stateChange'); resolve(); }
      });
    });
  }

  log(`Scanning for ${targetMac} (BlueZ D-Bus)...`);
  const targetNorm = targetMac.toLowerCase().replace(/:/g, '');
  let peripheral = null;

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { noble.removeListener('discover', onDiscover); reject(new Error(`Device ${targetMac} not found after 30s`)); }, 30_000);
    const onDiscover = (p) => {
      const id = (p.id ?? p.uuid ?? '').toLowerCase().replace(/:/g, '');
      let matched = id === targetNorm;
      if (!matched) {
        const mfg = p.advertisement?.manufacturerData;
        if (mfg && mfg.length >= 8 && mfg.readUInt16LE(0) === NOVABOT_COMPANY_ID) {
          const mac = Array.from(mfg.subarray(2, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
          matched = mac === targetNorm;
        }
      }
      if (!matched) return;
      clearTimeout(t); noble.removeListener('discover', onDiscover);
      peripheral = p; resolve();
    };
    noble.on('discover', onDiscover);
    noble.startScanning([], true);
  });

  noble.stopScanning();
  await sleep(500);

  log('Connecting...');
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`Connect attempt ${attempt}...`);
    try {
      await peripheral.connectAsync();
      log('Connected!');
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err.message ?? String(err);
      log(`Connect failed: ${lastErr}`);
      if (attempt < 3) { try { await peripheral.disconnectAsync(); } catch {} await sleep(3000); }
    }
  }
  if (lastErr) throw new Error(`Connect failed after 3 attempts: ${lastErr}`);

  peripheral.on('disconnect', (reason) => log(`DISCONNECT event: reason=${reason}`));

  await sleep(1000); // Allow connection to stabilize before GATT discovery

  const layout = GATT_LAYOUTS[deviceType];
  const result = await peripheral.discoverAllServicesAndCharacteristicsAsync();
  log(`Services: ${result.services.map(s => s.uuid).join(', ')}`);
  log(`Chars: ${result.characteristics.map(c => `${c.uuid}[${c.properties.join('+')}]`).join(', ')}`);

  const writeChar = result.characteristics.find(c => c.uuid === layout.writeChar);
  const notifyChar = result.characteristics.find(c => c.uuid === layout.notifyChar);
  if (!writeChar || !notifyChar) {
    throw new Error(`GATT chars not found. Available: ${result.characteristics.map(c => c.uuid).join(',')}`);
  }

  const notifyChars = [...new Set([writeChar, notifyChar])];
  for (const c of notifyChars) {
    await c.subscribeAsync();
    c.on('data', d => log(`RAW notify ${c.uuid}: ${d.toString('hex')} "${d.toString('utf8').replace(/\0/g, '')}"`));
    log(`Subscribed to ${c.uuid} (props: ${c.properties.join('+')})`);
  }
  await sleep(1000);

  // Commands
  const cmds = [
    { cmd: 'get_signal_info', payload: { get_signal_info: 0 }, timeout: 5000, fatal: false },
    { cmd: 'set_wifi_info', payload: deviceType === 'mower'
        ? { set_wifi_info: { ap: { ssid: wifiSsid, passwd: wifiPassword, encrypt: 0 } } }
        : { set_wifi_info: { sta: { ssid: wifiSsid, passwd: wifiPassword, encrypt: 0 }, ap: { ssid: 'CHARGER_PILE', passwd: '12345678', encrypt: 0 } } },
      timeout: 15000, fatal: false },
    { cmd: 'set_lora_info', payload: { set_lora_info: { addr: loraAddr, channel: loraChannel, hc: loraHc, lc: loraLc } }, timeout: 15000, fatal: false },
    { cmd: 'set_mqtt_info', payload: { set_mqtt_info: { addr: mqttAddr, port: mqttPort } }, timeout: 15000, fatal: false },
    { cmd: 'set_cfg_info', payload: deviceType === 'mower' ? { set_cfg_info: { cfg_value: 1, tz: timezone } } : { set_cfg_info: 1 }, timeout: 15000, fatal: false },
  ];

  for (const { cmd, payload, timeout, fatal } of cmds) {
    await sleep(1000);
    try {
      const r = await sendCommand(writeChar, notifyChars, JSON.stringify(payload), cmd, timeout);
      steps.push({ command: cmd, sent: payload, ...r });
    } catch (err) {
      const msg = err.message ?? String(err);
      if (cmd === 'set_cfg_info' && (msg.includes('timeout') || msg.includes('isconnect') || msg.includes('not connected'))) {
        log('set_cfg_info disconnect (expected — device restarting)');
        steps.push({ command: cmd, sent: payload, response: null, ok: true });
      } else if (!fatal) {
        log(`${cmd} no response (non-fatal): ${msg}`);
        steps.push({ command: cmd, sent: payload, response: null, ok: false });
      } else {
        throw err;
      }
    }
  }

  await Promise.race([
    (async () => {
      try {
        for (const c of notifyChars) await Promise.race([c.unsubscribeAsync().catch(() => {}), sleep(1000)]);
        await Promise.race([peripheral.disconnectAsync(), sleep(3000)]);
      } catch {}
    })(),
    sleep(6000),
  ]);

  return { success: true, steps };
}

main().then(result => {
  console.log(JSON.stringify(result));
  process.exit(0);
}).catch(err => {
  console.log(JSON.stringify({ success: false, steps: [], error: err.message ?? String(err) }));
  process.exit(1);
});
