#!/usr/bin/env node
/**
 * Capture real-cloud response fixtures for cloud-api regression tests.
 *
 * For each hot endpoint we already contract-test (userEquipmentList,
 * getEquipmentBySN, queryEquipmentMap, checkOtaNewVersion, login), this
 * script hits the official LFI cloud (direct-IP + SNI) with a real user
 * account and writes the JSON response to
 *   server/src/cloud-api/__tests__/fixtures/<endpoint>.lfi.json
 *
 * Fixtures are the baseline for Task C regression tests: they assert our
 * server's response shape matches what LFI actually returns. Run this once
 * now + whenever LFI's API changes. Commit the updated fixtures together
 * with a CHANGELOG entry.
 *
 * Volatile fields (tokens, timestamps, md5, URLs, numeric IDs) are replaced
 * with `<redacted-*>` placeholders before writing so the fixture stays
 * stable across captures.
 *
 * Usage:
 *   FIXTURE_EMAIL=you@example.com FIXTURE_PASSWORD=secret \
 *     node server/scripts/capture-lfi-fixtures.mjs
 *
 * Optional:
 *   FIXTURE_MOWER_SN=LFIN1231000211    # defaults to first mower in userEquipmentList
 *   FIXTURE_CHARGER_SN=LFIC1231000319  # defaults to first charger in userEquipmentList
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../src/cloud-api/__tests__/fixtures');

const LFI_CLOUD_HOST = '47.253.145.99';
const APP_PW_KEY_IV = Buffer.from('1234123412ABCDEF', 'utf8');

const EMAIL = process.env.FIXTURE_EMAIL;
const PASSWORD = process.env.FIXTURE_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error('Usage: FIXTURE_EMAIL=... FIXTURE_PASSWORD=... node capture-lfi-fixtures.mjs');
  process.exit(1);
}

function encryptCloudPassword(plain) {
  const c = crypto.createCipheriv('aes-128-cbc', APP_PW_KEY_IV, APP_PW_KEY_IV);
  return c.update(plain, 'utf8', 'base64') + c.final('base64');
}

function makeHeaders(token) {
  const echostr = 'p' + crypto.randomBytes(6).toString('hex');
  const ts = String(Date.now());
  const nonce = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
  const sig = crypto.createHash('sha256')
    .update(echostr + nonce + ts + token, 'utf8').digest('hex');
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

function call(method, urlPath, body, token = '') {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: LFI_CLOUD_HOST,
      path: urlPath,
      method,
      headers: {
        ...makeHeaders(token),
        ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
      },
      rejectUnauthorized: false,
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const VOLATILE_KEYS = /^(accessToken|token|timestamp|dateline|time|md5|hash|fileHash|url|downloadUrl|snapshotUrl|streamUrl|createdAt|updatedAt|activationTime|importTime|photoTime|createdBy|id|equipmentId|appUserId|userId)$/i;

function sanitize(obj, keyHint = '') {
  if (Array.isArray(obj)) return obj.map((v, i) => sanitize(v, `${keyHint}[${i}]`));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (VOLATILE_KEYS.test(k) && v !== null && typeof v !== 'object') {
        out[k] = `<redacted-${k}>`;
      } else {
        out[k] = sanitize(v, k);
      }
    }
    return out;
  }
  return obj;
}

function writeFixture(name, body) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, `${name}.lfi.json`);
  fs.writeFileSync(file, JSON.stringify(sanitize(body), null, 2) + '\n');
  console.log(`  → ${path.relative(process.cwd(), file)}`);
}

async function main() {
  console.log(`LFI cloud: ${LFI_CLOUD_HOST} (SNI: app.lfibot.com)`);

  // 1. login
  console.log('Login…');
  const login = await call('POST', '/api/nova-user/user/login', {
    email: EMAIL,
    password: encryptCloudPassword(PASSWORD),
  });
  if (!login?.success || !login?.value?.accessToken) {
    console.error('Login failed:', login);
    process.exit(1);
  }
  writeFixture('appUser.login', login);
  const token = login.value.accessToken;
  const appUserId = login.value.appUserId;

  // 2. userEquipmentList
  console.log('userEquipmentList…');
  const list = await call('POST', '/api/nova-user/equipment/userEquipmentList', {
    appUserId, pageSize: 10, pageNo: 1,
  }, token);
  writeFixture('equipment.userEquipmentList', list);

  // Pick SNs for downstream fixtures
  const pageList = list?.value?.pageList ?? [];
  const mowerSn = process.env.FIXTURE_MOWER_SN
    ?? pageList.find(d => String(d.sn ?? '').startsWith('LFIN'))?.sn;
  const chargerSn = process.env.FIXTURE_CHARGER_SN
    ?? pageList.find(d => String(d.sn ?? '').startsWith('LFIC'))?.sn;
  if (!mowerSn) {
    console.warn('No mower SN found — skipping getEquipmentBySN + queryEquipmentMap + checkOtaNewVersion');
  }

  if (mowerSn) {
    // 3. getEquipmentBySN (mower)
    console.log(`getEquipmentBySN (mower ${mowerSn})…`);
    const mower = await call('POST', '/api/nova-user/equipment/getEquipmentBySN', {
      sn: mowerSn,
    }, token);
    writeFixture('equipment.getEquipmentBySN.mower', mower);

    // 4. queryEquipmentMap
    console.log(`queryEquipmentMap ${mowerSn}…`);
    const map = await call('GET',
      `/api/nova-file-server/map/queryEquipmentMap?sn=${encodeURIComponent(mowerSn)}`,
      null, token);
    writeFixture('map.queryEquipmentMap', map);

    // 5. checkOtaNewVersion
    console.log(`checkOtaNewVersion ${mowerSn}…`);
    const ota = await call('GET',
      `/api/nova-user/otaUpgrade/checkOtaNewVersion?sn=${encodeURIComponent(mowerSn)}&version=v6.0.2&equipmentType=mower`,
      null, token);
    writeFixture('ota.checkOtaNewVersion.mower', ota);
  }

  if (chargerSn) {
    console.log(`getEquipmentBySN (charger ${chargerSn})…`);
    const charger = await call('POST', '/api/nova-user/equipment/getEquipmentBySN', {
      sn: chargerSn,
    }, token);
    writeFixture('equipment.getEquipmentBySN.charger', charger);
  }

  console.log('\nDone. Review fixtures + commit.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
