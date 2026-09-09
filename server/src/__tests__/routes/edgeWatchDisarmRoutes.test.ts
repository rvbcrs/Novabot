/**
 * Finding 4 (whole-branch review): de rand-dag watcher moet expliciet
 * ontwapenen wanneer de maaier via de server wordt gestopt of wanneer het
 * schema wordt uitgezet/verwijderd. Deze tests draaien de ECHTE scheduleRunner
 * (armen via een due schema) tegen de echte dashboard-routes; alleen de
 * MQTT/socket-randen zijn gemockt. Haalt iemand een disarm-aanroep uit een
 * route, dan faalt de bijbehorende test hier.
 */

import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  patchLatestZipChargingPose: vi.fn(),
  republishObstacleDetection: vi.fn(),
}));

vi.mock('../../mqtt/mapConverter.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../mqtt/mapConverter.js')>(),
  generateMapZipFromDb: vi.fn(),
  gpsToLocal: vi.fn(),
  localToGps: vi.fn(),
}));

vi.mock('../../services/demoSimulator.js', () => ({
  isDemoMode: vi.fn().mockReturnValue(false),
  setDemoMode: vi.fn(),
  getDemoStatus: vi.fn().mockReturnValue({}),
  setDemoInterceptor: vi.fn(),
}));

import { dashboardRouter } from '../../routes/dashboard.js';
import { publishRawToDevice, publishToDevice, publishToTopic } from '../../mqtt/mapSync.js';
import {
  startScheduleRunner, stopScheduleRunner, __getPendingEdgeForTest, disarmEdgeWatch,
} from '../../services/scheduleRunner.js';
import { mapRepo, scheduleRepo } from '../../db/repositories/index.js';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

it.each(['import-zip', 'upload-zip'])('%s preserves nonzero slots from a real ZIP and never replaces existing maps', async (endpoint) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'map-identity-'));
  try {
    fs.mkdirSync(path.join(dir, 'csv_file'));
    const csv = '4,4\n9,4\n9,9\n4,4\n';
    const files = ['map4_work.csv', 'map4_2_obstacle.csv', 'map4_3_obstacle.csv',
      'map4tomap0_7_unicom.csv', 'map4tocharge_unicom.csv'];
    for (const file of files) fs.writeFileSync(path.join(dir, 'csv_file', file), csv);
    const zipPath = path.join(dir, 'maps.zip');
    execFileSync('zip', ['-q', '-r', zipPath, 'csv_file'], { cwd: dir });
    const body = endpoint === 'import-zip'
      ? { zipPath }
      : { data: fs.readFileSync(zipPath).toString('base64') };
    const sn = 'LFIN_IMPORT_IDENTITY';
    const r = await request(app).post(`/api/dashboard/maps/${sn}/${endpoint}`).send(body);
    expect(r.status).toBe(200);
    const expectedFiles = endpoint === 'import-zip' ? files.slice(0, 1) : files;
    expect(r.body.imported).toBe(expectedFiles.length);
    const rows = mapRepo.findByMowerSn(sn);
    expect(rows.map(row => row.file_name).sort()).toEqual([...expectedFiles].sort());
    for (const row of rows) {
      expect(row.canonical_name).toBe(row.file_name!.replace(/_work\.csv$|\.csv$/g, ''));
      expect(JSON.parse(row.map_area!)).toEqual([{ x: 4, y: 4 }, { x: 9, y: 4 }, { x: 9, y: 9 }, { x: 4, y: 4 }]);
    }
    const work = rows.find(row => row.map_type === 'work')!;
    expect(work.canonical_name).toBe('map4');
    mapRepo.updateName(work.map_id, 'My existing alias');
    const repeated = await request(app).post(`/api/dashboard/maps/${sn}/${endpoint}`).send(body);
    expect(repeated.status).toBe(200);
    expect(repeated.body.imported).toBe(0);
    expect(mapRepo.findById(work.map_id)?.map_name).toBe('My existing alias');
    expect(mapRepo.findByMowerSn(sn)).toHaveLength(expectedFiles.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('mowing area limit at both command entry points (#114)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['start_navigation', 100000, undefined],
    ['start_navigation', 100001, false], // map0 + map5, raw plaintext override
    ['start_navigation', 1111111111, undefined], // all ten slots
    ['start_run', 100000, false], // legacy fallback must not bypass the limit
    ['start_navigation', 255, undefined], // reserved vision_test code
  ])('rejects %s area=%s before any publish', async (key, area, encrypt) => {
    const r = await request(app).post('/api/dashboard/command/LFIN_AREA_LIMIT')
      .send({ command: { [key]: { area } }, encrypt });
    expect(r.status).toBe(422);
    expect(r.body.reason).toBe('unsupported_mowing_area');
    expect(publishRawToDevice).not.toHaveBeenCalled();
    expect(publishToDevice).not.toHaveBeenCalled();
  });

  it.each([
    { map: 'map5' },
    { map: 'map005' }, // Python derives the numeric slot, including leading zeros
    { map: 'map5', area: 0 }, // Python handler treats zero as the fallback
    { map: 'map5', area: '1e0' }, // Number accepts these, Python int falls back to map5
    { map: 'map5', area: '1.0' },
    { map: 'map5', area: '0x1' },
    { map: 'map5', area: ' ' },
    { map: 'map0', area: 100001 }, // mixed selection, supported first target
  ])('rejects unsupported custom scalar selection %j before undocking', async (params) => {
    const r = await request(app).post('/api/dashboard/extended/LFIN_AREA_LIMIT')
      .send({ mow_zone: params });
    expect(r.status).toBe(422);
    expect(publishToTopic).not.toHaveBeenCalled();
  });

  it('preserves literal string-zero semantics instead of deriving a slot', async () => {
    const command = { mow_zone: { map: 'map5', area: '0' } };
    const r = await request(app).post('/api/dashboard/extended/AREA_LIMIT').send(command);
    expect(r.status).toBe(200);
    expect(publishToTopic).toHaveBeenCalledWith('novabot/extended/AREA_LIMIT', command);
  });

  it('preserves all five supported zones in the command and custom routes', async () => {
    const command = { start_navigation: { area: 11111 } };
    const normal = await request(app).post('/api/dashboard/command/AREA_LIMIT').send({ command });
    expect(normal.status).toBe(200);
    expect(publishToDevice).toHaveBeenCalledWith('AREA_LIMIT', command);
    const extendedCommand = { mow_zone: { map: 'map0', area: 11111 } };
    const extended = await request(app).post('/api/dashboard/extended/AREA_LIMIT').send(extendedCommand);
    expect(extended.status).toBe(200);
    expect(publishToTopic).toHaveBeenCalledWith('novabot/extended/AREA_LIMIT', extendedCommand);
  });

  it.each([
    { add_scan_map: { mapName: 'map5', type: 0 } },
    { save_map: { mapName: 'map5', type: 1 } },
    { start_run: { startWay: 1, workArea: [{ latitude: 1, longitude: 1 }, { latitude: 1, longitude: 2 }, { latitude: 2, longitude: 2 }] } },
  ])('leaves mapping and polygon commands unchanged: %j', async (command) => {
    const r = await request(app).post('/api/dashboard/command/AREA_LIMIT').send({ command });
    expect(r.status).toBe(200);
    expect(publishToDevice).toHaveBeenCalledWith('AREA_LIMIT', command);
  });

  it('leaves the custom edge route for later map slots available', async () => {
    const command = { start_edge_cut: { mapName: 'map5', bladeHeight: 40 } };
    const r = await request(app).post('/api/dashboard/extended/AREA_LIMIT').send(command);
    expect(r.status).toBe(200);
    expect(publishToTopic).toHaveBeenCalledWith('novabot/extended/AREA_LIMIT', command);
  });
});

/** Maak een schema dat NU aan de beurt is (echte klok) met vandaag als
 *  rand-dag, en laat de runner het armen. */
function armViaRunner(sn: string): void {
  const now = new Date();
  scheduleRepo.create({
    schedule_id: `sched-${sn}`,
    mower_sn: sn,
    start_time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    weekdays: JSON.stringify([now.getDay()]),
    enabled: 1,
    cutting_height: 50,
    rain_pause: 0,
    edge_days: JSON.stringify([now.getDay()]),
  });
  startScheduleRunner();
  expect(__getPendingEdgeForTest().get(sn)?.scheduleId).toBe(`sched-${sn}`);
}

describe('rand-dag watcher disarm via dashboard-routes', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => stopScheduleRunner());

  it('POST /stop-navigation/:sn ontwapent de watcher', async () => {
    const SN = 'ROUTE_STOPNAV';
    armViaRunner(SN);
    const r = await request(app).post(`/api/dashboard/stop-navigation/${SN}`);
    expect(r.status).toBe(200);
    expect(__getPendingEdgeForTest().has(SN)).toBe(false);
  });

  it('POST /command/:sn met stop_navigation (app-pad) ontwapent de watcher', async () => {
    const SN = 'ROUTE_CMDSTOP';
    armViaRunner(SN);
    const r = await request(app)
      .post(`/api/dashboard/command/${SN}`)
      .send({ command: { stop_navigation: { cmd_num: 1 } } });
    expect(r.status).toBe(200);
    expect(__getPendingEdgeForTest().has(SN)).toBe(false);
  });

  it('POST /command/:sn met een handmatige start_navigation ontwapent ook', async () => {
    const SN = 'ROUTE_CMDSTART';
    armViaRunner(SN);
    await request(app)
      .post(`/api/dashboard/command/${SN}`)
      .send({ command: { start_navigation: { mapName: 'test', cutterhigh: 2, area: 1 } } });
    expect(__getPendingEdgeForTest().has(SN)).toBe(false);
  });

  it('POST /command/:sn met een onschuldig commando laat de watcher staan', async () => {
    const SN = 'ROUTE_CMDOTHER';
    armViaRunner(SN);
    await request(app)
      .post(`/api/dashboard/command/${SN}`)
      .send({ command: { get_para_info: {} } });
    expect(__getPendingEdgeForTest().has(SN)).toBe(true);
    disarmEdgeWatch(SN, 'test-opruiming');
  });

  it('PATCH /schedules met enabled:false ontwapent de watcher van dat schema', async () => {
    const SN = 'ROUTE_DISABLE';
    armViaRunner(SN);
    const r = await request(app)
      .patch(`/api/dashboard/schedules/${SN}/sched-${SN}`)
      .send({ enabled: false });
    expect(r.status).toBe(200);
    expect(__getPendingEdgeForTest().has(SN)).toBe(false);
  });

  it('PATCH /schedules met edgeDays [] ontwapent de watcher van dat schema', async () => {
    const SN = 'ROUTE_CLEARDAYS';
    armViaRunner(SN);
    await request(app)
      .patch(`/api/dashboard/schedules/${SN}/sched-${SN}`)
      .send({ edgeDays: [] });
    expect(__getPendingEdgeForTest().has(SN)).toBe(false);
  });

  it('DELETE /schedules ontwapent de watcher van dat schema', async () => {
    const SN = 'ROUTE_DELETE';
    armViaRunner(SN);
    const r = await request(app).delete(`/api/dashboard/schedules/${SN}/sched-${SN}`);
    expect(r.status).toBe(200);
    expect(__getPendingEdgeForTest().has(SN)).toBe(false);
  });

  // c70d7488: mow_zone is het PRIMAIRE handmatige maaipad van de app en loopt
  // via de extended-route, niet via /command/:sn. Zonder deze disarm adopteert
  // een eerder gearmde schema-watcher de handmatige beurt en randmaait na het
  // dokken de SCHEMA-zone op de SCHEMA-hoogte in plaats van wat de gebruiker
  // net maaide (finding 4, eindreview).
  it('POST /extended/:sn met mow_zone (handmatig app-pad) ontwapent de watcher', async () => {
    const SN = 'ROUTE_EXTMOWZONE';
    armViaRunner(SN);
    const r = await request(app)
      .post(`/api/dashboard/extended/${SN}`)
      .send({ mow_zone: { mapName: 'map1', bladeHeight: 40 } });
    expect(r.status).toBe(200);
    expect(__getPendingEdgeForTest().has(SN)).toBe(false);
  });

  // Tegenhanger: een NIET-bewegingscommando op hetzelfde kanaal mag de watcher
  // niet raken. Over-ontwapenen is even erg als niet ontwapenen: dan verliest
  // elke normale extended-status-call (bv. system_info-polling) stilzwijgend
  // de geplande randmaai.
  it('POST /extended/:sn met een onschuldig commando laat de watcher staan', async () => {
    const SN = 'ROUTE_EXTOTHER';
    armViaRunner(SN);
    const r = await request(app)
      .post(`/api/dashboard/extended/${SN}`)
      .send({ system_info: {} });
    expect(r.status).toBe(200);
    expect(__getPendingEdgeForTest().has(SN)).toBe(true);
    disarmEdgeWatch(SN, 'test-opruiming');
  });
});
