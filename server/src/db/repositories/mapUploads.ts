/**
 * Map Upload Repository — chunk tracking for map_uploads.
 */
import { db } from '../database.js';

export interface MapUploadRow {
  upload_id: string;
  mower_sn: string;
  file_size: number;
  chunks_total: number | null;
  chunks_received: number;
  created_at: string;
}

export class MapUploadRepository {
  private _findById = db.prepare('SELECT * FROM map_uploads WHERE upload_id = ?');
  private _create = db.prepare(`
    INSERT INTO map_uploads (upload_id, mower_sn, file_size, chunks_total, chunks_received)
    VALUES (?, ?, ?, ?, 0)
  `);
  private _incrementChunksReceived = db.prepare(
    'UPDATE map_uploads SET chunks_received = chunks_received + 1 WHERE upload_id = ?'
  );
  private _deleteById = db.prepare('DELETE FROM map_uploads WHERE upload_id = ?');

  findById(uploadId: string): MapUploadRow | undefined {
    return this._findById.get(uploadId) as MapUploadRow | undefined;
  }

  create(uploadId: string, mowerSn: string, fileSize: number, chunksTotal: number): void {
    this._create.run(uploadId, mowerSn, fileSize, chunksTotal);
  }

  incrementChunksReceived(uploadId: string): void {
    this._incrementChunksReceived.run(uploadId);
  }

  deleteById(uploadId: string): void {
    this._deleteById.run(uploadId);
  }
}

export const mapUploadRepo = new MapUploadRepository();
