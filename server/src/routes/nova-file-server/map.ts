import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { equipmentRepo, mapRepo, mapUploadRepo } from '../../db/repositories/index.js';
import { authMiddleware } from '../../middleware/auth.js';
import { AuthRequest, ok, fail, MapRow } from '../../types/index.js';
import { parseMapZip, type LocalPoint, type GpsPoint, polygonArea, gpsToLocal } from '../../mqtt/mapConverter.js';

export const mapRouter = Router();

const STORAGE_PATH = path.resolve(process.env.STORAGE_PATH ?? './storage', 'maps');
fs.mkdirSync(STORAGE_PATH, { recursive: true });

const TRACKS_PATH = path.resolve(process.env.STORAGE_PATH ?? './storage', 'tracks');
fs.mkdirSync(TRACKS_PATH, { recursive: true });

// multer stores fragment files in the maps storage dir
const upload = multer({ dest: STORAGE_PATH });

/**
 * Genereer CSV content uit database lokale coördinaten.
 * DB bevat al lokale x,y meters (charger = 0,0) — output direct als CSV.
 */
function generateCsvFromDb(sn: string, fileName: string): string | null {
  const baseName = fileName.replace(/\.csv$/, '');
  const workMatch = fileName.match(/^map(\d+)_work\.csv$/);
  const obstacleMatch = fileName.match(/^map(\d+)_(\d+)_obstacle\.csv$/);
  const unicomMatch = fileName.match(/^map\d+to(?:charge|map\d+)_?\d*_?unicom\.csv$/);

  let mapRow: MapRow | undefined;

  // First try: find by map_name (cloud import stores original filenames)
  const allMaps = mapRepo.findWithAreaOrderByMapId(sn);
  mapRow = allMaps.find(m => m.map_name === baseName || m.map_name === fileName || m.file_name === fileName);

  // Fallback: find by index (mower-uploaded maps)
  if (!mapRow) {
    if (workMatch) {
      const workMaps = mapRepo.findByMowerSnAndTypeWithArea(sn, 'work');
      mapRow = workMaps[parseInt(workMatch[1])];
    } else if (obstacleMatch) {
      const obstacleMaps = mapRepo.findByMowerSnAndTypeWithArea(sn, 'obstacle');
      mapRow = obstacleMaps[parseInt(obstacleMatch[2])];
    } else if (unicomMatch) {
      const unicomMaps = mapRepo.findByMowerSnAndTypeWithArea(sn, 'unicom');
      mapRow = unicomMaps.find(m => m.map_name === baseName) ?? unicomMaps[0];
    }
  }

  if (!mapRow?.map_area) return null;

  try {
    const points: LocalPoint[] = JSON.parse(mapRow.map_area);
    if (!points || points.length < 2) return null;

    // Lokale punten direct als CSV — geen conversie nodig
    const lines = points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`);
    return lines.join('\n') + '\n';
  } catch {
    return null;
  }
}

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

/** Derive CSV filename from DB map_name. Cloud import stores "map0_work", mower uploads store full filename. */
function csvFileName(mapName: string | null | undefined, fallback: string): string {
  if (!mapName) return fallback + '.csv';
  // If map_name already ends with .csv, use as-is
  if (mapName.endsWith('.csv')) return mapName;
  return mapName + '.csv';
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
  console.log(`[MAP] queryEquipmentMap called: sn=${sn} userId=${(req as any).userId}`);
  if (!sn) { res.json(fail('sn required', 400)); return; }

  // IDOR bescherming: controleer of dit apparaat van de huidige user is
  const equipRow = equipmentRepo.findBySn(sn);
  if (!equipRow || equipRow.user_id !== req.userId) {
    console.log(`[MAP] queryEquipmentMap: IDOR blocked — sn=${sn} not owned by user`);
    res.json(ok({ data: null, md5: null, machineExtendedField: null }));
    return;
  }

  // Haal alle kaarten op voor dit SN (met map_area, geordend op map_id)
  const maps = mapRepo.findWithAreaOrderByMapId(sn);

  if (maps.length === 0) {
    console.log(`[MAP] queryEquipmentMap: sn=${sn} → geen kaarten`);
    res.json(ok({ data: null, md5: null, machineExtendedField: null }));
    return;
  }

  // Groepeer per mapIndex: werk + bijbehorende obstakels
  const workMaps = maps.filter(m => m.map_type === 'work');
  const obstacleMaps = maps.filter(m => m.map_type === 'obstacle');
  const unicomMaps = maps.filter(m => m.map_type === 'unicom');

  // Base URL voor map file downloads — server IP direct, geen NPM/DNS omweg
  const baseUrl = process.env.OTA_BASE_URL
    ?? `http://${process.env.TARGET_IP ?? 'localhost'}:${process.env.PORT ?? '3000'}`;

  // Helper: bouw download URL voor een map CSV bestand
  function mapFileUrl(fileName: string): string {
    return `${baseUrl}/api/nova-file-server/map/downloadMapFile?sn=${sn}&fileName=${fileName}`;
  }

  // mapArea = oppervlakte in m² als string (bv. "6.22"). App toont dit bij "Size: Xm²"
  // en berekent maaitijd via double._parse(mapArea) * 0.03 / 3600.
  // Polygoon rendering komt NIET uit mapArea maar via MQTT get_map_outline of url download.
  function calcPolygonAreaM2(polygonJson: string | null): string {
    if (!polygonJson) return '0';
    try {
      const points: LocalPoint[] = JSON.parse(polygonJson);
      if (!points || points.length < 3) return '0';
      // Punten zijn al lokale meters — directe oppervlakteberekening
      const area = polygonArea(points);
      return String(Math.round(area * 100) / 100);
    } catch { return '0'; }
  }

  // Bouw work items met geneste obstacles
  // Gebruik map_name uit DB als filename (cloud import slaat originele naam op).
  // Fallback naar firmware conventie als map_name ontbreekt.
  const work = workMaps.map((wm, idx) => {
    const workFileName = csvFileName(wm.map_name, `map${idx}_work`);

    // Zoek obstakels die bij dit werkgebied horen
    // Match op map_name containing the map index OR the obstacle pattern
    const relatedObs = obstacleMaps
      .filter(om => {
        const name = om.map_name ?? '';
        return name.startsWith(`map${idx}_`) || name.includes(`obstacle_${idx}`);
      })
      .map((om, obsIdx) => {
        const obsFileName = csvFileName(om.map_name, `map${idx}_${obsIdx}_obstacle`);
        return {
          fileName: obsFileName,
          alias: om.map_name ?? `obstacle_${idx}`,
          type: 'obstacle',
          url: mapFileUrl(obsFileName),
          fileHash: crypto.createHash('md5').update(om.map_id).digest('hex'),
          mapArea: calcPolygonAreaM2(om.map_area),
          obstacle: [],
        };
      });

    return {
      fileName: workFileName,
      alias: wm.map_name ?? `Work area ${idx + 1}`,
      type: 'work',
      url: mapFileUrl(workFileName),
      fileHash: crypto.createHash('md5').update(wm.map_id).digest('hex'),
      mapArea: calcPolygonAreaM2(wm.map_area),
      obstacle: relatedObs,
    };
  });

  // Bouw unicom items — gebruik originele map_name als filename
  const unicom = unicomMaps.map((um, idx) => {
    const unicomFileName = csvFileName(um.map_name, `map${idx}tocharge_unicom`);
    return {
      fileName: unicomFileName,
      alias: um.map_name ?? `Channel ${idx + 1}`,
      type: 'unicom',
      url: mapFileUrl(unicomFileName),
      fileHash: crypto.createHash('md5').update(um.map_id).digest('hex'),
      mapArea: calcPolygonAreaM2(um.map_area),
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

  // ChargingPose uit de ZIP map_info.json (lokale meters, consistent met CSV polygonen)
  // De maaier slaat de charger positie op in lokale coördinaten relatief aan de origin.
  let machineExtendedField: Record<string, unknown> | null = null;
  const latestPath2 = path.join(STORAGE_PATH, `${sn}_latest.zip`);
  if (fs.existsSync(latestPath2)) {
    try {
      const tmpDir = path.join(STORAGE_PATH, `tmp_info_${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        execSync(`unzip -o -q "${latestPath2}" "csv_file/map_info.json" -d "${tmpDir}"`);
        const infoPath = path.join(tmpDir, 'csv_file', 'map_info.json');
        if (fs.existsSync(infoPath)) {
          const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
          if (info.charging_pose) {
            machineExtendedField = {
              chargingPose: {
                x: String(info.charging_pose.x ?? 0),
                y: String(info.charging_pose.y ?? 0),
                orientation: String(info.charging_pose.orientation ?? 0),
              },
            };
          }
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch { /* geen map_info.json in ZIP */ }
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
// Auth + IDOR bescherming: alleen eigen apparaten.
mapRouter.get('/downloadMapFile', authMiddleware, (req: AuthRequest, res: Response) => {
  const sn = req.query.sn as string | undefined;
  const fileName = req.query.fileName as string | undefined;
  if (!sn || !fileName) { res.status(400).json(fail('sn and fileName required', 400)); return; }

  // IDOR bescherming
  const equipRow = equipmentRepo.findBySn(sn);
  if (!equipRow || equipRow.user_id !== req.userId) {
    res.status(403).json(fail('Access denied', 403));
    return;
  }

  // Beveilig tegen path traversal
  const safeName = path.basename(fileName);
  if (safeName !== fileName || fileName.includes('..')) {
    res.status(400).json(fail('invalid fileName', 400));
    return;
  }

  // Probeer eerst uit de ZIP te extracten (maaier-geüploade kaarten)
  const zipPath = path.join(STORAGE_PATH, `${sn}_latest.zip`);
  if (fs.existsSync(zipPath)) {
    try {
      const tmpDir = path.join(STORAGE_PATH, `tmp_dl_${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        execSync(`unzip -o -q "${zipPath}" "csv_file/${safeName}" -d "${tmpDir}"`);
        const csvPath = path.join(tmpDir, 'csv_file', safeName);
        if (fs.existsSync(csvPath)) {
          const csvData = fs.readFileSync(csvPath);
          console.log(`[MAP] downloadMapFile: ${sn}/${safeName} (${csvData.length} bytes) from ZIP`);
          res.setHeader('Content-Type', 'text/csv');
          res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
          res.send(csvData);
          return;
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch { /* ZIP extractie mislukt, probeer fallback */ }
  }

  // Fallback: genereer CSV on-the-fly uit database GPS coördinaten.
  // Dit is nodig voor dashboard-getekende kaarten die geen ZIP hebben.
  // De app's getOffsetListFromFile() verwacht per regel: x,y (lokale meters).
  const csvGenerated = generateCsvFromDb(sn!, safeName);
  if (csvGenerated) {
    console.log(`[MAP] downloadMapFile: ${sn}/${safeName} (${csvGenerated.length} bytes) generated from DB`);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(csvGenerated);
    return;
  }

  console.warn(`[MAP] downloadMapFile: ${safeName} niet gevonden voor ${sn}`);
  res.status(404).json(fail('map not found', 404));
});

// POST /api/nova-file-server/map/fragmentUploadEquipmentMap
//
// The app sends the map as multipart/form-data chunks.
// Fields expected:  sn, uploadId, fileSize, chunkIndex, chunksTotal, file (binary)
// When all chunks are received they are reassembled into one file.
mapRouter.post('/fragmentUploadEquipmentMap', authMiddleware, upload.single('file'), async (req: AuthRequest, res: Response) => {
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

  const equipment = equipmentRepo.findByMowerSn(sn);
  if (!equipment || equipment.user_id !== req.userId) { res.json(fail('Equipment not found', 404)); return; }

  // App stuurt mapArea als GPS [{lat,lng}] — converteer naar lokaal [{x,y}] vóór opslag
  let localMapArea = mapArea ?? null;
  let localMapMaxMin = mapMaxMin ?? null;
  if (mapArea) {
    try {
      const pts = JSON.parse(mapArea);
      if (Array.isArray(pts) && pts.length > 0 && 'lat' in pts[0]) {
        const cal = mapRepo.getChargerGps(sn);
        if (cal) {
          const origin: GpsPoint = { lat: cal.lat, lng: cal.lng };
          const localPts = pts.map((p: GpsPoint) => gpsToLocal(p, origin));
          localMapArea = JSON.stringify(localPts);
          localMapMaxMin = JSON.stringify({
            minX: Math.min(...localPts.map((p: LocalPoint) => p.x)),
            maxX: Math.max(...localPts.map((p: LocalPoint) => p.x)),
            minY: Math.min(...localPts.map((p: LocalPoint) => p.y)),
            maxY: Math.max(...localPts.map((p: LocalPoint) => p.y)),
          });
        }
      }
    } catch { /* keep as-is */ }
  }

  // Single-chunk or simple upload (no fragmentation)
  if (!chunkIndex && !chunksTotal) {
    const mapId = uuidv4();
    const fileName = req.file ? path.basename(req.file.path) : null;

    mapRepo.upsert({
      map_id: mapId,
      mower_sn: sn,
      map_name: mapName ?? null,
      map_area: localMapArea,
      map_max_min: localMapMaxMin,
      file_name: fileName,
      file_size: req.file?.size ?? null,
    });

    res.json(ok({ mapId, uploadId }));
    return;
  }

  // Fragmented upload — persist each chunk and track progress
  const idx = parseInt(chunkIndex ?? '0', 10);
  const total = parseInt(chunksTotal ?? '1', 10);
  const totalSize = parseInt(fileSize ?? '0', 10);

  // Register upload session on first chunk
  const session = mapUploadRepo.findById(uploadId);
  if (!session) {
    mapUploadRepo.create(uploadId, sn, totalSize, total);
  }

  // Rename multer temp file to chunk-specific name so we can reassemble later
  if (req.file) {
    const chunkPath = path.join(STORAGE_PATH, `${uploadId}_chunk_${idx}`);
    fs.renameSync(req.file.path, chunkPath);
  }

  mapUploadRepo.incrementChunksReceived(uploadId);

  const updated = mapUploadRepo.findById(uploadId);
  if (!updated) {
    res.json(fail('upload session not found', 404));
    return;
  }

  // All chunks received — reassemble
  const updatedChunksTotal = updated.chunks_total ?? total;
  if (updated.chunks_received >= updatedChunksTotal) {
    const finalFileName = `${uploadId}.bin`;
    const finalPath = path.join(STORAGE_PATH, finalFileName);
    const out = fs.createWriteStream(finalPath);

    for (let i = 0; i < updatedChunksTotal; i++) {
      const chunkPath = path.join(STORAGE_PATH, `${uploadId}_chunk_${i}`);
      const data = fs.readFileSync(chunkPath);
      out.write(data);
      fs.unlinkSync(chunkPath);
    }

    // Wait for write stream to finish before inserting into DB
    await new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      out.end();
    });

    const mapId = uuidv4();
    mapRepo.upsert({
      map_id: mapId,
      mower_sn: sn,
      map_name: mapName ?? null,
      map_area: localMapArea,
      map_max_min: localMapMaxMin,
      file_name: finalFileName,
      file_size: updated.file_size,
    });

    mapUploadRepo.deleteById(uploadId);

    res.json(ok({ mapId, uploadId, complete: true }));
    return;
  }

  res.json(ok({ uploadId, chunksReceived: updated.chunks_received, chunksTotal: updatedChunksTotal }));
});

// POST /api/nova-file-server/map/updateEquipmentMapAlias
// App stuurt: { fileName: "map0_work.csv", fileAlias: "Achtertuin" }
// Dashboard stuurt: { mapId: "...", mapName: "..." }
mapRouter.post('/updateEquipmentMapAlias', authMiddleware, (req: AuthRequest, res: Response) => {
  console.log(`[MAP] updateEquipmentMapAlias DEBUG: body=${JSON.stringify(req.body)}`);

  const { mapId, mapName, fileName, fileAlias, sn: bodySn } = req.body as {
    mapId?: string; mapName?: string; fileName?: string; fileAlias?: string; sn?: string;
  };
  const newName = mapName ?? fileAlias ?? null;

  let resolvedMapId = mapId;

  // App stuurt fileName (bv. "map0_work.csv") + sn i.p.v. mapId — resolve naar DB map_id
  if (!resolvedMapId && fileName) {
    // Gebruik sn direct uit body, of fallback naar equipment lookup
    const mowerSn = bodySn || equipmentRepo.findByUserId(req.userId!)?.[0]?.mower_sn;

    if (mowerSn) {
      const workMatch = fileName.match(/^map(\d+)_work\.csv$/);
      const obstacleMatch = fileName.match(/^map(\d+)_(\d+)_obstacle\.csv$/);
      const unicomMatch = fileName.match(/^map(\d+)tocharge_unicom\.csv$/);

      if (workMatch) {
        const idx = parseInt(workMatch[1]);
        const rows = mapRepo.findByMowerSnAndTypeWithArea(mowerSn, 'work');
        resolvedMapId = rows[idx]?.map_id;
      } else if (obstacleMatch) {
        const idx = parseInt(obstacleMatch[2]);
        const rows = mapRepo.findByMowerSnAndTypeWithArea(mowerSn, 'obstacle');
        resolvedMapId = rows[idx]?.map_id;
      } else if (unicomMatch) {
        const idx = parseInt(unicomMatch[1]);
        const rows = mapRepo.findByMowerSnAndTypeWithArea(mowerSn, 'unicom');
        resolvedMapId = rows[idx]?.map_id;
      }

      console.log(`[MAP] updateEquipmentMapAlias: fileName=${fileName} sn=${mowerSn} → resolvedMapId=${resolvedMapId}`);
    }
  }

  if (!resolvedMapId) {
    console.log(`[MAP] updateEquipmentMapAlias FAIL: could not resolve mapId. fileName=${fileName} sn=${bodySn} userId=${req.userId}`);
    res.json(fail('mapId required', 400));
    return;
  }

  mapRepo.updateName(resolvedMapId, newName ?? '');
  console.log(`[MAP] updateEquipmentMapAlias: ${resolvedMapId} → "${newName}"`);
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

  // Parse ZIP — lokale coördinaten direct uit CSV (geen GPS origin nodig)
  let mapName: string | null = localFileName ?? null;

  // Parse jsonBody metadata als aanwezig
  if (jsonBody) {
    try {
      const meta = JSON.parse(jsonBody);
      if (meta.mapName) mapName = meta.mapName;
      console.log(`[MAP] uploadEquipmentMap: jsonBody metadata:`, meta);
    } catch { /* niet-JSON jsonBody, negeren */ }
  }

  try {
    const parsed = parseMapZip(finalPath);
    if (parsed && parsed.areas.length > 0) {
      // Check of er al maps in de DB staan voor deze maaier (bijv. dashboard-drawn)
      const existingMaps = mapRepo.findWithArea(sn);

      if (existingMaps.length > 0) {
        // Maps bestaan al — maaier stuurt onze eigen ZIP terug. Alleen file_name bijwerken.
        for (const em of existingMaps) {
          mapRepo.updateFileName(em.map_id, finalFileName);
        }
        console.log(`[MAP] uploadEquipmentMap: ${existingMaps.length} bestaande maps bijgewerkt voor ${sn} (geen duplicaten)`);
      } else {
        // Geen bestaande maps — sla elk werkgebied op (lokale coördinaten direct uit CSV)
        for (const area of parsed.areas) {
          if (area.type !== 'work') continue;
          const areaMapId = uuidv4();
          const bounds = {
            minX: Math.min(...area.points.map(p => p.x)),
            maxX: Math.max(...area.points.map(p => p.x)),
            minY: Math.min(...area.points.map(p => p.y)),
            maxY: Math.max(...area.points.map(p => p.y)),
          };

          mapRepo.upsert({
            map_id: areaMapId,
            mower_sn: sn,
            map_name: mapName ?? `map${area.mapIndex}`,
            map_area: JSON.stringify(area.points),
            map_max_min: JSON.stringify(bounds),
            file_name: finalFileName,
            file_size: file.size,
            map_type: area.type,
          });
          console.log(`[MAP] Opgeslagen werkgebied map${area.mapIndex} voor ${sn} (${area.points.length} lokale punten)`);
        }
        // Sla obstakels op
        for (const area of parsed.areas) {
          if (area.type !== 'obstacle') continue;
          const obsMapId = uuidv4();
          mapRepo.upsert({
            map_id: obsMapId,
            mower_sn: sn,
            map_name: `obstacle_${area.mapIndex}_${area.subIndex ?? 0}`,
            map_area: JSON.stringify(area.points),
            map_max_min: null,
            file_name: finalFileName,
            file_size: file.size,
            map_type: 'obstacle',
          });
        }
        // Sla unicom (channel) paden op
        for (const area of parsed.areas) {
          if (area.type !== 'unicom') continue;
          const unicomMapId = uuidv4();
          mapRepo.upsert({
            map_id: unicomMapId,
            mower_sn: sn,
            map_name: `map${area.mapIndex}tocharge_unicom`,
            map_area: JSON.stringify(area.points),
            map_max_min: null,
            file_name: finalFileName,
            file_size: file.size,
            map_type: 'unicom',
          });
          console.log(`[MAP] Opgeslagen unicom kanaal map${area.mapIndex} voor ${sn} (${area.points.length} punten)`);
        }
        console.log(`[MAP] ZIP geparsed: ${parsed.areas.length} gebieden geëxtraheerd voor ${sn}`);
      }
    } else {
      // ZIP parsing geeft geen gebieden — sla alleen het bestand op
      console.log(`[MAP] Geen kaartgebieden in ZIP voor ${sn}, bestand opgeslagen`);
      const mapId = uuidv4();
      mapRepo.upsert({
        map_id: mapId,
        mower_sn: sn,
        map_name: mapName,
        map_area: null,
        map_max_min: null,
        file_name: finalFileName,
        file_size: file.size,
      });
    }
  } catch (err) {
    console.error(`[MAP] ZIP parsing mislukt voor ${sn}:`, err);
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
