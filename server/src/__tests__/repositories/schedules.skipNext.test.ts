/**
 * "Sla deze dag over": skip_date (YYYY-MM-DD, schema-tijdzone) op het schema.
 * De runner slaat alleen de occurrence op die datum over, wist het veld en
 * stempelt last_triggered_at zodat het 5-min window niet hertriggert.
 */
import { describe, it, expect } from 'vitest';
import { scheduleRepo } from '../../db/repositories/index.js';
import { scheduleDayKey } from '../../services/scheduleRunner.js';
import type { ScheduleRow } from '../../db/repositories/schedules.js';

describe('ScheduleRepository.skip_date', () => {
  it('defaults to null, settable and clearable via update', () => {
    scheduleRepo.create({ schedule_id: 'skip-1', mower_sn: 'LFIN0001', start_time: '09:00' });
    expect(scheduleRepo.findById('skip-1')?.skip_date).toBeNull();

    scheduleRepo.update('skip-1', { skip_date: '2026-07-16' });
    expect(scheduleRepo.findById('skip-1')?.skip_date).toBe('2026-07-16');

    // Wat de runner doet zodra de dag geskipt is:
    scheduleRepo.update('skip-1', { skip_date: null });
    scheduleRepo.updateLastTriggered('skip-1');
    const row = scheduleRepo.findById('skip-1')!;
    expect(row.skip_date).toBeNull();
    expect(row.last_triggered_at).not.toBeNull();
  });
});

describe('scheduleDayKey', () => {
  it('geeft de kalenderdag in de schema-tijdzone', () => {
    // 2026-07-15 23:30Z = 16 juli 01:30 in Amsterdam (CEST), nog 15 juli in Toronto
    const now = new Date('2026-07-15T23:30:00Z');
    const rowAms = { timezone: 'Europe/Amsterdam' } as ScheduleRow;
    const rowTor = { timezone: 'America/Toronto' } as ScheduleRow;
    expect(scheduleDayKey(rowAms, now)).toBe('2026-07-16');
    expect(scheduleDayKey(rowTor, now)).toBe('2026-07-15');
  });
});
