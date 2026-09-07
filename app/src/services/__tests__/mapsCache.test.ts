import { expect, it, vi } from 'vitest';
import * as FileSystem from 'expo-file-system/legacy';
import { mergePendingMaps, readMapsCache, writeMapsCache } from '../mapsCache';
import { isMapPoint, normalizeMapPoints } from '../../utils/mapPoints';

vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///test/',
  getInfoAsync: vi.fn(async () => ({ exists: true })),
  readAsStringAsync: vi.fn(),
  writeAsStringAsync: vi.fn(),
}));

it('repairs API-shaped caches and preserves offline map metadata with iterable geometry', async () => {
  const apiMap = {
    mapId: 'work-0', mapType: 'work', mapName: 'Garden',
    canonicalName: 'map0', fileName: 'map0_work.csv',
    mapArea: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 3 }],
  };
  const pendingMap = { mapId: 'pending-1', mapType: 'work', mapName: 'map1' };
  // Begin Recording used to write API rows; the next offline refresh then
  // crashed at LiveMapView's `allPoints.push(...m.points)`.
  vi.mocked(FileSystem.readAsStringAsync).mockResolvedValue(JSON.stringify({ maps: [apiMap, pendingMap] }));
  const repaired = (await readMapsCache('mower'))!;
  expect(repaired[0]).toEqual({
    mapId: apiMap.mapId, mapType: 'work', mapName: 'Garden',
    canonicalName: 'map0', fileName: 'map0_work.csv', points: apiMap.mapArea,
  });
  expect(repaired[1]).toMatchObject({ ...pendingMap, points: [] });
  expect(repaired.flatMap(m => [...m.points])).toEqual(apiMap.mapArea);

  await writeMapsCache('mower', [apiMap, repaired[1]]);
  const written = JSON.parse(vi.mocked(FileSystem.writeAsStringAsync).mock.calls[0][1]);
  expect(written.maps).toEqual(JSON.parse(JSON.stringify(repaired)));
  expect(written.maps[0]).not.toHaveProperty('mapArea');
});

it('excludes missing and non-finite coordinates from the live map bounds', () => {
  const valid = { x: 0, y: -1 };
  expect(normalizeMapPoints([valid, null, {}, { x: NaN, y: 0 }, { x: 1, y: Infinity }, { x: '1', y: 2 }])).toEqual([valid]);
  expect(normalizeMapPoints(undefined)).toEqual([]);
  expect(normalizeMapPoints('6.22')).toEqual([]);
  expect(isMapPoint({ x: Infinity, y: 2 })).toBe(false);
  expect(isMapPoint(null)).toBe(false);
  expect(isMapPoint(valid)).toBe(true);
});

it('retains a newly saved work area through stale refreshes until its server row arrives', () => {
  const map0 = { mapId: 'work-0', mapType: 'work', canonicalName: 'map0', points: [] };
  const localMap1 = {
    mapId: 'optimistic-map1-123', mapType: 'work', mapName: 'map1', fileName: 'map1_work.csv',
    points: [{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 3 }],
  };
  const deletedMap2 = { mapId: 'work-2', mapType: 'work', canonicalName: 'map2', points: [] };
  const cached = [map0, localMap1, deletedMap2];
  expect(mergePendingMaps([map0], cached)).toEqual([map0, localMap1]);
  const serverMap1 = { ...localMap1, mapId: 'work-1', canonicalName: 'map1', mapName: 'Back garden' };
  expect(mergePendingMaps([map0, serverMap1], cached)).toEqual([map0, serverMap1]);
  expect(mergePendingMaps([map0, { ...serverMap1, canonicalName: undefined }], cached)).toHaveLength(2);
});
