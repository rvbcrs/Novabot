/**
 * Route test — GET /api/dashboard/system/health
 *
 * Mounts the dashboardRouter in a minimal Express app (no MQTT broker, no
 * Socket.io) and verifies the shape of the JSON response.
 *
 * Heavy deps (broker, socketHandler, mapSync, etc.) are mocked so the test
 * stays fast and avoids the circular-init issues those modules have at
 * ESM top-level.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mock heavy deps BEFORE any import of dashboard.ts ───────────
// These modules have circular-dependency / top-level side-effects that crash
// in a vitest :memory: environment.  The health route doesn't use them.

vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(false),
  writeRawPublish: vi.fn().mockReturnValue(false),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
}));

vi.mock('../../dashboard/socketHandler.js', () => ({
  getRecentLogs: vi.fn().mockReturnValue([]),
  forwardToDashboard: vi.fn(),
  onLogEntry: vi.fn(),
  emitMapsChanged: vi.fn(),
  emitDeviceOnline: vi.fn(),
  emitDeviceOffline: vi.fn(),
  emitTrailClear: vi.fn(),
  emitCoveredLanes: vi.fn(),
  setDemoModeChecker: vi.fn(),
  setOutlineEmitter: vi.fn(),
  initBleLogger: vi.fn(),
  sendBleLogHistory: vi.fn(),
  pushMqttLog: vi.fn(),
  emitOtaEvent: vi.fn(),
  emitPinEvent: vi.fn(),
  emitExtendedEvent: vi.fn(),
  emitCommandRespond: vi.fn(),
}));

vi.mock('../../mqtt/mapSync.js', () => ({
  requestMapList: vi.fn(),
  requestMapOutline: vi.fn(),
  publishToDevice: vi.fn(),
  publishRawToDevice: vi.fn(),
  publishEncryptedOnTopic: vi.fn(),
  publishToTopic: vi.fn(),
  goToChargePayload: vi.fn(),
  getNextCmdNum: vi.fn().mockReturnValue(1),
  initMapSync: vi.fn(),
  handleMapMessage: vi.fn(),
  handleExtendedResponse: vi.fn(),
  handleDeviceResponse: vi.fn(),
  publishToExtended: vi.fn(),
  onExtendedResponse: vi.fn(),
  offExtendedResponse: vi.fn(),
  notifyRespond: vi.fn(),
  setDemoInterceptor: vi.fn(),
  onMowerConnected: vi.fn(),
}));

vi.mock('../../mqtt/mapConverter.js', () => ({
  generateMapZipFromDb: vi.fn(),
  gpsToLocal: vi.fn(),
  localToGps: vi.fn(),
  parseMapZip: vi.fn(),
}));

vi.mock('../../services/demoSimulator.js', () => ({
  isDemoMode: vi.fn().mockReturnValue(false),
  setDemoMode: vi.fn(),
  getDemoStatus: vi.fn().mockReturnValue({}),
  setDemoInterceptor: vi.fn(),
}));

vi.mock('../../services/mowerIpDiscovery.js', () => ({
  resolveMowerIp: vi.fn().mockResolvedValue(null),
  startMowerIpDiscovery: vi.fn(),
}));

// ── Now import dashboard.ts (after mocks are in place) ───────────
import { dashboardRouter } from '../../routes/dashboard.js';

// Minimal Express wrapper — mirrors how index.ts mounts the router
const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

// Eén luisteraar voor dit hele bestand. `request(server)` laat supertest per
// verzoek een NIEUWE efemere poort openen, en dat botst onder belasting met een
// andere luisteraar: het antwoord komt dan ergens anders vandaan. Bewezen op
// 2026-09-14, een 403 op /reanchor zonder x-powered-by en zonder serverkant-
// regel in de trace, wat drie beta-builds heeft gekost.
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

describe('GET /api/dashboard/system/health', () => {
  it('returns mDNS state, server uptime, and per-mower online flags', async () => {
    const res = await request(server).get('/api/dashboard/system/health');
    expect(res.status).toBe(200);

    // mdns block
    expect(res.body).toHaveProperty('mdns');
    expect(typeof res.body.mdns.running).toBe('boolean');
    expect(res.body.mdns).toHaveProperty('advertisement');

    // server block
    expect(res.body).toHaveProperty('server');
    expect(typeof res.body.server.uptimeSec).toBe('number');
    expect(res.body.server.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.server.startedAt).toBe('string');
    // startedAt must be a parseable ISO timestamp
    expect(new Date(res.body.server.startedAt).getTime()).toBeGreaterThan(0);

    // mowers block
    expect(Array.isArray(res.body.mowers)).toBe(true);
    for (const m of res.body.mowers) {
      expect(typeof m.sn).toBe('string');
      expect(typeof m.online).toBe('boolean');
      expect(typeof m.sensorKeys).toBe('number');
      expect(m.sensorKeys).toBeGreaterThanOrEqual(0);
    }
  });

  it('mowers array is empty when no equipment rows exist', async () => {
    // The in-memory DB is wiped before each test by setup.ts beforeEach
    const res = await request(server).get('/api/dashboard/system/health');
    expect(res.status).toBe(200);
    expect(res.body.mowers).toHaveLength(0);
  });
});
