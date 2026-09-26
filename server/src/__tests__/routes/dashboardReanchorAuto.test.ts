/**
 * Automatic re-anchor flow (Novabot-cq3).
 *
 * POST /api/dashboard/reanchor/:sn action:'auto' is the wizard's one-button
 * path. It must gate hard on the preconditions before it touches the mower:
 *   - frame must actually be unvalidated (else 409, nothing to do)
 *   - mower must be on the dock (charging)
 *   - mower must be on a real RTK Fixed
 *
 * action:'verify' is the manual backup: after the operator joysticks the mower
 * back onto the dock, it re-checks the docked map_position against the origin
 * and only clears frame_unvalidated when it lands within tolerance. It never
 * moves the mower. It is gated on the lifecycle: the mower must have left the
 * dock, re-locked (RUNNING + RTK Fixed) against the new origin, AND be back on
 * the dock — verifying before the relock tests a stale frame, verifying off-dock
 * checks the wrong place. battery FULL alone is NOT "on the dock" (it lingers
 * after undocking), so it cannot satisfy the auto-start or verify dock gate.
 *
 * GET /reanchor/:sn/status exposes the progress the wizard polls plus the live
 * gating booleans (onDock / rtkFixed / relocked).
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

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
import { markFrameUnvalidated, clearFrameUnvalidated, isFrameUnvalidated, setReanchorRelocked } from '../../services/frameValidation.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { mapRepo } from '../../db/repositories/index.js';
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

const SN = 'LFIN_REANCHOR_TEST';
const data = { battery_state: 'CHARGING', recharge_status: 9, rtk_fix_quality: 4, rtk_latitude: 52.1234567, rtk_longitude: 4.7654321, map_position_x: 0.13, map_position_y: -0.52, localization_state: 'RUNNING' };
const anchor = { x: 0.13, y: -0.52 };
const handlers = new Set<(data: Record<string, unknown>) => void>();
let loadedOrigin: unknown;
let snapshotConflict = false;
let requestCount = 0;
function snapshot() {
  return { result: 0, snapshot_consistent: true, csv_files: {
    'map0tocharge_unicom.csv': '0.13,-0.52\n0.2,-0.4\n',
    'map_info.json': JSON.stringify({ charging_pose: { ...anchor, orientation: 1.5 } }),
  }, charging_station_yaml: `charging_pose: [${snapshotConflict ? 2 : anchor.x}, ${anchor.y}, 1.5]`, pos_json: JSON.stringify({ utm_origin: loadedOrigin }) };
}
function feed(fields = {}) { ingestPositionTelemetry(SN, { ...data, rtk_sample_id: String(Date.now()), ...fields }); }
async function tick(ms = 1000) { await vi.advanceTimersByTimeAsync(ms); }
async function status() { return (await request(server).get(`/api/dashboard/reanchor/${SN}/status`)).body.status; }
const action = (value: string) => request(server).post(`/api/dashboard/reanchor/${SN}`).send({ action: value });
beforeEach(() => {
  vi.clearAllMocks(); clearPositionTelemetry(SN); clearFrameUnvalidated(SN); handlers.clear();
  snapshotConflict = false; requestCount = 0; loadedOrigin = undefined;
  for (const row of mapRepo.findByMowerSn(SN)) mapRepo.deleteById(row.map_id);
  mapRepo.create({ map_id: SN, mower_sn: SN, map_type: 'unicom', canonical_name: 'map0tocharge_unicom', map_area: JSON.stringify([anchor, { x: 0.2, y: -0.4 }]) });
  vi.mocked(onExtendedResponse).mockImplementation((_sn, h) => { handlers.add(h); });
  vi.mocked(offExtendedResponse).mockImplementation((_sn, h) => { handlers.delete(h); });
  vi.mocked(publishToExtended).mockImplementation((_sn, message) => {
    const [command, raw] = Object.entries(message)[0];
    const params = raw as Record<string, number | string>;
    let result: Record<string, unknown> = snapshot();
    if (command === 'reanchor_pos') {
      requestCount++;
      expect(params.anchor_x).toBe(anchor.x); expect(params.anchor_y).toBe(anchor.y);
      // Independent PROJ reference for the fixture's latitude/longitude (UTM 31N), minus anchor.
      loadedOrigin = { x: 620859.4976856122 - anchor.x, y: 5776239.508624249 - anchor.y, utm_zone: 31 };
      result = { result: 0, anchor, utm_origin: loadedOrigin };
    }
    for (const h of [...handlers]) h({ [`${command}_respond`]: { ...result, operation_id: params.operation_id } });
  });
});
afterEach(async () => {
  if (vi.isFakeTimers()) { await tick(400_000); vi.useRealTimers(); }
});
it('rejects cached values, bare RTK boolean, stale measurements and battery FULL without docking', async () => {
  markFrameUnvalidated(SN);
  deviceCache.set(SN, new Map(Object.entries(data).map(([k, v]) => [k, String(v)])));
  expect((await action('auto')).status).toBe(409);
  feed({ rtk_fix_quality: undefined, rtk: true });
  expect((await action('auto')).status).toBe(409);
  feed({ battery_state: 'FULL', recharge_status: 0 });
  expect((await action('auto')).status).toBe(409);
  expect(publishToExtended).not.toHaveBeenCalled();
});
it('retired drive/spin/dock actions and isolated verify cannot move or unlock a mower', async () => {
  markFrameUnvalidated(SN); feed(); setReanchorRelocked(SN, true);
  for (const name of ['drive', 'spin', 'dock']) expect((await action(name)).status).toBe(410);
  expect((await action('verify')).status).toBe(409);
  expect((await action('continue_dock')).status).toBe(409);
  expect(isFrameUnvalidated(SN)).toBe(true); expect(publishToDevice).not.toHaveBeenCalled();
});
it('a conflicting mower anchor refuses before writing an origin', async () => {
  vi.useFakeTimers(); markFrameUnvalidated(SN); feed(); snapshotConflict = true;
  expect((await action('auto')).status).toBe(200); await tick(1);
  expect((await status()).phase).toBe('error'); expect(requestCount).toBe(0);
  expect(isFrameUnvalidated(SN)).toBe(true);
});
it('requires eight new GPS packets, a new off-dock relock and eight post-return samples under one lease', async () => {
  vi.useFakeTimers(); markFrameUnvalidated(SN); feed();
  expect((await action('auto')).status).toBe(200); await tick(1);
  expect((await action('auto')).status).toBe(409);
  expect((await action('continue_dock')).status).toBe(409);
  // Polling cannot manufacture readings.
  await tick(2000); expect(requestCount).toBe(0);
  for (let i = 0; i < 8; i++) { feed(); await tick(); }
  expect(requestCount).toBe(1);
  expect((await status()).phase).toBe('needs_drive');
  expect(publishToDevice).not.toHaveBeenCalled();
  // A post-load report still on the dock cannot count as a relock.
  feed(); await tick(); expect((await status()).relocked).toBe(false);
  feed({ battery_state: 'NORMAL', recharge_status: 0, map_position_y: -1.52 }); await tick();
  expect((await status()).phase).toBe('needs_position');
  expect((await action('verify')).status).toBe(409);
  feed(); expect((await action('verify')).status).toBe(200); await tick();
  expect(isFrameUnvalidated(SN)).toBe(true);
  for (let i = 0; i < 8; i++) { feed(); await tick(); }
  expect((await status()).phase).toBe('done'); expect(isFrameUnvalidated(SN)).toBe(false);
  expect(requestCount).toBe(1); expect(publishToDevice).not.toHaveBeenCalled();
});
