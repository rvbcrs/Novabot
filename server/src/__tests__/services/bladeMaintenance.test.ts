import { describe, it, expect } from 'vitest';
import { messageRepo, userRepo } from '../../db/repositories/index.js';
import { getBladeStatus, setBladeMaintenance } from '../../services/bladeMaintenance.js';

const SN = 'LFIN_BLADE_TEST';
function record(minutes: number) {
  messageRepo.createWorkRecordFull(`${SN}-${Math.random()}`, 'blade-user', SN, null, minutes, 10, 2, '1', 'app', 'finished', null, null, 0);
}

describe('blade maintenance', () => {
  it('sums mowing hours since the replacement and flags due against the interval', () => {
    userRepo.create('blade-user', 'blade@test', 'hash', 'blade');
    record(30 * 60);
    expect(getBladeStatus(SN)).toMatchObject({ hoursSince: 30, due: false, intervalHours: 60 });
    expect(setBladeMaintenance(SN, { intervalHours: 20 }).due).toBe(true);
    expect(setBladeMaintenance(SN, { replaced: true }).replacedAt).not.toBeNull();
    // work_record_date is datetime('now') op secondeniveau; alles wat ná de
    // wissel binnenkomt telt weer mee.
    expect(getBladeStatus(SN).hoursSince).toBeLessThanOrEqual(30);
  });
});
