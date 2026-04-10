/**
 * Cut Grass Plan Repository — cut_grass_plans database operations.
 * All queries use prepared statements (SQL injection safe).
 */
import { db } from '../database.js';

export interface CutGrassPlanRow {
  id: number;
  plan_id: string;
  equipment_id: string;
  user_id: string;
  start_time: string | null;
  end_time: string | null;
  weekday: string | null;
  repeat: number;
  repeat_count: number;
  repeat_type: string | null;
  work_time: number | null;
  work_area: string | null;
  work_day: string | null;
  created_at: string;
  updated_at: string;
}

export class CutGrassPlanRepository {
  // ── Prepared statements ──

  private _findByEquipmentAndUser = db.prepare(
    'SELECT * FROM cut_grass_plans WHERE equipment_id = ? AND user_id = ?'
  );
  private _findByUser = db.prepare(
    'SELECT * FROM cut_grass_plans WHERE user_id = ?'
  );
  private _findById = db.prepare(
    'SELECT * FROM cut_grass_plans WHERE plan_id = ?'
  );
  private _findRecentByUser = db.prepare(
    'SELECT * FROM cut_grass_plans WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1'
  );
  private _findRecentByUserAndEquipment = db.prepare(
    'SELECT * FROM cut_grass_plans WHERE user_id = ? AND equipment_id = ? ORDER BY updated_at DESC LIMIT 1'
  );
  private _findRecentByUserAndSn = db.prepare(`
    SELECT p.* FROM cut_grass_plans p
    JOIN equipment e ON e.equipment_id = p.equipment_id
    WHERE p.user_id = ? AND (e.mower_sn = ? OR e.charger_sn = ?)
    ORDER BY p.updated_at DESC LIMIT 1
  `);
  private _findBySnForMachine = db.prepare(`
    SELECT p.* FROM cut_grass_plans p
    JOIN equipment e ON e.equipment_id = p.equipment_id
    WHERE e.mower_sn = ? OR e.charger_sn = ?
    ORDER BY p.updated_at DESC
  `);
  private _create = db.prepare(`
    INSERT INTO cut_grass_plans
      (plan_id, equipment_id, user_id, start_time, end_time, weekday, repeat,
       repeat_count, repeat_type, work_time, work_area, work_day, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  private _update = db.prepare(`
    UPDATE cut_grass_plans SET
      start_time   = COALESCE(?, start_time),
      end_time     = COALESCE(?, end_time),
      weekday      = COALESCE(?, weekday),
      repeat       = COALESCE(?, repeat),
      repeat_count = COALESCE(?, repeat_count),
      repeat_type  = COALESCE(?, repeat_type),
      work_time    = COALESCE(?, work_time),
      work_area    = COALESCE(?, work_area),
      work_day     = COALESCE(?, work_day),
      updated_at   = ?
    WHERE plan_id = ? AND user_id = ?
  `);
  private _delete = db.prepare(
    'DELETE FROM cut_grass_plans WHERE plan_id = ? AND user_id = ?'
  );

  // ── Methods ──

  findByEquipmentAndUser(equipmentId: string, userId: string): CutGrassPlanRow[] {
    return this._findByEquipmentAndUser.all(equipmentId, userId) as CutGrassPlanRow[];
  }

  findByUser(userId: string): CutGrassPlanRow[] {
    return this._findByUser.all(userId) as CutGrassPlanRow[];
  }

  findById(planId: string): CutGrassPlanRow | undefined {
    return this._findById.get(planId) as CutGrassPlanRow | undefined;
  }

  findRecentByUser(userId: string): CutGrassPlanRow | undefined {
    return this._findRecentByUser.get(userId) as CutGrassPlanRow | undefined;
  }

  findRecentByUserAndEquipment(userId: string, equipmentId: string): CutGrassPlanRow | undefined {
    return this._findRecentByUserAndEquipment.get(userId, equipmentId) as CutGrassPlanRow | undefined;
  }

  findRecentByUserAndSn(userId: string, sn: string): CutGrassPlanRow | undefined {
    return this._findRecentByUserAndSn.get(userId, sn, sn) as CutGrassPlanRow | undefined;
  }

  findBySnForMachine(sn: string): CutGrassPlanRow[] {
    return this._findBySnForMachine.all(sn, sn) as CutGrassPlanRow[];
  }

  create(data: {
    planId: string; equipmentId: string; userId: string;
    startTime?: string | null; endTime?: string | null;
    weekday?: string | null; repeat?: boolean;
    repeatCount?: number; repeatType?: string | null;
    workTime?: number | null; workArea?: string | null;
    workDay?: string | null;
  }): void {
    const now = new Date().toISOString();
    this._create.run(
      data.planId, data.equipmentId, data.userId,
      data.startTime ?? null, data.endTime ?? null,
      data.weekday ?? null,
      data.repeat ? 1 : 0,
      data.repeatCount ?? 0, data.repeatType ?? null,
      data.workTime ?? null,
      data.workArea ?? null,
      data.workDay ?? null,
      now, now,
    );
  }

  update(planId: string, userId: string, data: {
    startTime?: string | null; endTime?: string | null;
    weekday?: string | null; repeat?: boolean | null;
    repeatCount?: number | null; repeatType?: string | null;
    workTime?: number | null; workArea?: string | null;
    workDay?: string | null;
  }): void {
    this._update.run(
      data.startTime ?? null, data.endTime ?? null,
      data.weekday ?? null,
      data.repeat !== undefined && data.repeat !== null ? (data.repeat ? 1 : 0) : null,
      data.repeatCount ?? null, data.repeatType ?? null,
      data.workTime ?? null,
      data.workArea ?? null,
      data.workDay ?? null,
      new Date().toISOString(),
      planId, userId,
    );
  }

  delete(planId: string, userId: string): void {
    this._delete.run(planId, userId);
  }
}

export const cutGrassPlanRepo = new CutGrassPlanRepository();
