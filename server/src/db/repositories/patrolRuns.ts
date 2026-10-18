/**
 * Patrol runs: per mower the night patrol the server started last (the run,
 * its upload token, when it started, the schedule that started it) and the
 * end of it the server handled. See services/patrolRuns.ts.
 */
import { db } from '../database.js';

export interface PatrolRunRow {
  mower_sn: string;
  run: string;
  token: string;
  /** Epoch ms. */
  started_at: number;
  schedule_id: string | null;
  /** The terminal phase the server acted on (done | error | stopped), null while the run is out. */
  ended_phase: string | null;
  /** Epoch ms: the mower did not end on the dock after the server sent it home for this run. Null: no failed docking seen. */
  dock_failed_at: number | null;
  /** The error or stop flag the run's end came with (patrol_status). Null: the run is out, or its end carried none. */
  ended_error: string | null;
  /** The checkpoints the run was started with, JSON [{ zone, points: [[x, y], ...] }]. Null: a run from before this was kept. */
  plan: string | null;
}

class PatrolRunsRepository {
  private _get = db.prepare('SELECT * FROM patrol_runs WHERE mower_sn = ?');
  private _start = db.prepare(`
    INSERT INTO patrol_runs (mower_sn, run, token, started_at, schedule_id, ended_phase)
    VALUES (@mower_sn, @run, @token, @started_at, @schedule_id, NULL)
    ON CONFLICT(mower_sn) DO UPDATE SET
      run = excluded.run, token = excluded.token, started_at = excluded.started_at,
      schedule_id = excluded.schedule_id, ended_phase = NULL, dock_failed_at = NULL,
      ended_error = NULL, plan = NULL
  `);
  private _markEnded = db.prepare(
    'UPDATE patrol_runs SET ended_phase = ? WHERE mower_sn = ? AND run = ? AND ended_phase IS NULL',
  );
  private _recordEnded = db.prepare(`
    INSERT INTO patrol_runs (mower_sn, run, token, started_at, schedule_id, ended_phase)
    VALUES (@mower_sn, @run, '', @started_at, NULL, @ended_phase)
    ON CONFLICT(mower_sn) DO UPDATE SET
      run = excluded.run, token = '', started_at = excluded.started_at,
      schedule_id = NULL, ended_phase = excluded.ended_phase, dock_failed_at = NULL,
      ended_error = NULL, plan = NULL
    WHERE patrol_runs.ended_phase IS NOT NULL OR patrol_runs.started_at < @stale_before
  `);
  private _markDockFailed = db.prepare(
    'UPDATE patrol_runs SET dock_failed_at = ? WHERE mower_sn = ? AND run = ? AND dock_failed_at IS NULL',
  );
  private _setPlan = db.prepare('UPDATE patrol_runs SET plan = ? WHERE mower_sn = ? AND run = ?');
  private _setEndError = db.prepare(
    'UPDATE patrol_runs SET ended_error = ? WHERE mower_sn = ? AND run = ? AND ended_phase IS NOT NULL',
  );
  private _clearAll = db.prepare('DELETE FROM patrol_runs');

  get(sn: string): PatrolRunRow | undefined {
    return this._get.get(sn) as PatrolRunRow | undefined;
  }

  /** A new run replaces the mower's last one. */
  start(row: Omit<PatrolRunRow, 'ended_phase' | 'dock_failed_at' | 'ended_error' | 'plan'>): void {
    this._start.run(row);
  }

  /** Keep the checkpoints `run` was started with (JSON). False when `run` is not the mower's last. */
  setPlan(sn: string, run: string, plan: string): boolean {
    return this._setPlan.run(plan, sn, run).changes > 0;
  }

  /**
   * Keep the error or stop flag the end of `run` came with. It comes after the
   * run's end (markEnded / recordEnded), so a run that is still out keeps none.
   * False when `run` is not the mower's last, or has not ended.
   */
  setEndError(sn: string, run: string, error: string): boolean {
    return this._setEndError.run(error, sn, run).changes > 0;
  }

  /** Record the end of `run`. False when that run is not the mower's last, or its end was recorded before. */
  markEnded(sn: string, run: string, phase: string): boolean {
    return this._markEnded.run(phase, sn, run).changes > 0;
  }

  /**
   * Record that the mower did not end on the dock after the go home for `run`.
   * It comes after the run's end, so ended_phase does not matter. False when
   * `run` is not the mower's last run, or the failure was recorded before.
   */
  markDockFailed(sn: string, run: string, at: number): boolean {
    return this._markDockFailed.run(at, sn, run).changes > 0;
  }

  /** The end of a run this database has no row for (restored or reset): it becomes the
   *  mower's last run, ended, without a token (no uploads). Never over a live run: the
   *  row is only replaced when it has ended or started before `staleBefore` (its TTL). */
  recordEnded(sn: string, run: string, phase: string, startedAt: number, staleBefore: number): void {
    this._recordEnded.run({ mower_sn: sn, run, started_at: startedAt, ended_phase: phase, stale_before: staleBefore });
  }

  /** Tests only. */
  clearAll(): void {
    this._clearAll.run();
  }
}

export const patrolRunsRepo = new PatrolRunsRepository();
