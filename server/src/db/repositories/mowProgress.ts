/**
 * Mow progress: where the mower was inside its coverage task, kept on disk
 * so a lost task (power cut, reboot) can be resumed from that point (#86).
 */
import { db } from '../database.js';

export interface MowProgressRow {
  mower_sn: string;
  map_id: string | null;
  canonical_name: string | null;
  /** Lane direction in degrees from north, as the start command sent it. */
  direction_deg: number;
  last_x: number;
  last_y: number;
  /** Which side of the lane through (last_x, last_y) was already mowed:
   *  sign of the sweep-axis coordinate of the trail relative to that lane.
   *  0 = unknown. */
  mowed_sign: number;
  percent: number;
  updated_at: string;
}

export type MowProgressUpsert = Omit<MowProgressRow, 'updated_at'>;

class MowProgressRepository {
  private _get = db.prepare('SELECT * FROM mow_progress WHERE mower_sn = ?');
  private _upsert = db.prepare(`
    INSERT INTO mow_progress (mower_sn, map_id, canonical_name, direction_deg, last_x, last_y, mowed_sign, percent, updated_at)
    VALUES (@mower_sn, @map_id, @canonical_name, @direction_deg, @last_x, @last_y, @mowed_sign, @percent, datetime('now'))
    ON CONFLICT(mower_sn) DO UPDATE SET
      map_id = excluded.map_id, canonical_name = excluded.canonical_name,
      direction_deg = excluded.direction_deg, last_x = excluded.last_x, last_y = excluded.last_y,
      mowed_sign = excluded.mowed_sign, percent = excluded.percent, updated_at = excluded.updated_at
  `);
  private _delete = db.prepare('DELETE FROM mow_progress WHERE mower_sn = ?');

  get(sn: string): MowProgressRow | undefined {
    return this._get.get(sn) as MowProgressRow | undefined;
  }
  upsert(row: MowProgressUpsert): void {
    this._upsert.run(row);
  }
  delete(sn: string): void {
    this._delete.run(sn);
  }
}

export const mowProgressRepo = new MowProgressRepository();
