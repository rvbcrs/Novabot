/**
 * Route test — GET /api/dashboard/system/lora-status/:sn
 *
 * Mounts the dashboardRouter in a minimal Express app and verifies:
 *  - 404 when no LoRa cache row exists for the SN
 *  - 200 with correct pair shape + drift:false when only own cache exists (no peer)
 *  - 200 with drift:false when own + peer have identical address+channel
 *  - 200 with drift:true when own + peer have mismatched address or channel
 *
 * Same vi.mock bootstrap as dashboardSystemHealth.test.ts — copy verbatim.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mock heavy deps BEFORE any import of dashboard.ts ───────────
vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(false),
  writeRawPublish: vi.fn().mockReturnValue(false),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
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

vi.mock('../../services/mowerIpDiscovery.js', () => ({
  resolveMowerIp: vi.fn().mockResolvedValue(null),
  startMowerIpDiscovery: vi.fn(),
}));

// ── Now import dashboard.ts (after mocks are in place) ───────────
import { dashboardRouter } from '../../routes/dashboard.js';
import { equipmentRepo } from '../../db/repositories/index.js';

// Minimal Express wrapper — mirrors how index.ts mounts the router
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

describe('GET /api/dashboard/system/lora-status/:sn', () => {
  beforeEach(() => {
    // Clean up any LoRa cache rows and equipment rows inserted by tests
    equipmentRepo.deleteLoraCache('LFIN_NOPE');
    equipmentRepo.deleteLoraCache('LFIN_TEST_M');
    equipmentRepo.deleteLoraCache('LFIC_TEST_C');
    equipmentRepo.deleteLoraCache('LFIN_DRIFT_M');
    equipmentRepo.deleteLoraCache('LFIC_DRIFT_C');
  });

  it('404 when no lora cache row exists for given SN', async () => {
    const res = await request(server).get('/api/dashboard/system/lora-status/LFIN_NOPE');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'no_lora_cache' });
  });

  it('returns pair shape and drift:false when own cache exists but no peer in equipment table', async () => {
    equipmentRepo.setLoraCache('LFIN_TEST_M', '0xABCD', '15');

    const res = await request(server).get('/api/dashboard/system/lora-status/LFIN_TEST_M');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sn: 'LFIN_TEST_M',
      pair: { address: '0xABCD', channel: '15' },
      peer: { sn: null, address: null, channel: null },
      drift: false,
    });
  });

  it('returns drift:false when own and peer have identical address+channel', async () => {
    // Insert an equipment row pairing the mower and charger
    equipmentRepo.create({
      mower_sn: 'LFIN_TEST_M',
      charger_sn: 'LFIC_TEST_C',
      equipment_id: 'EQ_NODRIFT',
      user_id: null,
    });
    // Both on same LoRa pair
    equipmentRepo.setLoraCache('LFIN_TEST_M', '0xABCD', '15');
    equipmentRepo.setLoraCache('LFIC_TEST_C', '0xABCD', '15');

    const res = await request(server).get('/api/dashboard/system/lora-status/LFIN_TEST_M');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sn: 'LFIN_TEST_M',
      pair: { address: '0xABCD', channel: '15' },
      peer: { sn: 'LFIC_TEST_C', address: '0xABCD', channel: '15' },
      drift: false,
    });
  });

  it('returns drift:true when mower and charger have mismatched LoRa address', async () => {
    equipmentRepo.create({
      mower_sn: 'LFIN_DRIFT_M',
      charger_sn: 'LFIC_DRIFT_C',
      equipment_id: 'EQ_DRIFT_ADDR',
      user_id: null,
    });
    equipmentRepo.setLoraCache('LFIN_DRIFT_M', '0x1111', '15');
    equipmentRepo.setLoraCache('LFIC_DRIFT_C', '0x2222', '15'); // different address

    const res = await request(server).get('/api/dashboard/system/lora-status/LFIN_DRIFT_M');
    expect(res.status).toBe(200);
    expect(res.body.drift).toBe(true);
  });

  it('returns drift:true when mower and charger have mismatched LoRa channel', async () => {
    equipmentRepo.create({
      mower_sn: 'LFIN_DRIFT_M',
      charger_sn: 'LFIC_DRIFT_C',
      equipment_id: 'EQ_DRIFT_CH',
      user_id: null,
    });
    equipmentRepo.setLoraCache('LFIN_DRIFT_M', '0xABCD', '15');
    equipmentRepo.setLoraCache('LFIC_DRIFT_C', '0xABCD', '16'); // different channel

    const res = await request(server).get('/api/dashboard/system/lora-status/LFIN_DRIFT_M');
    expect(res.status).toBe(200);
    expect(res.body.drift).toBe(true);
  });
});
