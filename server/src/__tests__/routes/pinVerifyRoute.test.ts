/**
 * POST /pin/:sn/verify returns what the mower answered. It used to answer
 * ok:true before the mower had done anything, clear the PIN error in the cache
 * and suppress it with markPinVerified, so a motor board that never answered
 * (stock MCU v3.6.0, field report on custom-45) looked unlocked.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

type Handler = (d: Record<string, unknown>) => void;
const pin = vi.hoisted(() => ({
  handlers: [] as Array<(d: Record<string, unknown>) => void>,
  answer: null as ((cmd: Record<string, unknown>) => Record<string, unknown> | null) | null,
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
  onExtendedResponse: vi.fn((_sn: string, h: Handler) => { pin.handlers.push(h); }),
  offExtendedResponse: vi.fn((_sn: string, h: Handler) => { pin.handlers = pin.handlers.filter(x => x !== h); }),
  notifyRespond: vi.fn(),
  setDemoInterceptor: vi.fn(),
  onMowerConnected: vi.fn(),
  republishSeamFix: vi.fn(),
}));

vi.mock('../../mqtt/extendedCommands.js', () => ({
  publishExtendedCommand: vi.fn((_sn: string, cmd: Record<string, unknown>) => {
    const reply = pin.answer?.(cmd);
    if (reply) for (const h of [...pin.handlers]) h(reply);
  }),
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
  translateValue: (_field: string, raw: string) => raw,
  markPinVerified: vi.fn(),
  clearLocalTrail: vi.fn(),
  clearGpsTrail: vi.fn(),
  plannedPathCache: new Map(),
  previewPathCache: new Map(),
}));

vi.mock('../../services/mowerFileCapability.js', () => ({
  getMowerFileCapability: () => ({ mowerFileApplySupported: true, isOpenNova: true, mowerVersion: null, reason: null }),
  supportsMowerFileWrites: () => true,
  isOpenNovaMower: () => true,
  UNSUPPORTED_FIRMWARE_REASON: 'unsupported_firmware',
  UNSUPPORTED_FIRMWARE_MSG_KEY: 'requiresOpenNovaFirmware',
}));

import { dashboardRouter } from '../../routes/dashboard.js';
import { deviceCache, markPinVerified } from '../../mqtt/sensorData.js';
import { publishExtendedCommand } from '../../mqtt/extendedCommands.js';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

const SN = 'LFIN_PIN_ROUTE';
const verify = (lang = 'en') => request(server).post(`/api/dashboard/pin/${SN}/verify`).set('X-Lang', lang).send({ code: '1234' });
const opId = (cmd: Record<string, unknown>) => (cmd.verify_pin as { operation_id?: string }).operation_id;

describe('POST /pin/:sn/verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pin.handlers = [];
    pin.answer = null;
    deviceCache.set(SN, new Map([['error_status', '151'], ['error_msg', 'please input pin code']]));
  });

  it('a motor board that does not answer: 409 mcu_no_answer with the firmware hint, PIN error left alone', async () => {
    pin.answer = cmd => ({ verify_pin_respond: {
      result: 2, error: 'no_response', reason: 'mcu_no_answer', hint: 'stock v3.6.0 does not answer it', operation_id: opId(cmd),
    } });
    const res = await verify();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, action: 'verify', reason: 'mcu_no_answer', hint: 'stock v3.6.0 does not answer it' });
    expect(res.body.error).toContain('v3.6.0');
    expect(publishExtendedCommand).toHaveBeenCalledWith(SN, { verify_pin: { code: '1234', operation_id: expect.any(String) } });
    expect(markPinVerified).not.toHaveBeenCalled();
    expect(deviceCache.get(SN)!.get('error_status')).toBe('151');
  });

  it('understands the answer of custom-45 (no reason, no operation_id)', async () => {
    pin.answer = () => ({ verify_pin_respond: { result: 2, error: 'no_response' } });
    const res = await verify('nl');
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('mcu_no_answer');
    expect(res.body.error).toContain('Voer de PIN in op het scherm van de maaier');
  });

  it('a wrong PIN says so', async () => {
    pin.answer = cmd => ({ verify_pin_respond: { result: 1, status: 'wrong_pin', reason: 'wrong_pin', operation_id: opId(cmd) } });
    const res = await verify();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, reason: 'wrong_pin', error: 'Wrong PIN' });
    expect(markPinVerified).not.toHaveBeenCalled();
  });

  it('a confirmed verify clears the PIN error as before', async () => {
    pin.answer = cmd => ({ verify_pin_respond: { result: 0, status: 'verified', operation_id: opId(cmd) } });
    const res = await verify();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, action: 'verify', cfg_value: 2 });
    expect(markPinVerified).toHaveBeenCalledWith(SN);
    expect(deviceCache.get(SN)!.get('error_status')).toBe('0');
  });
});
