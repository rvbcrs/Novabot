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
import { startPatrol, stopPatrol } from '../../services/patrolService.js';
import { savePatrolFrame } from '../../services/patrolFrames.js';
import { M } from '../../services/serverText.js';
import { mapRepo, scheduleRepo, seamFixRepo, deviceSettingsRepo, equipmentRepo } from '../../db/repositories/index.js';

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
});
