/**
 * Zone kopiëren van een andere maaier: preview en copy routes.
 * Spec: docs/superpowers/specs/2026-09-24-copy-zone-between-mowers-design.md
 * Mocks zijn dezelfde als in dashboardMapWriteStock.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(true),
  writeRawPublish: vi.fn().mockReturnValue(false),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
  forceDisconnectDevice: vi.fn(),
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

vi.mock('../../mqtt/sensorData.js', () => ({
  deviceCache: new Map<string, Map<string, string>>(),
  getDockPose: vi.fn().mockReturnValue(null),
  // Faithful enough for the re-anchor gate: maps the raw GGA quality code to
  // the display label (4 = RTK Fixed, 5 = RTK Float), passthrough otherwise.
  translateValue: (field: string, raw: string) =>
    field === 'rtk_fix_quality'
      ? ({ '0': 'No fix', '1': 'GPS', '2': 'DGPS', '4': 'RTK Fixed', '5': 'RTK Float' } as Record<string, string>)[raw] ?? raw
      : raw,
  clearLocalTrail: vi.fn(),
  clearGpsTrail: vi.fn(),
  plannedPathCache: new Map(),
  previewPathCache: new Map(),
}));



const fw = vi.hoisted(() => ({ supported: false }));
vi.mock('../../services/mowerFileCapability.js', () => ({
  getMowerFileCapability: () => ({ mowerFileApplySupported: fw.supported, isOpenNova: fw.supported, mowerVersion: null, reason: null }),
  supportsMowerFileWrites: () => fw.supported,
  isOpenNovaMower: () => fw.supported,
  UNSUPPORTED_FIRMWARE_REASON: 'unsupported_firmware',
  UNSUPPORTED_FIRMWARE_MSG_KEY: 'requiresOpenNovaFirmware',
}));

import { dashboardRouter } from '../../routes/dashboard.js';
import { publishToExtended } from '../../mqtt/mapSync.js';
import { isDeviceOnline } from '../../mqtt/broker.js';
import { mapRepo } from '../../db/repositories/index.js';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

const A = 'LFIN_COPY_A';
const B = 'LFIN_COPY_B';
const square = (x0: number, y0: number, size = 10) => [
  { x: x0, y: y0 }, { x: x0 + size, y: y0 }, { x: x0 + size, y: y0 + size }, { x: x0, y: y0 + size },
];
const dockA = { x: 0.03, y: 0.73 };
const dockB = { x: 0.1, y: -0.5 };
const addRow = (sn: string, canonical: string, type: string, pts: unknown[], alias: string | null = null) =>
  mapRepo.create({ map_id: `${sn}-${canonical}`, mower_sn: sn, map_name: alias, map_type: type, map_area: JSON.stringify(pts), canonical_name: canonical });
const url = (suffix = '') => `/api/dashboard/maps/${B}/copy-from/${A}${suffix}`;

describe('zone copy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fw.supported = true;
    vi.mocked(isDeviceOnline).mockReturnValue(true);
    for (const sn of [A, B]) for (const m of mapRepo.findByMowerSn(sn)) mapRepo.deleteById(m.map_id);
    addRow(A, 'map0', 'work', square(0, 0), 'Grote tuin');
    addRow(A, 'map0_0_obstacle', 'obstacle', square(2, 2, 2));
    addRow(A, 'map0tocharge_unicom', 'unicom', [dockA, { x: -0.4, y: 0.94 }]);
    addRow(B, 'map0tocharge_unicom', 'unicom', [dockB, { x: 0.3, y: -0.8 }]);
  });

  it('preview: 200 met plan, geen DB-mutatie, geen push', async () => {
    const res = await request(server).post(url('/preview')).send({ canonical: 'map0', dockAtB: dockB });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.canonical).toBe('map0');
    expect(res.body.sourceAlias).toBe('Grote tuin');
    expect(res.body.channels[0].canonical).toBe('map0tocharge_unicom');
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
    expect(publishToExtended).not.toHaveBeenCalled();
  });

  it('preview: refusal komt als 200 met ok:false en leesbare tekst', async () => {
    const res = await request(server).post(url('/preview')).send({ canonical: 'map0', dockAtB: { x: 50, y: 50 } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.refusal).toBe('too_far_from_dock');
    expect(typeof res.body.error).toBe('string');
  });

  it('preview zonder dockAtB: 400 bad_dock, niets geschreven', async () => {
    const res = await request(server).post(url('/preview')).send({ canonical: 'map0' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('bad_dock');
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
  });

  it('copy: rijen + sync_map-push, antwoord zoals de tekenroute', async () => {
    const res = await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.map.canonicalName).toBe('map0');
    expect(res.body.map.mapName).toMatch(/^Grote tuin \((copy|kopie)\)$/);
    expect(res.body.map.mapType).toBe('work');
    expect(res.body.obstacles).toEqual(['map0_0_obstacle']);
    expect(res.body.channels).toEqual(['map0tocharge_unicom']);
    expect(res.body.needsChannel).toBe(false);
    const rows = mapRepo.findByMowerSn(B).map(r => r.canonical_name).sort();
    expect(rows).toEqual(['map0', 'map0_0_obstacle', 'map0tocharge_unicom']);
    await new Promise(r => setTimeout(r, 0));
    const sent = vi.mocked(publishToExtended).mock.calls.map(c => Object.keys(c[1] as object)[0]);
    expect(sent).toEqual(['sync_map']);
  });

  it('copy: eigen naam wint van de bron-alias', async () => {
    const res = await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB, name: 'Achtertuin' });
    expect(res.body.map.mapName).toBe('Achtertuin');
  });

  it('copy: 409 offline, niets geschreven', async () => {
    vi.mocked(isDeviceOnline).mockReturnValue(false);
    const res = await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('offline');
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
  });

  it('copy: 409 met refusal-reden als het plan weigert', async () => {
    const res = await request(server).post(url()).send({ canonical: 'map0', dockAtB: { x: 50, y: 50 } });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('too_far_from_dock');
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
  });

  it('stock firmware: 409 unsupported_firmware op beide routes', async () => {
    fw.supported = false;
    expect((await request(server).post(url('/preview')).send({ canonical: 'map0', dockAtB: dockB })).body.reason).toBe('unsupported_firmware');
    expect((await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB })).body.reason).toBe('unsupported_firmware');
  });
});
