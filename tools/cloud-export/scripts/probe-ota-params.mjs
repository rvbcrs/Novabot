#!/usr/bin/env node
/**
 * One-shot OTA parameter probe.
 *
 * Cloud `checkOtaNewVersion` is account-gated — different accounts see
 * different firmware versions for the same SN. v6.0.3 was reported by a
 * third-party account (Brandon) but our account (Ramon) gets v5.7.1
 * stable. This probe sweeps every combination of upgradeType /
 * equipmentType / sn / version we can think of, against the SN we want
 * v6.0.3 for. Used to find a hidden parameter that exposes the beta
 * channel without needing the device owner's credentials.
 *
 * Usage:
 *   node probe-ota-params.mjs <email> <password> <sn>
 */
import https from 'node:https';
import crypto from 'node:crypto';

const HOST = '47.253.145.99';
const KEY_IV = Buffer.from('1234123412ABCDEF', 'utf8');

function enc(p) {
  const c = crypto.createCipheriv('aes-128-cbc', KEY_IV, KEY_IV);
  return c.update(p, 'utf8', 'base64') + c.final('base64');
}

function hdrs(t) {
  const e = 'p' + crypto.randomBytes(6).toString('hex');
  const s = String(Date.now());
  const n = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
  const g = crypto.createHash('sha256').update(e + n + s + t, 'utf8').digest('hex');
  return {
    Host: 'app.lfibot.com',
    Authorization: t,
    'Content-Type': 'application/json;charset=UTF-8',
    source: 'app',
    userlanguage: 'en',
    echostr: e,
    nonce: n,
    timestamp: s,
    signature: g,
  };
}

function req(method, path, body, token = '') {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      ...hdrs(token),
      ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
    };
    const r = https.request(
      { hostname: HOST, path, method, headers, rejectUnauthorized: false },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error(data.slice(0, 200))); }
        });
      },
    );
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

const [email, password, sn] = process.argv.slice(2);
if (!email || !password || !sn) {
  console.error('Usage: node probe-ota-params.mjs <email> <password> <sn>');
  process.exit(1);
}

const lr = await req('POST', '/api/nova-user/appUser/login', {
  email, password: enc(password), plat: 'app', source: 'app',
});
if (!lr?.value?.accessToken) { console.error('login failed'); process.exit(1); }
const token = lr.value.accessToken;
console.log('[+] login ok — userId =', lr.value.appUserId ?? lr.value.userId ?? '?');

const queries = [
  // baseline — exactly what cloud-export wizard sends
  { label: 'wizard exact (SCAN, v6.0.0)', q: '?version=v6.0.0&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=SCAN' },
  { label: 'wizard exact (SCAN, v6.0.2)', q: '?version=v6.0.2&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=SCAN' },
  { label: 'wizard exact (SCAN, v6.0.3)', q: '?version=v6.0.3&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=SCAN' },
  // real SN
  { label: 'real SN, v6.0.0', q: `?version=v6.0.0&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=${sn}` },
  { label: 'real SN, v6.0.2', q: `?version=v6.0.2&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=${sn}` },
  { label: 'real SN, v6.0.3 (no-op)', q: `?version=v6.0.3&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=${sn}` },
  // alternative equipmentType encodings
  { label: 'eqtype=mower', q: `?version=v6.0.2&upgradeType=serviceUpgrade&equipmentType=mower&sn=${sn}` },
  { label: 'eqtype=LFIN2 lowercase', q: `?version=v6.0.2&upgradeType=serviceUpgrade&equipmentType=lfin2&sn=${sn}` },
  { label: 'eqtype=LFI', q: `?version=v6.0.2&upgradeType=serviceUpgrade&equipmentType=LFI&sn=${sn}` },
  { label: 'eqtype=null', q: `?version=v6.0.2&upgradeType=serviceUpgrade&sn=${sn}` },
  // upgradeType variants
  { label: 'upgradeType=force', q: `?version=v6.0.2&upgradeType=force&equipmentType=LFIN2&sn=${sn}` },
  { label: 'upgradeType=forceUpgrade', q: `?version=v6.0.2&upgradeType=forceUpgrade&equipmentType=LFIN2&sn=${sn}` },
  { label: 'upgradeType=betaUpgrade', q: `?version=v6.0.2&upgradeType=betaUpgrade&equipmentType=LFIN2&sn=${sn}` },
  { label: 'upgradeType=beta', q: `?version=v6.0.2&upgradeType=beta&equipmentType=LFIN2&sn=${sn}` },
  { label: 'upgradeType=increment', q: `?version=v6.0.2&upgradeType=increment&equipmentType=LFIN2&sn=${sn}` },
  { label: 'upgradeType=full', q: `?version=v6.0.2&upgradeType=full&equipmentType=LFIN2&sn=${sn}` },
  { label: 'upgradeType=test', q: `?version=v6.0.2&upgradeType=test&equipmentType=LFIN2&sn=${sn}` },
  { label: 'upgradeType=trial', q: `?version=v6.0.2&upgradeType=trial&equipmentType=LFIN2&sn=${sn}` },
  { label: 'upgradeType blank', q: `?version=v6.0.2&upgradeType=&equipmentType=LFIN2&sn=${sn}` },
  { label: 'upgradeType missing', q: `?version=v6.0.2&equipmentType=LFIN2&sn=${sn}` },
  // environment hints
  { label: 'env=trial', q: `?version=v6.0.2&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=${sn}&environment=trial` },
  { label: 'env=production', q: `?version=v6.0.2&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=${sn}&environment=production` },
  { label: 'env=beta', q: `?version=v6.0.2&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=${sn}&environment=beta` },
  // version sentinel values
  { label: 'version=null', q: `?version=null&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=${sn}` },
  { label: 'version=latest', q: `?version=latest&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=${sn}` },
  { label: 'version=any', q: `?version=any&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=${sn}` },
  // post body variants (some endpoints accept body even on GET)
];

for (const { label, q } of queries) {
  try {
    const r = await req('GET', '/api/nova-user/otaUpgrade/checkOtaNewVersion' + q, null, token);
    const v = r?.value;
    const ver = v?.version ?? '<null>';
    const url = v?.downloadUrl ? v.downloadUrl.split('/').pop() : '<none>';
    const flag = v?.upgradeFlag ?? '?';
    console.log(`${label.padEnd(36)} → version=${String(ver).padEnd(12)} flag=${String(flag).padEnd(2)} url=${url}`);
  } catch (e) {
    console.log(`${label.padEnd(36)} → ERROR ${e.message.slice(0, 60)}`);
  }
}
