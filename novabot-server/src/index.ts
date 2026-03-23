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

// Request/response logger — helpful during reverse engineering unknown payloads
app.use((req, res, next) => {
  const body = JSON.stringify(req.body);
  const masked = body.replace(/"password":"[^"]*"/g, '"password":"***"');
  // Log ook headers bij login requests voor debugging
  if (req.path.includes('login')) {
    console.log(`[HDR] ${JSON.stringify(req.headers)}`);
  }
  const srcIp = req.ip || req.socket.remoteAddress || '?';
  console.log(`[REQ] ${req.method} ${req.path} ${masked} (from ${srcIp})`);

  // Echo de echostr terug in de response — WeChat-achtig verificatiepatroon
  const echostr = req.headers['echostr'] as string | undefined;

  const originalJson = res.json.bind(res);
  res.json = (data: unknown) => {
    const enriched = echostr && typeof data === 'object' && data !== null
      ? { ...(data as Record<string, unknown>), echostr }
      : data;
    console.log(`[RES] ${req.method} ${req.path} ${JSON.stringify(enriched)}`);
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

  // dashboard (lokaal gebruik, geen auth)
  app.use('/api/dashboard', dashboardRouter);

  // ── Maaier firmware log upload (geen /api/ prefix, geen auth) ───────────────
  app.post('/x3/log/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
    console.log(`[x3-log] Log upload ontvangen (${req.get('content-length') ?? '?'} bytes)`);
    res.json({ code: 200, msg: 'ok' });
  });

  // ── Static files ────────────────────────────────────────────────────────────
  const dashboardPath = path.resolve(__dirname, '../../novabot-dashboard/dist');
  const setupWizardPath = path.resolve(__dirname, '../../setup-wizard');

  // Setup wizard static files (always served at /setup)
  app.use('/setup', express.static(setupWizardPath));

  // Dashboard static files (only when setup is complete)
  app.use(express.static(dashboardPath));

  // ── Catch-all ──────────────────────────────────────────────────────────────
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      console.warn(`[UNKNOWN] ${req.method} ${req.originalUrl}`, JSON.stringify(req.body));
      res.status(404).json({ code: 404, msg: 'Not found', data: null });
      return;
    }

    // Setup wizard fallback
    if (req.path.startsWith('/setup') || !isSetupComplete()) {
      res.sendFile(path.join(setupWizardPath, 'index.html'), (err) => {
        if (err) res.status(404).send('Setup wizard not found. Rebuild with: npm run build:setup');
      });
      return;
    }

    // Dashboard SPA fallback
    res.sendFile(path.join(dashboardPath, 'index.html'), (err) => {
      if (err) res.status(404).json({ code: 404, msg: 'Not found', data: null });
    });
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
