import { describe, expect, it } from 'vitest';
import {
  CHANNEL_MIN_GAP_M, ZONE_TOUCH_M, findCloseZonePairs, findMissingChannels, findZonePair, getWorkMapName,
  zoneGapMeters, type ChannelMapLike,
} from '../mapChannels';

const work = (canonicalName: string): ChannelMapLike => ({ mapType: 'work', canonicalName });
const unicom = (canonicalName: string, pointCount = 10): ChannelMapLike => ({ mapType: 'unicom', canonicalName, pointCount });

describe('findMissingChannels', () => {
  it('returns [] for a single work map', () => {
    expect(findMissingChannels([work('map0')])).toEqual([]);
  });

  it('returns [] when the only other map is connected to the dock', () => {
    expect(findMissingChannels([work('map0'), work('map1'), unicom('map0tomap1_0_unicom')])).toEqual([]);
  });

  it('flags an unconnected zone, suggesting the dock map', () => {
    expect(findMissingChannels([work('map0'), work('map1')])).toEqual([{ from: 'map1', to: 'map0' }]);
  });

  it('hub-and-spoke is reachable transitively — no direct map1<->map2 needed (issue #97)', () => {
    const maps = [
      work('map0'), work('map1'), work('map2'),
      unicom('map0tomap1_0_unicom'),
      unicom('map0tomap2_0_unicom'),
    ];
    expect(findMissingChannels(maps)).toEqual([]);
  });

  it('suggests attaching an unreachable zone to the nearest reachable lower-index map', () => {
    // map0<->map1 only; map2 is unreachable. Nearest reachable lower-index = map1.
    const maps = [work('map0'), work('map1'), work('map2'), unicom('map0tomap1_0_unicom')];
    expect(findMissingChannels(maps)).toEqual([{ from: 'map2', to: 'map1' }]);
  });

  it('a metadata-only connector (<2 points) is not navigable', () => {
    const maps = [work('map0'), work('map1'), unicom('map0tomap1_0_unicom', 1)];
    expect(findMissingChannels(maps)).toEqual([{ from: 'map1', to: 'map0' }]);
  });

  it('ignores charge connectors (map0tocharge)', () => {
    const maps = [work('map0'), work('map1'), unicom('map0tocharge_unicom'), unicom('map0tomap1_0_unicom')];
    expect(findMissingChannels(maps)).toEqual([]);
  });

  it('uses confirmed offline endpoints without inventing a firmware filename', () => {
    const offline: ChannelMapLike = { mapType: 'unicom', connectedMaps: ['map1', 'map0'], pointCount: 2 };
    expect(findMissingChannels([work('map0'), work('map1'), offline])).toEqual([]);
    expect(findMissingChannels([work('map0'), work('map1'), { ...offline, pointCount: 1 }]))
      .toEqual([{ from: 'map1', to: 'map0' }]);
  });

  it('identifies renamed work areas by stable canonical slot', () => {
    expect(getWorkMapName({ mapType: 'work', canonicalName: 'map1', mapName: 'Garden' })).toBe('map1');
    expect(getWorkMapName({ mapType: 'work', fileName: 'map2_work.csv', mapName: 'Garden' })).toBe('map2');
  });

  it('a zone that joins the network brings the zones it already connects to', () => {
    // map1<->map2 exists; once map1 is linked to map0, map2 is reachable too.
    const maps = [work('map0'), work('map1'), work('map2'), unicom('map1tomap2_0_unicom')];
    expect(findMissingChannels(maps)).toEqual([{ from: 'map1', to: 'map0' }]);
  });
});

// Axis-aligned square outline, side `s`, lower-left corner at (x, y).
const square = (x: number, y: number, s = 5) => [
  { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
];
const zone = (canonicalName: string, points: { x: number; y: number }[]): ChannelMapLike =>
  ({ mapType: 'work', canonicalName, points });

describe('zoneGapMeters', () => {
  it('is 0 for zones that share an edge, overlap, or nest', () => {
    expect(zoneGapMeters(square(0, 0), square(5, 0))).toBe(0);
    expect(zoneGapMeters(square(0, 0), square(3, 3))).toBe(0);
    expect(zoneGapMeters(square(0, 0, 10), square(2, 2, 2))).toBe(0);
  });

  it('measures the gap between separate zones', () => {
    expect(zoneGapMeters(square(0, 0), square(5.4, 0))).toBeCloseTo(0.4);
    // Diagonal: corner (5,5) to corner (8,9) is 5 m.
    expect(zoneGapMeters(square(0, 0), square(8, 9))).toBeCloseTo(5);
  });

  it('only promises "at least limit" for zones beyond the limit', () => {
    expect(zoneGapMeters(square(0, 0), square(20, 0), 1)).toBeGreaterThanOrEqual(1);
  });

  it('rejects unusable outlines', () => {
    expect(zoneGapMeters([{ x: 0, y: 0 }, { x: 1, y: 0 }], square(5, 0))).toBeNull();
    expect(zoneGapMeters([{ x: 0, y: 0 }, { x: 1, y: NaN }, { x: 1, y: 1 }], square(5, 0))).toBeNull();
  });
});

describe('findCloseZonePairs', () => {
  it('reports touching and too-close pairs, not zones about 1 m or more apart', () => {
    const pairs = findCloseZonePairs([
      zone('map0', square(0, 0)),
      zone('map1', square(5, 0)),     // shares map0's right edge
      zone('map2', square(0, 5.5)),   // 0.5 m above map0
      zone('map3', square(20, 0)),    // far away
      zone('map4', square(10.95, 0)), // 0.95 m right of map1: the gap that recorded fine
    ]);
    expect(pairs.map(p => [p.a, p.b, p.touching])).toEqual([
      ['map0', 'map1', true],
      ['map0', 'map2', false],
      ['map1', 'map2', false],
      ['map1', 'map4', false],
    ]);
    expect(findZonePair(pairs, 'map2', 'map0')?.gapM).toBeCloseTo(0.5);
    expect(findZonePair(pairs, 'map0', 'map3')).toBeUndefined();
    expect(CHANNEL_MIN_GAP_M).toBe(1);
  });

  it('counts a gap within one map cell as touching', () => {
    const [pair] = findCloseZonePairs([zone('map0', square(0, 0)), zone('map1', square(5.03, 0))]);
    expect(pair.touching).toBe(true);
    expect(pair.gapM).toBeLessThanOrEqual(ZONE_TOUCH_M);
  });

  it('skips zones without an outline', () => {
    expect(findCloseZonePairs([work('map0'), zone('map1', square(5, 0))])).toEqual([]);
  });
});

describe('findMissingChannels with zone outlines', () => {
  it('treats touching zones as connected: no channel to record', () => {
    expect(findMissingChannels([zone('map0', square(0, 0)), zone('map1', square(5, 0))])).toEqual([]);
  });

  it('still asks for a channel between zones that do not touch, however close', () => {
    expect(findMissingChannels([zone('map0', square(0, 0)), zone('map1', square(5.5, 0))]))
      .toEqual([{ from: 'map1', to: 'map0' }]);
  });

  it('never suggests a channel between two touching zones', () => {
    // map1 and map2 touch each other, neither reaches map0: one channel to map0 suffices.
    const maps = [zone('map0', square(0, 0)), zone('map1', square(10, 0)), zone('map2', square(15, 0))];
    expect(findMissingChannels(maps)).toEqual([{ from: 'map1', to: 'map0' }]);
  });
});
