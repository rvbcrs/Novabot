/**
 * Regression test for issue #13: scheduleRunner used new Date(last_triggered_at)
 * to parse SQLite's `datetime('now')` output. SQLite returns 'YYYY-MM-DD HH:MM:SS'
 * UTC without a Z suffix, which JS Date treats as LOCAL time. In any non-UTC
 * timezone (e.g. CEST = UTC+2) the parsed timestamp lagged scheduledAt by the
 * local offset → guard never matched → schedule retriggered every 30 s →
 * mower flooded with start_navigation → Error 2 'Already in running task'.
 *
 * The fix appends 'Z' (and swaps the space for 'T') before parsing.
 */

import { describe, it, expect } from 'vitest';

function parseSqliteUtc(s: string): Date {
  return new Date(s.replace(' ', 'T') + 'Z');
}

describe('SQLite datetime("now") parsing (issue #13 regression)', () => {
  it('the buggy parser drifts by the local offset', () => {
    const sqliteUtc = '2026-04-29 17:55:06';
    const buggy = new Date(sqliteUtc);
    const correct = parseSqliteUtc(sqliteUtc);
    const driftMs = correct.getTime() - buggy.getTime();
    // The drift magnitude equals the local timezone offset. Compare via
    // |drift| so the assertion holds in UTC (CI runner) where Object.is
    // distinguishes +0 from -0 and would otherwise fail this test.
    // The offset ON that date (April: summer time), not today's: with today's
    // the test failed every winter (CET +1 h against CEST +2 h).
    const expectedDriftMs = Math.abs(buggy.getTimezoneOffset()) * 60_000;
    expect(Math.abs(driftMs)).toBe(expectedDriftMs);
  });

  it('correctly parses SQLite UTC timestamp as UTC', () => {
    const sqliteUtc = '2026-04-29 17:55:06';
    const parsed = parseSqliteUtc(sqliteUtc);
    expect(parsed.toISOString()).toBe('2026-04-29T17:55:06.000Z');
  });

  it('lastTriggered >= scheduledAt holds when both are in the same second', () => {
    // scheduledAt is built locally with setHours; last_triggered_at is stored
    // as SQLite UTC. Simulate a CEST scheduled run at 19:55 local = 17:55 UTC.
    const sqliteUtc = '2026-04-29 17:55:06';
    const lastTriggered = parseSqliteUtc(sqliteUtc);
    const scheduledAt = new Date('2026-04-29T17:55:00.000Z');
    expect(lastTriggered.getTime() >= scheduledAt.getTime()).toBe(true);
  });
});
