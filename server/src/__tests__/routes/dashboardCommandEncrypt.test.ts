/**
 * Issue #16: when the dashboard `/command/:sn` endpoint receives an
 * explicit `encrypt: false`, the published bytes MUST be raw JSON — not
 * AES-encrypted. Earlier the unencrypted branch routed through
 * publishToDevice(), which has its own LFI auto-encrypt branch, so the
 * opt-out was silently re-encrypted for any LFI* SN.
 *
 * These tests pin the contract:
 *   - default (no encrypt flag) on LFI SN → encrypted bytes
 *   - encrypt: false on LFI SN → raw JSON bytes
 *   - encrypt: false on non-LFI SN → raw JSON bytes
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

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
}));

import { dashboardRouter } from '../../routes/dashboard.js';
import * as mapSync from '../../mqtt/mapSync.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { DEPARTURE_SETTLE_MS, _resetEdgeCutGate } from '../../services/edgeCutGuard.js';

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

const LFI_SN = 'LFIN2230700238';
const PLAIN_SN = 'TESTSN1234';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/dashboard/command/:sn — encryption opt-out (#16)', () => {
  it('LFI SN with no encrypt flag → AES bytes via publishRawToDevice', async () => {
    const r = await request(server)
      .post(`/api/dashboard/command/${LFI_SN}`)
      .send({ command: { pause_navigation: { cmd_num: 42 } } });

    expect(r.status).toBe(200);
    expect(r.body.encrypted).toBe(true);
    expect(mapSync.publishRawToDevice).toHaveBeenCalledTimes(1);
    expect(mapSync.publishToDevice).not.toHaveBeenCalled();

    const [, payload] = vi.mocked(mapSync.publishRawToDevice).mock.calls[0];
    // Encrypted output never contains the readable JSON keys.
    expect(payload.toString('utf8')).not.toContain('pause_navigation');
    // 16-byte AES blocks ⇒ length is a multiple of 16.
    expect(payload.length % 16).toBe(0);
  });

  it('LFI SN with encrypt:false → raw JSON bytes (regression #16)', async () => {
    const r = await request(server)
      .post(`/api/dashboard/command/${LFI_SN}`)
      .send({ encrypt: false, command: { pause_navigation: { cmd_num: 42 } } });

    expect(r.status).toBe(200);
    expect(r.body.encrypted).toBe(false);
    expect(mapSync.publishRawToDevice).toHaveBeenCalledTimes(1);
    expect(mapSync.publishToDevice).not.toHaveBeenCalled();

    const [, payload] = vi.mocked(mapSync.publishRawToDevice).mock.calls[0];
    const text = payload.toString('utf8');
    expect(text).toContain('pause_navigation');
    expect(text).toContain('cmd_num');
    expect(text).toBe(JSON.stringify({ pause_navigation: { cmd_num: 42 } }));
  });

  it('non-LFI SN defaults to raw JSON', async () => {
    const r = await request(server)
      .post(`/api/dashboard/command/${PLAIN_SN}`)
      .send({ command: { pause_navigation: { cmd_num: 7 } } });

    expect(r.status).toBe(200);
    expect(r.body.encrypted).toBeUndefined();
    expect(mapSync.publishToDevice).toHaveBeenCalledTimes(1);
    expect(mapSync.publishRawToDevice).not.toHaveBeenCalled();
  });
});

/**
 * The raw branches publish with publishRawToDevice, which skips publishToDevice
 * and with it the gate that ends a running zone drive or night patrol before a
 * stop, pause, go-home or start (mapSync.ts, edgeCutGuard.ts). The dashboard
 * and OpenNova-app buttons come through this route, so it sends stop_mow_zone
 * itself, first, as publishToDevice does. The publishToDevice branch gates
 * itself and must not do it twice.
 */
describe('POST /api/dashboard/command/:sn: ending a running drive', () => {
  beforeEach(() => { deviceCache.clear(); });

  /** Call order of a mock's first call, to compare calls across mocks. */
  const firstCall = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0];

  it.each([
    ['AES', undefined],
    ['plain JSON', false],
  ])('stop_navigation while a patrol patrols: headlight off, then stop_mow_zone, before the %s publish', async (_branch, encrypt) => {
    deviceCache.set(LFI_SN, new Map([['patrol_phase', 'patrolling']]));
    const r = await request(server)
      .post(`/api/dashboard/command/${LFI_SN}`)
      .send({ encrypt, command: { stop_navigation: { cmd_num: 5 } } });

    expect(r.status).toBe(200);
    expect(mapSync.publishToTopic).toHaveBeenCalledTimes(1);
    expect(mapSync.publishToTopic).toHaveBeenCalledWith(`novabot/cmd/${LFI_SN}`, { led_set: 0 });
    expect(mapSync.publishToExtended).toHaveBeenCalledTimes(1);
    expect(mapSync.publishToExtended).toHaveBeenCalledWith(LFI_SN, { stop_mow_zone: {} });
    expect(mapSync.publishRawToDevice).toHaveBeenCalledTimes(1);
    expect(firstCall(mapSync.publishToTopic)).toBeLessThan(firstCall(mapSync.publishToExtended));
    expect(firstCall(mapSync.publishToExtended)).toBeLessThan(firstCall(mapSync.publishRawToDevice));
  });

  it('stop_navigation while a zone drive follows the unicom: stop_mow_zone first, the light left alone', async () => {
    deviceCache.set(LFI_SN, new Map([['mow_zone_phase', 'following_unicom']]));
    const r = await request(server)
      .post(`/api/dashboard/command/${LFI_SN}`)
      .send({ command: { stop_navigation: { cmd_num: 5 } } });

    expect(r.status).toBe(200);
    expect(mapSync.publishToTopic).not.toHaveBeenCalled();
    expect(mapSync.publishToExtended).toHaveBeenCalledTimes(1);
    expect(mapSync.publishToExtended).toHaveBeenCalledWith(LFI_SN, { stop_mow_zone: {} });
    expect(firstCall(mapSync.publishToExtended)).toBeLessThan(firstCall(mapSync.publishRawToDevice));
  });

  it.each(['stop_navigation', 'pause_navigation', 'go_to_charge', 'start_navigation'])(
    '%s while a patrol returns also kills the patrol first, light off before that', async command => {
      deviceCache.set(LFI_SN, new Map([['patrol_phase', 'returning']]));
      const r = await request(server)
        .post(`/api/dashboard/command/${LFI_SN}`)
        .send({ command: { [command]: { cmd_num: 6 } } });

      expect(r.status).toBe(200);
      expect(mapSync.publishToTopic).toHaveBeenCalledWith(`novabot/cmd/${LFI_SN}`, { led_set: 0 });
      expect(mapSync.publishToExtended).toHaveBeenCalledWith(LFI_SN, { stop_mow_zone: {} });
      expect(firstCall(mapSync.publishToTopic)).toBeLessThan(firstCall(mapSync.publishToExtended));
      expect(firstCall(mapSync.publishToExtended)).toBeLessThan(firstCall(mapSync.publishRawToDevice));
    });

  it.each(['done', 'error', 'stopped'])('sends nothing extra once the patrol has ended (%s)', async phase => {
    deviceCache.set(LFI_SN, new Map([['patrol_phase', phase]]));
    const r = await request(server)
      .post(`/api/dashboard/command/${LFI_SN}`)
      .send({ command: { go_to_charge: { cmd_num: 8 } } });

    expect(r.status).toBe(200);
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
    expect(mapSync.publishRawToDevice).toHaveBeenCalledTimes(1);
  });

  it('sends nothing extra for a command that ends nothing, also while a patrol patrols', async () => {
    deviceCache.set(LFI_SN, new Map([['patrol_phase', 'patrolling']]));
    const r = await request(server)
      .post(`/api/dashboard/command/${LFI_SN}`)
      .send({ command: { set_para_info: { path_direction: 90 } } });

    expect(r.status).toBe(200);
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
    expect(mapSync.publishRawToDevice).toHaveBeenCalledTimes(1);
  });

  it('leaves a non-LFI SN to publishToDevice, which gates itself', async () => {
    deviceCache.set(PLAIN_SN, new Map([['patrol_phase', 'patrolling']]));
    const r = await request(server)
      .post(`/api/dashboard/command/${PLAIN_SN}`)
      .send({ command: { stop_navigation: { cmd_num: 5 } } });

    expect(r.status).toBe(200);
    expect(mapSync.publishToDevice).toHaveBeenCalledTimes(1);
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
  });

  it('gates an explicit encrypt:true on a non-LFI SN too, since that publishes raw', async () => {
    deviceCache.set(PLAIN_SN, new Map([['patrol_phase', 'patrolling']]));
    const r = await request(server)
      .post(`/api/dashboard/command/${PLAIN_SN}`)
      .send({ encrypt: true, command: { stop_navigation: { cmd_num: 5 } } });

    expect(r.status).toBe(200);
    expect(mapSync.publishToDevice).not.toHaveBeenCalled();
    expect(mapSync.publishToExtended).toHaveBeenCalledWith(PLAIN_SN, { stop_mow_zone: {} });
    expect(firstCall(mapSync.publishToExtended)).toBeLessThan(firstCall(mapSync.publishRawToDevice));
  });
});

/**
 * R1: a drive killed while it departs releases the firmware's departure task on
 * its way out. A go home or a start published before that release landed would
 * be stopped by it: the route answers at once and publishes after the hold. A
 * stop goes at once.
 */
describe('POST /api/dashboard/command/:sn while a drive departs', () => {
  beforeEach(() => { deviceCache.clear(); _resetEdgeCutGate(); });
  afterEach(() => { vi.useRealTimers(); _resetEdgeCutGate(); });

  it.each([
    ['AES', undefined],
    ['plain JSON', false],
  ])('answers go_pile at once and publishes it (%s) once the release had time to land', async (_branch, encrypt) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    deviceCache.set(LFI_SN, new Map([['patrol_phase', 'localizing']]));
    const r = await request(server)
      .post(`/api/dashboard/command/${LFI_SN}`)
      .send({ encrypt, command: { go_pile: {} } });

    expect(r.status).toBe(200);
    expect(mapSync.publishToExtended).toHaveBeenCalledWith(LFI_SN, { stop_mow_zone: {} });
    expect(mapSync.publishRawToDevice).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEPARTURE_SETTLE_MS);
    expect(mapSync.publishRawToDevice).toHaveBeenCalledTimes(1);
  });

  it('publishes stop_navigation at once', async () => {
    deviceCache.set(LFI_SN, new Map([['mow_zone_phase', 'starting']]));
    const r = await request(server)
      .post(`/api/dashboard/command/${LFI_SN}`)
      .send({ command: { stop_navigation: { cmd_num: 9 } } });

    expect(r.status).toBe(200);
    expect(mapSync.publishRawToDevice).toHaveBeenCalledTimes(1);
  });
});
