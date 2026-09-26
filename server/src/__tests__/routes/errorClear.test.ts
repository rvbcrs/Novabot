/**
 * Clearing a mower error the way the firmware allows it (mqtt/errorKind.ts):
 * task errors are marked cleared and stop blocking, errors above 150 without
 * a PIN need a software restart, PIN errors go to the PIN flow. The mower's
 * own error_status is never overwritten.
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

vi.mock('../../services/softRestart.js', () => ({
  softRestartBlockedReason: vi.fn().mockReturnValue(null),
  sendSoftRestart: vi.fn(),
}));

import { dashboardRouter } from '../../routes/dashboard.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { sendSoftRestart } from '../../services/softRestart.js';
import { errorKind } from '../../mqtt/errorKind.js';
import { deriveHasError } from '../../mqtt/mowerActivity.js';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

const SN = 'LFIN_ERR_CLEAR';
const clear = () => request(server).post(`/api/dashboard/error/${SN}/clear`).send({});
const setError = (code: string) => { deviceCache.set(SN, new Map([['error_status', code]])); };

describe('errorKind', () => {
  it('sorts codes by what clears them', () => {
    expect(errorKind(0)).toBe('none');
    for (const c of [2, 117, 123, 124, 126, 130, 150]) expect(errorKind(c)).toBe('task');
    for (const c of [151, 152, 154, 155, 156, 157, 158, 159, 160]) expect(errorKind(c)).toBe('pin');
    for (const c of [153, 170, 202, 221, 444]) expect(errorKind(c)).toBe('restart');
  });
});

describe('POST /error/:sn/clear', () => {
  beforeEach(() => { vi.clearAllMocks(); fw.supported = true; });

  it('marks a task error cleared without touching the mower value, and it stops counting as an error', async () => {
    setError('130');
    const res = await clear();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: 'cleared', code: 130 });
    const cache = deviceCache.get(SN)!;
    expect(cache.get('error_status')).toBe('130');          // the mower's own value stays
    expect(cache.get('error_ack')).toBe('130');
    expect(deriveHasError(Object.fromEntries(cache))).toBe(false);
    expect(sendSoftRestart).not.toHaveBeenCalled();
  });

  it('refuses PIN errors and says so', async () => {
    setError('154');
    const res = await clear();
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('pin_required');
    expect(deviceCache.get(SN)!.has('error_ack')).toBe(false);
  });

  it('restarts the mower software for a non-PIN error above 150 on OpenNova firmware', async () => {
    setError('221');
    const res = await clear();
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('restarting');
    expect(sendSoftRestart).toHaveBeenCalledWith(SN);
  });

  it('says a restart is needed on stock firmware instead of pretending', async () => {
    fw.supported = false;
    setError('170');
    const res = await clear();
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('needs_restart');
    expect(sendSoftRestart).not.toHaveBeenCalled();
  });
});
