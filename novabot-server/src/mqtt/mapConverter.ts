/**
 * Map Converter — converteert GPS polygonen naar het Novabot CSV/ZIP kaartformaat.
 *
 * De maaier slaat kaarten op als CSV bestanden met lokale x,y coördinaten (meters
 * relatief t.o.v. het laadstation). Dit bestand converteert GPS lat/lng polygonen
 * uit de dashboard database naar dat formaat, en verpakt ze in een ZIP.
 *
 * Coördinaatconversie (WGS84 → lokaal):
 *   x_local = (lon - lon_origin) × cos(lat_origin) × 111320
 *   y_local = (lat - lat_origin) × 111320
 *
 * ZIP structuur (identiek aan firmware):
 *   csv_file/
 *   ├── map_info.json
 *   ├── map0_work.csv
 *   ├── map0_0_obstacle.csv
 *   ├── map0tocharge_unicom.csv
 *   └── ...
 */
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import path from 'path';
import { db } from '../db/database.js';

const TAG = '[MAP-CONV]';

// Meters per graad op de evenaar
const METERS_PER_DEGREE = 111320;

// ── Types ────────────────────────────────────────────────────────

export interface GpsPoint {
  lat: number;
  lng: number;
}

export interface LocalPoint {
  x: number;
  y: number;
}

export interface ChargingPose {
  x: number;
  y: number;
  orientation: number;
}

export interface MapArea {
  mapIndex: number;
  type: 'work' | 'obstacle' | 'unicom';
  /** Voor obstacles: sub-index (0, 1, 2, ...) */
  subIndex?: number;
  /** Voor unicom: doel ("charge" of "map1_0" etc) */
  target?: string;
  points: GpsPoint[];
}

export interface MapPackage {
  sn: string;
  chargingStation: GpsPoint;
  chargingOrientation: number;
  areas: MapArea[];
}

// ── Coördinaat conversie ──────────────────────────────────────────

/**
 * Converteer GPS lat/lng naar lokale x,y meters relatief t.o.v. een origin punt.
 * Optioneel met rotatie (orientation in radialen van het lokale coördinatensysteem).
 */
export function gpsToLocal(point: GpsPoint, origin: GpsPoint, orientation: number = 0): LocalPoint {
  const cosLat = Math.cos(origin.lat * Math.PI / 180);
  // GPS → ongeroteerde meters
  const mx = (point.lng - origin.lng) * cosLat * METERS_PER_DEGREE;
  const my = (point.lat - origin.lat) * METERS_PER_DEGREE;
  if (orientation === 0) return { x: mx, y: my };
  // Roteer naar lokaal coördinatensysteem
  const cos = Math.cos(orientation);
  const sin = Math.sin(orientation);
  return {
    x:  mx * cos + my * sin,
    y: -mx * sin + my * cos,
  };
}

/**
 * Converteer lokale x,y meters terug naar GPS lat/lng.
 * Optioneel met rotatie (orientation in radialen van het lokale coördinatensysteem).
 */
export function localToGps(point: LocalPoint, origin: GpsPoint, orientation: number = 0): GpsPoint {
  let { x, y } = point;
  if (orientation !== 0) {
    // Roteer terug van lokaal naar noord-geörienteerd
    const cos = Math.cos(orientation);
    const sin = Math.sin(orientation);
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    x = rx;
    y = ry;
  }
  const cosLat = Math.cos(origin.lat * Math.PI / 180);
  return {
    lat: origin.lat + y / METERS_PER_DEGREE,
    lng: origin.lng + x / (cosLat * METERS_PER_DEGREE),
  };
}

/**
 * Bereken de oppervlakte van een polygoon in vierkante meters (Shoelace formule).
 */
export function polygonArea(points: LocalPoint[]): number {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return Math.abs(area) / 2;
}

// ── CSV generatie ──────────────────────────────────────────────────

/**
 * Genereer CSV content van x,y punten (Novabot formaat: "x,y\n").
 */
function pointsToCsv(points: LocalPoint[]): string {
  return points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('\n') + '\n';
}

/**
 * Genereer de bestandsnaam voor een kaartgebied conform Novabot firmware conventie.
 */
function areaFileName(area: MapArea): string {
  switch (area.type) {
    case 'work':
      return `map${area.mapIndex}_work.csv`;
    case 'obstacle':
      return `map${area.mapIndex}_${area.subIndex ?? 0}_obstacle.csv`;
    case 'unicom':
      return `map${area.mapIndex}to${area.target ?? 'charge'}_unicom.csv`;
  }
}

// ── ZIP pakket generatie ──────────────────────────────────────────

/**
 * Bouw een compleet kaart-ZIP pakket van GPS polygonen.
 *
 * @returns Pad naar het gegenereerde ZIP bestand
 */
export function buildMapZip(pkg: MapPackage): string {
  const storageDir = path.resolve('storage/maps');
  const tmpDir = path.join(storageDir, `tmp_${pkg.sn}_${Date.now()}`);
  const csvDir = path.join(tmpDir, 'csv_file');
  const zipPath = path.join(storageDir, `${pkg.sn}.zip`);

  // Zorg dat directories bestaan
  mkdirSync(csvDir, { recursive: true });

  const origin: GpsPoint = pkg.chargingStation;

  // map_info.json
  const mapInfo: Record<string, unknown> = {
    charging_pose: {
      x: 0,   // Charging station is altijd de origin
      y: 0,
      orientation: pkg.chargingOrientation,
    },
  };

  // Genereer CSV bestanden
  for (const area of pkg.areas) {
    const localPoints = area.points.map(p => gpsToLocal(p, origin));
    const fileName = areaFileName(area);
    const csvContent = pointsToCsv(localPoints);

    writeFileSync(path.join(csvDir, fileName), csvContent);
    console.log(`${TAG} Gegenereerd: ${fileName} (${localPoints.length} punten)`);

    // Voeg map_size toe aan map_info voor werkgebieden
    if (area.type === 'work') {
      const areaM2 = polygonArea(localPoints);
      mapInfo[fileName] = { map_size: Math.round(areaM2 * 100) / 100 };
    }
  }

  // Schrijf map_info.json
  writeFileSync(
    path.join(csvDir, 'map_info.json'),
    JSON.stringify(mapInfo, null, 3) + '\n'
  );

  // Maak ZIP (met store mode, zoals firmware doet)
  try {
    // Verwijder bestaande ZIP
    if (existsSync(zipPath)) rmSync(zipPath);

    // Gebruik zip commando (beschikbaar op macOS en Linux)
    execSync(`cd "${tmpDir}" && zip -r -0 -q "${zipPath}" csv_file/`);
    console.log(`${TAG} ZIP gegenereerd: ${zipPath}`);
  } catch (err) {
    console.error(`${TAG} ZIP creatie mislukt:`, err);
    throw err;
  } finally {
    // Ruim tmp directory op
    rmSync(tmpDir, { recursive: true, force: true });
  }

  return zipPath;
}

// ── Database integratie ──────────────────────────────────────────

interface MapRow {
  map_id: string;
  mower_sn: string;
  map_name: string | null;
  map_area: string | null;
  map_max_min: string | null;
  map_type: string;
}

/**
 * Genereer een Novabot-compatibel ZIP bestand van alle kaarten voor een maaier.
 *
 * Leest kaart-polygonen uit de database (GPS coördinaten), converteert naar
 * lokaal x,y formaat, en verpakt in een ZIP.
 *
 * @param sn Serienummer van de maaier
 * @param chargingStation GPS positie van het laadstation
 * @param chargingOrientation Oriëntatie van het laadstation (radialen)
 * @returns Pad naar het ZIP bestand, of null als er geen kaarten zijn
 */
export function generateMapZipFromDb(
  sn: string,
  chargingStation: GpsPoint,
  chargingOrientation: number = 0,
): string | null {
  const rows = db.prepare(
    'SELECT * FROM maps WHERE mower_sn = ? AND map_area IS NOT NULL ORDER BY map_id'
  ).all(sn) as MapRow[];

  if (rows.length === 0) {
    console.log(`${TAG} Geen kaarten gevonden voor ${sn}`);
    return null;
  }

  const areas: MapArea[] = [];

  // Splits DB rijen in werk en unicom
  const workRows = rows.filter(r => r.map_type === 'work');
  const unicomRows = rows.filter(r => r.map_type === 'unicom');

  for (let i = 0; i < workRows.length; i++) {
    const row = workRows[i];
    const points: GpsPoint[] = JSON.parse(row.map_area!);

    if (!points || points.length < 3) continue;

    areas.push({
      mapIndex: i,
      type: 'work',
      points,
    });

    // Zoek een handmatig getekend unicom kanaal voor dit werkgebied
    // (unicomRows[i] als die bestaat, anders automatisch genereren)
    if (unicomRows[i]) {
      const unicomPoints: GpsPoint[] = JSON.parse(unicomRows[i].map_area!);
      if (unicomPoints && unicomPoints.length >= 2) {
        areas.push({
          mapIndex: i,
          type: 'unicom',
          target: 'charge',
          points: unicomPoints,
        });
        continue;
      }
    }

    // Geen handmatig kanaal — genereer automatisch een unicom pad
    // (rechte lijn van dichtstbijzijnd punt naar charging station)
    const localPoints = points.map(p => gpsToLocal(p, chargingStation));
    let closestIdx = 0;
    let closestDist = Infinity;
    for (let j = 0; j < localPoints.length; j++) {
      const dist = Math.sqrt(localPoints[j].x ** 2 + localPoints[j].y ** 2);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = j;
      }
    }

    // Unicom: lineair pad van charging station naar dichtstbijzijnd punt
    const closestGps = points[closestIdx];
    const steps = Math.max(5, Math.ceil(closestDist / 0.5)); // stappen van ~0.5m
    const unicomPoints: GpsPoint[] = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      unicomPoints.push({
        lat: chargingStation.lat + t * (closestGps.lat - chargingStation.lat),
        lng: chargingStation.lng + t * (closestGps.lng - chargingStation.lng),
      });
    }

    areas.push({
      mapIndex: i,
      type: 'unicom',
      target: 'charge',
      points: unicomPoints,
    });
  }

  if (areas.length === 0) {
    console.log(`${TAG} Geen geldige kaartgebieden voor ${sn}`);
    return null;
  }

  return buildMapZip({
    sn,
    chargingStation,
    chargingOrientation,
    areas,
  });
}

/**
 * Lees en parseer een bestaand Novabot ZIP kaartbestand.
 *
 * @returns Geparsde kaartdata met GPS coördinaten
 */
export function parseMapZip(
  zipPath: string,
  chargingStation: GpsPoint,
): { areas: MapArea[]; chargingPose: ChargingPose } | null {
  if (!existsSync(zipPath)) return null;

  const tmpDir = path.join(path.dirname(zipPath), `tmp_parse_${Date.now()}`);

  try {
    mkdirSync(tmpDir, { recursive: true });
    execSync(`unzip -o -q "${zipPath}" -d "${tmpDir}"`);

    const csvDir = path.join(tmpDir, 'csv_file');
    if (!existsSync(csvDir)) {
      console.error(`${TAG} Geen csv_file directory in ZIP`);
      return null;
    }

    // Lees map_info.json
    const infoPath = path.join(csvDir, 'map_info.json');
    let chargingPose: ChargingPose = { x: 0, y: 0, orientation: 0 };
    if (existsSync(infoPath)) {
      const info = JSON.parse(readFileSync(infoPath, 'utf-8'));
      if (info.charging_pose) {
        chargingPose = info.charging_pose;
      }
    }

    // Zoek alle CSV bestanden
    const areas: MapArea[] = [];
    const files = execSync(`ls "${csvDir}"/*.csv 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean);

    for (const filePath of files) {
      const fileName = path.basename(filePath);
      const content = readFileSync(filePath, 'utf-8');

      const localPoints: LocalPoint[] = [];
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [xStr, yStr] = trimmed.split(',');
        const x = parseFloat(xStr);
        const y = parseFloat(yStr);
        if (!isNaN(x) && !isNaN(y)) {
          localPoints.push({ x, y });
        }
      }

      if (localPoints.length === 0) continue;

      // Converteer terug naar GPS (met orientation uit map_info.json)
      const gpsPoints = localPoints.map(p => localToGps(p, chargingStation, chargingPose.orientation));

      // Bepaal area type uit bestandsnaam
      const area = parseAreaFileName(fileName, gpsPoints);
      if (area) areas.push(area);
    }

    return { areas, chargingPose };

  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Parse een CSV bestandsnaam naar een MapArea.
 */
function parseAreaFileName(fileName: string, points: GpsPoint[]): MapArea | null {
  // map0_work.csv
  const workMatch = fileName.match(/^map(\d+)_work\.csv$/);
  if (workMatch) {
    return { mapIndex: parseInt(workMatch[1]), type: 'work', points };
  }

  // map0_0_obstacle.csv
  const obstacleMatch = fileName.match(/^map(\d+)_(\d+)_obstacle\.csv$/);
  if (obstacleMatch) {
    return {
      mapIndex: parseInt(obstacleMatch[1]),
      type: 'obstacle',
      subIndex: parseInt(obstacleMatch[2]),
      points,
    };
  }

  // map0tocharge_unicom.csv
  const unicomMatch = fileName.match(/^map(\d+)to(.+)_unicom\.csv$/);
  if (unicomMatch) {
    return {
      mapIndex: parseInt(unicomMatch[1]),
      type: 'unicom',
      target: unicomMatch[2],
      points,
    };
  }

  return null;
}
