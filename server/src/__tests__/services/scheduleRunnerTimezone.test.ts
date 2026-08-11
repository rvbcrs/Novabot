/**
 * Per-schedule timezone: getScheduleOccurrence moet start_time interpreteren
 * in de IANA zone van het schema (row.timezone), niet in de container-TZ.
 * Aanleiding: Steve (LFIN1231000241) zette TZ in docker-compose om zijn
 * console-schema op Toronto-tijd te laten vuren en gokte daarbij het
 * ongeldige "Canada/Toronto" — schema's dragen nu hun eigen zone.
 */
import { describe, it, expect } from 'vitest';
import { getScheduleOccurrence } from '../../services/scheduleRunner.js';
import type { ScheduleRow } from '../../db/repositories/schedules.js';

function row(overrides: Partial<ScheduleRow>): ScheduleRow {
  return {
    id: 1, schedule_id: 's1', mower_sn: 'LFIN1231000241',
    schedule_name: null, start_time: '09:00', end_time: null,
    weekdays: '[0,1,2,3,4,5,6]', enabled: 1, map_id: null, map_name: null,
    cutting_height: 40, path_direction: 0, work_mode: 0, task_mode: 0,
    edge_offset: 0, rain_pause: 0, rain_threshold_mm: 0.5,
    rain_threshold_probability: 50, rain_check_hours: 2,
    alternate_direction: 0, alternate_step: 90, last_triggered_at: null,
    interval_days: 0, interval_anchor_date: null, timezone: null,
    trigger_count: 0, skip_date: null, edge_days: null, created_at: '', updated_at: '',
    ...overrides,
  };
}

describe('getScheduleOccurrence per-schedule timezone', () => {
  it('09:00 America/Toronto (EDT, zomer) = 13:00 UTC', () => {
    // Woensdag 2026-07-15 13:00:30Z = 09:00:30 in Toronto
    const now = new Date('2026-07-15T13:00:30Z');
    const occ = getScheduleOccurrence(row({ timezone: 'America/Toronto' }), now);
    expect(occ?.toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });

  it('09:00 Europe/Amsterdam (CEST) = 07:00 UTC — zelfde klok, andere zone', () => {
    const now = new Date('2026-07-15T07:02:00Z');
    const occ = getScheduleOccurrence(row({ timezone: 'Europe/Amsterdam' }), now);
    expect(occ?.toISOString()).toBe('2026-07-15T07:00:00.000Z');
  });

  it('weekday match gebeurt in de schema-zone, niet in UTC', () => {
    // 2026-07-15 03:00Z = dinsdag 23:00 in Toronto → alleen-woensdag schema matcht NIET
    const now = new Date('2026-07-15T03:00:00Z');
    const wednesdayOnly = row({ timezone: 'America/Toronto', weekdays: '[3]', start_time: '23:00' });
    expect(getScheduleOccurrence(wednesdayOnly, now)).toBeNull();
    // maar een alleen-dinsdag schema matcht wél (23:00 Toronto = di)
    const tuesdayOnly = row({ timezone: 'America/Toronto', weekdays: '[2]', start_time: '23:00' });
    expect(getScheduleOccurrence(tuesdayOnly, now)?.toISOString()).toBe('2026-07-15T03:00:00.000Z');
  });

  it('ongeldige zone ("Canada/Toronto") gooit niet maar valt terug op server-lokaal', () => {
    const now = new Date('2026-07-15T13:00:30Z');
    const occ = getScheduleOccurrence(row({ timezone: 'Canada/Toronto', start_time: '00:00', weekdays: '[0,1,2,3,4,5,6]' }), now);
    expect(occ).toBeInstanceOf(Date);
  });

  it('interval_days telt kalenderdagen in de schema-zone', () => {
    // anchor 2026-07-13, elke 2 dagen → 15 juli matcht, 16 juli niet
    const base = row({
      timezone: 'America/Toronto', interval_days: 2,
      interval_anchor_date: '2026-07-13', weekdays: '[]',
    });
    expect(getScheduleOccurrence(base, new Date('2026-07-15T13:00:30Z'))).not.toBeNull();
    expect(getScheduleOccurrence(base, new Date('2026-07-16T13:00:30Z'))).toBeNull();
  });
});
