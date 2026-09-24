/**
 * sync-info tells the mower what to write on a map push. pos.json (the UTM
 * origin of its map frame) is only sent when a flow asked for it: the dock pin
 * is where the dock sits on the aerial photo, and a mower whose RTK base is off
 * would get its whole frame shifted by that much on the next reboot.
 */
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, afterAll } from 'vitest';

const zip = vi.hoisted(() => ({ path: '' }));
vi.mock('../../services/mapBackup.js', () => ({
  regenerateLatestZipFromBackup: vi.fn(() => zip.path),
}));

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
  generateMapZipFromDb: vi.fn(() => zip.path),
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
import { mapRepo } from '../../db/repositories/index.js';
import { requestPosJsonWrite } from '../../services/posJsonGate.js';

zip.path = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'syncinfo-')), 'm.zip');
fs.writeFileSync(zip.path, 'zip bytes');

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

describe('GET /maps/:sn/sync-info', () => {
  it('sends no pos.json for an ordinary map push, even with a dock pin', async () => {
    const sn = 'LFIN_SYNCINFO_A';
    mapRepo.setChargerGps(sn, 52.1408525, 6.2311550);
    const r = await request(server).get(`/api/dashboard/maps/${sn}/sync-info`);
    expect(r.status).toBe(200);
    expect(r.body.md5).toBeTruthy();
    expect(r.body.posJson).toBeNull();
  });

  it('sends pos.json from the pin right after a flow asked for it', async () => {
    const sn = 'LFIN_SYNCINFO_B';
    mapRepo.setChargerGps(sn, 52.1408525, 6.2311550);
    requestPosJsonWrite(sn);
    const r = await request(server).get(`/api/dashboard/maps/${sn}/sync-info`);
    expect(r.body.posJson?.wgs84_origin?.latitude).toBeCloseTo(52.1408525, 6);
  });
});
