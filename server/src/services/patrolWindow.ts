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
  /** The round's planned start. */
  slotAt: Date;
  windowStart: Date;
  windowEnd: Date;
  /** 0 for the first round of the window. */
  index: number;
}

const DAY_MS = 86_400_000;

/** A patrol row that runs rounds through a window: an interval and an end time. */
export function isWindowed(row: Pick<WindowRow, 'end_time' | 'interval_min'>): boolean {
  return (row.interval_min ?? 0) > 0 && typeof row.end_time === 'string' && /^\d{1,2}:\d{2}$/.test(row.end_time);
}

function minutesOf(hhmm: string): number | null {
  const [h = '', m = ''] = hhmm.split(':');
  const hour = Number(h), minute = Number(m);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

export function patrolSlot(row: WindowRow, now: Date): PatrolSlot | null {
  if (!isWindowed(row)) return null;
  const start = minutesOf(row.start_time), end = minutesOf(row.end_time!);
  if (start === null || end === null) return null;
  // The window's length: end at or before start is the next day; equal is a full day.
  // In elapsed time, like getScheduleOccurrence's own DST caveat: on the two nights a
  // year the clocks change, the end is an hour off on the wall clock.
  const lengthMs = (((end - start) % 1440 + 1440) % 1440 || 1440) * 60_000;
  const intervalMs = row.interval_min * 60_000;
  // Today's window start (if today is a window day), then yesterday's: a window
  // over midnight is still yesterday's in the small hours.
  for (const dayBack of [0, 1]) {
    const windowStart = getScheduleOccurrence(row as ScheduleRow, new Date(now.getTime() - dayBack * DAY_MS));
    if (!windowStart) continue;
    const windowEnd = new Date(windowStart.getTime() + lengthMs);
    if (now < windowStart || now >= windowEnd) continue;
    const index = Math.floor((now.getTime() - windowStart.getTime()) / intervalMs);
    return { slotAt: new Date(windowStart.getTime() + index * intervalMs), windowStart, windowEnd, index };
  }
  return null;
}
