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

import { dashboardRouter } from '../../routes/dashboard.js';
import {
  startScheduleRunner, stopScheduleRunner, __getPendingEdgeForTest, disarmEdgeWatch,
} from '../../services/scheduleRunner.js';
import { scheduleRepo } from '../../db/repositories/index.js';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

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
