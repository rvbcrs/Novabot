/**
 * Schedule Repository — dashboard_schedules + rain_sessions database operations.
 * All queries use prepared statements (SQL injection safe).
 */
import { db } from '../database.js';

export interface ScheduleRow {
  id: number;
  schedule_id: string;
  mower_sn: string;
  schedule_name: string | null;
  start_time: string;
  end_time: string | null;
  weekdays: string;
  enabled: number;
  map_id: string | null;
  map_name: string | null;
  cutting_height: number;
  path_direction: number;
  work_mode: number;
  task_mode: number;
  edge_offset: number;
  rain_pause: number;
  rain_threshold_mm: number;
  rain_threshold_probability: number;
  rain_check_hours: number;
  alternate_direction: number;
  alternate_step: number;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RainSessionRow {
  id: number;
  session_id: string;
  schedule_id: string;
  mower_sn: string;
  state: string;
  map_id: string | null;
  map_name: string | null;
  cutting_height: number;
  path_direction: number;
  work_mode: number;
  task_mode: number;
  edge_offset: number;
  rain_threshold_mm: number;
  rain_threshold_probability: number;
  rain_check_hours: number;
  paused_at: string;
  resumed_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export class ScheduleRepository {
  // ── Dashboard schedules — prepared statements ──

  private _findByMowerSn = db.prepare(
    'SELECT * FROM dashboard_schedules WHERE mower_sn = ? ORDER BY created_at DESC'
  );
  private _findByMowerSnOrderByStartTime = db.prepare(
    'SELECT * FROM dashboard_schedules WHERE mower_sn = ? ORDER BY start_time'
  );
  private _findById = db.prepare(
    'SELECT * FROM dashboard_schedules WHERE schedule_id = ?'
  );
  private _findByIdAndMower = db.prepare(
    'SELECT * FROM dashboard_schedules WHERE schedule_id = ? AND mower_sn = ?'
  );
  private _findEnabled = db.prepare(
    'SELECT * FROM dashboard_schedules WHERE enabled = 1'
  );
  private _findEnabledWithRainPause = db.prepare(
    'SELECT * FROM dashboard_schedules WHERE enabled = 1 AND rain_pause = 1'
  );
  private _findDistinctMowersWithRainPause = db.prepare(
    'SELECT DISTINCT mower_sn FROM dashboard_schedules WHERE enabled = 1 AND rain_pause = 1'
  );
  private _findActiveRainSchedule = db.prepare(
    'SELECT * FROM dashboard_schedules WHERE mower_sn = ? AND enabled = 1 AND rain_pause = 1 ORDER BY last_triggered_at DESC LIMIT 1'
  );
  private _updateLastTriggered = db.prepare(
    "UPDATE dashboard_schedules SET last_triggered_at = datetime('now') WHERE schedule_id = ?"
  );
  private _delete = db.prepare(
    'DELETE FROM dashboard_schedules WHERE schedule_id = ?'
  );
  private _deleteByIdAndMower = db.prepare(
    'DELETE FROM dashboard_schedules WHERE schedule_id = ? AND mower_sn = ?'
  );

  // ── Rain sessions — prepared statements ──

  private _findRainSessionByMower = db.prepare(
    'SELECT * FROM rain_sessions WHERE mower_sn = ? AND state = ?'
  );
  private _findPausedRainSessions = db.prepare(
    "SELECT * FROM rain_sessions WHERE state = 'paused'"
  );
  private _findPausedRainSessionsByMower = db.prepare(
    "SELECT * FROM rain_sessions WHERE mower_sn = ? AND state = 'paused' ORDER BY paused_at DESC"
  );
  private _findRainSessionForCompletion = db.prepare(
    "SELECT * FROM rain_sessions WHERE mower_sn = ? AND state IN ('paused', 'resuming') ORDER BY paused_at DESC LIMIT 1"
  );
  private _createRainSession = db.prepare(`
    INSERT INTO rain_sessions (
      session_id, schedule_id, mower_sn, state,
      map_id, map_name, cutting_height, path_direction,
      work_mode, task_mode, edge_offset,
      rain_threshold_mm, rain_threshold_probability, rain_check_hours
    ) VALUES (?, ?, ?, 'paused', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  private _updateRainSessionState = db.prepare(
    'UPDATE rain_sessions SET state = ?, resumed_at = ? WHERE session_id = ?'
  );
  private _cancelRainSession = db.prepare(
    "UPDATE rain_sessions SET state = 'cancelled', completed_at = datetime('now') WHERE session_id = ?"
  );
  private _completeRainSession = db.prepare(
    "UPDATE rain_sessions SET state = 'completed', completed_at = datetime('now') WHERE session_id = ?"
  );
  private _resumeRainSession = db.prepare(
    "UPDATE rain_sessions SET state = 'resumed', resumed_at = datetime('now') WHERE session_id = ?"
  );

  // ── Dashboard schedules — methods ──

  findByMowerSn(sn: string): ScheduleRow[] {
    return this._findByMowerSn.all(sn) as ScheduleRow[];
  }

  findById(scheduleId: string): ScheduleRow | undefined {
    return this._findById.get(scheduleId) as ScheduleRow | undefined;
  }

  findByIdAndMower(scheduleId: string, mowerSn: string): ScheduleRow | undefined {
    return this._findByIdAndMower.get(scheduleId, mowerSn) as ScheduleRow | undefined;
  }

  findByMowerSnOrderByStartTime(sn: string): ScheduleRow[] {
    return this._findByMowerSnOrderByStartTime.all(sn) as ScheduleRow[];
  }

  findEnabled(): ScheduleRow[] {
    return this._findEnabled.all() as ScheduleRow[];
  }

  findEnabledWithRainPause(): ScheduleRow[] {
    return this._findEnabledWithRainPause.all() as ScheduleRow[];
  }

  findDistinctMowersWithRainPause(): string[] {
    const rows = this._findDistinctMowersWithRainPause.all() as Array<{ mower_sn: string }>;
    return rows.map(r => r.mower_sn);
  }

  findActiveRainSchedule(mowerSn: string): ScheduleRow | undefined {
    return this._findActiveRainSchedule.get(mowerSn) as ScheduleRow | undefined;
  }

  create(data: Partial<ScheduleRow> & { schedule_id: string; mower_sn: string; start_time: string }): void {
    db.prepare(`
      INSERT INTO dashboard_schedules (
        schedule_id, mower_sn, schedule_name, start_time, end_time, weekdays, enabled,
        map_id, map_name, cutting_height, path_direction, work_mode, task_mode,
        edge_offset, rain_pause, rain_threshold_mm, rain_threshold_probability,
        rain_check_hours, alternate_direction, alternate_step
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.schedule_id, data.mower_sn, data.schedule_name ?? null,
      data.start_time, data.end_time ?? null, data.weekdays ?? '[]', data.enabled ?? 1,
      data.map_id ?? null, data.map_name ?? null, data.cutting_height ?? 40,
      data.path_direction ?? 0, data.work_mode ?? 0, data.task_mode ?? 0,
      data.edge_offset ?? 0, data.rain_pause ?? 0, data.rain_threshold_mm ?? 0.5,
      data.rain_threshold_probability ?? 50, data.rain_check_hours ?? 2,
      data.alternate_direction ?? 0, data.alternate_step ?? 90,
    );
  }

  update(scheduleId: string, data: Partial<ScheduleRow>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    const updatable: Array<[keyof ScheduleRow, unknown]> = [
      ['schedule_name', data.schedule_name],
      ['start_time', data.start_time],
      ['end_time', data.end_time],
      ['weekdays', data.weekdays],
      ['enabled', data.enabled],
      ['map_id', data.map_id],
      ['map_name', data.map_name],
      ['cutting_height', data.cutting_height],
      ['path_direction', data.path_direction],
      ['work_mode', data.work_mode],
      ['task_mode', data.task_mode],
      ['edge_offset', data.edge_offset],
      ['rain_pause', data.rain_pause],
      ['rain_threshold_mm', data.rain_threshold_mm],
      ['rain_threshold_probability', data.rain_threshold_probability],
      ['rain_check_hours', data.rain_check_hours],
      ['alternate_direction', data.alternate_direction],
      ['alternate_step', data.alternate_step],
    ];

    for (const [key, value] of updatable) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return;

    fields.push("updated_at = datetime('now')");
    values.push(scheduleId);

    db.prepare(`UPDATE dashboard_schedules SET ${fields.join(', ')} WHERE schedule_id = ?`).run(...values);
  }

  updateByIdAndMower(scheduleId: string, mowerSn: string, data: Partial<ScheduleRow>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    const updatable: Array<[keyof ScheduleRow, unknown]> = [
      ['schedule_name', data.schedule_name],
      ['start_time', data.start_time],
      ['end_time', data.end_time],
      ['weekdays', data.weekdays],
      ['enabled', data.enabled],
      ['map_id', data.map_id],
      ['map_name', data.map_name],
      ['cutting_height', data.cutting_height],
      ['path_direction', data.path_direction],
      ['work_mode', data.work_mode],
      ['task_mode', data.task_mode],
      ['edge_offset', data.edge_offset],
      ['rain_pause', data.rain_pause],
      ['rain_threshold_mm', data.rain_threshold_mm],
      ['rain_threshold_probability', data.rain_threshold_probability],
      ['rain_check_hours', data.rain_check_hours],
      ['alternate_direction', data.alternate_direction],
      ['alternate_step', data.alternate_step],
    ];

    for (const [key, value] of updatable) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return;

    fields.push("updated_at = datetime('now')");
    values.push(scheduleId, mowerSn);

    db.prepare(`UPDATE dashboard_schedules SET ${fields.join(', ')} WHERE schedule_id = ? AND mower_sn = ?`)
      .run(...values);
  }

  delete(scheduleId: string): void {
    this._delete.run(scheduleId);
  }

  deleteByIdAndMower(scheduleId: string, mowerSn: string): void {
    this._deleteByIdAndMower.run(scheduleId, mowerSn);
  }

  updateLastTriggered(scheduleId: string): void {
    this._updateLastTriggered.run(scheduleId);
  }

  // ── Rain sessions — methods ──

  findRainSessionByMower(mowerSn: string, state: string): RainSessionRow | undefined {
    return this._findRainSessionByMower.get(mowerSn, state) as RainSessionRow | undefined;
  }

  findPausedRainSessions(): RainSessionRow[] {
    return this._findPausedRainSessions.all() as RainSessionRow[];
  }

  findPausedRainSessionsByMower(mowerSn: string): RainSessionRow[] {
    return this._findPausedRainSessionsByMower.all(mowerSn) as RainSessionRow[];
  }

  findRainSessionForCompletion(mowerSn: string): RainSessionRow | undefined {
    return this._findRainSessionForCompletion.get(mowerSn) as RainSessionRow | undefined;
  }

  createRainSession(
    sessionId: string, scheduleId: string, mowerSn: string,
    mapId: string | null, mapName: string | null, cuttingHeight: number,
    pathDirection: number, workMode: number, taskMode: number, edgeOffset: number,
    rainThresholdMm: number, rainThresholdProbability: number, rainCheckHours: number,
  ): void {
    this._createRainSession.run(
      sessionId, scheduleId, mowerSn,
      mapId, mapName, cuttingHeight, pathDirection, workMode, taskMode, edgeOffset,
      rainThresholdMm, rainThresholdProbability, rainCheckHours,
    );
  }

  resumeRainSession(sessionId: string): void {
    this._resumeRainSession.run(sessionId);
  }

  cancelRainSession(sessionId: string): void {
    this._cancelRainSession.run(sessionId);
  }

  completeRainSession(sessionId: string): void {
    this._completeRainSession.run(sessionId);
  }

  updateRainSessionState(sessionId: string, state: string, resumedAt?: string | null): void {
    this._updateRainSessionState.run(state, resumedAt ?? null, sessionId);
  }
}

export const scheduleRepo = new ScheduleRepository();
