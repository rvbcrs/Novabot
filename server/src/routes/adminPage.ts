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
<link rel="icon" type="image/png" href="/assets/OpenNova.png">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#030712;color:#e0e0e0;min-height:100vh}
  .modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);z-index:1000;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s}
  .modal-overlay.show{opacity:1}
  .modal-box{background:#1a1a2e;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:24px;max-width:400px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .modal-title{font-size:16px;font-weight:700;color:#fff;margin-bottom:8px}
  .modal-msg{font-size:13px;color:#aaa;margin-bottom:20px;line-height:1.5;word-break:break-word}
  .modal-btns{display:flex;gap:8px;justify-content:flex-end}
  .modal-btn{padding:8px 20px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s}
  .modal-btn:hover{opacity:.85}
  .modal-btn-cancel{background:rgba(255,255,255,.08);color:#aaa}
  .modal-btn-ok{background:#7c3aed;color:#fff}
  .modal-btn-danger{background:#ef4444;color:#fff}
  .modal-btn-success{background:#22c55e;color:#fff}
  .container{max-width:900px;margin:0 auto;padding:20px}
  h1{color:#00d4aa;font-size:24px;margin-bottom:4px}
  h2{color:#7c3aed;font-size:14px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
  .version{color:#666;font-size:12px;margin-bottom:24px}
  .card{background:#16213e;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid rgba(255,255,255,.08)}
  .row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04);flex-wrap:wrap;gap:4px}
  .row:last-child{border-bottom:none}
  .label{color:#aaa;font-size:13px}
  .value{font-size:13px;font-weight:600;text-align:right;word-break:break-all}
  .on{color:#00d4aa}
  .off{color:#ef4444}
  .warn{color:#f59e0b}
  .sn{color:#a78bfa;font-family:monospace;font-size:12px;word-break:break-all}
  .table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
  table{width:100%;border-collapse:collapse;font-size:13px;min-width:400px}
  th{text-align:left;color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:8px 6px;border-bottom:1px solid rgba(255,255,255,.1);white-space:nowrap}
  td{padding:8px 6px;border-bottom:1px solid rgba(255,255,255,.04)}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
  .dot-on{background:#00d4aa}
  .dot-off{background:#ef4444}
  .pulse-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#f59e0b;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
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
  .tab{padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;background:rgba(255,255,255,.05);color:#aaa;border:none}
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
  .ota-progress-bar{width:100%;height:8px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden}
  .ota-progress-fill{height:100%;background:#00d4aa;border-radius:4px;transition:width .5s ease}
</style>
</head>
<body>

<!-- Login (hidden when first-time setup is shown) -->
<div id="login" class="login-box" style="display:none">
  <div class="card" style="text-align:center;padding:32px">
    <h1 style="margin-bottom:16px">OpenNova Admin</h1>
    <p style="color:#666;font-size:13px;margin-bottom:24px">Login with your OpenNova account</p>
    <form onsubmit="event.preventDefault(); doLogin();">
      <input id="email" type="email" placeholder="Email" style="margin-bottom:10px"><br>
      <input id="pass" type="password" placeholder="Password" style="margin-bottom:16px"><br>
      <button type="submit" class="btn btn-purple" style="width:100%;padding:12px">Login</button>
    </form>
    <p id="loginErr" style="color:#ef4444;font-size:12px;margin-top:10px"></p>
  </div>
</div>

<!-- First-time setup (shown instead of login when DB is empty) -->
<div id="firstTimeSetup" class="login-box" style="display:none">
  <div class="card" style="padding:20px 24px;max-width:420px;margin:0 auto">
    <div style="text-align:center;margin-bottom:12px">
      <img src="/assets/OpenNova.png" alt="OpenNova" style="width:200px;margin:0">
      <p style="font-size:13px;color:#888;margin:2px 0 0 0">Your local cloud replacement for Novabot</p>
    </div>

    <div style="background:rgba(0,212,170,.06);border:1px solid rgba(0,212,170,.15);border-radius:8px;padding:14px;margin-bottom:20px">
      <p style="font-size:12px;color:#aaa;margin:0 0 8px 0;font-weight:600;color:#00d4aa">First-time setup</p>
      <p style="font-size:12px;color:#999;margin:0;line-height:1.5">Sign in with your <b style="color:#ccc">Novabot app</b> account. This will:</p>
      <ul style="font-size:12px;color:#999;margin:8px 0 0 0;padding-left:18px;line-height:1.8">
        <li>Create your local admin account</li>
        <li>Import your devices (charger + mower)</li>
        <li>Download your maps from the cloud</li>
        <li>Auto-pair devices that are already online</li>
      </ul>
    </div>

    <input type="email" id="cloud_email_setup" placeholder="Novabot app email" style="margin-bottom:8px">
    <input type="password" id="cloud_pass_setup" placeholder="Novabot app password" style="margin-bottom:14px">
    <button class="btn btn-green" style="width:100%;padding:12px;font-size:14px" onclick="firstTimeCloudImport()" id="setupBtn">Connect &amp; Import from Cloud</button>
    <div id="setupResult" style="margin-top:12px"></div>

    <div style="text-align:center;color:#333;margin:18px 0;font-size:11px">&#8212; or &#8212;</div>
    <button class="btn" style="width:100%;padding:10px;background:#252535;color:#777;font-size:12px" onclick="skipSetup()">Skip cloud import &#8212; create local account only</button>
    <p style="font-size:10px;color:#444;margin-top:6px;text-align:center">You can always import from cloud later in Settings</p>
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

  <!-- Tabs -->
  <div class="tabs">
    <button class="tab active" onclick="switchTab('devices')">Devices</button>
    <button class="tab" onclick="switchTab('console')">Console</button>
    <button class="tab" onclick="switchTab('maps')">Maps</button>
    <button class="tab" onclick="switchTab('firmware')">Firmware</button>
    <button class="tab" onclick="switchTab('settings')">Settings</button>
  </div>

  <!-- Tab: Devices -->
  <div id="tab_devices">
    <div class="card">
      <h2>My Devices <span class="refresh-btn" onclick="loadMyDevices()">↻</span> <span id="deviceActivity" style="display:none;font-size:12px;font-weight:400;color:#f59e0b;margin-left:8px"><span class="pulse-dot"></span> <span id="deviceActivityText">discovering...</span></span></h2>
      <div id="myDevices">Loading...</div>
    </div>
  </div>

  <!-- Tab: Console -->
  <div id="tab_console" style="display:none">
    <div class="card" style="padding:0;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.06);flex-wrap:wrap;gap:6px">
        <h2 style="margin:0">Server Console</h2>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <div style="display:flex;gap:8px;align-items:center;background:rgba(255,255,255,.04);border-radius:6px;padding:4px 10px">
            <label style="font-size:11px;cursor:pointer;display:flex;align-items:center;gap:3px"><input type="checkbox" id="f_mower" checked onchange="applyFilter()"><span style="color:#22c55e">Mower</span></label>
            <label style="font-size:11px;cursor:pointer;display:flex;align-items:center;gap:3px"><input type="checkbox" id="f_charger" checked onchange="applyFilter()"><span style="color:#eab308">Charger</span></label>
            <label style="font-size:11px;cursor:pointer;display:flex;align-items:center;gap:3px"><input type="checkbox" id="f_app" checked onchange="applyFilter()"><span style="color:#3b82f6">App</span></label>
            <label style="font-size:11px;cursor:pointer;display:flex;align-items:center;gap:3px"><input type="checkbox" id="f_http" checked onchange="applyFilter()"><span style="color:#c084fc">HTTP</span></label>
            <label style="font-size:11px;cursor:pointer;display:flex;align-items:center;gap:3px"><input type="checkbox" id="f_system" checked onchange="applyFilter()"><span style="color:#aaa">System</span></label>
          </div>
          <div style="display:flex;gap:4px;align-items:center">
            <button onclick="mqttLogs=[];renderLogs()" style="background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.2);border-radius:6px;padding:4px 12px;font-size:11px;cursor:pointer">Clear</button>
            <button onclick="copyConsole()" style="background:rgba(59,130,246,.15);color:#60a5fa;border:1px solid rgba(59,130,246,.2);border-radius:6px;padding:4px 12px;font-size:11px;cursor:pointer">Copy</button>
          </div>
          <label style="font-size:11px;color:#aaa;cursor:pointer;display:flex;align-items:center;gap:3px"><input type="checkbox" id="f_autoscroll" checked>Auto-scroll</label>
        </div>
      </div>
      <div style="padding:6px 12px;border-bottom:1px solid rgba(255,255,255,.06)">
        <input id="f_search" type="text" placeholder="Search (e.g. start_run, error, LFIN...)" oninput="renderLogs()" style="width:100%;padding:6px 10px;font-size:12px;background:#0d0d20;border:1px solid #333;border-radius:6px;color:#fff">
      </div>
      <div id="mqttConsole" style="height:calc(100vh - 320px);min-height:300px;overflow-y:auto;font-family:monospace;font-size:11px;padding:8px;background:#0a0a1a;line-height:1.6;word-break:break-all"></div>
    </div>
  </div>

  <!-- Tab: Maps -->
  <div id="tab_maps" style="display:none">
    <div class="card">
      <h2>Map Viewer <span class="refresh-btn" onclick="loadMaps()">↻</span></h2>
      <div style="padding:8px 12px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.15);border-radius:6px;margin-bottom:12px;font-size:11px;color:#d97706">Maps stored here are for <b>preview and app display only</b>. They are not synced to the mower. To mow, the mower needs its own maps created via the Novabot app mapping function.</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <select id="mapMowerSelect" onchange="loadMaps()" style="flex:1;padding:8px 12px;background:#0d0d20;border:1px solid #333;border-radius:8px;color:#fff;font-size:13px">
          <option value="">Select a mower...</option>
        </select>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <input type="file" id="mapZipFile" accept=".zip" style="flex:1;min-width:180px;padding:6px 10px;background:#0d0d20;border:1px solid #333;border-radius:8px;color:#fff;font-size:12px">
        <button onclick="uploadMapZip()" style="padding:8px 16px;background:rgba(124,58,237,.2);color:#a78bfa;border:1px solid rgba(124,58,237,.3);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">Import ZIP</button>
      </div>
      <div id="mapUploadStatus" style="font-size:12px;margin-bottom:8px;display:none"></div>
      <div id="mapInfo" style="font-size:12px;color:#aaa;margin-bottom:8px"></div>
      <div style="background:#0a0a1a;border:1px solid rgba(255,255,255,.06);border-radius:8px;overflow:hidden;position:relative">
        <canvas id="mapCanvas" width="800" height="600" style="width:100%;display:block;background:#0a0a1a"></canvas>
      </div>
      <div id="mapLegend" style="display:none;margin-top:10px;display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:#aaa">
        <span><span style="display:inline-block;width:12px;height:12px;background:rgba(34,197,94,.3);border:2px solid #166534;border-radius:2px;vertical-align:middle;margin-right:4px"></span>Work area</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:rgba(239,68,68,.3);border:2px solid #991b1b;border-radius:2px;vertical-align:middle;margin-right:4px"></span>Obstacle</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:transparent;border:2px solid #3b82f6;border-radius:2px;vertical-align:middle;margin-right:4px"></span>Channel</span>
        <span><span style="display:inline-block;width:12px;height:12px;background:#f59e0b;border-radius:50%;vertical-align:middle;margin-right:4px"></span>Charger</span>
      </div>
      <div id="mapList" style="margin-top:12px"></div>
    </div>
  </div>

  <!-- Tab: Firmware -->
  <div id="tab_firmware" style="display:none">
    <div class="card">
      <div style="margin-bottom:16px;padding:12px;background:rgba(0,212,170,.04);border:1px solid rgba(0,212,170,.1);border-radius:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <span style="font-weight:600;color:#00d4aa">Firmware Updates</span>
            <span id="fwUpdateStatus" style="margin-left:8px;font-size:12px;color:#aaa"></span>
          </div>
          <button onclick="checkFirmwareUpdates()" id="fwCheckBtn" class="btn" style="padding:6px 14px;font-size:12px">Check for Updates</button>
        </div>
        <div id="fwUpdatesAvailable" style="margin-top:8px;display:none"></div>
      </div>
      <h2>Available Firmware <span class="refresh-btn" onclick="syncAndLoadFirmware()">&#x21BB;</span></h2>
      <div class="table-wrap">
        <table id="fwTable">
          <thead><tr><th>Version</th><th>Device</th><th>MD5</th><th>Notes</th><th></th></tr></thead>
          <tbody id="fwTableBody"><tr><td colspan="5" style="color:#aaa">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Update Device</h2>
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <select id="otaDeviceSelect" onchange="onOtaDeviceChange()" style="flex:1;min-width:180px;padding:8px 12px;background:#0d0d20;border:1px solid #333;border-radius:8px;color:#fff;font-size:13px">
          <option value="">Select device...</option>
        </select>
        <select id="otaVersionSelect" style="flex:1;min-width:180px;padding:8px 12px;background:#0d0d20;border:1px solid #333;border-radius:8px;color:#fff;font-size:13px">
          <option value="">Select version...</option>
        </select>
      </div>
      <div id="otaCurrentVersion" style="font-size:12px;color:#aaa;margin-bottom:12px"></div>
      <button class="btn btn-purple" onclick="startOtaUpdate()" style="padding:8px 20px">Start Update</button>

      <div id="otaProgress" style="display:none;margin-top:16px;padding:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span id="otaStatusText" style="font-size:13px;font-weight:600;color:#aaa">Waiting...</span>
          <span id="otaPctText" style="font-size:13px;font-weight:600;color:#00d4aa">0%</span>
        </div>
        <div class="ota-progress-bar"><div class="ota-progress-fill" id="otaProgressFill" style="width:0%"></div></div>
      </div>
    </div>
  </div>

  <!-- Tab: Settings -->
  <div id="tab_settings" style="display:none">
    <div class="card">
      <h2>Account</h2>
      <div id="account">Loading...</div>
    </div>

    <div class="card">
      <h2>Network &amp; DNS</h2>
      <p style="font-size:12px;color:#aaa;margin-bottom:12px">Check that DNS is configured correctly so the Novabot app and mower connect to this server instead of the cloud.</p>
      <div id="dnsResults" style="margin-bottom:12px;font-size:12px">
        <div style="color:#aaa">Checking DNS...</div>
      </div>
      <div style="margin-bottom:12px;padding:8px 12px;background:rgba(255,255,255,.03);border-radius:6px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="color:#ddd;font-weight:600;font-size:12px">Built-in DNS Server (dnsmasq)</div>
          <div style="color:#aaa;font-size:11px">Redirects *.lfibot.com to this server. Point your router DNS here to use.</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span id="dnsmasqStatus" style="font-size:11px;color:#aaa">...</span>
          <button id="dnsmasqBtn" onclick="toggleDnsmasq()" class="btn" style="font-size:11px;padding:4px 12px;min-width:60px">...</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-purple" onclick="checkDns()">Re-check DNS</button>
      </div>
    </div>

    <div class="card">
      <h2>Certificate Setup</h2>
      <p style="font-size:12px;color:#aaa;margin-bottom:12px">
        The official Novabot app requires HTTPS with a trusted certificate. Install the OpenNova CA certificate on your phone to trust the server.
      </p>
      <div style="background:rgba(124,58,237,.08);border:1px solid rgba(124,58,237,.2);border-radius:8px;padding:12px;margin-bottom:12px">
        <p style="font-size:13px;color:#c4b5fd;margin:0 0 8px 0;font-weight:600">How to install:</p>
        <ol style="font-size:12px;color:#a0a0a0;margin:0;padding-left:20px;line-height:1.8">
          <li>Tap the download button below on your iPhone/iPad</li>
          <li>Go to <b style="color:#e0e0e0">Settings → General → VPN & Device Management</b></li>
          <li>Tap the <b style="color:#e0e0e0">OpenNova</b> profile → <b style="color:#e0e0e0">Install</b></li>
          <li>Go to <b style="color:#e0e0e0">Settings → General → About → Certificate Trust Settings</b></li>
          <li>Enable <b style="color:#e0e0e0">OpenNova CA Certificate</b></li>
        </ol>
      </div>
      <a href="/api/setup/profile" class="btn btn-purple" style="display:block;text-align:center;text-decoration:none">Download iOS Profile (.mobileconfig)</a>
      <p style="font-size:11px;color:#666;margin-top:8px;text-align:center">
        On Android: download the certificate and install it via Settings → Security → Install certificate → CA certificate.
      </p>
    </div>

    <div class="card">
      <h2>Cloud Import</h2>
      <p style="font-size:12px;color:#aaa;margin-bottom:12px">Import devices from the Novabot cloud using your Novabot app credentials.</p>
      <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <input type="email" id="cloud_email" placeholder="Novabot email" style="flex:1;min-width:200px">
        <input type="password" id="cloud_pass" placeholder="Novabot password" style="flex:1;min-width:200px">
      </div>
      <button class="btn btn-purple" onclick="cloudImport()" id="cloudBtn">Connect &amp; Import</button>
      <div id="cloudResult" style="margin-top:8px"></div>
    </div>

    <div class="card" style="border:1px solid rgba(239,68,68,.3);background:rgba(239,68,68,.04)">
      <h2 style="color:#ef4444">Danger Zone</h2>
      <p style="font-size:12px;color:#aaa;margin-bottom:12px">Permanently delete all data and start fresh. This removes your account, all devices, maps, and settings. This action cannot be undone.</p>
      <button class="btn btn-red" style="background:#dc2626" onclick="factoryReset()">Factory Reset</button>
    </div>
  </div>
</div>

<script src="/socket.io/socket.io.js" onerror="
  // Socket.io not available on this port — try main server port
  var s=document.createElement('script');
  s.src=location.protocol+'//'+location.hostname+':${process.env.PORT ?? '3000'}/socket.io/socket.io.js';
  document.head.appendChild(s);
"></script>
<script>
let token = localStorage.getItem('admin_token') || '';

// Modern modal dialogs (replaces alert/confirm)
function showModal(title, msg, buttons) {
  return new Promise(function(resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    var box = document.createElement('div');
    box.className = 'modal-box';
    box.innerHTML = '<div class="modal-title">' + title + '</div><div class="modal-msg">' + msg + '</div>';
    var btns = document.createElement('div');
    btns.className = 'modal-btns';
    buttons.forEach(function(b) {
      var btn = document.createElement('button');
      btn.className = 'modal-btn ' + (b.cls || 'modal-btn-ok');
      btn.textContent = b.text;
      btn.onclick = function() { overlay.classList.remove('show'); setTimeout(function() { overlay.remove(); }, 200); resolve(b.value); };
      btns.appendChild(btn);
    });
    box.appendChild(btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(function() { overlay.classList.add('show'); });
  });
}
function modalAlert(title, msg) {
  return showModal(title, msg, [{ text: 'OK', value: true, cls: 'modal-btn-ok' }]);
}
function modalConfirm(title, msg) {
  return showModal(title, msg, [
    { text: 'Cancel', value: false, cls: 'modal-btn-cancel' },
    { text: 'Confirm', value: true, cls: 'modal-btn-danger' },
  ]);
}
let currentTab = 'devices';

function switchTab(name) {
  currentTab = name;
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
  // Activate clicked tab
  var names = ['devices','console','maps','firmware','settings'];
  for (var i = 0; i < names.length; i++) {
    document.getElementById('tab_' + names[i]).style.display = names[i] === name ? '' : 'none';
    if (names[i] === name) tabs[i].classList.add('active');
  }
  // Auto-check DNS + dnsmasq when switching to settings
  if (name === 'settings') { checkDns(); checkDnsmasqStatus(); }
  // Load maps when switching to maps tab
  if (name === 'maps') { populateMowerDropdown(); }
  if (name === 'firmware') { loadFirmwareVersions(); populateOtaDeviceDropdown(); }
}

// ── MQTT Console ──────────────────────────────────────────────────
let mqttLogs = [];
const MAX_CONSOLE_LINES = 500;

function classifyLog(entry) {
  if (!entry) return 'system';
  var t = entry.type || '';
  if (t === 'http-req' || t === 'http-res') return 'http';
  var cid = (entry.clientId || '') + (entry.sn || '') + (entry.topic || '');
  if (cid.indexOf('LFIN') >= 0) return 'mower';
  if (cid.indexOf('LFIC') >= 0 || cid.indexOf('ESP32') >= 0) return 'charger';
  if (entry.clientType === 'APP' || cid.indexOf('@') >= 0 || cid.indexOf('eyJ') >= 0) return 'app';
  return 'system';
}

function logColor(cls) {
  if (cls === 'mower') return '#22c55e';
  if (cls === 'charger') return '#eab308';
  if (cls === 'app') return '#3b82f6';
  if (cls === 'http') return '#c084fc';
  return '#666';
}

function typeIcon(type) {
  if (type === 'connect') return '🔌';
  if (type === 'disconnect') return '🔴';
  if (type === 'subscribe') return '📡';
  if (type === 'publish') return '📨';
  if (type === 'forward') return '➡️';
  if (type === 'http-req') return '🌐';
  if (type === 'http-res') return '↩️';
  if (type === 'error') return '❌';
  return '·';
}

function truncate(s, n) { return s && s.length > n ? s.substring(0, n) + '...' : (s || ''); }

function highlightTerm(text, q) {
  if (!q || !text) return text;
  var idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  var result = '';
  var pos = 0;
  while (idx !== -1) {
    result += text.substring(pos, idx);
    result += '<mark style="background:#facc15;color:#000;border-radius:2px;padding:0 1px">' + text.substring(idx, idx + q.length) + '</mark>';
    pos = idx + q.length;
    idx = text.toLowerCase().indexOf(q.toLowerCase(), pos);
  }
  result += text.substring(pos);
  return result;
}

function formatLog(entry, searchTerm) {
  var cls = classifyLog(entry);
  var color = logColor(cls);
  var t = new Date(entry.ts);
  var time = t.toLocaleTimeString('nl-NL', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  var icon = typeIcon(entry.type);
  var dir = entry.direction || '';
  var sn = entry.sn || '';
  var topic = entry.topic ? entry.topic.replace('Dart/Receive_mqtt/','←').replace('Dart/Send_mqtt/','→').replace('Dart/Receive_server_mqtt/','⇐') : '';
  var payload = (entry.payload || '').split('<').join('&lt;');
  var q = searchTerm || '';

  // Highlight search term in sn, topic, payload
  if (q) {
    sn = highlightTerm(sn, q);
    topic = highlightTerm(topic, q);
    payload = highlightTerm(payload, q);
  }

  return '<div class="mqtt-line mqtt-' + cls + '" style="color:' + color + '">' +
    '<span style="color:#555">' + time + '</span> ' +
    icon + ' ' +
    '<span style="font-weight:700">' + (entry.type || '').toUpperCase() + '</span> ' +
    (sn ? '<span style="color:' + color + ';opacity:.7">' + sn + '</span> ' : '') +
    (dir ? '<span style="color:#aaa">' + dir + '</span> ' : '') +
    (topic ? '<span style="color:#aaa">' + topic + '</span> ' : '') +
    (payload ? '<span style="color:' + color + ';opacity:.6">' + payload + '</span>' : '') +
    '</div>';
}

function copyConsole() {
  var fm = document.getElementById('f_mower').checked;
  var fc = document.getElementById('f_charger').checked;
  var fa = document.getElementById('f_app').checked;
  var fh = document.getElementById('f_http').checked;
  var fs = document.getElementById('f_system').checked;
  var q = (document.getElementById('f_search').value || '').toLowerCase().trim();
  var lines = [];
  for (var i = 0; i < mqttLogs.length; i++) {
    var e = mqttLogs[i];
    var cls = classifyLog(e);
    if (cls === 'mower' && !fm) continue;
    if (cls === 'charger' && !fc) continue;
    if (cls === 'app' && !fa) continue;
    if (cls === 'http' && !fh) continue;
    if (cls === 'system' && !fs) continue;
    if (!matchesSearch(e, q)) continue;
    var t = new Date(e.ts);
    var time = t.toLocaleTimeString('nl-NL', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    var dir = e.direction || '';
    var sn = e.sn || '';
    lines.push(time + ' ' + (e.type || '').toUpperCase() + ' ' + sn + ' ' + dir + ' ' + (e.topic || '') + ' ' + (e.payload || ''));
  }
  var text = lines.join('\\n');
  navigator.clipboard.writeText(text).then(function() {
    var btn = event.target;
    btn.textContent = 'Copied!';
    setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
  });
}

function applyFilter() {
  renderLogs();
}

function matchesSearch(entry, q) {
  if (!q) return true;
  var s = ((entry.sn || '') + ' ' + (entry.clientId || '') + ' ' + (entry.topic || '') + ' ' + (entry.payload || '') + ' ' + (entry.type || '')).toLowerCase();
  return s.indexOf(q) >= 0;
}

function renderLogs() {
  var fm = document.getElementById('f_mower').checked;
  var fc = document.getElementById('f_charger').checked;
  var fa = document.getElementById('f_app').checked;
  var fh = document.getElementById('f_http').checked;
  var fs = document.getElementById('f_system').checked;
  var q = (document.getElementById('f_search').value || '').toLowerCase().trim();
  var el = document.getElementById('mqttConsole');
  var html = '';
  for (var i = 0; i < mqttLogs.length; i++) {
    var cls = classifyLog(mqttLogs[i]);
    if (cls === 'mower' && !fm) continue;
    if (cls === 'charger' && !fc) continue;
    if (cls === 'app' && !fa) continue;
    if (cls === 'http' && !fh) continue;
    if (cls === 'system' && !fs) continue;
    if (!matchesSearch(mqttLogs[i], q)) continue;
    html += formatLog(mqttLogs[i], q);
  }
  el.innerHTML = html;
  if (document.getElementById('f_autoscroll').checked) {
    el.scrollTop = el.scrollHeight;
  }
}

function addLog(entry) {
  mqttLogs.push(entry);
  if (mqttLogs.length > MAX_CONSOLE_LINES) mqttLogs.splice(0, mqttLogs.length - MAX_CONSOLE_LINES);

  var cls = classifyLog(entry);
  var fm = document.getElementById('f_mower').checked;
  var fc = document.getElementById('f_charger').checked;
  var fa = document.getElementById('f_app').checked;
  var fh = document.getElementById('f_http').checked;
  var fs = document.getElementById('f_system').checked;
  var q = (document.getElementById('f_search').value || '').toLowerCase().trim();
  if (cls === 'mower' && !fm) return;
  if (cls === 'charger' && !fc) return;
  if (cls === 'app' && !fa) return;
  if (cls === 'http' && !fh) return;
  if (cls === 'system' && !fs) return;
  if (!matchesSearch(entry, q)) return;

  var el = document.getElementById('mqttConsole');
  el.insertAdjacentHTML('beforeend', formatLog(entry, q));
  if (document.getElementById('f_autoscroll').checked) {
    el.scrollTop = el.scrollHeight;
  }
}

// Connect Socket.io for real-time logs
var mqttSocket = (typeof io !== 'undefined') ? io() : null;
if (!mqttSocket) {
  // Socket.io loaded from different port — connect explicitly
  setTimeout(function() {
    if (typeof io !== 'undefined') {
      mqttSocket = io(location.protocol + '//' + location.hostname + ':${process.env.PORT ?? '3000'}');
      mqttSocket.on('mqtt:log', function(entry) { addLog(entry); });
      mqttSocket.emit('mqtt:log:history');
    }
  }, 1000);
}
mqttSocket.on('mqtt:log', function(entry) { addLog(entry); });
mqttSocket.on('device:online', function(d) {
  if (token) loadMyDevices();
  showToast(d.sn + ' came online', 'green');
});
mqttSocket.on('device:offline', function(d) {
  if (token) loadMyDevices();
  showToast(d.sn + ' went offline', 'gray');
});
mqttSocket.on('device:bound', function(d) {
  if (token) loadMyDevices();
  showActivity('binding ' + d.sn + '...', 3000);
  showToast('Auto-bound ' + d.sn + ' to your account', 'green');
});
mqttSocket.on('device:paired', function(d) {
  if (token) loadMyDevices();
  showActivity('pairing devices...', 3000);
  showToast('Auto-paired ' + (d.mowerSn || '?') + ' + ' + (d.chargerSn || '?'), 'green');
});
mqttSocket.on('ota:event', function(evt) {
  if (!evt) return;
  var selDev = document.getElementById('otaDeviceSelect');
  if (!selDev || !selDev.value) return;
  // Filter by selected SN
  if (evt.sn && evt.sn !== selDev.value) return;
  var progressArea = document.getElementById('otaProgress');
  var fill = document.getElementById('otaProgressFill');
  var pctText = document.getElementById('otaPctText');
  var statusText = document.getElementById('otaStatusText');
  if (!progressArea || !fill) return;
  progressArea.style.display = 'block';
  var pct = typeof evt.progress === 'number' ? evt.progress : 0;
  fill.style.width = pct + '%';
  pctText.textContent = pct + '%';
  // Determine status text from progress range
  var label = 'Updating...';
  if (evt.status === 'completed' || pct >= 100) {
    label = 'Completed!';
    fill.style.background = '#22c55e';
    pctText.textContent = '100%';
    fill.style.width = '100%';
    showToast('OTA update completed for ' + (evt.sn || selDev.value), 'green');
  } else if (evt.status === 'error' || evt.status === 'failed') {
    label = 'Failed: ' + (evt.message || 'unknown error');
    fill.style.background = '#ef4444';
    pctText.style.color = '#ef4444';
  } else if (pct <= 62) {
    label = 'Downloading firmware... (' + pct + '%)';
  } else if (pct <= 68) {
    label = 'Unpacking firmware...';
  } else {
    label = 'Installing firmware...';
  }
  statusText.textContent = label;
  statusText.style.color = (evt.status === 'error' || evt.status === 'failed') ? '#ef4444' : (evt.status === 'completed' || pct >= 100) ? '#22c55e' : '#aaa';
});

var _activityTimer = null;
function showActivity(text, durationMs) {
  var el = document.getElementById('deviceActivity');
  var txt = document.getElementById('deviceActivityText');
  if (!el || !txt) return;
  txt.textContent = text;
  el.style.display = 'inline';
  if (_activityTimer) clearTimeout(_activityTimer);
  _activityTimer = setTimeout(function() { el.style.display = 'none'; }, durationMs || 5000);
}

function showToast(msg, color) {
  var el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:8px;font-size:13px;z-index:9999;transition:opacity .5s;color:#fff;background:' + (color === 'green' ? 'rgba(0,212,170,.9)' : color === 'gray' ? 'rgba(100,100,100,.9)' : 'rgba(0,212,170,.9)');
  document.body.appendChild(el);
  setTimeout(function() { el.style.opacity = '0'; setTimeout(function() { el.remove(); }, 500); }, 3000);
}

// Load initial logs
fetch('/api/dashboard/mqtt-logs')
  .then(function(r) { return r.json(); })
  .then(function(d) {
    var logs = d.logs || d || [];
    for (var i = 0; i < logs.length; i++) mqttLogs.push(logs[i]);
    renderLogs();
  })
  .catch(function() {});

async function api(path, method='GET', body=null) {
  const opts = { method, headers: { 'Authorization': token, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch('/api/admin-status' + path, opts);
  if (r.status === 401 || r.status === 403) { logout(); throw new Error('Unauthorized'); }
  var ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    var txt = await r.text();
    var preStart = txt.indexOf(String.fromCharCode(60) + 'pre>');
    var preEnd = txt.indexOf(String.fromCharCode(60) + '/pre>');
    var inner = (preStart >= 0 && preEnd > preStart) ? txt.substring(preStart + 5, preEnd) : '';
    var errMsg = inner ? inner.split('&nbsp;').join(' ').split('&lt;').join('').split('&gt;').join('').split(String.fromCharCode(60) + 'br>').join(' ').substring(0, 200) : 'Server error: ' + r.status;
    throw new Error(errMsg);
  }
  var d = await r.json();
  if (!r.ok) throw new Error(d.error || d.message || 'Server error: ' + r.status);
  return d;
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

var _refreshInterval = null;
async function loadAll() {
  loadAccount();
  loadMyDevices();
  // Auto-refresh device list every 30s for timestamp updates
  if (_refreshInterval) clearInterval(_refreshInterval);
  _refreshInterval = setInterval(function() { if (token) loadMyDevices(); }, 30000);
}

async function loadAccount() {
  try {
    const d = await api('/overview');
    const s = d.server;
    document.getElementById('serverInfo').textContent = 'v' + (s.version || '?') + ' · uptime ' + s.uptimeFormatted + ' · ' + s.memoryMB + ' MB RAM';
    const u = d.currentUser || {};
    document.getElementById('account').innerHTML =
      '<div class="row"><span class="label">Email</span><span class="value">' + (u.email || '-') + '</span></div>' +
      '<div class="row"><span class="label">Role</span><span class="value"><span class="badge badge-admin">' + (u.is_admin ? 'admin' : 'user') + '</span></span></div>' +
      '<div class="row"><span class="label">Devices</span><span class="value">' + d.counts.equipment + ' registered · ' + d.counts.devices + ' seen</span></div>' +
      '<div class="row"><span class="label">Maps</span><span class="value">' + d.counts.maps + '</span></div>';
  } catch { document.getElementById('account').textContent = 'Failed to load'; }
}
// Refresh uptime every 30s
setInterval(async function() {
  try {
    var d = await api('/overview');
    var s = d.server;
    document.getElementById('serverInfo').textContent = 'v' + (s.version || '?') + ' · uptime ' + s.uptimeFormatted + ' · ' + s.memoryMB + ' MB RAM';
  } catch {}
}, 30000);

function devRow(dev) {
  const online = dev.is_online;
  const isCharger = dev.device_type === 'charger';
  const icon = isCharger ? '⚡' : '🤖';
  const typeColor = isCharger ? '#f59e0b' : '#00d4aa';
  const typeName = isCharger ? 'Charger' : 'Mower';
  const bound = dev.is_bound;
  const fw = dev.firmware_version || '';
  const isON = dev.is_opennova;
  var fwBadge = '';
  if (fw) {
    if (isON) {
      fwBadge = '<span style="font-size:9px;background:rgba(0,212,170,.15);color:#00d4aa;padding:1px 6px;border-radius:3px;font-weight:600">OpenNova</span>';
    } else {
      fwBadge = '<span style="font-size:9px;background:rgba(245,158,11,.15);color:#f59e0b;padding:1px 6px;border-radius:3px;font-weight:600">Stock</span>';
    }
  }
  var activeBadge = '';
  if (!isCharger && dev.is_active) {
    activeBadge = '<span style="font-size:9px;background:rgba(124,58,237,.2);color:#a78bfa;padding:1px 6px;border-radius:3px;font-weight:600;margin-left:4px">Active</span>';
  }
  let actions = '';
  if (bound) {
    if (!isCharger) {
      actions += dev.is_active
        ? '<span style="font-size:11px;color:#a78bfa;margin-right:6px">Active</span>'
        : '<button class="btn btn-sm" style="background:rgba(124,58,237,.2);color:#a78bfa;border:1px solid rgba(124,58,237,.3);font-size:11px;padding:2px 8px" onclick="setActiveDevice(\\'' + dev.sn + '\\')">Set Active</button> ';
    }
    actions += '<button class="btn btn-sm" style="background:#374151;color:#aaa" onclick="unbindDevice(\\'' + dev.sn + '\\')">Unbind</button>';
  } else {
    actions = '<button class="btn btn-sm btn-green" onclick="bindDevice(\\'' + dev.sn + '\\')">Bind</button> ' +
      '<button class="btn btn-sm btn-red" onclick="removeDevice(\\'' + dev.sn + '\\')">Remove</button>';
  }
  return '<div style="display:grid;grid-template-columns:90px 160px 140px 80px 70px auto;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid rgba(255,255,255,.04)">' +
    '<span style="color:' + typeColor + ';font-size:13px;white-space:nowrap">' + icon + ' ' + typeName + '</span>' +
    '<div><span class="sn" style="font-size:12px">' + (dev.sn || '-') + '</span></div>' +
    '<div style="text-align:right">' + (fw ? '<span style="font-size:11px;color:#888">' + fw + '</span>' : '') + '</div>' +
    '<div style="text-align:center">' + fwBadge + '</div>' +
    '<div style="text-align:center;white-space:nowrap">' + dot(online) + (online ? '<span class="on" style="font-size:11px">Online</span>' : '<span class="off" style="font-size:11px">Offline</span>') + '</div>' +
    '<div style="text-align:right;white-space:nowrap">' + actions + '</div>' +
    '</div>';
}

async function loadMyDevices() {
  try {
    const d = await api('/devices');
    const devs = d.devices || [];
    if (!devs.length) { document.getElementById('myDevices').textContent = 'No devices found. Import from cloud or wait for devices to connect via MQTT.'; return; }

    let html = '';

    // Group by equipment pairing (paired_with), then solo, then unbound
    const paired = {};    // key = sorted SN pair → [dev, dev]
    const solo = [];      // bound but not paired
    const unbound = [];   // not bound at all

    for (const dev of devs) {
      if (!dev.is_bound) {
        unbound.push(dev);
      } else if (dev.paired_with) {
        var key = [dev.sn, dev.paired_with].sort().join(':');
        if (!paired[key]) paired[key] = [];
        paired[key].push(dev);
      } else {
        solo.push(dev);
      }
    }

    // Render paired sets
    for (const key in paired) {
      const group = paired[key];
      const charger = group.find(function(d) { return d.device_type === 'charger'; });
      const mower = group.find(function(d) { return d.device_type === 'mower'; });
      const anyOnline = group.some(function(d) { return d.is_online; });
      var loraAddr = (charger && charger.lora_address) || (mower && mower.lora_address) || null;

      html += '<div style="margin-bottom:12px;padding:12px;background:rgba(255,255,255,.02);border:1px solid ' + (anyOnline ? 'rgba(0,212,170,.2)' : 'rgba(255,255,255,.06)') + ';border-radius:10px">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">';
      html += '<span style="font-size:12px;font-weight:600;color:#00d4aa">\uD83D\uDD17 Paired Set</span>';
      html += '<span style="font-size:11px;color:#666">' + (loraAddr ? 'LoRa ' + loraAddr : 'LoRa pending...') + '</span>';
      html += '</div>';
      for (const dev of group) { html += devRow(dev); }
      html += '</div>';
    }

    // Render solo bound devices (charger or mower without partner)
    if (solo.length > 0) {
      html += '<div style="margin-bottom:12px;padding:12px;background:rgba(255,255,255,.02);border:1px solid rgba(245,158,11,.15);border-radius:10px">';
      html += '<div style="margin-bottom:4px"><span style="font-size:12px;font-weight:600;color:#f59e0b">Waiting for partner</span></div>';
      html += '<div style="padding:4px 8px;margin-bottom:6px"><span style="color:#aaa;font-size:11px">' +
        'Bound to your account. The partner device (charger or mower) will be paired automatically when it connects.</span></div>';
      for (const dev of solo) { html += devRow(dev); }
      html += '</div>';
    }

    // Render unbound devices
    if (unbound.length > 0) {
      html += '<div style="margin-bottom:12px;padding:12px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:10px">';
      html += '<div style="margin-bottom:4px"><span style="font-size:12px;font-weight:600;color:#aaa">New Devices</span></div>';
      html += '<div style="padding:4px 8px;margin-bottom:6px"><span style="color:#aaa;font-size:11px">' +
        'Connected via MQTT but not yet bound to your account. They will be auto-bound shortly, or click Bind.</span></div>';
      for (const dev of unbound) { html += devRow(dev); }
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
  } catch(e) { modalAlert('Bind Failed', e.message); }
}

async function setActiveDevice(sn) {
  try {
    await api('/set-active-device', 'POST', { sn });
    showToast(sn + ' set as active device', 'green');
    loadMyDevices();
  } catch(e) { modalAlert('Failed', e.message); }
}

async function unbindDevice(sn) {
  var ok = await modalConfirm('Unbind Device', 'Unbind <b>' + sn + '</b> from your account?');
  if (!ok) return;
  try {
    await api('/unbind-device', 'POST', { sn });
    loadMyDevices();
  } catch(e) { modalAlert('Unbind Failed', e.message); }
}

async function removeDevice(sn) {
  var ok = await modalConfirm('Remove Device', 'Remove <b>' + sn + '</b>? This deletes it from the database.');
  if (!ok) return;
  try {
    await api('/remove-device', 'POST', { sn });
    loadMyDevices();
  } catch(e) { modalAlert('Remove Failed', e.message); }
}

async function pairMowerCharger(mowerSn, chargerSn) {
  try {
    await api('/pair-devices', 'POST', { mowerSn, chargerSn });
    await modalAlert('Paired!', 'Mower <b>' + mowerSn + '</b> paired with charger <b>' + chargerSn + '</b>.');
    loadMyDevices();
  } catch(e) { modalAlert('Pair Failed', e.message); }
}

var dnsmasqRunning = false;

async function checkDnsmasqStatus() {
  try {
    var r = await fetch('/api/admin-status/dnsmasq', { headers: { 'Authorization': token } });
    var d = await r.json();
    dnsmasqRunning = d.running;
    var btn = document.getElementById('dnsmasqBtn');
    var status = document.getElementById('dnsmasqStatus');
    if (d.running) {
      btn.textContent = 'Stop';
      btn.className = 'btn';
      btn.style.cssText = 'font-size:11px;padding:4px 12px;min-width:60px;background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.2);border-radius:6px;cursor:pointer';
      status.textContent = 'Running';
      status.style.color = '#22c55e';
    } else {
      btn.textContent = 'Start';
      btn.className = 'btn';
      btn.style.cssText = 'font-size:11px;padding:4px 12px;min-width:60px;background:rgba(34,197,94,.15);color:#86efac;border:1px solid rgba(34,197,94,.2);border-radius:6px;cursor:pointer';
      status.textContent = 'Stopped';
      status.style.color = '#aaa';
    }
  } catch { /* ignore */ }
}

async function toggleDnsmasq() {
  var btn = document.getElementById('dnsmasqBtn');
  btn.textContent = '...';
  try {
    await fetch('/api/admin-status/dnsmasq', {
      method: 'POST',
      headers: { 'Authorization': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable: !dnsmasqRunning })
    });
    await checkDnsmasqStatus();
    checkDns();
  } catch(e) { btn.textContent = 'Error'; }
}

async function checkDns() {
  var el = document.getElementById('dnsResults');
  el.innerHTML = '<div style="color:#aaa">Checking DNS...</div>';
  try {
    var r = await fetch('/api/admin-status/dns-check', { headers: { 'Authorization': token } });
    var d = await r.json();
    var html = '<div style="display:flex;flex-direction:column;gap:6px">';
    html += '<div style="display:flex;justify-content:space-between;padding:6px 10px;background:rgba(255,255,255,.03);border-radius:6px"><span style="color:#aaa">Server IP</span><span style="color:#fff;font-weight:600">' + (d.serverIp || '?') + '</span></div>';
    for (var i = 0; i < (d.domains || []).length; i++) {
      var dom = d.domains[i];
      var ok = dom.ok;
      var color = ok ? '#22c55e' : '#ef4444';
      var icon = ok ? '✓' : '✗';
      var detail = dom.resolvedIp ? dom.resolvedIp : dom.error || 'not resolved';
      var label = ok ? '(local)' : dom.isLocal === false && dom.resolvedIp ? '(cloud!)' : '';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:rgba(255,255,255,.03);border-radius:6px">';
      html += '<span style="color:#aaa">' + dom.domain + '</span>';
      html += '<span style="color:' + color + ';font-weight:600">' + icon + ' ' + detail + ' <span style="font-weight:400;opacity:.7">' + label + '</span></span>';
      html += '</div>';
    }
    html += '</div>';
    if (d.domains && d.domains.some(function(x) { return !x.ok; })) {
      html += '<div style="margin-top:8px;padding:8px 12px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:6px;font-size:11px;color:#fca5a5">';
      html += '<b>DNS still points to cloud.</b> Configure your router DNS or AdGuard DNS rewrites to redirect *.lfibot.com to a local IP.';
      html += '</div>';
    } else if (d.domains && d.domains.length > 0) {
      html += '<div style="margin-top:8px;padding:8px 12px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);border-radius:6px;font-size:11px;color:#86efac">';
      html += '<b>DNS is redirected!</b> All domains resolve to local IPs. The Novabot app and mower will connect locally.';
      html += '</div>';
    }
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = '<div style="color:#ef4444">DNS check failed: ' + e.message + '</div>';
  }
}

// ── Maps Tab ──────────────────────────────────────────────────────
var _mapsDropdownLoaded = false;

async function populateMowerDropdown() {
  var sel = document.getElementById('mapMowerSelect');
  if (_mapsDropdownLoaded && sel.options.length > 1) return;
  try {
    var d = await api('/devices');
    var devs = d.devices || [];
    // Keep current selection
    var prev = sel.value;
    sel.innerHTML = '<option value="">Select a mower...</option>';
    for (var i = 0; i < devs.length; i++) {
      if (devs[i].device_type === 'mower') {
        var opt = document.createElement('option');
        opt.value = devs[i].sn;
        opt.textContent = devs[i].sn;
        sel.appendChild(opt);
      }
    }
    _mapsDropdownLoaded = true;
    // Auto-select if only one mower, or restore previous
    if (prev && sel.querySelector('option[value="' + prev + '"]')) {
      sel.value = prev;
    } else if (sel.options.length === 2) {
      sel.selectedIndex = 1;
    }
    if (sel.value) loadMaps();
  } catch(e) {
    document.getElementById('mapInfo').textContent = 'Failed to load devices: ' + e.message;
  }
}

async function uploadMapZip() {
  var sn = document.getElementById('mapMowerSelect').value;
  var fileInput = document.getElementById('mapZipFile');
  var status = document.getElementById('mapUploadStatus');

  status.style.display = 'block';

  if (!sn) {
    status.style.color = '#f87171';
    status.textContent = 'Please select a mower first.';
    return;
  }

  if (!fileInput.files || fileInput.files.length === 0) {
    status.style.color = '#f87171';
    status.textContent = 'Please select a ZIP file.';
    return;
  }

  var file = fileInput.files[0];
  if (!file.name.toLowerCase().endsWith('.zip')) {
    status.style.color = '#f87171';
    status.textContent = 'Only .zip files are accepted.';
    return;
  }

  status.style.color = '#60a5fa';
  status.textContent = 'Importing ' + file.name + ' (creates new maps)...';

  try {
    var fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('sn', sn);

    var r = await fetch('/api/admin-status/import-map-zip', {
      method: 'POST',
      headers: { 'Authorization': token },
      body: fd
    });

    if (!r.ok) {
      var errData = await r.json().catch(function() { return {}; });
      throw new Error(errData.error || 'HTTP ' + r.status);
    }
    var result = await r.json();

    status.style.color = '#00d4aa';
    status.textContent = 'Imported ' + (result.mapsImported || 0) + ' map(s) from ' + file.name;
    fileInput.value = '';
    loadMaps();
  } catch(e) {
    status.style.color = '#f87171';
    status.textContent = 'Import failed: ' + e.message;
  }
}

async function loadMaps() {
  var sn = document.getElementById('mapMowerSelect').value;
  var info = document.getElementById('mapInfo');
  var canvas = document.getElementById('mapCanvas');
  var legend = document.getElementById('mapLegend');
  var ctx = canvas.getContext('2d');

  var mapList = document.getElementById('mapList');

  if (!sn) {
    info.textContent = '';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    legend.style.display = 'none';
    mapList.innerHTML = '';
    return;
  }

  info.textContent = 'Loading maps for ' + sn + '...';

  try {
    var r = await fetch('/api/dashboard/maps/' + encodeURIComponent(sn), {
      headers: { 'Authorization': token }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var data = await r.json();
    var maps = data.maps || [];

    if (maps.length === 0) {
      info.textContent = 'No maps found for ' + sn;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      legend.style.display = 'none';
      mapList.innerHTML = '';
      return;
    }

    var workCount = maps.filter(function(m) { return m.mapType === 'work'; }).length;
    info.textContent = workCount + ' work area(s), ' + maps.length + ' total for ' + sn;
    legend.style.display = 'flex';
    renderMapCanvas(canvas, maps);
    renderMapList(mapList, maps, sn);
  } catch(e) {
    info.textContent = 'Failed to load maps: ' + e.message;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    legend.style.display = 'none';
    mapList.innerHTML = '';
  }
}

function renderMapCanvas(canvas, maps) {
  // Get device pixel ratio for sharp rendering
  var dpr = window.devicePixelRatio || 1;
  var rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  var W = rect.width;
  var H = rect.height;

  ctx.clearRect(0, 0, W, H);

  // Collect all points to find bounds
  var allX = [0], allY = [0]; // include charger origin
  for (var i = 0; i < maps.length; i++) {
    var pts = maps[i].mapArea || [];
    for (var j = 0; j < pts.length; j++) {
      allX.push(pts[j].x);
      allY.push(pts[j].y);
    }
  }

  var minX = Math.min.apply(null, allX);
  var maxX = Math.max.apply(null, allX);
  var minY = Math.min.apply(null, allY);
  var maxY = Math.max.apply(null, allY);

  // Add padding
  var pad = 40;
  var rangeX = maxX - minX || 1;
  var rangeY = maxY - minY || 1;
  var scaleX = (W - pad * 2) / rangeX;
  var scaleY = (H - pad * 2) / rangeY;
  var scale = Math.min(scaleX, scaleY);

  // Center the drawing
  var drawW = rangeX * scale;
  var drawH = rangeY * scale;
  var offsetX = pad + (W - pad * 2 - drawW) / 2;
  var offsetY = pad + (H - pad * 2 - drawH) / 2;

  // Transform: local meters → canvas pixels (flip y-axis)
  function tx(x) { return offsetX + (x - minX) * scale; }
  function ty(y) { return offsetY + (maxY - y) * scale; } // flip Y

  // Draw grid
  ctx.strokeStyle = 'rgba(255,255,255,.04)';
  ctx.lineWidth = 1;
  // Calculate nice grid step
  var gridStep = 1;
  var maxRange = Math.max(rangeX, rangeY);
  if (maxRange > 50) gridStep = 10;
  else if (maxRange > 20) gridStep = 5;
  else if (maxRange > 10) gridStep = 2;

  var gx0 = Math.floor(minX / gridStep) * gridStep;
  var gy0 = Math.floor(minY / gridStep) * gridStep;
  for (var gx = gx0; gx <= maxX; gx += gridStep) {
    var cx = tx(gx);
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
  }
  for (var gy = gy0; gy <= maxY; gy += gridStep) {
    var cy = ty(gy);
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
  }

  // Draw scale bar
  ctx.fillStyle = '#555';
  ctx.font = '10px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText(rangeX.toFixed(1) + 'm x ' + rangeY.toFixed(1) + 'm', W - 10, H - 8);

  // Draw each map polygon
  for (var i = 0; i < maps.length; i++) {
    var map = maps[i];
    var pts = map.mapArea || [];
    if (pts.length < 2) continue;

    var type = (map.mapType || 'work').toLowerCase();
    var isObstacle = type.indexOf('obstacle') >= 0 || type.indexOf('forbidden') >= 0;
    var isUnicom = type.indexOf('unicom') >= 0 || type.indexOf('channel') >= 0 || type.indexOf('passage') >= 0;

    ctx.beginPath();
    ctx.moveTo(tx(pts[0].x), ty(pts[0].y));
    for (var j = 1; j < pts.length; j++) {
      ctx.lineTo(tx(pts[j].x), ty(pts[j].y));
    }

    if (isUnicom) {
      // Draw as polyline (not filled)
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else if (isObstacle) {
      ctx.closePath();
      ctx.fillStyle = 'rgba(239,68,68,.25)';
      ctx.fill();
      ctx.strokeStyle = '#991b1b';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      // Work area (default)
      ctx.closePath();
      ctx.fillStyle = 'rgba(34,197,94,.2)';
      ctx.fill();
      ctx.strokeStyle = '#166534';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Draw map name label at centroid
    if (pts.length > 0 && map.mapName) {
      var cx = 0, cy = 0;
      for (var j = 0; j < pts.length; j++) { cx += pts[j].x; cy += pts[j].y; }
      cx /= pts.length; cy /= pts.length;
      ctx.fillStyle = '#ccc';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(map.mapName, tx(cx), ty(cy) - 4);
      // Show area for non-unicom
      if (!isUnicom && pts.length >= 3) {
        var area = 0;
        for (var j = 0; j < pts.length; j++) {
          var k = (j + 1) % pts.length;
          area += pts[j].x * pts[k].y - pts[k].x * pts[j].y;
        }
        area = Math.abs(area) / 2;
        ctx.fillStyle = '#888';
        ctx.font = '10px system-ui';
        ctx.fillText(area.toFixed(1) + ' m\\u00B2', tx(cx), ty(cy) + 10);
      }
    }
  }

  // Draw charger marker at origin (0,0)
  var chargerX = tx(0);
  var chargerY = ty(0);
  ctx.beginPath();
  ctx.arc(chargerX, chargerY, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#f59e0b';
  ctx.fill();
  ctx.strokeStyle = '#92400e';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Charger label
  ctx.fillStyle = '#f59e0b';
  ctx.font = '10px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('Charger', chargerX, chargerY - 10);
}

function renderMapList(container, maps, sn) {
  var typeIcons = { work: '\\u{1F7E9}', obstacle: '\\u{1F7E5}', unicom: '\\u{1F535}' };
  var html = '<div style="font-size:12px;color:#aaa;margin-bottom:6px;font-weight:600">Maps (' + maps.length + ')</div>';
  for (var i = 0; i < maps.length; i++) {
    var m = maps[i];
    var type = (m.mapType || 'work').toLowerCase();
    var icon = typeIcons[type] || '\\u{2B1C}';
    var name = m.mapName || ('map_' + (i + 1));
    var areaStr = '';
    if (type !== 'unicom' && m.mapArea && m.mapArea.length >= 3) {
      var area = 0;
      for (var j = 0; j < m.mapArea.length; j++) {
        var k = (j + 1) % m.mapArea.length;
        area += m.mapArea[j].x * m.mapArea[k].y - m.mapArea[k].x * m.mapArea[j].y;
      }
      area = Math.abs(area) / 2;
      areaStr = ' (' + area.toFixed(1) + ' m\\u00B2)';
    } else if (type === 'unicom' && m.mapArea) {
      areaStr = ' (' + m.mapArea.length + ' pts)';
    }
    html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;'
      + 'background:rgba(255,255,255,.03);border-radius:6px;margin-bottom:4px">'
      + '<span style="color:#ddd;font-size:12px">' + icon + ' ' + name + '<span style="color:#888">' + areaStr + '</span>'
      + ' <span style="color:#666;font-size:10px">' + type + '</span></span>'
      + '<button onclick="deleteMap(\\'' + sn + '\\',\\'' + m.mapId + '\\',\\'' + name.replace(/'/g, "\\\\'") + '\\')" '
      + 'style="padding:3px 10px;background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.3);'
      + 'border-radius:6px;font-size:11px;cursor:pointer;font-weight:600">Delete</button></div>';
  }
  container.innerHTML = html;
}

async function deleteMap(sn, mapId, mapName) {
  if (!confirm('Delete map "' + mapName + '"? This cannot be undone.')) return;
  try {
    var r = await fetch('/api/dashboard/maps/' + encodeURIComponent(sn) + '/' + encodeURIComponent(mapId), {
      method: 'DELETE',
      headers: { 'Authorization': token }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    loadMaps();
  } catch(e) {
    alert('Delete failed: ' + e.message);
  }
}

// ── Firmware Tab ─────────────────────────────────────────────────
var _fwVersions = [];
var _fwDevices = [];

async function syncAndLoadFirmware() {
  try { await fetch('/api/dashboard/ota/sync', { method: 'POST', headers: { 'Authorization': token } }); } catch {}
  loadFirmwareVersions();
}

async function loadFirmwareVersions() {
  try {
    var r = await fetch('/api/dashboard/ota/versions', { headers: { 'Authorization': token } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var d = await r.json();
    _fwVersions = d.versions || d || [];
    var tbody = document.getElementById('fwTableBody');
    if (!_fwVersions.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:#666">No firmware versions found</td></tr>';
      return;
    }
    var html = '';
    for (var i = 0; i < _fwVersions.length; i++) {
      var v = _fwVersions[i];
      var devType = (v.device_type || v.deviceType || 'mower');
      var md5 = (v.md5 || '').substring(0, 10);
      var rawNotes = v.release_notes || v.releaseNotes || v.description || '';
      var notesHtml = rawNotes ? rawNotes.split('\\n').join('<br>').replace(/- /g, '&bull; ') : '<span style="color:#666">\u2014</span>';
      html += '<tr>' +
        '<td style="color:#fff;font-weight:600;white-space:nowrap">' + (v.version || '?') + '</td>' +
        '<td><span style="color:' + (devType === 'charger' ? '#f59e0b' : '#00d4aa') + '">' + devType + '</span></td>' +
        '<td style="color:#888;font-family:monospace;font-size:11px">' + md5 + (v.md5 && v.md5.length > 10 ? '...' : '') + '</td>' +
        '<td style="color:#aaa;font-size:11px;line-height:1.6">' + notesHtml + '</td>' +
        '<td><button class="btn btn-sm btn-red" onclick="deleteFirmwareVersion(' + (v.id || v.ID) + ')">Delete</button></td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
    // Also update version dropdown if a device is selected
    onOtaDeviceChange();
  } catch(e) {
    document.getElementById('fwTableBody').innerHTML = '<tr><td colspan="5" style="color:#ef4444">Failed: ' + e.message + '</td></tr>';
  }
}

async function deleteFirmwareVersion(id) {
  var ok = await modalConfirm('Delete Firmware', 'Delete this firmware version? This cannot be undone.');
  if (!ok) return;
  try {
    var r = await fetch('/api/dashboard/ota/versions/' + id, {
      method: 'DELETE',
      headers: { 'Authorization': token }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    loadFirmwareVersions();
    showToast('Firmware version deleted', 'green');
  } catch(e) { modalAlert('Delete Failed', e.message); }
}

async function populateOtaDeviceDropdown() {
  var sel = document.getElementById('otaDeviceSelect');
  try {
    var d = await api('/devices');
    _fwDevices = d.devices || [];
    var prev = sel.value;
    sel.innerHTML = '<option value="">Select device...</option>';
    for (var i = 0; i < _fwDevices.length; i++) {
      var dev = _fwDevices[i];
      var icon = dev.device_type === 'charger' ? '\\u26A1' : '\\uD83E\\uDD16';
      var opt = document.createElement('option');
      opt.value = dev.sn;
      opt.textContent = icon + ' ' + dev.sn + (dev.is_online ? ' (online)' : ' (offline)');
      opt.dataset.type = dev.device_type || 'mower';
      sel.appendChild(opt);
    }
    if (prev && sel.querySelector('option[value="' + prev + '"]')) sel.value = prev;
    onOtaDeviceChange();
  } catch(e) { /* ignore */ }
}

function onOtaDeviceChange() {
  var sel = document.getElementById('otaDeviceSelect');
  var vSel = document.getElementById('otaVersionSelect');
  var curDiv = document.getElementById('otaCurrentVersion');
  vSel.innerHTML = '<option value="">Select version...</option>';
  curDiv.textContent = '';

  if (!sel.value) return;

  // Determine device type
  var opt = sel.options[sel.selectedIndex];
  var devType = (opt.dataset && opt.dataset.type) || (sel.value.startsWith('LFIC') ? 'charger' : 'mower');

  // Show current version from device list
  var dev = _fwDevices.find(function(d) { return d.sn === sel.value; });
  if (dev) {
    var curVer = dev.firmware_version || 'unknown';
    var isON = curVer.includes('custom');
    var badge = isON ? ' <span style="font-size:9px;background:rgba(0,212,170,.15);color:#00d4aa;padding:1px 5px;border-radius:3px;font-weight:600">OpenNova</span>'
      : (curVer !== 'unknown' ? ' <span style="font-size:9px;background:rgba(245,158,11,.15);color:#f59e0b;padding:1px 5px;border-radius:3px;font-weight:600">Stock</span>' : '');
    curDiv.innerHTML = 'Current firmware: <span style="color:#fff;font-weight:600">' + curVer + '</span>' + badge +
      (dev.is_online ? ' <span class="on" style="font-size:11px">(online)</span>' : ' <span class="off" style="font-size:11px">(offline)</span>');
  }

  // Filter versions by device type
  for (var i = 0; i < _fwVersions.length; i++) {
    var v = _fwVersions[i];
    var vType = (v.device_type || v.deviceType || 'mower');
    if (vType !== devType) continue;
    var o = document.createElement('option');
    o.value = v.id || v.ID;
    o.textContent = v.version + (v.release_notes || v.releaseNotes ? ' - ' + truncate(v.release_notes || v.releaseNotes, 30) : '');
    vSel.appendChild(o);
  }
}

async function startOtaUpdate() {
  var sn = document.getElementById('otaDeviceSelect').value;
  var versionId = document.getElementById('otaVersionSelect').value;
  if (!sn) { modalAlert('No Device', 'Please select a device.'); return; }
  if (!versionId) { modalAlert('No Version', 'Please select a firmware version.'); return; }

  var vName = '';
  for (var i = 0; i < _fwVersions.length; i++) {
    if (String(_fwVersions[i].id || _fwVersions[i].ID) === String(versionId)) { vName = _fwVersions[i].version; break; }
  }

  var ok = await modalConfirm('Start OTA Update', 'Update <b>' + sn + '</b> to <b>' + (vName || 'selected version') + '</b>?<br><br>The device will reboot during the update.');
  if (!ok) return;

  // Reset progress UI
  var progressArea = document.getElementById('otaProgress');
  var fill = document.getElementById('otaProgressFill');
  var pctText = document.getElementById('otaPctText');
  var statusText = document.getElementById('otaStatusText');
  progressArea.style.display = 'block';
  fill.style.width = '0%';
  fill.style.background = '#00d4aa';
  pctText.textContent = '0%';
  pctText.style.color = '#00d4aa';
  statusText.textContent = 'Sending update command...';
  statusText.style.color = '#aaa';

  try {
    var r = await fetch('/api/dashboard/ota/trigger/' + encodeURIComponent(sn), {
      method: 'POST',
      headers: { 'Authorization': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version_id: parseInt(versionId) })
    });
    if (!r.ok) {
      var errData = await r.json().catch(function() { return {}; });
      throw new Error(errData.error || errData.message || 'HTTP ' + r.status);
    }
    statusText.textContent = 'Update command sent. Waiting for device...';
  } catch(e) {
    statusText.textContent = 'Failed: ' + e.message;
    statusText.style.color = '#ef4444';
    fill.style.background = '#ef4444';
  }
}

// ── Firmware Updates (Download from Cloud) ──────────────────────
var _fwAvailable = [];

async function checkFirmwareUpdates() {
  var btn = document.getElementById('fwCheckBtn');
  var status = document.getElementById('fwUpdateStatus');
  var container = document.getElementById('fwUpdatesAvailable');
  btn.disabled = true;
  btn.textContent = 'Checking...';
  status.textContent = '';
  container.style.display = 'none';
  container.innerHTML = '';
  try {
    var d = await api('/check-firmware-updates');
    var available = (d.available || []).filter(function(fw) { return !fw.installed; });
    _fwAvailable = d.available || [];
    if (available.length === 0) {
      status.textContent = 'All firmware up to date';
      status.style.color = '#00d4aa';
      container.style.display = 'none';
    } else {
      status.textContent = available.length + ' update(s) available';
      status.style.color = '#f59e0b';
      var html = '';
      for (var i = 0; i < available.length; i++) {
        var fw = available[i];
        var typeColor = fw.device_type === 'charger' ? '#f59e0b' : '#00d4aa';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;' + (i > 0 ? 'border-top:1px solid rgba(255,255,255,.06)' : '') + '">' +
          '<div>' +
            '<span style="color:#fff;font-weight:600">' + fw.version + '</span>' +
            ' <span style="color:' + typeColor + ';font-size:12px">' + fw.device_type + '</span>' +
            (fw.description ? '<div style="font-size:11px;color:#888;margin-top:4px;line-height:1.6">' + fw.description.split('\\n').join('<br>').replace(/- /g, '&bull; ') + '</div>' : '') +
          '</div>' +
          '<button class="btn" style="padding:4px 12px;font-size:12px" onclick="downloadFirmwareByIdx(' + i + ')" id="fwDlBtn' + i + '">Download</button>' +
        '</div>';
      }
      container.innerHTML = html;
      container.style.display = 'block';
    }
    // Also show already-installed remote firmwares
    var installed = (d.available || []).filter(function(fw) { return fw.installed; });
    if (installed.length > 0 && available.length > 0) {
      status.textContent += ' (' + installed.length + ' already installed)';
    }
  } catch(e) {
    status.textContent = 'Failed: ' + e.message;
    status.style.color = '#ef4444';
  }
  btn.disabled = false;
  btn.textContent = 'Check for Updates';
}

function downloadFirmwareByIdx(idx) {
  var available = _fwAvailable.filter(function(fw) { return !fw.installed; });
  if (idx >= 0 && idx < available.length) downloadFirmware(available[idx], idx);
}

async function downloadFirmware(fw, btnIdx) {
  var btn = document.getElementById('fwDlBtn' + btnIdx);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="pulse-dot" style="margin-right:6px"></span>Downloading ~35 MB...';
    btn.style.opacity = '0.8';
    btn.style.minWidth = '180px';
  }
  try {
    var d = await api('/download-firmware', 'POST', {
      url: fw.url,
      filename: fw.filename,
      version: fw.version,
      device_type: fw.device_type,
      md5: fw.md5,
      description: fw.description || ''
    });
    if (d.ok) {
      showToast('Firmware ' + fw.version + ' downloaded (' + ((d.size || 0) / 1024 / 1024).toFixed(1) + ' MB)', 'green');
      if (btn) { btn.innerHTML = '&#10003; Downloaded'; btn.style.color = '#00d4aa'; }
      loadFirmwareVersions();
      checkFirmwareUpdates();
    }
  } catch(e) {
    modalAlert('Download Failed', e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Download'; btn.style.opacity = '1'; }
  }
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
      devHtml += '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px"><span class="sn">' + sn + '</span><span style="color:#aaa">' + type + '</span></div>';
    });
    result.innerHTML = devHtml;

    // Step 2: Merge cloud records into paired sets, then import each pair in 1 call
    btn.textContent = 'Importing...';
    // Cloud may return separate records for same pair — merge by matching chargerSn/mowerSn
    var pairs = {};
    // First pass: collect all chargers and mowers
    var chargers = [], mowers = [];
    all.forEach(function(equip) {
      var sn = equip.chargerSn || equip.mowerSn || equip.sn || '';
      var name = equip.userCustomDeviceName || equip.equipmentNickName || 'My Novabot';
      if (equip.chargerSn || String(sn).startsWith('LFIC')) {
        chargers.push({ sn: equip.chargerSn || sn, address: equip.chargerAddress, channel: equip.chargerChannel, mac: equip.macAddress, name: name });
      } else if (equip.mowerSn || String(sn).startsWith('LFIN')) {
        mowers.push({ sn: equip.mowerSn || sn, mac: equip.macAddress, version: equip.sysVersion, name: name });
      }
    });
    // Pair chargers with mowers (1:1 by order, unpaired become solo entries)
    var maxLen = Math.max(chargers.length, mowers.length, 1);
    for (var pi = 0; pi < maxLen; pi++) {
      var c = chargers[pi], m = mowers[pi];
      var key = (c ? c.sn : '') + ':' + (m ? m.sn : '');
      pairs[key] = {
        deviceName: (m && m.name) || (c && c.name) || 'My Novabot',
        charger: c ? { sn: c.sn, address: c.address, channel: c.channel, mac: c.mac } : undefined,
        mower: m ? { sn: m.sn, mac: m.mac, version: m.version } : undefined,
      };
    }
    var totalMaps = 0;
    var failed = 0;
    for (var pk in pairs) {
      var p = pairs[pk];
      const r = await fetch('/api/setup/cloud-apply', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          email, password: pass,
          deviceName: p.deviceName,
          charger: p.charger || undefined,
          mower: p.mower || undefined,
        })
      });
      const rj = await r.json();
      if (rj.ok) { if (rj.mapsImported) totalMaps += rj.mapsImported; }
      else { failed++; result.innerHTML += '<div style="color:#ef4444;font-size:12px">Failed: ' + (rj.error || 'unknown') + '</div>'; }
    }

    var pairCount = Object.keys(pairs).length - failed;
    var msg = 'Imported ' + pairCount + ' device set(s)!';
    if (totalMaps > 0) msg += ' (' + totalMaps + ' map(s))';
    result.innerHTML += '<div style="color:#00d4aa;font-size:13px;margin-top:8px;font-weight:600">' + msg + '</div>';
    result.innerHTML += '<div style="margin-top:8px;padding:8px 12px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);border-radius:6px;font-size:12px;color:#f59e0b">If the Novabot app is open, log out and log back in to see your devices.</div>';
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

    var totalMapsSetup = 0;
    var chargerGps = false;
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
      if (applyData.mapsImported) totalMapsSetup += applyData.mapsImported;
      if (applyData.chargerGpsImported) chargerGps = true;
    }

    var mapInfo = '';
    if (totalMapsSetup > 0) {
      mapInfo = ' + ' + totalMapsSetup + ' map area(s)';
      if (chargerGps) mapInfo += ' + charger GPS';
    } else {
      mapInfo = ' (no maps found on cloud)';
    }
    result.innerHTML += '<p style="color:#00d4aa;font-size:13px;font-weight:600">Setup complete! ' + all.length + ' device(s)' + mapInfo + ' imported.</p>';
    result.innerHTML += '<div style="margin-top:8px;padding:8px 12px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);border-radius:6px;font-size:12px;color:#f59e0b">Open the Novabot app and log in with <b>' + email + '</b> to see your devices.</div>';
    btn.textContent = 'Done!';

    // Auto-login met de zojuist aangemaakte credentials
    try {
      const loginRes = await fetch('/api/nova-user/appUser/login', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ email, password: pass })
      });
      const loginData = await loginRes.json();
      var newToken = loginData.value && loginData.value.accessToken;
      if (newToken) {
        token = newToken;
        localStorage.setItem('admin_token', token);
        result.innerHTML += '<p style="color:#aaa;font-size:12px">Logging in...</p>';
        setTimeout(() => showApp(), 1000);
        return;
      }
    } catch(loginErr) { console.error('Auto-login failed:', loginErr); }

    // Fallback: reload naar login scherm
    setTimeout(() => location.reload(), 2000);
  } catch(e) {
    result.innerHTML = '<p style="color:#ef4444;font-size:12px">Failed: ' + e.message + '</p>';
    btn.disabled = false; btn.textContent = 'Connect & Import from Cloud';
  }
}

async function skipSetup() {
  try {
    await fetch('/api/setup/skip', {method:'POST'});
    await modalAlert('Account Created', 'Email: <b>admin@local</b><br>Password: <b>admin</b>');
    location.reload();
  } catch(e) { modalAlert('Failed', e.message); }
}

async function factoryReset() {
  var ok = await modalConfirm('Factory Reset', 'This will <b>permanently delete</b> all data:<br><br>&#8226; Your account<br>&#8226; All devices &amp; pairings<br>&#8226; All maps<br>&#8226; Schedules &amp; settings<br><br>This action <b>cannot be undone</b>.');
  if (!ok) return;
  try {
    const r = await api('/factory-reset', 'POST');
    if (r.ok) {
      token = '';
      localStorage.removeItem('admin_token');
      showSetup();
    }
  } catch(e) {
    modalAlert('Failed', e.message);
  }
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
      showToast('Session expired — please log in again', 'gray');
    }
  }

  showLogin();
})();
</script>
</body>
</html>`;
}
