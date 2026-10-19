/**
 * A patrol schedule is a nightly window with an interval: POST and PATCH take
 * intervalMin and endTime, GET gives them back, and a window that cannot run
 * (an interval outside 0 or 15..240, an interval without an end time) is a 400
 * with a sentence, never a stored row. Mow schedules ignore intervalMin.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md, 9.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Same edges as the other dashboard route tests: only MQTT and sockets are mocked.
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
  emitScheduleEvent: vi.fn(),
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

// A patrol schedule is only accepted for an OpenNova mower (the central firmware gate).
vi.mock('../../services/mowerFileCapability.js', () => ({
  getMowerFileCapability: () => ({ mowerFileApplySupported: true, isOpenNova: true, mowerVersion: 'v6.0.2-custom-test', reason: null }),
  supportsMowerFileWrites: () => true,
  isOpenNovaMower: () => true,
  UNSUPPORTED_FIRMWARE_REASON: 'unsupported_firmware',
  UNSUPPORTED_FIRMWARE_MSG_KEY: 'requiresOpenNovaFirmware',
}));

import { dashboardRouter } from '../../routes/dashboard.js';
import { scheduleRepo } from '../../db/repositories/index.js';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

// One listener for the whole file, like the other route tests: supertest opens a
// fresh ephemeral port per request otherwise, which collides under load.
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

const SN = 'LFIN2230700997';
const B = '/api/dashboard';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WINDOW = { kind: 'patrol', startTime: '23:00', endTime: '06:00', intervalMin: 30, weekdays: ALL_DAYS, timezone: 'Europe/Amsterdam' };

const post = (body: Record<string, unknown>, query = '') => request(server).post(`${B}/schedules/${SN}${query}`).send(body);
const patch = (id: string, body: Record<string, unknown>) => request(server).patch(`${B}/schedules/${SN}/${id}`).send(body);
const patrolList = async () => (await request(server).get(`${B}/schedules/${SN}?kind=patrol`)).body.schedules as Array<Record<string, unknown>>;

describe('patrol schedule window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const s of scheduleRepo.findByMowerSn(SN)) scheduleRepo.deleteByIdAndMower(s.schedule_id, SN);
  });

  it('creates a patrol window and reads it back', async () => {
    const created = await post(WINDOW);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.schedule).toMatchObject({ kind: 'patrol', startTime: '23:00', endTime: '06:00', intervalMin: 30 });
    const row = scheduleRepo.findById(created.body.schedule.scheduleId)!;
    expect([row.start_time, row.end_time, row.interval_min]).toEqual(['23:00', '06:00', 30]);

    const list = await patrolList();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ startTime: '23:00', endTime: '06:00', intervalMin: 30 });
  });

  it('a patrol without a window is "once": interval 0 and no end time', async () => {
    const created = await post({ kind: 'patrol', startTime: '23:30', weekdays: ALL_DAYS });
    expect(created.status).toBe(200);
    expect(created.body.schedule).toMatchObject({ endTime: null, intervalMin: 0 });
  });

  it('refuses an interval outside 0 or 15..240 and an interval without an end time', async () => {
    for (const intervalMin of [7, 14, 241, 500, -30, 30.5, '30', null]) {
      const res = await post({ ...WINDOW, intervalMin });
      expect(res.status, JSON.stringify(intervalMin)).toBe(400);
      expect(res.body.error, JSON.stringify(intervalMin)).toContain('intervalMin');
    }
    const noEnd = await post({ kind: 'patrol', startTime: '23:00', intervalMin: 30, weekdays: ALL_DAYS });
    expect(noEnd.status).toBe(400);
    expect(noEnd.body.error).toContain('endTime');
    for (const endTime of ['', '6am', '24', '06:0', 6]) {
      const res = await post({ ...WINDOW, endTime });
      expect(res.status, JSON.stringify(endTime)).toBe(400);
      expect(res.body.error, JSON.stringify(endTime)).toContain('endTime');
    }
    expect(scheduleRepo.findByMowerSn(SN)).toHaveLength(0);   // a refusal stores nothing

    // The edges of the range, and "once" without an end time, are fine.
    for (const intervalMin of [15, 240]) expect((await post({ ...WINDOW, intervalMin })).status, String(intervalMin)).toBe(200);
    expect((await post({ kind: 'patrol', startTime: '23:00', intervalMin: 0, weekdays: ALL_DAYS })).status).toBe(200);
  });

  it('says what is wrong in the language of the request', async () => {
    const res = await post({ ...WINDOW, intervalMin: 7 }, '?lang=de');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('intervalMin muss 0 oder zwischen 15 und 240 Minuten liegen');
  });

  it('an edit changes the window, refuses what cannot run, and null clears the end time', async () => {
    const id = (await post(WINDOW)).body.schedule.scheduleId as string;

    const bad = await patch(id, { intervalMin: 500 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('intervalMin');
    expect((await patch(id, { intervalMin: null })).status).toBe(400);   // not a NOT NULL violation (500)
    expect((await patch(id, { endTime: null })).status).toBe(400);       // the interval stays 30: an interval needs an end
    expect((await patch(id, { endTime: '' })).status).toBe(400);
    expect(scheduleRepo.findById(id)).toMatchObject({ interval_min: 30, end_time: '06:00' });   // nothing of the refusals got through

    // One of the two alone is checked against the other as it is kept.
    const hourly = await patch(id, { intervalMin: 60 });
    expect(hourly.status, JSON.stringify(hourly.body)).toBe(200);
    expect(hourly.body.schedule).toMatchObject({ intervalMin: 60, endTime: '06:00' });
    const earlier = await patch(id, { endTime: '05:00' });
    expect(earlier.status, JSON.stringify(earlier.body)).toBe(200);
    expect(earlier.body.schedule).toMatchObject({ intervalMin: 60, endTime: '05:00' });
    const longer = await patch(id, { intervalMin: 90, endTime: '06:30' });
    expect(longer.status).toBe(200);
    expect(longer.body.schedule).toMatchObject({ intervalMin: 90, endTime: '06:30' });

    // Back to once: the interval and the end time go together.
    const once = await patch(id, { intervalMin: 0, endTime: null });
    expect(once.status).toBe(200);
    expect(once.body.schedule).toMatchObject({ intervalMin: 0, endTime: null });
    expect(await patrolList()).toEqual([expect.objectContaining({ scheduleId: id, intervalMin: 0, endTime: null })]);

    // A window needs both again; an edit of something else leaves them alone.
    expect((await patch(id, { intervalMin: 30 })).status).toBe(400);
    expect((await patch(id, { startTime: '22:15' })).body.schedule).toMatchObject({ startTime: '22:15', intervalMin: 0, endTime: null });
  });

  it('a mow schedule ignores intervalMin', async () => {
    const created = await post({ kind: 'mow', startTime: '10:00', endTime: '12:00', intervalMin: 30, weekdays: [1] });
    expect(created.status).toBe(200);
    const id = created.body.schedule.scheduleId as string;
    expect(created.body.schedule).toMatchObject({ kind: 'mow', intervalMin: 0, endTime: '12:00' });
    expect(scheduleRepo.findById(id)!.interval_min).toBe(0);

    // Not even an invalid one is refused: it is not read.
    const mowBad = await post({ startTime: '11:00', intervalMin: 7, weekdays: [1] });
    expect(mowBad.status).toBe(200);
    expect(mowBad.body.schedule.intervalMin).toBe(0);

    const edited = await patch(id, { intervalMin: 45, startTime: '10:30' });
    expect(edited.status).toBe(200);
    expect(edited.body.schedule).toMatchObject({ startTime: '10:30', intervalMin: 0 });
    expect(scheduleRepo.findById(id)!.interval_min).toBe(0);
  });
});
