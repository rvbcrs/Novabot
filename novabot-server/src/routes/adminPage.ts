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
  .row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04)}
  .row:last-child{border-bottom:none}
  .label{color:#888;font-size:13px}
  .value{font-size:13px;font-weight:600}
  .on{color:#00d4aa}
  .off{color:#ef4444}
  .warn{color:#f59e0b}
  .sn{color:#a78bfa;font-family:monospace;font-size:12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:8px 6px;border-bottom:1px solid rgba(255,255,255,.1)}
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
  .login-box{max-width:360px;margin:80px auto}
  .tabs{display:flex;gap:4px;margin-bottom:16px}
  .tab{padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;background:rgba(255,255,255,.05);color:#888;border:none}
  .tab.active{background:#7c3aed;color:#fff}
  #app{display:none}
  .refresh-btn{float:right;cursor:pointer;color:#666;font-size:12px}
  .refresh-btn:hover{color:#00d4aa}
</style>
</head>
<body>

<!-- Login -->
<div id="login" class="login-box">
  <div class="card" style="text-align:center;padding:32px">
    <h1 style="margin-bottom:16px">OpenNova Admin</h1>
    <p style="color:#666;font-size:13px;margin-bottom:24px">Login with your OpenNova account</p>
    <input id="email" type="email" placeholder="Email" style="margin-bottom:10px"><br>
    <input id="pass" type="password" placeholder="Password" style="margin-bottom:16px"><br>
    <button class="btn btn-purple" style="width:100%;padding:12px" onclick="doLogin()">Login</button>
    <p id="loginErr" style="color:#ef4444;font-size:12px;margin-top:10px"></p>
  </div>
</div>

<!-- Admin Panel -->
<div id="app" class="container">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
    <div>
      <h1>OpenNova Admin</h1>
      <div class="version" id="serverInfo">Loading...</div>
    </div>
    <button class="btn btn-purple" onclick="location.reload()">↻ Refresh</button>
  </div>

  <!-- Overview -->
  <div class="card">
    <h2>Server</h2>
    <div id="overview">Loading...</div>
  </div>

  <!-- Users -->
  <div class="card">
    <h2>Users <span class="refresh-btn" onclick="loadUsers()">↻</span></h2>
    <div id="users">Loading...</div>
  </div>

  <!-- Devices -->
  <div class="card">
    <h2>Devices <span class="refresh-btn" onclick="loadDevices()">↻</span></h2>
    <div id="devices">Loading...</div>
  </div>

  <!-- Equipment -->
  <div class="card">
    <h2>Equipment <span class="refresh-btn" onclick="loadEquipment()">↻</span></h2>
    <div id="equipment">Loading...</div>
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
    if (d.code === 200 && d.data?.token) {
      token = d.data.token;
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
  document.getElementById('app').style.display = 'block';
  loadOverview();
  loadUsers();
  loadDevices();
  loadEquipment();
}

async function loadOverview() {
  try {
    const d = await api('/overview');
    const s = d.server;
    document.getElementById('serverInfo').textContent = s.nodeVersion + ' · ' + s.platform + ' · uptime ' + s.uptimeFormatted;
    document.getElementById('overview').innerHTML =
      '<div class="row"><span class="label">Uptime</span><span class="value">' + s.uptimeFormatted + '</span></div>' +
      '<div class="row"><span class="label">Memory</span><span class="value">' + s.memoryMB + ' MB (heap: ' + s.heapUsedMB + ' MB)</span></div>' +
      '<div class="row"><span class="label">Database</span><span class="value">' + s.dbSizeMB + ' MB</span></div>' +
      '<div class="row"><span class="label">Users</span><span class="value">' + d.counts.users + '</span></div>' +
      '<div class="row"><span class="label">Equipment</span><span class="value">' + d.counts.equipment + '</span></div>' +
      '<div class="row"><span class="label">Devices seen</span><span class="value">' + d.counts.devices + '</span></div>' +
      '<div class="row"><span class="label">Maps</span><span class="value">' + d.counts.maps + '</span></div>';
  } catch { document.getElementById('overview').textContent = 'Failed to load'; }
}

async function loadUsers() {
  try {
    const d = await api('/users');
    if (!d.users?.length) { document.getElementById('users').textContent = 'No users'; return; }
    let html = '<table><tr><th>Email</th><th>SNs</th><th>Role</th><th>Registered</th><th>Actions</th></tr>';
    for (const u of d.users) {
      const role = u.is_admin ? 'admin' : u.dashboard_access ? 'dashboard' : 'user';
      const badgeClass = u.is_admin ? 'badge-admin' : u.dashboard_access ? 'badge-dash' : 'badge-user';
      const sns = [u.mower_sns, u.charger_sns].filter(Boolean).join(', ') || '-';
      html += '<tr>' +
        '<td>' + u.email + '</td>' +
        '<td class="sn">' + sns + '</td>' +
        '<td><span class="badge ' + badgeClass + '">' + role + '</span></td>' +
        '<td style="color:#666">' + ago(u.created_at) + '</td>' +
        '<td>' +
          (u.is_admin ? '' : '<button class="btn btn-sm btn-green" onclick="setRole(\\'' + u.app_user_id + '\\',\\'dashboard_access\\',true)">+ Dash</button> ') +
          (u.is_admin ? '' : '<button class="btn btn-sm btn-purple" onclick="setRole(\\'' + u.app_user_id + '\\',\\'is_admin\\',true)">+ Admin</button> ') +
          (u.is_admin ? '<button class="btn btn-sm btn-red" onclick="setRole(\\'' + u.app_user_id + '\\',\\'is_admin\\',false)">- Admin</button>' : '') +
        '</td></tr>';
    }
    html += '</table>';
    document.getElementById('users').innerHTML = html;
  } catch { document.getElementById('users').textContent = 'Failed to load'; }
}

async function setRole(userId, role, enabled) {
  await api('/set-role', 'POST', { userId, role, enabled });
  loadUsers();
}

async function loadDevices() {
  try {
    const d = await api('/devices');
    if (!d.devices?.length) { document.getElementById('devices').textContent = 'No devices'; return; }
    let html = '<table><tr><th>SN</th><th>MAC</th><th>Status</th><th>Last Seen</th><th>User</th></tr>';
    for (const dev of d.devices) {
      const online = dev.is_online;
      html += '<tr>' +
        '<td class="sn">' + (dev.sn || dev.mqtt_client_id) + '</td>' +
        '<td class="sn">' + (dev.mac_address || '-') + '</td>' +
        '<td>' + dot(online) + (online ? '<span class="on">Online</span>' : '<span class="off">Offline</span>') + '</td>' +
        '<td style="color:#666">' + ago(dev.last_seen) + '</td>' +
        '<td style="color:#888">' + (dev.equipment_nick_name || dev.user_id || '-') + '</td>' +
        '</tr>';
    }
    html += '</table>';
    document.getElementById('devices').innerHTML = html;
  } catch { document.getElementById('devices').textContent = 'Failed to load'; }
}

async function loadEquipment() {
  try {
    const d = await api('/equipment');
    if (!d.equipment?.length) { document.getElementById('equipment').textContent = 'No equipment'; return; }
    let html = '<table><tr><th>Mower SN</th><th>Charger SN</th><th>Name</th><th>User</th><th>MAC</th></tr>';
    for (const eq of d.equipment) {
      html += '<tr>' +
        '<td class="sn">' + (eq.mower_sn || '-') + '</td>' +
        '<td class="sn">' + (eq.charger_sn || '-') + '</td>' +
        '<td>' + (eq.equipment_nick_name || '-') + '</td>' +
        '<td style="color:#888">' + (eq.user_email || '-') + '</td>' +
        '<td class="sn">' + (eq.mac_address || '-') + '</td>' +
        '</tr>';
    }
    html += '</table>';
    document.getElementById('equipment').innerHTML = html;
  } catch { document.getElementById('equipment').textContent = 'Failed to load'; }
}

// Auto-login if token exists
if (token) {
  api('/overview').then(() => showApp()).catch(() => {
    document.getElementById('login').style.display = 'block';
  });
} else {
  document.getElementById('login').style.display = 'block';
}
</script>
</body>
</html>`;
}
