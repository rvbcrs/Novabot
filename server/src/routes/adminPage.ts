/**
 * Admin page — self-contained HTML with login + status dashboard.
 * No build step needed — pure inline HTML/CSS/JS.
 */

export function adminPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenNova Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#030712;color:#e0e0e0;min-height:100vh}
  .container{max-width:900px;margin:0 auto;padding:20px}
  h1{color:#00d4aa;font-size:24px;margin-bottom:4px}
  h2{color:#7c3aed;font-size:14px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
  .version{color:#666;font-size:12px;margin-bottom:24px}
  .card{background:#16213e;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid rgba(255,255,255,.08)}
  .row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04);flex-wrap:wrap;gap:4px}
  .row:last-child{border-bottom:none}
  .label{color:#888;font-size:13px}
  .value{font-size:13px;font-weight:600;text-align:right;word-break:break-all}
  .on{color:#00d4aa}
  .off{color:#ef4444}
  .warn{color:#f59e0b}
  .sn{color:#a78bfa;font-family:monospace;font-size:12px;word-break:break-all}
  .table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
  table{width:100%;border-collapse:collapse;font-size:13px;min-width:400px}
  th{text-align:left;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:8px 6px;border-bottom:1px solid rgba(255,255,255,.1);white-space:nowrap}
  td{padding:8px 6px;border-bottom:1px solid rgba(255,255,255,.04)}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
  .dot-on{background:#00d4aa}
  .dot-off{background:#ef4444}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
  .badge-admin{background:rgba(124,58,237,.2);color:#a78bfa}
  .badge-dash{background:rgba(0,212,170,.15);color:#00d4aa}
  .badge-user{background:rgba(255,255,255,.05);color:#666}
  .btn{padding:4px 12px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600;transition:all .2s}
  .btn-sm{padding:3px 8px;font-size:11px}
  .btn-green{background:#047857;color:#fff}
  .btn-green:hover{background:#059669}
  .btn-red{background:#991b1b;color:#fff}
  .btn-red:hover{background:#b91c1c}
  .btn-purple{background:#6d28d9;color:#fff}
  .btn-purple:hover{background:#7c3aed}
  input{padding:10px 14px;background:#0d0d20;border:1px solid #333;border-radius:8px;color:#fff;font-size:14px;width:100%}
  input:focus{border-color:#7c3aed;outline:none}
  .login-box{max-width:360px;margin:80px auto;padding:0 16px}
  .tabs{display:flex;gap:4px;margin-bottom:16px}
  .tab{padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;background:rgba(255,255,255,.05);color:#888;border:none}
  .tab.active{background:#7c3aed;color:#fff}
  .hide-mobile{}
  /* Responsive */
  @media(max-width:600px){
    .container{padding:10px}
    h1{font-size:20px}
    h2{font-size:12px}
    .card{padding:12px;border-radius:10px}
    table{font-size:12px;min-width:0}
    th,td{padding:6px 4px}
    th{font-size:9px}
    .row{flex-direction:column;align-items:flex-start;gap:2px}
    .value{text-align:left;font-size:12px}
    .sn{font-size:11px}
    .btn{font-size:11px;padding:6px 10px}
    .login-box{margin:40px auto}
    .hide-mobile{display:none!important}
  }
  #app{display:none}
  .refresh-btn{float:right;cursor:pointer;color:#666;font-size:12px}
  .refresh-btn:hover{color:#00d4aa}
  .menu-item{padding:8px 12px;font-size:12px;color:#ccc;cursor:pointer;border-radius:6px;white-space:nowrap}
  .menu-item:hover{background:rgba(255,255,255,.08)}
</style>
</head>
<body>

<!-- Login (hidden when first-time setup is shown) -->
<div id="login" class="login-box" style="display:none">
  <div class="card" style="text-align:center;padding:32px">
    <h1 style="margin-bottom:16px">OpenNova Admin</h1>
    <p style="color:#666;font-size:13px;margin-bottom:24px">Login with your OpenNova account</p>
    <input id="email" type="email" placeholder="Email" style="margin-bottom:10px"><br>
    <input id="pass" type="password" placeholder="Password" style="margin-bottom:16px"><br>
    <button class="btn btn-purple" style="width:100%;padding:12px" onclick="doLogin()">Login</button>
    <p id="loginErr" style="color:#ef4444;font-size:12px;margin-top:10px"></p>
  </div>
</div>

<!-- First-time setup (shown instead of login when DB is empty) -->
<div id="firstTimeSetup" class="login-box" style="display:none">
  <div class="card" style="padding:28px">
    <h1 style="color:#00d4aa;margin-bottom:8px;text-align:center">Welcome to OpenNova</h1>
    <p style="font-size:13px;color:#888;margin-bottom:20px;text-align:center">Import your devices from the Novabot cloud to get started.</p>
    <input type="email" id="cloud_email_setup" placeholder="Novabot app email" style="margin-bottom:8px">
    <input type="password" id="cloud_pass_setup" placeholder="Novabot app password" style="margin-bottom:14px">
    <button class="btn btn-green" style="width:100%;padding:12px" onclick="firstTimeCloudImport()" id="setupBtn">Connect &amp; Import from Cloud</button>
    <div id="setupResult" style="margin-top:10px"></div>
    <div style="text-align:center;color:#444;margin:16px 0;font-size:12px">— or —</div>
    <button class="btn" style="width:100%;padding:10px;background:#333" onclick="skipSetup()">Skip — Create Local Account</button>
    <p style="font-size:11px;color:#555;margin-top:8px;text-align:center">Creates admin@local with password admin</p>
  </div>
</div>

<!-- Admin Panel -->
<div id="app" class="container" style="display:none">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;flex-wrap:wrap;gap:8px">
    <div style="min-width:0">
      <h1>OpenNova Admin</h1>
      <div class="version" id="serverInfo">Loading...</div>
    </div>
    <div style="display:flex;gap:6px">
      <button class="btn" style="background:#333" onclick="logout()">Logout</button>
      <button class="btn btn-purple" onclick="loadAll()">↻</button>
    </div>
  </div>

  <!-- Account -->
  <div class="card">
    <h2>Account</h2>
    <div id="account">Loading...</div>
  </div>

  <!-- My Devices -->
  <div class="card">
    <h2>My Devices <span class="refresh-btn" onclick="loadMyDevices()">↻</span></h2>
    <div id="myDevices">Loading...</div>
  </div>

  <!-- Cloud Import -->
  <div class="card">
    <h2>Cloud Import</h2>
    <p style="font-size:12px;color:#888;margin-bottom:12px">Import devices from the Novabot cloud using your Novabot app credentials.</p>
    <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
      <input type="email" id="cloud_email" placeholder="Novabot email" style="flex:1;min-width:200px">
      <input type="password" id="cloud_pass" placeholder="Novabot password" style="flex:1;min-width:200px">
    </div>
    <button class="btn btn-purple" onclick="cloudImport()" id="cloudBtn">Connect &amp; Import</button>
    <div id="cloudResult" style="margin-top:8px"></div>
  </div>
</div>

<script>
let token = localStorage.getItem('admin_token') || '';

async function api(path, method='GET', body=null) {
  const opts = { method, headers: { 'Authorization': token, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch('/api/admin-status' + path, opts);
  if (r.status === 401 || r.status === 403) { logout(); throw new Error('Unauthorized'); }
  return r.json();
}

async function doLogin() {
  const email = document.getElementById('email').value;
  const pass = document.getElementById('pass').value;
  try {
    const r = await fetch('/api/nova-user/appUser/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass }),
    });
    const d = await r.json();
    if (d.code === 200 && (d.data?.token || d.value?.accessToken)) {
      token = d.data?.token || d.value?.accessToken;
      localStorage.setItem('admin_token', token);
      showApp();
    } else {
      document.getElementById('loginErr').textContent = d.msg || 'Login failed';
    }
  } catch(e) {
    document.getElementById('loginErr').textContent = 'Connection error';
  }
}

function logout() {
  token = '';
  localStorage.removeItem('admin_token');
  document.getElementById('login').style.display = 'block';
  document.getElementById('app').style.display = 'none';
}

function dot(on) { return '<span class="dot '+(on?'dot-on':'dot-off')+'"></span>'; }
function ago(ts) {
  if (!ts) return '-';
  const d = new Date(ts+'Z');
  const s = Math.round((Date.now()-d.getTime())/1000);
  if (s<60) return s+'s ago';
  if (s<3600) return Math.round(s/60)+'m ago';
  if (s<86400) return Math.round(s/3600)+'h ago';
  return Math.round(s/86400)+'d ago';
}

async function showApp() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('firstTimeSetup').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  loadAll();
}

async function loadAll() {
  loadAccount();
  loadMyDevices();
}

async function loadAccount() {
  try {
    const d = await api('/overview');
    const s = d.server;
    document.getElementById('serverInfo').textContent = 'uptime ' + s.uptimeFormatted + ' · ' + s.memoryMB + ' MB RAM';
    const u = d.currentUser || {};
    document.getElementById('account').innerHTML =
      '<div class="row"><span class="label">Email</span><span class="value">' + (u.email || '-') + '</span></div>' +
      '<div class="row"><span class="label">Role</span><span class="value"><span class="badge badge-admin">' + (u.is_admin ? 'admin' : 'user') + '</span></span></div>' +
      '<div class="row"><span class="label">Devices</span><span class="value">' + d.counts.equipment + ' registered · ' + d.counts.devices + ' seen</span></div>' +
      '<div class="row"><span class="label">Maps</span><span class="value">' + d.counts.maps + '</span></div>';
  } catch { document.getElementById('account').textContent = 'Failed to load'; }
}

function devRow(dev) {
  const online = dev.is_online;
  const isCharger = dev.device_type === 'charger';
  const icon = isCharger ? '⚡' : '🤖';
  const typeColor = isCharger ? '#f59e0b' : '#00d4aa';
  const typeName = isCharger ? 'Charger' : 'Mower';
  const bound = dev.is_bound;
  let actions = '';
  if (bound) {
    actions = '<button class="btn btn-sm" style="background:#374151;color:#aaa" onclick="unbindDevice(\\'' + dev.sn + '\\')">Unbind</button>';
  } else {
    actions = '<button class="btn btn-sm btn-green" onclick="bindDevice(\\'' + dev.sn + '\\')">Bind</button> ' +
      '<button class="btn btn-sm btn-red" onclick="removeDevice(\\'' + dev.sn + '\\')">Remove</button>';
  }
  return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04);flex-wrap:wrap">' +
    '<span style="color:' + typeColor + ';font-size:13px;min-width:80px">' + icon + ' ' + typeName + '</span>' +
    '<span class="sn" style="flex:1;min-width:120px">' + (dev.sn || '-') + '</span>' +
    '<span>' + dot(online) + (online ? '<span class="on" style="font-size:12px">Online</span>' : '<span class="off" style="font-size:12px">Offline</span>') + '</span>' +
    '<span style="color:#666;font-size:11px;min-width:50px">' + ago(dev.last_seen) + '</span>' +
    '<span style="white-space:nowrap">' + actions + '</span>' +
    '</div>';
}

async function loadMyDevices() {
  try {
    const d = await api('/devices');
    const devs = d.devices || [];
    if (!devs.length) { document.getElementById('myDevices').textContent = 'No devices found. Import from cloud or wait for devices to connect via MQTT.'; return; }

    let html = '';

    // Group by LoRa address
    const byAddr = {};
    const unpaired = [];
    for (const dev of devs) {
      const addr = dev.lora_address;
      if (addr != null) {
        if (!byAddr[addr]) byAddr[addr] = [];
        byAddr[addr].push(dev);
      } else {
        unpaired.push(dev);
      }
    }

    // Render paired sets
    const addrs = Object.keys(byAddr).sort();
    for (const addr of addrs) {
      const group = byAddr[addr];
      const chargers = group.filter(function(d) { return d.device_type === 'charger'; });
      const mowers = group.filter(function(d) { return d.device_type === 'mower'; });
      const anyOnline = group.some(function(d) { return d.is_online; });
      const isPaired = chargers.length > 0 && mowers.length > 0;
      const hasDuplicates = chargers.length > 1 || mowers.length > 1;

      html += '<div style="margin-bottom:12px;padding:12px;background:rgba(255,255,255,.02);border:1px solid ' + (anyOnline ? 'rgba(0,212,170,.2)' : 'rgba(255,255,255,.06)') + ';border-radius:10px">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">';
      html += '<span style="font-size:12px;font-weight:600;color:' + (isPaired ? '#00d4aa' : '#f59e0b') + '">' +
        (isPaired ? '🔗 Paired Set' : '⚡ Charger Only') + '</span>';
      html += '<span style="font-size:11px;color:#666">LoRa ' + addr + '</span>';
      html += '</div>';

      if (!isPaired) {
        html += '<div style="padding:4px 8px;margin-bottom:6px"><span style="color:#888;font-size:11px">' +
          (mowers.length === 0
            ? 'No mower paired on this LoRa address yet. The mower will be linked automatically when it connects, or you can pair it via BLE provisioning.'
            : 'No charger found on this LoRa address. Provision the charger via BLE to link it.') +
          '</span></div>';
      }

      if (hasDuplicates) {
        html += '<div style="padding:6px 10px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);border-radius:6px;margin-bottom:8px">' +
          '<span style="color:#ef4444;font-size:11px;font-weight:600">⚠ Multiple devices on same LoRa address!</span></div>';
      }

      for (const dev of group) {
        html += devRow(dev);
      }
      html += '</div>';
    }

    // Unpaired devices (no LoRa address)
    if (unpaired.length > 0) {
      html += '<div style="margin-bottom:12px;padding:12px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:10px">';
      html += '<div style="margin-bottom:4px"><span style="font-size:12px;font-weight:600;color:#888">New Devices</span></div>';
      html += '<div style="padding:4px 8px;margin-bottom:6px"><span style="color:#888;font-size:11px">' +
        'These devices have connected but have no LoRa pairing yet. ' +
        'They will be paired automatically after BLE provisioning, or when the charger and mower connect on the same LoRa address.' +
        '</span></div>';
      for (const dev of unpaired) {
        html += devRow(dev);
      }
      html += '</div>';
    }

    document.getElementById('myDevices').innerHTML = html;
  } catch { document.getElementById('myDevices').textContent = 'Failed to load'; }
}

function logout() {
  token = '';
  localStorage.removeItem('admin_token');
  location.reload();
}

async function bindDevice(sn) {
  try {
    await api('/bind-device', 'POST', { sn });
    loadMyDevices();
  } catch(e) { alert('Bind failed: ' + e.message); }
}

async function unbindDevice(sn) {
  if (!confirm('Unbind ' + sn + ' from your account?')) return;
  try {
    await api('/unbind-device', 'POST', { sn });
    loadMyDevices();
  } catch(e) { alert('Unbind failed: ' + e.message); }
}

async function removeDevice(sn) {
  if (!confirm('Remove ' + sn + '? This deletes it from the database.')) return;
  try {
    await api('/remove-device', 'POST', { sn });
    loadMyDevices();
  } catch(e) { alert('Remove failed: ' + e.message); }
}

async function cloudImport() {
  const email = document.getElementById('cloud_email').value;
  const pass = document.getElementById('cloud_pass').value;
  const btn = document.getElementById('cloudBtn');
  const result = document.getElementById('cloudResult');
  if (!email || !pass) { result.innerHTML = '<div class="msg err" style="display:block">Enter email and password</div>'; return; }

  btn.disabled = true;
  btn.textContent = 'Connecting...';
  result.innerHTML = '';

  try {
    // Step 1: Login to cloud
    const loginRes = await fetch('/api/setup/cloud-login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({email, password: pass})
    });
    const loginData = await loginRes.json();
    if (!loginData.ok) {
      result.innerHTML = '<div style="color:#ef4444;font-size:13px">' + (loginData.error || 'Login failed') + '</div>';
      btn.disabled = false; btn.textContent = 'Connect & Import';
      return;
    }

    // Show devices found
    const all = loginData.rawList || [];
    let devHtml = '<div style="font-size:12px;color:#00d4aa;margin-bottom:8px">Found ' + all.length + ' device(s)</div>';
    all.forEach(function(d) {
      const sn = d.mowerSn || d.chargerSn || d.sn || '?';
      const type = sn.startsWith('LFIC') ? 'Charger' : sn.startsWith('LFIN') ? 'Mower' : '?';
      devHtml += '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px"><span class="sn">' + sn + '</span><span style="color:#888">' + type + '</span></div>';
    });
    result.innerHTML = devHtml;

    // Step 2: Import each device
    btn.textContent = 'Importing...';
    let imported = 0;
    for (const equip of all) {
      const chargerSn = equip.chargerSn || (equip.sn && equip.sn.startsWith('LFIC') ? equip.sn : null);
      const mowerSn = equip.mowerSn || (equip.sn && equip.sn.startsWith('LFIN') ? equip.sn : null);
      const r = await fetch('/api/setup/cloud-apply', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          email, password: pass,
          deviceName: equip.userCustomDeviceName || equip.equipmentNickName || 'My Novabot',
          charger: chargerSn ? { sn: chargerSn, address: equip.chargerAddress, channel: equip.chargerChannel, mac: equip.macAddress } : undefined,
          mower: mowerSn ? { sn: mowerSn, mac: equip.macAddress, version: equip.sysVersion } : undefined
        })
      });
      const rj = await r.json();
      if (rj.ok) imported++;
      else result.innerHTML += '<div style="color:#ef4444;font-size:12px">Failed to import ' + (mowerSn || chargerSn) + ': ' + (rj.error || 'unknown error') + '</div>';
    }

    result.innerHTML += '<div style="color:#00d4aa;font-size:13px;margin-top:8px;font-weight:600">Imported ' + imported + ' device set(s)!</div>';
    loadMyDevices();
  } catch(e) {
    result.innerHTML = '<div style="color:#ef4444;font-size:13px">Failed: ' + e.message + '</div>';
  }
  btn.disabled = false;
  btn.textContent = 'Connect & Import';
}

async function firstTimeCloudImport() {
  const email = document.getElementById('cloud_email_setup').value;
  const pass = document.getElementById('cloud_pass_setup').value;
  const btn = document.getElementById('setupBtn');
  const result = document.getElementById('setupResult');
  if (!email || !pass) { result.innerHTML = '<p style="color:#ef4444;font-size:12px">Enter email and password</p>'; return; }

  btn.disabled = true;
  btn.textContent = 'Connecting to Novabot cloud...';
  result.innerHTML = '';

  try {
    const loginRes = await fetch('/api/setup/cloud-login', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({email, password: pass})
    });
    const loginData = await loginRes.json();
    if (!loginData.ok) {
      result.innerHTML = '<p style="color:#ef4444;font-size:12px">' + (loginData.error || 'Login failed') + '</p>';
      btn.disabled = false; btn.textContent = 'Connect & Import from Cloud'; return;
    }

    const all = loginData.rawList || [];
    result.innerHTML = '<p style="color:#00d4aa;font-size:12px">Found ' + all.length + ' device(s). Creating account...</p>';
    btn.textContent = 'Importing...';

    // Always create user account (even if no devices found)
    try {
      const createRes = await fetch('/api/setup/cloud-apply', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ email, password: pass })
      });
      const createData = await createRes.json();
      if (!createData.ok && createData.error) {
        result.innerHTML += '<p style="color:#ef4444;font-size:11px">' + createData.error + '</p>';
      }
    } catch(accountErr) {
      console.error('Account create failed:', accountErr);
      result.innerHTML += '<p style="color:#ef4444;font-size:11px">Account creation error: ' + accountErr.message + '</p>';
    }

    for (const equip of all) {
      const chargerSn = equip.chargerSn || (equip.sn && equip.sn.startsWith('LFIC') ? equip.sn : null);
      const mowerSn = equip.mowerSn || (equip.sn && equip.sn.startsWith('LFIN') ? equip.sn : null);
      const applyRes = await fetch('/api/setup/cloud-apply', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          email, password: pass,
          deviceName: equip.userCustomDeviceName || equip.equipmentNickName || 'My Novabot',
          charger: chargerSn ? { sn: chargerSn, address: equip.chargerAddress, channel: equip.chargerChannel, mac: equip.macAddress } : undefined,
          mower: mowerSn ? { sn: mowerSn, mac: equip.macAddress, version: equip.sysVersion } : undefined
        })
      });
      const applyData = await applyRes.json();
      if (applyData.error) {
        result.innerHTML += '<p style="color:#ef4444;font-size:11px">Error: ' + applyData.error + '</p>';
      }
    }

    result.innerHTML += '<p style="color:#00d4aa;font-size:13px;font-weight:600">Setup complete! ' + all.length + ' device(s) imported.</p><p style="color:#888;font-size:12px;margin-top:4px">You can now login with: ' + email + '</p>';
    btn.textContent = 'Done!';
    setTimeout(() => location.reload(), 2000);
  } catch(e) {
    result.innerHTML = '<p style="color:#ef4444;font-size:12px">Failed: ' + e.message + '</p>';
    btn.disabled = false; btn.textContent = 'Connect & Import from Cloud';
  }
}

async function skipSetup() {
  try {
    await fetch('/api/setup/skip', {method:'POST'});
    alert('Local account created!\\nEmail: admin@local\\nPassword: admin');
    location.reload();
  } catch(e) { alert('Failed: ' + e.message); }
}

function showLogin() {
  document.getElementById('login').style.display = 'block';
  document.getElementById('firstTimeSetup').style.display = 'none';
  document.getElementById('app').style.display = 'none';
}

function showSetup() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('firstTimeSetup').style.display = 'block';
  document.getElementById('app').style.display = 'none';
}

// Check if this is first time (no users) or returning user
(async function init() {
  // Always check setup status first (no auth needed)
  let needsSetup = false;
  try {
    const s = await fetch('/api/setup/status');
    const sd = await s.json();
    needsSetup = sd && !sd.setupComplete;
  } catch { /* assume setup complete if endpoint fails */ }

  if (needsSetup) {
    showSetup();
    return;
  }

  // Setup is complete — try auto-login
  if (token) {
    try {
      await api('/overview');
      showApp();
      return;
    } catch {
      token = '';
      localStorage.removeItem('admin_token');
    }
  }

  showLogin();
})();
</script>
</body>
</html>`;
}
