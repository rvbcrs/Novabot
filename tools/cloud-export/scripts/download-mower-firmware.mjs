#!/usr/bin/env node
/**
 * Standalone mower firmware downloader. Mirrors the firmware step from
 * tools/cloud-export/src/server.ts but lets the caller probe an arbitrary
 * SN instead of being limited to the SNs bound to the logged-in account.
 *
 * Usage:
 *   node download-mower-firmware.mjs <email> <password> <sn>
 *
 * What it does:
 *   1. Logs into the LFI cloud (47.253.145.99) with the same AES password
 *      encryption + signed-headers handshake as the wizard.
 *   2. For each well-known mower seed version, calls
 *      /api/nova-user/otaUpgrade/checkOtaNewVersion with the supplied SN.
 *      Each response that includes a version is collected.
 *   3. Walks the chain dynamically: every response's version becomes the
 *      next "current" so we discover any version newer than our seeds
 *      (e.g. v6.0.3 betas) without hardcoding the list.
 *   4. Writes responses to research/firmware/<version>.json + downloads
 *      the binary to research/firmware/mower_firmware_<version>.deb.
 *
 * Notes:
 *   - downloadUrl returned by the cloud points at Aliyun OSS, not
 *     *.lfibot.com, so local DNS rewrites do not interfere.
 *   - Hits the cloud directly via IP so /etc/hosts or AdGuard rewrites
 *     for app.lfibot.com cannot redirect the request.
 */
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LFI_CLOUD_HOST = '47.253.145.99';
const APP_PW_KEY_IV = Buffer.from('1234123412ABCDEF', 'utf8');
const FIRMWARE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../research/firmware',
);

// Seed versions copied from cloud-export/src/server.ts mowerVersions array.
// Walking starts from each so we catch branches the chain may miss (e.g.
// older LTS lines that don't link forward to the latest beta). The device's
// own sysVersion (queried via getEquipmentBySN) is prepended so the cloud
// gets the lookup it actually expects.
const SEED_VERSIONS = ['v0.0.0', 'v5.7.1', 'v6.0.0', 'v6.0.1', 'v6.0.2', 'v6.0.3'];

function encryptPassword(plain) {
  const cipher = crypto.createCipheriv('aes-128-cbc', APP_PW_KEY_IV, APP_PW_KEY_IV);
  return cipher.update(plain, 'utf8', 'base64') + cipher.final('base64');
}

function signedHeaders(token) {
  const echostr = 'p' + crypto.randomBytes(6).toString('hex');
  const ts = String(Date.now());
  const nonce = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
  const sig = crypto.createHash('sha256').update(echostr + nonce + ts + token, 'utf8').digest('hex');
  return {
    Host: 'app.lfibot.com',
    Authorization: token,
    'Content-Type': 'application/json;charset=UTF-8',
    source: 'app',
    userlanguage: 'en',
    echostr,
    nonce,
    timestamp: ts,
    signature: sig,
  };
}

function callCloud(method, urlPath, body, token = '') {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      ...signedHeaders(token),
      ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
    };
    const req = https.request(
      { hostname: LFI_CLOUD_HOST, path: urlPath, method, headers, rejectUnauthorized: false },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Cloud timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https://') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close(() => fs.unlinkSync(dest));
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(fs.statSync(dest).size)));
    }).on('error', (err) => {
      file.close(() => fs.unlinkSync(dest));
      reject(err);
    });
  });
}

async function login(email, password) {
  const resp = await callCloud('POST', '/api/nova-user/appUser/login', {
    email,
    password: encryptPassword(password),
    plat: 'app',
    source: 'app',
  });
  if (resp.code !== 200 || !resp.value?.accessToken) {
    throw new Error(`Login failed: ${resp.message || JSON.stringify(resp).slice(0, 200)}`);
  }
  return resp.value.accessToken;
}

// Single OTA query. The cloud appears to gate certain firmware versions
// (notably v6.0.3) behind a non-default upgradeType. Try the wizard's
// `serviceUpgrade` first — fall back to other known/guessed types if the
// caller passes them in. The set of types tried is controlled by the
// caller's seeds loop so we can sweep multiple types per version.
async function checkOta(token, version, sn, upgradeType = 'serviceUpgrade', equipmentType = 'LFIN2') {
  return callCloud(
    'GET',
    `/api/nova-user/otaUpgrade/checkOtaNewVersion?version=${encodeURIComponent(version)}&upgradeType=${encodeURIComponent(upgradeType)}&equipmentType=${encodeURIComponent(equipmentType)}&sn=${encodeURIComponent(sn)}`,
    null,
    token,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const [email, password] = args;
  // Pick the first SN-looking arg from anywhere on the cmdline so reordering
  // (e.g. legacy `<email> <pass> v6.0.0 <sn>`) doesn't silently feed the
  // version where the SN belongs.
  const sn = args.find((a) => /^LFI[CN]\d/.test(a));

  if (!email || !password || !sn) {
    console.error('Usage: node download-mower-firmware.mjs <email> <password> <sn>');
    console.error('  sn must start with LFIC or LFIN, e.g. LFIN2231200027');
    process.exit(1);
  }

  fs.mkdirSync(FIRMWARE_DIR, { recursive: true });

  console.log(`[+] Login as ${email}`);
  const token = await login(email, password);
  console.log('[+] Authenticated.');

  // First: ask cloud what version this SN is *currently* running. Mirrors
  // research/cloud_scanner.js. Lets us probe checkOtaNewVersion with the
  // device's actual sysVersion as the "current" — which is how the cloud
  // expects to be queried (give it the device's own version + sn, get the
  // newest binary back).
  let deviceCurrentVersion = null;
  try {
    const detail = await callCloud(
      'POST',
      '/api/nova-user/equipment/getEquipmentBySN',
      { sn, deviceType: 'mower' },
      token,
    );
    const val = detail?.value;
    if (val) {
      console.log(`[+] Device record: sysVersion=${val.sysVersion} mac=${val.macAddress} equipmentType=${val.equipmentType}`);
      if (val.sysVersion) deviceCurrentVersion = String(val.sysVersion);
    } else {
      console.log(`[!] getEquipmentBySN returned no value: ${JSON.stringify(detail).slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`[!] getEquipmentBySN failed: ${e.message}`);
  }

  console.log(`[+] Probing OTA for sn=${sn}${deviceCurrentVersion ? ` (current=${deviceCurrentVersion})` : ''}`);

  // Walk every (seed, upgradeType) pair + chain forward so a v6.0.3 beta is
  // reachable even when no seed names it explicitly. Bucket dedupes by
  // version string so the same binary isn't downloaded twice. Cloud gates
  // some firmware behind non-default upgradeType values — sweep a known
  // set so a hidden beta channel surfaces if it exists.
  const UPGRADE_TYPES = [
    'serviceUpgrade',
    'firmwareUpgrade',
    'betaUpgrade',
    'increment',
    'force',
  ];
  const found = new Map(); // version -> raw cloud response
  const seeds = deviceCurrentVersion
    ? [deviceCurrentVersion, ...SEED_VERSIONS.filter((v) => v !== deviceCurrentVersion)]
    : SEED_VERSIONS;
  for (const upgradeType of UPGRADE_TYPES) {
   for (const seed of seeds) {
    let current = seed;
    let hops = 0;
    while (hops < 12) {
      hops += 1;
      let resp;
      try {
        resp = await checkOta(token, current, sn, upgradeType);
      } catch (e) {
        console.log(`    [type=${upgradeType} seed=${seed}] hop ${hops}: error ${e.message}`);
        break;
      }
      const value = resp?.value || null;
      const ver = value?.version;
      if (!ver) {
        if (hops === 1) {
          console.log(`    [type=${upgradeType} seed=${seed}] no version. raw=${JSON.stringify(resp).slice(0, 140)}`);
        }
        break;
      }
      if (found.has(ver)) break;
      console.log(`    [type=${upgradeType} seed=${seed}] hop ${hops}: ${current} → ${ver}  flag=${value.upgradeFlag}`);
      found.set(ver, value);
      current = ver;
    }
   }
  }

  if (found.size === 0) {
    console.log('[!] Cloud returned nothing for this SN. Either the SN is unknown to the cloud or this account cannot query it.');
    return;
  }

  console.log(`\n[+] ${found.size} version(s) discovered:`);
  for (const ver of found.keys()) console.log(`    - ${ver}`);

  for (const [ver, info] of found) {
    const safeVer = ver.startsWith('v') ? ver : `v${ver}`;
    const baseName = `mower_firmware_${safeVer}`;
    const debPath = path.join(FIRMWARE_DIR, `${baseName}.deb`);
    const jsonPath = path.join(FIRMWARE_DIR, `${baseName}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(info, null, 2));
    if (!info.downloadUrl) {
      console.log(`[-] ${ver}: no downloadUrl in response, metadata saved to ${path.basename(jsonPath)}`);
      continue;
    }
    if (fs.existsSync(debPath)) {
      console.log(`[=] ${ver}: ${path.basename(debPath)} already on disk, skipping`);
      continue;
    }
    console.log(`[↓] ${ver}: ${info.downloadUrl}`);
    try {
      const size = await downloadFile(info.downloadUrl, debPath);
      console.log(`    wrote ${size} bytes → ${path.basename(debPath)}`);
    } catch (e) {
      console.log(`    download failed: ${e.message}`);
    }
  }

  console.log('\n[+] Done.');
}

main().catch((err) => { console.error('[!]', err.message || err); process.exit(1); });
