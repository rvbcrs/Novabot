import { db } from '../database.js';

export interface TerrainClusterRow {
  mower_sn: string;
  cluster_key: string;
  cx: number;
  cy: number;
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
  cells: number;
  max_h: number;
  class_name: string | null;
  confidence: number | null;
  crop_file: string | null;
  user_override: string | null;
  updated_at: string;
}

export interface TerrainClusterUpsert {
  mower_sn: string;
  cluster_key: string;
  cx: number;
  cy: number;
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
  cells: number;
  max_h: number;
  class_name: string | null;
  confidence: number | null;
  crop_file: string | null;
}

class TerrainClusterRepository {
  private _findBySn = db.prepare('SELECT * FROM terrain_clusters WHERE mower_sn = ?');
  private _setOverride = db.prepare(`
    UPDATE terrain_clusters SET user_override = ?, updated_at = datetime('now')
    WHERE mower_sn = ? AND cluster_key = ?
  `);
  // ON CONFLICT-update ververst model-velden + geometrie, maar raakt
  // user_override bewust NIET aan: een handmatige correctie moet een
  // her-classificatie overleven.
  private _upsert = db.prepare(`
    INSERT INTO terrain_clusters (
      mower_sn, cluster_key, cx, cy, min_x, min_y, max_x, max_y, cells, max_h,
      class_name, confidence, crop_file, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mower_sn, cluster_key) DO UPDATE SET
      cx         = excluded.cx,
      cy         = excluded.cy,
      min_x      = excluded.min_x,
      min_y      = excluded.min_y,
      max_x      = excluded.max_x,
      max_y      = excluded.max_y,
      cells      = excluded.cells,
      max_h      = excluded.max_h,
      class_name = excluded.class_name,
      confidence = excluded.confidence,
      crop_file  = excluded.crop_file,
      updated_at = datetime('now')
  `);

  upsert(row: TerrainClusterUpsert): void {
    this._upsert.run(
      row.mower_sn,
      row.cluster_key,
      row.cx,
      row.cy,
      row.min_x,
      row.min_y,
      row.max_x,
      row.max_y,
      row.cells,
      row.max_h,
      row.class_name,
      row.confidence,
      row.crop_file
    );
  }

  findBySn(sn: string): TerrainClusterRow[] {
    return this._findBySn.all(sn) as TerrainClusterRow[];
  }

  setOverride(sn: string, clusterKey: string, className: string | null): void {
    this._setOverride.run(className, sn, clusterKey);
  }
}

export const terrainClusterRepo = new TerrainClusterRepository();
