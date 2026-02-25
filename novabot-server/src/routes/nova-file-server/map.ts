import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/database.js';
import { authMiddleware } from '../../middleware/auth.js';
import { AuthRequest, ok, fail, MapRow } from '../../types/index.js';
import { parseMapZip, GpsPoint } from '../../mqtt/mapConverter.js';
import { deviceCache } from '../../mqtt/sensorData.js';

export const mapRouter = Router();

const STORAGE_PATH = path.resolve(process.env.STORAGE_PATH ?? './storage', 'maps');
fs.mkdirSync(STORAGE_PATH, { recursive: true });

const TRACKS_PATH = path.resolve(process.env.STORAGE_PATH ?? './storage', 'tracks');
fs.mkdirSync(TRACKS_PATH, { recursive: true });

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

// ── Maaier firmware endpoints (geen JWT auth) ─────────────────────────────────

// POST /api/nova-file-server/map/uploadEquipmentMap
//
// De maaier stuurt kaart-ZIPs via curl_formadd (multipart/form-data).
// Velden: local_file (ZIP), local_file_name, zipMd5, sn, jsonBody
// Geen JWT — maaier identificeert zichzelf via sn in body.
mapRouter.post('/uploadEquipmentMap', upload.single('local_file'), (req: Request, res: Response) => {
  const { sn, zipMd5, local_file_name: localFileName, jsonBody } = req.body as {
    sn?: string;
    zipMd5?: string;
    local_file_name?: string;
    jsonBody?: string;
  };

  if (!sn) { res.json(fail('sn required', 400)); return; }
  console.log(`[MAP] uploadEquipmentMap: sn=${sn} file=${localFileName ?? '-'} md5=${zipMd5 ?? '-'}`);

  if (!req.file) {
    console.warn(`[MAP] uploadEquipmentMap: geen bestand ontvangen van ${sn}`);
    res.json(ok(null));
    return;
  }

  // Verifieer MD5 als meegegeven
  if (zipMd5) {
    const fileData = fs.readFileSync(req.file.path);
    const actualMd5 = crypto.createHash('md5').update(fileData).digest('hex');
    if (actualMd5 !== zipMd5) {
      console.warn(`[MAP] uploadEquipmentMap: MD5 mismatch: expected=${zipMd5} actual=${actualMd5}`);
    }
  }

  // Hernoem naar definitieve locatie
  const finalFileName = `${sn}_${Date.now()}.zip`;
  const finalPath = path.join(STORAGE_PATH, finalFileName);
  fs.renameSync(req.file.path, finalPath);

  // Probeer GPS polygonen te extraheren als we de charging station positie kennen
  let mapAreaJson: string | null = null;
  let mapMaxMinJson: string | null = null;
  let mapName: string | null = localFileName ?? null;

  // Parse jsonBody metadata als aanwezig
  if (jsonBody) {
    try {
      const meta = JSON.parse(jsonBody);
      if (meta.mapName) mapName = meta.mapName;
      console.log(`[MAP] uploadEquipmentMap: jsonBody metadata:`, meta);
    } catch { /* niet-JSON jsonBody, negeren */ }
  }

  // Haal GPS origin op vanuit sensorData cache (maaier stuurt lat/lng via MQTT)
  const snData = deviceCache.get(sn);
  const lat = snData?.get('latitude');
  const lng = snData?.get('longitude');

  if (lat && lng) {
    const origin: GpsPoint = { lat: parseFloat(lat), lng: parseFloat(lng) };
    try {
      const parsed = parseMapZip(finalPath, origin);
      if (parsed && parsed.areas.length > 0) {
        // Sla elk werkgebied als aparte map op
        const now = new Date().toISOString();
        for (const area of parsed.areas) {
          if (area.type !== 'work') continue;
          const areaMapId = uuidv4();
          const lats = area.points.map(p => p.lat);
          const lngs = area.points.map(p => p.lng);
          const bounds = {
            minLat: Math.min(...lats), maxLat: Math.max(...lats),
            minLng: Math.min(...lngs), maxLng: Math.max(...lngs),
          };
          mapAreaJson = JSON.stringify(area.points);
          mapMaxMinJson = JSON.stringify(bounds);

          db.prepare(`
            INSERT OR REPLACE INTO maps
              (map_id, mower_sn, map_name, map_area, map_max_min, file_name, file_size, map_type, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)
          `).run(areaMapId, sn, mapName ?? `map${area.mapIndex}`, mapAreaJson, mapMaxMinJson,
                 finalFileName, req.file!.size, area.type, now, now);
          console.log(`[MAP] Opgeslagen werkgebied map${area.mapIndex} voor ${sn} (${area.points.length} GPS punten)`);
        }
        // Sla obstakels ook op
        for (const area of parsed.areas) {
          if (area.type !== 'obstacle') continue;
          const obsMapId = uuidv4();
          db.prepare(`
            INSERT OR REPLACE INTO maps
              (map_id, mower_sn, map_name, map_area, map_max_min, file_name, file_size, map_type, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)
          `).run(obsMapId, sn, `obstacle_${area.mapIndex}_${area.subIndex ?? 0}`,
                 JSON.stringify(area.points), null, finalFileName, req.file!.size,
                 'obstacle', now, now);
        }
        console.log(`[MAP] ZIP geparsed: ${parsed.areas.length} gebieden geëxtraheerd voor ${sn}`);
      }
    } catch (err) {
      console.error(`[MAP] ZIP parsing mislukt voor ${sn}:`, err);
    }
  } else {
    // Geen GPS beschikbaar — sla alleen het bestand op zonder parsing
    console.log(`[MAP] Geen GPS origin beschikbaar voor ${sn}, ZIP opgeslagen als bestand`);
    const mapId = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO maps
        (map_id, mower_sn, map_name, map_area, map_max_min, file_name, file_size, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(mapId, sn, mapName, null, null, finalFileName, req.file.size, now, now);
  }

  res.json(ok(null));
});

// POST /api/nova-file-server/map/uploadEquipmentTrack
//
// De maaier uploadt track/trail data na een maaisessie.
// Zelfde multipart structuur als uploadEquipmentMap.
const trackUpload = multer({ dest: TRACKS_PATH });

mapRouter.post('/uploadEquipmentTrack', trackUpload.single('local_file'), (req: Request, res: Response) => {
  const { sn, local_file_name: localFileName } = req.body as {
    sn?: string;
    local_file_name?: string;
  };

  if (!sn) { res.json(fail('sn required', 400)); return; }
  console.log(`[MAP] uploadEquipmentTrack: sn=${sn} file=${localFileName ?? '-'}`);

  if (req.file) {
    const finalName = `${sn}_track_${Date.now()}${path.extname(localFileName ?? '.bin')}`;
    fs.renameSync(req.file.path, path.join(TRACKS_PATH, finalName));
    console.log(`[MAP] Track opgeslagen: ${finalName}`);
  }

  res.json(ok(null));
});
