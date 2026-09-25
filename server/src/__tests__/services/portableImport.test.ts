import { describe, it, expect } from 'vitest';
import { db } from '../../db/database.js';
import { mapRepo } from '../../db/repositories/maps.js';
import { importParsedBundleServerCopy } from '../../services/portableImport.js';
import type { ParsedBundle } from '../../services/portableMap.js';

const polygon = { name: 'map0', alias: 'Garden', areaM2: 25,
  points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }] };
const bundle = { metadata: { originalChargingPose: { x: 0, y: 0, orientation: 1.5 } },
  polygon, polygons: [polygon], obstacles: [], unicom: [] } as unknown as ParsedBundle;

describe('atomic portable import', () => {
  it('restores two mowers with globally unique internal IDs', () => {
    importParsedBundleServerCopy('A', bundle);
    importParsedBundleServerCopy('B', bundle);
    const a = mapRepo.findByMowerSn('A')[0], b = mapRepo.findByMowerSn('B')[0];
    expect(a.canonical_name).toBe('map0');
    expect(b.canonical_name).toBe('map0');
    expect(a.map_id).not.toBe(b.map_id);
    expect(a.file_name).toBe('map0_work.csv');
  });

  it('rolls back deleted maps and calibration when an insert fails', () => {
    importParsedBundleServerCopy('A', bundle);
    mapRepo.setPolygonOffset('A', 2, 3);
    const before = mapRepo.findByMowerSn('A');
    db.exec("CREATE TEMP TRIGGER reject_test_map BEFORE INSERT ON maps WHEN NEW.mower_sn = 'A' BEGIN SELECT RAISE(FAIL, 'test disk constraint'); END");
    try {
      expect(() => importParsedBundleServerCopy('A', bundle)).toThrow('test disk constraint');
      expect(mapRepo.findByMowerSn('A')).toEqual(before);
      expect(mapRepo.getPolygonOffset('A')).toEqual({ x: 2, y: 3 });
    } finally { db.exec('DROP TRIGGER reject_test_map'); }
  });
});
