/**
 * Schedules anchored to sunrise/sunset: the start follows the seasons instead
 * of a fixed clock time. Reference times from Open-Meteo for Funes, Argentina
 * (-32.92, -60.81, America/Argentina/Buenos_Aires, UTC-3, no DST).
 */
import { describe, it, expect } from 'vitest';
import { getScheduleOccurrence, effectiveStartTime } from '../../services/scheduleRunner.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { sunTimes } from '../../services/sunTimes.js';
import type { ScheduleRow } from '../../db/repositories/schedules.js';

const FUNES = { lat: -32.92, lng: -60.81 };
const TZ = 'America/Argentina/Buenos_Aires';

function row(overrides: Partial<ScheduleRow>): ScheduleRow {
  return {
    id: 1, schedule_id: 's1', mower_sn: 'LFIN0000000000',
    schedule_name: null, start_time: '19:45', end_time: null,
    weekdays: '[0,1,2,3,4,5,6]', enabled: 1, map_id: null, map_name: null,
    last_result_at: null, last_result: null, last_result_reason: null,
    cutting_height: 40, path_direction: 0, work_mode: 0, task_mode: 0,
    edge_offset: 0, rain_pause: 0, rain_threshold_mm: 0.5,
    rain_threshold_probability: 50, rain_check_hours: 2,
    alternate_direction: 0, alternate_step: 90, last_triggered_at: null,
    interval_days: 0, interval_anchor_date: null, timezone: TZ, interval_min: 0,
    trigger_count: 0, skip_date: null, edge_days: null, created_at: '', updated_at: '',
    ...overrides,
  };
}

/** Minutes between two epochs, rounded. */
const minutesApart = (a: number, b: number) => Math.round(Math.abs(a - b) / 60_000);

describe('sunTimes', () => {
  it('matches Open-Meteo within 2 minutes (Funes, through the year)', () => {
    const cases: Array<[number, number, number, string | null, string]> = [
      [2026, 11, 15, '2026-11-15T08:53:00Z', '2026-11-15T22:42:00Z'],
      [2026, 11, 30, null, '2026-11-30T22:56:00Z'],
      [2026, 12, 21, null, '2026-12-21T23:10:00Z'],
      [2026, 6, 21, null, '2026-06-21T21:04:00Z'],
    ];
    for (const [y, m, d, rise, set] of cases) {
      const t = sunTimes(y, m, d, FUNES.lat, FUNES.lng);
      if (rise) expect(minutesApart(t.sunrise!, Date.parse(rise))).toBeLessThanOrEqual(2);
      expect(minutesApart(t.sunset!, Date.parse(set))).toBeLessThanOrEqual(2);
    }
  });

  it('returns null during polar night', () => {
    const t = sunTimes(2026, 12, 21, 78.22, 15.65); // Longyearbyen
    expect(t.sunrise).toBeNull();
    expect(t.sunset).toBeNull();
  });
});

describe('getScheduleOccurrence with a sun anchor', () => {
  it('starts at sunset of that day instead of start_time', () => {
    const now = new Date('2026-11-15T22:43:00Z');
    const occ = getScheduleOccurrence(row({ start_anchor: 'sunset' }), now, FUNES)!;
    expect(minutesApart(occ.getTime(), Date.parse('2026-11-15T22:42:00Z'))).toBeLessThanOrEqual(2);
  });

  it('follows the seasons: five weeks later sunset is ~28 min later', () => {
    const r = row({ start_anchor: 'sunset' });
    expect(effectiveStartTime(r, new Date('2026-11-15T15:00:00Z'), FUNES)).toMatch(/^19:4[0-4]$/);
    expect(effectiveStartTime(r, new Date('2026-12-21T15:00:00Z'), FUNES)).toMatch(/^20:(0[8-9]|1[0-2])$/);
  });

  it('applies the offset (negative = before)', () => {
    const now = new Date('2026-11-15T15:00:00Z');
    const plain = getScheduleOccurrence(row({ start_anchor: 'sunset' }), now, FUNES)!;
    const early = getScheduleOccurrence(row({ start_anchor: 'sunset', start_offset_min: -30 }), now, FUNES)!;
    expect(plain.getTime() - early.getTime()).toBe(30 * 60_000);
    // sunrise 05:53 + 45 min
    expect(effectiveStartTime(row({ start_anchor: 'sunrise', start_offset_min: 45 }), now, FUNES))
      .toMatch(/^06:3[6-9]$/);
  });

  it('still honours the weekday rule', () => {
    // 2026-11-15 is a Sunday
    const now = new Date('2026-11-15T22:43:00Z');
    expect(getScheduleOccurrence(row({ start_anchor: 'sunset', weekdays: '[1,2,3,4,5]' }), now, FUNES)).toBeNull();
  });

  it('falls back to start_time without a GPS position', () => {
    const now = new Date('2026-11-15T22:46:00Z');
    const occ = getScheduleOccurrence(row({ start_anchor: 'sunset' }), now, null);
    expect(occ?.toISOString()).toBe('2026-11-15T22:45:00.000Z');
    expect(effectiveStartTime(row({ start_anchor: 'sunset' }), now, null)).toBe('19:45');
  });

  it('ignores the anchor on a patrol (it keeps its clock window)', () => {
    const now = new Date('2026-11-15T22:46:00Z');
    const occ = getScheduleOccurrence(row({ kind: 'patrol', start_anchor: 'sunset' }), now, FUNES);
    expect(occ?.toISOString()).toBe('2026-11-15T22:45:00.000Z');
  });

  it("'time' keeps the fixed start_time", () => {
    const now = new Date('2026-11-15T22:46:00Z');
    const occ = getScheduleOccurrence(row({ start_anchor: 'time' }), now, FUNES);
    expect(occ?.toISOString()).toBe('2026-11-15T22:45:00.000Z');
  });

  it('uses the mower\'s own GPS fix while the charger position is unknown', () => {
    const sn = 'LFIN0000000099';
    deviceCache.set(sn, new Map([['latitude', '-32.945'], ['longitude', '-60.826']]));
    try {
      const r = row({ mower_sn: sn, start_anchor: 'sunset' });
      expect(effectiveStartTime(r, new Date('2026-11-15T15:00:00Z'))).toMatch(/^19:4[0-4]$/);
      // (0,0) = no RTK fix yet: fall back to start_time
      deviceCache.set(sn, new Map([['latitude', '0'], ['longitude', '0']]));
      expect(effectiveStartTime(r, new Date('2026-11-15T15:00:00Z'))).toBe('19:45');
    } finally {
      deviceCache.delete(sn);
    }
  });
});
