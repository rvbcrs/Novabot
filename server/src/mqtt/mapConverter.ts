/**
 * Map Converter — beheert het Novabot CSV/ZIP kaartformaat.
 *
 * De database slaat kaartpolygonen op als lokale x,y coördinaten (meters,
 * charger = 0,0), identiek aan het CSV formaat op de maaier.
 * Conversie GPS ↔ lokaal gebeurt alleen aan de API-grenzen (dashboard, app).
 *
 * Coördinaatconversie (WGS84 ↔ lokaal):
 *   x_local = (lon - lon_origin) × metersPerDegLng(lat_origin)
 *   y_local = (lat - lat_origin) × metersPerDegLat(lat_origin)
 *
 * Eerder gebruikte de code een vlakke constante (111320 m/deg) die alleen
 * op de evenaar klopt — bij 45° gaf dat ~17 cm fout per 100 m langs de
 * noord-zuid as (issue #53). De WGS84-polynoom hieronder corrigeert
 * tot sub-millimeter precisie voor alle gangbare gebruikers-latitudes.
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
import { shiftPoints, isToChargeUnicomName } from '../services/polygonOffset.js';

const TAG = '[MAP-CONV]';

/**
 * Meters per degree of latitude at a given latitude — WGS84 polynomial
 * approximation accurate to sub-mm at all earthly latitudes. Constant
 * 111320 used in the old code is only correct on the equator; at 45° it
 * overshoots by ~190 m/deg → 17 cm error per 100 m of north-south travel.
 */
export function metersPerDegLat(latDeg: number): number {
  const phi = latDeg * Math.PI / 180;
  return 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi) - 0.0023 * Math.cos(6 * phi);
}

/**
 * Meters per degree of longitude at a given latitude. Shrinks with cos(lat)
 * — 111.32 km/deg on the equator, 0 at the poles. WGS84 polynomial
 * approximation keeps sub-mm accuracy.
 */
export function metersPerDegLng(latDeg: number): number {
  const phi = latDeg * Math.PI / 180;
  return 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);
}

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
  points: LocalPoint[];
}

export interface MapPackage {
  sn: string;
  chargingOrientation: number;
  areas: MapArea[];
}

// ── Coördinaat conversie ──────────────────────────────────────────

/**
 * Converteer GPS lat/lng naar lokale x,y meters relatief t.o.v. een origin punt.
 * Optioneel met rotatie (orientation in radialen van het lokale coördinatensysteem).
 */
export function gpsToLocal(point: GpsPoint, origin: GpsPoint, orientation: number = 0): LocalPoint {
  const mPerDegLat = metersPerDegLat(origin.lat);
  const mPerDegLng = metersPerDegLng(origin.lat);
  // GPS → ongeroteerde meters
  const mx = (point.lng - origin.lng) * mPerDegLng;
  const my = (point.lat - origin.lat) * mPerDegLat;
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
  return {
    lat: origin.lat + y / metersPerDegLat(origin.lat),
    lng: origin.lng + x / metersPerDegLng(origin.lat),
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
export function areaFileName(area: MapArea): string {
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

  // map_info.json
  const mapInfo: Record<string, unknown> = {
    charging_pose: {
      x: 0,   // Charging station is altijd de origin
      y: 0,
      orientation: pkg.chargingOrientation,
    },
  };

  // Genereer CSV bestanden — punten zijn al lokaal (charger = 0,0)
  for (const area of pkg.areas) {
    const localPoints = area.points;
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
  file_name: string | null;
  map_type: string;
  canonical_name?: string | null;
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
  chargingOrientation: number = 0,
): string | null {
  const rows = db.prepare(
    'SELECT * FROM maps WHERE mower_sn = ? AND map_area IS NOT NULL ORDER BY map_id'
  ).all(sn) as MapRow[];

  if (rows.length === 0) {
    console.log(`${TAG} Geen kaarten gevonden voor ${sn}`);
    return null;
  }

  // Read polygon offset directly from the DB table to avoid pulling
  // mapRepo (which transitively imports mapBackup → mapConverter and
  // creates an evaluation cycle).
  const offsetRow = db.prepare(
    'SELECT polygon_offset_x_m, polygon_offset_y_m FROM map_calibration WHERE mower_sn = ?'
  ).get(sn) as { polygon_offset_x_m: number; polygon_offset_y_m: number } | undefined;
  const offset = offsetRow
    ? { x: offsetRow.polygon_offset_x_m ?? 0, y: offsetRow.polygon_offset_y_m ?? 0 }
    : { x: 0, y: 0 };

  const areas: MapArea[] = [];

  // Splits DB rijen in werk, unicom en obstakels
  const workRows = rows.filter(r => r.map_type === 'work');
  const unicomRows = rows.filter(r => r.map_type === 'unicom');
  const obstacleRows = rows.filter(r => r.map_type === 'obstacle');

  // Slot komt uit de canonieke naam ("map3_work"), NOOIT uit de array-index:
  // rijen staan op UUID-volgorde, dus na het wissen van map1/map2 werd map3
  // anders als map1_work.csv geschreven (2026-09-07, .244). Alleen rijen zonder
  // herkenbare naam vallen terug op hun positie.
  const slotOf = (r: MapRow): number | null => {
    // canonical_name eerst: dashboard-getekende rijen dragen hun slot daar
    // (map_name blijft de gebruikersnaam, bv. "Werkgebied 4").
    for (const n of [r.canonical_name, r.map_name, r.file_name]) {
      const m = n?.match(/^map(\d+)(_work)?(\.csv)?$/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  };

  // Rijen zonder slotnaam (dashboard-getekend: "Werkgebied 4") krijgen het
  // eerste VRIJE slot, niet hun array-index: die kan botsen met een benoemd slot.
  const taken = new Set(workRows.map(slotOf).filter((n): n is number => n !== null));
  let nextFree = 0;
  const claimFreeSlot = (): number => {
    while (taken.has(nextFree)) nextFree++;
    taken.add(nextFree);
    return nextFree;
  };

  for (let i = 0; i < workRows.length; i++) {
    const row = workRows[i];
    const rawPoints: LocalPoint[] = JSON.parse(row.map_area!);

    if (!rawPoints || rawPoints.length < 3) continue;
    const points = shiftPoints(rawPoints, offset.x, offset.y, false);
    const slot = slotOf(row) ?? claimFreeSlot();

    areas.push({
      mapIndex: slot,
      type: 'work',
      points,
    });

    // Obstacles van dit werkgebied — file_name begint met "mapN_" (bijv. "map0_3_obstacle.csv").
    // We vinden het sub-index terug uit de filename zodat ze dezelfde canonieke CSV namen
    // krijgen als de maaier zelf zou genereren (map0_0_obstacle, map0_3_obstacle, ...).
    // Check both map_name AND file_name — some DB rows have the canonical name
    // ("map0_3_obstacle") in map_name with a ZIP bundle name in file_name. Match
    // whichever holds the "mapN_..._obstacle" pattern.
    const prefix = `map${slot}`;
    const obstaclePattern = new RegExp(`^${prefix}_\\d+_obstacle`);
    const myObstacles = obstacleRows.filter(r => {
      return (
        (r.canonical_name && obstaclePattern.test(r.canonical_name)) ||
        (r.map_name && obstaclePattern.test(r.map_name)) ||
        (r.file_name && obstaclePattern.test(r.file_name))
      );
    });
    for (const obs of myObstacles) {
      try {
        const rawObsPoints: LocalPoint[] = JSON.parse(obs.map_area!);
        if (!rawObsPoints || rawObsPoints.length < 3) continue;
        const obsPoints = shiftPoints(rawObsPoints, offset.x, offset.y, false);
        // Extract sub-index from whichever field carries the canonical name.
        const canonical = [obs.canonical_name, obs.map_name, obs.file_name]
          .find(n => n && obstaclePattern.test(n)) ?? obs.file_name ?? '';
        const match = canonical.match(/^map\d+_(\d+)_obstacle/);
        const subIndex = match ? parseInt(match[1], 10) : areas.filter(a => a.type === 'obstacle' && a.mapIndex === slot).length;
        areas.push({
          mapIndex: slot,
          type: 'obstacle',
          subIndex,
          points: obsPoints,
        });
      } catch { /* skip malformed row */ }
    }

  }

  // Unicoms (kanalen) — emit elk OPGENOMEN kanaal op zijn ECHTE identiteit, afgeleid
  // uit de file_name/map_name ("map0tocharge", "map1tomap2_0"), NOOIT op array-index.
  //
  // Twee bugs die hier zaten en nu weg zijn:
  //  1. Index-koppeling (unicomRows[i] ↔ werkgebied i) plakte een opgenomen kanaal aan
  //     de verkeerde zone — positie i zegt niets over wélke zones het kanaal verbindt.
  //  2. Voor elke index zonder match werd een rechte-lijn-unicom vanaf de charger
  //     verzonnen. Die "auto-kanalen" (rechte lijnen dwars door obstakels) overschreven
  //     het kanaal dat de gebruiker net had opgenomen. We genereren niets meer zelf:
  //     ontbrekende kanalen worden in de app gemeld ("Zones not connected — Add channel")
  //     en door de gebruiker gereden.
  //
  // Lege rijen worden overgeslagen: de LFI-cloud levert map↔map unicoms als 0-byte
  // placeholders (het pad zat alleen in de originele live-pgm), dus een lege rij mag
  // nooit een echt, gereden kanaal verdringen.
  for (const uRow of unicomRows) {
    // file_name is vaak de ZIP-bundelnaam ("LFIN..._<ts>.zip"), de canonieke naam
    // staat dan in map_name. Neem het veld dat op "mapNto..._unicom" lijkt; met
    // alleen file_name vielen ALLE kanalen weg (incl. map0tocharge).
    const unicomName = [uRow.canonical_name, uRow.map_name, uRow.file_name]
      .map(n => (n ?? '').replace(/\.csv$/, ''))
      .find(n => /^map\d+to.+unicom/.test(n));
    const targetMatch = unicomName?.match(/^map(\d+)to(.+?)_?unicom/);
    if (!unicomName || !targetMatch) continue;
    let rawUnicomPoints: LocalPoint[];
    try {
      rawUnicomPoints = JSON.parse(uRow.map_area ?? '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(rawUnicomPoints) || rawUnicomPoints.length < 2) continue; // lege/placeholder overslaan
    const unicomPoints = shiftPoints(rawUnicomPoints, offset.x, offset.y, isToChargeUnicomName(unicomName));
    if (unicomPoints && unicomPoints.length >= 2) {
      areas.push({
        mapIndex: parseInt(targetMatch[1], 10),
        type: 'unicom',
        target: targetMatch[2],
        points: unicomPoints,
      });
    }
  }

  if (areas.length === 0) {
    console.log(`${TAG} Geen geldige kaartgebieden voor ${sn}`);
    return null;
  }

  return buildMapZip({
    sn,
    chargingOrientation,
    areas,
  });
}

/**
 * Lees en parseer een bestaand Novabot ZIP kaartbestand.
 *
 * @returns Geparsde kaartdata met lokale coördinaten (charger = 0,0)
 */
export function parseMapZip(
  zipPath: string,
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
    // READ-ONLY default: this parsed chargingPose is only ever used for display
    // (dashboard JSON) or DB-polygon restore (which writes area.points, NOT the
    // pose). It is NEVER threaded into synthesizeMowerFiles / a mower write, so
    // a {0,0,0} fallback here is harmless. Do NOT feed this value to
    // synthesizeMowerFiles — that path fails closed on a zeroed pose by design.
    const infoPath = path.join(csvDir, 'map_info.json');
    let chargingPose: ChargingPose = { x: 0, y: 0, orientation: 0 };
    if (existsSync(infoPath)) {
      const info = JSON.parse(readFileSync(infoPath, 'utf-8'));
      if (info.charging_pose) {
        chargingPose = info.charging_pose;
      }
    }

    // Zoek alle CSV bestanden — punten blijven lokaal (1:1 met CSV)
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

      // Bepaal area type uit bestandsnaam — punten zijn al lokaal
      const area = parseAreaFileName(fileName, localPoints);
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
function parseAreaFileName(fileName: string, points: LocalPoint[]): MapArea | null {
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
