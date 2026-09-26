import { describe, expect, it } from 'vitest';
import { bladesMaySpin } from '../bladeState';

// Same rule as dashboard/src/utils/mowerActivity.ts bladesMaySpin.
describe('bladesMaySpin', () => {
  it('locks while the coverage runs', () => {
    for (const work of ['COVERING', 'BOUNDARY_COVERING', 'COVERING_MISSING', 'AVOIDING', 'MOVING']) {
      expect(bladesMaySpin({ msg: `Mode:COVERAGE Work:${work} Prev work:COVERING` }), work).toBe(true);
    }
    expect(bladesMaySpin({ work_status: '90' })).toBe(true);
    expect(bladesMaySpin({ edge_active: '1' })).toBe(true);
    expect(bladesMaySpin({ blade_speed: '-2750' })).toBe(true);
  });

  it('frees it when the blade is stopped', () => {
    for (const work of ['RECOVER_ERROR_STOP', 'SLIPPING_HANDLE', 'USER_STOP', 'FINISHED']) {
      expect(bladesMaySpin({ msg: `Mode:COVERAGE Work:${work} Prev work:COVERING`, work_status: 'Recovery error' }), work).toBe(false);
    }
    expect(bladesMaySpin({})).toBe(false);
  });
});
