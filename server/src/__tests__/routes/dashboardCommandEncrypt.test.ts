/**
 * Issue #16: when the dashboard `/command/:sn` endpoint receives an
 * explicit `encrypt: false`, the published bytes MUST be raw JSON — not
 * AES-encrypted. Earlier the unencrypted branch routed through
 * publishToDevice(), which has its own LFI auto-encrypt branch, so the
 * opt-out was silently re-encrypted for any LFI* SN.
 *
 * These tests pin the contract:
 *   - default (no encrypt flag) on LFI SN → encrypted bytes
 *   - encrypt: false on LFI SN → raw JSON bytes
 *   - encrypt: false on non-LFI SN → raw JSON bytes
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

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
}));

import { dashboardRouter } from '../../routes/dashboard.js';
import * as mapSync from '../../mqtt/mapSync.js';

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

const LFI_SN = 'LFIN2230700238';
const PLAIN_SN = 'TESTSN1234';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/dashboard/command/:sn — encryption opt-out (#16)', () => {
  it('LFI SN with no encrypt flag → AES bytes via publishRawToDevice', async () => {
    const r = await request(server)
      .post(`/api/dashboard/command/${LFI_SN}`)
      .send({ command: { pause_navigation: { cmd_num: 42 } } });

    expect(r.status).toBe(200);
    expect(r.body.encrypted).toBe(true);
    expect(mapSync.publishRawToDevice).toHaveBeenCalledTimes(1);
    expect(mapSync.publishToDevice).not.toHaveBeenCalled();

    const [, payload] = vi.mocked(mapSync.publishRawToDevice).mock.calls[0];
    // Encrypted output never contains the readable JSON keys.
    expect(payload.toString('utf8')).not.toContain('pause_navigation');
    // 16-byte AES blocks ⇒ length is a multiple of 16.
    expect(payload.length % 16).toBe(0);
  });

  it('LFI SN with encrypt:false → raw JSON bytes (regression #16)', async () => {
    const r = await request(server)
      .post(`/api/dashboard/command/${LFI_SN}`)
      .send({ encrypt: false, command: { pause_navigation: { cmd_num: 42 } } });

    expect(r.status).toBe(200);
    expect(r.body.encrypted).toBe(false);
    expect(mapSync.publishRawToDevice).toHaveBeenCalledTimes(1);
    expect(mapSync.publishToDevice).not.toHaveBeenCalled();

    const [, payload] = vi.mocked(mapSync.publishRawToDevice).mock.calls[0];
    const text = payload.toString('utf8');
    expect(text).toContain('pause_navigation');
    expect(text).toContain('cmd_num');
    expect(text).toBe(JSON.stringify({ pause_navigation: { cmd_num: 42 } }));
  });

  it('non-LFI SN defaults to raw JSON', async () => {
    const r = await request(server)
      .post(`/api/dashboard/command/${PLAIN_SN}`)
      .send({ command: { pause_navigation: { cmd_num: 7 } } });

    expect(r.status).toBe(200);
    expect(r.body.encrypted).toBeUndefined();
    expect(mapSync.publishToDevice).toHaveBeenCalledTimes(1);
    expect(mapSync.publishRawToDevice).not.toHaveBeenCalled();
  });
});
