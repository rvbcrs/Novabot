/**
 * Route tests — POST /api/dashboard/maps/:sn/apply-offset
 *
 * De polygon-offset-calibratie is verhuisd van adminStatus.ts
 * (POST /api/admin-status/maps/:sn/apply-polygon-offset) naar dashboard.ts
 * zodat de dashboard-nudge-UI (dashboard-auth, geen admin-auth) hem kan
 * aanroepen. Logica ongewijzigd — zie adminStatus.ts git-historie voor het
 * origineel. De supertest-cases hieronder zijn 1-op-1 overgenomen uit het
 * oude adminPolygonOffset.test.ts (dat blok is daar verwijderd).
 *
 * Mock-set volgt het huidige dashboard.ts-testpatroon (zie o.a.
 * edgeWatchDisarmRoutes.test.ts / autoMapRoutes.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  patchLatestZipChargingPose: vi.fn(),
  republishObstacleDetection: vi.fn(),
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

vi.mock('../../services/mapBackup.js', () => ({
  listBackups: vi.fn().mockReturnValue([]),
  backupPath: vi.fn().mockReturnValue('/fake/backup.zip'),
  scheduleSnapshot: vi.fn(),
  regenerateLatestZipFromBackup: vi.fn().mockReturnValue('/fake/_latest.zip'),
}));

// ── Nu pas dashboard.ts + deps importeren (na de mocks) ───────────
import { dashboardRouter, validateOffsetBody } from '../../routes/dashboard.js';
import { mapRepo } from '../../db/repositories/index.js';
import * as broker from '../../mqtt/broker.js';
import * as mapSync from '../../mqtt/mapSync.js';
import * as mapBackupModule from '../../services/mapBackup.js';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

const SN = 'LFIN2230700238';

beforeEach(() => {
  vi.clearAllMocks();
  mapRepo.setPolygonOffset(SN, 0, 0);
});

describe('validateOffsetBody (pure)', () => {
  it('wijst niet-eindige dx/dy af', () => {
    expect(validateOffsetBody({ dx_m: 'x', dy_m: 0 })).toEqual({ ok: false });
    expect(validateOffsetBody({ dx_m: 0.1, dy_m: 0.2 })).toEqual({ ok: true, dx: 0.1, dy: 0.2 });
  });
});

describe('POST /api/dashboard/maps/:sn/apply-offset', () => {
  beforeEach(() => {
    mapRepo.setPolygonOffset(SN, 0, 0);
    vi.mocked(broker.isDeviceOnline).mockReturnValue(true);
    vi.mocked(mapBackupModule.regenerateLatestZipFromBackup).mockReturnValue('/fake/_latest.zip');
    // Mock onExtendedResponse to immediately fire a successful sync_map_respond.
    vi.mocked(mapSync.onExtendedResponse).mockImplementation((_sn, handler) => {
      queueMicrotask(() => handler({ sync_map_respond: { result: 0 } } as any));
    });
    vi.mocked(mapSync.offExtendedResponse).mockImplementation(() => {});
  });

  it('persists offset, regenerates, and pushes sync_map on happy path', async () => {
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/apply-offset`)
      .send({ dx_m: 0.05, dy_m: -0.03 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.dx_m).toBeCloseTo(0.05);
    expect(r.body.dy_m).toBeCloseTo(-0.03);
    expect(mapRepo.getPolygonOffset(SN).x).toBeCloseTo(0.05);
    expect(mapRepo.getPolygonOffset(SN).y).toBeCloseTo(-0.03);
    expect(mapBackupModule.regenerateLatestZipFromBackup).toHaveBeenCalledWith(SN);
    expect(mapSync.publishToExtended).toHaveBeenCalledWith(SN, expect.objectContaining({ sync_map: expect.anything() }));
  });

  it('rejects non-finite dx with 400 and does not write DB', async () => {
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/apply-offset`)
      .send({ dx_m: 'banana', dy_m: 0 });
    expect(r.status).toBe(400);
    expect(mapRepo.getPolygonOffset(SN)).toEqual({ x: 0, y: 0 });
    expect(mapBackupModule.regenerateLatestZipFromBackup).not.toHaveBeenCalled();
  });

  it('rejects |dx| > 1.0 with 400 and does not write DB', async () => {
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/apply-offset`)
      .send({ dx_m: 1.5, dy_m: 0 });
    expect(r.status).toBe(400);
    expect(mapRepo.getPolygonOffset(SN)).toEqual({ x: 0, y: 0 });
  });

  it('returns 404 with partial flag when mower offline (DB still updated)', async () => {
    vi.mocked(broker.isDeviceOnline).mockReturnValue(false);
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/apply-offset`)
      .send({ dx_m: 0.02, dy_m: 0 });
    expect(r.status).toBe(404);
    expect(r.body.ok).toBe(false);
    expect(r.body.partial).toBe(true);
    expect(mapRepo.getPolygonOffset(SN).x).toBeCloseTo(0.02);
  });

  it('returns 400 when no map data found (DB still updated)', async () => {
    vi.mocked(mapBackupModule.regenerateLatestZipFromBackup).mockReturnValue(null);
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/apply-offset`)
      .send({ dx_m: 0.02, dy_m: 0 });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/map the area first/i);
    expect(mapRepo.getPolygonOffset(SN).x).toBeCloseTo(0.02);
  });
});
