#!/usr/bin/env node
/**
 * Novabot OTA Brute-Force Scanner
 *
 * Tries different mower serial numbers against the cloud OTA API
 * to find devices that received firmware newer than v5.7.1 (e.g. v6.0.3).
 * The download URL is public — we just need ONE SN that returns a newer version.
 *
 * Known SN patterns:
 *   LFIN2230700238  (ours)
 *   LFIN2231000675  (from firmware debug files)
 *   Format: LFIN2 + YY + BATCH(2) + SEQ(5)
 *
 * Usage:
 *   node bruteforce_firmware.js              # scan all known ranges
 *   node bruteforce_firmware.js --fast       # quick scan (fewer SNs)
 */

const crypto = require('crypto');
const https = require('https');

const CLOUD_IP = '47.253.145.99';
const EMAIL = 'ramonvanbruggen@gmail.com';
const PASSWORD = 'M@rleen146';
const AES_KEY_IV = '1234123412ABCDEF';
const CONCURRENCY = 5;       // parallel requests
const KNOWN_VERSION = 'v5.7.1';

// ─── Auth ──────────────────────────────────────────────────────────

function makeHeaders(token) {
  const echostr = 'p' + crypto.randomBytes(6).toString('hex');
  const ts = String(Date.now());
  const nonce = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
  const sig = crypto.createHash('sha256')
    .update(echostr + nonce + ts + (token || ''), 'utf8').digest('hex');
  return {
    'Host': 'app.lfibot.com',
    'Authorization': token || '',
    'Content-Type': 'application/json;charset=UTF-8',
    'source': 'app', 'userlanguage': 'en',
    'echostr': echostr, 'nonce': nonce, 'timestamp': ts, 'signature': sig,
  };
}

function apiGet(path, token) {
  return new Promise((resolve) => {
    const opts = {
      hostname: CLOUD_IP, path, method: 'GET',
      headers: makeHeaders(token), rejectUnauthorized: false,
    };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    r.on('error', () => resolve(null));
    r.setTimeout(10000, () => { r.destroy(); resolve(null); });
    r.end();
  });
}

async function login() {
  const cipher = crypto.createCipheriv('aes-128-cbc',
    Buffer.from(AES_KEY_IV), Buffer.from(AES_KEY_IV));
  let pw = cipher.update(PASSWORD, 'utf8', 'base64');
  pw += cipher.final('base64');

  return new Promise((resolve) => {
    const body = JSON.stringify({ email: EMAIL, password: pw, imei: 'imei' });
    const opts = {
      hostname: CLOUD_IP, path: '/api/nova-user/appUser/login', method: 'POST',
      headers: { ...makeHeaders(''), 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: false,
    };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).value.accessToken); }
        catch { resolve(null); }
      });
    });
    r.on('error', () => resolve(null));
    r.write(body);
    r.end();
  });
}

// ─── Scanner ───────────────────────────────────────────────────────

async function checkSn(token, sn) {
  const path = `/api/nova-user/otaUpgrade/checkOtaNewVersion?version=v0.0.0&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=${sn}`;
  const res = await apiGet(path, token);
  if (!res) return null;

  // Token expired?
  if (res.code === 1008) return 'REAUTH';

  if (res.value && res.value.version) {
    return {
      sn,
      version: res.value.version,
      url: res.value.downloadUrl,
      md5: res.value.md5,
    };
  }
  return null; // no firmware for this SN
}

/** Run tasks with limited concurrency */
async function parallelMap(items, fn, concurrency) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// ─── Main ──────────────────────────────────────────────────────────

(async () => {
  const fast = process.argv.includes('--fast');

  console.log('Novabot OTA Brute-Force Scanner');
  console.log('===============================\n');
  console.log(`Looking for firmware newer than ${KNOWN_VERSION}`);
  console.log(`Mode: ${fast ? 'FAST (sample scan)' : 'FULL (comprehensive scan)'}\n`);

  // Login
  let token = await login();
  if (!token) {
    console.error('Login failed! Cloud may be down.');
    process.exit(1);
  }
  console.log('Logged in.\n');

  // Generate SN candidates
  // Known format: LFIN2 + 2-digit year + 2-digit batch + 5-digit sequence
  // Known SNs: LFIN2230700238, LFIN2231000675
  // Year: 23 (2023), possibly 22, 24
  // Batch: 01-12 (months?) or custom batch codes
  // Sequence: 00001-01000+ (we know up to 00675 in batch 10)

  const candidates = [];

  const years = ['22', '23', '24'];
  const batches = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

  if (fast) {
    // Quick scan: sample every 50th SN in each batch
    for (const yr of years) {
      for (const batch of batches) {
        for (let seq = 1; seq <= 1500; seq += 50) {
          candidates.push(`LFIN2${yr}${batch}${String(seq).padStart(5, '0')}`);
        }
      }
    }
  } else {
    // Full scan: try every SN in reasonable ranges
    // Start with batches we know exist (07, 10), then expand
    const batchOrder = ['07', '10', '06', '08', '09', '11', '05', '12', '04', '03', '02', '01'];
    for (const yr of years) {
      for (const batch of batchOrder) {
        // Scan 0-1500 for each batch (covers known range)
        for (let seq = 1; seq <= 1500; seq++) {
          candidates.push(`LFIN2${yr}${batch}${String(seq).padStart(5, '0')}`);
        }
      }
    }
  }

  console.log(`Testing ${candidates.length} serial numbers (${CONCURRENCY} parallel)...\n`);

  const found = [];
  const versions = new Map(); // version -> count
  let checked = 0;
  let noFirmware = 0;
  let errors = 0;
  let lastPrint = Date.now();

  // Process in batches to handle re-auth
  const BATCH_SIZE = 50;
  for (let batchStart = 0; batchStart < candidates.length; batchStart += BATCH_SIZE) {
    const batch = candidates.slice(batchStart, batchStart + BATCH_SIZE);

    const results = await parallelMap(batch, async (sn) => {
      const result = await checkSn(token, sn);
      if (result === 'REAUTH') {
        token = await login();
        return checkSn(token, sn);
      }
      return result;
    }, CONCURRENCY);

    for (let i = 0; i < results.length; i++) {
      checked++;
      const r = results[i];

      if (r === null || r === 'REAUTH') {
        noFirmware++;
        continue;
      }

      // Count versions
      versions.set(r.version, (versions.get(r.version) || 0) + 1);

      if (r.version !== KNOWN_VERSION) {
        // FOUND SOMETHING NEW!
        console.log(`\n  !!! FOUND ${r.version} for ${r.sn} !!!`);
        console.log(`      URL: ${r.url}`);
        console.log(`      MD5: ${r.md5}\n`);
        found.push(r);
      }
    }

    // Progress update every second
    const now = Date.now();
    if (now - lastPrint > 1000 || batchStart + BATCH_SIZE >= candidates.length) {
      const pct = ((checked / candidates.length) * 100).toFixed(1);
      const versionStr = Array.from(versions.entries())
        .map(([v, c]) => `${v}:${c}`).join(', ');
      process.stdout.write(
        `\r  [${pct}%] ${checked}/${candidates.length} checked | ` +
        `hits: ${checked - noFirmware} | versions: ${versionStr || 'none yet'}    `
      );
      lastPrint = now;
    }

    // Early exit if we found a new version
    if (found.length > 0) {
      console.log('\n\nNew firmware version found! Stopping scan.');
      break;
    }
  }

  console.log('\n\n=== Results ===');
  console.log(`Checked: ${checked} serial numbers`);
  console.log(`With firmware: ${checked - noFirmware}`);
  console.log(`Versions found: ${Array.from(versions.entries()).map(([v, c]) => `${v} (${c}x)`).join(', ') || 'none'}`);

  if (found.length > 0) {
    console.log(`\nNEW FIRMWARE FOUND:`);
    for (const f of found) {
      console.log(`  ${f.sn} -> ${f.version}`);
      console.log(`  URL: ${f.url}`);
      console.log(`  MD5: ${f.md5}`);
    }
    console.log(`\nDownload with:`);
    console.log(`  node research/download_firmware.js ${found[0].sn}`);
  } else {
    console.log(`\nNo firmware newer than ${KNOWN_VERSION} found in scanned range.`);
  }
})();
