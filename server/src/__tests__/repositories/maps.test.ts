import { describe, it, expect } from 'vitest';
import { mapRepo } from '../../db/repositories/index.js';

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
