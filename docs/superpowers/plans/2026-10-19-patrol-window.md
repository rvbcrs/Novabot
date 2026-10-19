# Patrol Window and Interval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A patrol schedule is a nightly window with an interval (from 23:00 until 06:00, every 30 min) instead of one start time; the server starts a round per slot, skips a slot when the mower is not ready, and stops the night after a round that failed, was stopped or did not dock.

**Architecture:** The schedule row keeps `start_time`, gains `interval_min` and uses the existing `end_time` as the window end. A pure helper (`patrolWindow.ts`) maps "now" onto the slot of the window; the schedule runner uses that slot as the occurrence for windowed patrol rows and applies the per-slot guards before the weather check. The dashboard's patrol panel edits from/until/every and groups the run list per night.

**Tech Stack:** TypeScript, Express, better-sqlite3, vitest (server); React, i18next, node:test `.check.ts` files run with `npx tsx` (dashboard).

**Spec:** docs/superpowers/specs/2026-10-14-night-patrol-design.md, section 9 "Starting" (window paragraph added 2026-10-19).

## Global Constraints

- Patrol schedules are run by the server only; never sent to the mower, never mirrored into the stock app's plans, not listed among mow schedules (spec 9).
- A slot that is not started is a **skip** on the schedule (`logScheduleDecision(row, false, 'SKIPPED', ...)` + `scheduleRepo.updateLastTriggered`), never an error and never a notification.
- The night stops after a round of this schedule tonight that ended `error`, `stopped`, or has `dock_failed_at` (spec 9). The first slot of a window keeps today's rules.
- `interval_min = 0` or `end_time = null` on a patrol row is "once": exactly today's behaviour; mow rows ignore `interval_min` entirely.
- Every new `M\`...\`` / `T\`...\`` sentence gets its en/fr/de entries in the server text catalog (`server/src/services/serverText.ts`; `serverText.coverage.test.ts` fails otherwise).
- No em dashes in any text. Dutch sentences in `M\`\``/`T\`\`` like the surrounding code. UI strings in all four locales (en, nl, fr, de).
- Commits in English, plain messages, no attribution trailers of any kind.
- Server checks: `cd server && npx tsc --noEmit && npx vitest run <files>` (never two vitest runs at once). Dashboard checks: `cd dashboard && npx tsc -p tsconfig.app.json --noEmit && npm run build`, plus `npx tsx <file>.check.ts`.

## Review Focus

1. A window that crosses midnight (23:00 until 06:00): at 00:10 the slot is tonight's (yesterday's start), at 06:00 nothing, at 22:00 nothing. Pinned by patrolWindow.test.ts.
2. The night-stop rule must not look at a run of another schedule, of a manual start, or of a previous night: only a run with this `schedule_id` started at or after the window start. Pinned in scheduleRunnerPatrol.test.ts.
3. A skipped slot must stamp `last_triggered_at`, or the 5-minute window re-evaluates the same slot every 30 seconds and spams the schedule log. Pinned in scheduleRunnerPatrol.test.ts (one decision per slot).
4. The dashboard must not create a second patrol schedule when the window fields are saved before the first save has answered (the existing queue); and "once" must hide the until-time without sending `endTime: ''`. Pinned by reading the save path; `endTime` is sent as `null` for once.
5. Validation: `intervalMin` outside `{0, 15..240}` or an interval without `endTime` is a 400 with a sentence, never a stored row. Pinned in the routes test.

---

### Task 1: Server: window slots, per-slot guards, API fields

**Files:**
- Modify: `server/src/db/database.ts` (right after the `kind` migration, ~line 855)
- Modify: `server/src/db/repositories/schedules.ts` (`ScheduleRow`, `create`, `update`, `updateByIdAndMower`)
- Create: `server/src/services/patrolWindow.ts`
- Modify: `server/src/services/scheduleRunner.ts` (`checkSchedules`, MISSED text, new guards)
- Modify: `server/src/routes/dashboard.ts` (`scheduleRowToDto`, POST `/schedules/:sn`, PATCH `/schedules/:sn/:scheduleId`)
- Modify: `server/src/services/patrolFrames.ts` (`PATROL_KEEP_RUNS` 10 to 30)
- Modify: `server/src/services/serverText.ts` (catalog entries for every new sentence)
- Create: `server/src/__tests__/services/patrolWindow.test.ts`
- Modify: `server/src/__tests__/services/scheduleRunnerPatrol.test.ts`
- Create: `server/src/__tests__/routes/patrolScheduleWindow.test.ts`

**Interfaces:**
- Consumes: `getScheduleOccurrence(row, now)` and `scheduleDayKey` (scheduleRunner.ts), `wallClock(date, tz)` (where getScheduleOccurrence gets it), `patrolRunsRepo.get(sn)` (`{ run, started_at, schedule_id, ended_phase, dock_failed_at }`), `getDeviceSnapshot(sn)` from `../mqtt/sensorData.js` (`battery_state`, `charging`, `battery_power` strings), `PATROL_MIN_BATTERY` from patrolService.ts, `logScheduleDecision`, `scheduleRepo.updateLastTriggered`.
- Produces: column `dashboard_schedules.interval_min INTEGER NOT NULL DEFAULT 0`; `ScheduleRow.interval_min: number`; `patrolSlot(row, now): PatrolSlot | null` and `isWindowed(row): boolean` exported from `services/patrolWindow.ts`; DTO field `intervalMin` on GET `/schedules/:sn`; POST/PATCH body fields `intervalMin` (number) and `endTime` (HH:MM | null) for patrol rows.

- [ ] **Step 1: Migration and row type**

In `server/src/db/database.ts`, right after the `kind` migration block, add in the same style:

```ts
  // Night patrol window: a round every interval_min minutes from start_time
  // while the slot lies before end_time (plan 2026-10-19). 0 = once.
  try {
    db.exec(`ALTER TABLE dashboard_schedules ADD COLUMN interval_min INTEGER NOT NULL DEFAULT 0`);
    console.log('[DB] Migrated: added dashboard_schedules.interval_min');
  } catch {
    // Kolom bestaat al
  }
```

In `server/src/db/repositories/schedules.ts`: add to `ScheduleRow` after `kind`:

```ts
  /** Patrol only: minutes between two rounds of the night's window (end_time); 0 = once. */
  interval_min: number;
```

Add `interval_min` to the INSERT column list and values in `create` (`data.interval_min ?? 0`), and `['interval_min', data.interval_min]` to the `updatable` lists of `update` and `updateByIdAndMower`.

- [ ] **Step 2: Failing tests for the pure slot helper**

Create `server/src/__tests__/services/patrolWindow.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to see it fail**

Run: `cd server && npx vitest run src/__tests__/services/patrolWindow.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `patrolWindow.ts`**

```ts
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
```

Note: `getScheduleOccurrence` needs `start_time`, `weekdays`, `interval_days`, `interval_anchor_date`, `timezone` only; the cast is for its signature. If importing scheduleRunner from patrolWindow creates a cycle that breaks tests (scheduleRunner imports patrolWindow in Step 6), move `getScheduleOccurrence`, `scheduleDayKey` and `wallClock` usage into `patrolWindow.ts` and re-export them from scheduleRunner.ts so the existing imports keep working.

- [ ] **Step 5: Run the test to see it pass**

Run: `cd server && npx vitest run src/__tests__/services/patrolWindow.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Failing runner tests**

Append to `server/src/__tests__/services/scheduleRunnerPatrol.test.ts` (inside the existing `describe`, reusing its mocks, `NOW`, `SN`, `flush`, `due`). Add near `due`:

```ts
/** A windowed patrol schedule: 23:00 until 06:00, every 30 min. */
function windowed(id: string) {
  scheduleRepo.create({
    schedule_id: id, mower_sn: SN, start_time: '23:00', end_time: '06:00', interval_min: 30, kind: 'patrol',
    weekdays: JSON.stringify([NOW.getDay()]), enabled: 1, rain_pause: 0,
  });
}
/** What the mower reports: charging on the dock with this battery. */
function dockedAt(battery: number, charging = true) {
  vi.mocked(getDeviceSnapshot).mockReturnValue({ battery_state: charging ? 'CHARGING' : 'DISCHARGING', charging: charging ? '1' : '0', battery_power: String(battery) });
}
/** The run the server holds for the mower. */
function lastRun(over: Partial<{ schedule_id: string | null; started_at: number; ended_phase: string | null; dock_failed_at: number | null }>) {
  vi.mocked(patrolRunsRepo.get).mockReturnValue({ mower_sn: SN, run: 'r1', token: 't', started_at: NOW.getTime(), schedule_id: 'w-23', ended_phase: 'done', dock_failed_at: null, ...over } as never);
}
```

with the mocks at the top of the file extended by:

```ts
vi.mock('../../mqtt/sensorData.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mqtt/sensorData.js')>()),
  getDeviceSnapshot: vi.fn(() => null),
}));
```

and `patrolRunsRepo.get` spied in `beforeEach` with `vi.spyOn(patrolRunsRepo, 'get').mockReturnValue(undefined)` (import `patrolRunsRepo` from `../../db/repositories/index.js`, `getDeviceSnapshot` from `../../mqtt/sensorData.js`). Tests:

```ts
  it('a windowed schedule starts its first round at the start like a single one', async () => {
    windowed('w-23');
    startScheduleRunner();
    await flush();
    expect(startPatrol).toHaveBeenCalledWith(SN, NOW.getTime(), 'w-23');
  });

  it('a later slot starts the next round when the previous one is done and the mower charges', async () => {
    windowed('w-23');
    scheduleRepo.update('w-23', { last_triggered_at: '2026-08-05 21:00:40' });   // the first slot was decided (UTC = 23:00:40 CEST)
    lastRun({ ended_phase: 'done' });
    dockedAt(80);
    vi.setSystemTime(new Date('2026-08-05T23:30:30'));
    startScheduleRunner();
    await flush();
    expect(startPatrol).toHaveBeenCalledTimes(1);
    expect(startPatrol).toHaveBeenCalledWith(SN, new Date('2026-08-05T23:30:30').getTime(), 'w-23');
  });

  it('a slot is skipped, once, while the previous round is still out', async () => {
    windowed('w-23');
    scheduleRepo.update('w-23', { last_triggered_at: '2026-08-05 21:00:40' });
    lastRun({ ended_phase: null });
    dockedAt(80, false);
    vi.setSystemTime(new Date('2026-08-05T23:30:30'));
    startScheduleRunner();
    await flush();
    vi.advanceTimersByTime(90_000);   // three more ticks inside the 5-minute window
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();
    const row = scheduleRepo.findById('w-23')!;
    expect(row.last_result).toBe('skipped');
    expect(row.last_result_reason).toMatch(/onderweg|still out/i);
    expect(emitScheduleEvent).toHaveBeenCalledTimes(1);   // one decision for the slot, not one per tick
  });

  it('a slot is skipped when the mower is not charging on the dock, or its battery is below the patrol minimum', async () => {
    windowed('w-23');
    scheduleRepo.update('w-23', { last_triggered_at: '2026-08-05 21:00:40' });
    lastRun({ ended_phase: 'done' });
    dockedAt(80, false);
    vi.setSystemTime(new Date('2026-08-05T23:30:30'));
    startScheduleRunner();
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();
    expect(scheduleRepo.findById('w-23')!.last_result).toBe('skipped');
    stopScheduleRunner();
    scheduleRepo.update('w-23', { last_triggered_at: '2026-08-05 21:30:40', last_result: null });
    dockedAt(40);
    vi.setSystemTime(new Date('2026-08-06T00:00:30'));
    startScheduleRunner();
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();
    expect(scheduleRepo.findById('w-23')!.last_result_reason).toMatch(/40/);
  });

  it('the night stops after a round that failed, was stopped or did not dock; another schedule or an older night does not count', async () => {
    for (const [over, stops] of [
      [{ ended_phase: 'error' }, true], [{ ended_phase: 'stopped' }, true], [{ ended_phase: 'done', dock_failed_at: NOW.getTime() + 1 }, true],
      [{ ended_phase: 'error', schedule_id: 'other' }, false], [{ ended_phase: 'error', started_at: NOW.getTime() - 86_400_000 }, false],
    ] as const) {
      db.prepare('DELETE FROM dashboard_schedules').run();
      vi.clearAllMocks();
      windowed('w-23');
      scheduleRepo.update('w-23', { last_triggered_at: '2026-08-05 21:00:40' });
      lastRun(over as never);
      dockedAt(80);
      vi.setSystemTime(new Date('2026-08-05T23:30:30'));
      startScheduleRunner();
      await flush();
      stopScheduleRunner();
      expect(startPatrol, JSON.stringify(over)).toHaveBeenCalledTimes(stops ? 0 : 1);
      if (stops) expect(scheduleRepo.findById('w-23')!.last_result_reason).toMatch(/nacht|night/i);
    }
  });

  it('a once schedule (interval 0) and a mow schedule are untouched by the window code', async () => {
    due('p-once', 'patrol');
    scheduleRepo.update('p-once', { end_time: '06:00', interval_min: 0 });
    due('m-23', 'mow');
    scheduleRepo.update('m-23', { end_time: '06:00', interval_min: 30 });
    vi.setSystemTime(new Date('2026-08-05T23:30:30'));
    startScheduleRunner();
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();    // 23:30 is outside the 5-minute window of a 23:00 single start
    expect(startMowing).not.toHaveBeenCalled();
  });
```

Note `due()` in the file sets no `end_time`; `scheduleRepo.update` must accept `interval_min` (Step 1). If `last_result` columns are set by `logScheduleDecision` under other names, read `logScheduleDecision` and adapt the assertions to the columns it writes.

- [ ] **Step 7: Run the runner tests to see the new ones fail**

Run: `cd server && npx vitest run src/__tests__/services/scheduleRunnerPatrol.test.ts`
Expected: the six new tests FAIL, the existing ones PASS.

- [ ] **Step 8: Runner integration**

In `server/src/services/scheduleRunner.ts`:

1. Import `isWindowed`, `patrolSlot` from `./patrolWindow.js`, `patrolRunsRepo` from the repositories index, `getDeviceSnapshot` from `../mqtt/sensorData.js`, `PATROL_MIN_BATTERY` from `./patrolService.js`.
2. In `checkSchedules`, replace the occurrence line:

```ts
    // A patrol window runs a round per slot: the slot is the occurrence.
    const slot = row.kind === 'patrol' && isWindowed(row) ? patrolSlot(row, now) : null;
    if (row.kind === 'patrol' && isWindowed(row) && !slot) continue;   // outside the window
    const scheduledAt = slot ? slot.slotAt : getScheduleOccurrence(row, now);
```

3. The MISSED message: for a slot, say the slot's wall time instead of `row.start_time`: add

```ts
/** HH:MM of a moment in the schedule's zone. */
function wallTime(row: ScheduleRow, at: Date): string {
  const wc = wallClock(at, row.timezone ?? null);
  return `${String(Math.floor(wc.minutesIntoDay / 60)).padStart(2, '0')}:${String(wc.minutesIntoDay % 60).padStart(2, '0')}`;
}
```

and use `M\`de server draaide niet om ${slot ? wallTime(row, slot.slotAt) : row.start_time}\`` (one sentence, the argument changes). Check what `wallClock` returns (hours/minutes fields may exist; use them).

4. After the `skip_date` block and before the online check, the per-slot guards, for `slot && slot.index > 0` only:

```ts
    if (slot && slot.index > 0) {
      const why = roundSkipReason(row, slot);
      if (why) {
        scheduleRepo.updateLastTriggered(row.schedule_id);
        logScheduleDecision(row, false, 'SKIPPED', why);
        continue;
      }
    }
```

with

```ts
/**
 * Why a later round of a patrol window is not started now, or null. The night
 * stops after a round of this schedule tonight that failed, was stopped or did
 * not dock; a round still out, a mower not charging on the dock, or a battery
 * under the patrol minimum skip this slot only. (spec 9)
 */
function roundSkipReason(row: ScheduleRow, slot: PatrolSlot): Msg | null {
  const last = patrolRunsRepo.get(row.mower_sn);
  if (last && last.schedule_id === row.schedule_id && last.started_at >= slot.windowStart.getTime()) {
    const at = wallTime(row, new Date(last.started_at));
    if (last.dock_failed_at != null) return M`rest van de nacht overgeslagen: de ronde van ${at} kon niet docken`;
    if (last.ended_phase === 'error') return M`rest van de nacht overgeslagen: de ronde van ${at} is mislukt`;
    if (last.ended_phase === 'stopped') return M`rest van de nacht overgeslagen: de ronde van ${at} is gestopt`;
    if (last.ended_phase === null) return M`de ronde van ${at} is nog onderweg`;
  }
  const snap = getDeviceSnapshot(row.mower_sn);
  const charging = snap?.battery_state === 'CHARGING' || snap?.charging === '1';
  if (!charging) return M`de maaier staat niet aan het laden op het dock`;
  const battery = parseInt(snap?.battery_power ?? '', 10);
  if (Number.isFinite(battery) && battery < PATROL_MIN_BATTERY) return M`accu ${battery} %, laadt nog op (minimaal ${PATROL_MIN_BATTERY} %)`;
  return null;
}
```

Add the en/fr/de catalog entries for the five new sentences (and the MISSED one if its text changed) in `server/src/services/serverText.ts`, in the file's existing format.

- [ ] **Step 9: Run the runner tests to see them pass**

Run: `cd server && npx vitest run src/__tests__/services/scheduleRunnerPatrol.test.ts src/__tests__/services/serverText.coverage.test.ts`
Expected: PASS.

- [ ] **Step 10: Failing routes test**

Create `server/src/__tests__/routes/patrolScheduleWindow.test.ts`, modelled on the harness of `server/src/__tests__/routes/stockFirmwareGate.test.ts` (same app bootstrap, same way to mark the mower OpenNova so a patrol row is accepted). Cases:

```ts
  it('creates a patrol window and reads it back', async () => {
    // POST { kind: 'patrol', startTime: '23:00', endTime: '06:00', intervalMin: 30, weekdays: [0,1,2,3,4,5,6], timezone: 'Europe/Amsterdam' } -> 201/200
    // GET /schedules/:sn?kind=patrol -> schedules[0] has startTime '23:00', endTime '06:00', intervalMin 30
  });
  it('refuses an interval outside 0 or 15..240 and an interval without an end time', async () => {
    // intervalMin 7 -> 400 with a sentence; intervalMin 30 and no endTime -> 400; intervalMin 0 and no endTime -> accepted
    // PATCH intervalMin 500 -> 400; PATCH { intervalMin: 0, endTime: null } -> accepted, GET shows intervalMin 0 and endTime null
  });
  it('a mow schedule ignores intervalMin', async () => {
    // POST { kind: 'mow', startTime: '10:00', intervalMin: 30 } -> stored row has interval_min 0
  });
```

- [ ] **Step 11: Run it to see it fail**

Run: `cd server && npx vitest run src/__tests__/routes/patrolScheduleWindow.test.ts`
Expected: FAIL (intervalMin not in the DTO / validation missing).

- [ ] **Step 12: Routes**

In `server/src/routes/dashboard.ts`:
- `scheduleRowToDto`: add `intervalMin: r.interval_min ?? 0,`.
- POST `/schedules/:sn`: body type gains `endTime?: string | null; intervalMin?: number;`. Add a validator used by POST and PATCH:

```ts
/** A patrol window's interval and end time, validated: null when fine, else the 400 sentence. */
function patrolWindowError(T: ReturnType<typeof reqT>, intervalMin: unknown, endTime: unknown): Msg | null {
  if (intervalMin !== undefined && (!Number.isInteger(intervalMin) || !(intervalMin === 0 || ((intervalMin as number) >= 15 && (intervalMin as number) <= 240)))) {
    return T`intervalMin moet 0 of 15 tot en met 240 minuten zijn`;
  }
  if (endTime !== undefined && endTime !== null && !(typeof endTime === 'string' && /^\d{1,2}:\d{2}$/.test(endTime))) {
    return T`endTime moet HH:MM zijn`;
  }
  if ((intervalMin as number ?? 0) > 0 && !endTime) return T`endTime is vereist bij een interval`;
  return null;
}
```

(match the file's actual `T`/`Msg` types and how other 400s are sent). POST: for `isPatrol`, validate `body.intervalMin` and `body.endTime` (reject with 400 `{ error }`), store `interval_min: isPatrol ? (body.intervalMin ?? 0) : 0` and `end_time: body.endTime ?? null`. PATCH: when `existing.kind === 'patrol'`, validate `body.intervalMin` and the effective end time (`body.endTime !== undefined ? body.endTime : existing.end_time`) against the effective interval (`body.intervalMin ?? existing.interval_min`); set `interval_min: body.intervalMin` (patrol only), `end_time: body.endTime` (already passed through; make sure `null` clears it rather than being dropped as undefined).

- [ ] **Step 13: Run the routes test, the catalog test and tsc**

Run: `cd server && npx tsc --noEmit && npx vitest run src/__tests__/routes/patrolScheduleWindow.test.ts src/__tests__/services/serverText.coverage.test.ts`
Expected: PASS.

- [ ] **Step 14: Keep more runs**

`server/src/services/patrolFrames.ts`: `PATROL_KEEP_RUNS = 30` and its comment ("a night of half-hour rounds is 14 runs; three nights fit").

- [ ] **Step 15: Full server test run and commit**

Run: `cd server && npx vitest run` (alone; expect the pre-existing counts plus the new tests, no failures).

```bash
git add server/src/db/database.ts server/src/db/repositories/schedules.ts server/src/services/patrolWindow.ts server/src/services/scheduleRunner.ts server/src/routes/dashboard.ts server/src/services/patrolFrames.ts server/src/services/serverText.ts server/src/__tests__/services/patrolWindow.test.ts server/src/__tests__/services/scheduleRunnerPatrol.test.ts server/src/__tests__/routes/patrolScheduleWindow.test.ts
git commit -m "feat(server): a patrol schedule is a nightly window with an interval; a round per slot, skipped while the mower is not ready, and the night stops after a failed round"
```

---

### Task 2: Dashboard: from / until / every, the run list per night, docs

**Files:**
- Modify: `dashboard/src/api/client.ts` (`Schedule` type, `savePatrolSchedule`)
- Modify: `dashboard/src/components/dashboard/PatrolPanel.tsx` (`NightlySchedule`, `RunList`)
- Create: `dashboard/src/utils/patrolNights.ts`, `dashboard/src/utils/patrolNights.check.ts`
- Modify: `dashboard/src/i18n/locales/en.json`, `nl.json`, `fr.json`, `de.json` (`drawer.patrol.*`)
- Modify: `docs/user-guide/dashboard.md` (Night patrol: the schedule bullet and "Last patrols")

**Interfaces:**
- Consumes: GET `/schedules/:sn?kind=patrol` returns `intervalMin` and `endTime`; POST/PATCH accept `intervalMin` (0 | 15..240) and `endTime` (HH:MM | null); `PatrolRunDto.startedAt` (epoch ms or ISO, as the existing `patrolTime` helper takes it).
- Produces: `savePatrolSchedule(sn, { startTime, endTime, intervalMin, enabled }, existingId)`; `nightKey(startedAt, locale?)` and `groupByNight(runs)` in `utils/patrolNights.ts`.

- [ ] **Step 1: Client**

In `dashboard/src/api/client.ts`: add `intervalMin?: number;` to `Schedule` (next to `endTime`), and change:

```ts
export interface PatrolWindow { startTime: string; endTime: string | null; intervalMin: number; enabled: boolean }

/**
 * Create the patrol schedule (every day) or change its window and switch. The
 * server keeps the window with the switch off. Resolves with the saved
 * schedule, so a first save yields the id the next one needs.
 */
export async function savePatrolSchedule(sn: string, window: PatrolWindow, existingId: string | null): Promise<Schedule> {
  if (existingId) return updateSchedule(sn, existingId, window);
  const data = await (await post(`${BASE}/schedules/${encodeURIComponent(sn)}`, {
    kind: 'patrol', ...window, weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: browserTimezone(),
  })).json();
  return data.schedule;
}
```

- [ ] **Step 2: Night grouping helper and its check**

`dashboard/src/utils/patrolNights.ts`:

```ts
/**
 * Patrol runs grouped per night. A night is the evening's date: a run started
 * before noon belongs to the night that began the day before, so the rounds of
 * one window (23:00 until 06:00) stay together.
 */
export interface NightGroup<R> { night: string; runs: R[] }

const HALF_DAY_MS = 12 * 3_600_000;

/** YYYY-MM-DD of the night a run belongs to, in the browser's zone. */
export function nightKey(startedAt: number | string): string {
  const t = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt);
  const d = new Date(t - HALF_DAY_MS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The runs, newest first, in groups per night (newest night first), keeping the order within a night. */
export function groupByNight<R extends { startedAt: number | string }>(runs: readonly R[]): NightGroup<R>[] {
  const groups: NightGroup<R>[] = [];
  for (const r of runs) {
    const night = nightKey(r.startedAt);
    const last = groups[groups.length - 1];
    if (last && last.night === night) last.runs.push(r);
    else groups.push({ night, runs: [r] });
  }
  return groups;
}
```

`dashboard/src/utils/patrolNights.check.ts` (header: `// Draaien: npx tsx dashboard/src/utils/patrolNights.check.ts`), with node:test: a 23:30 run and the next day's 00:10 and 05:50 runs share one night; a 12:00 run starts a new one; an ISO string and a number give the same key; grouping keeps newest-first order and splits at the night boundary; an empty list gives no groups.

- [ ] **Step 3: The schedule row in the panel**

Replace `NightlySchedule`'s state with the window: `from` (start), `until` (end, default `'06:00'`), `every` (0 | 15 | 30 | 60 | 120, default 0), `on`. Keep the queue, the settle timer, the "controls off until loaded" rule, and the one-at-a-time saves. Layout (one line, wrapping on a narrow panel):

```
Every night from [23:00] until [06:00] every [once ▾]   (switch)
```

- `every` is a `<select>` with `once`, `15 min`, `30 min`, `60 min`, `120 min`. Choosing `once` hides the until-time and saves `endTime: null, intervalMin: 0`. Choosing an interval shows the until-time (prefilled `06:00`) and saves `endTime: until, intervalMin: n`.
- Both time inputs use the existing settle/blur handling. The held state is `{ id, from, until, every, on }`; a save compares all four.
- Tooltips: `nightlyTime` stays for the start, new `nightlyUntil`, `nightlyEvery`.

- [ ] **Step 4: The run list per night**

In `RunList`, use `groupByNight(runs)`; render per group a header line `t('drawer.patrol.night', { date, count })` (date via the existing `patrolTime`-style helper for a day, or `new Date(night).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' })`), then the rows as now. When every group has one run, still show the headers (one rule, no special case).

- [ ] **Step 5: Locales**

Add to `drawer.patrol` in all four files (en shown; nl/fr/de translated, no em dashes):

```json
"nightly": "Every night from",
"nightlyUntil": "until",
"nightlyUntilTitle": "End of the patrol window",
"nightlyEvery": "every",
"nightlyEveryTitle": "Minutes between two rounds",
"nightlyOnce": "once",
"nightlyMinutes": "{{n}} min",
"night": "Night of {{date}} ({{count}})",
"nightOne": "Night of {{date}}",
```

(use i18next plural keys the way the file already does elsewhere, if it does).

- [ ] **Step 6: Docs**

In `docs/user-guide/dashboard.md`, Night patrol, replace the "Every night at HH:MM" bullet with:

```
- **Every night from HH:MM until HH:MM, every N min.** One patrol schedule per
  mower: a window, an interval and an on/off switch. *Once* is a single round
  at the start time. With an interval the server starts a round at the start
  time and then every N minutes while the round's start lies before the end
  time (an end at or before the start means the next morning). The server
  starts them by itself, so no app needs to be open. A later round is skipped,
  and the schedule says why, when the previous round is still out, the mower is
  not charging on the dock, or its battery is under 50 %. After a round that
  failed, was stopped, or did not dock, the night stops: the mower is not sent
  out again until the next window. Patrol schedules do not appear in the
  Schedule tab or in the stock app's plans. *No mowing after dark* does not
  hold them back; *No mowing in frost* does (Settings → Weather & time). Rain
  does not pause them.
```

and in "Last patrols": "One line for each of the last 30 patrols, grouped per night (a night runs from one noon to the next)".

- [ ] **Step 7: Checks and commit**

Run: `cd dashboard && npx tsx src/utils/patrolNights.check.ts && npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: all pass, build clean.

```bash
git add dashboard/src/api/client.ts dashboard/src/components/dashboard/PatrolPanel.tsx dashboard/src/utils/patrolNights.ts dashboard/src/utils/patrolNights.check.ts dashboard/src/i18n/locales/en.json dashboard/src/i18n/locales/nl.json dashboard/src/i18n/locales/fr.json dashboard/src/i18n/locales/de.json docs/user-guide/dashboard.md
git commit -m "feat(dashboard): the patrol schedule is a window with an interval; the run list is grouped per night"
```
