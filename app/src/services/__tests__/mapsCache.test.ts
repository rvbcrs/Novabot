import { expect, it, vi } from 'vitest';
import * as FileSystem from 'expo-file-system/legacy';
import { mergePendingMaps, normalizeCachedMaps, readMapsCache, writeMapsCache } from '../mapsCache';
import { isMapPoint, normalizeMapPoints } from '../../utils/mapPoints';
import { findMissingChannels } from '../../utils/mapChannels';

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

it.each([null, { x: NaN, y: 0 }, { x: 1, y: Infinity }, { x: '1', y: 0 }])(
  'preserves cache metadata but discards incomplete geometry instead of inventing edges: %j', invalid => {
    const map = { mapId: 'work-1', mapType: 'work', mapName: 'Garden', canonicalName: 'map1' };
    const points = [{ x: 0, y: 0 }, invalid, { x: 2, y: 2 }, { x: 0, y: 2 }];
    for (const geometry of [{ points }, { mapArea: points }]) {
      const [cached] = normalizeCachedMaps([{ ...map, ...geometry }]);
      expect(cached).toMatchObject({ ...map, points: [] });
    }
  },
);

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

it('keeps a confirmed offline channel across stale refreshes and retires it for the native pair', () => {
  const areas = normalizeCachedMaps(['map0', 'map1'].map(mapName => ({
    mapId: mapName, mapName, mapType: 'work', points: [],
  })));
  const [channel] = normalizeCachedMaps([{
    mapId: 'optimistic-channel-123', mapType: 'unicom', connectedMaps: ['map1', 'map0'],
    points: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
  }]);
  expect(channel.connectedMaps).toEqual(['map1', 'map0']);
  expect(channel.fileName).toBeUndefined();
  const merged = mergePendingMaps(areas, [...areas, channel]);
  expect(merged).toEqual([...areas, channel]);
  expect(findMissingChannels(merged.map(map => ({ ...map, pointCount: map.points.length })))).toEqual([]);
  const [native] = normalizeCachedMaps([{
    mapId: 'server-channel', mapType: 'unicom', canonicalName: 'map0tomap1_7_unicom', points: channel.points,
  }]);
  const metadata = { ...native, points: [] };
  expect(mergePendingMaps([...areas, metadata], merged)).toEqual([...areas, metadata, channel]);
  expect(mergePendingMaps([...areas, native], merged)).toEqual([...areas, native]);
  expect(channel.connectedMaps).toEqual(['map1', 'map0']); // matching must not mutate cached direction
});

it.each([['map0', 'map0'], ['map0'], ['map0', 'charge'], [0, 'map1'], ['map0', 'map1', 'map2']])(
  'drops invalid confirmed endpoint metadata: %j', (...connectedMaps) => {
    const [map] = normalizeCachedMaps([{ mapId: 'channel', mapType: 'unicom', connectedMaps, points: [] }]);
    expect(map.connectedMaps).toBeUndefined();
  },
);
