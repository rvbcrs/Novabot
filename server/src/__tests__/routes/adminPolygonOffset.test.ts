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
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
vi.mock('../../services/mowerMapApply.js', () => ({ applyMapsToMower: vi.fn(), getMapApplySnapshot: vi.fn() }));
import { applyMapsToMower } from '../../services/mowerMapApply.js';
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

// Eén luisteraar voor dit hele bestand. `request(server)` laat supertest per
// verzoek een NIEUWE efemere poort openen, en dat botst onder belasting met een
// andere luisteraar: het antwoord komt dan ergens anders vandaan. Bewezen op
// 2026-09-14, een 403 op /reanchor zonder x-powered-by en zonder serverkant-
// regel in de trace, wat drie beta-builds heeft gekost.
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

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
    const r = await request(server).get(`/api/admin-status/maps/${SN}/polygon-offset`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ dx_m: 0, dy_m: 0 });
  });

  it('returns the persisted offset', async () => {
    mapRepo.setPolygonOffset(SN, 0.05, -0.03);
    const r = await request(server).get(`/api/admin-status/maps/${SN}/polygon-offset`);
    expect(r.body.dx_m).toBeCloseTo(0.05);
    expect(r.body.dy_m).toBeCloseTo(-0.03);
  });
});

describe('POST /api/admin-status/maps/:sn/reset-polygon-offset', () => {
  it('uses the same confirmed apply pipeline for zero offsets', async () => {
    vi.mocked(applyMapsToMower).mockResolvedValue(true);
    const r = await request(server).post(`/api/admin-status/maps/${SN}/reset-polygon-offset`).send({});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(applyMapsToMower).toHaveBeenCalledWith(SN, { x: 0, y: 0 });
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
  });
  it('keeps a refused reset from being reported as successful', async () => {
    vi.mocked(applyMapsToMower).mockResolvedValue(false);
    const r = await request(server).post(`/api/admin-status/maps/${SN}/reset-polygon-offset`).send({});
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
  });
});
