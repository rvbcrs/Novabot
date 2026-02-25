const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

const OUTPUT_DIR = '/Users/rvbcrs/GitHub/Novabot/research/cloud_data';

function makeHeaders(token) {
  const echostr = 'p' + crypto.randomBytes(6).toString('hex');
  const ts = String(Date.now());
  const nonce = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
  const sig = crypto.createHash('sha256').update(echostr + nonce + ts + (token || ''), 'utf8').digest('hex');
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

function req(method, path, body, token) {
  return new Promise((resolve) => {
    const opts = { hostname: '47.253.145.99', path, method, headers: makeHeaders(token), rejectUnauthorized: false };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', e => resolve({ status: 0, body: 'ERROR: ' + e.message }));
    r.setTimeout(15000);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function login() {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from('1234123412ABCDEF'), Buffer.from('1234123412ABCDEF'));
  let pw = cipher.update('M@rleen146', 'utf8', 'base64');
  pw += cipher.final('base64');

  const r = await req('POST', '/api/nova-user/appUser/login', {
    email: 'ramonvanbruggen@gmail.com',
    password: pw,
    imei: 'imei',
  });
  const data = JSON.parse(r.body);
  return data.value.accessToken;
}

async function fetchPaginated(token, path, params, listKey) {
  const all = [];
  let page = 1;
  let totalSize = 0;

  while (true) {
    const body = { ...params, pageNo: page };
    const r = await req('POST', path, body, token);
    let data;
    try { data = JSON.parse(r.body); } catch { break; }

    if (data.code === 1008) {
      console.log('  Token expired, re-logging in...');
      token = await login();
      continue;
    }

    const list = data.value && data.value[listKey];
    if (!data.success || !list || list.length === 0) {
      if (page === 1) console.log('  No data found. Response:', r.body.slice(0, 200));
      break;
    }

    totalSize = data.value.totalSize || 0;
    all.push(...list);
    console.log('  Page ' + page + ': ' + list.length + ' items (total: ' + all.length + '/' + totalSize + ')');

    if (all.length >= totalSize) break;
    page++;
    if (page > 200) break;
  }

  return { token, items: all };
}

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('Logging in...');
  let TOKEN = await login();
  console.log('Token: ' + TOKEN);

  // 1. Work records
  console.log('\n=== WORK RECORDS ===');
  let result = await fetchPaginated(TOKEN, '/api/novabot-message/message/queryCutGrassRecordPageByUserId',
    { appUserId: 86, pageSize: 50, sn: 'LFIN2230700238' }, 'pageList');
  TOKEN = result.token;
  fs.writeFileSync(OUTPUT_DIR + '/work_records.json', JSON.stringify({ totalSize: result.items.length, records: result.items }, null, 2));
  console.log('Saved work_records.json (' + result.items.length + ' records)');

  // 2. Robot messages
  console.log('\n=== ROBOT MESSAGES ===');
  result = await fetchPaginated(TOKEN, '/api/novabot-message/message/queryRobotMsgPageByUserId',
    { appUserId: 86, pageSize: 50 }, 'pageList');
  TOKEN = result.token;
  fs.writeFileSync(OUTPUT_DIR + '/robot_messages.json', JSON.stringify({ totalSize: result.items.length, messages: result.items }, null, 2));
  console.log('Saved robot_messages.json (' + result.items.length + ' messages)');

  // 3. Firmware scan — smart approach: test key version boundaries
  console.log('\n=== FIRMWARE SCAN ===');
  const firmwareResults = { charger: [], mower: [] };

  // Charger versions to test
  const chargerTests = ['v0.0.0', 'v0.1.0', 'v0.2.0', 'v0.3.0', 'v0.3.5', 'v0.3.6', 'v0.3.7', 'v0.4.0', 'v0.5.0', 'v1.0.0'];
  console.log('Charger firmware:');
  const seenCharger = new Set();
  for (const ver of chargerTests) {
    const r = await req('GET', '/api/nova-user/otaUpgrade/checkOtaNewVersion?version=' + ver + '&upgradeType=serviceUpgrade&equipmentType=LFIC1&sn=LFIC1230700004', null, TOKEN);
    const data = JSON.parse(r.body);
    if (data.value && data.value.version) {
      const key = data.value.version + '|' + data.value.downloadUrl;
      if (!seenCharger.has(key)) {
        seenCharger.add(key);
        firmwareResults.charger.push(data.value);
        console.log('  From ' + ver + ' -> ' + data.value.version + ' (' + data.value.environment + ') ' + data.value.downloadUrl);
      }
    } else {
      console.log('  From ' + ver + ' -> no update available (already latest)');
    }
  }

  // Mower versions to test
  const mowerTests = ['v0.0.0', 'v0.3.25', 'v1.0.0', 'v2.0.0', 'v3.0.0', 'v4.0.0', 'v5.0.0', 'v5.5.0', 'v5.7.0', 'v5.7.1', 'v5.8.0', 'v6.0.0'];
  console.log('Mower firmware:');
  const seenMower = new Set();
  for (const ver of mowerTests) {
    const r = await req('GET', '/api/nova-user/otaUpgrade/checkOtaNewVersion?version=' + ver + '&upgradeType=serviceUpgrade&equipmentType=LFIN2&sn=LFIN2230700238', null, TOKEN);
    const data = JSON.parse(r.body);
    if (data.value && data.value.version) {
      const key = data.value.version + '|' + data.value.downloadUrl;
      if (!seenMower.has(key)) {
        seenMower.add(key);
        firmwareResults.mower.push(data.value);
        console.log('  From ' + ver + ' -> ' + data.value.version + ' (' + data.value.environment + ') ' + data.value.downloadUrl);
      }
    } else {
      console.log('  From ' + ver + ' -> no update available (already latest)');
    }
  }

  // Try different equipment types too
  console.log('Other equipment types:');
  for (const et of ['LFIC1', 'LFIC2', 'LFIN1', 'LFIN2', 'LFIN3', 'LFIC3', 'LFI01', 'N1000', 'N2000']) {
    const r = await req('GET', '/api/nova-user/otaUpgrade/checkOtaNewVersion?version=v0.0.0&upgradeType=serviceUpgrade&equipmentType=' + et + '&sn=TEST', null, TOKEN);
    const data = JSON.parse(r.body);
    if (data.value && data.value.version) {
      console.log('  ' + et + ': ' + data.value.version + ' -> ' + data.value.downloadUrl);
      firmwareResults[et] = data.value;
    }
  }

  fs.writeFileSync(OUTPUT_DIR + '/firmware_versions.json', JSON.stringify(firmwareResults, null, 2));
  console.log('\nSaved firmware_versions.json');

  // 4. Verify already-saved files
  console.log('\n=== FILES IN ' + OUTPUT_DIR + ' ===');
  const files = fs.readdirSync(OUTPUT_DIR);
  for (const f of files) {
    const stat = fs.statSync(OUTPUT_DIR + '/' + f);
    console.log('  ' + f + ' (' + (stat.size / 1024).toFixed(1) + ' KB)');
  }

  console.log('\nDone!');
})();
