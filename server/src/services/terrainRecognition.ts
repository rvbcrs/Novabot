/**
 * Batch-orkestratie voor objectherkenning (objectherkenning-plan Task 7).
 *
 * Knoopt de bouwstenen van Task 3-6 aan elkaar: leest hetzelfde gemergde
 * display-TGO1-grid als de dashboard-viewer (`GET /terrain-objects/:sn`),
 * clustert de object-cellen, kiest per cluster zonder `user_override` het
 * best-gerichte frame uit de bewaarde RGB-sessies, cropt en classificeert,
 * en upsert het resultaat in `terrain_clusters`.
 *
 * Fire-and-forget: wordt aangeroepen (`void runRecognition(sn).catch(...)`)
 * vanuit `cloud-api/routes/terrain.ts` ná een finale merge van een
 * OBJECT-grid (final-upload of crash-herstel via `foldActive`). Fouten per
 * cluster crashen de job nooit — skip + `console.warn`, door naar het
 * volgende cluster.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { parseTgo1, mergeIntoTgmo, tgmoToDisplayTgo1, type Tgo1 } from './terrainGrid.js';
import { clusterObjects, type Cluster } from './terrainClusters.js';
import { scoreFrame, cropBox, cropFrame, type Pose } from './terrainCrops.js';
import { initClassifier, classifyCrop } from './terrainClassifier.js';
import { terrainClusterRepo } from '../db/repositories/index.js';

const TERRAIN_DIR = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain');

/**
 * Leest de persistente TGMO + een eventuele actieve (nog niet
 * gefinaliseerde) live-sessie-laag en levert de gemergde TGMO-buffer —
 * exact dezelfde merge-stap als `GET /api/dashboard/terrain-objects/:sn`
 * gebruikt (`mergeIntoTgmo`), zodat de batch nooit een ander grid ziet dan
 * de viewer. `null` als geen van beide bestaat. Wordt ook door
 * `routes/dashboard.ts` hergebruikt — geen kopie-implementatie.
 */
export function loadMergedTgmo(sn: string): Buffer | null {
  const tgmoPath = path.join(TERRAIN_DIR, `${sn}.tgmo`);
  const activePath = path.join(TERRAIN_DIR, `${sn}.active.tgo`);
  const base = fs.existsSync(tgmoPath) ? fs.readFileSync(tgmoPath) : null;
  const active = fs.existsSync(activePath) ? fs.readFileSync(activePath) : null;
  if (!base && !active) return null;
  return active ? mergeIntoTgmo(base, active) : base!;
}

interface FrameCandidate { jpegPath: string; pose: Pose }

/**
 * Alle bruikbare (sidecar + jpeg allebei aanwezig, pose numeriek) frames van
 * alle op dit moment aanwezige sessies voor deze sn. De upload-rotatie in
 * `uploadSessionFrame` houdt dit al op maximaal 5 sessies — hier wordt
 * gewoon de hele map gelezen, geen eigen sessie-selectie nodig.
 */
function loadFrameCandidates(sn: string): FrameCandidate[] {
  const dir = path.join(TERRAIN_DIR, 'frames', sn);
  if (!fs.existsSync(dir)) return [];
  const out: FrameCandidate[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const jpegPath = path.join(dir, `${f.slice(0, -'.json'.length)}.jpg`);
    if (!fs.existsSync(jpegPath)) continue;
    try {
      const pose = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Pose;
      if (![pose.x, pose.y, pose.yaw].every(Number.isFinite)) continue;
      out.push({ jpegPath, pose });
    } catch {
      // corrupte sidecar overslaan — nooit de hele batch laten falen
    }
  }
  return out;
}

/**
 * Kiest het frame met de LAAGSTE `scoreFrame`-waarde — dat is per het
 * contract van `terrainCrops.scoreFrame` ("Lager = beter") het best-gerichte
 * frame. `null` als geen enkel frame binnen bereik valt (hoek/afstand-gate).
 */
function pickBestFrame(
  cluster: Cluster,
  frames: FrameCandidate[],
): { frame: FrameCandidate; target: { cx: number; cy: number } } | null {
  // Match op de ledencellen, niet het centroid: bij een langgerekte of
  // gebogen border ligt het centroid midden in het gazon en kijkt geen
  // enkel frame daarnaartoe. Fallback op het centroid voor (test)clusters
  // zonder memberPoints.
  const points: Array<[number, number]> = cluster.memberPoints?.length
    ? cluster.memberPoints
    : [[cluster.cx, cluster.cy]];
  let best: { frame: FrameCandidate; target: { cx: number; cy: number } } | null = null;
  let bestScore = Infinity;
  for (const f of frames) {
    for (const [px, py] of points) {
      const score = scoreFrame({ cx: px, cy: py }, f.pose);
      if (score !== null && score < bestScore) {
        bestScore = score;
        best = { frame: f, target: { cx: px, cy: py } };
      }
    }
  }
  return best;
}

/**
 * Orkestreert clustering → beste-frame → crop → classify → upsert voor één
 * maaier. Retourneert het aantal cluster dat deze run succesvol is
 * geclassificeerd (boven de confidence-drempel). Clusters mét
 * `user_override` worden overgeslagen voor crop/classify (de override wint
 * toch altijd) maar krijgen wel hun geometrie ververst.
 */
export async function runRecognition(sn: string): Promise<number> {
  const ready = await initClassifier();
  if (!ready) return 0;

  const merged = loadMergedTgmo(sn);
  if (!merged) return 0;

  let display: Tgo1;
  try {
    display = parseTgo1(tgmoToDisplayTgo1(merged));
  } catch (err) {
    console.warn(`[terrainRecognition] corrupte objectdata voor ${sn}, batch overgeslagen:`, err instanceof Error ? err.message : err);
    return 0;
  }

  const clusters = clusterObjects(display);
  if (clusters.length === 0) return 0;

  const existingByKey = new Map(terrainClusterRepo.findBySn(sn).map((r) => [r.cluster_key, r]));
  const frames = loadFrameCandidates(sn);
  const cropsDir = path.join(TERRAIN_DIR, 'crops', sn);

  let classified = 0;
  for (const cluster of clusters) {
    try {
      const row = existingByKey.get(cluster.key);
      const geometry = {
        mower_sn: sn,
        cluster_key: cluster.key,
        cx: cluster.cx,
        cy: cluster.cy,
        min_x: cluster.minX,
        min_y: cluster.minY,
        max_x: cluster.maxX,
        max_y: cluster.maxY,
        cells: cluster.cells,
        max_h: cluster.maxH,
      };

      if (row?.user_override) {
        // Override staat vast: alleen geometrie verversen. upsert() raakt
        // user_override sowieso niet aan (repo-contract Task 4/6).
        terrainClusterRepo.upsert({
          ...geometry,
          class_name: row.class_name,
          confidence: row.confidence,
          crop_file: row.crop_file,
        });
        continue;
      }

      const best = pickBestFrame(cluster, frames);
      if (!best) {
        console.warn(`[terrainRecognition] geen bruikbaar frame voor cluster ${cluster.key} (${sn}) — overgeslagen`);
        terrainClusterRepo.upsert({
          ...geometry,
          class_name: row?.class_name ?? null,
          confidence: row?.confidence ?? null,
          crop_file: row?.crop_file ?? null,
        });
        continue;
      }

      const meta = await sharp(best.frame.jpegPath).metadata();
      const box = cropBox(best.target, best.frame.pose, meta.width ?? 0, meta.height ?? 0);
      const jpeg = await cropFrame(best.frame.jpegPath, box);

      const result = await classifyCrop(jpeg);

      fs.mkdirSync(cropsDir, { recursive: true });
      const cropFile = `${cluster.key}.jpg`;
      fs.writeFileSync(path.join(cropsDir, cropFile), jpeg);

      terrainClusterRepo.upsert({
        ...geometry,
        class_name: result?.className ?? null,
        confidence: result?.confidence ?? null,
        crop_file: cropFile,
      });
      if (result) classified++;
    } catch (err) {
      console.warn(`[terrainRecognition] cluster ${cluster.key} (${sn}) overgeslagen door fout:`, err instanceof Error ? err.message : err);
    }
  }

  // Wezen opruimen: clusters die door een nieuwe clustering (bv. het
  // opknippen van een te groot component in tegels) niet meer bestaan,
  // moeten uit de tabel — anders blijven ze met hun oude geometrie én
  // eventuele handmatige correctie op de kaart liggen.
  const verwijderd = terrainClusterRepo.deleteMissingForSn(
    sn,
    clusters.map((c) => c.key),
  );
  if (verwijderd > 0) {
    console.log(`[terrainRecognition] ${verwijderd} verouderde cluster(s) opgeruimd voor ${sn}`);
  }

  return classified;
}
