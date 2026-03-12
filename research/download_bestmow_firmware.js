#!/usr/bin/env node
/**
 * BestMow Firmware Downloader
 *
 * Downloads mower and charger firmware from the BestMow cloud OTA API.
 * BestMow (园睛科技 / Yuanjing Technology) uses the same backend framework
 * as Novabot but with different endpoints and SN formats.
 *
 * HOW IT WORKS:
 * 1. Login to cloud API with AES-encrypted password (PKCS7 padding) → get accessToken
 * 2. All subsequent requests need signature headers (same as Novabot):
 *    signature = SHA256(echostr + SHA1("qtzUser") + timestamp + token)
 * 3. POST to OTA endpoint with JSON *array* of device SNs → cloud returns download URLs
 * 4. Download firmware from Alibaba OSS (public URL, no auth needed)
 * 5. Verify MD5 checksum
 *
 * KEY DIFFERENCES FROM NOVABOT:
 * - OTA endpoint is POST (not GET) and expects a JSON array body
 * - SN format: MR1P... (mower), CS1P... (charger) — not LFIN/LFIC
 * - API host: cluster-us.bestmow.net (not app.lfibot.com)
 * - Password uses PKCS7 padding (not null-byte padding)
 *
 * USAGE:
 *   node download_bestmow_firmware.js                                    # default SNs
 *   node download_bestmow_firmware.js MR1P1239US0000005                  # specific mower SN
 *   node download_bestmow_firmware.js MR1P1239US0000005 CS1P1251US0000001  # mower + charger
 *   node download_bestmow_firmware.js --email you@example.com --password yourpass
 *
 * You need a BestMow account. Create one at https://www.bestmow.com or
 * in the BestMow app. No device binding required — any valid account works.
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────
const API_HOST = 'cluster-us.bestmow.net';
const AES_KEY_IV = '1234123412ABCDEF';
const OUTPUT_DIR = path.join(__dirname, 'firmware', 'bestmow');

// Default serial numbers (from BestMow App Store screenshots / known devices)
const DEFAULT_MOWER_SN = 'MR1P1239US0000005';
const DEFAULT_CHARGER_SN = 'CS1P1251US0000001';

// ─── Parse CLI args ─────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    email: process.env.BESTMOW_EMAIL || '',
    password: process.env.BESTMOW_PASSWORD || '',
    mowerSn: DEFAULT_MOWER_SN,
    chargerSn: DEFAULT_CHARGER_SN,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i + 1]) {
      opts.email = args[++i];
    } else if (args[i] === '--password' && args[i + 1]) {
      opts.password = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
BestMow Firmware Downloader

Usage:
  node download_bestmow_firmware.js [mower_sn] [charger_sn] [options]

Options:
  --email <email>       BestMow account email
  --password <password> BestMow account password
  --help                Show this help

Environment variables:
  BESTMOW_EMAIL         BestMow account email
  BESTMOW_PASSWORD      BestMow account password

Examples:
  node download_bestmow_firmware.js
  node download_bestmow_firmware.js MR1P1239US0000005
  node download_bestmow_firmware.js --email user@example.com --password secret
  BESTMOW_EMAIL=user@example.com BESTMOW_PASSWORD=secret node download_bestmow_firmware.js
`);
      process.exit(0);
    } else if (!args[i].startsWith('--')) {
      // Positional: first = mower SN, second = charger SN
      if (opts.mowerSn === DEFAULT_MOWER_SN) {
        opts.mowerSn = args[i];
      } else {
        opts.chargerSn = args[i];
      }
    }
  }

  if (!opts.email || !opts.password) {
    console.error('Error: BestMow credentials required.');
    console.error('Provide via --email/--password flags or BESTMOW_EMAIL/BESTMOW_PASSWORD env vars.');
    console.error('Run with --help for usage info.');
    process.exit(1);
  }

  return opts;
}

// ─── Cloud API auth ────────────────────────────────────────────────

/** Build signed request headers for BestMow cloud API */
function makeHeaders(token) {
  const echostr = 'p' + crypto.randomBytes(6).toString('hex');
  const ts = String(Date.now());
  const nonce = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
  const sig = crypto.createHash('sha256')
    .update(echostr + nonce + ts + (token || ''), 'utf8')
    .digest('hex');

  return {
    'Host': API_HOST,
    'Authorization': token || '',
    'Content-Type': 'application/json;charset=UTF-8',
    'source': 'app',
    'userlanguage': 'en',
    'echostr': echostr,
    'nonce': nonce,
    'timestamp': ts,
    'signature': sig,
  };
}

/** Make HTTPS request to BestMow cloud API */
function apiRequest(method, reqPath, body, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: API_HOST,
      path: reqPath,
      method,
      headers: makeHeaders(token),
      rejectUnauthorized: false,
    };
    if (body) {
      const bodyStr = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Encrypt password with AES-128-CBC using PKCS7 padding.
 * BestMow requires PKCS7 — null-byte padding returns "password invalid".
 */
function encryptPassword(password) {
  const key = Buffer.from(AES_KEY_IV);
  const iv = Buffer.from(AES_KEY_IV);

  // PKCS7 padding: Node.js crypto uses PKCS7 by default (autoPadding = true)
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  let encrypted = cipher.update(password, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

/** Login to BestMow cloud → returns accessToken (UUID) */
async function login(email, password) {
  const encryptedPw = encryptPassword(password);

  const res = await apiRequest('POST', '/api/nova-user/appUser/login', {
    email,
    password: encryptedPw,
    imei: 'imei',
  });

  if (!res.success || !res.value?.accessToken) {
    throw new Error(`Login failed: ${JSON.stringify(res)}`);
  }
  return res.value;
}

// ─── OTA firmware check ────────────────────────────────────────────

/**
 * Query BestMow OTA endpoint for available firmware.
 *
 * KEY DIFFERENCE: BestMow uses POST with a JSON array body, not GET with query params.
 * Returns array of firmware entries or empty array.
 */
async function checkOta(token, sn) {
  const res = await apiRequest('POST',
    '/api/nova-data/equipmentOta/checkOtaNewVersion',
    [{ sn, version: 'v0.0.0' }],
    token,
  );

  if (!res.success) {
    // Token expired?
    if (res.code === 1008) return 'REAUTH';
    throw new Error(`OTA check failed: ${JSON.stringify(res)}`);
  }

  if (res.value && Array.isArray(res.value) && res.value.length > 0) {
    return res.value[0];
  }
  return null;
}

// ─── File download ─────────────────────────────────────────────────

/** Download a file from URL, show progress, verify MD5 */
function downloadFile(url, outputPath, expectedMd5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    const hash = crypto.createHash('md5');
    let received = 0;

    const getter = url.startsWith('https') ? https : require('http');

    getter.get(url, { rejectUnauthorized: false }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(outputPath);
        return downloadFile(res.headers.location, outputPath, expectedMd5)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(outputPath);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);

      res.on('data', chunk => {
        file.write(chunk);
        hash.update(chunk);
        received += chunk.length;
        if (total > 0) {
          const pct = ((received / total) * 100).toFixed(1);
          const mb = (received / 1024 / 1024).toFixed(1);
          process.stdout.write(`\r  Downloading: ${mb} MB (${pct}%)`);
        }
      });

      res.on('end', () => {
        file.close();
        process.stdout.write('\n');
        const actualMd5 = hash.digest('hex');
        if (expectedMd5 && actualMd5 !== expectedMd5) {
          reject(new Error(`MD5 mismatch! Expected: ${expectedMd5}, Got: ${actualMd5}`));
        } else {
          resolve({ path: outputPath, size: received, md5: actualMd5 });
        }
      });
    }).on('error', err => {
      file.close();
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      reject(err);
    });
  });
}

/** Determine file extension from download URL */
function getExtension(url) {
  if (url.includes('.zip')) return '.zip';
  if (url.includes('.deb')) return '.deb';
  if (url.includes('.bin')) return '.bin';
  return '.bin';
}

/** Download firmware if not already present (or verify existing) */
async function downloadFirmware(ota, deviceType) {
  const ext = getExtension(ota.downloadUrl);
  const filename = `BestMow_${deviceType}_${ota.version}${ext}`;
  const outputPath = path.join(OUTPUT_DIR, filename);

  if (fs.existsSync(outputPath)) {
    const existing = fs.readFileSync(outputPath);
    const existingMd5 = crypto.createHash('md5').update(existing).digest('hex');
    if (existingMd5 === ota.packageMd5) {
      console.log(`  Already downloaded: ${filename} (MD5 OK)`);
      return { path: outputPath, size: existing.length, md5: existingMd5, skipped: true };
    }
    console.log(`  Existing file has wrong MD5, re-downloading...`);
  } else {
    console.log(`  Downloading to ${filename}...`);
  }

  const result = await downloadFile(ota.downloadUrl, outputPath, ota.packageMd5);
  console.log(`  Saved: ${filename} (${(result.size / 1024 / 1024).toFixed(1)} MB)`);
  return result;
}

// ─── Main ──────────────────────────────────────────────────────────

(async () => {
  const opts = parseArgs();

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('BestMow Firmware Downloader');
  console.log('==========================\n');
  console.log(`Mower SN:   ${opts.mowerSn}`);
  console.log(`Charger SN: ${opts.chargerSn}\n`);

  // Step 1: Login
  console.log('Step 1: Logging in to BestMow cloud...');
  let token;
  try {
    const loginResult = await login(opts.email, opts.password);
    token = loginResult.accessToken;
    console.log(`  Logged in as: ${opts.email} (userId: ${loginResult.appUserId})`);
    console.log(`  Token: ${token}\n`);
  } catch (e) {
    console.error(`  Login failed: ${e.message}`);
    console.error('  Check your email/password. Create an account at bestmow.com if needed.');
    process.exit(1);
  }

  // Step 2: Check OTA for mower
  console.log('Step 2: Checking mower firmware...');
  try {
    let mowerOta = await checkOta(token, opts.mowerSn);
    if (mowerOta === 'REAUTH') {
      console.log('  Token expired, re-authenticating...');
      const loginResult = await login(opts.email, opts.password);
      token = loginResult.accessToken;
      mowerOta = await checkOta(token, opts.mowerSn);
    }

    if (mowerOta) {
      console.log(`  Version:  ${mowerOta.version}`);
      console.log(`  Type:     ${mowerOta.equipmentType} (models: ${mowerOta.equipmentModel})`);
      console.log(`  Region:   ${mowerOta.region}`);
      console.log(`  URL:      ${mowerOta.downloadUrl}`);
      console.log(`  MD5:      ${mowerOta.packageMd5}`);
      if (mowerOta.upgradeNotes) {
        console.log(`  Notes:    ${mowerOta.upgradeNotes.split('\n').map(l => l.trim()).filter(Boolean).join(' | ')}`);
      }
      console.log();
      await downloadFirmware(mowerOta, 'mower');
    } else {
      console.log(`  No firmware available for ${opts.mowerSn}`);
      console.log(`  Try a different SN. Known working: MR1P1239US0000005, MR1P1251US0000001`);
    }
  } catch (e) {
    console.error(`  Error: ${e.message}`);
  }

  // Step 3: Check OTA for charger
  console.log('\nStep 3: Checking charger firmware...');
  try {
    let chargerOta = await checkOta(token, opts.chargerSn);
    if (chargerOta === 'REAUTH') {
      const loginResult = await login(opts.email, opts.password);
      token = loginResult.accessToken;
      chargerOta = await checkOta(token, opts.chargerSn);
    }

    if (chargerOta) {
      console.log(`  Version:  ${chargerOta.version}`);
      console.log(`  Type:     ${chargerOta.equipmentType} (model: ${chargerOta.equipmentModel})`);
      console.log(`  Region:   ${chargerOta.region}`);
      console.log(`  URL:      ${chargerOta.downloadUrl}`);
      console.log(`  MD5:      ${chargerOta.packageMd5}`);
      if (chargerOta.upgradeNotes) {
        console.log(`  Notes:    ${chargerOta.upgradeNotes.split('\n').map(l => l.trim()).filter(Boolean).join(' | ')}`);
      }
      console.log();
      await downloadFirmware(chargerOta, 'charger');
    } else {
      console.log(`  No firmware available for ${opts.chargerSn}`);
      console.log(`  Try a different SN. Known working: CS1P1251US0000001`);
    }
  } catch (e) {
    console.error(`  Error: ${e.message}`);
  }

  console.log('\n' + '='.repeat(50));
  console.log('Done!');
  console.log(`\nFirmware saved to: ${OUTPUT_DIR}`);
  console.log('\nSN format reference:');
  console.log('  Mower:   MR1P + YYMM + REGION + SEQ  (e.g. MR1P1239US0000005)');
  console.log('  Charger: CS1P + YYMM + REGION + SEQ  (e.g. CS1P1251US0000001)');
  console.log('  Models:  MR (standard), MA, MF, MT (Titan?), CS (charger)');
})();
