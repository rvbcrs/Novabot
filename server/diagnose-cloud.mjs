#!/usr/bin/env node
/**
 * Diagnose cloud import — check what LFI cloud returns for a given SN.
 * Usage: node diagnose-cloud.mjs <email> <password> <sn>
 */
import https from 'https';
import crypto from 'crypto';

const LFI_CLOUD_HOST = '47.253.145.99';
const LFI_CLOUD_SERVERNAME = 'app.lfibot.com';
const APP_PW_KEY_IV = Buffer.from('1234123412ABCDEF', 'utf8');

function encryptPassword(plain) {
  const cipher = crypto.createCipheriv('aes-128-cbc', APP_PW_KEY_IV, APP_PW_KEY_IV);
  let encrypted = cipher.update(plain, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

function makeHeaders(token) {
  const echostr = 'p' + crypto.randomBytes(6).toString('hex');
  const ts = String(Date.now());
  const nonce = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
  const sig = crypto.createHash('sha256').update(echostr + nonce + ts + token, 'utf8').digest('hex');
  return {
    'Host': 'app.lfibot.com',
    'Authorization': token,
    'Content-Type': 'application/json;charset=UTF-8',
    'source': 'app',
    'echostr': echostr,
    'timestamp': ts,
    'nonce': nonce,
    'signature': sig,
  };
}

function callCloud(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: LFI_CLOUD_HOST,
      path,
      method,
      headers: makeHeaders(token || ''),
      rejectUnauthorized: false,
    }, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function downloadCsv(url, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url, `https://${LFI_CLOUD_HOST}`);
    const isCloud = parsed.hostname === LFI_CLOUD_SERVERNAME || parsed.hostname === LFI_CLOUD_HOST;
    const req = https.request({
      hostname: isCloud ? LFI_CLOUD_HOST : parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      ...(isCloud ? { headers: makeHeaders(token), rejectUnauthorized: false } : {}),
    }, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => resolve({ status: resp.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── Main ──
const [,, email, password, sn] = process.argv;
if (!email || !password || !sn) {
  console.log('Usage: node diagnose-cloud.mjs <email> <password> <sn>');
  process.exit(1);
}

console.log(`\n🔍 Diagnosing cloud data for SN: ${sn}\n`);

// Step 1: Login
console.log('1️⃣  Logging in to LFI cloud...');
const loginResp = await callCloud('POST', '/api/nova-user/appUser/login', {
  email,
  password: encryptPassword(password),
  imei: 'imei',
}, '');
const token = loginResp?.value?.accessToken;
if (!token) {
  console.error('❌ Login failed:', JSON.stringify(loginResp));
  process.exit(1);
}
console.log('   ✓ Login OK, got token\n');

// Step 2: queryEquipmentMap
console.log('2️⃣  Fetching queryEquipmentMap...');
const mapResp = await callCloud('GET',
  `/api/nova-file-server/map/queryEquipmentMap?sn=${encodeURIComponent(sn)}`,
  null, token);

const mapVal = mapResp?.value;
const mapData = mapVal?.data;

if (!mapData) {
  console.error('❌ No map data in response:', JSON.stringify(mapResp).slice(0, 500));
  process.exit(1);
}

const workItems = mapData.work ?? [];
const unicomItems = mapData.unicom ?? [];

console.log(`   ✓ Response: ${workItems.length} work, ${unicomItems.length} unicom\n`);

// Step 3: Show work items
console.log('3️⃣  Work items:');
for (const w of workItems) {
  const obsCount = Array.isArray(w.obstacle) ? w.obstacle.length : 0;
  console.log(`   📍 ${w.fileName}  alias="${w.alias}"  type=${w.type}  obstacles=${obsCount}  url=${w.url ? '✓' : '❌ MISSING'}`);
}

// Step 4: Show unicom items
console.log(`\n4️⃣  Unicom items (${unicomItems.length}):`);
if (unicomItems.length === 0) {
  console.log('   ⚠️  GEEN unicom items van cloud! Dit verklaart de disabled zones.');
} else {
  for (const u of unicomItems) {
    console.log(`   🔗 ${u.fileName}  alias="${u.alias}"  type=${u.type}  url=${u.url ? '✓' : '❌ MISSING'}`);
  }
}

// Step 5: Try downloading each unicom CSV
if (unicomItems.length > 0) {
  console.log('\n5️⃣  Download test per unicom CSV:');
  for (const u of unicomItems) {
    if (!u.url) { console.log(`   ❌ ${u.fileName}: no URL`); continue; }
    try {
      const result = await downloadCsv(u.url, token);
      const lines = result.data?.trim().split('\n') ?? [];
      const hasComma = result.data?.includes(',');
      console.log(`   ${result.status === 200 && hasComma ? '✓' : '❌'} ${u.fileName}: HTTP ${result.status}, ${result.data?.length ?? 0} bytes, ${lines.length} lines, csv=${hasComma ? 'yes' : 'NO'}`);
      if (result.status !== 200 || !hasComma) {
        console.log(`      First 200 chars: ${result.data?.slice(0, 200)}`);
      }
    } catch (err) {
      console.log(`   ❌ ${u.fileName}: ${err.message}`);
    }
  }
}

console.log('\n✅ Done\n');
