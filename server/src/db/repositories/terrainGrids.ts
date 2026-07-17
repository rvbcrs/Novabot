import { db } from '../database.js';

export interface TerrainGridRow {
  mower_sn: string;
  cell_size: number;
  sessions: number;
  cells: number;
  obj_sessions: number;
  obj_cells: number;
  updated_at: string;
}

class TerrainGridRepository {
  private _find = db.prepare('SELECT * FROM terrain_grids WHERE mower_sn = ?');
  private _upsert = db.prepare(`
    INSERT INTO terrain_grids (mower_sn, cell_size, sessions, cells, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mower_sn) DO UPDATE SET
      cell_size = excluded.cell_size,
      sessions  = sessions + ?,
      cells     = excluded.cells,
      updated_at = datetime('now')
  `);
  private _upsertObj = db.prepare(`
    INSERT INTO terrain_grids (mower_sn, obj_sessions, obj_cells, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(mower_sn) DO UPDATE SET
      obj_sessions = obj_sessions + ?,
      obj_cells    = excluded.obj_cells,
      updated_at   = datetime('now')
  `);

  findBySn(sn: string): TerrainGridRow | undefined {
    return this._find.get(sn) as TerrainGridRow | undefined;
  }

  upsertMeta(d: { mower_sn: string; cell_size: number; cells: number; sessions_delta: number }): void {
    this._upsert.run(d.mower_sn, d.cell_size, d.sessions_delta, d.cells, d.sessions_delta);
  }

  upsertObjMeta(d: { mower_sn: string; cells: number; sessions_delta: number }): void {
    this._upsertObj.run(d.mower_sn, d.sessions_delta, d.cells, d.sessions_delta);
  }
}

export const terrainGridRepo = new TerrainGridRepository();
