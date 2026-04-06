import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { initProxyLogger } from './proxy/proxyLogger.js';

// Start proxy logger VOOR alle andere imports — vangt alle console output op
initProxyLogger();

import http from 'http';
import path from 'path';
import express from 'express';
// initDb() wordt nu automatisch aangeroepen bij import van database.ts
import './db/database.js';
import { startMqttBroker } from './mqtt/broker.js';
import { cloudHttpProxy } from './proxy/httpProxy.js';
import { initDashboardSocket } from './dashboard/socketHandler.js';
import { adminStatusRouter } from './routes/adminStatus.js';
import { adminPageHtml } from './routes/adminPage.js';
import { authMiddleware, adminMiddleware, dashboardMiddleware } from './middleware/auth.js';
import { dashboardRouter, initFirmwareSync } from './routes/dashboard.js';

const PROXY_MODE = process.env.PROXY_MODE ?? 'local';

// Route modules
import { appUserRouter }      from './routes/nova-user/appUser.js';
import { validateRouter }     from './routes/nova-user/validate.js';
import { equipmentRouter }    from './routes/nova-user/equipment.js';
import { otaUpgradeRouter }   from './routes/nova-user/otaUpgrade.js';
import { cutGrassPlanRouter } from './routes/nova-data/cutGrassPlan.js';
import { mapRouter }          from './routes/nova-file-server/map.js';
import { logRouter }          from './routes/nova-file-server/log.js';
import { messageRouter }      from './routes/novabot-message/message.js';
import { machineMessageRouter } from './routes/novabot-message/machineMessage.js';
import { equipmentStateRouter } from './routes/nova-data/equipmentState.js';
import { adminRouter }        from './routes/admin.js';
import { networkRouter }      from './routes/nova-network/network.js';
import { setupRouter }        from './routes/setup.js';
import { setupGuard, isSetupComplete } from './middleware/setupGuard.js';

// ── DB is al geïnitialiseerd bij import van database.ts (module-level initDb())
// zodat module-level db.prepare() calls in sensorData.ts etc. niet falen.

// ── Firmware auto-sync (watches firmware directory → ota_versions DB) ─────────
initFirmwareSync();

// ── Signal history cleanup (verwijder records ouder dan 7 dagen) ──────────────
import { cleanupSignalHistory } from './mqtt/sensorData.js';
cleanupSignalHistory();

// ── MQTT Broker ───────────────────────────────────────────────────────────────
startMqttBroker().catch(err => {
  console.error('[MQTT] Broker start mislukt:', err);
  process.exit(1);
});

// ── Schedule Runner (server-managed schedules met rain pause) ──────────────
import { startScheduleRunner } from './services/scheduleRunner.js';
startScheduleRunner();

// ── Rain Monitor (actieve sessies monitoren + go_to_charge bij regen) ─────
import { startRainMonitor } from './services/rainMonitor.js';
startRainMonitor();

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request/response logger — controlled by LOG_LEVEL env var
const LOG_VERBOSE = process.env.LOG_LEVEL === 'verbose';
app.use((req, res, next) => {
  const srcIp = req.ip || req.socket.remoteAddress || '?';
  // Mask sensitive fields
  const body = JSON.stringify(req.body);
  const masked = body
    .replace(/"password":"[^"]*"/g, '"password":"***"')
    .replace(/"passwd":"[^"]*"/g, '"passwd":"***"')
    .replace(/"token":"[^"]*"/g, '"token":"***"');
  // Compact logging: skip noisy endpoints
  const isNoisy = req.path.includes('/network/connection') || req.path.includes('/up_status_info');
  if (!isNoisy || LOG_VERBOSE) {
    console.log(`[REQ] ${req.method} ${req.path} ${masked} (from ${srcIp})`);
  }

  // Echo de echostr terug in de response — WeChat-achtig verificatiepatroon
  const echostr = req.headers['echostr'] as string | undefined;

  const originalJson = res.json.bind(res);
  res.json = (data: unknown) => {
    const enriched = echostr && typeof data === 'object' && data !== null
      ? { ...(data as Record<string, unknown>), echostr }
      : data;
    if (!isNoisy || LOG_VERBOSE) {
      const resStr = JSON.stringify(enriched);
      console.log(`[RES] ${req.method} ${req.path} ${resStr.substring(0, 200)}${resStr.length > 200 ? '...' : ''}`);
    }
    return originalJson(enriched);
  };
  next();
});

// ── Mount routes ──────────────────────────────────────────────────────────────

if (PROXY_MODE === 'cloud') {
  // Cloud proxy mode: forward ALL HTTP requests to upstream cloud
  console.log('[SERVER] *** PROXY_MODE=cloud — alle HTTP requests worden doorgestuurd naar app.lfibot.com ***');
  app.use(cloudHttpProxy);
} else {
  // Normal local mode: handle requests ourselves

  // ── Setup wizard (always accessible) ────────────────────────────────────────
  app.use('/api/setup', setupRouter);

  // ── Setup guard: block app API routes until setup is complete ───────────────
  // MQTT broker and /api/setup/* always work. App routes return 503 until
  // the user completes the wizard (imports their LFI account + devices).
  app.use(setupGuard);

  // nova-user service
  // Alias: app roept /api/nova-user/user/... aan (niet /appUser/)
  // Validate routes ook under /user/ — app kan sendAppRegistEmailCode e.d. via /user/ aanroepen
  app.use('/api/nova-user/user',       validateRouter);
  app.use('/api/nova-user/user',       appUserRouter);
  app.use('/api/nova-user/appUser',    appUserRouter);
  app.use('/api/nova-user/validate',   validateRouter);
  app.use('/api/nova-user/equipment',  equipmentRouter);
  app.use('/api/nova-user/otaUpgrade', otaUpgradeRouter);

  // nova-data service
  app.use('/api/nova-data/appManage',       cutGrassPlanRouter);
  app.use('/api/nova-data/cutGrassPlan',    cutGrassPlanRouter);
  app.use('/api/nova-data/equipmentState',  equipmentStateRouter);

  // nova-file-server service
  app.use('/api/nova-file-server/map', mapRouter);
  app.use('/api/nova-file-server/log', logRouter);

  // novabot-message service (maaier stuurt naar nova-message, app naar novabot-message)
  app.use('/api/novabot-message/message',        messageRouter);
  app.use('/api/novabot-message/machineMessage',  machineMessageRouter);
  app.use('/api/nova-message/message',            messageRouter);
  app.use('/api/nova-message/machineMessage',     machineMessageRouter);

  // nova-network service (aangeroepen door charger firmware via HTTP)
  app.use('/api/nova-network/network', networkRouter);

  // admin (lokaal gebruik, geen auth)
  app.use('/api/admin', adminRouter);

  // Admin status API (always available for admin users)
  app.use('/api/admin-status', authMiddleware, adminMiddleware, adminStatusRouter);

  // Admin web page — self-contained HTML with login + dashboard
  app.get('/admin', (_req, res) => {
    res.send(adminPageHtml());
  });

  // Setup page — cloud import wizard (self-contained HTML)
  app.get('/setup', (_req, res) => {
    res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenNova Setup</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a1a;color:#e0e0e0;min-height:100vh;display:flex;justify-content:center;padding:20px}
  .container{max-width:480px;width:100%}
  h1{color:#00d4aa;font-size:28px;margin-bottom:4px}
  .subtitle{color:#666;font-size:13px;margin-bottom:24px}
  .card{background:#16213e;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #0f3460}
  .card h2{font-size:15px;color:#7c3aed;margin-bottom:12px;text-transform:uppercase;letter-spacing:1px}
  label{display:block;color:#888;font-size:13px;margin-bottom:4px;margin-top:12px}
  label:first-child{margin-top:0}
  input{width:100%;padding:10px 12px;background:#0d0d20;border:2px solid #333;border-radius:8px;color:#fff;font-size:15px}
  input:focus{border-color:#7c3aed;outline:none}
  .btn{display:block;width:100%;padding:14px;margin-top:16px;background:#7c3aed;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
  .btn:hover{background:#6d28d9}
  .btn:disabled{background:#444;cursor:not-allowed}
  .btn-green{background:#00d4aa}
  .btn-green:hover{background:#00b894}
  .msg{text-align:center;padding:10px;border-radius:8px;margin-top:12px;font-size:14px}
  .msg.ok{background:rgba(0,212,170,.15);color:#00d4aa}
  .msg.err{background:rgba(239,68,68,.15);color:#ef4444}
  .msg.warn{background:rgba(245,158,11,.15);color:#f59e0b}
  .device{display:flex;justify-content:space-between;align-items:center;padding:10px;border-radius:8px;margin-top:8px;background:rgba(255,255,255,.04)}
  .device .sn{font-family:monospace;font-size:13px;color:#a78bfa}
  .device .type{font-size:12px;color:#888}
  .step{display:none}
  .step.active{display:block}
  .spinner{display:inline-block;width:16px;height:16px;border:2px solid #fff;border-top:2px solid transparent;border-radius:50%;animation:spin 1s linear infinite;margin-right:8px;vertical-align:middle}
  @keyframes spin{to{transform:rotate(360deg)}}
  .info{font-size:12px;color:#666;margin-top:8px;line-height:1.4}
  .or{text-align:center;color:#444;margin:16px 0;font-size:13px}
</style>
</head><body>
<div class="container">
  <h1>OpenNova Setup</h1>
  <div class="subtitle">Import your devices and maps from the Novabot cloud</div>

  <!-- Step 1: Login -->
  <div id="step1" class="step active">
    <div class="card">
      <h2>Novabot Cloud Login</h2>
      <p class="info">Enter the same email and password you use in the Novabot app. This connects to the Novabot cloud to fetch your device list and maps.</p>
      <label>Email</label>
      <input type="email" id="email" placeholder="your@email.com">
      <label>Password</label>
      <input type="password" id="password" placeholder="Your Novabot password">
      <button class="btn" onclick="cloudLogin()" id="loginBtn">Connect to Novabot Cloud</button>
      <div id="loginMsg" class="msg" style="display:none"></div>
    </div>
    <div class="or">— or —</div>
    <div class="card">
      <h2>Skip Cloud Import</h2>
      <p class="info">Create a local account without importing from the cloud. You can provision devices later via BLE.</p>
      <button class="btn" style="background:#444" onclick="skipSetup()">Skip — Create Local Account</button>
    </div>
  </div>

  <!-- Step 2: Device list -->
  <div id="step2" class="step">
    <div class="card">
      <h2>Your Devices</h2>
      <div id="deviceList"></div>
      <button class="btn btn-green" onclick="importAll()" id="importBtn">Import All Devices</button>
      <div id="importMsg" class="msg" style="display:none"></div>
    </div>
  </div>

  <!-- Step 3: Done -->
  <div id="step3" class="step">
    <div class="card" style="text-align:center">
      <h2 style="color:#00d4aa">Setup Complete!</h2>
      <p style="margin:12px 0">Your devices and maps have been imported.</p>
      <p class="info">The Novabot app will now connect to this server instead of the cloud (make sure DNS is configured).</p>
      <div id="importedDevices" style="margin:16px 0"></div>
      <button class="btn btn-green" onclick="location.reload()">Done</button>
    </div>
  </div>
</div>

<script>
let cloudData = null;

function show(id) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function setMsg(id, text, type) {
  const el = document.getElementById(id);
  el.style.display = 'block';
  el.className = 'msg ' + type;
  el.textContent = text;
}

async function cloudLogin() {
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  if (!email || !password) { setMsg('loginMsg', 'Please enter email and password', 'err'); return; }

  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Connecting...';

  try {
    const res = await fetch('/api/setup/cloud-login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({email, password})
    });
    const data = await res.json();

    if (!data.ok) {
      setMsg('loginMsg', data.error || 'Login failed', 'err');
      btn.disabled = false;
      btn.textContent = 'Connect to Novabot Cloud';
      return;
    }

    cloudData = data;

    // Show devices
    const list = document.getElementById('deviceList');
    list.innerHTML = '';
    const all = [...(data.chargers||[]), ...(data.mowers||[])];
    if (all.length === 0) {
      list.innerHTML = '<div class="msg warn">No devices found on this account.</div>';
    }
    all.forEach(d => {
      const sn = d.mowerSn || d.chargerSn || d.sn || '?';
      const type = sn.startsWith('LFIC') ? 'Charger' : sn.startsWith('LFIN') ? 'Mower' : 'Unknown';
      list.innerHTML += '<div class="device"><span class="sn">' + sn + '</span><span class="type">' + type + '</span></div>';
    });

    show('step2');
  } catch(e) {
    setMsg('loginMsg', 'Connection failed — is the Novabot cloud online?', 'err');
  }

  btn.disabled = false;
  btn.textContent = 'Connect to Novabot Cloud';
}

async function importAll() {
  if (!cloudData) return;
  const btn = document.getElementById('importBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Importing...';

  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  let imported = 0;

  try {
    // Import each device set
    const all = cloudData.rawList || [];
    for (const equip of all) {
      const chargerSn = equip.chargerSn || (equip.sn?.startsWith?.('LFIC') ? equip.sn : null);
      const mowerSn = equip.mowerSn || (equip.sn?.startsWith?.('LFIN') ? equip.sn : null);

      await fetch('/api/setup/cloud-apply', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          email, password,
          deviceName: equip.userCustomDeviceName || equip.equipmentNickName || 'My Novabot',
          charger: chargerSn ? {
            sn: chargerSn,
            address: equip.chargerAddress,
            channel: equip.chargerChannel,
            mac: equip.macAddress
          } : undefined,
          mower: mowerSn ? {
            sn: mowerSn,
            mac: equip.macAddress,
            version: equip.sysVersion
          } : undefined
        })
      });
      imported++;
    }

    // Show success
    document.getElementById('importedDevices').innerHTML = imported + ' device set(s) imported.';
    show('step3');
  } catch(e) {
    setMsg('importMsg', 'Import failed: ' + e.message, 'err');
    btn.disabled = false;
    btn.textContent = 'Import All Devices';
  }
}

async function skipSetup() {
  try {
    await fetch('/api/setup/skip', {method:'POST'});
    alert('Local account created!\\n\\nEmail: admin@local\\nPassword: admin\\n\\nYou can now use the Novabot app to provision your devices.');
    location.reload();
  } catch(e) {
    alert('Failed: ' + e.message);
  }
}
</script>
</body></html>`);
  });

  // dashboard API — always mounted (setup/import routes needed by bootstrap wizard)
  app.use('/api/dashboard', dashboardRouter);

  // ── Maaier firmware log upload (geen /api/ prefix, geen auth) ───────────────
  app.post('/x3/log/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
    console.log(`[x3-log] Log upload ontvangen (${req.get('content-length') ?? '?'} bytes)`);
    res.json({ code: 200, msg: 'ok' });
  });

  // ── Static files ────────────────────────────────────────────────────────────
  const dashboardPath = path.resolve(__dirname, '../../dashboard/dist');
  // Setup wizard removed — provisioning now handled by OpenNova mobile app or bootstrap tool

  // Dashboard static files (only if ENABLE_DASHBOARD=true)
  const dashboardEnabled = process.env.ENABLE_DASHBOARD === 'true';
  if (dashboardEnabled) {
    app.use(express.static(dashboardPath));
    console.log('[DASHBOARD] Web UI enabled');
  } else {
    console.log('[DASHBOARD] Web UI disabled (set ENABLE_DASHBOARD=true to enable)');
  }

  // ── Catch-all ──────────────────────────────────────────────────────────────
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      console.warn(`[UNKNOWN] ${req.method} ${req.originalUrl}`, JSON.stringify(req.body));
      res.status(404).json({ code: 404, msg: 'Not found', data: null });
      return;
    }

    if (dashboardEnabled) {
      // Dashboard SPA fallback
      res.sendFile(path.join(dashboardPath, 'index.html'), (err) => {
        if (err) res.status(404).json({ code: 404, msg: 'Not found', data: null });
      });
    } else {
      res.status(200).send('<html><body style="background:#111;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>OpenNova</h1><p>Server is running. Use the OpenNova app to connect.</p></div></body></html>');
    }
  });
}

// ── Start server ─────────────────────────────────────────────────────────────
// TLS wordt afgehandeld door nginx proxy manager — Node.js draait puur HTTP.
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const server = http.createServer(app);
initDashboardSocket(server);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] HTTP + WebSocket listening on port ${PORT}`);
  console.log(`[SERVER] Verwacht nginx proxy manager voor TLS termination op app.lfibot.com`);
});

// ── Port 80 listener ────────────────────────────────────────────────────────
// De maaier firmware maakt HTTP calls naar app.lfibot.com:80 (plain HTTP)
// na BLE provisioning als connectivity check. Zonder port 80 denkt de maaier
// dat het netwerk niet werkt en probeert hij geen MQTT verbinding.
if (PORT !== 80) {
  const server80 = http.createServer(app);
  server80.listen(80, '0.0.0.0', () => {
    console.log(`[SERVER] HTTP also listening on port 80 (mower firmware compatibility)`);
  });
  server80.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EACCES') {
      console.warn(`[SERVER] Port 80 vereist root/sudo — maaier HTTP calls zullen falen`);
    } else if (err.code === 'EADDRINUSE') {
      console.warn(`[SERVER] Port 80 al in gebruik (nginx?) — maaier HTTP calls via nginx`);
    } else {
      console.warn(`[SERVER] Port 80 bind fout: ${err.message}`);
    }
  });
}
