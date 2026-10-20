/**
 * Route test — GET /api/admin-status/dns-check
 *
 * The check resolves *.lfibot.com inside the server, which says nothing about
 * what the mower gets from the router: a user had a green check and "0 / 0
 * online" for 30 hours (Facebook, Oct 2026). So it also reports how many
 * mowers and chargers are connected, for the panel to give a next step.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import dns from 'dns';

// ── Mock mDNS advertiser before import ───────────
vi.mock('../../services/mdnsAdvertiser.js', () => ({
  startMdnsAdvertiser: vi.fn(),
  stopMdnsAdvertiser: vi.fn(),
  getActiveAdvertisement: vi.fn().mockReturnValue({
    ip: '192.168.0.177',
    hostnames: ['opennova.local', 'opennovabot.local'],
    ttl: 120,
    port: 5353,
  }),
}));

// ── Mock broker deps (same pattern as dashboardSystemHealth.test.ts) ───────────
vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(false),
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
  awaitCommand: vi.fn(),
}));

vi.mock('../../mqtt/mapConverter.js', () => ({
  generateMapZipFromDb: vi.fn(),
  gpsToLocal: vi.fn(),
  localToGps: vi.fn(),
  parseMapZip: vi.fn(),
  polygonArea: vi.fn(),
}));

vi.mock('../../services/demoSimulator.js', () => ({
  isDemoMode: vi.fn().mockReturnValue(false),
  setDemoMode: vi.fn(),
  getDemoStatus: vi.fn().mockReturnValue({}),
  setDemoInterceptor: vi.fn(),
}));

vi.mock('../../services/mowerIpDiscovery.js', () => ({
  resolveMowerIp: vi.fn().mockResolvedValue(null),
  startMowerIpDiscovery: vi.fn(),
}));

// ── Now import the router ───────────
import { adminStatusRouter } from '../../routes/adminStatus.js';
import * as broker from '../../mqtt/broker.js';
import { deviceRepo } from '../../db/repositories/index.js';
import { db } from '../../db/database.js';

const app = express();
app.use(express.json());
app.use('/api/admin-status', adminStatusRouter);
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

const SNS = ['LFIN0000000901', 'LFIC0000000901'];

describe('GET /api/admin-status/dns-check', () => {
  beforeEach(() => {
    for (const sn of SNS) db.prepare('DELETE FROM device_registry WHERE sn = ?').run(sn);
    vi.spyOn(dns, 'resolve4').mockImplementation(((_host: string, cb: (err: null, a: string[]) => void) =>
      cb(null, ['192.168.0.109'])) as unknown as typeof dns.resolve4);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(broker.isDeviceOnline).mockReturnValue(false);
  });

  it('reports no connected device when nothing ever connected', async () => {
    const res = await request(server).get('/api/admin-status/dns-check');

    expect(res.status).toBe(200);
    expect(res.body.domains.every((d: { ok: boolean }) => d.ok)).toBe(true);
    expect(res.body.devicesOnline).toBe(0);
  });

  it('counts the mowers and chargers that are connected now, not the ones it once saw', async () => {
    deviceRepo.upsertDevice('LFIN0000000901_6688', SNS[0], null);
    deviceRepo.upsertDevice('ESP32_test01', SNS[1], null);
    vi.mocked(broker.isDeviceOnline).mockImplementation(sn => sn === SNS[0]);

    const res = await request(server).get('/api/admin-status/dns-check');

    expect(res.body.devicesOnline).toBe(1);
  });
});
