/**
 * Route test — GET /api/dashboard/maps/:sn — charger GPS auto-detect
 *
 * Tests the behaviour where, when charger_lat/charger_lng are NULL in
 * map_calibration but the mower is currently at the dock (map_position ≈ 0,0
 * AND recharge_status contains "charging"), the handler auto-detects the
 * charger GPS from the mower's current GPS and persists it.
 *
 * Mock pattern mirrors dashboardSystemHealth.test.ts exactly.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
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

// Mock sensorData so tests can seed deviceCache without a live MQTT broker
vi.mock('../../mqtt/sensorData.js', () => {
  const deviceCache = new Map<string, Map<string, string>>();
  return {
    deviceCache,
    getAllDeviceSnapshots: vi.fn().mockReturnValue({}),
    getDeviceSnapshot: vi.fn().mockReturnValue(null),
    SENSORS: [],
    getGpsTrail: vi.fn().mockReturnValue([]),
    clearGpsTrail: vi.fn(),
    getLocalTrail: vi.fn().mockReturnValue([]),
    clearLocalTrail: vi.fn(),
    translateValue: vi.fn().mockImplementation((_f: string, v: string) => v),
    markPinVerified: vi.fn(),
    getDockPose: vi.fn().mockReturnValue(null),
  };
});

// ── Now import dashboard.ts and sensorData (after mocks are in place) ───────
import { dashboardRouter } from '../../routes/dashboard.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { equipmentRepo } from '../../db/repositories/equipment.js';
import { mapRepo } from '../../db/repositories/maps.js';

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

const TEST_SN = 'LFIN9990000001';

/** Seed a minimal equipment row so the DB FK constraints pass. */
function seedEquipment() {
  equipmentRepo.create({
    equipment_id: `EQ_${TEST_SN}`,
    mower_sn: TEST_SN,
    charger_sn: null,
    nick_name: null,
    mac_address: null,
    user_id: null,
  });
}

/** Build a sensor map for the mower at the dock. */
function makeDockSensors(opts: {
  lat?: string;
  lng?: string;
  mapX?: string;
  mapY?: string;
  recharge?: string;
} = {}): Map<string, string> {
  return new Map<string, string>([
    ['latitude',        opts.lat      ?? '52.14088833563'],
    ['longitude',       opts.lng      ?? '6.2310356968'],
    ['map_position_x',  opts.mapX     ?? '0'],
    ['map_position_y',  opts.mapY     ?? '0'],
    // recharge_status in deviceCache is the RAW integer string from the
    // mower (e.g. '0' = not charging, '1' = charging, '9' = charging
    // variant). The translated display 'Charging (9)' is added at API
    // serialise time, not in the cache.
    ['recharge_status', opts.recharge ?? '9'],
  ]);
}

// Clear deviceCache before each test (DB is wiped by global setup.ts beforeEach)
beforeEach(() => {
  (deviceCache as Map<string, Map<string, string>>).clear();
});

describe('GET /api/dashboard/maps/:sn — charger GPS auto-detect', () => {
  it('case 1: no deviceCache entry, no calibration → chargerGps: null', async () => {
    seedEquipment();
    // deviceCache is empty, no calibration row

    const res = await request(server).get(`/api/dashboard/maps/${TEST_SN}`);
    expect(res.status).toBe(200);
    expect(res.body.chargerGps).toBeNull();
  });

  it('case 2: deviceCache has GPS and mower is at dock → chargerGps populated', async () => {
    seedEquipment();
    (deviceCache as Map<string, Map<string, string>>).set(TEST_SN, makeDockSensors());

    const res = await request(server).get(`/api/dashboard/maps/${TEST_SN}`);
    expect(res.status).toBe(200);
    expect(res.body.chargerGps).not.toBeNull();
    expect(res.body.chargerGps.lat).toBeCloseTo(52.14088833563, 5);
    expect(res.body.chargerGps.lng).toBeCloseTo(6.2310356968, 5);
  });

  it('case 3: after case 2, calibration is persisted → second request returns same chargerGps even with empty cache', async () => {
    seedEquipment();
    (deviceCache as Map<string, Map<string, string>>).set(TEST_SN, makeDockSensors());

    // First request — triggers auto-detect + persist
    await request(server).get(`/api/dashboard/maps/${TEST_SN}`);

    // Clear the deviceCache to simulate mower going offline
    (deviceCache as Map<string, Map<string, string>>).clear();

    // Second request — should read from DB calibration row
    const res = await request(server).get(`/api/dashboard/maps/${TEST_SN}`);
    expect(res.status).toBe(200);
    expect(res.body.chargerGps).not.toBeNull();
    expect(res.body.chargerGps.lat).toBeCloseTo(52.14088833563, 5);
    expect(res.body.chargerGps.lng).toBeCloseTo(6.2310356968, 5);
  });

  it('case 4: mower at dock with non-zero map_position still auto-detects (charging_pose can be any value)', async () => {
    seedEquipment();
    (deviceCache as Map<string, Map<string, string>>).set(
      TEST_SN,
      makeDockSensors({ mapX: '-1.23', mapY: '0.50' }),
    );

    const res = await request(server).get(`/api/dashboard/maps/${TEST_SN}`);
    expect(res.status).toBe(200);
    expect(res.body.chargerGps).not.toBeNull();
  });

  it('case 5: deviceCache has GPS but recharge_status is "0" (not charging) → chargerGps: null', async () => {
    seedEquipment();
    (deviceCache as Map<string, Map<string, string>>).set(
      TEST_SN,
      makeDockSensors({ recharge: '0' }),
    );

    const res = await request(server).get(`/api/dashboard/maps/${TEST_SN}`);
    expect(res.status).toBe(200);
    expect(res.body.chargerGps).toBeNull();
  });
});
