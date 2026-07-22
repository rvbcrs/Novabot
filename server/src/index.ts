import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { readFileSync } from 'fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { initProxyLogger } from './proxy/proxyLogger.js';

// Start proxy logger VOOR alle andere imports — vangt alle console output op
initProxyLogger();

// Read version from package.json so the docker container log advertises which
// release is running. Resolved relative to this file so it works whether the
// server runs from src/ (ts-node), dist/ (compiled), or /app/server in Docker.
const SERVER_VERSION = (() => {
  for (const candidate of [
    resolvePath(__dirname, '../package.json'),
    resolvePath(__dirname, '../../package.json'),
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch { /* try next */ }
  }
  return 'unknown';
})();

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  OpenNova Server — v${SERVER_VERSION}`);
console.log(`  Started: ${new Date().toISOString()}`);
console.log(`  Node:    ${process.version}`);
console.log('═══════════════════════════════════════════════════════════');
console.log('');

import http from 'http';
import path from 'path';
import express from 'express';
// initDb() wordt nu automatisch aangeroepen bij import van database.ts
import './db/database.js';
import { startMqttBroker } from './mqtt/broker.js';
import { cloudHttpProxy } from './proxy/httpProxy.js';
import { mountCloudApi } from './cloud-api/index.js';
import { initDashboardSocket, pushMqttLog } from './dashboard/socketHandler.js';
import {
  adminStatusRouter,
  walkerBundleUploadMulter,
  handleWalkerBundleUpload,
  handleWalkerFirmwareBinary,
} from './routes/adminStatus.js';
import { adminPageHtml } from './routes/adminPage.js';
import { authMiddleware, adminMiddleware, dashboardMiddleware, verifyAuthToken } from './middleware/auth.js';
import { externalAuthGate } from './middleware/externalAuthGate.js';
import { userRepo } from './db/repositories/users.js';
import { dashboardRouter, initFirmwareSync, getOtaBaseUrl } from './routes/dashboard.js';
import { buildWalkerFirmwareLatestResponse } from './routes/walkerFirmware.js';
import { eventsRouter } from './notifications/route.js';
import { pushRegisterRouter } from './notifications/registerRoute.js';
import { renderRouter } from './render/route.js';

const PROXY_MODE = process.env.PROXY_MODE ?? 'local';

// Route modules
// Cloud-API routes (nova-*, novabot-message, nova-message alias) moved into
// `./cloud-api/` on 2026-04-23 (Task 9). They are now mounted via
// `mountCloudApi(app)`; do not re-import them here.
import { adminRouter }        from './routes/admin.js';
import { setupRouter }        from './routes/setup.js';
import { setupGuard, isSetupComplete } from './middleware/setupGuard.js';
import { createRemoteSupportRouter, attachRemoteSupportWebSocket } from './routes/remoteSupport.js';
import { Relay } from './services/remoteSupport/relay.js';
import {
  bootstrapAgent,
  approvePending,
  denyPending,
  getPendingRequest,
  killActiveSession,
  getActivePty,
} from './services/remoteSupport/agent.js';
import { getOrCreateInstanceToken } from './services/remoteSupport/instanceToken.js';
import { equipmentRepo } from './db/repositories/equipment.js';

// ── DB is al geïnitialiseerd bij import van database.ts (module-level initDb())
// zodat module-level db.prepare() calls in sensorData.ts etc. niet falen.

// ── Frame-validation state: laad de persistente frame_unvalidated vlaggen ─────
// zodat een server-herstart go_to_charge niet stilletjes deblokkeert.
import { loadFrameValidationFromDb } from './services/frameValidation.js';
loadFrameValidationFromDb();

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

// ── Soft-restart auto-recovery (sustained Error 140 + idle/charging → ROS-stack restart) ──
import { startSoftRestartMonitor } from './services/softRestart.js';
startSoftRestartMonitor();

// ── Mower IP discovery (mDNS + camera-port verify) ────────────────────────
// Houdt equipment.discovered_ip vers zodat camera/info en push-to-mower
// werken zonder dat de gebruiker handmatig een IP hoeft in te stellen.
import { startMowerIpDiscovery } from './services/mowerIpDiscovery.js';
import { startMdnsAdvertiser } from './services/mdnsAdvertiser.js';
startMowerIpDiscovery();

// ── LoRa auto-sync — detect addr/channel drift on charger (lc→hc scan) ────
// Polls alle ONLINE LFI* devices elke 60s via get_lora_info; broker.ts
// schrijft dan de actuele waardes naar equipment_lora_cache. Voorkomt
// dat UI stale data toont nadat een charger z'n channel zelf verplaatst.
import { startLoraAutoSync } from './services/loraAutoSync.js';
startLoraAutoSync();

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

// In PROXY_MODE=cloud capturen we de raw body VOOR express.json() zodat
// multipart uploads (mower ZIP uploads) intact blijven. express.json() zou
// anders multipart-bodies niet parsen maar wel de stream "claimen", waardoor
// req.body leeg blijft en onze proxy een lege body naar upstream stuurt.
if (PROXY_MODE === 'cloud') {
  app.use((req, _res, next) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      (req as unknown as { rawBody: Buffer }).rawBody = Buffer.concat(chunks);
      // Parse JSON zodat bestaande logger (regel 83) niet crasht op req.body
      const ct = req.headers['content-type'] ?? '';
      if (ct.includes('application/json') && chunks.length > 0) {
        try { req.body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { req.body = {}; }
      } else {
        req.body = {};
      }
      next();
    });
    req.on('error', next);
  });
} else {
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
}

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
  const isNoisy = req.path.includes('/network/connection') || req.path.includes('/up_status_info') || req.path.includes('/remote-debug/');
  if (!isNoisy || LOG_VERBOSE) {
    console.log(`[REQ] ${req.method} ${req.path} ${masked} (from ${srcIp})`);
    // Push HTTP requests naar admin console
    pushMqttLog({
      ts: Date.now(), type: 'http-req' as any, clientId: srcIp,
      clientType: 'APP', sn: null, direction: '' as any,
      topic: `${req.method} ${req.path}`,
      payload: masked.length > 200 ? masked.substring(0, 200) + '...' : masked,
      encrypted: false,
    });
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
      pushMqttLog({
        ts: Date.now(), type: 'http-res' as any, clientId: srcIp,
        clientType: 'APP', sn: null, direction: '' as any,
        topic: `${res.statusCode} ${req.method} ${req.path}`,
        payload: resStr.length > 200 ? resStr.substring(0, 200) + '...' : resStr,
        encrypted: false,
      });
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

  // ── Setup wizard ────────────────────────────────────────────────────────────
  // Always accessible from the LAN/VPN (installer + app + bootstrap discover and
  // provision over the local network). Provisioning actions must NOT be reachable
  // from the public internet, so the external gate applies — EXCEPT the benign
  // read-only GET /status, which the admin UI and discovery check before login to
  // decide login-vs-first-setup. Gating /status made /admin wrongly show
  // first-setup from outside (the 401 envelope has no setupComplete field).
  app.use('/api/setup', (req, res, next) => {
    if (req.method === 'GET' && req.path === '/status') { next(); return; }
    externalAuthGate(req, res, next);
  }, setupRouter);

  // Admin static assets — before setup guard so they're always accessible
  app.use('/assets', express.static(path.resolve(__dirname, '../public')));

  // ── Setup guard: block app API routes until setup is complete ───────────────
  // MQTT broker and /api/setup/* always work. App routes return 503 until
  // the user completes the wizard (imports their LFI account + devices).
  app.use(setupGuard);

  // Cloud-API frozen surface — wires every /api/nova-*\/* and
  // /api/novabot-message/* (plus /api/nova-message/* alias) endpoint onto the
  // app. Previously inline here; moved into cloud-api/index.ts on 2026-04-23.
  // Path list + router bindings are identical — see cloud-api/CHANGELOG.md.
  mountCloudApi(app);

  // admin (lokaal gebruik). LAN/VPN: geen auth zoals voorheen; publiek
  // internet: vereist een geldige login (externalAuthGate).
  app.use('/api/admin', externalAuthGate, adminRouter);

  // Admin status API (always available for admin users)
  app.use('/api/admin-status', authMiddleware, adminMiddleware, adminStatusRouter);

  // Admin web page — self-contained HTML with login + dashboard
  app.get('/admin', (_req, res) => {
    res.send(adminPageHtml());
  });


  // dashboard API — always mounted (setup/import routes needed by bootstrap wizard).
  // LAN/VPN traffic (Expo app, bootstrap wizard, local browser) passes through
  // unauthenticated as before; requests from the public internet must carry a
  // valid login token. See middleware/externalAuthGate.ts.
  app.use('/api/dashboard', externalAuthGate, dashboardRouter);

  // Remote support tunnel — relay side runs on Ramon's central instance.
  const remoteSupportAuditLogDir = path.resolve(
    process.env.STORAGE_PATH ?? '/data',
    'remote-support-logs',
  );
  if (process.env.REMOTE_SUPPORT_RELAY_ENABLED === 'true') {
    const remoteSupportRelay = new Relay();
    const remoteSupportRouter = createRemoteSupportRouter({
      mode: 'relay',
      relay: remoteSupportRelay,
      auditLogDir: remoteSupportAuditLogDir,
      isOperator: (req) => {
        // Operator = authenticated admin. `authMiddleware` sets `userId`
        // (a string) on the request — NOT `userRole` or `user`. We must
        // re-check the admin flag from the DB rather than trusting any
        // request property, since this callback can also be invoked from
        // the raw WS upgrade path (see below) where Express middleware
        // has not run.
        const userId = (req as any).userId;
        if (typeof userId !== 'string' || !userId) return false;
        try { return userRepo.isAdmin(userId); } catch { return false; }
      },
    });
    app.use('/api/remote-support', authMiddleware, remoteSupportRouter);
    // WS upgrade wiring is deferred to after `server` is created below.
    (app as any)._remoteSupportRelay = remoteSupportRelay;
    (app as any)._remoteSupportRouter = remoteSupportRouter;
    (app as any)._remoteSupportAuditLogDir = remoteSupportAuditLogDir;
    console.log('[remote-support] relay enabled on /api/remote-support');
  }

  // Agent — runs on EVERY user instance (relay-only instances skip this).
  // Bootstrapping the agent is unconditional: the actual outbound dial is
  // gated by the `/data/.remote_support_enabled` toggle file the user
  // writes via the admin UI, so a freshly-installed container costs
  // nothing until support is requested. Drop-in zero-config — users no
  // longer need to set REMOTE_SUPPORT_ENABLED or REMOTE_SUPPORT_SECRET.
  if (process.env.REMOTE_SUPPORT_RELAY_ENABLED !== 'true') {
    try {
      const storagePath = process.env.STORAGE_PATH ?? '/data';
      const ownSn = equipmentRepo.listAll()[0]?.mower_sn ?? `HOST-${process.env.HOSTNAME ?? 'unknown'}`;
      const token = getOrCreateInstanceToken(storagePath);
      const relayUrl = process.env.REMOTE_SUPPORT_RELAY_URL
        ?? 'wss://opennova.ramonvanbruggen.nl/api/remote-support/agent';
      bootstrapAgent({
        sn: ownSn,
        token,
        relayUrl,
      });
      const agentRouter = createRemoteSupportRouter({
        mode: 'agent',
        auditLogDir: remoteSupportAuditLogDir,
        approveRequest: (requestId) => { approvePending(requestId); },
        denyRequest: (requestId) => { denyPending(requestId); },
        getPendingRequest: () => getPendingRequest(),
        killSession: () => killActiveSession(),
        isSessionActive: () => getActivePty() !== null,
      });
      app.use('/api/remote-support', authMiddleware, agentRouter);
      console.log(`[remote-support] agent registered for ${ownSn}`);
    } catch (err) {
      console.error('[remote-support] agent bootstrap failed:', err);
    }
  }

  // Notification event ring (HTTP polling for HA / scripts)
  app.use('/api/events', eventsRouter);

  // Expo push token registration (OpenNova mobile app uploads on launch)
  app.use('/api/push', pushRegisterRouter);

  // Rendered mower map SVG (used by HA's MQTT image entity + manual viewers)
  app.use('/api/render', renderRouter);

  // ── Walker firmware OTA check (public, LAN-only) ────────────────────────────
  // The RTK walker polls this endpoint to discover newer firmware. It has no
  // admin credentials at check-time; the binary endpoint below
  // (/api/admin-status/walker-firmware/binary/:filename) is bearer-protected
  // and the walker stores the admin token in NVS.
  // Version strings use the `YYYY.MMDD.HHMM` date format — lexicographic
  // comparison is correct.
  // Walker bundle upload (SN-agnostic library). Mounted publicly, no
  // auth — the walker has no good way to hold a Bearer token and the
  // threat model is LAN-only. Assign-to-mower (the dangerous step) is
  // still admin-auth on the adminStatusRouter side.
  app.post('/api/walker-bundles', walkerBundleUploadMulter, handleWalkerBundleUpload);

  // Public OTA binary download — same LAN-only reasoning as bundle upload.
  // Walker no longer carries an admin token, so the firmware path it gets
  // back from /api/walker-firmware/latest has to be reachable without auth.
  app.get('/api/walker-firmware/binary/:filename', handleWalkerFirmwareBinary);

  app.get('/api/walker-firmware/latest', (req: express.Request, res: express.Response) => {
    const currentVersion = String(req.query.currentVersion ?? '');
    res.json(buildWalkerFirmwareLatestResponse(currentVersion, getOtaBaseUrl()));
  });

  // App self-update flow lives entirely client-side now: the app polls the
  // central NAS host (downloads.ramonvanbruggen.nl) directly. No server
  // endpoint or static APK serving needed here.

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

// ── Autonoom karteren: voortgang → dashboard-socket ────────────────────────
import { onProgress as onAutoMapProgress } from './services/autoMap.js';
import { emitAutoMapProgress } from './dashboard/socketHandler.js';
onAutoMapProgress(emitAutoMapProgress);

// Attach remote support WebSocket upgrade handler once `server` exists.
if (process.env.REMOTE_SUPPORT_RELAY_ENABLED === 'true') {
  attachRemoteSupportWebSocket(server, (app as any)._remoteSupportRouter, {
    relay: (app as any)._remoteSupportRelay,
    auditLogDir: (app as any)._remoteSupportAuditLogDir,
    // The WS upgrade does NOT pass through `authMiddleware` — `req` is the
    // raw IncomingMessage. Validate the JWT ourselves and require the
    // caller to be an admin. Accept the token from either the
    // `Authorization` header (Bearer / raw) or a `?token=` query param
    // since browser WebSocket clients cannot set arbitrary headers.
    isOperator: (req) => {
      try {
        const raw = req as unknown as { headers?: Record<string, string | string[] | undefined>; url?: string };
        const authHeader = (raw.headers?.authorization as string | undefined) ?? '';
        let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
        if (!token && raw.url) {
          try {
            const u = new URL(raw.url, 'http://localhost');
            token = u.searchParams.get('token') ?? '';
          } catch { /* ignore malformed URL */ }
        }
        if (!token) return false;
        const decoded = verifyAuthToken(token);
        if (!decoded?.userId) return false;
        return userRepo.isAdmin(decoded.userId);
      } catch {
        return false;
      }
    },
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] OpenNova v${SERVER_VERSION} — HTTP + WebSocket listening on port ${PORT}`);
  console.log(`[SERVER] Verwacht nginx proxy manager voor TLS termination op app.lfibot.com`);
  startMdnsAdvertiser();
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
