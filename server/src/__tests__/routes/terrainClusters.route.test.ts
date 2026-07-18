/**
 * Route tests — terrain-clusters / terrain-crops (objectherkenning-plan
 * Task 7). Mounts dashboardRouter in a minimal Express app, same heavy-mock
 * pattern as terrainGet.test.ts, so the circular-init-prone modules
 * (broker, socketHandler, mapSync, ...) never load for real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';

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
import { terrainClusterRepo } from '../../db/repositories/index.js';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

const SN = 'LFIN2230700238';
const BASE_ROW = {
  mower_sn: SN, cluster_key: '1,2', cx: 1.2, cy: 3.4,
  min_x: 1, min_y: 3, max_x: 2, max_y: 4, cells: 40, max_h: 0.6,
};

describe('GET /api/dashboard/terrain-clusters/:sn', () => {
  it('400 bij een ongeldige sn (encoded slash — anders normaliseert Express de route weg)', async () => {
    const res = await request(app).get('/api/dashboard/terrain-clusters/..%2f..%2fx');
    expect(res.status).toBe(400);
  });

  it('lege lijst zonder clusters', async () => {
    const res = await request(app).get('/api/dashboard/terrain-clusters/LFIN0000000010');
    expect(res.status).toBe(200);
    expect(res.body.clusters).toEqual([]);
  });

  it('levert het volledige cluster-shape, className = model zonder override', async () => {
    terrainClusterRepo.upsert({ ...BASE_ROW, class_name: 'trampoline', confidence: 0.62, crop_file: '1,2.jpg' });
    const res = await request(app).get(`/api/dashboard/terrain-clusters/${SN}`);
    expect(res.status).toBe(200);
    expect(res.body.clusters).toEqual([{
      key: '1,2', cx: 1.2, cy: 3.4, minX: 1, minY: 3, maxX: 2, maxY: 4,
      cells: 40, maxH: 0.6,
      className: 'trampoline', nl: 'Trampoline', confidence: 0.62,
      userOverride: null, photoUrl: `/api/dashboard/terrain-crops/${SN}/1,2.jpg`,
    }]);
  });

  it('className = override (wint van het model) en nl volgt de override', async () => {
    terrainClusterRepo.upsert({ ...BASE_ROW, class_name: 'trampoline', confidence: 0.62, crop_file: '1,2.jpg' });
    terrainClusterRepo.setOverride(SN, '1,2', 'tree');
    const res = await request(app).get(`/api/dashboard/terrain-clusters/${SN}`);
    expect(res.body.clusters[0].className).toBe('tree');
    expect(res.body.clusters[0].nl).toBe('Boom');
    expect(res.body.clusters[0].userOverride).toBe('tree');
  });

  it('photoUrl is null zonder crop_file', async () => {
    terrainClusterRepo.upsert({ ...BASE_ROW, class_name: null, confidence: null, crop_file: null });
    const res = await request(app).get(`/api/dashboard/terrain-clusters/${SN}`);
    expect(res.body.clusters[0].photoUrl).toBeNull();
    expect(res.body.clusters[0].className).toBeNull();
    expect(res.body.clusters[0].nl).toBeNull();
  });
});

describe('GET /api/dashboard/terrain-crops/:sn/:file', () => {
  it('400 bij een ongeldige sn (encoded slash)', async () => {
    const res = await request(app).get('/api/dashboard/terrain-crops/..%2f..%2fx/1,2.jpg');
    expect(res.status).toBe(400);
  });

  it('400 bij een bestandsnaam buiten de whitelist (path-traversal guard)', async () => {
    const res = await request(app).get(`/api/dashboard/terrain-crops/${SN}/..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(400);
  });

  it('404 als de foto niet bestaat', async () => {
    const res = await request(app).get(`/api/dashboard/terrain-crops/${SN}/9,9.jpg`);
    expect(res.status).toBe(404);
  });

  it('200 met de jpeg-bytes als de foto bestaat', async () => {
    const dir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain', 'crops', SN);
    fs.mkdirSync(dir, { recursive: true });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    fs.writeFileSync(path.join(dir, '1,2.jpg'), jpeg);
    const res = await request(app).get(`/api/dashboard/terrain-crops/${SN}/1,2.jpg`)
      .buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(jpeg)).toBe(true);
  });
});

describe('POST /api/dashboard/terrain-clusters/:sn/:key/override', () => {
  beforeEach(() => {
    terrainClusterRepo.upsert({ ...BASE_ROW, class_name: 'trampoline', confidence: 0.62, crop_file: '1,2.jpg' });
  });

  it('400 bij een ongeldige sn (encoded slash)', async () => {
    const res = await request(app).post('/api/dashboard/terrain-clusters/..%2f..%2fx/1,2/override').send({ className: 'tree' });
    expect(res.status).toBe(400);
  });

  it('400 bij een className die niet in LABELS voorkomt', async () => {
    const res = await request(app).post(`/api/dashboard/terrain-clusters/${SN}/1,2/override`).send({ className: 'unicorn' });
    expect(res.status).toBe(400);
  });

  it('404 als het cluster niet bestaat', async () => {
    const res = await request(app).post(`/api/dashboard/terrain-clusters/${SN}/9,9/override`).send({ className: 'tree' });
    expect(res.status).toBe(404);
  });

  it('200 en zet de override', async () => {
    const res = await request(app).post(`/api/dashboard/terrain-clusters/${SN}/1,2/override`).send({ className: 'tree' });
    expect(res.status).toBe(200);
    expect(terrainClusterRepo.findBySn(SN)[0].user_override).toBe('tree');
  });

  it('200 met className:null wist de override', async () => {
    terrainClusterRepo.setOverride(SN, '1,2', 'tree');
    const res = await request(app).post(`/api/dashboard/terrain-clusters/${SN}/1,2/override`).send({ className: null });
    expect(res.status).toBe(200);
    expect(terrainClusterRepo.findBySn(SN)[0].user_override).toBeNull();
  });
});
