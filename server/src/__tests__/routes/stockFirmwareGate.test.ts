/**
 * Centrale firmware-gate (GH #115 + audit 2026-09-09): alles wat via
 * novabot/extended/<SN> loopt bestaat alleen op OpenNova custom firmware. Op
 * stock moet elke route 409 unsupported_firmware geven VÓÓR een DB-schrijf,
 * zodat server en maaier nooit uiteenlopen (LoRa-cache, seam-fix, planner-
 * radius, kaart-offset) en er geen valse succes-toasts ontstaan.
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

vi.mock('../../services/patrolService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/patrolService.js')>()),
  startPatrol: vi.fn(() => ({ ok: true, run: '123' })),
  stopPatrol: vi.fn(),
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
import { publishToDevice, publishToExtended } from '../../mqtt/mapSync.js';
import { publishExtendedCommand } from '../../mqtt/extendedCommands.js';
import { startPatrol, stopPatrol, readPatrolSettings } from '../../services/patrolService.js';
import { buildPatrolZones, PATROL_INSET_M } from '../../services/patrolRoute.js';
import { getPolygonAnchor } from '../../services/anchor.js';
import { savePatrolFrame } from '../../services/patrolFrames.js';
import { M } from '../../services/serverText.js';
import { mapRepo, scheduleRepo, seamFixRepo, deviceSettingsRepo, equipmentRepo, deviceRepo, patrolRunsRepo } from '../../db/repositories/index.js';

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

const SN = 'LFIN_STOCK_GATE';
const B = `/api/dashboard`;

const stockCases: Array<[string, () => request.Test]> = [
  ['POST /extended (start_edge_cut)', () => request(server).post(`${B}/extended/${SN}`).send({ start_edge_cut: { mapName: 'map0' } })],
  ['PUT /coverage-planner-radius', () => request(server).put(`${B}/coverage-planner-radius/${SN}`).send({ radius: 0.35 })],
  ['PUT /seam-fix', () => request(server).put(`${B}/seam-fix/${SN}`).send({ enabled: true, edgeMarginCm: 5 })],
  ['POST /maps/apply-offset', () => request(server).post(`${B}/maps/${SN}/apply-offset`).send({ dx_m: 0.1, dy_m: 0 })],
  ['POST /lora/set-mower', () => request(server).post(`${B}/lora/set-mower/${SN}`).send({ addr: 718, channel: 16 })],
  ['POST /lora/query-mower', () => request(server).post(`${B}/lora/query-mower/${SN}`).send({})],
  ['POST /reanchor (invalidate)', () => request(server).post(`${B}/reanchor/${SN}`).send({ action: 'invalidate' })],
  ['POST /soft-restart', () => request(server).post(`${B}/soft-restart/${SN}`).send({})],
  ['POST /auto-map/start', () => request(server).post(`${B}/auto-map/${SN}/start`).send({ mode: 'record' })],
  ['POST /mapping-preflight', () => request(server).post(`${B}/mapping-preflight/${SN}`).send({})],
  ['POST /pin/verify', () => request(server).post(`${B}/pin/${SN}/verify`).send({ code: '1234' })],
  ['POST /maps/recalibrate-charging-pose', () => request(server).post(`${B}/maps/${SN}/recalibrate-charging-pose`).send({})],
  ['POST /navigate-to (stock stub never drives)', () => request(server).post(`${B}/navigate-to/${SN}`).send({ x: 1.5, y: -2 })],
  ['POST /schedules with edgeDays', () => request(server).post(`${B}/schedules/${SN}`).send({ startTime: '10:00', weekdays: [1], mapName: 'map0', edgeDays: [1] })],
  ['POST /schedules as a patrol', () => request(server).post(`${B}/schedules/${SN}`).send({ kind: 'patrol', startTime: '23:30', weekdays: [1] })],
  ['POST /patrol', () => request(server).post(`${B}/patrol/${SN}`).send({})],
  ['POST /stop-patrol', () => request(server).post(`${B}/stop-patrol/${SN}`).send({})],
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
      // The patrol service is mocked in this file, so it needs its own check.
      expect(startPatrol).not.toHaveBeenCalled();
      expect(stopPatrol).not.toHaveBeenCalled();
    });
  }

  it('writes nothing to the DB for the settings routes', async () => {
    await request(server).put(`${B}/seam-fix/${SN}`).send({ enabled: true });
    await request(server).put(`${B}/coverage-planner-radius/${SN}`).send({ radius: 0.35 });
    await request(server).post(`${B}/lora/set-mower/${SN}`).send({ addr: 718, channel: 16 });
    await request(server).post(`${B}/schedules/${SN}`).send({ startTime: '10:00', weekdays: [1], mapName: 'map0', edgeDays: [1] });
    await request(server).post(`${B}/schedules/${SN}`).send({ kind: 'patrol', startTime: '23:30', weekdays: [1] });
    expect(seamFixRepo.get(SN)).toBeNull();
    expect(deviceSettingsRepo.findBySn(SN)).toHaveLength(0);
    expect(equipmentRepo.getLoraCache(SN)).toBeFalsy();
    expect(scheduleRepo.findByMowerSn(SN)).toHaveLength(0);
  });

  it('still accepts a schedule WITHOUT edge days on stock', async () => {
    const res = await request(server).post(`${B}/schedules/${SN}`).send({ startTime: '10:00', weekdays: [1], mapName: 'map0' });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(scheduleRepo.findByMowerSn(SN)).toHaveLength(1);
  });

  it('navigate-to: map metres become nav_to_point on OpenNova, bad input is refused', async () => {
    fw.supported = true;
    const ok = await request(server).post(`${B}/navigate-to/${SN}`).send({ x: 1.5, y: -2, yaw: 0.3 });
    expect(ok.status).toBe(200);
    expect(publishExtendedCommand).toHaveBeenCalledWith(SN, { nav_to_point: { x: 1.5, y: -2, yaw: 0.3 } });
    for (const bad of [{ latitude: 52, longitude: 6 }, { x: 'a', y: 1 }, { x: 1, y: 900 }, { x: 1, y: 2, yaw: 'n' }]) {
      const res = await request(server).post(`${B}/navigate-to/${SN}`).send(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(publishExtendedCommand).toHaveBeenCalledTimes(1);
  });

  it('stop-navigation also stops a nav_to_point drive on OpenNova', async () => {
    fw.supported = true;
    await request(server).post(`${B}/stop-navigation/${SN}`).send({});
    expect(publishToDevice).toHaveBeenCalledWith(SN, expect.objectContaining({ stop_navigation: expect.anything() }));
    expect(publishExtendedCommand).toHaveBeenCalledWith(SN, { stop_mow_zone: {} });
  });

  it('lets everything through on OpenNova firmware', async () => {
    fw.supported = true;
    const res = await request(server).post(`${B}/extended/${SN}`).send({ start_edge_cut: { mapName: 'map0' } });
    expect(res.status).toBe(200);
    expect(publishExtendedCommand).toHaveBeenCalledTimes(1);
  });
});

describe('patrol routes', () => {
  const PSN = 'LFIN2230700999';
  beforeEach(() => { vi.clearAllMocks(); fw.supported = true; });

  it('starts and stops a patrol on OpenNova', async () => {
    const ok = await request(server).post(`${B}/patrol/${PSN}`).send({});
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, run: '123' });
    expect(startPatrol).toHaveBeenCalledWith(PSN);
    expect(stopPatrol).not.toHaveBeenCalled();
    const stop = await request(server).post(`${B}/stop-patrol/${PSN}`).send({});
    expect(stop.status).toBe(200);
    expect(stopPatrol).toHaveBeenCalledWith(PSN);
  });

  it('passes a refusal on with its reason', async () => {
    vi.mocked(startPatrol).mockReturnValueOnce({ ok: false, error: 'battery too low for a patrol (30%, at least 50%)' });
    const res = await request(server).post(`${B}/patrol/${PSN}`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('battery');
  });

  it('renders a refusal in the language of the request', async () => {
    vi.mocked(startPatrol).mockReturnValueOnce({ ok: false, error: 'mower offline', errorMsg: M`maaier offline` });
    const res = await request(server).post(`${B}/patrol/${PSN}?lang=de`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Mäher offline');
  });

  it('lists runs with what was seen, and "no data" as null', async () => {
    const meta = { x: 1, y: 2, animal: 0, image: true, ts: 1 };
    savePatrolFrame(PSN, '5', { ...meta, seq: 1, person: 60, frames: 3 }, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    savePatrolFrame(PSN, '5', { ...meta, seq: 2, person: 500, frames: 1 }, null);
    savePatrolFrame(PSN, '5', { ...meta, seq: 3, person: 0, frames: 4 }, null);
    const res = await request(server).get(`${B}/patrol/${PSN}/runs`);
    expect(res.status).toBe(200);
    // By run id: the listing is newest first, so run 5 is not necessarily the first entry.
    const run5 = (res.body.runs as Array<{ run: string; frames: unknown[] }>).find(r => r.run === '5')!;
    const frames = run5.frames as Array<{ seq: number; seen: string[] | null }>;
    expect(frames.map(f => f.seen)).toEqual([['person'], null, []]);
  });

  it('serves a checkpoint photo and 404s the rest', async () => {
    savePatrolFrame(PSN, '6', { seq: 1, x: 0, y: 0, person: 0, animal: 0, frames: 3, image: true, ts: 1 },
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const img = await request(server).get(`${B}/patrol/${PSN}/runs/6/1.jpg`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/jpeg');
    expect((await request(server).get(`${B}/patrol/${PSN}/runs/6/2.jpg`)).status).toBe(404);
    expect((await request(server).get(`${B}/patrol/${PSN}/runs/x6/1.jpg`)).status).toBe(404);
  });

  it('a patrol schedule never goes to the mower as timer_task and cannot be sent', async () => {
    for (const s of scheduleRepo.findByMowerSn(PSN)) scheduleRepo.deleteByIdAndMower(s.schedule_id, PSN);
    const created = await request(server).post(`${B}/schedules/${PSN}`)
      .send({ kind: 'patrol', startTime: '23:30', weekdays: [0, 1, 2, 3, 4, 5, 6], rainPause: true });
    expect(created.status).toBe(200);
    expect(created.body.schedule.kind).toBe('patrol');
    expect(created.body.schedule.rainPause).toBe(false);
    expect(publishToDevice).not.toHaveBeenCalledWith(PSN, expect.objectContaining({ timer_task: expect.anything() }));
    const send = await request(server).post(`${B}/schedules/${PSN}/${created.body.schedule.scheduleId}/send`).send({});
    expect(send.status).toBe(409);
    expect(publishToDevice).not.toHaveBeenCalled();
  });

  // The test above sends rainPause, and a rain pause alone already keeps the
  // timer_task away. Without it, only the patrol kind stands between a patrol
  // schedule and a timer_task, which makes the firmware mow.
  it('a patrol schedule is not sent as timer_task where the same schedule as a mow is', async () => {
    for (const s of scheduleRepo.findByMowerSn(PSN)) scheduleRepo.deleteByIdAndMower(s.schedule_id, PSN);
    const body = { startTime: '23:30', weekdays: [1] };
    const patrol = await request(server).post(`${B}/schedules/${PSN}`).send({ ...body, kind: 'patrol' });
    expect(patrol.status).toBe(200);
    expect(publishToDevice).not.toHaveBeenCalled();
    const mow = await request(server).post(`${B}/schedules/${PSN}`).send(body);
    expect(mow.status).toBe(200);
    expect(publishToDevice).toHaveBeenCalledWith(PSN, expect.objectContaining({ timer_task: expect.anything() }));
  });

  // The patrol card saves its time while the nightly toggle is off; that must
  // give a disabled schedule, not an enabled one.
  it('a patrol schedule honors enabled:false and is enabled without it', async () => {
    for (const s of scheduleRepo.findByMowerSn(PSN)) scheduleRepo.deleteByIdAndMower(s.schedule_id, PSN);
    const off = await request(server).post(`${B}/schedules/${PSN}`)
      .send({ kind: 'patrol', startTime: '23:30', weekdays: [0, 1, 2, 3, 4, 5, 6], enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.schedule.enabled).toBe(false);
    expect(scheduleRepo.findById(off.body.schedule.scheduleId)!.enabled).toBe(0);
    const on = await request(server).post(`${B}/schedules/${PSN}`).send({ kind: 'patrol', startTime: '23:30', weekdays: [1] });
    expect(on.status).toBe(200);
    expect(on.body.schedule.enabled).toBe(true);
    expect(scheduleRepo.findById(on.body.schedule.scheduleId)!.enabled).toBe(1);
  });

  it('a mow schedule posted with enabled:false is still created enabled (unchanged)', async () => {
    for (const s of scheduleRepo.findByMowerSn(PSN)) scheduleRepo.deleteByIdAndMower(s.schedule_id, PSN);
    const mow = await request(server).post(`${B}/schedules/${PSN}`).send({ startTime: '10:00', weekdays: [1], enabled: false });
    expect(mow.status).toBe(200);
    expect(mow.body.schedule.enabled).toBe(true);
    expect(scheduleRepo.findById(mow.body.schedule.scheduleId)!.enabled).toBe(1);
  });

  // No rain pause for a patrol, also not through an edit: scheduleRepo's
  // findActiveRainSchedule (used by rainMonitor) picks an enabled rain_pause
  // schedule as the mower's rain schedule, and must never pick a patrol row.
  it('PATCH keeps rain_pause off on a patrol schedule and still sets it on a mow schedule', async () => {
    for (const s of scheduleRepo.findByMowerSn(PSN)) scheduleRepo.deleteByIdAndMower(s.schedule_id, PSN);
    const patrolId = (await request(server).post(`${B}/schedules/${PSN}`)
      .send({ kind: 'patrol', startTime: '23:30', weekdays: [1] })).body.schedule.scheduleId as string;
    const mowId = (await request(server).post(`${B}/schedules/${PSN}`)
      .send({ startTime: '10:00', weekdays: [1] })).body.schedule.scheduleId as string;

    const patrol = await request(server).patch(`${B}/schedules/${PSN}/${patrolId}`).send({ rainPause: true, startTime: '22:15' });
    expect(patrol.status).toBe(200);
    expect(patrol.body.schedule.rainPause).toBe(false);
    expect(scheduleRepo.findById(patrolId)!.rain_pause).toBe(0);
    expect(patrol.body.schedule.startTime).toBe('22:15');   // only the rain pause is ignored

    const mow = await request(server).patch(`${B}/schedules/${PSN}/${mowId}`).send({ rainPause: true });
    expect(mow.status).toBe(200);
    expect(mow.body.schedule.rainPause).toBe(true);
    expect(scheduleRepo.findById(mowId)!.rain_pause).toBe(1);
  });
});

// The dashboard draws the planned checkpoints on the map and shows a run's
// report: GET /patrol/:sn/plan, and the plan, end, error and failed docking
// that GET /patrol/:sn/runs adds to a run.
describe('patrol plan and report routes', () => {
  const PSN = 'LFIN2230700998';
  const SQ = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
  const TRAMPOLINE = [{ x: 0, y: 8 }, { x: 3, y: 8 }, { x: 3, y: 12 }, { x: 0, y: 12 }];   // against map0's west border
  const zone = (slot: number, dx: number) => mapRepo.create({
    map_id: `plan-z${slot}`, mower_sn: PSN, map_name: `map${slot}`, canonical_name: `map${slot}`, map_type: 'work',
    map_area: JSON.stringify(SQ.map(p => ({ x: p.x + dx, y: p.y }))), file_name: `map${slot}.csv`,
  });
  const known = () => equipmentRepo.create({ equipment_id: `eq-${PSN}`, mower_sn: PSN });

  beforeEach(() => { vi.clearAllMocks(); fw.supported = true; });

  describe('GET /patrol/:sn/plan', () => {
    it('gives the checkpoints a start would drive, in driving order, with the spacing and inset they were planned with', async () => {
      known(); zone(0, 0); zone(1, 40);
      mapRepo.create({
        map_id: 'plan-o0', mower_sn: PSN, map_name: 'map0_0_obstacle', canonical_name: 'map0_0_obstacle',
        map_type: 'obstacle', map_area: JSON.stringify(TRAMPOLINE), file_name: 'map0_0_obstacle.csv',
      });
      deviceSettingsRepo.upsert(PSN, 'patrol_zones', '["map0","map1"]');
      deviceSettingsRepo.upsert(PSN, 'patrol_spacing_m', '5');
      const res = await request(server).get(`${B}/patrol/${PSN}/plan`);
      expect(res.status).toBe(200);
      const s = readPatrolSettings(PSN);
      // startPatrol's own call, spelled out.
      const asStarted = buildPatrolZones(mapRepo.findWorkMaps(PSN), s.zones, s.spacingM, getPolygonAnchor(PSN), undefined,
        mapRepo.findAllByMowerSnAndType(PSN, 'obstacle'));
      expect(res.body).toEqual({ ok: true, zones: asStarted, spacingM: 5, insetM: PATROL_INSET_M });
      expect((res.body.zones as Array<{ zone: string }>).map(z => z.zone)).toEqual(['map0', 'map1']);
      // The recorded obstacle takes checkpoints out, as it does in a start.
      const bare = buildPatrolZones(mapRepo.findWorkMaps(PSN), s.zones, s.spacingM, getPolygonAnchor(PSN));
      expect(res.body.zones[0].points.length).toBeLessThan(bare[0].points.length);
    });

    it('gives no zones, and still the settings, when nothing is planned', async () => {
      known();
      const res = await request(server).get(`${B}/patrol/${PSN}/plan`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, zones: [], spacingM: 6, insetM: PATROL_INSET_M });
    });

    it('starts nothing and sends the mower nothing', async () => {
      known(); zone(0, 0);
      expect((await request(server).get(`${B}/patrol/${PSN}/plan`)).status).toBe(200);
      expect(startPatrol).not.toHaveBeenCalled();
      expect(publishExtendedCommand).not.toHaveBeenCalled();
      expect(publishToDevice).not.toHaveBeenCalled();
      expect(patrolRunsRepo.get(PSN)).toBeUndefined();
    });

    it('is refused on stock firmware like the start is: 409 unsupported_firmware', async () => {
      known(); zone(0, 0);
      fw.supported = false;
      const res = await request(server).get(`${B}/patrol/${PSN}/plan`);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ ok: false, reason: 'unsupported_firmware', msgKey: 'requiresOpenNovaFirmware' });
      expect(res.body.zones).toBeUndefined();
    });

    it('404s a mower the server does not know, whatever its firmware', async () => {
      for (const supported of [true, false]) {
        fw.supported = supported;
        const res = await request(server).get(`${B}/patrol/${PSN}/plan`);
        expect(res.status, `supported ${supported}`).toBe(404);
        expect(res.body).toEqual({ ok: false, error: 'Equipment not found' });
      }
    });

    // The dashboard lists a mower from its MQTT registry row, bound or not.
    it('knows a mower that is not bound yet, from its MQTT registry row', async () => {
      expect((await request(server).get(`${B}/patrol/${PSN}/plan`)).status).toBe(404);
      deviceRepo.upsertDevice('client-plan', PSN, null);
      expect((await request(server).get(`${B}/patrol/${PSN}/plan`)).status).toBe(200);
    });
  });

  describe('GET /patrol/:sn/runs', () => {
    const meta = { x: 1, y: 2, person: 0, animal: 0, frames: 3, image: false, ts: 1 };
    const PLAN = [{ zone: 'map0', points: [[2.5, 1], [7.5, 1]] }];
    const start = (run: string) => patrolRunsRepo.start({ mower_sn: PSN, run, token: 'f'.repeat(32), started_at: Number(run), schedule_id: null });
    const runs = async () => (await request(server).get(`${B}/patrol/${PSN}/runs`)).body.runs as Array<Record<string, unknown>>;

    it('adds the plan, how it ended, the error and the failed docking to the run the server started last', async () => {
      savePatrolFrame(PSN, '7002', { ...meta, seq: 1 }, null);
      start('7002');
      patrolRunsRepo.setPlan(PSN, '7002', JSON.stringify(PLAN));
      patrolRunsRepo.markEnded(PSN, '7002', 'error');
      patrolRunsRepo.setEndError(PSN, '7002', 'checkpoints_unreachable');
      patrolRunsRepo.markDockFailed(PSN, '7002', Date.UTC(2026, 9, 18, 23, 30));
      expect((await runs()).find(r => r.run === '7002')).toEqual({
        run: '7002', startedAt: 7002, frames: [{ ...meta, seq: 1, seen: [] }],
        plan: PLAN, endedPhase: 'error', error: 'checkpoints_unreachable', dockFailedAt: '2026-10-18T23:30:00.000Z',
      });
    });

    it('has no end, error or failed docking for a run that is still out', async () => {
      savePatrolFrame(PSN, '7005', { ...meta, seq: 1 }, null);
      start('7005');
      patrolRunsRepo.setPlan(PSN, '7005', JSON.stringify(PLAN));
      expect((await runs()).find(r => r.run === '7005')).toMatchObject({ plan: PLAN, endedPhase: null, error: null, dockFailedAt: null });
    });

    it('leaves a run the row is not about with nulls, and every frame as it was', async () => {
      savePatrolFrame(PSN, '7003', { ...meta, seq: 1, person: 60 }, null);
      savePatrolFrame(PSN, '7004', { ...meta, seq: 1 }, null);
      start('7004');
      patrolRunsRepo.setPlan(PSN, '7004', JSON.stringify(PLAN));
      expect((await runs()).find(r => r.run === '7003')).toEqual({
        run: '7003', startedAt: 7003, frames: [{ ...meta, seq: 1, person: 60, seen: ['person'] }],
        plan: null, endedPhase: null, error: null, dockFailedAt: null,
      });
    });

    it('lists the run the server started last before its first checkpoint, and when it never reaches one', async () => {
      start('9001');
      patrolRunsRepo.setPlan(PSN, '9001', JSON.stringify(PLAN));
      expect((await runs())[0]).toEqual({
        run: '9001', startedAt: 9001, frames: [], plan: PLAN, endedPhase: null, error: null, dockFailedAt: null,
      });
      patrolRunsRepo.markEnded(PSN, '9001', 'error');
      patrolRunsRepo.setEndError(PSN, '9001', 'not_localized');
      expect((await runs())[0]).toMatchObject({ run: '9001', frames: [], endedPhase: 'error', error: 'not_localized' });
    });
  });
});
