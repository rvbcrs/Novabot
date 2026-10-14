/**
 * Which night patrol run a report of the mower belongs to, and what the broker
 * mirrors of it. The run the server started last is on disk (patrol_runs), so
 * all of this holds across a server restart in the middle of a patrol.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import { patrolRunsRepo } from '../db/repositories/patrolRuns.js';
import { PATROL_DRIVE_PHASES } from './edgeCutGuard.js';

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
      changes: new Map([['patrol_phase', b.phase], ['patrol_error', b.phase === 'error' ? (error ?? 'unknown') : '']]),
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
