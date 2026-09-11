/**
 * POST/PUT /api/dashboard/maps/:sn op STOCK firmware (GH #115).
 *
 * Stock firmware kent geen write_map_files, dus een in het dashboard getekend
 * of versleept gebied bestond alleen in de DB: de app toonde het, de maaier
 * niet → Error 118 bij starten. De routes weigeren nu vóór de DB-schrijf.
 */


import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { mapRepo } from '../../db/repositories/index.js';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

const SN = 'LFIN_STOCK_DRAW';
const tri = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }];

describe('map create/update on stock firmware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fw.supported = false;
    for (const m of mapRepo.findByMowerSn(SN)) mapRepo.deleteWithCascade(m.map_id, SN);
    mapRepo.create({
      map_id: 'stock-map0', mower_sn: SN, map_name: 'map0', file_name: 'bundle.zip',
      map_area: JSON.stringify(tri), map_type: 'work',
    });
  });

  it('refuses to draw a new area: 409, nothing written, no push', async () => {
    const res = await request(app).post(`/api/dashboard/maps/${SN}`).send({ mapName: 'Work area 2', mapArea: tri, mapType: 'work' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('unsupported_firmware');
    expect(mapRepo.findByMowerSn(SN)).toHaveLength(1);
    expect(publishToExtended).not.toHaveBeenCalled();
  });

  it('refuses to move an existing polygon, but still allows a rename', async () => {
    const moved = await request(app).patch(`/api/dashboard/maps/${SN}/stock-map0`).send({ mapArea: [{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 9 }] });
    expect(moved.status).toBe(409);
    expect(JSON.parse(mapRepo.findByMowerSn(SN)[0].map_area!)).toEqual(tri);

    const renamed = await request(app).patch(`/api/dashboard/maps/${SN}/stock-map0`).send({ mapName: 'Front lawn' });
    expect(renamed.status).toBe(200);
    expect(publishToExtended).not.toHaveBeenCalled();
  });

  it('still creates on OpenNova firmware, met canonieke slotnaam in het antwoord', async () => {
    fw.supported = true;
    const res = await request(app).post(`/api/dashboard/maps/${SN}`).send({ mapName: 'Work area 2', mapArea: tri, mapType: 'work' });
    expect(res.status).toBe(200);
    expect(res.body.map.canonicalName).toBe('map1');
    expect(mapRepo.findByMowerSn(SN)).toHaveLength(2);
    expect(mapRepo.findBySnAndCanonical(SN, 'map1')).toBeTruthy();
  });

  it('lege naam wordt geen alias: de canonieke slotnaam blijft de weergavenaam', async () => {
    fw.supported = true;
    const res = await request(app).post(`/api/dashboard/maps/${SN}`).send({ mapName: '   ', mapArea: tri, mapType: 'work' });
    expect(res.status).toBe(200);
    expect(res.body.map.mapName).toBeNull();
    expect(res.body.map.canonicalName).toBe('map1');
    expect(mapRepo.findBySnAndCanonical(SN, 'map1')?.map_name).toBeNull();
  });

  it('weigert een kanaal waarvan de eindpunten geen gebieden raken', async () => {
    fw.supported = true;
    const res = await request(app)
      .post(`/api/dashboard/maps/${SN}`)
      .send({ mapName: 'Kanaal 1', mapArea: [{ x: 100, y: 100 }, { x: 200, y: 200 }], mapType: 'unicom' });
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('canonical_name_underivable');
    expect(mapRepo.findByMowerSn(SN)).toHaveLength(1);
  });
});
