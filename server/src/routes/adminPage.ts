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
  .menu-item{padding:8px 12px;font-size:12px;color:#ccc;cursor:pointer;border-radius:6px;white-space:nowrap}
  .menu-item:hover{background:rgba(255,255,255,.08)}
</style>
</head>
<body>

<!-- Login -->
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

<!-- Admin Panel -->
<div id="app" class="container" style="display:none">
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
      // Deduplicate and label SNs
      const allSns = new Set([...(u.mower_sns||'').split(','), ...(u.charger_sns||'').split(',')].filter(Boolean));
      let snHtml = '';
      for (const sn of allSns) {
        const isCharger = sn.startsWith('LFIC');
        const color = isCharger ? '#f59e0b' : '#00d4aa';
        const label = isCharger ? 'C' : 'M';
        snHtml += '<span style="display:inline-block;margin:2px 4px 2px 0;padding:2px 8px;border-radius:6px;font-size:11px;font-family:monospace;background:rgba(255,255,255,.05);border:1px solid ' + color + '33"><span style="color:' + color + ';font-weight:700;margin-right:4px">' + label + '</span>' + sn + '</span>';
      }
      html += '<tr>' +
        '<td>' + u.email + '</td>' +
        '<td>' + (snHtml || '<span style="color:#666">-</span>') + '</td>' +
        '<td><span class="badge ' + badgeClass + '">' + role + '</span></td>' +
        '<td style="color:#666">' + ago(u.created_at) + '</td>' +
        '<td><div style="position:relative;display:inline-block">' +
          '<button class="btn btn-sm" style="background:#374151;color:#ccc" onclick="toggleMenu(this)">⋯</button>' +
          '<div class="action-menu" style="display:none;position:absolute;right:0;top:28px;background:#1e293b;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:6px;min-width:160px;z-index:50;box-shadow:0 8px 30px rgba(0,0,0,.5)">' +
            (u.is_admin ? '' : '<div class="menu-item" onclick="closeMenus();setRole(\\'' + u.app_user_id + '\\',\\'dashboard_access\\',true)">Grant Dashboard</div>') +
            (u.is_admin ? '' : '<div class="menu-item" onclick="closeMenus();setRole(\\'' + u.app_user_id + '\\',\\'is_admin\\',true)">Grant Admin</div>') +
            (u.is_admin ? '<div class="menu-item" onclick="closeMenus();setRole(\\'' + u.app_user_id + '\\',\\'is_admin\\',false)">Remove Admin</div>' : '') +
            (u.dashboard_access && !u.is_admin ? '<div class="menu-item" onclick="closeMenus();setRole(\\'' + u.app_user_id + '\\',\\'dashboard_access\\',false)">Remove Dashboard</div>' : '') +
            '<div class="menu-item" onclick="closeMenus();resetPw(\\'' + u.app_user_id + '\\',\\'' + u.email + '\\')">Reset Password</div>' +
            '<div class="menu-item" style="color:#ef4444" onclick="closeMenus();deleteUser(\\'' + u.app_user_id + '\\',\\'' + u.email + '\\')">Delete User</div>' +
          '</div></div></td></tr>';
    }
    html += '</table>';

    // Show unbound equipment warning
    if (d.unboundCount > 0) {
      html += '<div style="margin-top:12px;padding:10px 14px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);border-radius:8px">' +
        '<span class="warn" style="font-size:12px;font-weight:600">' + d.unboundCount + ' unbound device(s)</span>' +
        '<span style="color:#888;font-size:12px"> — not linked to any user account</span></div>';

      html += '<table style="margin-top:8px"><tr><th>Mower SN</th><th>Charger SN</th><th>Name</th></tr>';
      for (const eq of d.allEquipment) {
        if (eq.user_id) continue;
        html += '<tr><td class="sn">' + (eq.mower_sn || '-') + '</td>' +
          '<td class="sn">' + (eq.charger_sn || '-') + '</td>' +
          '<td style="color:#888">' + (eq.equipment_nick_name || '-') + '</td></tr>';
      }
      html += '</table>';
    }

    document.getElementById('users').innerHTML = html;
  } catch { document.getElementById('users').textContent = 'Failed to load'; }
}

async function setRole(userId, role, enabled) {
  await api('/set-role', 'POST', { userId, role, enabled });
  loadUsers();
}

// ── Action menu ──
function toggleMenu(btn) {
  closeMenus();
  const menu = btn.nextElementSibling;
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  event.stopPropagation();
}
function closeMenus() {
  document.querySelectorAll('.action-menu').forEach(function(m) { m.style.display = 'none'; });
}
document.addEventListener('click', closeMenus);

// ── Inline modal system ──
function showModal(title, body, onConfirm) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:999';
  const modal = document.createElement('div');
  modal.style.cssText = 'background:#16213e;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:24px;max-width:380px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.5)';
  modal.innerHTML = '<h3 style="color:#fff;font-size:16px;margin-bottom:8px">' + title + '</h3>' +
    '<div style="color:#aaa;font-size:13px;margin-bottom:20px">' + body + '</div>' +
    '<div id="modal-actions" style="display:flex;gap:8px;justify-content:flex-end"></div>';
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) { overlay.remove(); } });

  const actions = modal.querySelector('#modal-actions');
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn'; cancelBtn.style.cssText = 'background:#374151;color:#ccc;padding:8px 20px';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = function() { overlay.remove(); };
  actions.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-purple'; confirmBtn.style.padding = '8px 20px';
  confirmBtn.textContent = 'Confirm';
  confirmBtn.onclick = function() { overlay.remove(); onConfirm(); };
  actions.appendChild(confirmBtn);

  return { overlay, modal, actions };
}

function showInputModal(title, placeholder, onSubmit) {
  const { modal, actions } = showModal(title, '<input id="modal-input" type="text" placeholder="' + placeholder + '" style="width:100%;margin-top:4px">', function() {
    const val = document.getElementById('modal-input').value;
    onSubmit(val);
  });
  setTimeout(function() { const inp = document.getElementById('modal-input'); if(inp) inp.focus(); }, 100);
}

function showToast(msg, isError) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:500;z-index:1000;transition:opacity .3s;' +
    (isError ? 'background:#991b1b;color:#fca5a5' : 'background:#065f46;color:#6ee7b7');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function() { t.style.opacity = '0'; setTimeout(function() { t.remove(); }, 300); }, 3000);
}

async function deleteUser(userId, email) {
  showModal('Delete User', 'Are you sure you want to delete <strong style="color:#fff">' + email + '</strong>? This cannot be undone.', async function() {
    try {
      await api('/delete-user', 'POST', { userId });
      showToast('User ' + email + ' deleted');
      loadUsers();
    } catch(e) { showToast('Failed: ' + e.message, true); }
  });
  // Style confirm button red for destructive action
  setTimeout(function() { const btns = document.querySelectorAll('.btn-purple'); const last = btns[btns.length-1]; if(last) { last.className='btn btn-red'; last.textContent='Delete'; } }, 10);
}

async function resetPw(userId, email) {
  showInputModal('Reset Password for ' + email, 'Enter new password...', async function(pw) {
    if (!pw || pw.length < 4) { showToast('Password must be at least 4 characters', true); return; }
    try {
      await api('/reset-password', 'POST', { userId, newPassword: pw });
      showToast('Password reset for ' + email);
    } catch(e) { showToast('Failed: ' + e.message, true); }
  });
}

async function loadDevices() {
  try {
    const d = await api('/devices');
    if (!d.devices?.length) { document.getElementById('devices').textContent = 'No devices'; return; }
    let html = '<table><tr><th>SN</th><th>Type</th><th>MAC</th><th>Status</th><th>Last Seen</th><th>Name</th></tr>';
    for (const dev of d.devices) {
      const online = dev.is_online;
      const typeColor = dev.device_type === 'charger' ? '#f59e0b' : dev.device_type === 'mower' ? '#00d4aa' : '#666';
      html += '<tr>' +
        '<td class="sn">' + (dev.sn || dev.mqtt_client_id) + '</td>' +
        '<td><span style="color:' + typeColor + '">' + (dev.device_type || '-') + '</span></td>' +
        '<td class="sn">' + (dev.mac_address || '-') + '</td>' +
        '<td>' + dot(online) + (online ? '<span class="on">Online</span>' : '<span class="off">Offline</span>') + '</td>' +
        '<td style="color:#666">' + ago(dev.last_seen) + '</td>' +
        '<td style="color:#888">' + (dev.equipment_nick_name || '-') + '</td>' +
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
    let html = '<table><tr><th>Type</th><th>SN</th><th>Name</th><th>User</th><th>MAC</th></tr>';
    for (const eq of d.equipment) {
      const typeColor = eq.device_type === 'Charging station' ? '#f59e0b' : '#00d4aa';
      const sn = eq.display_mower_sn || eq.display_charger_sn || eq.mower_sn || '-';
      html += '<tr>' +
        '<td><span style="color:' + typeColor + '">' + eq.device_type + '</span></td>' +
        '<td class="sn">' + sn + '</td>' +
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
    token = '';
    localStorage.removeItem('admin_token');
    document.getElementById('login').style.display = 'block';
    document.getElementById('app').style.display = 'none';
  });
} else {
  document.getElementById('login').style.display = 'block';
  document.getElementById('app').style.display = 'none';
}
</script>
</body>
</html>`;
}
