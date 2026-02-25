import 'dotenv/config';
import http from 'http';
import path from 'path';
import express from 'express';
import { initDb } from './db/database.js';
import { startMqttBroker } from './mqtt/broker.js';
import { cloudHttpProxy } from './proxy/httpProxy.js';
import { initDashboardSocket } from './dashboard/socketHandler.js';
import { dashboardRouter } from './routes/dashboard.js';

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
import { adminRouter }        from './routes/admin.js';
import { networkRouter }      from './routes/nova-network/network.js';

// ── Initialise DB ─────────────────────────────────────────────────────────────
initDb();

// ── MQTT Broker ───────────────────────────────────────────────────────────────
startMqttBroker().catch(err => {
  console.error('[MQTT] Broker start mislukt:', err);
  process.exit(1);
});

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
  console.log(`[REQ] ${req.method} ${req.path} ${masked}`);

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
  // nova-user service
  app.use('/api/nova-user/appUser',    appUserRouter);
  app.use('/api/nova-user/validate',   validateRouter);
  app.use('/api/nova-user/equipment',  equipmentRouter);
  app.use('/api/nova-user/otaUpgrade', otaUpgradeRouter);

  // nova-data service
  app.use('/api/nova-data/appManage',    cutGrassPlanRouter);
  app.use('/api/nova-data/cutGrassPlan', cutGrassPlanRouter);

  // nova-file-server service
  app.use('/api/nova-file-server/map', mapRouter);
  app.use('/api/nova-file-server/log', logRouter);

  // novabot-message service
  app.use('/api/novabot-message/message', messageRouter);

  // nova-network service (aangeroepen door charger firmware via HTTP)
  app.use('/api/nova-network/network', networkRouter);

  // admin (lokaal gebruik, geen auth)
  app.use('/api/admin', adminRouter);

  // dashboard (lokaal gebruik, geen auth)
  app.use('/api/dashboard', dashboardRouter);

  // ── Dashboard static files (productie build) ────────────────────────────────
  const dashboardPath = path.resolve(__dirname, '../../novabot-dashboard/dist');
  app.use(express.static(dashboardPath));

  // ── Catch-all: log unknown API routes, SPA fallback voor dashboard ──────────
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      console.warn(`[UNKNOWN] ${req.method} ${req.originalUrl}`, JSON.stringify(req.body));
      res.status(404).json({ code: 404, msg: 'Not found', data: null });
    } else {
      // SPA fallback: serveer index.html voor alle niet-API routes
      res.sendFile(path.join(dashboardPath, 'index.html'), (err) => {
        if (err) res.status(404).json({ code: 404, msg: 'Not found', data: null });
      });
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
