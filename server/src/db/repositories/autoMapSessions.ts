import { db } from '../database.js';

export interface AutoMapSession {
  id: number;
  sn: string;
  mode: 'test' | 'record';
  phase: string;
  radius_m: number;
  result_code: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const FINAL_PHASES = ['done', 'rejected', 'error', 'aborted'];

export function createSession(sn: string, mode: 'test' | 'record', radiusM: number): AutoMapSession {
  const info = db.prepare(
    `INSERT INTO auto_map_sessions (sn, mode, radius_m) VALUES (?, ?, ?)`
  ).run(sn, mode, radiusM);
  return db.prepare(`SELECT * FROM auto_map_sessions WHERE id = ?`)
    .get(info.lastInsertRowid) as AutoMapSession;
}

export function updatePhase(
  id: number,
  phase: string,
  patch: { result_code?: number | null; error?: string | null; finished?: boolean } = {},
): void {
  db.prepare(
    `UPDATE auto_map_sessions SET phase = ?,
       result_code = COALESCE(?, result_code),
       error = COALESCE(?, error),
       finished_at = CASE WHEN ? THEN datetime('now') ELSE finished_at END
     WHERE id = ?`
  ).run(phase, patch.result_code ?? null, patch.error ?? null, patch.finished ? 1 : 0, id);
}

export function getActiveSession(sn: string): AutoMapSession | undefined {
  return db.prepare(
    `SELECT * FROM auto_map_sessions
     WHERE sn = ? AND phase NOT IN (${FINAL_PHASES.map(() => '?').join(',')})
     ORDER BY id DESC LIMIT 1`
  ).get(sn, ...FINAL_PHASES) as AutoMapSession | undefined;
}

export function getLatestSession(sn: string): AutoMapSession | undefined {
  return db.prepare(
    `SELECT * FROM auto_map_sessions WHERE sn = ? ORDER BY id DESC LIMIT 1`
  ).get(sn) as AutoMapSession | undefined;
}
