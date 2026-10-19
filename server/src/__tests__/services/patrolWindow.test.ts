/**
 * The slot of a patrol window that "now" falls in: the start, then one every
 * interval_min while the slot lies before end_time (next day when end_time is
 * at or before start_time). Design: specs/2026-10-14-night-patrol-design.md, 9.
 */
import { describe, it, expect } from 'vitest';
import { patrolSlot, isWindowed } from '../../services/patrolWindow.js';

const ALL = JSON.stringify([0, 1, 2, 3, 4, 5, 6]);
const row = (over: Record<string, unknown> = {}) => ({
  start_time: '23:00', end_time: '06:00', interval_min: 30, weekdays: ALL,
  interval_days: 0, interval_anchor_date: null, timezone: 'Europe/Amsterdam', ...over,
});
// Wall-clock times in Europe/Amsterdam on 5/6 August 2026 (CEST, +02:00).
const at = (iso: string) => new Date(`${iso}+02:00`);

describe('patrolSlot', () => {
  it('is nothing for once (interval 0 or no end time), or a mow row', () => {
    expect(patrolSlot(row({ interval_min: 0 }), at('2026-08-05T23:10:00'))).toBeNull();
    expect(patrolSlot(row({ end_time: null }), at('2026-08-05T23:10:00'))).toBeNull();
    expect(isWindowed(row({ interval_min: 0 }))).toBe(false);
    expect(isWindowed(row())).toBe(true);
  });
  it('the first slot is the start; the k-th is start + k * interval', () => {
    const first = patrolSlot(row(), at('2026-08-05T23:00:30'))!;
    expect(first.index).toBe(0);
    expect(first.slotAt.getTime()).toBe(at('2026-08-05T23:00:00').getTime());
    expect(first.windowStart.getTime()).toBe(at('2026-08-05T23:00:00').getTime());
    expect(first.windowEnd.getTime()).toBe(at('2026-08-06T06:00:00').getTime());
    const third = patrolSlot(row(), at('2026-08-06T00:10:00'))!;
    expect(third.index).toBe(2);
    expect(third.slotAt.getTime()).toBe(at('2026-08-06T00:00:00').getTime());
    expect(third.windowStart.getTime()).toBe(at('2026-08-05T23:00:00').getTime());
  });
  it('after midnight the window is still the one that started yesterday', () => {
    const s = patrolSlot(row(), at('2026-08-06T05:59:00'))!;
    expect(s.index).toBe(13);
    expect(s.slotAt.getTime()).toBe(at('2026-08-06T05:30:00').getTime());
  });
  it('outside the window there is no slot', () => {
    expect(patrolSlot(row(), at('2026-08-06T06:00:00'))).toBeNull();
    expect(patrolSlot(row(), at('2026-08-06T12:00:00'))).toBeNull();
    expect(patrolSlot(row(), at('2026-08-05T22:59:00'))).toBeNull();
  });
  it('a window inside one day, and one whose end equals its start (a full day)', () => {
    const day = row({ start_time: '01:00', end_time: '04:00', interval_min: 60 });
    expect(patrolSlot(day, at('2026-08-06T03:30:00'))!.index).toBe(2);
    expect(patrolSlot(day, at('2026-08-06T04:00:00'))).toBeNull();
    const full = row({ start_time: '23:00', end_time: '23:00', interval_min: 120 });
    expect(patrolSlot(full, at('2026-08-06T22:59:00'))!.index).toBe(11);
  });
  it('the weekday rule applies to the day the window starts', () => {
    // 2026-08-05 is a Wednesday (3). A window of Wednesday nights only:
    const wed = row({ weekdays: JSON.stringify([3]) });
    expect(patrolSlot(wed, at('2026-08-06T01:00:00'))!.index).toBe(4);   // Thursday 01:00 belongs to Wednesday's window
    expect(patrolSlot(wed, at('2026-08-06T23:30:00'))).toBeNull();        // Thursday night: no window
  });
  it('a slot never lies at or past the end: the last round starts before end_time', () => {
    const tight = row({ start_time: '23:00', end_time: '00:00', interval_min: 30 });
    expect(patrolSlot(tight, at('2026-08-05T23:45:00'))!.index).toBe(1);
    expect(patrolSlot(tight, at('2026-08-06T00:00:00'))).toBeNull();
  });
  it('a server in UTC with a schedule in Amsterdam still finds the slot', () => {
    const s = patrolSlot(row(), new Date('2026-08-05T21:00:30Z'))!;   // 23:00:30 CEST
    expect(s.index).toBe(0);
  });
});

// The clocks change in the middle of a night window: forward at 02:00 on 2026-03-29 and back at
// 03:00 on 2026-10-25 in Amsterdam. Instants below are written in UTC.
describe('patrolSlot across a clock change', () => {
  it('finds yesterday\'s window on the night after the clocks went forward', () => {
    // Sunday 2026-03-29 has 23 hours: Monday 00:10 CEST minus 24 h is Saturday 23:10 CET.
    const s = patrolSlot(row(), new Date('2026-03-29T22:10:00Z'))!;   // Monday 00:10 CEST
    expect(s).not.toBeNull();
    expect(s.index).toBe(2);
    expect(s.windowStart.toISOString()).toBe('2026-03-29T21:00:00.000Z');   // Sunday 23:00 CEST
    expect(s.slotAt.toISOString()).toBe('2026-03-29T22:00:00.000Z');         // Monday 00:00 CEST
    expect(s.windowEnd.toISOString()).toBe('2026-03-30T04:00:00.000Z');      // Monday 06:00 CEST
    // The 00:30 round is the one that was lost with it.
    expect(patrolSlot(row(), new Date('2026-03-29T22:40:00Z'))!.index).toBe(3);
    expect(patrolSlot(row(), new Date('2026-03-30T04:00:00Z'))).toBeNull();
  });
  it('a window over the change forward ends at 06:00 on the wall clock, not an hour later', () => {
    // Saturday 2026-03-28 23:00 CET to Sunday 06:00 CEST: six hours elapsed, seven on the clock.
    const s = patrolSlot(row(), new Date('2026-03-29T03:50:00Z'))!;   // 05:50 CEST
    expect(s).not.toBeNull();
    expect(s.index).toBe(11);
    expect(s.slotAt.toISOString()).toBe('2026-03-29T03:30:00.000Z');
    expect(s.windowStart.toISOString()).toBe('2026-03-28T22:00:00.000Z');
    expect(s.windowEnd.toISOString()).toBe('2026-03-29T04:00:00.000Z');
    expect(patrolSlot(row(), new Date('2026-03-29T04:10:00Z'))).toBeNull();   // 06:10 CEST
  });
  it('a window over the change back runs until 06:00 on the wall clock, not an hour less', () => {
    // Saturday 2026-10-24 23:00 CEST to Sunday 06:00 CET: eight hours elapsed, seven on the clock.
    const s = patrolSlot(row(), new Date('2026-10-25T04:50:00Z'))!;   // 05:50 CET
    expect(s).not.toBeNull();
    expect(s.index).toBe(15);
    expect(s.slotAt.toISOString()).toBe('2026-10-25T04:30:00.000Z');
    expect(s.windowStart.toISOString()).toBe('2026-10-24T21:00:00.000Z');
    expect(s.windowEnd.toISOString()).toBe('2026-10-25T05:00:00.000Z');
    expect(patrolSlot(row(), new Date('2026-10-25T05:00:00Z'))).toBeNull();   // 06:00 CET
  });
  it('the weekday of the start holds on the night after the change too', () => {
    // Monday 00:10 CEST still belongs to Sunday\'s window, and Monday\'s own starts at 23:00.
    expect(patrolSlot(row({ weekdays: JSON.stringify([0]) }), new Date('2026-03-29T22:10:00Z'))!.index).toBe(2);
    expect(patrolSlot(row({ weekdays: JSON.stringify([1]) }), new Date('2026-03-29T22:10:00Z'))).toBeNull();
  });
});

describe('patrolSlot times', () => {
  it('are whole seconds, whatever the milliseconds of now', () => {
    // getScheduleOccurrence keeps the milliseconds of its argument; a round that started
    // in the same second as the window must not count as before it.
    const today = patrolSlot(row(), new Date('2026-08-05T21:30:00.800Z'))!;   // 23:30:00.800 CEST
    expect(today.index).toBe(1);
    expect(today.windowStart.toISOString()).toBe('2026-08-05T21:00:00.000Z');
    expect(today.slotAt.toISOString()).toBe('2026-08-05T21:30:00.000Z');
    const overMidnight = patrolSlot(row(), new Date('2026-08-05T22:10:00.800Z'))!;   // 00:10:00.800 CEST
    expect(overMidnight.windowStart.toISOString()).toBe('2026-08-05T21:00:00.000Z');
    expect(overMidnight.slotAt.toISOString()).toBe('2026-08-05T22:00:00.000Z');
    expect(overMidnight.windowEnd.getTime() % 1000).toBe(0);
  });
});
