/**
 * Map Repository — all map + calibration database operations.
 * All queries use prepared statements (SQL injection safe).
 */
import { db } from '../database.js';

export interface MapRow {
  id: number;
  map_id: string;
  mower_sn: string;
  map_name: string | null;
  map_area: string | null;
  map_max_min: string | null;
  file_name: string | null;
  file_size: number | null;
  map_type: string;
  /**
   * Firmware-canonical slot identifier: `map0`, `map1`, `map0_0_obstacle`,
   * `map0tomap1_0_unicom`, `map0tocharge_unicom`, etc. Combined with `mower_sn`
   * this forms a UNIQUE key so re-uploads from the app (user alias) cannot
   * create duplicate rows next to the mower's own upload.
   */
  canonical_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalibrationRow {
  mower_sn: string;
  offset_lat: number;
  offset_lng: number;
  rotation: number;
  scale: number;
  updated_at: string;
  charger_lat: number | null;
  charger_lng: number | null;
  gps_charger_lat: number | null;
  gps_charger_lng: number | null;
}

export interface CreateMapData {
  map_id: string;
  mower_sn: string;
  map_name?: string | null;
  map_area?: string | null;
  map_max_min?: string | null;
  file_name?: string | null;
  file_size?: number | null;
  map_type?: string;
  /** Caller-supplied canonical name; derived from file_name/map_name when null. */
  canonical_name?: string | null;
}

export interface SetCalibrationData {
  offset_lat?: number;
  offset_lng?: number;
  rotation?: number;
  scale?: number;
  charger_lat?: number | null;
  charger_lng?: number | null;
  gps_charger_lat?: number | null;
  gps_charger_lng?: number | null;
}

/**
 * Extract the canonical `mapN` prefix (e.g. "map0", "map12") from a row.
 * Prefers file_name (always holds the mower's internal name) and falls back
 * to map_name (used on installs that store the shared ZIP as file_name).
 */
function extractCanonicalPrefix(row: Pick<MapRow, 'file_name' | 'map_name'>): string | null {
  const fileMatch = row.file_name?.match(/^(map\d+)(?=[_t])/);
  if (fileMatch) return fileMatch[1];
  const nameMatch = row.map_name?.match(/^(map\d+)(?:$|[_t])/);
  return nameMatch ? nameMatch[1] : null;
}

/**
 * Derive the firmware-canonical slot identifier for a row.
 *
 * Returns the full slot name (e.g. `map0`, `map0_0_obstacle`,
 * `map0tomap1_0_unicom`, `map0tocharge_unicom`). Used as the stable key for
 * dedup: any two rows with the same `(mower_sn, canonical_name)` refer to
 * the same underlying mower-side CSV, regardless of user-assigned alias.
 *
 * Priority:
 *   1. `file_name` when it's a canonical CSV (ignoring the `.csv` suffix and
 *      skipping ZIP filenames).
 *   2. `map_name` when it matches a canonical pattern.
 *   3. null — caller must resolve explicitly (e.g. assign next free slot).
 */
export function deriveCanonicalName(
  row: Pick<MapRow, 'file_name' | 'map_name' | 'map_type'>,
): string | null {
  const tryParse = (value: string | null | undefined): string | null => {
    if (!value) return null;
    // Strip .csv suffix if present
    const base = value.endsWith('.csv') ? value.slice(0, -4) : value;
    // Skip ZIP filenames (e.g. LFIN1231000211_1776458861649.zip)
    if (/\.zip$/i.test(value) || /^LFI[NC]\d+_\d+/.test(base)) return null;
    // Work: map0, map1, map2
    if (/^map\d+$/.test(base) && (row.map_type === 'work' || !row.map_type)) return base;
    // Work CSV: map0_work → map0
    const workMatch = base.match(/^(map\d+)_work$/);
    if (workMatch) return workMatch[1];
    // Obstacle: map0_0_obstacle, map1_3_obstacle
    if (/^map\d+_\d+_obstacle$/.test(base)) return base;
    // Unicom map↔map: map0tomap1_0_unicom
    if (/^map\d+tomap\d+_\d+_unicom$/.test(base)) return base;
    // Unicom map↔charger: map0tocharge_unicom
    if (/^map\d+tocharge_unicom$/.test(base)) return base;
    return null;
  };
  return tryParse(row.file_name) ?? tryParse(row.map_name);
}

/**
 * True when `name` is a firmware-canonical slot label (e.g. `map0`,
 * `map0_3_obstacle`, `map0tomap1_0_unicom`, `map0tocharge_unicom`) or null.
 *
 * Used to protect user-set aliases from being overwritten when the mower
 * (or the Novabot app's cached cloud copy) re-uploads a map with its
 * canonical name as `mapName`. If the existing row already has a user
 * alias like "achter" or "zij", we keep it.
 */
export function isCanonicalMapName(name: string | null | undefined): boolean {
  if (!name) return true;
  return /^map\d+$/.test(name)
    || /^map\d+_\d+_obstacle$/.test(name)
    || /^map\d+tomap\d+_\d+_unicom$/.test(name)
    || /^map\d+tocharge_unicom$/.test(name);
}

/** Check whether `row` is a dependent of the map identified by `prefix`. */
function isRelatedByPrefix(row: Pick<MapRow, 'file_name' | 'map_name'>, prefix: string): boolean {
  const candidates = [row.file_name, row.map_name].filter((v): v is string => !!v);
  // Obstacles owned by this map: e.g. map1_0_obstacle, map1_3_obstacle.csv
  const obstacleRe = new RegExp(`^${prefix}_\\d+_obstacle(\\.|$)`);
  // Unicoms starting from this map: e.g. map1tocharge_unicom, map1tomap2_0_unicom
  const outgoingRe = new RegExp(`^${prefix}to[a-z0-9]+(_|\\.|$)`);
  // Unicoms ending at this map: e.g. map0tomap1_0_unicom
  const incomingRe = new RegExp(`to${prefix}(_|\\.|$)`);
  return candidates.some(v => obstacleRe.test(v) || outgoingRe.test(v) || incomingRe.test(v));
}

export class MapRepository {
  // ── Prepared statements (cached for performance) ──

  // Map lookups
  private _findByMowerSn = db.prepare('SELECT * FROM maps WHERE mower_sn = ? ORDER BY updated_at DESC');
  private _findByMowerSnAndType = db.prepare('SELECT * FROM maps WHERE mower_sn = ? AND map_type = ? ORDER BY updated_at DESC');
  private _findById = db.prepare('SELECT * FROM maps WHERE map_id = ?');
  private _findByIdAndMower = db.prepare('SELECT * FROM maps WHERE map_id = ? AND mower_sn = ?');
  private _findBySnAndCanonical = db.prepare(
    'SELECT * FROM maps WHERE mower_sn = ? AND canonical_name = ?'
  );
  private _findWorkMaps = db.prepare(
    "SELECT * FROM maps WHERE mower_sn = ? AND map_type = 'work' AND map_area IS NOT NULL ORDER BY updated_at DESC"
  );
  private _findWithArea = db.prepare('SELECT * FROM maps WHERE mower_sn = ? AND map_area IS NOT NULL ORDER BY updated_at DESC');
  private _findWithAreaOrderByMapId = db.prepare(
    'SELECT * FROM maps WHERE mower_sn = ? AND map_area IS NOT NULL ORDER BY COALESCE(file_name, map_name), map_id'
  );
  private _findByMowerSnAndTypeWithArea = db.prepare(
    'SELECT * FROM maps WHERE mower_sn = ? AND map_type = ? AND map_area IS NOT NULL ORDER BY COALESCE(file_name, map_name), map_id'
  );
  // Unicom items hoeven geen map_area te hebben — de app checkt alleen fileName voor zone selectie
  private _findByMowerSnAndType2 = db.prepare(
    'SELECT * FROM maps WHERE mower_sn = ? AND map_type = ? ORDER BY COALESCE(file_name, map_name), map_id'
  );
  private _listAll = db.prepare('SELECT * FROM maps ORDER BY updated_at DESC');

  // Map mutations
  private _create = db.prepare(`
    INSERT INTO maps (map_id, mower_sn, map_name, map_area, map_max_min, file_name, file_size, map_type, canonical_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  private _upsert = db.prepare(`
    INSERT OR REPLACE INTO maps (map_id, mower_sn, map_name, map_area, map_max_min, file_name, file_size, map_type, canonical_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  private _updateName = db.prepare("UPDATE maps SET map_name = ?, updated_at = datetime('now') WHERE map_id = ?");
  private _updateNameByIdAndMower = db.prepare(
    "UPDATE maps SET map_name = ?, updated_at = datetime('now') WHERE map_id = ? AND mower_sn = ?"
  );
  private _updateFileName = db.prepare("UPDATE maps SET file_name = ?, updated_at = datetime('now') WHERE map_id = ?");
  private _updateAreaAndBoundsById = db.prepare(
    "UPDATE maps SET map_area = ?, map_max_min = ?, updated_at = datetime('now') WHERE map_id = ?"
  );
  private _updateAreaAndBoundsByIdAndMower = db.prepare(
    "UPDATE maps SET map_area = ?, map_max_min = ?, updated_at = datetime('now') WHERE map_id = ? AND mower_sn = ?"
  );

  // Map deletes
  private _deleteById = db.prepare('DELETE FROM maps WHERE map_id = ?');
  private _deleteByMowerSn = db.prepare('DELETE FROM maps WHERE mower_sn = ?');
  private _deleteByIdAndMower = db.prepare('DELETE FROM maps WHERE map_id = ? AND mower_sn = ?');

  // Map aggregates
  private _count = db.prepare('SELECT COUNT(*) as count FROM maps');
  private _countByMowerSn = db.prepare('SELECT COUNT(*) as count FROM maps WHERE mower_sn = ?');

  // Calibration
  private _getCalibration = db.prepare('SELECT * FROM map_calibration WHERE mower_sn = ?');
  private _setCalibration = db.prepare(`
    INSERT OR REPLACE INTO map_calibration
      (mower_sn, offset_lat, offset_lng, rotation, scale, charger_lat, charger_lng, gps_charger_lat, gps_charger_lng, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  private _getChargerGps = db.prepare('SELECT charger_lat, charger_lng FROM map_calibration WHERE mower_sn = ?');

  // ── Map lookups ──

  findByMowerSn(sn: string): MapRow[] {
    return this._findByMowerSn.all(sn) as MapRow[];
  }

  findByMowerSnAndType(sn: string, type: string): MapRow[] {
    return this._findByMowerSnAndType.all(sn, type) as MapRow[];
  }

  findById(mapId: string): MapRow | undefined {
    return this._findById.get(mapId) as MapRow | undefined;
  }

  findByIdAndMower(mapId: string, mowerSn: string): MapRow | undefined {
    return this._findByIdAndMower.get(mapId, mowerSn) as MapRow | undefined;
  }

  /**
   * Look up a map by its (mower_sn, canonical_name) pair. Used to dedup
   * re-uploads from the app (user alias) against the mower's own upload:
   * both refer to the same firmware slot (e.g. `map0`), so they should
   * collapse to a single row rather than creating a duplicate.
   */
  findBySnAndCanonical(mowerSn: string, canonical: string): MapRow | undefined {
    return this._findBySnAndCanonical.get(mowerSn, canonical) as MapRow | undefined;
  }

  findWorkMaps(mowerSn: string): MapRow[] {
    return this._findWorkMaps.all(mowerSn) as MapRow[];
  }

  findWithArea(mowerSn: string): MapRow[] {
    return this._findWithArea.all(mowerSn) as MapRow[];
  }

  findWithAreaOrderByMapId(mowerSn: string): MapRow[] {
    return this._findWithAreaOrderByMapId.all(mowerSn) as MapRow[];
  }

  findByMowerSnAndTypeWithArea(mowerSn: string, type: string): MapRow[] {
    return this._findByMowerSnAndTypeWithArea.all(mowerSn, type) as MapRow[];
  }

  /** Alle maps van een type, inclusief zonder map_area (nodig voor unicom items) */
  findAllByMowerSnAndType(mowerSn: string, type: string): MapRow[] {
    return this._findByMowerSnAndType2.all(mowerSn, type) as MapRow[];
  }

  listAll(): MapRow[] {
    return this._listAll.all() as MapRow[];
  }

  // ── Map mutations ──

  create(data: CreateMapData): void {
    const mapType = data.map_type ?? 'work';
    const canonical = data.canonical_name !== undefined
      ? data.canonical_name
      : deriveCanonicalName({
          file_name: data.file_name ?? null,
          map_name: data.map_name ?? null,
          map_type: mapType,
        });
    this._create.run(
      data.map_id,
      data.mower_sn,
      data.map_name ?? null,
      data.map_area ?? null,
      data.map_max_min ?? null,
      data.file_name ?? null,
      data.file_size ?? null,
      mapType,
      canonical,
    );
  }

  upsert(data: CreateMapData): void {
    const mapType = data.map_type ?? 'work';
    const canonical = data.canonical_name !== undefined
      ? data.canonical_name
      : deriveCanonicalName({
          file_name: data.file_name ?? null,
          map_name: data.map_name ?? null,
          map_type: mapType,
        });
    this._upsert.run(
      data.map_id,
      data.mower_sn,
      data.map_name ?? null,
      data.map_area ?? null,
      data.map_max_min ?? null,
      data.file_name ?? null,
      data.file_size ?? null,
      mapType,
      canonical,
    );
  }

  updateName(mapId: string, name: string): void {
    this._updateName.run(name, mapId);
  }

  updateNameByIdAndMower(mapId: string, mowerSn: string, name: string | null): void {
    this._updateNameByIdAndMower.run(name, mapId, mowerSn);
  }

  updateFileName(mapId: string, fileName: string): void {
    this._updateFileName.run(fileName, mapId);
  }

  updateAreaAndBoundsById(mapId: string, mapArea: string, mapMaxMin: string): void {
    this._updateAreaAndBoundsById.run(mapArea, mapMaxMin, mapId);
  }

  updateAreaAndBoundsByIdAndMower(mapId: string, mowerSn: string, mapArea: string, mapMaxMin: string): void {
    this._updateAreaAndBoundsByIdAndMower.run(mapArea, mapMaxMin, mapId, mowerSn);
  }

  // ── Map deletes ──

  deleteById(mapId: string): void {
    this._deleteById.run(mapId);
  }

  deleteByMowerSn(mowerSn: string): void {
    this._deleteByMowerSn.run(mowerSn);
  }

  deleteByIdAndMower(mapId: string, mowerSn: string): void {
    this._deleteByIdAndMower.run(mapId, mowerSn);
  }

  /**
   * Delete a work-map row AND its related obstacle/unicom rows in one transaction.
   * Related rows are matched by canonical `mapN` prefix extracted from file_name
   * (e.g. `map1_work.csv` → prefix `map1`) or map_name (e.g. `map1`).
   *
   * Cascades:
   *   - obstacles: file_name LIKE `{prefix}_%_obstacle%` (or map_name for shared-zip installs)
   *   - outgoing unicom: `{prefix}to%` (including `{prefix}tocharge_unicom`)
   *   - incoming unicom: `%to{prefix}\_%` (trailing underscore avoids matching `map10` via `map1`)
   *
   * Returns the list of rows that were deleted, so callers can unlink the
   * associated files and emit a single auto-push afterwards.
   */
  deleteWithCascade(mapId: string, mowerSn: string): MapRow[] {
    const target = this.findByIdAndMower(mapId, mowerSn);
    if (!target) return [];

    const prefix = extractCanonicalPrefix(target);
    const deleted: MapRow[] = [target];

    const tx = db.transaction(() => {
      this._deleteByIdAndMower.run(mapId, mowerSn);
      if (prefix) {
        const candidates = db.prepare('SELECT * FROM maps WHERE mower_sn = ? AND map_id != ?').all(mowerSn, mapId) as MapRow[];
        for (const row of candidates) {
          if (isRelatedByPrefix(row, prefix)) {
            this._deleteById.run(row.map_id);
            deleted.push(row);
          }
        }
      }
    });
    tx();

    return deleted;
  }

  /**
   * Delete every row referencing `prefix` (e.g. `map1`) on this mower:
   * work map, obstacles, and all unicoms where the prefix appears as an
   * endpoint (`map1to*`, `*tomap1_*`, `map1tocharge_unicom`).
   *
   * Used by `delete_map`: even when the work-map row is missing from our DB,
   * any leftover unicoms referencing the prefix still get cleaned up.
   */
  deleteByPrefix(mowerSn: string, prefix: string): MapRow[] {
    const allRows = this.findByMowerSn(mowerSn);
    const deleted: MapRow[] = [];
    const tx = db.transaction(() => {
      for (const row of allRows) {
        if (isRelatedByPrefix(row, prefix)
            || extractCanonicalPrefix(row) === prefix) {
          this._deleteById.run(row.map_id);
          deleted.push(row);
        }
      }
    });
    tx();
    return deleted;
  }

  // ── Map aggregates ──

  count(): number {
    return (this._count.get() as { count: number }).count;
  }

  countByMowerSn(mowerSn: string): number {
    return (this._countByMowerSn.get(mowerSn) as { count: number }).count;
  }

  // ── Calibration ──

  getCalibration(mowerSn: string): CalibrationRow | undefined {
    return this._getCalibration.get(mowerSn) as CalibrationRow | undefined;
  }

  setCalibration(mowerSn: string, data: SetCalibrationData): void {
    // Merge with existing calibration (preserve fields not being updated)
    const existing = this.getCalibration(mowerSn);
    this._setCalibration.run(
      mowerSn,
      data.offset_lat ?? existing?.offset_lat ?? 0,
      data.offset_lng ?? existing?.offset_lng ?? 0,
      data.rotation ?? existing?.rotation ?? 0,
      data.scale ?? existing?.scale ?? 1,
      data.charger_lat !== undefined ? data.charger_lat : (existing?.charger_lat ?? null),
      data.charger_lng !== undefined ? data.charger_lng : (existing?.charger_lng ?? null),
      data.gps_charger_lat !== undefined ? data.gps_charger_lat : (existing?.gps_charger_lat ?? null),
      data.gps_charger_lng !== undefined ? data.gps_charger_lng : (existing?.gps_charger_lng ?? null),
    );
  }

  getChargerGps(mowerSn: string): { lat: number; lng: number } | null {
    const row = this._getChargerGps.get(mowerSn) as { charger_lat: number | null; charger_lng: number | null } | undefined;
    if (!row || row.charger_lat == null || row.charger_lng == null) return null;
    return { lat: row.charger_lat, lng: row.charger_lng };
  }
}

export const mapRepo = new MapRepository();
