// server/src/services/patrolWindow.ts
/**
 * The slot of a night patrol window that a moment falls in. A patrol schedule
 * with an interval starts a round at start_time and then one every
 * interval_min minutes while the slot lies before end_time (end_time at or
 * before start_time means the next day). The weekday rule applies to the day
 * the window starts. Pure: no DB, no clock of its own.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md, 9.
 */
import { getScheduleOccurrence } from './scheduleRunner.js';
import type { ScheduleRow } from '../db/repositories/schedules.js';

export type WindowRow = Pick<ScheduleRow, 'start_time' | 'end_time' | 'interval_min' | 'weekdays' | 'interval_days' | 'interval_anchor_date' | 'timezone'>;

export interface PatrolSlot {
  /** The round's planned start, a whole second. */
  slotAt: Date;
  windowStart: Date;
  /** end_time on the wall clock of the window's last day. */
  windowEnd: Date;
  /** 0 for the first round of the window. */
  index: number;
}

const HOUR_MS = 3_600_000;
const EVERY_DAY = '[0,1,2,3,4,5,6]';

/** A patrol row that runs rounds through a window: an interval and an end time. */
export function isWindowed(row: Pick<WindowRow, 'end_time' | 'interval_min'>): boolean {
  return (row.interval_min ?? 0) > 0 && typeof row.end_time === 'string' && /^\d{1,2}:\d{2}$/.test(row.end_time);
}

function minutesOf(hhmm: string): number | null {
  const [h = '', m = ''] = hhmm.split(':');
  const hour = Number(h), minute = Number(m);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

function wholeSecond(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 1000) * 1000);
}

/**
 * Where a window that starts at `windowStart` ends: end_time on the wall clock of the day
 * `lengthMs` later. A window over a clock change is an hour longer or shorter in elapsed
 * time, and still ends at 06:00.
 */
function windowEndOf(row: ScheduleRow, windowStart: Date, lengthMs: number): Date {
  const nominal = new Date(windowStart.getTime() + lengthMs);
  const end = getScheduleOccurrence({ ...row, start_time: row.end_time!, weekdays: EVERY_DAY, interval_days: 0 }, nominal);
  return end ?? nominal;
}

export function patrolSlot(row: WindowRow, now: Date): PatrolSlot | null {
  if (!isWindowed(row)) return null;
  const start = minutesOf(row.start_time), end = minutesOf(row.end_time!);
  if (start === null || end === null) return null;
  // The window's nominal length: end at or before start is the next day; equal is a full day.
  const lengthMs = (((end - start) % 1440 + 1440) % 1440 || 1440) * 60_000;
  const intervalMs = row.interval_min * 60_000;
  const full = row as ScheduleRow;
  // The window that holds `now` started today or yesterday: a window over midnight is still
  // yesterday's in the small hours. Yesterday is read from its noon (local midnight minus 12 h),
  // not from `now` minus 24 h: on the night after the clocks went forward Sunday has 23 hours,
  // so that is two days back. From noon, getScheduleOccurrence counts the hours to an evening
  // or night start with no clock change in between, as on any other day.
  // Known limits, on the night the clocks change only:
  // - A window that starts in the small hours BEFORE the change (after 00:00, before 02:00 or
  //   03:00) is read an hour off once the clocks have changed.
  // - Where the clocks change around midnight (Beirut, Santiago, Cairo) the hour before midnight
  //   happens twice, and during the repeated hour the start of an evening window is read an hour
  //   late. The window end stays right, and so do the slot times for intervals that divide 60
  //   minutes; other intervals can shift or lose a round in that hour.
  // Both come from getScheduleOccurrence, which counts elapsed hours from the instant it is given
  // and has the same caveat for a single start. Evening and night starts and starts after the
  // change were exact on every minute around the change in the other zones tried (Amsterdam,
  // London, Toronto, Los Angeles, Sydney, Auckland, Lord Howe, Kolkata).
  const midnight = getScheduleOccurrence({ ...full, start_time: '00:00', weekdays: EVERY_DAY, interval_days: 0 }, now);
  const yesterdayNoon = new Date((midnight ?? now).getTime() - 12 * HOUR_MS);
  for (const from of [now, yesterdayNoon]) {
    const found = getScheduleOccurrence(full, from);
    if (!found) continue;
    // Whole seconds: getScheduleOccurrence keeps the milliseconds of `from`, and a round that
    // started in the same second as the window would otherwise count as before it.
    const windowStart = wholeSecond(found);
    const windowEnd = windowEndOf(full, windowStart, lengthMs);
    if (now < windowStart || now >= windowEnd) continue;
    const index = Math.floor((now.getTime() - windowStart.getTime()) / intervalMs);
    return { slotAt: new Date(windowStart.getTime() + index * intervalMs), windowStart, windowEnd, index };
  }
  return null;
}
