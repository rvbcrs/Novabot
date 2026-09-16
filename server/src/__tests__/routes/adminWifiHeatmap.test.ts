import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { db } from '../../db/database.js';

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
  applyVerbatimToMower: vi.fn(),
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

vi.mock('../../services/mdnsAdvertiser.js', () => ({
  startMdnsAdvertiser: vi.fn(),
  stopMdnsAdvertiser: vi.fn(),
  getActiveAdvertisement: vi.fn().mockReturnValue(null),
}));

vi.mock('../../services/mapBackup.js', () => ({
  listBackups: vi.fn().mockReturnValue([]),
  backupPath: vi.fn().mockReturnValue('/fake/backup.zip'),
  scheduleSnapshot: vi.fn(),
  regenerateLatestZipFromBackup: vi.fn().mockReturnValue('/fake/_latest.zip'),
}));

vi.mock('../../services/anchor.js', () => ({
  getPolygonAnchor: vi.fn().mockReturnValue(null),
}));

vi.mock('../../mqtt/sensorData.js', () => ({
  deviceCache: new Map<string, Map<string, string>>(),
  getValidationTrail: vi.fn().mockReturnValue([]),
  clearValidationTrail: vi.fn(),
  getLocalTrail: vi.fn().mockReturnValue([]),
}));

vi.mock('../../mqtt/mapConverter.js', () => ({
  generateMapZipFromDb: vi.fn(),
  gpsToLocal: vi.fn(),
  localToGps: vi.fn(),
  parseMapZip: vi.fn(),
  polygonArea: vi.fn().mockReturnValue(10),
  metersPerDegLat: vi.fn().mockReturnValue(111000),
  metersPerDegLng: vi.fn().mockReturnValue(68000),
}));

import { adminStatusRouter } from '../../routes/adminStatus.js';

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

describe('GET /api/admin-status/wifi-heatmap/:sn', () => {
  it('returns positioned WiFi samples with normalized weights', async () => {
    const sn = 'LFIN_HEATMAP_ROUTE';
    db.prepare(`
      INSERT INTO signal_history (sn, wifi_rssi, battery, loc_quality, map_x, map_y, latitude, longitude, ts)
      VALUES
        (?, 100, 90, 100, 0, 0, 52.1, 6.1, datetime('now', '-5 minutes')),
        (?, 30, 70, 80, 5, 2, 52.2, 6.2, datetime('now', '-4 minutes')),
        (?, 83, 65, 100, NULL, 4, 52.3, 6.3, datetime('now', '-3 minutes'))
    `).run(sn, sn, sn);

    const res = await request(server).get(`/api/admin-status/wifi-heatmap/${sn}?hours=1`);

    expect(res.status).toBe(200);
    expect(res.body.sn).toBe(sn);
    expect(res.body.hours).toBe(1);
    expect(res.body.points).toEqual([
      expect.objectContaining({ wifiRssi: 100, mapX: 0, mapY: 0, weight: 1 }),
      expect.objectContaining({ wifiRssi: 30, mapX: 5, mapY: 2, weight: 0.3 }),
    ]);
  });
});
