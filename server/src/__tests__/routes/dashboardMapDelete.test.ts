/**
 * DELETE /api/dashboard/maps/:sn/:mapId — wat er NA het verwijderen naar de
 * maaier gaat.
 *
 * Twee dingen gingen hier live mis op LFIN2230700238 (2026-09-07):
 *  1. Er volgde een `sync_map`-kick die onze DB-ZIP over home0/ heen schreef.
 *     Die ZIP miste alle kanalen en hernummerde map3 → map1. De maaier is de
 *     bron van waarheid: we vragen nu om een her-upload (get_map_outline all).
 *  2. Stock robot_decision blijft na delete_map in MAPPING/REQUEST_START staan
 *     (met bladhoogte 90). Zonder quit_mapping_mode staat de maaier daarna in
 *     een halve mapping-sessie.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  clearLocalTrail: vi.fn(),
  clearGpsTrail: vi.fn(),
  plannedPathCache: new Map(),
  previewPathCache: new Map(),
}));


import { dashboardRouter } from '../../routes/dashboard.js';
import { publishToDevice, publishToExtended } from '../../mqtt/mapSync.js';
import { mapRepo } from '../../db/repositories/index.js';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

const SN = 'LFIN_DELETE_ROUTE';

describe('DELETE map route — follow-up commands to the mower', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // shouldAdvanceTime keeps supertest's real I/O alive while we fast-forward
    // the route's two delayed follow-up publishes.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (const m of mapRepo.findByMowerSn(SN)) mapRepo.deleteWithCascade(m.map_id, SN);
    mapRepo.create({
      map_id: 'del-map1', mower_sn: SN, map_name: 'map1', file_name: 'bundle.zip',
      map_area: JSON.stringify([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]),
      map_type: 'work',
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('sends delete_map, then quit_mapping_mode, then get_map_outline all — and never sync_map', async () => {
    const res = await request(app).delete(`/api/dashboard/maps/${SN}/del-map1`);
    expect(res.status).toBe(200);

    const sent = () => vi.mocked(publishToDevice).mock.calls.map(c => Object.keys(c[1] as object)[0]);
    expect(sent()).toEqual(['delete_map']);

    await vi.advanceTimersByTimeAsync(5000);
    expect(sent()).toEqual(['delete_map', 'quit_mapping_mode', 'get_map_outline']);

    // The DB-ZIP push is what corrupted the mower's map set — it must be gone.
    expect(vi.mocked(publishToExtended).mock.calls.map(c => Object.keys(c[1] as object)[0]))
      .not.toContain('sync_map');
  });
});
