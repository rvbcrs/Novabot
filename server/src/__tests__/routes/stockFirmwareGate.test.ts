/**
 * Centrale firmware-gate (GH #115 + audit 2026-09-09): alles wat via
 * novabot/extended/<SN> loopt bestaat alleen op OpenNova custom firmware. Op
 * stock moet elke route 409 unsupported_firmware geven VÓÓR een DB-schrijf,
 * zodat server en maaier nooit uiteenlopen (LoRa-cache, seam-fix, planner-
 * radius, kaart-offset) en er geen valse succes-toasts ontstaan.
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
  republishSeamFix: vi.fn(),
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


vi.mock('../../mqtt/extendedCommands.js', () => ({ publishExtendedCommand: vi.fn() }));

const fw = vi.hoisted(() => ({ supported: false }));
vi.mock('../../services/mowerFileCapability.js', () => ({
  getMowerFileCapability: () => ({ mowerFileApplySupported: fw.supported, isOpenNova: fw.supported, mowerVersion: null, reason: null }),
  supportsMowerFileWrites: () => fw.supported,
  isOpenNovaMower: () => fw.supported,
  UNSUPPORTED_FIRMWARE_REASON: 'unsupported_firmware',
  UNSUPPORTED_FIRMWARE_MSG_KEY: 'requiresOpenNovaFirmware',
}));

import { dashboardRouter } from '../../routes/dashboard.js';
import { publishToDevice, publishToExtended } from '../../mqtt/mapSync.js';
import { publishExtendedCommand } from '../../mqtt/extendedCommands.js';
import { mapRepo, scheduleRepo, seamFixRepo, deviceSettingsRepo, equipmentRepo } from '../../db/repositories/index.js';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

const SN = 'LFIN_STOCK_GATE';
const B = `/api/dashboard`;

const stockCases: Array<[string, () => request.Test]> = [
  ['POST /extended (start_edge_cut)', () => request(app).post(`${B}/extended/${SN}`).send({ start_edge_cut: { mapName: 'map0' } })],
  ['PUT /coverage-planner-radius', () => request(app).put(`${B}/coverage-planner-radius/${SN}`).send({ radius: 0.35 })],
  ['PUT /seam-fix', () => request(app).put(`${B}/seam-fix/${SN}`).send({ enabled: true, edgeMarginCm: 5 })],
  ['POST /maps/apply-offset', () => request(app).post(`${B}/maps/${SN}/apply-offset`).send({ dx_m: 0.1, dy_m: 0 })],
  ['POST /lora/set-mower', () => request(app).post(`${B}/lora/set-mower/${SN}`).send({ addr: 718, channel: 16 })],
  ['POST /lora/query-mower', () => request(app).post(`${B}/lora/query-mower/${SN}`).send({})],
  ['POST /reanchor (invalidate)', () => request(app).post(`${B}/reanchor/${SN}`).send({ action: 'invalidate' })],
  ['POST /soft-restart', () => request(app).post(`${B}/soft-restart/${SN}`).send({})],
  ['POST /auto-map/start', () => request(app).post(`${B}/auto-map/${SN}/start`).send({ mode: 'record' })],
  ['POST /mapping-preflight', () => request(app).post(`${B}/mapping-preflight/${SN}`).send({})],
  ['POST /pin/verify', () => request(app).post(`${B}/pin/${SN}/verify`).send({ code: '1234' })],
  ['POST /maps/recalibrate-charging-pose', () => request(app).post(`${B}/maps/${SN}/recalibrate-charging-pose`).send({})],
  ['POST /schedules with edgeDays', () => request(app).post(`${B}/schedules/${SN}`).send({ startTime: '10:00', weekdays: [1], mapName: 'map0', edgeDays: [1] })],
];

describe('central firmware gate on stock firmware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fw.supported = false;
    for (const m of mapRepo.findByMowerSn(SN)) mapRepo.deleteWithCascade(m.map_id, SN);
    for (const s of scheduleRepo.findByMowerSn(SN)) scheduleRepo.deleteByIdAndMower(s.schedule_id, SN);
  });

  for (const [name, call] of stockCases) {
    it(`${name} → 409 unsupported_firmware, nothing sent`, async () => {
      const res = await call();
      expect(res.status, name).toBe(409);
      expect(res.body.reason).toBe('unsupported_firmware');
      expect(res.body.msgKey).toBe('requiresOpenNovaFirmware');
      expect(publishExtendedCommand).not.toHaveBeenCalled();
      expect(publishToExtended).not.toHaveBeenCalled();
      expect(publishToDevice).not.toHaveBeenCalled();
    });
  }

  it('writes nothing to the DB for the settings routes', async () => {
    await request(app).put(`${B}/seam-fix/${SN}`).send({ enabled: true });
    await request(app).put(`${B}/coverage-planner-radius/${SN}`).send({ radius: 0.35 });
    await request(app).post(`${B}/lora/set-mower/${SN}`).send({ addr: 718, channel: 16 });
    await request(app).post(`${B}/schedules/${SN}`).send({ startTime: '10:00', weekdays: [1], mapName: 'map0', edgeDays: [1] });
    expect(seamFixRepo.get(SN)).toBeNull();
    expect(deviceSettingsRepo.findBySn(SN)).toHaveLength(0);
    expect(equipmentRepo.getLoraCache(SN)).toBeFalsy();
    expect(scheduleRepo.findByMowerSn(SN)).toHaveLength(0);
  });

  it('still accepts a schedule WITHOUT edge days on stock', async () => {
    const res = await request(app).post(`${B}/schedules/${SN}`).send({ startTime: '10:00', weekdays: [1], mapName: 'map0' });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(scheduleRepo.findByMowerSn(SN)).toHaveLength(1);
  });

  it('lets everything through on OpenNova firmware', async () => {
    fw.supported = true;
    const res = await request(app).post(`${B}/extended/${SN}`).send({ start_edge_cut: { mapName: 'map0' } });
    expect(res.status).toBe(200);
    expect(publishExtendedCommand).toHaveBeenCalledTimes(1);
  });
});
