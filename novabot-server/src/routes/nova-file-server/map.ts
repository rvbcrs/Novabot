import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/database.js';
import { authMiddleware } from '../../middleware/auth.js';
import { AuthRequest, ok, fail, MapRow } from '../../types/index.js';
import { parseMapZip, GpsPoint, gpsToLocal, polygonArea } from '../../mqtt/mapConverter.js';
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
//
// De app (v2.4.0) verwacht een JSON object als `data`, NIET base64:
//   data: { work: [MapEntityItem, ...], unicom: [MapEntityItem, ...] }
//   MapEntityItem: { fileName, alias, type, url, fileHash, mapArea, obstacle: [] }
//   machineExtendedField: { chargingPose: { x: "0", y: "0", orientation: "0" } } | null
//
// ChargingPostion.fromJson verwacht x/y/orientation als strings die naar double geparsed worden.
mapRouter.get('/queryEquipmentMap', authMiddleware, (req: AuthRequest, res: Response) => {
  const sn = req.query.sn as string | undefined;
  if (!sn) { res.json(fail('sn required', 400)); return; }

  // Haal alle kaarten op voor dit SN
  const maps = db.prepare(
    'SELECT * FROM maps WHERE mower_sn = ? AND map_area IS NOT NULL ORDER BY map_id'
  ).all(sn) as MapRow[];

  if (maps.length === 0) {
    console.log(`[MAP] queryEquipmentMap: sn=${sn} → geen kaarten`);
    res.json(ok({ data: null, md5: null, machineExtendedField: null }));
    return;
  }

  // Groepeer per mapIndex: werk + bijbehorende obstakels
  const workMaps = maps.filter(m => m.map_type === 'work');
  const obstacleMaps = maps.filter(m => m.map_type === 'obstacle');
  const unicomMaps = maps.filter(m => m.map_type === 'unicom');

  // Base URL voor map file downloads
  const baseUrl = process.env.OTA_BASE_URL
    ?? `http://${process.env.TARGET_IP ?? 'localhost'}`;

  // Helper: bereken oppervlakte in m² uit GPS punten JSON string
  function calcAreaM2(mapAreaJson: string | null): string {
    if (!mapAreaJson) return '0';
    try {
      const points: GpsPoint[] = JSON.parse(mapAreaJson);
      if (!points || points.length < 3) return '0';
      // Gebruik eerste punt als origin voor lokale conversie
      const origin = points[0];
      const localPoints = points.map(p => gpsToLocal(p, origin));
      const area = polygonArea(localPoints);
      return String(Math.round(area * 100) / 100);
    } catch { return '0'; }
  }

  // Helper: bouw download URL voor een map CSV bestand
  function mapFileUrl(fileName: string): string {
    return `${baseUrl}/api/nova-file-server/map/downloadMapFile?sn=${sn}&fileName=${fileName}`;
  }

  // Bouw work items met geneste obstacles
  // NB: file_name in DB is de ZIP-bestandsnaam, NIET de CSV-bestandsnaam.
  // Genereer altijd CSV-bestandsnamen conform firmware conventie.
  const work = workMaps.map((wm, idx) => {
    const workFileName = `map${idx}_work.csv`;

    // Zoek obstakels die bij dit werkgebied horen (zelfde mapIndex)
    let obsCounter = 0;
    const relatedObs = obstacleMaps
      .filter(om => om.map_name?.includes(`${idx}`) || om.map_name?.includes(`obstacle_${idx}`))
      .map(om => {
        const obsFileName = `map${idx}_${obsCounter++}_obstacle.csv`;
        return {
          fileName: obsFileName,
          alias: om.map_name ?? `obstacle_${idx}`,
          type: 'obstacle',
          url: mapFileUrl(obsFileName),
          fileHash: crypto.createHash('md5').update(om.map_id).digest('hex'),
          mapArea: calcAreaM2(om.map_area),
          obstacle: [],
        };
      });

    return {
      fileName: workFileName,
      alias: wm.map_name ?? `Work area ${idx + 1}`,
      type: 'work',
      url: mapFileUrl(workFileName),
      fileHash: crypto.createHash('md5').update(wm.map_id).digest('hex'),
      mapArea: calcAreaM2(wm.map_area),
      obstacle: relatedObs,
    };
  });

  // Bouw unicom items
  const unicom = unicomMaps.map((um, idx) => {
    const unicomFileName = `map${idx}tocharge_unicom.csv`;
    return {
      fileName: unicomFileName,
      alias: um.map_name ?? `Channel ${idx + 1}`,
      type: 'unicom',
      url: mapFileUrl(unicomFileName),
      fileHash: crypto.createHash('md5').update(um.map_id).digest('hex'),
      mapArea: calcAreaM2(um.map_area),
      obstacle: [],
    };
  });

  // Bereken MD5 van de ZIP als die bestaat
  let md5: string | null = null;
  const latestPath = path.join(STORAGE_PATH, `${sn}_latest.zip`);
  if (fs.existsSync(latestPath)) {
    const fileData = fs.readFileSync(latestPath);
    md5 = crypto.createHash('md5').update(fileData).digest('hex');
  }

  // ChargingPose uit map_calibration (charger positie)
  let machineExtendedField: Record<string, unknown> | null = null;
  const cal = db.prepare('SELECT charger_lat, charger_lng FROM map_calibration WHERE mower_sn = ?')
    .get(sn) as { charger_lat: number | null; charger_lng: number | null } | undefined;
  if (cal?.charger_lat && cal?.charger_lng) {
    machineExtendedField = {
      chargingPose: {
        x: String(cal.charger_lng),
        y: String(cal.charger_lat),
        orientation: '0',
      },
    };
  }

  console.log(`[MAP] queryEquipmentMap: sn=${sn} → ${work.length} work, ${unicom.length} unicom, md5=${md5 ?? 'none'}`);
  res.json(ok({
    data: { work, unicom },
    md5,
    machineExtendedField,
  }));
});

// GET /api/nova-file-server/map/downloadMapFile?sn=&fileName=
//
// Serveert individuele CSV kaartbestanden uit de opgeslagen ZIP.
// De app downloadt deze via de URLs in de queryEquipmentMap response.
mapRouter.get('/downloadMapFile', (req: Request, res: Response) => {
  const sn = req.query.sn as string | undefined;
  const fileName = req.query.fileName as string | undefined;
  if (!sn || !fileName) { res.status(400).json(fail('sn and fileName required', 400)); return; }

  // Beveilig tegen path traversal
  const safeName = path.basename(fileName);
  if (safeName !== fileName || fileName.includes('..')) {
    res.status(400).json(fail('invalid fileName', 400));
    return;
  }

  const zipPath = path.join(STORAGE_PATH, `${sn}_latest.zip`);
  if (!fs.existsSync(zipPath)) {
    console.warn(`[MAP] downloadMapFile: ZIP niet gevonden voor ${sn}`);
    res.status(404).json(fail('map not found', 404));
    return;
  }

  try {
    // Extract het gevraagde bestand uit de ZIP
    const tmpDir = path.join(STORAGE_PATH, `tmp_dl_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      execSync(`unzip -o -q "${zipPath}" "csv_file/${safeName}" -d "${tmpDir}"`);
      const csvPath = path.join(tmpDir, 'csv_file', safeName);

      if (!fs.existsSync(csvPath)) {
        console.warn(`[MAP] downloadMapFile: ${safeName} niet in ZIP voor ${sn}`);
        res.status(404).json(fail('file not found in map', 404));
        return;
      }

      const csvData = fs.readFileSync(csvPath);
      console.log(`[MAP] downloadMapFile: ${sn}/${safeName} (${csvData.length} bytes)`);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.send(csvData);
    } finally {
      // Ruim tmp directory op
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`[MAP] downloadMapFile: extractie mislukt voor ${sn}/${safeName}:`, err);
    res.status(500).json(fail('extraction failed', 500));
  }
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
mapRouter.post('/uploadEquipmentMap', upload.any(), (req: Request, res: Response) => {
  // Debug logging — inspect what the mower actually sends
  const files = req.files as Express.Multer.File[] | undefined;
  console.log(`[MAP] uploadEquipmentMap DEBUG:`,
    `content-type=${req.headers['content-type']}`,
    `body=${JSON.stringify(req.body)}`,
    `query=${JSON.stringify(req.query)}`,
    `files=${files?.map(f => `${f.fieldname}(${f.originalname},${f.size}b)`).join(',')}`,
  );

  // Maaier stuurt sn in body OF in query params — probeer beide
  const { zipMd5, local_file_name: localFileName, jsonBody } = req.body as {
    zipMd5?: string;
    local_file_name?: string;
    jsonBody?: string;
  };
  let sn = (req.body.sn ?? req.query.sn) as string | undefined;

  // Fallback: extract SN from uploaded filename (maaier stuurt LFIN*.zip)
  if (!sn && files?.[0]?.originalname) {
    const match = files[0].originalname.match(/^(LFI[A-Z]\d+)/);
    if (match) {
      sn = match[1];
      console.log(`[MAP] uploadEquipmentMap: SN extracted from filename: ${sn}`);
    }
  }

  if (!sn) { res.json(fail('sn required', 400)); return; }

  // upload.any() accepteert elk veld-naam — pak het eerste bestand
  const uploadedFile = (req.files as Express.Multer.File[] | undefined)?.[0] ?? req.file;
  const fieldName = uploadedFile ? (uploadedFile as Express.Multer.File).fieldname : '?';
  console.log(`[MAP] uploadEquipmentMap: sn=${sn} file=${localFileName ?? '-'} md5=${zipMd5 ?? '-'} field=${fieldName}`);

  if (!uploadedFile) {
    console.warn(`[MAP] uploadEquipmentMap: geen bestand ontvangen van ${sn}`);
    res.json(ok(null));
    return;
  }

  const file = uploadedFile;

  // Verifieer MD5 als meegegeven
  if (zipMd5) {
    const fileData = fs.readFileSync(file.path);
    const actualMd5 = crypto.createHash('md5').update(fileData).digest('hex');
    if (actualMd5 !== zipMd5) {
      console.warn(`[MAP] uploadEquipmentMap: MD5 mismatch: expected=${zipMd5} actual=${actualMd5}`);
    }
  }

  // Hernoem naar definitieve locatie
  const finalFileName = `${sn}_${Date.now()}.zip`;
  const finalPath = path.join(STORAGE_PATH, finalFileName);
  fs.renameSync(file.path, finalPath);

  // Bewaar ook als _latest.zip zodat queryEquipmentMap het kan serveren
  const latestPath = path.join(STORAGE_PATH, `${sn}_latest.zip`);
  fs.copyFileSync(finalPath, latestPath);

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
                 finalFileName, file.size, area.type, now, now);
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
                 JSON.stringify(area.points), null, finalFileName, file.size,
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
    `).run(mapId, sn, mapName, null, null, finalFileName, file.size, now, now);
  }

  res.json(ok(null));
});

// POST /api/nova-file-server/map/uploadEquipmentTrack
//
// De maaier uploadt track/trail data na een maaisessie.
// Zelfde multipart structuur als uploadEquipmentMap.
const trackUpload = multer({ dest: TRACKS_PATH });

mapRouter.post('/uploadEquipmentTrack', trackUpload.any(), (req: Request, res: Response) => {
  const { local_file_name: localFileName } = req.body as {
    local_file_name?: string;
  };

  // SN uit body, query, of bestandsnaam
  let sn = (req.body.sn ?? req.query.sn) as string | undefined;
  const files = req.files as Express.Multer.File[] | undefined;
  if (!sn && files?.[0]?.originalname) {
    const match = files[0].originalname.match(/^(LFI[A-Z]\d+)/);
    if (match) sn = match[1];
  }

  if (!sn) { res.json(fail('sn required', 400)); return; }
  console.log(`[MAP] uploadEquipmentTrack: sn=${sn} file=${localFileName ?? '-'}`);

  const file = files?.[0];
  if (file) {
    const finalName = `${sn}_track_${Date.now()}${path.extname(localFileName ?? '.bin')}`;
    fs.renameSync(file.path, path.join(TRACKS_PATH, finalName));
    console.log(`[MAP] Track opgeslagen: ${finalName}`);
  }

  res.json(ok(null));
});
