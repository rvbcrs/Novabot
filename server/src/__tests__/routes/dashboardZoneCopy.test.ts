/**
 * Zone kopiëren van een andere maaier: preview en copy routes.
 * Spec: docs/superpowers/specs/2026-09-24-copy-zone-between-mowers-design.md
 * Mocks zijn dezelfde als in dashboardMapWriteStock.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach, afterAll } from 'vitest';

// Preflight itself has native-snapshot/telemetry tests in dockChannelRepair.test.ts.
vi.mock('../../services/dockChannelRepair.js', () => ({
  repairDockChannels: vi.fn(),
  withConfirmedCopyDocks: vi.fn(async (_target, _source, run) => run({
    source: { x: 0.03, y: 0.73, orientation: -Math.PI / 2 },
    target: { x: 0.1, y: -0.5, orientation: -Math.PI / 2 },
  })),
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

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';
import { ingestPositionTelemetry, clearPositionTelemetry } from '../../services/positionTelemetry.js';
import { clearFrameUnvalidated, isFrameUnvalidated } from '../../services/frameValidation.js';
const zipFixture = vi.hoisted(() => ({ path: '' }));
vi.mock('../../services/mapBackup.js', () => ({ regenerateLatestZipFromBackup: () => zipFixture.path, scheduleSnapshot: vi.fn() }));
import { dashboardRouter } from '../../routes/dashboard.js';
import { publishToExtended, onExtendedResponse, offExtendedResponse } from '../../mqtt/mapSync.js';
import { forwardToDashboard } from '../../dashboard/socketHandler.js';
import { mapApplyTiming, PHASE_KEY, ERROR_KEY } from '../../services/mapApplyStatus.js';
import { isDeviceOnline } from '../../mqtt/broker.js';
import { mapRepo } from '../../db/repositories/index.js';
import { withConfirmedCopyDocks } from '../../services/dockChannelRepair.js';

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

const csvFixture = { 'map_info.json': JSON.stringify({ charging_pose: { ...dockB, orientation: 1.5 } }), 'map0_work.csv': '0,0\n2,0\n0,2\n', 'map0tocharge_unicom.csv': '0.1,-0.5\n0.3,-0.8\n' };
const snapshot = () => ({ result: 0, snapshot_consistent: true, csv_files: csvFixture, x3_csv_files: csvFixture, charging_station_yaml: 'charging_pose: [0.1,-0.5,1.5]', pos_json: '{"utm_origin":{"x":1,"y":2}}' });
let fixtureDir: string;
beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'copy-sync-test-'));
  zipFixture.path = join(fixtureDir, 'maps.zip');
  const archive = archiver('zip'); const chunks: Buffer[] = [];
  const output = new PassThrough(); output.on('data', b => chunks.push(b));
  const complete = new Promise<void>((resolve, reject) => { output.on('end', resolve); archive.on('error', reject); });
  archive.pipe(output);
  for (const [name, text] of Object.entries(csvFixture)) archive.append(text, { name: `csv_file/${name}` });
  await archive.finalize(); await complete; writeFileSync(zipFixture.path, Buffer.concat(chunks));
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));
beforeEach(() => { clearFrameUnvalidated(B); clearFrameUnvalidated(A); clearPositionTelemetry(B); vi.mocked(publishToExtended).mockReset(); });

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

  it('copy: na bevestigde preflight rijen opgeslagen; apply controleert dock opnieuw', async () => {
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
    expect(sent).toEqual([]);
  });

  it('copy: eigen naam wint van de bron-alias', async () => {
    const res = await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB, name: 'Achtertuin' });
    expect(res.body.map.mapName).toBe('Achtertuin');
  });

  it('copy: an unconfirmed native dock is refused before any DB mutation or push', async () => {
    const before = mapRepo.findByMowerSn(B);
    vi.mocked(withConfirmedCopyDocks).mockRejectedValueOnce(new Error('Dockbestanden spreken elkaar tegen'));
    const res = await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('dock_unconfirmed');
    expect(mapRepo.findByMowerSn(B)).toEqual(before);
    expect(publishToExtended).not.toHaveBeenCalled();
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

describe('toepassen op de maaier: status voor het dashboard', () => {
  const saved = { ...mapApplyTiming };
  let handlers: Array<(d: Record<string, unknown>) => void> = [];
  const answer = async (d: Record<string, unknown>) => {
    const [key, raw] = Object.entries(d)[0]; const command = key.replace(/_respond$/, '');
    await vi.waitFor(() => expect(vi.mocked(publishToExtended).mock.calls.some(c => c[1][command])).toBe(true));
    const params = vi.mocked(publishToExtended).mock.calls.map(c => c[1][command]).filter(Boolean).at(-1) as Record<string, unknown>;
    for (const h of [...handlers]) h({ [key]: { ...(raw as object), operation_id: params?.operation_id } });
  };
  const tick = () => new Promise(r => setTimeout(r, 5));
  const phases = () => vi.mocked(forwardToDashboard).mock.calls
    .filter(c => c[0] === B && (c[1] as Map<string, string>).has(PHASE_KEY))
    .map(c => (c[1] as Map<string, string>).get(PHASE_KEY));

  beforeEach(() => {
    vi.clearAllMocks();
    fw.supported = true;
    vi.mocked(isDeviceOnline).mockReturnValue(true);
    Object.assign(mapApplyTiming, { settleMinMs: 0, settleMaxMs: 50, pollMs: 1 });
    handlers = [];
    ingestPositionTelemetry(B, { battery_state: 'CHARGING', rtk_fix_quality: 4, localization_state: 'RUNNING' });
    vi.mocked(offExtendedResponse).mockImplementation((_sn, h) => { handlers = handlers.filter(x => x !== h); });
    vi.mocked(publishToExtended).mockImplementation((_sn, command) => {
      if (command.read_map_files) queueMicrotask(() => answer({ read_map_files_respond: snapshot() }));
    });
    vi.mocked(onExtendedResponse).mockImplementation((_sn, h) => { handlers.push(h as (d: Record<string, unknown>) => void); });
    for (const sn of [A, B]) for (const m of mapRepo.findByMowerSn(sn)) mapRepo.deleteById(m.map_id);
    addRow(A, 'map0', 'work', square(0, 0), 'Grote tuin');
    addRow(A, 'map0tocharge_unicom', 'unicom', [dockA, { x: -0.4, y: 0.94 }]);
    addRow(B, 'map0tocharge_unicom', 'unicom', [dockB, { x: 0.3, y: -0.8 }]);
  });
  afterAll(() => { Object.assign(mapApplyTiming, saved); });
  afterEach(async () => { await new Promise(r => setTimeout(r, 60)); });

  it('meldt syncing → regenerating → settling → klaar', async () => {
    const res = await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB });
    expect(res.status).toBe(200);
    await tick();
    expect(phases()).toEqual(['syncing']);
    await answer({ sync_map_respond: { result: 0 } });
    await tick();
    await vi.waitFor(() => expect(phases()).toEqual(['syncing', 'regenerating']));
    await answer({ regenerate_per_map_files_respond: { result: 0 } });
    await tick(); ingestPositionTelemetry(B, { error_status: 0 }); await tick(); await tick();
    await vi.waitFor(() => expect(phases()).toEqual(['syncing', 'regenerating', 'settling', '']));
  });

  it('can install the first copied zone after all old channels have been deleted', async () => {
    let reads = 0;
    vi.mocked(publishToExtended).mockImplementation((_sn, command) => {
      if (!command.read_map_files) return;
      const data = snapshot();
      if (reads++ === 0) {
        data.csv_files = { 'map_info.json': csvFixture['map_info.json'] } as typeof csvFixture;
        data.x3_csv_files = data.csv_files;
      }
      queueMicrotask(() => answer({ read_map_files_respond: data }));
    });
    await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB });
    await answer({ sync_map_respond: { result: 0 } });
    await answer({ regenerate_per_map_files_respond: { result: 0 } });
    await tick(); ingestPositionTelemetry(B, { error_status: 0 });
    await vi.waitFor(() => expect(phases().at(-1)).toBe(''));
    expect(reads).toBe(2);
    expect(isFrameUnvalidated(B)).toBe(false);
  });

  it('keeps navigation locked if sync reports a failed restart despite result zero', async () => {
    await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB });
    await answer({ sync_map_respond: { result: 0, restart: false } });
    await vi.waitFor(() => expect(phases().at(-1)).toBe('failed'));
    expect(isFrameUnvalidated(B)).toBe(true);
    expect(vi.mocked(publishToExtended).mock.calls.some(c => c[1].regenerate_per_map_files)).toBe(false);
  });

  it('blocks concurrent writes and keeps planner timeout failed with navigation locked', async () => {
    await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB }); await tick();
    expect((await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB })).status).toBe(409);
    await answer({ sync_map_respond: { result: 0 } }); await tick();
    await answer({ regenerate_per_map_files_respond: { result: 0 } });
    await new Promise(r => setTimeout(r, 80));
    const last = vi.mocked(forwardToDashboard).mock.calls.at(-1)![1] as Map<string, string>;
    expect(last.get(ERROR_KEY)).toBe('planner_timeout'); expect(isFrameUnvalidated(B)).toBe(true);
  });

  it('een mislukte sync_map laat failed staan met de reden', async () => {
    await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB });
    await tick();
    await answer({ sync_map_respond: { result: 1, error: 'download failed' } });
    await tick();
    const last = vi.mocked(forwardToDashboard).mock.calls.at(-1)![1] as Map<string, string>;
    expect(last.get(PHASE_KEY)).toBe('failed');
    expect(last.get(ERROR_KEY)).toBe('sync_failed');
  });

  it('een mislukte regenerate laat failed staan met de reden', async () => {
    await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB });
    await tick();
    await answer({ sync_map_respond: { result: 0 } });
    await tick();
    await answer({ regenerate_per_map_files_respond: { result: 1, error: 'map.pgm missing' } });
    await tick();
    const last = vi.mocked(forwardToDashboard).mock.calls.at(-1)![1] as Map<string, string>;
    expect(last.get(PHASE_KEY)).toBe('failed');
    expect(last.get(ERROR_KEY)).toBe('regenerate_failed');
  });
});

describe('POST /maps/:sn/apply — opnieuw op de maaier zetten na een mislukte push', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fw.supported = true;
    vi.mocked(isDeviceOnline).mockReturnValue(true);
  });

  it('weigert device-write zonder verse dockmeting, zichtbaar als failed', async () => {
    const res = await request(server).post(`/api/dashboard/maps/${B}/apply`).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    await new Promise(r => setTimeout(r, 0));
    expect(publishToExtended).not.toHaveBeenCalled();
  });

  it('409 offline, geen push', async () => {
    vi.mocked(isDeviceOnline).mockReturnValue(false);
    const res = await request(server).post(`/api/dashboard/maps/${B}/apply`).send({});
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('offline');
    expect(publishToExtended).not.toHaveBeenCalled();
  });

  it('stock firmware: 409 unsupported_firmware', async () => {
    fw.supported = false;
    const res = await request(server).post(`/api/dashboard/maps/${B}/apply`).send({});
    expect(res.body.reason).toBe('unsupported_firmware');
  });
});

describe('server-qualified measurement', () => {
  it('refuses cached/Float data, accepts eight actual stable packets and binds the token to coordinates', async () => {
    fw.supported = true; vi.mocked(isDeviceOnline).mockReturnValue(true);
    for (const m of mapRepo.findByMowerSn(B)) mapRepo.deleteById(m.map_id);
    addRow(B, 'map0tocharge_unicom', 'unicom', [dockB, { x: 0.3, y: -0.8 }]);
    const endpoint = `/api/dashboard/maps/${B}/measurement`;
    expect((await request(server).get(endpoint)).status).toBe(409);
    for (let i = 0; i < 8; i++) ingestPositionTelemetry(B, { rtk_fix_quality: 4, localization_state: 'RUNNING', map_position_x: 2, map_position_y: 3 }, Date.now() - 8000 + i * 1000);
    const result = await request(server).get(endpoint);
    expect(result.status).toBe(200); expect(result.body.sampleCount).toBe(8);
    expect((await request(server).post(url('/preview')).send({ canonical: 'map0', dockAtB: { x: 5, y: 6 }, measurementId: result.body.measurementId })).status).toBe(409);
    for (const m of mapRepo.findByMowerSn(B)) mapRepo.deleteById(m.map_id);
    expect((await request(server).get(endpoint)).status).toBe(200);
    ingestPositionTelemetry(B, { rtk_fix_quality: 5 });
    expect((await request(server).get(endpoint)).status).toBe(409);
  });
});
