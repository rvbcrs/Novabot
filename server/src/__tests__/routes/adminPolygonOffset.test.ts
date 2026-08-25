/**
 * Route tests — polygon-offset calibration endpoints
 *
 * Tests:
 *   GET  /api/admin-status/maps/:sn/polygon-offset
 *   POST /api/admin-status/maps/:sn/reset-polygon-offset
 *
 * apply-polygon-offset is verhuisd naar dashboardRouter
 * (POST /api/dashboard/maps/:sn/apply-offset) — die tests staan nu in
 * applyOffsetRoute.test.ts.
 *
 * Mock block copied verbatim from adminMapBackupRestore.test.ts so the
 * heavy dependency graph of adminStatus.ts is fully stubbed out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mock heavy deps BEFORE any import of adminStatus.ts ─────────────────────

vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(false),
  writeRawPublish: vi.fn().mockReturnValue(false),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
  banishSn: vi.fn(),
  unbanSn: vi.fn(),
  listBannedSns: vi.fn().mockReturnValue([]),
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
  awaitCommand: vi.fn(),
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

vi.mock('../../services/mdnsAdvertiser.js', () => ({
  startMdnsAdvertiser: vi.fn(),
  stopMdnsAdvertiser: vi.fn(),
  getActiveAdvertisement: vi.fn().mockReturnValue(null),
}));

vi.mock('../../services/mapBackup.js', () => ({
  listBackups: vi.fn().mockReturnValue([]),
  backupPath: vi.fn().mockReturnValue('/fake/backup.zip'),
  scheduleSnapshot: vi.fn(),
  regenerateLatestZipFromBackup: vi.fn().mockReturnValue('/fake/_latest.zip'),
}));

vi.mock('../../services/anchor.js', () => ({
  getPolygonAnchor: vi.fn().mockReturnValue(null),
}));

vi.mock('../../mqtt/sensorData.js', () => ({
  deviceCache: new Map<string, Map<string, string>>(),
}));

vi.mock('../../mqtt/mapConverter.js', () => ({
  generateMapZipFromDb: vi.fn(),
  gpsToLocal: vi.fn(),
  localToGps: vi.fn(),
  parseMapZip: vi.fn(),
  polygonArea: vi.fn().mockReturnValue(10),
}));

// ── Now import the router + deps ─────────────────────────────────────────────
import { adminStatusRouter } from '../../routes/adminStatus.js';
import { mapRepo } from '../../db/repositories/index.js';
import * as broker from '../../mqtt/broker.js';
import * as mapSync from '../../mqtt/mapSync.js';
import * as mapBackupModule from '../../services/mapBackup.js';

const app = express();
app.use(express.json());
app.use('/api/admin-status', adminStatusRouter);

// ── Constants ─────────────────────────────────────────────────────────────────

const SN = 'LFIN2230700238';

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Reset offset to known zero state before each test
  mapRepo.setPolygonOffset(SN, 0, 0);
});

describe('GET /api/admin-status/maps/:sn/polygon-offset', () => {
  it('returns 0/0 when no offset persisted', async () => {
    const r = await request(app).get(`/api/admin-status/maps/${SN}/polygon-offset`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ dx_m: 0, dy_m: 0 });
  });

  it('returns the persisted offset', async () => {
    mapRepo.setPolygonOffset(SN, 0.05, -0.03);
    const r = await request(app).get(`/api/admin-status/maps/${SN}/polygon-offset`);
    expect(r.body.dx_m).toBeCloseTo(0.05);
    expect(r.body.dy_m).toBeCloseTo(-0.03);
  });
});

describe('POST /api/admin-status/maps/:sn/reset-polygon-offset', () => {
  beforeEach(() => {
    vi.mocked(broker.isDeviceOnline).mockReturnValue(true);
    vi.mocked(mapBackupModule.regenerateLatestZipFromBackup).mockReturnValue('/fake/_latest.zip');
    vi.mocked(mapSync.onExtendedResponse).mockImplementation((_sn, handler) => {
      queueMicrotask(() => handler({ sync_map_respond: { result: 0 } } as any));
    });
    vi.mocked(mapSync.offExtendedResponse).mockImplementation(() => {});
  });

  it('writes (0,0), regenerates, and pushes sync_map', async () => {
    mapRepo.setPolygonOffset(SN, 0.05, 0.05);
    const r = await request(app).post(`/api/admin-status/maps/${SN}/reset-polygon-offset`).send({});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.dx_m).toBe(0);
    expect(r.body.dy_m).toBe(0);
    expect(mapRepo.getPolygonOffset(SN)).toEqual({ x: 0, y: 0 });
  });

  it('reset on a never-calibrated SN still works (no row → row with zeros)', async () => {
    const FRESH = 'LFIN_NEVER_CALIBRATED';
    const r = await request(app).post(`/api/admin-status/maps/${FRESH}/reset-polygon-offset`).send({});
    expect(r.status).toBe(200);
    expect(mapRepo.getPolygonOffset(FRESH)).toEqual({ x: 0, y: 0 });
  });
});
