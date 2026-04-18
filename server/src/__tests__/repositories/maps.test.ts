import { describe, it, expect } from 'vitest';
import { mapRepo } from '../../db/repositories/index.js';
import { deriveCanonicalName, isCanonicalMapName } from '../../db/repositories/maps.js';

describe('MapRepository', () => {
  const sn = 'LFIN0001';

  describe('create + find', () => {
    it('creates a map and finds by mower SN', () => {
      mapRepo.create({
        map_id: 'map-1',
        mower_sn: sn,
        map_name: 'Test Map',
        map_area: '[{"x":1,"y":2},{"x":3,"y":4}]',
        map_type: 'work',
      });

      const maps = mapRepo.findByMowerSn(sn);
      expect(maps.length).toBe(1);
      expect(maps[0].map_name).toBe('Test Map');
      expect(maps[0].map_type).toBe('work');
    });

    it('findById returns correct map', () => {
      mapRepo.create({ map_id: 'map-1', mower_sn: sn, map_name: 'A' });
      mapRepo.create({ map_id: 'map-2', mower_sn: sn, map_name: 'B' });

      const found = mapRepo.findById('map-2');
      expect(found).toBeDefined();
      expect(found!.map_name).toBe('B');
    });
  });

  describe('upsert', () => {
    it('inserts new map', () => {
      mapRepo.upsert({
        map_id: 'map-1',
        mower_sn: sn,
        map_name: 'Original',
      });
      expect(mapRepo.findById('map-1')!.map_name).toBe('Original');
    });

    it('replaces existing map', () => {
      mapRepo.upsert({ map_id: 'map-1', mower_sn: sn, map_name: 'First' });
      mapRepo.upsert({ map_id: 'map-1', mower_sn: sn, map_name: 'Second' });
      expect(mapRepo.findById('map-1')!.map_name).toBe('Second');
      expect(mapRepo.countByMowerSn(sn)).toBe(1);
    });
  });

  describe('findWorkMaps', () => {
    it('returns only work maps with area', () => {
      mapRepo.create({ map_id: 'w1', mower_sn: sn, map_name: 'Work', map_area: '[{"x":0,"y":0}]', map_type: 'work' });
      mapRepo.create({ map_id: 'o1', mower_sn: sn, map_name: 'Obstacle', map_area: '[{"x":0,"y":0}]', map_type: 'obstacle' });
      mapRepo.create({ map_id: 'w2', mower_sn: sn, map_name: 'NoArea', map_type: 'work' }); // no map_area

      const work = mapRepo.findWorkMaps(sn);
      expect(work.length).toBe(1);
      expect(work[0].map_name).toBe('Work');
    });
  });

  describe('delete', () => {
    it('deleteById removes single map', () => {
      mapRepo.create({ map_id: 'map-1', mower_sn: sn, map_name: 'A' });
      mapRepo.create({ map_id: 'map-2', mower_sn: sn, map_name: 'B' });
      mapRepo.deleteById('map-1');
      expect(mapRepo.countByMowerSn(sn)).toBe(1);
    });

    it('deleteByMowerSn removes all maps for SN', () => {
      mapRepo.create({ map_id: 'map-1', mower_sn: sn });
      mapRepo.create({ map_id: 'map-2', mower_sn: sn });
      mapRepo.create({ map_id: 'map-3', mower_sn: 'LFIN9999' });
      mapRepo.deleteByMowerSn(sn);
      expect(mapRepo.countByMowerSn(sn)).toBe(0);
      expect(mapRepo.countByMowerSn('LFIN9999')).toBe(1);
    });
  });

  describe('deleteWithCascade', () => {
    it('cascades obstacles and unicom channels matching the canonical prefix', () => {
      // Mirror the real mower layout — work rows carry file_name like "map1_work.csv"
      mapRepo.create({ map_id: 'w0', mower_sn: sn, map_name: 'Zone0', file_name: 'map0_work.csv', map_type: 'work' });
      mapRepo.create({ map_id: 'w1', mower_sn: sn, map_name: 'Zone1', file_name: 'map1_work.csv', map_type: 'work' });
      mapRepo.create({ map_id: 'w2', mower_sn: sn, map_name: 'Zone2', file_name: 'map2_work.csv', map_type: 'work' });
      mapRepo.create({ map_id: 'o1a', mower_sn: sn, map_name: 'tree', file_name: 'map1_0_obstacle.csv', map_type: 'obstacle' });
      mapRepo.create({ map_id: 'o1b', mower_sn: sn, map_name: 'bush', file_name: 'map1_3_obstacle.csv', map_type: 'obstacle' });
      mapRepo.create({ map_id: 'u01', mower_sn: sn, map_name: 'ch01', file_name: 'map0tomap1_0_unicom.csv', map_type: 'unicom' });
      mapRepo.create({ map_id: 'u12', mower_sn: sn, map_name: 'ch12', file_name: 'map1tomap2_0_unicom.csv', map_type: 'unicom' });
      mapRepo.create({ map_id: 'u0c', mower_sn: sn, map_name: 'charge0', file_name: 'map0tocharge_unicom.csv', map_type: 'unicom' });
      // Sibling that must survive (map10 must NOT match map1)
      mapRepo.create({ map_id: 'w10', mower_sn: sn, map_name: 'Zone10', file_name: 'map10_work.csv', map_type: 'work' });

      const deleted = mapRepo.deleteWithCascade('w1', sn);
      const deletedIds = deleted.map(d => d.map_id).sort();
      expect(deletedIds).toEqual(['o1a', 'o1b', 'u01', 'u12', 'w1']);

      const remaining = mapRepo.findByMowerSn(sn).map(r => r.map_id).sort();
      expect(remaining).toEqual(['u0c', 'w0', 'w10', 'w2']);
    });

    it('falls back to map_name when file_name is the shared ZIP', () => {
      // Installs that persist the shared ZIP name carry canonical names in map_name
      const zip = 'LFIN0001_latest.zip';
      mapRepo.create({ map_id: 'w0', mower_sn: sn, map_name: 'map0', file_name: zip, map_type: 'work' });
      mapRepo.create({ map_id: 'u01', mower_sn: sn, map_name: 'map0tomap1_0_unicom', file_name: zip, map_type: 'unicom' });
      mapRepo.create({ map_id: 'u0c', mower_sn: sn, map_name: 'map0tocharge_unicom', file_name: zip, map_type: 'unicom' });

      const deleted = mapRepo.deleteWithCascade('w0', sn);
      const deletedIds = deleted.map(d => d.map_id).sort();
      expect(deletedIds).toEqual(['u01', 'u0c', 'w0']);
      expect(mapRepo.countByMowerSn(sn)).toBe(0);
    });

    it('returns empty array and no-ops when target does not exist', () => {
      const deleted = mapRepo.deleteWithCascade('nonexistent', sn);
      expect(deleted).toEqual([]);
    });
  });

  describe('canonical_name', () => {
    it('derives map0 from map_name for bare work slots', () => {
      expect(deriveCanonicalName({ file_name: null, map_name: 'map0', map_type: 'work' })).toBe('map0');
    });

    it('derives map0 from map0_work.csv file_name', () => {
      expect(deriveCanonicalName({ file_name: 'map0_work.csv', map_name: 'Backyard', map_type: 'work' })).toBe('map0');
    });

    it('derives obstacle canonical from file_name', () => {
      expect(deriveCanonicalName({ file_name: 'map1_3_obstacle.csv', map_name: 'tree', map_type: 'obstacle' })).toBe('map1_3_obstacle');
    });

    it('derives unicom canonical from file_name', () => {
      expect(deriveCanonicalName({ file_name: 'map0tomap1_0_unicom.csv', map_name: null, map_type: 'unicom' })).toBe('map0tomap1_0_unicom');
      expect(deriveCanonicalName({ file_name: 'map0tocharge_unicom.csv', map_name: null, map_type: 'unicom' })).toBe('map0tocharge_unicom');
    });

    it('ignores shared ZIP file_name and falls back to map_name', () => {
      const zip = 'LFIN0001_1234567890.zip';
      expect(deriveCanonicalName({ file_name: zip, map_name: 'map0', map_type: 'work' })).toBe('map0');
      expect(deriveCanonicalName({ file_name: zip, map_name: 'map0tomap1_0_unicom', map_type: 'unicom' })).toBe('map0tomap1_0_unicom');
    });

    it('returns null for non-canonical names', () => {
      expect(deriveCanonicalName({ file_name: null, map_name: 'Backyard', map_type: 'work' })).toBeNull();
      expect(deriveCanonicalName({ file_name: 'random.bin', map_name: null, map_type: 'work' })).toBeNull();
    });

    it('auto-derives canonical_name on create', () => {
      mapRepo.create({ map_id: 'w0', mower_sn: sn, map_name: 'Backyard', file_name: 'map0_work.csv', map_type: 'work' });
      const row = mapRepo.findById('w0')!;
      expect(row.canonical_name).toBe('map0');
    });

    it('findBySnAndCanonical returns the same row regardless of alias', () => {
      mapRepo.create({ map_id: 'w0', mower_sn: sn, map_name: 'Backyard', file_name: 'map0_work.csv', map_type: 'work' });
      const found = mapRepo.findBySnAndCanonical(sn, 'map0');
      expect(found).toBeDefined();
      expect(found!.map_id).toBe('w0');
      expect(found!.map_name).toBe('Backyard');
    });

    it('UNIQUE index blocks duplicate (mower_sn, canonical_name)', () => {
      mapRepo.create({ map_id: 'w0a', mower_sn: sn, map_name: 'First', file_name: 'map0_work.csv', map_type: 'work' });
      expect(() =>
        mapRepo.create({ map_id: 'w0b', mower_sn: sn, map_name: 'Duplicate', file_name: 'map0_work.csv', map_type: 'work' })
      ).toThrow();
    });

    it('isCanonicalMapName recognises slot labels but not user aliases', () => {
      expect(isCanonicalMapName(null)).toBe(true);
      expect(isCanonicalMapName('')).toBe(true);
      expect(isCanonicalMapName('map0')).toBe(true);
      expect(isCanonicalMapName('map12')).toBe(true);
      expect(isCanonicalMapName('map1_3_obstacle')).toBe(true);
      expect(isCanonicalMapName('map0tomap1_0_unicom')).toBe(true);
      expect(isCanonicalMapName('map0tocharge_unicom')).toBe(true);
      // User aliases must not be classified as canonical
      expect(isCanonicalMapName('achter')).toBe(false);
      expect(isCanonicalMapName('zij')).toBe(false);
      expect(isCanonicalMapName('Backyard')).toBe(false);
      expect(isCanonicalMapName('map0_renamed')).toBe(false);
    });

    it('allows same canonical_name across different mowers', () => {
      mapRepo.create({ map_id: 'm1w0', mower_sn: sn, map_name: 'A', file_name: 'map0_work.csv', map_type: 'work' });
      mapRepo.create({ map_id: 'm2w0', mower_sn: 'LFIN9999', map_name: 'B', file_name: 'map0_work.csv', map_type: 'work' });
      expect(mapRepo.findBySnAndCanonical(sn, 'map0')?.map_id).toBe('m1w0');
      expect(mapRepo.findBySnAndCanonical('LFIN9999', 'map0')?.map_id).toBe('m2w0');
    });
  });

  describe('calibration', () => {
    it('set and get calibration', () => {
      mapRepo.setCalibration(sn, {
        charger_lat: 52.14,
        charger_lng: 6.23,
      });
      const cal = mapRepo.getCalibration(sn);
      expect(cal).toBeDefined();
      expect(cal!.charger_lat).toBe(52.14);
      expect(cal!.charger_lng).toBe(6.23);
    });

    it('getChargerGps returns lat/lng', () => {
      mapRepo.setCalibration(sn, { charger_lat: 52.14, charger_lng: 6.23 });
      const gps = mapRepo.getChargerGps(sn);
      expect(gps).toEqual({ lat: 52.14, lng: 6.23 });
    });

    it('getChargerGps returns null if no calibration', () => {
      expect(mapRepo.getChargerGps(sn)).toBeNull();
    });
  });
});
