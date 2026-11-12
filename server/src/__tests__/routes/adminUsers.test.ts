/**
 * Route test — local user management under /api/admin-status (GH #164).
 *
 * The dashboard gets a Users section: an admin adds a local account, sets its
 * roles, resets its password or deletes it. The list never carries the
 * password hash or the machine token, and the last admin keeps the role.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';

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
import bcrypt from 'bcrypt';
import { adminStatusRouter } from '../../routes/adminStatus.js';
import { userRepo } from '../../db/repositories/index.js';
import { db } from '../../db/database.js';

const ME = 'ADMIN-ME';
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as unknown as { userId: string }).userId = ME; next(); });
app.use('/api/admin-status', adminStatusRouter);
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

describe('local user management (GH #164)', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM users').run();
    userRepo.create(ME, 'me@example.test', bcrypt.hashSync('secret1', 4), '', true);
  });

  it('creates a local account with its roles', async () => {
    const r = await request(server).post('/api/admin-status/create-user')
      .send({ email: '  Partner@Example.TEST ', password: 'secret2', dashboardAccess: true });
    expect(r.status).toBe(200);
    const u = userRepo.findByEmail('partner@example.test')!;
    expect(u.app_user_id).toBe(r.body.userId);
    expect(u.is_admin).toBe(0);
    expect(u.dashboard_access).toBe(1);
    expect(bcrypt.compareSync('secret2', u.password)).toBe(true);
  });

  it('refuses a bad email, a short password and an existing email', async () => {
    expect((await request(server).post('/api/admin-status/create-user').send({ email: 'nope', password: 'secret2' })).status).toBe(400);
    expect((await request(server).post('/api/admin-status/create-user').send({ email: 'a@b.c', password: '123' })).status).toBe(400);
    expect((await request(server).post('/api/admin-status/create-user').send({ email: 'ME@example.test', password: 'secret2' })).status).toBe(409);
  });

  it('lists users without the password hash or the machine token', async () => {
    const r = await request(server).get('/api/admin-status/users');
    expect(r.status).toBe(200);
    expect(r.body.users[0].email).toBe('me@example.test');
    expect(r.body.users[0]).not.toHaveProperty('password');
    expect(r.body.users[0]).not.toHaveProperty('machine_token');
  });

  it('keeps the last admin an admin, but lets one of two step down', async () => {
    const last = await request(server).post('/api/admin-status/set-role').send({ userId: ME, role: 'is_admin', enabled: false });
    expect(last.status).toBe(400);
    expect(userRepo.isAdmin(ME)).toBe(true);
    userRepo.create('ADMIN-2', 'two@example.test', 'x', '', true);
    const second = await request(server).post('/api/admin-status/set-role').send({ userId: ME, role: 'is_admin', enabled: false });
    expect(second.status).toBe(200);
    expect(userRepo.isAdmin(ME)).toBe(false);
  });
});
