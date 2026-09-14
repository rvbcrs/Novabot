/**
 * Route test — POST /api/admin-status/mdns-restart
 *
 * Mounts the adminStatusRouter in a minimal Express app and verifies that:
 * 1. stopMdnsAdvertiser and startMdnsAdvertiser are called in order
 * 2. Response includes restartedAt timestamp and advertisement details
 * 3. Errors from startMdnsAdvertiser result in 500 response
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
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

// ── Now import the router ───────────
import { adminStatusRouter } from '../../routes/adminStatus.js';
import * as mdns from '../../services/mdnsAdvertiser.js';

// Get references to mocked functions via vi.mocked
const mockStart = vi.mocked(mdns.startMdnsAdvertiser);
const mockStop = vi.mocked(mdns.stopMdnsAdvertiser);
const mockGetActive = vi.mocked(mdns.getActiveAdvertisement);

// Minimal Express wrapper (no auth middleware — router mounts directly)
const app = express();
app.use(express.json());
app.use('/api/admin-status', adminStatusRouter);

// Eén luisteraar voor dit hele bestand. `request(server)` laat supertest per
// verzoek een NIEUWE efemere poort openen, en dat botst onder belasting met een
// andere luisteraar: het antwoord komt dan ergens anders vandaan. Bewezen op
// 2026-09-14, een 403 op /reanchor zonder x-powered-by en zonder serverkant-
// regel in de trace, wat drie beta-builds heeft gekost.
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

describe('POST /api/admin-status/mdns-restart', () => {
  beforeEach(() => {
    mockStop.mockClear();
    mockStart.mockClear();
    mockGetActive.mockClear();
    mockGetActive.mockReturnValue({
      ip: '192.168.0.177',
      hostnames: ['opennova.local', 'opennovabot.local'],
      ttl: 120,
      port: 5353,
      httpPort: 8080,
      srvName: '_opennova-http._tcp.local',
    });
  });

  it('calls stop then start, returns advertisement and timestamp', async () => {
    const res = await request(server).post('/api/admin-status/mdns-restart');

    // Check response
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.restartedAt).toBe('string');
    expect(new Date(res.body.restartedAt).getTime()).toBeGreaterThan(0);
    expect(res.body.advertisement).toEqual({
      ip: '192.168.0.177',
      hostnames: ['opennova.local', 'opennovabot.local'],
      ttl: 120,
      port: 5353,
      httpPort: 8080,
      srvName: '_opennova-http._tcp.local',
    });

    // Check that mocks were called
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockGetActive).toHaveBeenCalledTimes(1);

    // Check that stop was called before start
    const stopOrder = mockStop.mock.invocationCallOrder[0];
    const startOrder = mockStart.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(startOrder);
  });

  it('returns 500 if start throws', async () => {
    mockStart.mockImplementationOnce(() => {
      throw new Error('mDNS port in use');
    });

    const res = await request(server).post('/api/admin-status/mdns-restart');

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('mDNS port in use');

    // stop should still be called even if start fails
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('returns 500 if stop throws', async () => {
    mockStop.mockImplementationOnce(() => {
      throw new Error('socket cleanup failed');
    });

    const res = await request(server).post('/api/admin-status/mdns-restart');

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('socket cleanup failed');
  });
});
