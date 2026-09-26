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
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Centrale firmware-gate (2026-09-09): deze tests gaan uit van een OpenNova
// custom-firmware maaier, anders weigert de server extended-commando's met 409.
vi.mock('../../services/mowerFileCapability.js', () => ({
  getMowerFileCapability: () => ({ mowerFileApplySupported: true, isOpenNova: true, mowerVersion: 'v6.0.2-custom-test', reason: null }),
  supportsMowerFileWrites: () => true,
  isOpenNovaMower: () => true,
  UNSUPPORTED_FIRMWARE_REASON: 'unsupported_firmware',
  UNSUPPORTED_FIRMWARE_MSG_KEY: 'requiresOpenNovaFirmware',
}));
vi.mock('../../services/mowerMapApply.js', () => ({ applyMapsToMower: vi.fn(), getMapApplySnapshot: vi.fn() }));
import { applyMapsToMower } from '../../services/mowerMapApply.js';
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

// Eén luisteraar voor dit hele bestand. `request(server)` laat supertest per
// verzoek een NIEUWE efemere poort openen, en dat botst onder belasting met een
// andere luisteraar: het antwoord komt dan ergens anders vandaan. Bewezen op
// 2026-09-14, een 403 op /reanchor zonder x-powered-by en zonder serverkant-
// regel in de trace, wat drie beta-builds heeft gekost.
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

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
  it('uses the confirmed shared apply pipeline', async () => {
    vi.mocked(applyMapsToMower).mockResolvedValue(true);
    const r = await request(server).post(`/api/dashboard/maps/${SN}/apply-offset`).send({ dx_m: 0.05, dy_m: -0.03 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(applyMapsToMower).toHaveBeenCalledWith(SN, { x: 0.05, y: -0.03 });
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
  });
  it.each([{ dx_m: 'banana', dy_m: 0 }, { dx_m: 1.5, dy_m: 0 }])('rejects invalid offsets before applying', async body => {
    const r = await request(server).post(`/api/dashboard/maps/${SN}/apply-offset`).send(body);
    expect(r.status).toBe(400);
    expect(applyMapsToMower).not.toHaveBeenCalled();
    expect(mapRepo.getPolygonOffset(SN)).toEqual({ x: 0, y: 0 });
  });
  it('does not report success when the confirmed pipeline fails', async () => {
    vi.mocked(applyMapsToMower).mockResolvedValue(false);
    const r = await request(server).post(`/api/dashboard/maps/${SN}/apply-offset`).send({ dx_m: 0.02, dy_m: 0 });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
  });
});
