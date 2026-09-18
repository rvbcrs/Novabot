/**
 * Dock samples: where the mower stands on the charger, one row per docking
 * stint. Feeds the dock-drift check (a walking dock position means the
 * station's antenna or the map frame moved).
 */
import { db } from '../database.js';

export interface DockSampleRow {
  id: number;
  sn: string;
  ts: string;
  map_x: number;
  map_y: number;
  lat: number | null;
  lng: number | null;
  n: number;
}

class DockSamplesRepository {
  private _insert = db.prepare(`
    INSERT INTO dock_samples (sn, map_x, map_y, lat, lng, n) VALUES (?, ?, ?, ?, ?, ?)
  `);
  private _listSince = db.prepare(`
    SELECT * FROM dock_samples WHERE sn = ? AND ts >= datetime('now', ? || ' days') ORDER BY ts ASC
  `);
  private _deleteBySn = db.prepare('DELETE FROM dock_samples WHERE sn = ?');
  private _prune = db.prepare("DELETE FROM dock_samples WHERE ts < datetime('now', '-120 days')");

  insert(sn: string, x: number, y: number, lat: number | null, lng: number | null, n: number): void {
    this._insert.run(sn, x, y, lat, lng, n);
  }
  listSince(sn: string, days: number): DockSampleRow[] {
    return this._listSince.all(sn, `-${days}`) as DockSampleRow[];
  }
  /** A new map frame (re-anchor, restore) makes old samples meaningless. */
  deleteBySn(sn: string): void {
    this._deleteBySn.run(sn);
  }
  prune(): void {
    this._prune.run();
  }
}

export const dockSamplesRepo = new DockSamplesRepository();
