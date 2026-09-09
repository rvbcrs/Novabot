/**
 * Automatic re-anchor flow (Novabot-cq3).
 *
 * POST /api/dashboard/reanchor/:sn action:'auto' is the wizard's one-button
 * path. It must gate hard on the preconditions before it touches the mower:
 *   - frame must actually be unvalidated (else 409, nothing to do)
 *   - mower must be on the dock (charging)
 *   - mower must be on a real RTK Fixed
 *
 * action:'verify' is the manual backup: after the operator joysticks the mower
 * back onto the dock, it re-checks the docked map_position against the origin
 * and only clears frame_unvalidated when it lands within tolerance. It never
 * moves the mower. It is gated on the lifecycle: the mower must have left the
 * dock, re-locked (RUNNING + RTK Fixed) against the new origin, AND be back on
 * the dock — verifying before the relock tests a stale frame, verifying off-dock
 * checks the wrong place. battery FULL alone is NOT "on the dock" (it lingers
 * after undocking), so it cannot satisfy the auto-start or verify dock gate.
 *
 * GET /reanchor/:sn/status exposes the progress the wizard polls plus the live
 * gating booleans (onDock / rtkFixed / relocked).
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
}));

import { dashboardRouter } from '../../routes/dashboard.js';
import { markFrameUnvalidated, clearFrameUnvalidated, isFrameUnvalidated, setReanchorRelocked } from '../../services/frameValidation.js';
import { deviceCache } from '../../mqtt/sensorData.js';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

const SN = 'LFIN2230700238';

function setCache(fields: Record<string, string>): void {
  deviceCache.set(SN, new Map(Object.entries(fields)));
}

const DOCKED_FIXED = {
  battery_state: 'CHARGING',
  // deviceCache holds the RAW relay value: GGA quality code 4 = RTK Fixed (NOT
  // the display label). The gate must translate before comparing — regression
  // for the always-409 bug where it compared '4' === 'RTK Fixed'.
  rtk_fix_quality: '4',
  latitude: '52.1234567', // live RTK position is cached under 'latitude'/'longitude'
  longitude: '4.7654321',
  map_position_x: '0.05',
  map_position_y: '0.10',
  localization_state: 'RUNNING',
};

beforeEach(() => {
  vi.clearAllMocks();
  clearFrameUnvalidated(SN);
  deviceCache.clear();
});

describe('POST /reanchor/:sn action:auto — precondition gates', () => {
  it('409 when the frame is already validated (nothing to re-anchor)', async () => {
    setCache(DOCKED_FIXED);
    const r = await request(app).post(`/api/dashboard/reanchor/${SN}`).send({ action: 'auto' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already validated/i);
  });

  it('409 when the mower is not on the dock', async () => {
    markFrameUnvalidated(SN);
    setCache({ ...DOCKED_FIXED, battery_state: 'NORMAL', recharge_status: '0' });
    const r = await request(app).post(`/api/dashboard/reanchor/${SN}`).send({ action: 'auto' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/on the dock/i);
  });

  it('409 when only the battery reads FULL (lingers after undocking — not on the dock)', async () => {
    // Regression: a full battery keeps reporting FULL for a while after the mower
    // drives off the dock. It must NOT count as docked, or auto would rewrite
    // pos.json off the dock (and verify would check the wrong place).
    markFrameUnvalidated(SN);
    setCache({ ...DOCKED_FIXED, battery_state: 'FULL', recharge_status: '0' });
    const r = await request(app).post(`/api/dashboard/reanchor/${SN}`).send({ action: 'auto' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/on the dock/i);
  });

  it('409 when on the dock but not RTK Fixed (raw code 5 = Float)', async () => {
    markFrameUnvalidated(SN);
    setCache({ ...DOCKED_FIXED, rtk_fix_quality: '5' }); // 5 = RTK Float
    const r = await request(app).post(`/api/dashboard/reanchor/${SN}`).send({ action: 'auto' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Fixed/i);
  });

  it('accepts the translated label too (RTK Fixed string passthrough)', async () => {
    vi.useFakeTimers();
    try {
      markFrameUnvalidated(SN);
      setCache({ ...DOCKED_FIXED, rtk_fix_quality: 'RTK Fixed' });
      const r = await request(app).post(`/api/dashboard/reanchor/${SN}`).send({ action: 'auto' });
      expect(r.status).toBe(200);
      await vi.advanceTimersByTimeAsync(50);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('200 + starts when on the dock and RTK Fixed; status goes to check', async () => {
    // Fake timers so the fire-and-forget runAutoReanchor (which schedules a 15s
    // extended-response timeout) cannot leave a real timer dangling into later
    // test files — clearAllTimers() in finally guarantees a clean exit.
    vi.useFakeTimers();
    try {
      markFrameUnvalidated(SN);
      setCache(DOCKED_FIXED);
      const r = await request(app).post(`/api/dashboard/reanchor/${SN}`).send({ action: 'auto' });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.action).toBe('auto');

      await vi.advanceTimersByTimeAsync(50); // let the async flow start
      const s = await request(app).get(`/api/dashboard/reanchor/${SN}/status`);
      expect(s.status).toBe(200);
      expect(['check', 'anchor', 'error']).toContain(s.body.status.phase);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('falls back to the rtk bool when no quality string is published', async () => {
    vi.useFakeTimers();
    try {
      markFrameUnvalidated(SN);
      setCache({ battery_state: 'CHARGING', rtk: 'true', latitude: '52.1', longitude: '4.7', map_position_x: '0', map_position_y: '0' });
      const r = await request(app).post(`/api/dashboard/reanchor/${SN}`).send({ action: 'auto' });
      expect(r.status).toBe(200);
      await vi.advanceTimersByTimeAsync(50);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('POST /reanchor/:sn action:verify — manual backup (lifecycle-gated)', () => {
  it('clears frame_unvalidated when relocked and docked on the origin (within tolerance)', async () => {
    vi.useFakeTimers();
    try {
      markFrameUnvalidated(SN);
      setReanchorRelocked(SN, true); // mower left the dock, re-locked, now re-docked
      setCache({ ...DOCKED_FIXED, map_position_x: '0.08', map_position_y: '-0.12' });
      const r = await request(app).post(`/api/dashboard/reanchor/${SN}`).send({ action: 'verify' });
      expect(r.status).toBe(200);
      await vi.advanceTimersByTimeAsync(3500); // past the settle delay
      expect(isFrameUnvalidated(SN)).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    const s = await request(app).get(`/api/dashboard/reanchor/${SN}/status`);
    expect(s.body.status.phase).toBe('done');
    expect(s.body.status.ok).toBe(true);
  });

  it('keeps frame_unvalidated when relocked + docked but the position is outside tolerance', async () => {
    vi.useFakeTimers();
    try {
      markFrameUnvalidated(SN);
      setReanchorRelocked(SN, true);
      setCache({ ...DOCKED_FIXED, map_position_x: '2.12', map_position_y: '0.63' });
      const r = await request(app).post(`/api/dashboard/reanchor/${SN}`).send({ action: 'verify' });
      expect(r.status).toBe(200);
      await vi.advanceTimersByTimeAsync(3500);
      expect(isFrameUnvalidated(SN)).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    const s = await request(app).get(`/api/dashboard/reanchor/${SN}/status`);
    expect(s.body.status.phase).toBe('error');
    expect(s.body.status.error).toBe('verify_failed');
  });

  it('verifies against the DOCK ANCHOR, not (0,0) — known-good LFIN1231000211 frame', async () => {
    // reanchor_pos subtracts the anchor from the origin, so a correctly anchored
    // mower docks ON the anchor. The old verify measured hypot(pose) against
    // (0,0) and rejected every frame whose anchor is >0.4m out — including the
    // known-good .100 (anchor (0.13,-0.52), docked (0.09,-0.51) = 4cm off the
    // anchor but 0.52m from origin).
    const ASN = 'LFINANCHORVERIFY';
    const { mapRepo } = await import('../../db/repositories/maps.js');
    mapRepo.create({
      map_id: 'test_anchor_unicom',
      mower_sn: ASN,
      map_name: 'map0tocharge_unicom',
      canonical_name: 'map0tocharge_unicom',
      map_type: 'unicom',
      map_area: JSON.stringify([{ x: 0.13, y: -0.52 }, { x: 0.1, y: -0.3 }]),
    });
    vi.useFakeTimers();
    try {
      markFrameUnvalidated(ASN);
      setReanchorRelocked(ASN, true);
      deviceCache.set(ASN, new Map(Object.entries({
        ...DOCKED_FIXED, map_position_x: '0.09', map_position_y: '-0.51',
      })));
      const r = await request(app).post(`/api/dashboard/reanchor/${ASN}`).send({ action: 'verify' });
      expect(r.status).toBe(200);
      await vi.advanceTimersByTimeAsync(3500);
      expect(isFrameUnvalidated(ASN)).toBe(false); // 4cm from anchor → valid
    } finally {
      vi.useRealTimers();
      mapRepo.deleteById('test_anchor_unicom');
    }
  });

  it('409 when verify is requested but the mower never re-locked (cycle incomplete)', async () => {
    markFrameUnvalidated(SN); // resets the relock latch to false
    setCache(DOCKED_FIXED); // on the dock + Fixed, but no off-dock relock happened
    const r = await request(app).post(`/api/dashboard/reanchor/${SN}`).send({ action: 'verify' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/re-anchor cycle|left the dock|RUNNING/i);
    expect(isFrameUnvalidated(SN)).toBe(true); // not cleared
  });

  it('409 when verify is requested off the dock, even after a relock', async () => {
    markFrameUnvalidated(SN);
    setReanchorRelocked(SN, true);
    setCache({ ...DOCKED_FIXED, battery_state: 'NORMAL', recharge_status: '0' });
    const r = await request(app).post(`/api/dashboard/reanchor/${SN}`).send({ action: 'verify' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/on the dock/i);
    expect(isFrameUnvalidated(SN)).toBe(true);
  });

  it('409 verify off the dock even when only the battery reads FULL', async () => {
    markFrameUnvalidated(SN);
    setReanchorRelocked(SN, true);
    setCache({ ...DOCKED_FIXED, battery_state: 'FULL', recharge_status: '0' });
    const r = await request(app).post(`/api/dashboard/reanchor/${SN}`).send({ action: 'verify' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/on the dock/i);
  });
});

describe('GET /reanchor/:sn/status', () => {
  it('returns an idle status for an unknown SN', async () => {
    const s = await request(app).get('/api/dashboard/reanchor/UNKNOWNSN/status');
    expect(s.status).toBe(200);
    expect(s.body.status.phase).toBe('idle');
  });

  it('augments the status with live onDock / rtkFixed / relocked gating booleans', async () => {
    markFrameUnvalidated(SN);
    setReanchorRelocked(SN, true);
    setCache(DOCKED_FIXED);
    const s = await request(app).get(`/api/dashboard/reanchor/${SN}/status`);
    expect(s.body.status.onDock).toBe(true);
    expect(s.body.status.rtkFixed).toBe(true);
    expect(s.body.status.relocked).toBe(true);
  });

  it('reports onDock=false when only the battery is FULL (off the dock)', async () => {
    setCache({ ...DOCKED_FIXED, battery_state: 'FULL', recharge_status: '0' });
    const s = await request(app).get(`/api/dashboard/reanchor/${SN}/status`);
    expect(s.body.status.onDock).toBe(false);
  });
});
