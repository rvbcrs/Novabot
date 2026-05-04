import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(true),
  writeRawPublish: vi.fn().mockReturnValue(false),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
  banishSn: vi.fn(),
  unbanSn: vi.fn(),
  listBannedSns: vi.fn().mockReturnValue([]),
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

vi.mock('../../mqtt/mapSync.js', async () => {
  const actual = await vi.importActual<typeof import('../../mqtt/mapSync.js')>(
    '../../mqtt/mapSync.js',
  );
  return {
    ...actual,
    publishToExtended: vi.fn(),
    onExtendedResponse: vi.fn(),
    offExtendedResponse: vi.fn(),
    publishToDevice: vi.fn(),
    publishRawToDevice: vi.fn(),
  };
});

vi.mock('../../mqtt/sensorData.js', () => ({
  deviceCache: new Map<string, Map<string, string>>(),
  getAllDeviceSnapshots: vi.fn().mockReturnValue([]),
  getDeviceSnapshot: vi.fn(),
  SENSORS: [],
  getGpsTrail: vi.fn().mockReturnValue([]),
  clearGpsTrail: vi.fn(),
  getLocalTrail: vi.fn().mockReturnValue([]),
  clearLocalTrail: vi.fn(),
  translateValue: vi.fn((_k: string, v: string) => v),
  markPinVerified: vi.fn(),
  getDockPose: vi.fn().mockReturnValue(null),
}));

import { dashboardRouter } from '../../routes/dashboard.js';
import { isDeviceOnline } from '../../mqtt/broker.js';
import * as mapSync from '../../mqtt/mapSync.js';
import { deviceCache } from '../../mqtt/sensorData.js';

const SN = 'LFIN1231000211';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDeviceOnline).mockReturnValue(true);
  vi.mocked(mapSync.offExtendedResponse).mockImplementation(() => {});
  deviceCache.clear();
});

function ackWith(respond: Record<string, unknown>) {
  vi.mocked(mapSync.onExtendedResponse).mockImplementation((_sn, handler) => {
    queueMicrotask(() => handler({ swap_active_map_respond: respond } as any));
  });
}

describe('POST /api/dashboard/maps/:sn/active-slot', () => {
  it('publishes swap_active_map and returns 200 on result:0', async () => {
    ackWith({ result: 0, slot: 3 });
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: 3 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, slot: 3 });
    expect(mapSync.publishToExtended).toHaveBeenCalledWith(
      SN,
      expect.objectContaining({ swap_active_map: { slot: 3 } }),
    );
    expect(deviceCache.get(SN)?.get('active_map_slot')).toBe('3');
  });

  it('idempotent: 2nd POST same slot is cached, no MQTT', async () => {
    if (!deviceCache.has(SN)) deviceCache.set(SN, new Map());
    deviceCache.get(SN)!.set('active_map_slot', '2');

    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, slot: 2, cached: true });
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
  });

  it('rejects negative slot with 400 and no MQTT', async () => {
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: -1 });
    expect(r.status).toBe(400);
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
  });

  it('rejects non-integer slot with 400', async () => {
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: 'two' });
    expect(r.status).toBe(400);
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
  });

  it('returns 404 when mower offline', async () => {
    vi.mocked(isDeviceOnline).mockReturnValue(false);
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: 0 });
    expect(r.status).toBe(404);
  });

  it('translates mower result:2 (slot not mapped) to 400 with helpful error', async () => {
    ackWith({ result: 2, error: 'map5 not mapped on this mower (yaml/pgm missing)', slot: 5 });
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: 5 });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(String(r.body.error)).toContain('map first via the app');
    expect(deviceCache.get(SN)?.has('active_map_slot')).toBe(false);
  });

  it('translates mower result:3 (coverage active) to 409', async () => {
    ackWith({ result: 3, error: 'coverage active, swap refused' });
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: 1 });
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toContain('stop mowing first');
  });

  it('translates mower result:4 (LoadMap fail) to 500', async () => {
    ackWith({ result: 4, error: 'LoadMap call failed', load_rc: 1 });
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: 1 });
    expect(r.status).toBe(500);
  });
});

describe('GET /api/dashboard/maps/:sn/active-slot', () => {
  it('returns the cached slot or null', async () => {
    let r = await request(app).get(`/api/dashboard/maps/${SN}/active-slot`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ slot: null });

    if (!deviceCache.has(SN)) deviceCache.set(SN, new Map());
    deviceCache.get(SN)!.set('active_map_slot', '4');
    r = await request(app).get(`/api/dashboard/maps/${SN}/active-slot`);
    expect(r.body).toEqual({ slot: 4 });
  });
});
