/**
 * Regressie: alternate_direction roteerde nooit omdat de teller op
 * work_records.schedule_id liep — de maaier stuurt geen scheduleId mee bij
 * runner-gestarte mows, dus count bleef 0. De rotatie draait nu op
 * dashboard_schedules.trigger_count die de runner zelf ophoogt.
 */
import { describe, it, expect } from 'vitest';
import { scheduleRepo } from '../../db/repositories/index.js';

describe('ScheduleRepository.trigger_count', () => {
  it('starts at 0 and increments per geslaagde trigger', () => {
    scheduleRepo.create({ schedule_id: 'alt-1', mower_sn: 'LFIN0001', start_time: '09:00' });
    expect(scheduleRepo.findById('alt-1')?.trigger_count).toBe(0);

    scheduleRepo.incrementTriggerCount('alt-1');
    scheduleRepo.incrementTriggerCount('alt-1');
    expect(scheduleRepo.findById('alt-1')?.trigger_count).toBe(2);

    // De formule uit triggerSchedule: modulo 180 (richting = lijn-oriëntatie),
    // dus een 60°-schema met stap 90 alterneert 60 → 150 → 60 → ...
    const row = scheduleRepo.findById('alt-1')!;
    expect((60 + row.trigger_count * 90) % 180).toBe(60);   // count=2 → weer 60
    expect((60 + 1 * 90) % 180).toBe(150);                  // count=1 → 150
    expect((60 + 3 * 90) % 180).toBe(150);                  // count=3 → weer 150
  });
});
