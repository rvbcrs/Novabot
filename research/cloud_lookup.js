#!/usr/bin/env node
/**
 * Quick lookup of a single device on the LFI cloud.
 * Usage: node cloud_lookup.js <email> <password> <SN> [charger|mower]
 */
const https = require('https');
const crypto = require('crypto');

const CLOUD_HOST = '47.253.145.99';
const KEY_IV = Buffer.from('1234123412ABCDEF', 'utf8');

function encryptPassword(pw) {
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY_IV, KEY_IV);
  return cipher.update(pw, 'utf8', 'base64') + cipher.final('base64');
}

function makeHeaders(token) {
  const echostr = 'p' + crypto.randomBytes(6).toString('hex');
  const ts = String(Date.now());
  const nonce = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
  const sig = crypto.createHash('sha256').update(echostr + nonce + ts + (token || ''), 'utf8').digest('hex');
  return { 'Host': 'app.lfibot.com', 'Authorization': token || '', 'Content-Type': 'application/json;charset=UTF-8', 'source': 'app', 'echostr': echostr, 'nonce': nonce, 'timestamp': ts, 'signature': sig };
}

function call(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = { hostname: CLOUD_HOST, path, method, headers: { ...makeHeaders(token), 'Content-Length': String(Buffer.byteLength(data)) }, rejectUnauthorized: false };
    const req = https.request(opts, res => { let s = ''; res.on('data', c => s += c); res.on('end', () => { try { resolve(JSON.parse(s)); } catch { reject(s); } }); });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject('timeout'); });
    req.write(data);
    req.end();
  });
}

(async () => {
  const [,, email, password, sn, type] = process.argv;
  if (!email || !password || !sn) {
    console.log('Usage: node cloud_lookup.js <email> <password> <SN> [charger|mower]');
    process.exit(1);
  }

  const deviceType = type || (sn.startsWith('LFIC') ? 'charger' : 'mower');
  console.log(`Looking up ${sn} (${deviceType})...`);

  const login = await call('POST', '/api/nova-user/appUser/login', { email, password: encryptPassword(password), imei: 'imei' });
  if (!login.success) { console.log('Login failed:', login.message); process.exit(1); }

  const token = login.value.accessToken;
  const result = await call('POST', '/api/nova-user/equipment/getEquipmentBySN', { sn, deviceType }, token);

  if (result.value) {
    console.log(JSON.stringify(result.value, null, 2));
  } else {
    console.log('Not found:', result.message || 'no data');
  }
})();
