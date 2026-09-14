/**
 * Route test — GET /api/dashboard/system/logs
 *
 * Mounts the dashboardRouter in a minimal Express app and verifies the
 * in-memory MQTT log buffer can be filtered and tailed.
 *
 * Heavy deps are mocked so the test stays fast.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mock heavy deps BEFORE any import of dashboard.ts ───────────
// These modules have circular-dependency / top-level side-effects that crash
// in a vitest :memory: environment.

const mockLogBuffer: any[] = [];

vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(false),
  writeRawPublish: vi.fn().mockReturnValue(false),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
}));

vi.mock('../../dashboard/socketHandler.js', () => ({
  getRecentLogs: vi.fn(() => mockLogBuffer),
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
  pushMqttLog: (entry: any) => { mockLogBuffer.push(entry); },
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

// Minimal Express wrapper
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

describe('GET /api/dashboard/system/logs', () => {
  beforeAll(() => {
    mockLogBuffer.length = 0;
  });

  it('returns empty logs when buffer is empty', async () => {
    const res = await request(server).get('/api/dashboard/system/logs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ logs: [] });
  });

  it('filters by sn parameter', async () => {
    mockLogBuffer.length = 0;
    mockLogBuffer.push(
      {
        ts: 1000,
        type: 'publish',
        clientId: 'app1',
        clientType: 'APP',
        sn: 'A',
        direction: '→DEV',
        topic: 'test',
        payload: 'data',
        encrypted: false,
      },
      {
        ts: 2000,
        type: 'publish',
        clientId: 'dev1',
        clientType: 'DEV',
        sn: 'B',
        direction: '←DEV',
        topic: 'test',
        payload: 'data',
        encrypted: false,
      },
      {
        ts: 3000,
        type: 'publish',
        clientId: 'dev2',
        clientType: 'DEV',
        sn: 'B',
        direction: '←DEV',
        topic: 'test',
        payload: 'data',
        encrypted: false,
      },
    );

    const res = await request(server).get('/api/dashboard/system/logs?sn=B');
    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(2);
    expect(res.body.logs.every((l: any) => l.sn === 'B')).toBe(true);
  });

  it('limits results using tail parameter', async () => {
    mockLogBuffer.length = 0;
    for (let i = 0; i < 250; i++) {
      mockLogBuffer.push({
        ts: i * 1000,
        type: 'publish',
        clientId: `dev${i}`,
        clientType: 'DEV',
        sn: `SN${i}`,
        direction: '←DEV',
        topic: 'test',
        payload: 'data',
        encrypted: false,
      });
    }

    const res = await request(server).get('/api/dashboard/system/logs?tail=10');
    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(10);
    // Should be the last 10 entries
    expect(res.body.logs[0].ts).toBe(240 * 1000);
    expect(res.body.logs[9].ts).toBe(249 * 1000);
  });

  it('filters by type parameter', async () => {
    mockLogBuffer.length = 0;
    mockLogBuffer.push(
      {
        ts: 1000,
        type: 'publish',
        clientId: 'dev1',
        clientType: 'DEV',
        sn: 'X',
        direction: '←DEV',
        topic: 'test',
        payload: 'data',
        encrypted: false,
      },
      {
        ts: 2000,
        type: 'connect',
        clientId: 'dev2',
        clientType: 'DEV',
        sn: 'Y',
        direction: '',
        topic: '',
        payload: '',
        encrypted: false,
      },
      {
        ts: 3000,
        type: 'publish',
        clientId: 'dev3',
        clientType: 'DEV',
        sn: 'Z',
        direction: '←DEV',
        topic: 'test',
        payload: 'data',
        encrypted: false,
      },
      {
        ts: 4000,
        type: 'connect',
        clientId: 'dev4',
        clientType: 'DEV',
        sn: 'W',
        direction: '',
        topic: '',
        payload: '',
        encrypted: false,
      },
      {
        ts: 5000,
        type: 'error',
        clientId: 'dev5',
        clientType: '?',
        sn: null,
        direction: '',
        topic: '',
        payload: '',
        encrypted: false,
      },
    );

    const res = await request(server).get('/api/dashboard/system/logs?type=connect');
    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(2);
    expect(res.body.logs.every((l: any) => l.type === 'connect')).toBe(true);
  });

  it('combines filters (type + sn)', async () => {
    mockLogBuffer.length = 0;
    mockLogBuffer.push(
      { ts: 1000, type: 'publish', clientId: 'c1', clientType: 'DEV', sn: 'A', direction: '←DEV', topic: '', payload: '', encrypted: false },
      { ts: 2000, type: 'publish', clientId: 'c2', clientType: 'DEV', sn: 'B', direction: '←DEV', topic: '', payload: '', encrypted: false },
      { ts: 3000, type: 'connect', clientId: 'c3', clientType: 'DEV', sn: 'A', direction: '', topic: '', payload: '', encrypted: false },
      { ts: 4000, type: 'connect', clientId: 'c4', clientType: 'DEV', sn: 'B', direction: '', topic: '', payload: '', encrypted: false },
    );

    const res = await request(server).get('/api/dashboard/system/logs?type=connect&sn=A');
    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].type).toBe('connect');
    expect(res.body.logs[0].sn).toBe('A');
  });

  it('clamps invalid tail to default 200', async () => {
    mockLogBuffer.length = 0;
    for (let i = 0; i < 100; i++) {
      mockLogBuffer.push({
        ts: i * 1000,
        type: 'publish',
        clientId: `c${i}`,
        clientType: 'DEV',
        sn: 'X',
        direction: '←DEV',
        topic: '',
        payload: '',
        encrypted: false,
      });
    }

    // Non-numeric tail
    const res1 = await request(server).get('/api/dashboard/system/logs?tail=abc');
    expect(res1.status).toBe(200);
    expect(res1.body.logs).toHaveLength(100); // All 100, since 200 > 100

    // Negative tail
    const res2 = await request(server).get('/api/dashboard/system/logs?tail=-5');
    expect(res2.status).toBe(200);
    expect(res2.body.logs).toHaveLength(100);

    // Zero tail
    const res3 = await request(server).get('/api/dashboard/system/logs?tail=0');
    expect(res3.status).toBe(200);
    expect(res3.body.logs).toHaveLength(100);

    // Exceeds max 500
    const res4 = await request(server).get('/api/dashboard/system/logs?tail=600');
    expect(res4.status).toBe(200);
    expect(res4.body.logs).toHaveLength(100); // Clamped to default 200, which is > 100
  });
});
