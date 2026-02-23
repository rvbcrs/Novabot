import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/database.js';
import { authMiddleware } from '../../middleware/auth.js';
import { AuthRequest, ok, fail, MapRow } from '../../types/index.js';

export const mapRouter = Router();

const STORAGE_PATH = path.resolve(process.env.STORAGE_PATH ?? './storage', 'maps');
fs.mkdirSync(STORAGE_PATH, { recursive: true });

// multer stores fragment files in the maps storage dir
const upload = multer({ dest: STORAGE_PATH });

function rowToDto(r: MapRow) {
  return {
    mapId: r.map_id,
    mowerSn: r.mower_sn,
    mapName: r.map_name,
    mapArea: r.map_area ? JSON.parse(r.map_area) : [],
    mapMaxMin: r.map_max_min ? JSON.parse(r.map_max_min) : null,
    fileSize: r.file_size,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// GET /api/nova-file-server/map/queryEquipmentMap?sn=
mapRouter.get('/queryEquipmentMap', authMiddleware, (req: AuthRequest, res: Response) => {
  const sn = req.query.sn as string | undefined;
  if (!sn) { res.json(fail('sn required', 400)); return; }

  // Verify this user owns the device
  const equipment = db.prepare('SELECT equipment_id FROM equipment WHERE mower_sn = ? AND user_id = ?')
    .get(sn, req.userId);
  if (!equipment) { res.json(fail('Equipment not found', 404)); return; }

  const rows = db.prepare('SELECT * FROM maps WHERE mower_sn = ? ORDER BY updated_at DESC').all(sn) as MapRow[];
  res.json(ok(rows.map(rowToDto)));
});

// POST /api/nova-file-server/map/fragmentUploadEquipmentMap
//
// The app sends the map as multipart/form-data chunks.
// Fields expected:  sn, uploadId, fileSize, chunkIndex, chunksTotal, file (binary)
// When all chunks are received they are reassembled into one file.
mapRouter.post('/fragmentUploadEquipmentMap', authMiddleware, upload.single('file'), (req: AuthRequest, res: Response) => {
  const { sn, uploadId, fileSize, chunkIndex, chunksTotal, mapName, mapArea, mapMaxMin } = req.body as {
    sn?: string;
    uploadId?: string;
    fileSize?: string;
    chunkIndex?: string;
    chunksTotal?: string;
    mapName?: string;
    mapArea?: string;
    mapMaxMin?: string;
  };

  if (!sn || !uploadId) { res.json(fail('sn and uploadId required', 400)); return; }

  const equipment = db.prepare('SELECT equipment_id FROM equipment WHERE mower_sn = ? AND user_id = ?')
    .get(sn, req.userId);
  if (!equipment) { res.json(fail('Equipment not found', 404)); return; }

  // Single-chunk or simple upload (no fragmentation)
  if (!chunkIndex && !chunksTotal) {
    const mapId = uuidv4();
    const now = new Date().toISOString();
    const fileName = req.file ? path.basename(req.file.path) : null;

    db.prepare(`
      INSERT OR REPLACE INTO maps
        (map_id, mower_sn, map_name, map_area, map_max_min, file_name, file_size, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(mapId, sn, mapName ?? null, mapArea ?? null, mapMaxMin ?? null,
           fileName, req.file?.size ?? null, now, now);

    res.json(ok({ mapId, uploadId }));
    return;
  }

  // Fragmented upload — persist each chunk and track progress
  const idx = parseInt(chunkIndex ?? '0', 10);
  const total = parseInt(chunksTotal ?? '1', 10);
  const totalSize = parseInt(fileSize ?? '0', 10);

  // Register upload session on first chunk
  const session = db.prepare('SELECT * FROM map_uploads WHERE upload_id = ?').get(uploadId);
  if (!session) {
    db.prepare(`
      INSERT INTO map_uploads (upload_id, mower_sn, file_size, chunks_total, chunks_received)
      VALUES (?, ?, ?, ?, 0)
    `).run(uploadId, sn, totalSize, total);
  }

  // Rename multer temp file to chunk-specific name so we can reassemble later
  if (req.file) {
    const chunkPath = path.join(STORAGE_PATH, `${uploadId}_chunk_${idx}`);
    fs.renameSync(req.file.path, chunkPath);
  }

  db.prepare('UPDATE map_uploads SET chunks_received = chunks_received + 1 WHERE upload_id = ?').run(uploadId);

  const updated = db.prepare('SELECT * FROM map_uploads WHERE upload_id = ?').get(uploadId) as {
    chunks_received: number; chunks_total: number; mower_sn: string; file_size: number;
  };

  // All chunks received — reassemble
  if (updated.chunks_received >= updated.chunks_total) {
    const finalFileName = `${uploadId}.bin`;
    const finalPath = path.join(STORAGE_PATH, finalFileName);
    const out = fs.createWriteStream(finalPath);

    for (let i = 0; i < updated.chunks_total; i++) {
      const chunkPath = path.join(STORAGE_PATH, `${uploadId}_chunk_${i}`);
      const data = fs.readFileSync(chunkPath);
      out.write(data);
      fs.unlinkSync(chunkPath);
    }
    out.end();

    const mapId = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO maps
        (map_id, mower_sn, map_name, map_area, map_max_min, file_name, file_size, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(mapId, sn, mapName ?? null, mapArea ?? null, mapMaxMin ?? null,
           finalFileName, updated.file_size, now, now);

    db.prepare('DELETE FROM map_uploads WHERE upload_id = ?').run(uploadId);

    res.json(ok({ mapId, uploadId, complete: true }));
    return;
  }

  res.json(ok({ uploadId, chunksReceived: updated.chunks_received, chunksTotal: updated.chunks_total }));
});

// POST /api/nova-file-server/map/updateEquipmentMapAlias
mapRouter.post('/updateEquipmentMapAlias', authMiddleware, (req: AuthRequest, res: Response) => {
  const { mapId, mapName } = req.body as { mapId?: string; mapName?: string };
  if (!mapId) { res.json(fail('mapId required', 400)); return; }

  db.prepare(`
    UPDATE maps SET map_name = ?, updated_at = ?
    WHERE map_id = ?
      AND mower_sn IN (SELECT mower_sn FROM equipment WHERE user_id = ?)
  `).run(mapName ?? null, new Date().toISOString(), mapId, req.userId);
  res.json(ok());
});
