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

// Marker acquisition/validation is exercised in copyAlignment.test.ts; these
// route tests verify that no old photo/position request bypasses that service.
vi.mock('../../services/copyAlignment.js', () => ({
  beginCopyAlignment: vi.fn(async () => ({ alignmentId: 'verified', phase: 'source_first' })),
  getCopyAlignment: vi.fn((id: string) => {
    if (!['verified', 'far'].includes(id)) throw new Error('Unknown alignment');
    return { alignmentId: id, phase: 'target_first', dockAtB: id === 'far' ? { x: 50, y: 50 } : { x: 0.1, y: -0.5 } };
  }),
  captureCopyAlignment: vi.fn(async () => ({ alignmentId: 'verified', phase: 'source_second' })),
  validateCopyAlignment: vi.fn(async (id: string) => {
    if (!['verified', 'far'].includes(id)) throw new Error('Unknown alignment');
    return { dockAtB: id === 'far' ? { x: 50, y: 50 } : { x: 0.1, y: -0.5 }, verifyRuntime: async () => {} };
  }),
  consumeCopyAlignment: vi.fn(),
  pointedDockVerifier: vi.fn(() => async () => ({ verifyRuntime: async () => ({}) })),
}));

// Device transfer/readback is covered by installZoneCopy.test.ts. The route
// must await that boundary and only then consume the one-use alignment.
vi.mock('../../services/installZoneCopy.js', () => ({ installZoneCopy: vi.fn() }));
vi.mock('../../services/dockReturnCycle.js', () => ({
  startDockReturn: vi.fn(),
  dockReturn: vi.fn((cycleId: string, sn: string, action: string) => ({ cycleId, sn, phase: action })),
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
import { clearFrameUnvalidated, clearMapInstallPending, isFrameUnvalidated, markFrameUnvalidated, markMapInstallPending, isMapInstallPending, isFrameNavBlocked, loadFrameValidationFromDb, getFrameRevision } from '../../services/frameValidation.js';
const zipFixture = vi.hoisted(() => ({ path: '' }));
vi.mock('../../services/mapBackup.js', () => ({ regenerateLatestZipFromBackup: () => zipFixture.path, scheduleSnapshot: vi.fn() }));
import { dashboardRouter } from '../../routes/dashboard.js';
import { publishToExtended, onExtendedResponse, offExtendedResponse } from '../../mqtt/mapSync.js';
import { forwardToDashboard } from '../../dashboard/socketHandler.js';
import { beginMapApply, mapApplyTiming, PHASE_KEY, ERROR_KEY } from '../../services/mapApplyStatus.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { isDeviceOnline } from '../../mqtt/broker.js';
import { mapRepo } from '../../db/repositories/index.js';
import { withConfirmedCopyDocks } from '../../services/dockChannelRepair.js';
import { captureCopyAlignment, consumeCopyAlignment, validateCopyAlignment } from '../../services/copyAlignment.js';
import { deviceSettingsRepo } from '../../db/repositories/deviceSettings.js';
import { installZoneCopy } from '../../services/installZoneCopy.js';
import { persistZoneCopy } from '../../services/zoneCopy.js';
import { withMowerMapOperation } from '../../services/mowerMapOperation.js';

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
beforeEach(() => { clearMapInstallPending(B); clearMapInstallPending(A); clearFrameUnvalidated(B); clearFrameUnvalidated(A); clearPositionTelemetry(B); vi.mocked(publishToExtended).mockReset(); });

describe('zone copy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(installZoneCopy).mockImplementation(async (sn, plan, opts, docks, verify) => {
      const alignment = await verify();
      await alignment.verifyRuntime();
      return persistZoneCopy(sn, plan, { ...opts, dockOrientation: docks.target.orientation });
    });
    fw.supported = true;
    vi.mocked(isDeviceOnline).mockReturnValue(true);
    for (const sn of [A, B]) for (const m of mapRepo.findByMowerSn(sn)) mapRepo.deleteById(m.map_id);
    addRow(A, 'map0', 'work', square(0, 0), 'Grote tuin');
    addRow(A, 'map0_0_obstacle', 'obstacle', square(2, 2, 2));
    addRow(A, 'map0tocharge_unicom', 'unicom', [dockA, { x: -0.4, y: 0.94 }]);
    addRow(B, 'map0tocharge_unicom', 'unicom', [dockB, { x: 0.3, y: -0.8 }]);
  });

  it('allows dock-return supervision through its own map-operation lease', async () => {
    const cycle = '00000000-0000-0000-0000-000000000001';
    await withMowerMapOperation(B, async () => {
      for (const action of ['pulse', 'stop']) {
        const response = await request(server).post(`/api/dashboard/maps/${B}/dock-return/${cycle}`).send({ action });
        expect(response.status).toBe(200);
        expect(response.body.phase).toBe(action);
      }
      expect((await request(server).post(url('/preview')).send({ canonical: 'map0' })).status).toBe(409);
    });
  });

  it('an ambiguous or legacy position input cannot bypass the marker wizard', async () => {
    const before = mapRepo.findByMowerSn(B);
    for (const suffix of ['', '/preview']) for (const extra of [
      { dockAtB: dockB, alignmentId: 'verified' }, { dockAtB: { x: 'a', y: 1 } }, { dockAtB: { x: 0, y: Number.NaN } },
      { measurementId: 'old-position-token', alignmentId: 'verified' }, { alignmentId: 'unknown' },
    ]) {
      const res = await request(server).post(url(suffix)).send({ canonical: 'map0', ...extra });
      expect([400, 409]).toContain(res.status);
      expect(mapRepo.findByMowerSn(B)).toEqual(before);
    }
    expect(publishToExtended).not.toHaveBeenCalled();
    expect(consumeCopyAlignment).not.toHaveBeenCalled();
  });

  it('quick placement: a pointed source dock previews and copies without a marker measurement, and the origin is remembered', async () => {
    const preview = await request(server).post(url('/preview')).send({ canonical: 'map0', dockAtB: dockB });
    expect(preview.status).toBe(200);
    expect(preview.body.ok).toBe(true);
    expect(preview.body.channels[0].canonical).toBe('map0tocharge_unicom');
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
    expect(validateCopyAlignment).not.toHaveBeenCalled();

    const res = await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB, name: 'Achtertuin' });
    expect(res.status).toBe(200);
    expect(res.body.map.canonicalName).toBe('map0');
    expect(mapRepo.findByMowerSn(B).map(r => r.canonical_name).sort()).toEqual(['map0', 'map0_0_obstacle', 'map0tocharge_unicom']);
    expect(consumeCopyAlignment).not.toHaveBeenCalled();
    expect(validateCopyAlignment).not.toHaveBeenCalled();
    // Nudging later re-runs the copy from this origin; the listing exposes it.
    const origin = deviceSettingsRepo.findBySn(B).find(r => r.key === 'zone_copy:map0');
    expect(JSON.parse(origin!.value)).toMatchObject({ sourceSn: A, sourceCanonical: 'map0', dockAtB: dockB });
    const listed = await request(server).get(`/api/dashboard/maps/${B}`);
    expect(listed.body.maps.find((m: { canonicalName: string }) => m.canonicalName === 'map0').copyOrigin).toMatchObject({ sourceSn: A, sourceCanonical: 'map0', dockAtB: dockB });
  });

  it('quick placement relaxes the dock gate to 30 cm; a marker measurement keeps the default', async () => {
    expect((await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB })).status).toBe(200);
    expect(vi.mocked(withConfirmedCopyDocks).mock.calls.at(-1)?.[4]).toBe(0.3);
    for (const m of mapRepo.findByMowerSn(B)) if (m.canonical_name !== 'map0tocharge_unicom') mapRepo.deleteById(m.map_id);
    expect((await request(server).post(url()).send({ canonical: 'map0', alignmentId: 'verified' })).status).toBe(200);
    expect(vi.mocked(withConfirmedCopyDocks).mock.calls.at(-1)?.[4]).toBeUndefined();
  });

  it('a copy may be retried while the install it left behind is still pending', async () => {
    markMapInstallPending(B);
    try {
      expect((await request(server).post(url('/preview')).send({ canonical: 'map0', dockAtB: dockB })).status).toBe(200);
      const res = await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB });
      expect(res.status).toBe(200);
      expect(res.body.map.canonicalName).toBe('map0');
    } finally { clearMapInstallPending(B); }
  });

  it('rejects malformed copy options before measurement or mutation', async () => {
    for (const suffix of ['', '/preview']) for (const body of [
      [], { canonical: ['map0'] }, { canonical: 'map0', name: 42 },
      { canonical: 'map0', withObstacles: 'false' }, { canonical: 'map0', acceptChannel: 0 },
    ]) {
      expect((await request(server).post(url(suffix)).send(body)).status).toBe(400);
    }
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
    expect(consumeCopyAlignment).not.toHaveBeenCalled();
  });

  it('a changed or incomplete alignment is refused before any mutation', async () => {
    vi.mocked(validateCopyAlignment).mockRejectedValueOnce(new Error('Frame changed'));
    const res = await request(server).post(url()).send({ canonical: 'map0', alignmentId: 'verified' });
    expect(res.status).toBe(409);
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
    expect(consumeCopyAlignment).not.toHaveBeenCalled();
    expect(publishToExtended).not.toHaveBeenCalled();
  });

  it('capture requires physical source-dock confirmation and server chooses the mower', async () => {
    expect((await request(server).post(url('/alignment')).send({ canonical: 'map0' })).status).toBe(400);
    expect(captureCopyAlignment).not.toHaveBeenCalled();
    expect((await request(server).post(url('/alignment')).send({ canonical: 'map0', atSourceDock: true, side: 'target' })).status).toBe(200);
    expect(captureCopyAlignment).toHaveBeenLastCalledWith('verified', 'source');
    expect((await request(server).post(url('/alignment')).send({ canonical: 'map0', atSourceDock: true, alignmentId: 'verified' })).status).toBe(200);
    expect(captureCopyAlignment).toHaveBeenLastCalledWith('verified', 'target');
    expect(publishToExtended).not.toHaveBeenCalled();
  });

  it('preview: 200 met plan, geen DB-mutatie, geen push', async () => {
    const res = await request(server).post(url('/preview')).send({ canonical: 'map0', alignmentId: 'verified' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.canonical).toBe('map0');
    expect(res.body.sourceAlias).toBe('Grote tuin');
    expect(res.body.channels[0].canonical).toBe('map0tocharge_unicom');
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
    expect(publishToExtended).not.toHaveBeenCalled();
  });

  it('preview: refusal komt als 200 met ok:false en leesbare tekst', async () => {
    const res = await request(server).post(url('/preview')).send({ canonical: 'map0', alignmentId: 'far' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.refusal).toBe('too_far_from_dock');
    expect(typeof res.body.error).toBe('string');
  });

  it('preview zonder verplichte uitlijning: 409, niets geschreven', async () => {
    const res = await request(server).post(url('/preview')).send({ canonical: 'map0' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('alignment_required');
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
  });

  it('copy: consumes the alignment only after the verified installer commits the rows', async () => {
    const res = await request(server).post(url()).send({ canonical: 'map0', alignmentId: 'verified' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.map.canonicalName).toBe('map0');
    expect(res.body.map.mapName).toMatch(/^Grote tuin \((copy|kopie)\)$/);
    expect(res.body.map.mapType).toBe('work');
    expect(res.body.obstacles).toEqual(['map0_0_obstacle']);
    expect(res.body.channels).toEqual(['map0tocharge_unicom']);
    expect(res.body.needsChannel).toBe(false);
    expect(consumeCopyAlignment).toHaveBeenCalledWith('verified');
    expect(installZoneCopy).toHaveBeenCalledOnce();
    expect(vi.mocked(installZoneCopy).mock.calls[0][0]).toBe(B);
    expect(vi.mocked(installZoneCopy).mock.calls[0][2]).toEqual({ alias: res.body.map.mapName, acceptChannel: true });
    const rows = mapRepo.findByMowerSn(B).map(r => r.canonical_name).sort();
    expect(rows).toEqual(['map0', 'map0_0_obstacle', 'map0tocharge_unicom']);
    expect(JSON.parse(deviceSettingsRepo.findBySn(B).find(r => r.key === 'zone_copy:map0')!.value)).toMatchObject({ sourceSn: A, sourceCanonical: 'map0' });
    await new Promise(r => setTimeout(r, 0));
    const sent = vi.mocked(publishToExtended).mock.calls.map(c => Object.keys(c[1] as object)[0]);
    expect(sent).toEqual([]);
  });

  it('copy waits for device verification without responding or consuming the alignment early', async () => {
    const before = mapRepo.findByMowerSn(B);
    let release!: () => void;
    const installed = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(installZoneCopy).mockImplementationOnce(async (sn, plan, opts, docks, verify) => {
      await verify();
      await installed;
      return persistZoneCopy(sn, plan, { ...opts, dockOrientation: docks.target.orientation });
    });
    let responded = false;
    const response = request(server).post(url()).send({ canonical: 'map0', alignmentId: 'verified' })
      .then(res => { responded = true; return res; });
    await vi.waitFor(() => expect(installZoneCopy).toHaveBeenCalledOnce());
    expect(responded).toBe(false);
    expect(mapRepo.findByMowerSn(B)).toEqual(before);
    expect(consumeCopyAlignment).not.toHaveBeenCalled();
    release();
    expect((await response).status).toBe(200);
    expect(consumeCopyAlignment).toHaveBeenCalledWith('verified');
    expect(publishToExtended).not.toHaveBeenCalled();
  });

  it.each(['runtime frame changed', 'native readback did not match'])('copy failure (%s) preserves DB and alignment for a fresh checked attempt', async error => {
    const before = mapRepo.findByMowerSn(B);
    if (error === 'runtime frame changed') vi.mocked(validateCopyAlignment).mockRejectedValueOnce(new Error(error));
    else vi.mocked(installZoneCopy).mockRejectedValueOnce(new Error(error));
    const res = await request(server).post(url()).send({ canonical: 'map0', alignmentId: 'verified' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(error);
    expect(mapRepo.findByMowerSn(B)).toEqual(before);
    expect(consumeCopyAlignment).not.toHaveBeenCalled();
    expect(publishToExtended).not.toHaveBeenCalled();
  });

  it('copy: eigen naam wint van de bron-alias', async () => {
    const res = await request(server).post(url()).send({ canonical: 'map0', alignmentId: 'verified', name: 'Achtertuin' });
    expect(res.body.map.mapName).toBe('Achtertuin');
  });

  it('copy: an unconfirmed native dock is refused before any DB mutation or push', async () => {
    const before = mapRepo.findByMowerSn(B);
    vi.mocked(withConfirmedCopyDocks).mockRejectedValueOnce(new Error('Dockbestanden spreken elkaar tegen'));
    const res = await request(server).post(url()).send({ canonical: 'map0', alignmentId: 'verified' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('dock_unconfirmed');
    expect(mapRepo.findByMowerSn(B)).toEqual(before);
    expect(publishToExtended).not.toHaveBeenCalled();
  });

  it('copy: 409 offline, niets geschreven', async () => {
    vi.mocked(isDeviceOnline).mockReturnValue(false);
    const res = await request(server).post(url()).send({ canonical: 'map0', alignmentId: 'verified' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('offline');
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
  });

  it('copy: 409 met refusal-reden als het plan weigert', async () => {
    const res = await request(server).post(url()).send({ canonical: 'map0', alignmentId: 'far' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('too_far_from_dock');
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
  });

  it('stock firmware: 409 unsupported_firmware op beide routes', async () => {
    fw.supported = false;
    expect((await request(server).post(url('/preview')).send({ canonical: 'map0', alignmentId: 'verified' })).body.reason).toBe('unsupported_firmware');
    expect((await request(server).post(url()).send({ canonical: 'map0', alignmentId: 'verified' })).body.reason).toBe('unsupported_firmware');
  });
});

describe('toepassen op de maaier: status voor het dashboard', () => {
  const applyUrl = `/api/dashboard/maps/${B}/apply`;
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
    addRow(B, 'map0', 'work', square(0, 0), 'Grote tuin');
    addRow(B, 'map0tocharge_unicom', 'unicom', [dockB, { x: 0.3, y: -0.8 }]);
  });
  afterAll(() => { Object.assign(mapApplyTiming, saved); });
  afterEach(async () => { await new Promise(r => setTimeout(r, 60)); });

  it('meldt syncing → regenerating → settling → klaar', async () => {
    const revision = getFrameRevision(B);
    const res = await request(server).post(applyUrl).send({});
    expect(res.status).toBe(200);
    await tick();
    expect(phases()).toEqual(['syncing']);
    await answer({ sync_map_respond: { result: 0 } });
    await tick();
    await vi.waitFor(() => expect(phases()).toEqual(['syncing', 'regenerating']));
    await answer({ regenerate_per_map_files_respond: { result: 0 } });
    await tick(); ingestPositionTelemetry(B, { error_status: 0 }); await tick(); await tick();
    await vi.waitFor(() => expect(phases()).toEqual(['syncing', 'regenerating', 'settling', '']));
    expect(getFrameRevision(B)).toBe(revision + 1);
    expect(isFrameUnvalidated(B)).toBe(false);
  });

  it.each([false, true])('a verified retry preserves an independent frame block across restart: %s', async needsReanchor => {
    if (needsReanchor) markFrameUnvalidated(B);
    markMapInstallPending(B);
    loadFrameValidationFromDb();
    ingestPositionTelemetry(B, { map_position_x: dockB.x + 10, map_position_y: dockB.y });
    expect(isFrameNavBlocked(B, { start_navigation: {} })).toBe(true);
    expect((await request(server).post(applyUrl).send({})).status).toBe(200);
    await answer({ sync_map_respond: { result: 0 } });
    await answer({ regenerate_per_map_files_respond: { result: 0 } });
    await tick(); ingestPositionTelemetry(B, { error_status: 0 });
    await vi.waitFor(() => expect(phases().at(-1)).toBe(''));
    loadFrameValidationFromDb();
    expect(isMapInstallPending(B)).toBe(false);
    expect(isFrameUnvalidated(B)).toBe(needsReanchor);
    expect(isFrameNavBlocked(B, { start_navigation: {} })).toBe(needsReanchor);
    expect(vi.mocked(publishToExtended).mock.calls.some(c => c[1].measure_runtime_frame || c[1].reanchor_pos)).toBe(false);
  });

  it('can install the first zone after all old channels have been deleted on the mower', async () => {
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
    await request(server).post(applyUrl).send({});
    await answer({ sync_map_respond: { result: 0 } });
    await answer({ regenerate_per_map_files_respond: { result: 0 } });
    await tick(); ingestPositionTelemetry(B, { error_status: 0 });
    await vi.waitFor(() => expect(phases().at(-1)).toBe(''));
    expect(reads).toBe(2);
    expect(isFrameUnvalidated(B)).toBe(false);
  });

  // GH #161: the dashboard's Retry (and the app's "Retry installation") on a
  // mower whose home0 lost map.yaml/map.pgm. regenerate refuses without them.
  it('Retry first gives a mower that lost its whole-garden raster a new one, then the per-zone grids', async () => {
    let reads = 0;
    vi.mocked(publishToExtended).mockImplementation((_sn, command) => {
      if (!command.read_map_files) return;
      const data = { ...snapshot(), map_files_text: {}, map_files_b64: {} };
      if (reads++ > 0) Object.assign(data, { map_files_text: { 'map.yaml': 'image: map.pgm\n' }, map_files_b64: { 'map.pgm': 'UDU=' } });
      queueMicrotask(() => answer({ read_map_files_respond: data }));
    });
    markMapInstallPending(B);
    expect((await request(server).post(applyUrl).send({})).status).toBe(200);
    await answer({ sync_map_respond: { result: 0 } });
    await answer({ write_map_files_respond: { result: 0 } });
    const sent = vi.mocked(publishToExtended).mock.calls.map(c => Object.keys(c[1])[0]).filter(c => c !== 'read_map_files');
    expect(sent).toEqual(['sync_map', 'write_map_files']);
    const write = vi.mocked(publishToExtended).mock.calls.find(c => c[1].write_map_files)![1].write_map_files as Record<string, any>;
    expect(write.csv_files).toEqual(csvFixture);
    expect(Object.keys(write.map_files_b64).sort()).toEqual(['map.pgm', 'map.png']);
    await answer({ regenerate_per_map_files_respond: { result: 0 } });
    await tick(); ingestPositionTelemetry(B, { error_status: 0 });
    await vi.waitFor(() => expect(phases().at(-1)).toBe(''));
    expect(phases()).not.toContain('failed');
    expect(isMapInstallPending(B)).toBe(false);
  });

  // GH #162: the failed banner stayed until a run of its own kind replaced it.
  it('a verified Retry ends the failed banner, also one another route reported meanwhile', async () => {
    markMapInstallPending(B);
    expect((await request(server).post(applyUrl).send({})).status).toBe(200);
    await answer({ sync_map_respond: { result: 0 } });
    beginMapApply(B).fail('install_mismatch'); // another route reports a failure while the Retry runs
    await answer({ regenerate_per_map_files_respond: { result: 0 } });
    await tick(); ingestPositionTelemetry(B, { error_status: 0 });
    await vi.waitFor(() => expect(isMapInstallPending(B)).toBe(false));
    expect(phases().at(-1)).toBe('');
    expect(deviceCache.get(B)?.get(PHASE_KEY)).toBe('');
  });

  it.each(['pos_json', 'charging_station_yaml'] as const)('retains independent frame recovery when %s changes during a CSV install', async file => {
    let reads = 0;
    vi.mocked(publishToExtended).mockImplementation((_sn, command) => {
      if (!command.read_map_files) return;
      const data = snapshot();
      if (reads++ > 0) data[file] += '\n';
      queueMicrotask(() => answer({ read_map_files_respond: data }));
    });
    await request(server).post(applyUrl).send({});
    await answer({ sync_map_respond: { result: 0 } });
    await answer({ regenerate_per_map_files_respond: { result: 0 } });
    await tick(); ingestPositionTelemetry(B, { error_status: 0 });
    await vi.waitFor(() => expect(phases().at(-1)).toBe('failed'));
    expect(isMapInstallPending(B)).toBe(true);
    clearMapInstallPending(B);
    loadFrameValidationFromDb();
    expect(isFrameNavBlocked(B, { start_navigation: {} })).toBe(true);
  });

  it('keeps navigation locked if sync reports a failed restart despite result zero', async () => {
    await request(server).post(applyUrl).send({});
    await answer({ sync_map_respond: { result: 0, restart: false } });
    await vi.waitFor(() => expect(phases().at(-1)).toBe('failed'));
    expect(isFrameUnvalidated(B)).toBe(true);
    expect(vi.mocked(publishToExtended).mock.calls.some(c => c[1].regenerate_per_map_files)).toBe(false);
    // Applying again is the repair of a failed install: it passes the frame
    // gate, pushes a fresh sync, and the frame stays locked until it confirms.
    const commands = vi.mocked(publishToExtended).mock.calls.length;
    const retry = await request(server).post(applyUrl).send({});
    expect(retry.status).toBe(200);
    await vi.waitFor(() => expect(vi.mocked(publishToExtended).mock.calls.filter(c => c[1].sync_map)).toHaveLength(2));
    await answer({ sync_map_respond: { result: 0 } });
    await answer({ regenerate_per_map_files_respond: { result: 0 } });
    await tick(); ingestPositionTelemetry(B, { error_status: 0 });
    await vi.waitFor(() => expect(phases().at(-1)).toBe(''));
    expect(vi.mocked(publishToExtended).mock.calls.length).toBeGreaterThan(commands);
    loadFrameValidationFromDb();
    expect(isFrameUnvalidated(B)).toBe(false);
  });

  it('blocks concurrent writes and keeps planner timeout failed with navigation locked', async () => {
    await request(server).post(applyUrl).send({}); await tick();
    expect((await request(server).post(applyUrl).send({})).status).toBe(409);
    expect(phases()).toEqual(['syncing']);
    await vi.waitFor(() => expect(vi.mocked(publishToExtended).mock.calls.filter(c => c[1].sync_map)).toHaveLength(1));
    await answer({ sync_map_respond: { result: 0 } }); await tick();
    await answer({ regenerate_per_map_files_respond: { result: 0 } });
    await new Promise(r => setTimeout(r, 80));
    const last = vi.mocked(forwardToDashboard).mock.calls.at(-1)![1] as Map<string, string>;
    expect(last.get(ERROR_KEY)).toBe('planner_timeout'); expect(isFrameUnvalidated(B)).toBe(true);
  });

  it('een mislukte sync_map laat failed staan met de reden', async () => {
    await request(server).post(applyUrl).send({});
    await tick();
    await answer({ sync_map_respond: { result: 1, error: 'download failed' } });
    await tick();
    const last = vi.mocked(forwardToDashboard).mock.calls.at(-1)![1] as Map<string, string>;
    expect(last.get(PHASE_KEY)).toBe('failed');
    expect(last.get(ERROR_KEY)).toBe('sync_failed');
  });

  it('een mislukte regenerate laat failed staan met de reden', async () => {
    await request(server).post(applyUrl).send({});
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

// A failed edit push leaves the install pending and the frame unvalidated, and
// re-anchor refuses until the install is done. Re-sync and Revert push the map
// again, which is the repair; Discard only touches the database. All three
// got a 409, so the user could do nothing (LFIN1231000265, Oct 2026).
describe('the map gate while an edit install is pending', () => {
  beforeEach(() => { vi.mocked(isDeviceOnline).mockReturnValue(false); });
  const gated = (res: request.Response) => res.status === 409 && res.body.reason === 'frame_unvalidated';

  it('lets Re-sync and Revert through, as the repair', async () => {
    markFrameUnvalidated(B); markMapInstallPending(B);
    expect(gated(await request(server).post(`/api/dashboard/maps/${B}/edit/apply`).send({}))).toBe(false);
    expect(gated(await request(server).post(`/api/dashboard/maps/${B}/edit/revert`).send({}))).toBe(false);
  });

  it('keeps blocking them while only the frame waits for a re-anchor', async () => {
    markFrameUnvalidated(B);
    expect(gated(await request(server).post(`/api/dashboard/maps/${B}/edit/apply`).send({}))).toBe(true);
    expect(gated(await request(server).post(`/api/dashboard/maps/${B}/edit/revert`).send({}))).toBe(true);
  });

  it('lets Discard clear the drafts whatever the frame state', async () => {
    markFrameUnvalidated(B); markMapInstallPending(B);
    expect((await request(server).delete(`/api/dashboard/maps/${B}/edit/drafts`)).status).toBe(200);
  });
});
