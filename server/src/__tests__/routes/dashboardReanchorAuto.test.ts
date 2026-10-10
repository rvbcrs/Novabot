import express from 'express';
import request from 'supertest';
import { it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

// Centrale firmware-gate (2026-09-09): deze tests gaan uit van een OpenNova
// custom-firmware maaier, anders weigert de server extended-commando's met 409.
vi.mock('../../services/mowerFileCapability.js', () => ({
  getMowerFileCapability: () => ({ mowerFileApplySupported: true, isOpenNova: true, mowerVersion: 'v6.0.2-custom-test', reason: null }),
  supportsMowerFileWrites: () => true,
  isOpenNovaMower: () => true,
  UNSUPPORTED_FIRMWARE_REASON: 'unsupported_firmware',
  UNSUPPORTED_FIRMWARE_MSG_KEY: 'requiresOpenNovaFirmware',
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
}));

import { dashboardRouter } from '../../routes/dashboard.js';
import { markFrameUnvalidated, clearFrameUnvalidated, isFrameUnvalidated, markMapInstallPending, clearMapInstallPending, getPendingReanchor, setPendingReanchor, loadFrameValidationFromDb } from '../../services/frameValidation.js';
import { frameSnapshotSignature } from '../../services/copyAlignment.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { mapRepo } from '../../db/repositories/index.js';
import { guardedDockMove, settleDockMotion } from '../../services/dockMotion.js';
import { ingestPositionTelemetry, clearPositionTelemetry } from '../../services/positionTelemetry.js';
import { publishToDevice, publishToExtended, onExtendedResponse, offExtendedResponse } from '../../mqtt/mapSync.js';

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

vi.mock('../../services/dockMotion.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/dockMotion.js')>()), guardedDockMove: vi.fn(), settleDockMotion: vi.fn(),
}));

let cycleId: string | undefined;
const SN = 'LFIN_REANCHOR_TEST';
const data = { battery_state: 'CHARGING', recharge_status: 9, rtk_fix_quality: 4, rtk_latitude: 52.1234567, rtk_longitude: 4.7654321, map_position_x: 0.13, map_position_y: -0.52, localization_state: 'RUNNING' };
const anchor = { x: 0.13, y: -0.52 };
// The pose the mower reports it left from, in its own current frame.
const LEFT_FROM = { x: anchor.x, y: anchor.y, yaw: 1.5 };
const handlers = new Set<(data: Record<string, unknown>) => void>();
let loadedOrigin: { x: number; y: number; z: number; utm_zone: number };
let runtimeOverride: Record<string, unknown>;
let rejectWrite = false;
let measurementCount = 0;
let corruptAfterWrite = false;
let slowReadAfterMeasure = false;
let snapshotConflict = false;
let requestCount = 0;
let motionProtocol: string;
let armResult: number;
let moveResult: number;
function snapshot() {
  return { result: 0, snapshot_consistent: true, x3_csv_files: {}, map_files_b64: {}, map_files_text: {}, csv_files: {
    'map0tocharge_unicom.csv': '0.13,-0.52\n0.2,-0.4\n',
    'map_info.json': JSON.stringify({ charging_pose: { ...anchor, orientation: 1.5 } }),
  }, charging_station_yaml: `charging_pose: [${snapshotConflict ? 2 : anchor.x}, ${anchor.y}, 1.5]`, pos_json: JSON.stringify({ utm_origin: loadedOrigin }) };
}
let lastFeed: Record<string, unknown> = {};
function feed(fields: Record<string, unknown> = {}) { lastFeed = fields; for (let i = 7; i >= 0; i--) ingestPositionTelemetry(SN, { ...data, rtk_sample_id: String(Date.now() - i * 100), ...fields }, Date.now() - i * 100); }
async function tick(ms = 1000, supervise = true) {
  for (let left = ms; left > 0; left -= 1000) {
    if (supervise && cycleId) await action('pulse');
    await vi.advanceTimersByTimeAsync(Math.min(left, 1000));
  }
}
async function status() { return (await request(server).get(`/api/dashboard/reanchor/${SN}/status`)).body.status; }
const action = (value: string, extra = {}) => request(server).post(`/api/dashboard/reanchor/${SN}`).send({ action: value, mode: 'supervised-v2', ownDockUnmoved: true, cycleId, ...extra });
async function start() { const res = await action('auto'); cycleId = res.body.cycleId; if (cycleId) await action('pulse'); return res; }
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); clearPositionTelemetry(SN); clearFrameUnvalidated(SN); clearMapInstallPending(SN); setPendingReanchor(SN, null); handlers.clear(); cycleId = undefined; deviceCache.delete(SN);
  vi.mocked(guardedDockMove).mockImplementation(async (_sn, operation, input, check, _setMotion, beforeMove) => {
    expect(operation.reanchor).toBe(true); check();
    beforeMove?.();
    if (input.action === 'reverse') {
      expect(input.distance).toBe(1.15);
      feed({ battery_state: 'NORMAL', recharge_status: 0, map_position_y: anchor.y - 1 });
      return { startPose: LEFT_FROM };
    }
    // The return is bounded by the pose measured at departure, never by saved files.
    expect(input.chargePose).toEqual(LEFT_FROM);
    feed();
    return {};
  });
  vi.mocked(settleDockMotion).mockImplementation(async (_sn, docked, check) => { check(); return { x: anchor.x, y: anchor.y - (docked ? 0 : .6), sampledAt: Date.now(), sampleCount: 8, spreadM: 0 }; });
  snapshotConflict = false; requestCount = 0; loadedOrigin = { x: 620859.4, y: 5776239.5, z: 0, utm_zone: 31 };
  motionProtocol = 'dock-measurement-motion-v4'; armResult = 0; moveResult = 0;
  runtimeOverride = {}; rejectWrite = false; measurementCount = 0; corruptAfterWrite = false; slowReadAfterMeasure = false;
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  for (const row of mapRepo.findByMowerSn(SN)) mapRepo.deleteById(row.map_id);
  mapRepo.create({ map_id: SN, mower_sn: SN, map_type: 'unicom', canonical_name: 'map0tocharge_unicom', map_area: JSON.stringify([anchor, { x: 0.2, y: -0.4 }]) });
  vi.mocked(onExtendedResponse).mockImplementation((_sn, h) => { handlers.add(h); });
  vi.mocked(offExtendedResponse).mockImplementation((_sn, h) => { handlers.delete(h); });
  vi.mocked(publishToExtended).mockImplementation((_sn, message) => {
    const [command, raw] = Object.entries(message)[0];
    const params = raw as Record<string, any>;
    let result: Record<string, unknown> = snapshot();
    if (command === 'dock_measurement_control') result = { result: armResult, protocol: motionProtocol };
    if (command === 'dock_measurement_move') {
      expect(isFrameUnvalidated(SN)).toBe(true);
      const docked = params.action === 'dock';
      if (docked) { expect(params.charge_pose).toEqual(LEFT_FROM); feed(); } else feed({ battery_state: 'NORMAL', recharge_status: 0, map_position_y: anchor.y - 1 });
      result = { result: moveResult, protocol: motionProtocol, docked, frame_fingerprint: params.frame_fingerprint, ...(docked ? {} : { start_pose: LEFT_FROM }) };
    }
    if (command === 'read_map_files' && requestCount && corruptAfterWrite) result.x3_csv_files = { 'map0_work.csv': 'changed' };
    if (command === 'read_map_files' && slowReadAfterMeasure && measurementCount) {
      // A multi-MB snapshot read after the measurement; telemetry keeps flowing meanwhile.
      const reply = { ...result, operation_id: params.operation_id };
      setTimeout(() => feed(lastFeed), 5000); setTimeout(() => feed(lastFeed), 10_000);
      setTimeout(() => { for (const h of [...handlers]) h({ read_map_files_respond: reply }); }, 12_000);
      return;
    }
    if (command === 'reanchor_pos') {
      requestCount++;
      expect(params.anchor_x).toBe(anchor.x); expect(params.anchor_y).toBe(anchor.y);
      expect(params.protocol).toBe('base-link-reanchor-v1');
      expect(params).not.toHaveProperty('lat');
      if (!rejectWrite) loadedOrigin = params.utm_origin;
      // The firmware reply carries x, y and utm_zone only (extended_commands.py reanchor_pos_respond).
      result = { result: rejectWrite ? 1 : 0, protocol: 'base-link-reanchor-v1', anchor, utm_origin: { x: loadedOrigin.x, y: loadedOrigin.y, utm_zone: loadedOrigin.utm_zone } };
    }
    if (command === 'measure_runtime_frame') {
      measurementCount++;
      const signature = frameSnapshotSignature(snapshot());
      setTimeout(() => {
        const base = { x: anchor.x + (requestCount ? 0 : .145), y: anchor.y, z: 0, yaw: 1.5 };
        const frame = { x: 0, y: 0, spread_m: .001, base, base_spread_m: .002, yaw_spread_rad: .001,
          docked: true, northern: true, sample_count: 30, unique_stamps: 30, max_pair_dt_s: 0,
          // Mower wall clock intentionally differs from the server.
          capture_started: Date.now() / 1000 + 25, capture_finished: Date.now() / 1000 + 31,
          ...runtimeOverride };
        feed({ map_position_x: frame.base?.x ?? base.x, map_position_y: frame.base?.y ?? base.y });
        for (const h of [...handlers]) h({ measure_runtime_frame_respond: { result: 0, protocol: 'runtime-map-frame-v1',
          runtime_frame: frame, frame_fingerprint: signature, operation_id: params.operation_id } });
      }, 6000);
      return;
    }
    for (const h of [...handlers]) h({ [`${command}_respond`]: { ...result, operation_id: params.operation_id } });
  });
});
afterEach(async () => {
  if (vi.isFakeTimers()) { if (cycleId) await action('stop'); await tick(400_000, false); vi.useRealTimers(); }
});
it('rejects old clients, missing confirmation, stale telemetry and FULL without contact before moving', async () => {
  feed();
  expect((await action('auto', { mode: undefined })).status).toBe(409);
  expect((await action('auto', { ownDockUnmoved: false })).status).toBe(409);
  clearPositionTelemetry(SN); expect((await start()).status).toBe(409);
  feed({ battery_state: 'FULL', recharge_status: 0 }); expect((await start()).status).toBe(409);
  expect(guardedDockMove).not.toHaveBeenCalled();
});
// Field report (Oct 2026): one sentence for four conditions left the owner
// guessing which one failed; it was the missing dock channel.
it('names a missing dock channel instead of the combined precondition', async () => {
  feed();
  for (const row of mapRepo.findByMowerSn(SN)) mapRepo.deleteById(row.map_id);
  const res = await start();
  expect(res.status).toBe(409);
  expect(res.body.reason).toBe('no_dock_anchor');
  expect(guardedDockMove).not.toHaveBeenCalled();
});
it('retires recalibration and old single-step shortcuts without any mower write', async () => {
  feed();
  expect((await request(server).post(`/api/dashboard/maps/${SN}/recalibrate-charging-pose`).send({ force: true })).status).toBe(410);
  for (const name of ['drive', 'spin', 'dock', 'verify', 'continue_dock']) expect((await action(name)).status).toBe(410);
  expect(publishToExtended).not.toHaveBeenCalled();
});
it('has a recovery entry without prior invalidation; a lost start response never moves nor locks the frame', async () => {
  vi.useFakeTimers(); feed();
  expect(isFrameUnvalidated(SN)).toBe(false); expect((await action('auto')).status).toBe(200);
  await tick(6000, false);
  expect((await status()).phase).toBe('error'); expect(guardedDockMove).not.toHaveBeenCalled();
  expect(isFrameUnvalidated(SN)).toBe(false);
});
it('refuses a docked mower whose localization is not RUNNING, without invalidating the frame', async () => {
  feed({ localization_state: 'NOT_INITIALIZED', map_position_x: 0, map_position_y: 0 });
  expect((await start()).status).toBe(409);
  expect(isFrameUnvalidated(SN)).toBe(false); expect(guardedDockMove).not.toHaveBeenCalled();
});
it.each(['v3', 'arm refused', 'already invalid'])('native protocol preflight preserves the original frame state: %s', async kind => {
  const actual = await vi.importActual<typeof import('../../services/dockMotion.js')>('../../services/dockMotion.js');
  vi.mocked(guardedDockMove).mockImplementation(actual.guardedDockMove);
  vi.useFakeTimers(); feed();
  if (kind === 'arm refused') armResult = 1;
  else motionProtocol = 'dock-measurement-motion-v3';
  if (kind === 'already invalid') markFrameUnvalidated(SN);
  await start(); await tick(1000);
  expect((await status()).phase).toBe('error');
  expect(vi.mocked(publishToExtended).mock.calls.some(c => c[1].dock_measurement_move)).toBe(false);
  expect(requestCount).toBe(0);
  loadFrameValidationFromDb();
  expect(isFrameUnvalidated(SN)).toBe(kind === 'already invalid');
});
it.each([0, 1])('native v3 invalidates at movement dispatch and only releases after full verification: move result %s', async result => {
  const actual = await vi.importActual<typeof import('../../services/dockMotion.js')>('../../services/dockMotion.js');
  vi.mocked(guardedDockMove).mockImplementation(actual.guardedDockMove);
  vi.useFakeTimers(); feed(); moveResult = result;
  await start(); await tick(16_000);
  expect((await status()).phase).toBe(result ? 'error' : 'done');
  expect(vi.mocked(publishToExtended).mock.calls.some(c => c[1].dock_measurement_move)).toBe(true);
  loadFrameValidationFromDb();
  expect(isFrameUnvalidated(SN)).toBe(result !== 0);
});
it('a slow snapshot read after the measurement does not make the measurement stale', async () => {
  vi.useFakeTimers(); feed({ map_position_orientation: 1.606 }); slowReadAfterMeasure = true;
  await start(); await tick(70_000);
  expect((await status()).phase).toBe('done'); expect(isFrameUnvalidated(SN)).toBe(false);
  expect(requestCount).toBe(1); expect(measurementCount).toBe(2);
});
it('refuses conflicting native anchors before departure', async () => {
  vi.useFakeTimers(); feed(); snapshotConflict = true;
  await start(); await tick(1000);
  expect((await status()).phase).toBe('error');
  expect(guardedDockMove).not.toHaveBeenCalled(); expect(requestCount).toBe(0);
});
it('initializes heading first, writes once, then repeats the dock cycle and fresh measurement', async () => {
  vi.useFakeTimers(); feed({ map_position_orientation: 1.606 });
  const oldX = loadedOrigin.x, move = vi.mocked(guardedDockMove).getMockImplementation()!;
  vi.mocked(guardedDockMove).mockImplementationOnce(async (...args) => {
    expect(measurementCount).toBe(0); expect(requestCount).toBe(0); return move(...args);
  });
  await start(); expect((await action('auto')).status).toBe(409); await tick(16_000);
  expect((await status()).phase).toBe('done'); expect(isFrameUnvalidated(SN)).toBe(false);
  expect(getPendingReanchor(SN)).toBeUndefined(); expect(loadedOrigin.x).toBeCloseTo(oldX + .145, 8);
  expect(requestCount).toBe(1); expect(measurementCount).toBe(2);
  expect(vi.mocked(guardedDockMove).mock.calls.map(c => c[2].action)).toEqual(['reverse', 'dock', 'reverse', 'dock']);
  expect(vi.mocked(guardedDockMove).mock.calls.map(c => c[2].chargePose)).toEqual([undefined, LEFT_FROM, undefined, LEFT_FROM]);
  expect(publishToDevice).not.toHaveBeenCalled();
});
it('a matching frame still requires preparation but no origin write, and new invalidation clears old success', async () => {
  vi.useFakeTimers(); feed(); runtimeOverride = { base: { ...anchor, z: 0, yaw: 1.5 } };
  // A refused preflight is not an uncertain device write and must not create
  // the same chicken-and-egg dead end as the retired calibration button.
  deviceCache.set(SN, new Map([['map_apply_phase', 'failed']]));
  await start(); await tick(9000);
  expect((await status()).phase).toBe('done'); expect(requestCount).toBe(0);
  expect(guardedDockMove).toHaveBeenCalledTimes(2); await action('invalidate');
  expect((await status()).phase).toBe('idle'); expect(isFrameUnvalidated(SN)).toBe(true);
});
it('does not release a failed map installation, including after restarting the server', async () => {
  vi.useFakeTimers(); feed(); markMapInstallPending(SN); markFrameUnvalidated(SN);
  clearFrameUnvalidated(SN); loadFrameValidationFromDb();
  expect(isFrameUnvalidated(SN)).toBe(true);
  expect((await start()).status).toBe(409); expect(guardedDockMove).not.toHaveBeenCalled();
  expect((await status()).installPending).toBe(true);
});
it('persists the post-write trip across cancellation and restart, without a duplicate write', async () => {
  vi.useFakeTimers(); feed();
  const move = vi.mocked(guardedDockMove).getMockImplementation()!;
  vi.mocked(guardedDockMove).mockImplementation(async (...args) => {
    if (requestCount) throw new Error('operator interrupted post-write departure');
    return move(...args);
  });
  await start(); await tick(9000);
  expect((await status()).phase).toBe('error'); expect(requestCount).toBe(1);
  expect(getPendingReanchor(SN)).toBeDefined();
  clearFrameUnvalidated(SN); loadFrameValidationFromDb(); feed();
  expect(isFrameUnvalidated(SN)).toBe(true);
  await start(); await tick(1000);
  expect((await status()).phase).toBe('error'); expect(isFrameUnvalidated(SN)).toBe(true);
  vi.mocked(guardedDockMove).mockImplementation(move); feed();
  await start(); await tick(9000);
  expect((await status()).phase).toBe('done'); expect(requestCount).toBe(1);
  expect(isFrameUnvalidated(SN)).toBe(false);
});
it('an expired operator lease during measurement cannot write or unlock', async () => {
  vi.useFakeTimers(); feed(); await start(); await tick(7000, false);
  expect((await status()).phase).toBe('error'); expect(requestCount).toBe(0);
  expect(isFrameUnvalidated(SN)).toBe(true); expect((await action('verify')).status).toBe(410);
});
it.each([{ x: .06 }, { docked: false }, { base: undefined }, { base_spread_m: .04 },
  { base: { ...anchor, z: 0, yaw: 2 } }, { capture_started: 100, capture_finished: 101 }])(
  'still rejects invalid final heading, runtime or measurement after preparation: %j', async bad => {
    vi.useFakeTimers(); feed(); runtimeOverride = bad; await start(); await tick(9000);
    expect((await status()).phase).toBe('error'); expect(requestCount).toBe(0);
    expect(isFrameUnvalidated(SN)).toBe(true);
  });
it('retains durable uncertainty after changed native readback and refuses a blind retry', async () => {
  vi.useFakeTimers(); feed(); corruptAfterWrite = true; await start(); await tick(9000);
  expect((await status()).phase).toBe('error'); expect(getPendingReanchor(SN)).toBeDefined();
  expect(isFrameUnvalidated(SN)).toBe(true); expect(guardedDockMove).toHaveBeenCalledTimes(2);
  feed(); await start(); await tick(1000);
  expect((await status()).phase).toBe('error'); expect(requestCount).toBe(1);
});
