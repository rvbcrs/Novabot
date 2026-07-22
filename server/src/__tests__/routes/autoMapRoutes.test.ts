/**
 * Route test — /api/dashboard/auto-map/:sn/*
 *
 * Mounts the dashboardRouter in a minimal Express app (no MQTT broker, no
 * Socket.io) and verifies the autonomous-mapping dashboard endpoints (Task 8).
 *
 * Heavy deps (broker, socketHandler, mapSync, etc.) are mocked so the test
 * stays fast and avoids the circular-init issues those modules have at
 * ESM top-level. Mock pattern mirrors terrainGet.test.ts exactly.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mock heavy deps BEFORE any import of dashboard.ts ───────────
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
  emitAutoMapProgress: vi.fn(),
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

vi.mock('../../services/autoMap.js', () => ({
  startAutoMap: vi.fn(async (_sn: string, opts: { mode: string }) =>
    opts.mode === 'record' ? { ok: true, sessionId: 7 } : { ok: false, error: 'preflight_rtk' }),
  stopAutoMap: vi.fn(),
  getStatus: vi.fn(() => ({ id: 7, sn: 'X', phase: 'following' })),
  acceptProposal: vi.fn(() => true),
  rejectProposal: vi.fn(() => false),
  onProgress: vi.fn(),
}));

// ── Now import dashboard.ts (after mocks are in place) ───────────
import { dashboardRouter } from '../../routes/dashboard.js';

// Minimal Express wrapper — mirrors how index.ts mounts the router
const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

describe('auto-map routes', () => {
  it('start geeft sessionId terug', async () => {
    const res = await request(app).post('/api/dashboard/auto-map/LFIN_X/start')
      .send({ mode: 'record', radiusM: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sessionId: 7 });
  });

  it('start met preflight-fout geeft 409', async () => {
    const res = await request(app).post('/api/dashboard/auto-map/LFIN_X/start')
      .send({ mode: 'test' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('preflight_rtk');
  });

  it('stop geeft ok:true', async () => {
    const res = await request(app).post('/api/dashboard/auto-map/LFIN_X/stop');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('status geeft sessie terug', async () => {
    const res = await request(app).get('/api/dashboard/auto-map/LFIN_X/status');
    expect(res.status).toBe(200);
    expect(res.body.phase).toBe('following');
  });

  it('accept geeft ok:true', async () => {
    const res = await request(app).post('/api/dashboard/auto-map/LFIN_X/accept');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('reject zonder review-sessie geeft ok:false', async () => {
    const res = await request(app).post('/api/dashboard/auto-map/LFIN_X/reject');
    expect(res.body).toEqual({ ok: false });
  });
});
