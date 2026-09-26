import { createHash } from 'node:crypto';
import { classifyCsv } from './bundleClassifier.js';
import type { ExportInput, ParsedBundle, XY } from './portableMap.js';

export interface SnapshotMetadata {
  kind: 'live' | 'generated';
  capturedAt: string;
  consistencyVerified: boolean;
  complete: boolean;
  missing: string[];
  files: Record<string, string>;
}

type MowerFiles = NonNullable<ParsedBundle['mowerFiles']>;

export function mowerFilesManifest(files: MowerFiles): Record<string, string> {
  const manifest: Record<string, string> = {};
  const add = (name: string, bytes: string | Buffer) => { manifest[name] = createHash('sha256').update(bytes).digest('hex'); };
  for (const [name, data] of Object.entries(files.csvFiles)) add(`csv_file/${name}`, data);
  for (const [name, data] of Object.entries(files.x3CsvFiles ?? {})) add(`x3_csv_file/${name}`, data);
  for (const [name, data] of Object.entries(files.mapFilesText ?? {})) add(`map_files/${name}`, data);
  for (const [name, data] of Object.entries(files.mapFilesB64 ?? {})) add(`map_files/${name}`, Buffer.from(data, 'base64'));
  if (files.chargingStationYaml != null) add('charging_station.yaml', files.chargingStationYaml);
  if (files.posJson != null) add('pos.json', files.posJson);
  return manifest;
}

export function parseMapCsv(text: string, name: string): XY[] {
  return text.split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
    const values = line.split(',');
    const x = Number(values[0]), y = Number(values[1]);
    if (values.length < 2 || !values[0].trim() || !values[1].trim() || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid coordinate in ${name}:${i + 1}`);
    }
    return { x, y };
  });
}

/** Live files are the geometry source; DB values may supply labels only. */
export function geometryFromMowerFiles(files: MowerFiles, aliases: Record<string, string> = {}) {
  const workMaps: ExportInput['workMaps'] = [];
  const obstacles: ExportInput['obstacles'] = [];
  const unicom: ExportInput['unicom'] = [];
  const csv = { ...files.csvFiles };
  // A connector can exist only in the firmware's second CSV tree. Preserve it;
  // contradictory nonempty copies cannot define one canonical server geometry.
  for (const [name, data] of Object.entries(files.x3CsvFiles ?? {})) {
    if (classifyCsv(name)?.category !== 'unicom') continue;
    if (!(name in csv)) csv[name] = data;
    if (!data.trim()) continue;
    const full = parseMapCsv(data, name);
    const filtered = parseMapCsv(csv[name] ?? '', name);
    let cursor = 0;
    for (const point of full) {
      if (cursor < filtered.length && point.x === filtered[cursor].x && point.y === filtered[cursor].y) cursor++;
    }
    // Stock csv_file omits points inside work areas; x3 retains the full path.
    if (cursor !== filtered.length) throw new Error(`Conflicting connector copies: ${name}`);
    csv[name] = data;
  }
  for (const [name, text] of Object.entries(csv)) {
    const entry = classifyCsv(name);
    if (!entry) continue;
    const canonical = entry.category === 'work' ? entry.parent! : name.replace(/\.csv$/, '');
    const points = parseMapCsv(text, name);
    if (entry.category !== 'unicom' && points.length < 3) throw new Error(`Incomplete polygon: ${name}`);
    if (entry.category === 'work') workMaps.push({ canonical, alias: aliases[canonical] ?? canonical, points });
    if (entry.category === 'obstacle') obstacles.push({ canonical, alias: aliases[canonical] ?? canonical, points });
    if (entry.category === 'unicom') unicom.push({ canonical, targetMapName: entry.unicomTarget ?? 'charge', points });
  }
  if (!workMaps.length) throw new Error('Snapshot has no work polygon');
  const info = JSON.parse(files.csvFiles['map_info.json'] ?? '{}');
  const chargingPose = info.charging_pose as { x: number; y: number; orientation: number } | undefined;
  if (!chargingPose || ![chargingPose.x, chargingPose.y, chargingPose.orientation].every(Number.isFinite)) {
    throw new Error('Snapshot has no finite charging_pose');
  }
  return { workMaps, obstacles, unicom, chargingPose };
}

/** Old bundles stay readable, but raw mower geometry must win over stale JSON copies. */
export function normalizeBundleGeometry(parsed: ParsedBundle): ParsedBundle {
  if (!parsed.mowerFiles?.csvFiles?.['map_info.json']) return parsed;
  const geometry = geometryFromMowerFiles(parsed.mowerFiles, parsed.metadata.userAliases);
  const area = (points: XY[]) => Math.abs(points.reduce((n, p, i) => {
    const q = points[(i + 1) % points.length]; return n + p.x * q.y - q.x * p.y;
  }, 0)) / 2;
  const polygons = geometry.workMaps.map(p => ({ name: p.canonical, alias: p.alias, points: p.points, areaM2: area(p.points) }));
  return { ...parsed, polygon: polygons[0], polygons,
    obstacles: geometry.obstacles.map(p => ({ name: p.canonical, alias: p.alias, points: p.points, areaM2: area(p.points) })),
    unicom: geometry.unicom.map(p => ({ name: p.canonical, targetMapName: p.targetMapName, points: p.points })),
    metadata: { ...parsed.metadata, originalChargingPose: geometry.chargingPose },
  };
}
