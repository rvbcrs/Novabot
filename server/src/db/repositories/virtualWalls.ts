/**
 * Virtual Wall Repository — virtual_walls operations.
 */
import { db } from '../database.js';

export interface VirtualWallRow {
  id: number;
  wall_id: string;
  mower_sn: string;
  wall_name: string | null;
  lat1: number;
  lng1: number;
  lat2: number;
  lng2: number;
  enabled: number;
  created_at: string;
}

export class VirtualWallRepository {
  private _findByMowerSn = db.prepare(
    'SELECT * FROM virtual_walls WHERE mower_sn = ? ORDER BY created_at DESC'
  );
  private _findEnabledByMowerSn = db.prepare(
    'SELECT * FROM virtual_walls WHERE mower_sn = ? AND enabled = 1'
  );
  private _create = db.prepare(
    'INSERT INTO virtual_walls (wall_id, mower_sn, wall_name, lat1, lng1, lat2, lng2) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  private _deleteByIdAndMower = db.prepare(
    'DELETE FROM virtual_walls WHERE wall_id = ? AND mower_sn = ?'
  );

  findByMowerSn(mowerSn: string): VirtualWallRow[] {
    return this._findByMowerSn.all(mowerSn) as VirtualWallRow[];
  }

  findEnabledByMowerSn(mowerSn: string): VirtualWallRow[] {
    return this._findEnabledByMowerSn.all(mowerSn) as VirtualWallRow[];
  }

  create(
    wallId: string,
    mowerSn: string,
    wallName: string | null,
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): void {
    this._create.run(wallId, mowerSn, wallName, lat1, lng1, lat2, lng2);
  }

  deleteByIdAndMower(wallId: string, mowerSn: string): void {
    this._deleteByIdAndMower.run(wallId, mowerSn);
  }
}

export const virtualWallRepo = new VirtualWallRepository();
