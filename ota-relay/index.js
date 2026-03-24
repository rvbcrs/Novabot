#!/usr/bin/env node
/**
 * OpenNova OTA Relay Service
 *
 * Public MQTT broker that accepts Novabot mower connections and pushes
 * custom firmware via OTA. After flashing, the mower uses mDNS to find
 * the user's local server — no DNS rewrites needed.
 *
 * Flow:
 *   1. User does BLE provisioning with mqtt addr = this relay's hostname
 *   2. Mower connects to this MQTT broker
 *   3. Relay sends OTA upgrade command
 *   4. Mower downloads firmware .deb from this server's HTTP endpoint
 *   5. Mower installs, reboots with custom firmware
 *   6. Custom firmware uses mDNS → connects to user's local server
 *   7. Relay is no longer needed
 *
 * Usage:
 *   node index.js [--port 4000] [--firmware-dir ./firmware]
 *
 * Env vars:
 *   RELAY_PORT       — HTTP + MQTT port (default: 4000)
 *   FIRMWARE_DIR     — directory containing .deb firmware files
 *   PUBLIC_HOST      — public hostname for firmware download URLs
 *   MQTT_PORT        — MQTT port (default: 1883)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Config ───────────────────────────────────────────────────────────────────

const HTTP_PORT = parseInt(process.env.RELAY_PORT || '4000', 10);
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883', 10);
const FIRMWARE_DIR = process.env.FIRMWARE_DIR || path.join(__dirname, 'firmware');
const PUBLIC_HOST = process.env.PUBLIC_HOST || `localhost:${HTTP_PORT}`;

// AES encryption for MQTT messages to LFI devices
const AES_IV = Buffer.from('abcd1234abcd1234', 'utf8');
function aesKey(sn) {
  return Buffer.from('abcdabcd1234' + sn.slice(-4), 'utf8');
}
function aesEncrypt(sn, plaintext) {
  const key = aesKey(sn);
  const buf = Buffer.from(plaintext, 'utf8');
  // Null-pad to 16-byte boundary
  const padded = Buffer.alloc(Math.ceil(buf.length / 16) * 16, 0);
  buf.copy(padded);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, AES_IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

// ── Find latest firmware ─────────────────────────────────────────────────────

function findFirmware() {
  if (!fs.existsSync(FIRMWARE_DIR)) {
    console.log(`[OTA-RELAY] No firmware directory at ${FIRMWARE_DIR}`);
    return null;
  }
  const files = fs.readdirSync(FIRMWARE_DIR)
    .filter(f => f.endsWith('.deb') && f.includes('mower_firmware'))
    .sort()
    .reverse();
  if (files.length === 0) {
    console.log('[OTA-RELAY] No .deb firmware files found');
    return null;
  }
  const file = files[0];
  const filePath = path.join(FIRMWARE_DIR, file);
  const stat = fs.statSync(filePath);
  // Extract version from filename: mower_firmware_v6.0.2-custom-17.deb
  const match = file.match(/v[\d.]+-custom-\d+|v[\d.]+/);
  const version = match ? match[0] : 'unknown';
  // Calculate MD5
  const md5 = crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
  return { file, filePath, version, md5, size: stat.size };
}

// ── HTTP server (firmware download + status) ─────────────────────────────────

const httpServer = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/' || req.url === '/status') {
    const fw = findFirmware();
    const status = {
      service: 'OpenNova OTA Relay',
      mqtt: `mqtt://${PUBLIC_HOST.split(':')[0]}:${MQTT_PORT}`,
      firmware: fw ? { version: fw.version, file: fw.file, size: fw.size, md5: fw.md5 } : null,
      connectedMowers: Object.keys(connectedDevices),
      otaHistory: otaHistory.slice(-20),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  // Firmware download: /firmware/<filename>
  if (req.url.startsWith('/firmware/')) {
    const filename = path.basename(req.url);
    const filePath = path.join(FIRMWARE_DIR, filename);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const stat = fs.statSync(filePath);
    console.log(`[HTTP] Serving firmware: ${filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── MQTT broker (aedes) ──────────────────────────────────────────────────────

const connectedDevices = {};  // sn → { clientId, connectedAt }
const otaHistory = [];        // { sn, version, timestamp, status }

async function startMqttBroker() {
  // Aedes v1.0.0 is ESM-only
  const { Aedes: AedesClass } = await import('aedes');
  const aedes = await AedesClass.createBroker();
  const net = require('net');
  const mqttServer = net.createServer(aedes.handle);

  aedes.on('client', (client) => {
    const clientId = client.id;
    // Extract SN from clientId: "LFIN2230700238_6688" → "LFIN2230700238"
    const snMatch = clientId.match(/^(LFI[NC]\d+)/);
    if (!snMatch) {
      console.log(`[MQTT] Non-device client connected: ${clientId}`);
      return;
    }
    const sn = snMatch[1];
    console.log(`[MQTT] Device connected: ${sn} (clientId=${clientId})`);
    connectedDevices[sn] = { clientId, connectedAt: new Date().toISOString() };

    // Auto-trigger OTA after short delay (let device settle)
    setTimeout(() => triggerOta(sn, aedes), 5000);
  });

  aedes.on('clientDisconnect', (client) => {
    const snMatch = client.id.match(/^(LFI[NC]\d+)/);
    if (snMatch) {
      const sn = snMatch[1];
      console.log(`[MQTT] Device disconnected: ${sn}`);
      delete connectedDevices[sn];
    }
  });

  // Subscribe to all device messages (for logging)
  aedes.on('publish', (packet, client) => {
    if (client && packet.topic.startsWith('Dart/Receive_mqtt/')) {
      const sn = packet.topic.split('/')[2];
      // Just log that we received data, don't decrypt
      console.log(`[MQTT] ← ${sn}: ${packet.payload.length}B on ${packet.topic}`);
    }
  });

  // Accept all connections (no auth required for relay)
  aedes.authenticate = (client, username, password, callback) => {
    callback(null, true);
  };
  aedes.authorizePublish = (client, packet, callback) => {
    callback(null);
  };
  aedes.authorizeSubscribe = (client, sub, callback) => {
    callback(null, sub);
  };

  mqttServer.listen(MQTT_PORT, () => {
    console.log(`[MQTT] Broker listening on port ${MQTT_PORT}`);
  });

  return aedes;
}

// ── OTA trigger ──────────────────────────────────────────────────────────────

function triggerOta(sn, aedes) {
  if (!sn.startsWith('LFIN')) {
    console.log(`[OTA] Skipping non-mower device: ${sn}`);
    return;
  }

  const fw = findFirmware();
  if (!fw) {
    console.log(`[OTA] No firmware available for ${sn}`);
    return;
  }

  const downloadUrl = `http://${PUBLIC_HOST}/firmware/${fw.file}`;
  const otaPayload = {
    ota_upgrade_cmd: {
      cmd: 'upgrade',
      type: 'full',
      content: 'app',
      url: downloadUrl,
      version: fw.version,
      md5: fw.md5,
    },
  };

  const topic = `Dart/Send_mqtt/${sn}`;
  const jsonStr = JSON.stringify(otaPayload);

  // Encrypt if LFI device
  let payload;
  if (sn.startsWith('LFI')) {
    payload = aesEncrypt(sn, jsonStr);
    console.log(`[OTA] → ${sn}: Sending encrypted OTA command (${fw.version}, ${(fw.size / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    payload = Buffer.from(jsonStr, 'utf8');
    console.log(`[OTA] → ${sn}: Sending OTA command (${fw.version})`);
  }

  aedes.publish({
    topic,
    payload,
    qos: 0,
    retain: false,
  }, () => {
    console.log(`[OTA] → ${sn}: OTA command published on ${topic}`);
    otaHistory.push({
      sn,
      version: fw.version,
      timestamp: new Date().toISOString(),
      downloadUrl,
      status: 'sent',
    });
  });
}

// ── Start ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║     OpenNova OTA Relay Service                 ║');
  console.log('╠════════════════════════════════════════════════╣');
  console.log(`║  HTTP:  http://localhost:${HTTP_PORT}                  ║`);
  console.log(`║  MQTT:  mqtt://localhost:${MQTT_PORT}                  ║`);
  console.log(`║  Public: ${PUBLIC_HOST.padEnd(37)}║`);
  console.log('╚════════════════════════════════════════════════╝');

  // Check firmware
  const fw = findFirmware();
  if (fw) {
    console.log(`[OTA-RELAY] Firmware: ${fw.version} (${fw.file}, ${(fw.size / 1024 / 1024).toFixed(1)} MB, md5=${fw.md5})`);
  } else {
    console.log(`[OTA-RELAY] WARNING: No firmware found in ${FIRMWARE_DIR}`);
    console.log(`[OTA-RELAY] Place .deb files in ${FIRMWARE_DIR} to enable OTA`);
  }

  // Start MQTT broker
  await startMqttBroker();

  // Start HTTP server
  httpServer.listen(HTTP_PORT, () => {
    console.log(`[HTTP] Server listening on port ${HTTP_PORT}`);
    console.log('');
    console.log('[OTA-RELAY] Ready! Waiting for mowers to connect...');
    console.log('[OTA-RELAY] BLE provision mowers with:');
    console.log(`[OTA-RELAY]   set_mqtt_info: {"addr":"${PUBLIC_HOST.split(':')[0]}","port":${MQTT_PORT}}`);
  });
})();
