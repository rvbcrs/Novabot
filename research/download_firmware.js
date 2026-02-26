#!/usr/bin/env node
/**
 * Novabot Firmware Downloader
 *
 * Downloads mower and charger firmware from the Novabot cloud OTA API.
 * The cloud servers (47.253.145.99 / app.lfibot.com) are still running
 * despite Novabot being bankrupt — use while they last.
 *
 * HOW IT WORKS:
 * 1. Login to cloud API with AES-encrypted password → get accessToken
 * 2. All subsequent requests need a signature header:
 *    signature = SHA256(echostr + SHA1("qtzUser") + timestamp + token)
 * 3. Query OTA endpoint with a mower SN → cloud returns download URL + MD5
 * 4. Download the .deb from Alibaba OSS (public URL, no auth needed)
 * 5. Verify MD5 checksum
 *
 * USAGE:
 *   node download_firmware.js                          # uses default SN
 *   node download_firmware.js LFIN2231000675           # use specific mower SN
 *   node download_firmware.js LFIN2231000675 LFIC1230700004  # mower + charger SN
 *
 * The firmware version returned depends on the SN — Novabot pushed different
 * versions to different devices. v5.7.1 is the public release; v6.0.3 was
 * pushed to select devices on request.
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────
const CLOUD_IP = '47.253.145.99';                   // app.lfibot.com
const EMAIL = 'ramonvanbruggen@gmail.com';
const PASSWORD = 'M@rleen146';
const AES_KEY_IV = '1234123412ABCDEF';               // AES key = IV for password encryption
const OUTPUT_DIR = path.join(__dirname, '..', 'research', 'firmware');

// Default serial numbers (ours)
const DEFAULT_MOWER_SN = 'LFIN2230700238';
const DEFAULT_CHARGER_SN = 'LFIC1230700004';

// ─── Cloud API auth ────────────────────────────────────────────────

/** Build signed request headers for cloud API */
function makeHeaders(token) {
  // echostr = random nonce (misleadingly named in the API)
  const echostr = 'p' + crypto.randomBytes(6).toString('hex');
  const ts = String(Date.now());
  // nonce = SHA1("qtzUser") — static value (misleadingly named)
  const nonce = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
  // signature = SHA256(echostr + nonce + timestamp + token)
  const sig = crypto.createHash('sha256')
    .update(echostr + nonce + ts + (token || ''), 'utf8')
    .digest('hex');

  return {
    'Host': 'app.lfibot.com',
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

/** Make HTTPS request to cloud API */
function apiRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: CLOUD_IP,
      path,
      method,
      headers: makeHeaders(token),
      rejectUnauthorized: false,  // self-signed cert
    };
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

/** Login to cloud → returns accessToken (UUID) */
async function login() {
  // Password encrypted with AES-128-CBC, key and IV both = "1234123412ABCDEF"
  const cipher = crypto.createCipheriv('aes-128-cbc',
    Buffer.from(AES_KEY_IV), Buffer.from(AES_KEY_IV));
  let encryptedPw = cipher.update(PASSWORD, 'utf8', 'base64');
  encryptedPw += cipher.final('base64');

  const res = await apiRequest('POST', '/api/nova-user/appUser/login', {
    email: EMAIL,
    password: encryptedPw,
    imei: 'imei',
  });

  if (!res.success || !res.value?.accessToken) {
    throw new Error(`Login failed: ${JSON.stringify(res)}`);
  }
  return res.value.accessToken;
}

// ─── OTA firmware check ────────────────────────────────────────────

/**
 * Query OTA endpoint for available firmware.
 * Returns { version, downloadUrl, md5, environment } or null if no update.
 *
 * @param {string} sn - Device serial number (e.g. LFIN2230700238)
 * @param {string} equipmentType - First 5 chars of SN (e.g. LFIN2, LFIC1)
 * @param {string} currentVersion - Report this as current version (use v0.0.0 to get latest)
 */
async function checkOta(token, sn, equipmentType, currentVersion = 'v0.0.0') {
  const query = new URLSearchParams({
    version: currentVersion,
    upgradeType: 'serviceUpgrade',
    equipmentType,
    sn,
  });
  const res = await apiRequest('GET',
    `/api/nova-user/otaUpgrade/checkOtaNewVersion?${query}`, null, token);

  if (res.value && res.value.version) {
    return res.value;
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

    https.get(url, res => {
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
      fs.unlinkSync(outputPath);
      reject(err);
    });
  });
}

// ─── Main ──────────────────────────────────────────────────────────

(async () => {
  const mowerSn = process.argv[2] || DEFAULT_MOWER_SN;
  const chargerSn = process.argv[3] || DEFAULT_CHARGER_SN;
  const mowerType = mowerSn.slice(0, 5);   // LFIN2
  const chargerType = chargerSn.slice(0, 5); // LFIC1

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('Novabot Firmware Downloader');
  console.log('==========================\n');
  console.log(`Mower SN:   ${mowerSn} (type: ${mowerType})`);
  console.log(`Charger SN: ${chargerSn} (type: ${chargerType})\n`);

  // Step 1: Login
  console.log('Step 1: Logging in to cloud API...');
  let token;
  try {
    token = await login();
    console.log(`  Token: ${token}\n`);
  } catch (e) {
    console.error(`  Login failed: ${e.message}`);
    console.error('  The cloud server may be down. Novabot is bankrupt,');
    console.error('  these servers could stop at any time.');
    process.exit(1);
  }

  // Step 2: Check OTA for mower
  console.log('Step 2: Checking mower firmware...');
  const mowerOta = await checkOta(token, mowerSn, mowerType);
  if (mowerOta) {
    console.log(`  Version:  ${mowerOta.version}`);
    console.log(`  URL:      ${mowerOta.downloadUrl}`);
    console.log(`  MD5:      ${mowerOta.md5}`);
    console.log(`  Env:      ${mowerOta.environment}`);

    const ext = mowerOta.downloadUrl.endsWith('.deb') ? '.deb' : '.bin';
    const filename = `mower_firmware_${mowerOta.version}${ext}`;
    const outputPath = path.join(OUTPUT_DIR, filename);

    if (fs.existsSync(outputPath)) {
      // Verify existing file
      const existing = fs.readFileSync(outputPath);
      const existingMd5 = crypto.createHash('md5').update(existing).digest('hex');
      if (existingMd5 === mowerOta.md5) {
        console.log(`  Already downloaded: ${outputPath} (MD5 OK)`);
      } else {
        console.log(`  Existing file has wrong MD5, re-downloading...`);
        const result = await downloadFile(mowerOta.downloadUrl, outputPath, mowerOta.md5);
        console.log(`  Saved: ${result.path} (${(result.size / 1024 / 1024).toFixed(1)} MB)`);
      }
    } else {
      console.log(`  Downloading to ${outputPath}...`);
      const result = await downloadFile(mowerOta.downloadUrl, outputPath, mowerOta.md5);
      console.log(`  Saved: ${result.path} (${(result.size / 1024 / 1024).toFixed(1)} MB)`);
    }
  } else {
    console.log(`  No firmware available for ${mowerSn}`);
  }

  // Step 3: Check OTA for charger
  console.log('\nStep 3: Checking charger firmware...');
  const chargerOta = await checkOta(token, chargerSn, chargerType);
  if (chargerOta) {
    console.log(`  Version:  ${chargerOta.version}`);
    console.log(`  URL:      ${chargerOta.downloadUrl}`);
    console.log(`  MD5:      ${chargerOta.md5}`);

    const ext = chargerOta.downloadUrl.endsWith('.deb') ? '.deb' : '.bin';
    const filename = `charger_firmware_${chargerOta.version}${ext}`;
    const outputPath = path.join(OUTPUT_DIR, filename);

    if (fs.existsSync(outputPath)) {
      const existing = fs.readFileSync(outputPath);
      const existingMd5 = crypto.createHash('md5').update(existing).digest('hex');
      if (existingMd5 === chargerOta.md5) {
        console.log(`  Already downloaded: ${outputPath} (MD5 OK)`);
      } else {
        console.log(`  Existing file has wrong MD5, re-downloading...`);
        const result = await downloadFile(chargerOta.downloadUrl, outputPath, chargerOta.md5);
        console.log(`  Saved: ${result.path} (${(result.size / 1024 / 1024).toFixed(1)} MB)`);
      }
    } else {
      console.log(`  Downloading to ${outputPath}...`);
      const result = await downloadFile(chargerOta.downloadUrl, outputPath, chargerOta.md5);
      console.log(`  Saved: ${result.path} (${(result.size / 1024 / 1024).toFixed(1)} MB)`);
    }
  } else {
    console.log(`  No firmware available for ${chargerSn}`);
  }

  console.log('\nDone!');
  console.log('\nNote: The firmware version depends on the SN. Novabot pushed');
  console.log('different versions per device. To try downloading v6.0.3,');
  console.log('run this script with the SN of a device that received it:');
  console.log('  node download_firmware.js LFIN22XXXXXXXX');
})();
