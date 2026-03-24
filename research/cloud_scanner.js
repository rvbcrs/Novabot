#!/usr/bin/env node
/**
 * LFI Cloud Device Scanner — fetches all Novabot device data (MAC, version, etc.)
 * and saves it locally as a safety backup before the cloud potentially goes offline.
 *
 * Usage:
 *   node cloud_scanner.js <email> <password>
 *
 * Output:
 *   research/cloud_devices.json — all found devices
 *
 * Rate limiting: 100 requests per batch, 2 second pause between batches.
 * Estimated time: ~20 minutes for a full scan of known SN ranges.
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────────

const CLOUD_HOST = '47.253.145.99';
const KEY_IV = Buffer.from('1234123412ABCDEF', 'utf8');
const BATCH_SIZE = 100;        // requests per batch
const BATCH_DELAY_MS = 2000;   // pause between batches
const REQUEST_DELAY_MS = 50;   // small delay between individual requests
const OUTPUT_FILE = path.join(__dirname, 'cloud_devices.json');

// SN ranges to scan — based on known devices:
//   LFIC1230700004, LFIC1231000319, LFIC2230700017
//   LFIN2230700238
// Scan ALL devices — chargers and mowers.
// Known SNs: LFIC1230700004, LFIC1231000319, LFIC2230700017, LFIN2230700238
// SN format: LFI<C|N><type><batch:4><serial:5>
// Use --chargers-only to skip mowers.
const CHARGERS_ONLY = process.argv.includes('--chargers-only');

const SN_RANGES = [
  // Chargers
  { prefix: 'LFIC1', type: 'charger', batch: '2307', serialStart: 0, serialEnd: 1000 },
  { prefix: 'LFIC1', type: 'charger', batch: '2308', serialStart: 0, serialEnd: 500 },
  { prefix: 'LFIC1', type: 'charger', batch: '2309', serialStart: 0, serialEnd: 500 },
  { prefix: 'LFIC1', type: 'charger', batch: '2310', serialStart: 0, serialEnd: 1000 },
  { prefix: 'LFIC1', type: 'charger', batch: '2311', serialStart: 0, serialEnd: 500 },
  { prefix: 'LFIC1', type: 'charger', batch: '2312', serialStart: 0, serialEnd: 500 },
  { prefix: 'LFIC1', type: 'charger', batch: '2401', serialStart: 0, serialEnd: 500 },
  { prefix: 'LFIC1', type: 'charger', batch: '2402', serialStart: 0, serialEnd: 500 },
  { prefix: 'LFIC2', type: 'charger', batch: '2307', serialStart: 0, serialEnd: 500 },
  { prefix: 'LFIC2', type: 'charger', batch: '2310', serialStart: 0, serialEnd: 500 },
  // Mowers (unless --chargers-only)
  ...(!CHARGERS_ONLY ? [
    { prefix: 'LFIN1', type: 'mower', batch: '2307', serialStart: 0, serialEnd: 1000 },
    { prefix: 'LFIN2', type: 'mower', batch: '2307', serialStart: 0, serialEnd: 1000 },
    { prefix: 'LFIN2', type: 'mower', batch: '2308', serialStart: 0, serialEnd: 500 },
    { prefix: 'LFIN2', type: 'mower', batch: '2309', serialStart: 0, serialEnd: 500 },
    { prefix: 'LFIN2', type: 'mower', batch: '2310', serialStart: 0, serialEnd: 500 },
    { prefix: 'LFIN2', type: 'mower', batch: '2311', serialStart: 0, serialEnd: 500 },
    { prefix: 'LFIN2', type: 'mower', batch: '2312', serialStart: 0, serialEnd: 500 },
    { prefix: 'LFIN2', type: 'mower', batch: '2401', serialStart: 0, serialEnd: 500 },
    { prefix: 'LFIN2', type: 'mower', batch: '2402', serialStart: 0, serialEnd: 500 },
  ] : []),
];

// ── Cloud API helpers ────────────────────────────────────────────────────────

function encryptPassword(pw) {
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY_IV, KEY_IV);
  return cipher.update(pw, 'utf8', 'base64') + cipher.final('base64');
}

function makeHeaders(token = '') {
  const echostr = 'p' + crypto.randomBytes(6).toString('hex');
  const ts = String(Date.now());
  const nonce = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
  const sig = crypto.createHash('sha256').update(echostr + nonce + ts + token, 'utf8').digest('hex');
  return {
    'Host': 'app.lfibot.com',
    'Authorization': token,
    'Content-Type': 'application/json;charset=UTF-8',
    'source': 'app',
    'userlanguage': 'en',
    'echostr': echostr,
    'nonce': nonce,
    'timestamp': ts,
    'signature': sig,
  };
}

function cloudCall(method, urlPath, body, token = '') {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      ...makeHeaders(token),
      ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
    };
    const req = https.request({
      hostname: CLOUD_HOST, path: urlPath, method, headers, rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [,, email, password] = process.argv;
  if (!email || !password) {
    console.log('Usage: node cloud_scanner.js <email> <password>');
    process.exit(1);
  }

  // Login
  console.log(`Logging in as ${email}...`);
  const encPwd = encryptPassword(password);
  const loginResp = await cloudCall('POST', '/api/nova-user/appUser/login', {
    email, password: encPwd, imei: 'imei',
  });

  if (!loginResp.success) {
    console.error(`Login failed: ${loginResp.message}`);
    process.exit(1);
  }

  const token = loginResp.value.accessToken;
  console.log(`Logged in! appUserId=${loginResp.value.appUserId}\n`);

  // Load existing results (resume support)
  let allDevices = [];
  let scannedSNs = new Set();
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      allDevices = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
      scannedSNs = new Set(allDevices.map(d => d.sn));
      console.log(`Resuming: ${allDevices.length} devices already found\n`);
    } catch {}
  }

  // Generate all SNs to scan
  const snList = [];
  for (const range of SN_RANGES) {
    for (let serial = range.serialStart; serial <= range.serialEnd; serial++) {
      const sn = `${range.prefix}${range.batch}${String(serial).padStart(5, '0')}`;
      if (!scannedSNs.has(sn)) {
        snList.push({ sn, type: range.type });
      }
    }
  }

  console.log(`Total SNs to scan: ${snList.length}`);
  console.log(`Batch size: ${BATCH_SIZE}, delay: ${BATCH_DELAY_MS}ms between batches\n`);

  let found = 0;
  let errors = 0;
  let scanned = 0;

  for (let i = 0; i < snList.length; i += BATCH_SIZE) {
    const batch = snList.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(snList.length / BATCH_SIZE);

    process.stdout.write(`Batch ${batchNum}/${totalBatches} (${scanned}/${snList.length} scanned, ${found} found)...`);

    for (const { sn, type } of batch) {
      try {
        const resp = await cloudCall('POST', '/api/nova-user/equipment/getEquipmentBySN', {
          sn, deviceType: type,
        }, token);

        const val = resp.value;
        if (val && (val.macAddress || val.equipmentId)) {
          // Save EVERYTHING the cloud returns — complete backup
          console.log(`\n  FOUND: ${sn} mac=${val.macAddress || '?'} version=${val.sysVersion || '?'} name=${val.equipmentNickName || '?'}`);
          allDevices.push({
            ...val,
            _queriedSn: sn,
            _queriedType: type,
            _scannedAt: new Date().toISOString(),
          });
          found++;
        }

        await sleep(REQUEST_DELAY_MS);
      } catch (err) {
        errors++;
        // Don't log every timeout
      }
      scanned++;
    }

    // Save after each batch (resume support)
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allDevices, null, 2));
    process.stdout.write(` saved\n`);

    // Pause between batches
    if (i + BATCH_SIZE < snList.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log(`\n=== Scan Complete ===`);
  console.log(`Scanned: ${scanned}`);
  console.log(`Found:   ${found}`);
  console.log(`Errors:  ${errors}`);
  console.log(`Total devices in database: ${allDevices.length}`);
  console.log(`Saved to: ${OUTPUT_FILE}`);

  // Summary by type
  const chargers = allDevices.filter(d => d.deviceType === 'charger');
  const mowers = allDevices.filter(d => d.deviceType === 'mower');
  console.log(`\nChargers: ${chargers.length}`);
  console.log(`Mowers:   ${mowers.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
