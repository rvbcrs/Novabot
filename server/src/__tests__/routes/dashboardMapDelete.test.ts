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
  // De route bevestigt het wissen bij de maaier vóór ze de DB aanraakt.
  awaitCommand: vi.fn().mockResolvedValue({ result: 0, value: null }),
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


import { dashboardRouter, mowerFileName } from '../../routes/dashboard.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { publishToDevice, publishToExtended, awaitCommand, onExtendedResponse } from '../../mqtt/mapSync.js';
import { mapRepo } from '../../db/repositories/index.js';

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

const SN = 'LFIN_DELETE_ROUTE';

describe('DELETE map route — follow-up commands to the mower', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(awaitCommand).mockResolvedValue({ result: 0, value: null });
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

  it('laat de maaier eerst wissen, dan quit_mapping_mode en get_map_outline — en nooit sync_map', async () => {
    const res = await request(server).delete(`/api/dashboard/maps/${SN}/del-map1`);
    expect(res.status).toBe(200);

    // delete_map gaat via awaitCommand zodat het antwoord van de maaier telt.
    expect(vi.mocked(awaitCommand).mock.calls.map(c => c[1])).toEqual(['delete_map']);
    expect(mapRepo.findByMowerSn(SN)).toHaveLength(0);

    const sent = () => vi.mocked(publishToDevice).mock.calls.map(c => Object.keys(c[1] as object)[0]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent()).toEqual(['quit_mapping_mode', 'get_map_outline']);

    // The DB-ZIP push is what corrupted the mower's map set — it must be gone.
    expect(vi.mocked(publishToExtended).mock.calls.map(c => Object.keys(c[1] as object)[0]))
      .not.toContain('sync_map');
  });

  it('stuurt map_type mee: zonder dat veld wist de firmware niets', async () => {
    await request(server).delete(`/api/dashboard/maps/${SN}/del-map1`);
    const payload = vi.mocked(awaitCommand).mock.calls.find(c => c[1] === 'delete_map')?.[2] as
      { map_name?: string; map_type?: number };
    expect(payload).toMatchObject({ map_name: 'map1', map_type: 1 });
  });

  // novabot_mapping (firmware v6.0.2, mapControlCallback) behandelt de drie
  // soorten verschillend. Een werkgebied gaat via "get delete child map name" en
  // daar plakt de node zelf `.csv` achter de slotnaam. Een obstakel en een kanaal
  // gaan via "get delete obstacle name" / "get delete unicom name" en daar doet de
  // node letterlijk remove(<dir> + "/" + map_name) op csv_file/ én x3_csv_file/.
  // Zonder `.csv` bestaat dat pad niet en antwoordt hij "delete obstacle failed".
  it('stuurt de bestandsnaam met .csv voor een obstakel, kaal voor een werkgebied', async () => {
    mapRepo.create({
      map_id: 'del-obs', mower_sn: SN, map_name: 'map1_0_obstacle', file_name: 'bundle.zip',
      map_area: JSON.stringify([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]),
      map_type: 'obstacle', canonical_name: 'map1_0_obstacle',
    });
    await request(server).delete(`/api/dashboard/maps/${SN}/del-obs`);
    expect(vi.mocked(awaitCommand).mock.calls.find(c => c[1] === 'delete_map')?.[2])
      .toMatchObject({ map_name: 'map1_0_obstacle.csv', map_type: 2 });
  });

  it('stuurt de bestandsnaam met .csv voor een kanaal', async () => {
    mapRepo.create({
      map_id: 'del-uni', mower_sn: SN, map_name: 'map1tocharge_unicom', file_name: 'bundle.zip',
      map_area: JSON.stringify([{ x: 0, y: 0 }, { x: 1, y: 0 }]),
      map_type: 'unicom', canonical_name: 'map1tocharge_unicom',
    });
    await request(server).delete(`/api/dashboard/maps/${SN}/del-uni`);
    expect(vi.mocked(awaitCommand).mock.calls.find(c => c[1] === 'delete_map')?.[2])
      .toMatchObject({ map_name: 'map1tocharge_unicom.csv', map_type: 3 });
  });

  it('plakt er geen tweede .csv achter als de naam die al heeft', () => {
    expect(mowerFileName({ canonical_name: 'map0_1_obstacle.csv', map_type: 'obstacle' })).toBe('map0_1_obstacle.csv');
    expect(mowerFileName({ canonical_name: 'map0', map_type: 'work' })).toBe('map0');
    expect(mowerFileName({ map_name: 'Achtertuin', map_type: 'work' })).toBe('Achtertuin');
    expect(mowerFileName({ map_type: 'work' })).toBeNull();
  });

  it('houdt de kaart in de database als de maaier het wissen weigert', async () => {
    vi.mocked(awaitCommand).mockResolvedValueOnce({ result: 1, value: null });
    const res = await request(server).delete(`/api/dashboard/maps/${SN}/del-map1`);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('mower_refused_delete');
    expect(mapRepo.findByMowerSn(SN)).toHaveLength(1);
  });

  it('herstart novabot_mapping en probeert opnieuw als die node eruit ligt', async () => {
    deviceCache.set(SN, new Map([['error_msg', 'Error_code: 140 Process crashed, please reboot and retry!!!']]));
    vi.mocked(awaitCommand)
      .mockResolvedValueOnce({ result: 1, value: null })   // eerste poging: geweigerd
      .mockResolvedValueOnce({ result: 0, value: null });  // na herstart: gelukt
    // De maaier bevestigt de herstart via het extended-kanaal.
    vi.mocked(onExtendedResponse).mockImplementation((_sn: string, handler: (d: Record<string, unknown>) => void) => {
      setTimeout(() => handler({ restart_mapping_respond: { result: 0, running: true } }), 0);
    });

    const res = await request(server).delete(`/api/dashboard/maps/${SN}/del-map1`);
    expect(res.status).toBe(200);
    expect(vi.mocked(publishToExtended).mock.calls.map(c => Object.keys(c[1] as object)[0])).toContain('restart_mapping');
    expect(vi.mocked(awaitCommand).mock.calls.filter(c => c[1] === 'delete_map')).toHaveLength(2);
    expect(mapRepo.findByMowerSn(SN)).toHaveLength(0);
    vi.mocked(onExtendedResponse).mockReset();
    deviceCache.delete(SN);
  });

  it('weigert meteen als de maaier bezig is, zonder commando te sturen', async () => {
    deviceCache.set(SN, new Map([['work_status', '100']]));
    const res = await request(server).delete(`/api/dashboard/maps/${SN}/del-map1`);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('mower_busy');
    expect(awaitCommand).not.toHaveBeenCalled();
    expect(mapRepo.findByMowerSn(SN)).toHaveLength(1);
    deviceCache.delete(SN);
  });

  it('ruimt een geparkeerde taak op vóór het wissen', async () => {
    deviceCache.set(SN, new Map([['work_status', '10']]));
    const res = await request(server).delete(`/api/dashboard/maps/${SN}/del-map1`);
    expect(res.status).toBe(200);
    expect(vi.mocked(awaitCommand).mock.calls.map(c => c[1])).toEqual(['quit_mapping_mode', 'delete_map']);
    deviceCache.delete(SN);
  });

  it('ruimt ook de mapping-modus op, ook al is work_status laag', async () => {
    // Na een afgebroken maaipoging stond de maaier op task_mode 2 met
    // work_status 1 ("Failed"). Die 1 viel onder de oude drempel van 9 door, dus
    // werd er niets opgeruimd en weigerde de firmware het wissen.
    deviceCache.set(SN, new Map([['work_status', '1'], ['task_mode', '2']]));
    const res = await request(server).delete(`/api/dashboard/maps/${SN}/del-map1`);
    expect(res.status).toBe(200);
    expect(vi.mocked(awaitCommand).mock.calls.map(c => c[1])).toEqual(['quit_mapping_mode', 'delete_map']);
    deviceCache.delete(SN);
  });

  it('laat een rustige maaier met rust', async () => {
    deviceCache.set(SN, new Map([['work_status', '0'], ['task_mode', '1']]));
    const res = await request(server).delete(`/api/dashboard/maps/${SN}/del-map1`);
    expect(res.status).toBe(200);
    expect(vi.mocked(awaitCommand).mock.calls.map(c => c[1])).toEqual(['delete_map']);
    deviceCache.delete(SN);
  });

  it('noemt Error 8 niet als reden: dat is LoRa-ruis, geen wis-probleem', async () => {
    vi.mocked(awaitCommand).mockResolvedValue({ result: 1 });
    deviceCache.set(SN, new Map([
      ['work_status', '0'],
      ['error_msg', 'Error_code: 8 Lora disconnect for some time,may causing localization not good!!!'],
    ]));
    const res = await request(server).delete(`/api/dashboard/maps/${SN}/del-map1`);
    expect(res.status).toBe(409);
    expect(res.body.mowerError).toBeNull();
    expect(res.body.error).not.toContain('Lora');
    deviceCache.delete(SN);
  });
});
