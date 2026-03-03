#!/usr/bin/env node
/**
 * BLE MQTT Host Changer for Novabot Charger
 *
 * Changes the MQTT broker address stored in the charger's NVS via BLE,
 * without re-sending WiFi or LoRa configuration.
 *
 * USAGE:
 *   1. Run:  node research/ble_set_mqtt.js     (from project root)
 *   2. Script starts scanning for charger via BLE
 *   3. Unplug and replug the charger — it enters provisioning mode for ~10s after boot
 *   4. Script auto-connects and sends set_mqtt_info + set_cfg_info
 *   5. Charger saves new MQTT host to NVS and reconnects
 *
 * IMPORTANT: The charger only accepts BLE commands in provisioning mode (first ~10s
 * after boot, before WiFi connects). If the charger is already running, it will be
 * found via BLE scan but will NOT respond to commands. Power-cycle it!
 *
 * OPTIONS:
 *   --mqtt-host <host>   MQTT broker hostname (default: mqtt.lfibot.com)
 *   --mqtt-port <port>   MQTT broker port (default: 1883)
 *   --mac <MAC>          Target BLE MAC (default: 48:27:E2:1B:A4:0A = charger LFIC1230700004)
 *   --timeout <sec>      Scan timeout in seconds (default: 30)
 *   --full               Send full provisioning (WiFi + LoRa + MQTT + cfg)
 *   --wifi-ssid <ssid>   WiFi SSID (only with --full)
 *   --wifi-pass <pass>   WiFi password (only with --full)
 */

// Resolve noble from novabot-server/node_modules (script lives in research/)
const path = require('path');
const noble = require(path.resolve(__dirname, '../novabot-server/node_modules/@stoprocent/noble'));

// ── Parse CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}
const hasFlag = (name) => args.includes(name);

const MQTT_HOST = getArg('--mqtt-host') || 'mqtt.lfibot.com';
const MQTT_PORT = parseInt(getArg('--mqtt-port') || '1883', 10);
const TARGET_MAC = (getArg('--mac') || '48:27:E2:1B:A4:0A').toLowerCase().replace(/:/g, '');
const TIMEOUT_SEC = parseInt(getArg('--timeout') || '30', 10);
const FULL_PROVISION = hasFlag('--full');
const WIFI_SSID = getArg('--wifi-ssid');
const WIFI_PASS = getArg('--wifi-pass');

const CHUNK_SIZE = 20;
const INTER_CHUNK_DELAY = 30; // ms

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║  Novabot Charger — BLE MQTT Host Changer              ║');
console.log('╠════════════════════════════════════════════════════════╣');
console.log(`║  Target MAC:  ${TARGET_MAC.match(/.{2}/g).join(':').toUpperCase().padEnd(40)}║`);
console.log(`║  MQTT Host:   ${MQTT_HOST.padEnd(40)}║`);
console.log(`║  MQTT Port:   ${String(MQTT_PORT).padEnd(40)}║`);
console.log(`║  Mode:        ${(FULL_PROVISION ? 'Full provisioning' : 'MQTT only').padEnd(40)}║`);
console.log(`║  Scan timeout: ${String(TIMEOUT_SEC) + 's'.padEnd(39)}║`);
console.log('╚════════════════════════════════════════════════════════╝');
console.log();

if (FULL_PROVISION && (!WIFI_SSID || !WIFI_PASS)) {
  console.error('ERROR: --full requires --wifi-ssid and --wifi-pass');
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function writeFrame(char, jsonPayload) {
  const startMarker = Buffer.from('ble_start', 'utf8');
  const endMarker = Buffer.from('ble_end', 'utf8');
  const data = Buffer.from(jsonPayload, 'utf8');

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

function waitForResponse(char, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let collecting = false;
    const timeout = setTimeout(() => {
      char.removeAllListeners('data');
      reject(new Error(`Response timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    const onData = (data) => {
      const str = data.toString('utf8');
      if (str === 'ble_start') { collecting = true; buffer = ''; return; }
      if (str === 'ble_end' && collecting) {
        collecting = false;
        clearTimeout(timeout);
        char.removeListener('data', onData);
        try { resolve(JSON.parse(buffer)); }
        catch { resolve(buffer); }
        return;
      }
      if (collecting) buffer += str;
    };
    char.on('data', onData);
  });
}

async function sendBleCommand(writeChar, notifyChar, payload, label, timeoutMs = 10000) {
  console.log(`  → ${label}: ${payload}`);
  const responsePromise = waitForResponse(notifyChar, timeoutMs);
  await writeFrame(writeChar, payload);
  try {
    const response = await responsePromise;
    const resp = response;
    const ok = resp?.message?.result === 0 || resp?.message?.result === undefined;
    const statusStr = ok ? '✓ OK' : '✗ FAILED';
    console.log(`  ← ${label}: ${statusStr}  ${JSON.stringify(response)}`);
    return { response, ok };
  } catch (err) {
    console.log(`  ← ${label}: ✗ TIMEOUT (${timeoutMs}ms)`);
    return { response: null, ok: false };
  }
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  // Wait for Bluetooth adapter
  if (noble.state !== 'poweredOn') {
    console.log('Waiting for Bluetooth adapter...');
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Bluetooth adapter timeout')), 10000);
      noble.on('stateChange', (state) => {
        if (state === 'poweredOn') { clearTimeout(t); resolve(); }
      });
    });
  }
  console.log('Bluetooth adapter ready.\n');

  // ── Scan for target device ──────────────────────────────────
  console.log(`Scanning for charger (BLE MAC: ${TARGET_MAC.match(/.{2}/g).join(':').toUpperCase()})...`);
  console.log('⚡ Power-cycle the charger NOW if not already done.\n');

  let peripheral = null;

  await new Promise((resolve, reject) => {
    const scanTimeout = setTimeout(() => {
      noble.stopScanning();
      noble.removeAllListeners('discover');
      reject(new Error(`Charger not found after ${TIMEOUT_SEC}s — is it powered on and not yet connected to WiFi?`));
    }, TIMEOUT_SEC * 1000);

    noble.on('discover', (p) => {
      const name = p.advertisement?.localName ?? '';
      const mfgData = p.advertisement?.manufacturerData;
      if (!mfgData || mfgData.length < 8) return;
      if (mfgData.readUInt16LE(0) !== 0x5566) return;

      const mac = Array.from(mfgData.subarray(2, 8))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      if (mac === TARGET_MAC) {
        clearTimeout(scanTimeout);
        noble.stopScanning();
        noble.removeAllListeners('discover');
        console.log(`Found! ${name} (RSSI: ${p.rssi} dBm)\n`);
        peripheral = p;
        resolve();
      } else {
        // Log other Novabot devices
        console.log(`  [skip] ${name || '?'} MAC=${mac.match(/.{2}/g).join(':')} RSSI=${p.rssi}`);
      }
    });

    noble.startScanning([], true);
  });

  if (!peripheral) {
    console.error('Device not found');
    process.exit(1);
  }

  // ── Connect ─────────────────────────────────────────────────
  console.log('Connecting via BLE...');
  await peripheral.connectAsync();
  console.log('Connected!\n');

  try {
    // ── Discover GATT services ──────────────────────────────
    console.log('Discovering GATT services...');
    const result = await peripheral.discoverAllServicesAndCharacteristicsAsync();
    console.log(`  Services: ${result.services.map(s => s.uuid).join(', ')}`);
    console.log(`  Characteristics: ${result.characteristics.map(c => `${c.uuid}(${c.properties.join('+')})`).join(', ')}`);

    // Find command characteristic (0x2222 for charger)
    const writeChar = result.characteristics.find(c => c.uuid === '2222');
    const notifyChar = writeChar; // Same char for charger

    if (!writeChar) {
      throw new Error(`Characteristic 0x2222 not found. Available: ${result.characteristics.map(c => c.uuid).join(', ')}`);
    }

    // Subscribe to notifications
    for (const c of result.characteristics.filter(c => c.properties.includes('notify'))) {
      await c.subscribeAsync();
      c.on('data', () => {
        // Raw tap — responses handled by waitForResponse
      });
    }
    await sleep(200);

    console.log('\nSending BLE commands:\n');

    if (FULL_PROVISION) {
      // ── Full provisioning: signal + wifi + lora + mqtt + cfg ──

      // get_signal_info
      await sendBleCommand(writeChar, notifyChar,
        JSON.stringify({ get_signal_info: 0 }),
        'get_signal_info');

      // set_wifi_info (charger format: sta + ap)
      await sendBleCommand(writeChar, notifyChar,
        JSON.stringify({
          set_wifi_info: {
            sta: { ssid: WIFI_SSID, passwd: WIFI_PASS, encrypt: 0 },
            ap: { ssid: 'CHARGER', passwd: '12345678', encrypt: 0 },
          },
        }),
        'set_wifi_info');

      // set_lora_info
      const { response: loraResp } = await sendBleCommand(writeChar, notifyChar,
        JSON.stringify({ set_lora_info: { addr: 718, channel: 16, hc: 20, lc: 14 } }),
        'set_lora_info');
      if (loraResp?.message?.value != null) {
        console.log(`  LoRa assigned channel: ${loraResp.message.value}`);
      }

      // set_mqtt_info
      await sendBleCommand(writeChar, notifyChar,
        JSON.stringify({ set_mqtt_info: { addr: MQTT_HOST, port: MQTT_PORT } }),
        'set_mqtt_info');

      // set_rtk_info
      await sendBleCommand(writeChar, notifyChar,
        JSON.stringify({ set_rtk_info: 0 }),
        'set_rtk_info');

      // set_cfg_info (commit)
      await sendBleCommand(writeChar, notifyChar,
        JSON.stringify({ set_cfg_info: 1 }),
        'set_cfg_info');

    } else {
      // ── MQTT-only: just set_mqtt_info + set_cfg_info ──────

      // Quick connectivity check (3s timeout — this is optional)
      const { ok: signalOk } = await sendBleCommand(writeChar, notifyChar,
        JSON.stringify({ get_signal_info: 0 }),
        'get_signal_info', 3000);

      if (!signalOk) {
        console.warn('\n⚠ get_signal_info got no response — charger may be in operational mode.');
        console.warn('  Will still try set_mqtt_info (charger may accept writes without responding to reads).\n');
      }

      // set_mqtt_info (10s timeout — this is the critical command)
      const { ok: mqttOk } = await sendBleCommand(writeChar, notifyChar,
        JSON.stringify({ set_mqtt_info: { addr: MQTT_HOST, port: MQTT_PORT } }),
        'set_mqtt_info', 10000);

      if (!mqttOk) {
        console.error('\n✗ set_mqtt_info failed — charger is likely in operational mode.');
        console.error('  To fix: unplug charger, run this script, then plug charger back in.');
        console.error('  The charger accepts BLE only in the first ~10s after boot (before WiFi connects).\n');
        throw new Error('set_mqtt_info failed — MQTT host NOT changed');
      }

      // set_cfg_info (commit to NVS)
      const { ok: cfgOk } = await sendBleCommand(writeChar, notifyChar,
        JSON.stringify({ set_cfg_info: 1 }),
        'set_cfg_info', 10000);

      if (!cfgOk) {
        throw new Error('set_cfg_info failed — config NOT committed, MQTT host may not be saved');
      }
    }

    // Unsubscribe
    for (const c of result.characteristics.filter(c => c.properties.includes('notify'))) {
      try { await c.unsubscribeAsync(); } catch {}
    }

    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║  ✓ SUCCESS — MQTT host updated!                       ║');
    console.log(`║  Charger will now connect to:                          ║`);
    console.log(`║    ${(MQTT_HOST + ':' + MQTT_PORT).padEnd(52)}║`);
    console.log('║                                                        ║');
    console.log('║  The charger should reconnect to WiFi + MQTT shortly.  ║');
    console.log('╚════════════════════════════════════════════════════════╝');

  } finally {
    try {
      await peripheral.disconnectAsync();
      console.log('\nBLE disconnected.');
    } catch {}
  }
}

main().catch(err => {
  console.error('\n✗ ERROR:', err.message);
  process.exit(1);
});
