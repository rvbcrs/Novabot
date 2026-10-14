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
}

class PatrolRunsRepository {
  private _get = db.prepare('SELECT * FROM patrol_runs WHERE mower_sn = ?');
  private _start = db.prepare(`
    INSERT INTO patrol_runs (mower_sn, run, token, started_at, schedule_id, ended_phase)
    VALUES (@mower_sn, @run, @token, @started_at, @schedule_id, NULL)
    ON CONFLICT(mower_sn) DO UPDATE SET
      run = excluded.run, token = excluded.token, started_at = excluded.started_at,
      schedule_id = excluded.schedule_id, ended_phase = NULL
  `);
  private _markEnded = db.prepare(
    'UPDATE patrol_runs SET ended_phase = ? WHERE mower_sn = ? AND run = ? AND ended_phase IS NULL',
  );
  private _recordEnded = db.prepare(`
    INSERT INTO patrol_runs (mower_sn, run, token, started_at, schedule_id, ended_phase)
    VALUES (@mower_sn, @run, '', @started_at, NULL, @ended_phase)
    ON CONFLICT(mower_sn) DO UPDATE SET
      run = excluded.run, token = '', started_at = excluded.started_at,
      schedule_id = NULL, ended_phase = excluded.ended_phase
    WHERE patrol_runs.ended_phase IS NOT NULL OR patrol_runs.started_at < @stale_before
  `);
  private _clearAll = db.prepare('DELETE FROM patrol_runs');

  get(sn: string): PatrolRunRow | undefined {
    return this._get.get(sn) as PatrolRunRow | undefined;
  }

  /** A new run replaces the mower's last one. */
  start(row: Omit<PatrolRunRow, 'ended_phase'>): void {
    this._start.run(row);
  }

  /** Record the end of `run`. False when that run is not the mower's last, or its end was recorded before. */
  markEnded(sn: string, run: string, phase: string): boolean {
    return this._markEnded.run(phase, sn, run).changes > 0;
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
