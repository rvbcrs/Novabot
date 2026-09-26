import { randomUUID } from 'node:crypto';
import { db } from '../db/database.js';
import { mapRepo } from '../db/repositories/maps.js';
import type { ParsedBundle } from './portableMap.js';

/** Replace one mower's server copy atomically. Never keep a DB transaction open during MQTT. */
export function preparePortableImport(sn: string, parsed: ParsedBundle) {
  const work = parsed.polygons?.length ? parsed.polygons : [parsed.polygon];
  const rows = [
    ...work.map(p => ({ ...p, type: 'work', filename: `${p.name}_work.csv` })),
    ...parsed.obstacles.map(p => ({ ...p, type: 'obstacle', filename: `${p.name}.csv` })),
    ...parsed.unicom.map(p => ({ ...p, alias: p.targetMapName, type: 'unicom', filename: `${p.name}.csv` })),
  ];
  const names = new Set<string>();
  for (const row of rows) {
    if (!/^map\d+(?:_\d+_obstacle|to(?:charge|map\d+)(?:_\d+)?_unicom)?$/.test(row.name)
      || names.has(row.name)) throw new Error(`Invalid or duplicate canonical map name: ${row.name}`);
    names.add(row.name);
    if (!Array.isArray(row.points) || row.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      throw new Error(`Invalid points in ${row.name}`);
    }
  }
  const insert = db.prepare(`INSERT INTO maps
    (mower_sn, map_id, map_name, map_type, file_name, map_area, canonical_name, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'import')`);
  return db.transaction(() => {
    db.prepare('DELETE FROM maps WHERE mower_sn = ?').run(sn);
    for (const row of rows) {
      insert.run(sn, randomUUID(), row.alias, row.type, row.filename,
        row.points.length ? JSON.stringify(row.points) : null, row.name);
    }
    const heading = parsed.metadata.originalChargingPose?.orientation;
    if (typeof heading === 'number' && Number.isFinite(heading)) mapRepo.setPolygonChargingOrientation(sn, heading);
    mapRepo.setPolygonOffset(sn, 0, 0);
    return { work: work.length, obstacles: parsed.obstacles.length, unicom: parsed.unicom.length };
  });
}

export function importParsedBundleServerCopy(sn: string, parsed: ParsedBundle) {
  return preparePortableImport(sn, parsed)();
}
