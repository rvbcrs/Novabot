import { describe, it, expect } from 'vitest';
import { bladesMaySpin, deriveMowerActivity } from '../../../../dashboard/src/utils/mowerActivity.js';

// Live .100 log 2026-09-25: the planner lowers the blade at COVERING, keeps it
// down through AVOIDING/MOVING between lanes, and raises it ("stop blade") at a
// slip, a stop or the finish.
const off = { task_mode: '1', battery_state: 'DISCHARGING' };

describe('bladesMaySpin: the only state that locks the joystick', () => {
  it('locks while the coverage runs', () => {
    for (const work of ['COVERING', 'BOUNDARY_COVERING', 'COVERING_MISSING', 'AVOIDING', 'MOVING']) {
      expect(bladesMaySpin({ ...off, msg: `Mode:COVERAGE Work:${work} Prev work:COVERING` }), work).toBe(true);
    }
    expect(bladesMaySpin({ work_status: 'Mowing' })).toBe(true);
    expect(bladesMaySpin({ edge_active: '1' })).toBe(true);
    expect(bladesMaySpin({ blade_speed: '-2750' })).toBe(true);
  });

  it('frees it when the blade is stopped', () => {
    for (const work of ['RECOVER_ERROR_STOP', 'SLIPPING_HANDLE', 'USER_STOP', 'FINISHED', 'MAPPING']) {
      // "Prev work:COVERING" must not count: only the live Work tag does.
      expect(bladesMaySpin({ ...off, msg: `Mode:COVERAGE Work:${work} Prev work:COVERING`, work_status: 'Recovery error' }), work).toBe(false);
    }
    expect(bladesMaySpin({ msg: 'Mode:COVERAGE Work:FINISHED Recharge: RETURN_TO_PILE', blade_speed: '0' })).toBe(false);
    expect(bladesMaySpin(undefined)).toBe(false);
  });
});

describe('failed slip escape (Error 123, Ivan)', () => {
  it('is a resumable pause, not mowing', () => {
    const s = { ...off, msg: 'Mode:COVERAGE Work:RECOVER_ERROR_STOP Prev work:SLIPPING_HANDLE Recharge: WAIT',
      work_status: 'Recovery error', error_status: 'Error (123)' };
    expect(deriveMowerActivity(s, { online: true })).toBe('paused');
  });
});
