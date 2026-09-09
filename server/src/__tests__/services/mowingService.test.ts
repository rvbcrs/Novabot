import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock isDeviceOnline + publishToDevice so we can hit startMowing
// without an actual aedes broker. mowingService now delegates to
// publishToDevice (which handles AES vs plain JSON internally based
// on firmware version), so the test asserts on that call instead of
// the lower-level publishRawToDevice.
vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn(() => true),
}));
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToDevice: vi.fn(),
}));

import { isMowerBusy, startMowing, cuttingHeightToWire } from '../../services/mowingService.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { publishToDevice } from '../../mqtt/mapSync.js';
import { deviceSettingsRepo } from '../../db/repositories/deviceSettings.js';

const sn = 'LFIN1234567890';

function setSensors(values: Record<string, string>) {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(values)) map.set(k, v);
  deviceCache.set(sn, map);
}

describe('isMowerBusy', () => {
  beforeEach(() => {
    deviceCache.delete(sn);
    vi.clearAllMocks();
  });

  it('returns false when no cache exists', () => {
    expect(isMowerBusy(sn)).toBe(false);
  });

  it('returns false for idle work_status (0)', () => {
    setSensors({ work_status: '0', msg: 'Mode:COVERAGE Work:WAIT Recharge: WAIT' });
    expect(isMowerBusy(sn)).toBe(false);
  });

  it('returns false on dock (work_status 9)', () => {
    setSensors({ work_status: '9', msg: 'Mode:DOCK Work:WAIT Recharge: FINISHED' });
    expect(isMowerBusy(sn)).toBe(false);
  });

  it('returns false for cancelled/done (work_status 2)', () => {
    setSensors({ work_status: '2', msg: 'Mode:COVERAGE Work:CANCELLED Recharge: WAIT' });
    expect(isMowerBusy(sn)).toBe(false);
  });

  it('returns true when the msg shows an active state, even for a terminal work_status', () => {
    setSensors({ work_status: '1', msg: 'Mode:COVERAGE Work:MOVING Recharge: WAIT' });
    expect(isMowerBusy(sn)).toBe(true);
  });

  // Regression: a mow that aborted parks the mower at work_status=1 (FAILED).
  // The old guard ({0,2,9} only) wrongly treated that as "busy", so EVERY
  // scheduled startMowing was rejected for days while manual starts (which skip
  // this guard) still worked. FAILED + a non-active msg must be NOT busy.
  it('returns false for a parked FAILED mower (work_status 1, no active msg)', () => {
    setSensors({ work_status: '1', msg: 'Mode:COVERAGE Work:FAILED Prev work:QUIT_PILE_INIT Recharge: FINISHED' });
    expect(isMowerBusy(sn)).toBe(false);
  });

  it('returns false for terminal stop codes (ERROR_STOP 13)', () => {
    setSensors({ work_status: '13', msg: 'Mode:COVERAGE Work:ERROR_STOP Recharge: FINISHED' });
    expect(isMowerBusy(sn)).toBe(false);
  });

  it('returns true while covering (work_status 92)', () => {
    setSensors({ work_status: '92', msg: 'Mode:COVERAGE Work:COVERING Recharge: WAIT' });
    expect(isMowerBusy(sn)).toBe(true);
  });

  it('returns true when msg shows REQUEST_START even if work_status missing', () => {
    setSensors({ work_status: '', msg: 'Mode:COVERAGE Work:REQUEST_START Recharge: CANCELLED' });
    expect(isMowerBusy(sn)).toBe(true);
  });

  it('returns true while mapping', () => {
    setSensors({ work_status: '5', msg: 'Mode:MAPPING Work:USER_MAP_BUILD' });
    expect(isMowerBusy(sn)).toBe(true);
  });
});

describe('cuttingHeightToWire', () => {
  // Regression: a 9 cm schedule made in the app stored cutting_height=9 (cm),
  // which the old heuristic mis-read as a "cm+2 wire value" and mowed at 7 cm.
  it('treats app user-cm (2..9) as cm', () => {
    expect(cuttingHeightToWire(9)).toBe(7); // 9cm  (was wrongly 5 = 7cm)
    expect(cuttingHeightToWire(5)).toBe(3); // 5cm
    expect(cuttingHeightToWire(2)).toBe(0); // 2cm
  });
  it('keeps low cm distinct (old heuristic collapsed 3cm AND 4cm to 2cm)', () => {
    expect(cuttingHeightToWire(2)).toBe(0); // 2cm
    expect(cuttingHeightToWire(3)).toBe(1); // 3cm  (old code gave 0 = 2cm)
    expect(cuttingHeightToWire(4)).toBe(2); // 4cm  (old code gave 0 = 2cm)
  });
  it('treats dashboard mm (20..90) as mm', () => {
    expect(cuttingHeightToWire(90)).toBe(7); // 90mm = 9cm
    expect(cuttingHeightToWire(50)).toBe(3); // 50mm = 5cm
    expect(cuttingHeightToWire(20)).toBe(0); // 20mm = 2cm
  });
  it('app 9cm and dashboard 90mm produce the same wire value', () => {
    expect(cuttingHeightToWire(9)).toBe(cuttingHeightToWire(90));
  });
  it('clamps out-of-range inputs to 2..9 cm', () => {
    expect(cuttingHeightToWire(1)).toBe(0);   // below min → 2cm
    expect(cuttingHeightToWire(99)).toBe(7);  // 99mm ≈ 10cm → clamp 9cm
  });
});

describe('startMowing busy guard', () => {
  beforeEach(() => {
    deviceCache.delete(sn);
    vi.clearAllMocks();
  });

  it.each([100000, 100001, 1111111111, 255, -1, NaN, 1.5])('rejects unsupported area %s before publishing (#114)', (area) => {
    const result = startMowing({ sn, area });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/area code/);
    expect(publishToDevice).not.toHaveBeenCalled();
  });

  it('preserves the full supported multi-zone selection', () => {
    expect(startMowing({ sn, area: 11111 }).ok).toBe(true);
    expect(publishToDevice).toHaveBeenCalledWith(sn, {
      start_navigation: expect.objectContaining({ area: 11111 }),
    });
  });

  it('rejects when mower is already mowing', () => {
    setSensors({ work_status: '92', msg: 'Mode:COVERAGE Work:COVERING' });
    const result = startMowing({ sn });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/busy/i);
    expect(publishToDevice).not.toHaveBeenCalled();
  });

  it('publishes when mower is idle', () => {
    setSensors({ work_status: '9', msg: 'Mode:DOCK Work:WAIT' });
    const result = startMowing({ sn });
    expect(result.ok).toBe(true);
    expect(publishToDevice).toHaveBeenCalledOnce();
  });

  it('publishes when no cache exists yet (first start after boot)', () => {
    const result = startMowing({ sn });
    expect(result.ok).toBe(true);
    expect(publishToDevice).toHaveBeenCalledOnce();
  });

  it('sends cutterhigh 7 for a 9cm app schedule (regression: was 5 = 7cm)', () => {
    setSensors({ work_status: '9', msg: 'Mode:DOCK Work:WAIT' });
    startMowing({ sn, cuttingHeight: 9 });
    expect(vi.mocked(publishToDevice).mock.calls[0][1]).toMatchObject({
      start_navigation: { cutterhigh: 7 },
    });
  });

  it('sends cutterhigh 7 for a 90mm dashboard schedule', () => {
    setSensors({ work_status: '9', msg: 'Mode:DOCK Work:WAIT' });
    startMowing({ sn, cuttingHeight: 90 });
    expect(vi.mocked(publishToDevice).mock.calls[0][1]).toMatchObject({
      start_navigation: { cutterhigh: 7 },
    });
  });
});

describe('startMowing re-applies saved para before the mow', () => {
  // A fresh SN with no deviceCache entry (so not busy) but with saved settings —
  // the mower resets para over a reconnect, so every mow must re-send them first.
  const psn = 'LFINPARAREAPPLY';
  beforeEach(() => {
    deviceCache.delete(psn);
    vi.clearAllMocks();
  });

  it('sends the full saved para block (with the mow direction) before start_navigation', () => {
    deviceSettingsRepo.upsert(psn, 'obstacle_avoidance_sensitivity', '3');
    deviceSettingsRepo.upsert(psn, 'path_direction', '0');
    deviceSettingsRepo.upsert(psn, 'sound', '0');
    const result = startMowing({ sn: psn, cuttingHeight: 3, pathDirection: 60 });
    expect(result.ok).toBe(true);
    // set_para_info is sent synchronously (start_navigation is delayed); it must
    // carry the saved obstacle level (so perception_level != 0) and THIS mow's
    // direction (60), not the saved 0.
    const paraCall = vi.mocked(publishToDevice).mock.calls
      .find((c) => c[1] && typeof c[1] === 'object' && 'set_para_info' in (c[1] as object));
    expect(paraCall).toBeTruthy();
    const para = (paraCall![1] as { set_para_info: Record<string, unknown> }).set_para_info;
    expect(para.obstacle_avoidance_sensitivity).toBe(3);
    expect(para.path_direction).toBe(60);
  });

  it('does not send a partial para block when nothing is saved (avoids resetting fields to 0)', () => {
    const result = startMowing({ sn: 'LFINNOSAVED', cuttingHeight: 5 });
    expect(result.ok).toBe(true);
    const paraCall = vi.mocked(publishToDevice).mock.calls
      .find((c) => c[1] && typeof c[1] === 'object' && 'set_para_info' in (c[1] as object));
    expect(paraCall).toBeUndefined();
  });
});
