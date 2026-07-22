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
  override_group: string | null;
  model_file: string | null;
  size_override: number | null;
  height_override: number | null;
  z_offset: number | null;
  x_offset: number | null;
  y_offset: number | null;
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
    UPDATE terrain_clusters SET user_override = ?, override_group = ?, updated_at = datetime('now')
    WHERE mower_sn = ? AND cluster_key = ?
  `);
  // custom 3D-model per object — net als user_override raakt de
  // ON CONFLICT-update dit veld nooit aan (her-classificatie overleeft het).
  private _setModelFile = db.prepare(`
    UPDATE terrain_clusters SET model_file = ?, updated_at = datetime('now')
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

  // overrideGroup: tag van de correctie-actie (de aangeklikte sleutel), zodat
  // groupClusters twee losse correcties nooit tot één object samenvoegt.
  setOverride(sn: string, clusterKey: string, className: string | null, overrideGroup: string | null = null): void {
    this._setOverride.run(className, className != null ? overrideGroup : null, sn, clusterKey);
  }

  setModelFile(sn: string, clusterKey: string, file: string | null): void {
    this._setModelFile.run(file, sn, clusterKey);
  }

  private _setDisplay = db.prepare(`
    UPDATE terrain_clusters
    SET size_override = ?, height_override = ?, z_offset = ?, x_offset = ?, y_offset = ?, updated_at = datetime('now')
    WHERE mower_sn = ? AND cluster_key = ?
  `);

  /** Weergave-overrides (alle vijf tegelijk; null = terug naar automatisch). */
  setDisplay(sn: string, clusterKey: string, size: number | null, height: number | null,
             z: number | null, x: number | null, y: number | null): void {
    this._setDisplay.run(size, height, z, x, y, sn, clusterKey);
  }

  private _renameModel = db.prepare(`
    UPDATE terrain_clusters SET model_file = ? WHERE model_file = ?
  `);

  renameModelFile(oldFile: string, newFile: string): number {
    return this._renameModel.run(newFile, oldFile).changes;
  }

  /**
   * Verwijdert de rijen van deze maaier die NIET in `keepKeys` staan — de
   * clusters die na een nieuwe clustering niet meer bestaan. Zonder deze stap
   * blijven wezen eeuwig staan (les 2026-07-20: het 27x22 m "trampoline"-
   * cluster bleef na het opknippen in tegels gewoon over de hele tuin liggen,
   * inclusief de handmatige correctie erop).
   *
   * Retourneert het aantal verwijderde rijen. Bij een lege `keepKeys` wordt
   * er NIETS verwijderd: dat duidt op een mislukte/lege clustering en mag
   * nooit de hele tabel wissen.
   */
  deleteMissingForSn(sn: string, keepKeys: Iterable<string>): number {
    const keep = [...keepKeys];
    if (keep.length === 0) return 0;
    const placeholders = keep.map(() => '?').join(',');
    // 'm%'-sleutels zijn handmatig toegevoegde objecten: die hebben geen
    // voxel-cluster als bestaansbewijs en mogen dus nooit als wees opgeruimd.
    const stmt = db.prepare(
      `DELETE FROM terrain_clusters WHERE mower_sn = ? AND cluster_key NOT LIKE 'm%' AND cluster_key NOT IN (${placeholders})`
    );
    return stmt.run(sn, ...keep).changes;
  }
}

export const terrainClusterRepo = new TerrainClusterRepository();
