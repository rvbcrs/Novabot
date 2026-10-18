/**
 * Which night patrol run a report of the mower belongs to, and what the broker
 * mirrors of it. The run the server started last is on disk (patrol_runs), so
 * all of this holds across a server restart in the middle of a patrol. Also
 * the command list a mower announces (ext_hello), which the patrol start reads,
 * and what the dashboard's patrol report reads off a run's row (patrolRunOutcome).
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import { patrolRunsRepo, type PatrolRunRow } from '../db/repositories/patrolRuns.js';
import { PATROL_DRIVE_PHASES } from './edgeCutGuard.js';
import type { PatrolRun } from './patrolFrames.js';
import type { PatrolZone } from './patrolRoute.js';

/** How long a patrol run counts as out after its start (also its upload window). */
export const PATROL_RUN_TTL_MS = 6 * 3_600_000;

/** A run id as the server makes them, String(Date.now()). */
function isRun(run: unknown): run is string {
  return typeof run === 'string' && /^\d{1,20}$/.test(run);
}

/**
 * True when `run` is older than the patrol this server started last for the
 * mower: a late report of a run that a newer patrol took over. Runs are
 * compared as numbers. A report without a run is never older.
 */
export function isOlderPatrolRun(sn: string, run: unknown): boolean {
  const last = patrolRunsRepo.get(sn)?.run;
  return isRun(run) && isRun(last) && BigInt(run) < BigInt(last);
}

/** True when `run` is the patrol this server started last and its end has not been handled. */
export function isLivePatrolRun(sn: string, run: unknown): boolean {
  const last = patrolRunsRepo.get(sn);
  return isRun(run) && !!last && last.run === run && !last.ended_phase;
}

export const PATROL_END_PHASES = new Set(['done', 'error', 'stopped']);

/**
 * True while a night patrol drives this mower: a driving phase in the cache AND
 * a run that is out (started, its end not handled, within PATROL_RUN_TTL_MS). A
 * cached phase alone never expires (a lost end, a reboot), and the gates that
 * keep a patrol apart from the rain pause, the mowing pushes, the always-edge
 * watcher and the edge cut must not hold for ever on it.
 */
export function isPatrolDriving(sn: string, cachedPhase: string | undefined, now = Date.now()): boolean {
  if (!PATROL_DRIVE_PHASES.has(cachedPhase ?? '')) return false;
  const last = patrolRunsRepo.get(sn);
  return !!last && !last.ended_phase && now - last.started_at <= PATROL_RUN_TTL_MS;
}

/** How long the drive home after a patrol counts as the patrol's at most. */
export const PATROL_DOCKING_MAX_MS = 15 * 60_000;

interface PatrolDocking {
  /** When the server sent the mower home. */
  since: number;
  /** The run that go home belongs to (the mower's last run then), null without a run row. */
  run: string | null;
  /** The failure of this go home was reported (patrolDockingFailed). */
  failureReported: boolean;
}
// The server's go home after a patrol, per mower. In memory: a restart inside the
// 15 minutes loses it, and the generic detectors take over.
const docking = new Map<string, PatrolDocking>();

/** The server sends the mower home after a patrol (patrolService). */
export function markPatrolDocking(sn: string, now = Date.now()): void {
  docking.set(sn, { since: now, run: patrolRunsRepo.get(sn)?.run ?? null, failureReported: false });
}

/**
 * True while the drive home after a patrol is under way: from the server's go
 * home until the mower reports docked or charging, at most
 * PATROL_DOCKING_MAX_MS. On its way the firmware reports Work:MOVING, which is
 * no mow. The first docked report still belongs to the docking and ends it, so
 * a later departure is a mow again.
 */
export function patrolDockingUnderWay(sn: string, docked: boolean, now = Date.now()): boolean {
  const d = docking.get(sn);
  if (d === undefined) return false;
  if (now - d.since > PATROL_DOCKING_MAX_MS) {
    docking.delete(sn);
    return false;
  }
  if (docked) docking.delete(sn);
  return true;
}

/**
 * The error code that says the recharge failed when the msg does not: 126 is
 * "Return-to-charge failed" (MOVE_ROBOT_FAIL, nav2 refusing the goal at the pile
 * pose, live 2026-10-15). The error_status sensor, as the dashboard shows it.
 * Not 113 ("no aruco code find"): it comes up while the firmware retries the
 * alignment at the dock and goes away again, so it is no failure by itself. A 113
 * that is followed by `Recharge: FAILED` raises through that trigger.
 */
export const DOCK_FAILED_ERROR_CODES: ReadonlySet<number> = new Set([126]);

export interface PatrolDockingFailure {
  /** The run whose go home failed, null when the mower had no run row then. */
  run: string | null;
  /** False when this go home's failure was reported before: nothing more to say. */
  first: boolean;
}

/**
 * The mower reports the recharge failed (the msg says `Recharge: FAILED`, or
 * error 126 came up; the caller edge-detects that) while it is not charging
 * (`docked` false). Non-null when that is the drive home the server sent after a
 * patrol, within PATROL_DOCKING_MAX_MS: the first time per go home it records the
 * failure on the run (patrol_runs.dock_failed_at) and says `first`, so the caller
 * raises ONE dock_failed with the patrol's context; after that `first` is false.
 * Null when it is not that: no go home, 15 minutes gone, the mower charging, or a
 * patrol that started since (it owns the mower now). The caller then leaves the
 * failure to the generic dock_failed detector, unchanged.
 */
export function patrolDockingFailed(sn: string, docked: boolean, now = Date.now()): PatrolDockingFailure | null {
  const d = docking.get(sn);
  if (d === undefined || docked || now - d.since > PATROL_DOCKING_MAX_MS) return null;
  if (d.run !== (patrolRunsRepo.get(sn)?.run ?? null)) return null;
  if (d.failureReported) return { run: d.run, first: false };
  d.failureReported = true;
  if (d.run) patrolRunsRepo.markDockFailed(sn, d.run, now);
  return { run: d.run, first: true };
}

/** Tests only. */
export function _resetPatrolDocking(): void {
  docking.clear();
}

/**
 * True for a phase on the way (not an end) of the run whose end was handled
 * already. The mower re-sends its last status after a reconnect, and one that
 * left just before the end can arrive after it: it must not put the phase back
 * on `patrolling` or switch the headlight on again.
 */
export function isAfterPatrolEnd(sn: string, phase: string, run: unknown): boolean {
  const last = patrolRunsRepo.get(sn);
  return !PATROL_END_PHASES.has(phase) && isRun(run) && !!last && last.run === run && !!last.ended_phase;
}

export interface PatrolMirror {
  /** patrol_phase and patrol_error, for the device cache and the dashboard. */
  changes: Map<string, string>;
  /** A status for patrolService.onPatrolStatus, with its run. */
  status?: { phase: string; error?: string; run?: string };
  /** A start the mower refused, for patrolService.onPatrolRefused. */
  refused?: { error: string };
}

/**
 * What the broker does with a patrol report on novabot/extended_response.
 * - patrol_status: mirror the phase and pass it on with its run, unless the
 *   run is older than the one the server started last, or it is a phase on
 *   the way of a run whose end was handled. A late `stopped` of a run a newer
 *   patrol took over must not overwrite the newer run's phase: every stop path
 *   keys on that phase.
 * - patrol_checkpoint of the live run while the cached phase is not a driving
 *   phase: the evidence that the patrol is out (its `patrolling` got lost, or
 *   the server restarted). The phase is `patrolling` again, so every stop
 *   path reaches the patrol.
 * - patrol_respond with result 1: the mower refused the start before anything
 *   moved; an error with its reason.
 * Null: nothing to do.
 */
export function patrolReport(
  sn: string, cmdName: string, body: unknown, cachedPhase: string | undefined,
): PatrolMirror | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const error = typeof b.error === 'string' && b.error ? b.error : undefined;
  if (cmdName === 'patrol_status') {
    if (typeof b.phase !== 'string' || !b.phase || isOlderPatrolRun(sn, b.run)
        || isAfterPatrolEnd(sn, b.phase, b.run)) return null;
    return {
      // A `stopped` with a flag (STOP button, lift, tilt) keeps it, so the card can say why.
      changes: new Map([['patrol_phase', b.phase],
        ['patrol_error', b.phase === 'error' ? (error ?? 'unknown') : b.phase === 'stopped' ? (error ?? '') : '']]),
      status: { phase: b.phase, error, run: typeof b.run === 'string' ? b.run : undefined },
    };
  }
  if (cmdName === 'patrol_checkpoint') {
    if (!isLivePatrolRun(sn, b.run) || PATROL_DRIVE_PHASES.has(cachedPhase ?? '')) return null;
    return { changes: new Map([['patrol_phase', 'patrolling'], ['patrol_error', '']]) };
  }
  if (cmdName === 'patrol_respond') {
    if (b.result !== 1) return null;
    return {
      changes: new Map([['patrol_phase', 'error'], ['patrol_error', error ?? 'unknown']]),
      refused: { error: error ?? 'unknown' },
    };
  }
  return null;
}

/** Device cache key of the command names a mower announced (ext_hello). */
export const EXT_COMMANDS_KEY = 'ext_commands';

/**
 * What the broker mirrors of an `ext_hello` on novabot/extended_response/<SN>.
 * After every connect extended_commands.py announces the keys of its command
 * table, `{"ext_hello": {"commands": ["...", ...]}}`. They are cached as a JSON
 * array under EXT_COMMANDS_KEY, so a mower whose extended_commands.py was
 * updated by hand is known by what it can do and not by its build number
 * (patrolService.mowerSupportsExtended). The cache goes with the mower's
 * disconnect, and its next connect announces again.
 * Null for a body that is not a list of strings: nothing is cached.
 */
export function extHelloReport(body: unknown): Map<string, string> | null {
  if (!body || typeof body !== 'object') return null;
  const commands = (body as { commands?: unknown }).commands;
  if (!Array.isArray(commands) || !commands.every(c => typeof c === 'string')) return null;
  return new Map([[EXT_COMMANDS_KEY, JSON.stringify(commands)]]);
}

/** What the patrol report shows of a run besides its checkpoint frames (GET /patrol/:sn/runs). */
export interface PatrolRunOutcome {
  /** The checkpoints the run was started with, in the order the mower drives them; null when none were kept. */
  plan: PatrolZone[] | null;
  /** How the run ended; null while it is out. */
  endedPhase: 'done' | 'error' | 'stopped' | null;
  /** The error, or the stop flag (STOP button, lift, tilt), the end came with. */
  error: string | null;
  /** ISO time the mower did not end on the dock after the server's go home, null if it did. */
  dockFailedAt: string | null;
}

/**
 * The plan, end, error and failed docking of `run`, from the mower's patrol_runs
 * row. That table holds one row per mower, the run the server started last, so
 * every other run gets nothing here.
 */
export function patrolRunOutcome(row: PatrolRunRow | undefined, run: string): PatrolRunOutcome {
  if (!row || row.run !== run) return { plan: null, endedPhase: null, error: null, dockFailedAt: null };
  let plan: PatrolZone[] | null = null;
  try {
    const parsed: unknown = row.plan ? JSON.parse(row.plan) : null;
    if (Array.isArray(parsed)) plan = parsed as PatrolZone[];
  } catch { /* unreadable: no plan */ }
  const ended = row.ended_phase;
  const failedAt = row.dock_failed_at == null ? null : new Date(row.dock_failed_at);
  return {
    plan,
    endedPhase: ended === 'done' || ended === 'error' || ended === 'stopped' ? ended : null,
    error: row.ended_error,
    dockFailedAt: failedAt && !Number.isNaN(failedAt.getTime()) ? failedAt.toISOString() : null,
  };
}

/**
 * The runs on disk (patrolFrames.listPatrolRuns), each with its outcome. The run
 * the server started last is listed even when no checkpoint of it is on disk: it
 * has none before its first, and none at all when it ends before reaching one
 * (not localized, a busy mower), and its plan and how it ended are what the
 * report is for then. Newest first, as listPatrolRuns lists them.
 */
export function withPatrolOutcome(runs: PatrolRun[], last: PatrolRunRow | undefined): Array<PatrolRun & PatrolRunOutcome> {
  const out = runs.map(r => ({ ...r, ...patrolRunOutcome(last, r.run) }));
  if (last && !runs.some(r => r.run === last.run)) {
    out.push({ run: last.run, startedAt: Number(last.run), frames: [], ...patrolRunOutcome(last, last.run) });
    out.sort((a, b) => Number(b.run) - Number(a.run));
  }
  return out;
}
