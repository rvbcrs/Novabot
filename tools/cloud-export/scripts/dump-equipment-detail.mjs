#!/usr/bin/env node
/**
 * Full dump of getEquipmentBySN for a given SN. Useful for spotting
 * fields the wizard summary skips (e.g. an OTA downloadUrl tied to the
 * device's beta channel that shows up here even when checkOtaNewVersion
 * refuses to expose it to our account).
 *
 * Usage:
 *   node dump-equipment-detail.mjs <email> <password> <sn>
 */
import https from 'node:https';
import crypto from 'node:crypto';

const HOST = '47.253.145.99';
const KEY_IV = Buffer.from('1234123412ABCDEF', 'utf8');
const enc = (p) => { const c = crypto.createCipheriv('aes-128-cbc', KEY_IV, KEY_IV); return c.update(p, 'utf8', 'base64') + c.final('base64'); };
const hdrs = (t) => { const e = 'p' + crypto.randomBytes(6).toString('hex'), s = String(Date.now()), n = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex'), g = crypto.createHash('sha256').update(e + n + s + t, 'utf8').digest('hex'); return { Host: 'app.lfibot.com', Authorization: t, 'Content-Type': 'application/json;charset=UTF-8', source: 'app', userlanguage: 'en', echostr: e, nonce: n, timestamp: s, signature: g }; };
const req = (m, p, b, t = '') => new Promise((res, rej) => { const s = b ? JSON.stringify(b) : '', h = { ...hdrs(t), ...(s ? { 'Content-Length': String(Buffer.byteLength(s)) } : {}) }; const r = https.request({ hostname: HOST, path: p, method: m, headers: h, rejectUnauthorized: false }, (o) => { let d = ''; o.on('data', (c) => d += c); o.on('end', () => { try { res(JSON.parse(d)); } catch { rej(new Error(d.slice(0, 200))); } }); }); r.on('error', rej); if (s) r.write(s); r.end(); });

const [email, password, sn] = process.argv.slice(2);
if (!email || !password || !sn) { console.error('Usage: dump-equipment-detail.mjs <email> <pass> <sn>'); process.exit(1); }

const lr = await req('POST', '/api/nova-user/appUser/login', { email, password: enc(password), plat: 'app', source: 'app' });
const token = lr.value.accessToken;
console.log('login ok, userId =', lr.value.appUserId);

// Try multiple deviceType encodings — the cloud stores chargers and mowers
// under different keys, and getEquipmentBySN sometimes returns more or
// fewer fields depending on which deviceType label you pass.
const variants = [
  { ep: '/api/nova-user/equipment/getEquipmentBySN', body: { sn, deviceType: 'mower' } },
  { ep: '/api/nova-user/equipment/getEquipmentBySN', body: { sn, deviceType: 'charger' } },
  { ep: '/api/nova-user/equipment/getEquipmentBySN', body: { sn } },
  // userEquipmentList sometimes returns extra fields when scoped by SN
  { ep: '/api/nova-user/equipment/userEquipmentList', body: { pageNum: 1, pageSize: 50, sn } },
];

for (const v of variants) {
  console.log(`\n=== POST ${v.ep} body=${JSON.stringify(v.body)}`);
  try {
    const r = await req('POST', v.ep, v.body, token);
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.log('error', e.message);
  }
}
