import { describe, expect, it } from 'vitest';
import type { LocalPoint } from '../../services/api';
import type { CachedMap } from '../../services/mapsCache';
import { findMappingOverlapIds } from '../mappingOverlap';

const xy = (pairs: number[][]): LocalPoint[] => pairs.map(([x, y]) => ({ x, y }));
const square = xy([[0, 0], [2, 0], [2, 2], [0, 2]]);
const work = (points = square, mapId = 'map0'): CachedMap => ({ mapId, mapType: 'work', points });

describe('findMappingOverlapIds', () => {
  it.each([
    ['inside', [[1, 1]], true],
    ['left boundary', [[0, 1]], true],
    ['right boundary', [[2, 1]], true],
    ['top boundary', [[1, 2]], true],
    ['bottom boundary', [[1, 0]], true],
    ['corner', [[2, 2]], true],
    ['crossing between outside BLE samples', [[-1, 1], [3, 1]], true],
    ['tangent at a corner', [[-1, 1], [1, 3]], true],
    ['collinear boundary overlap', [[-1, 2], [3, 2]], true],
    ['repeated boundary sample', [[2, 1], [2, 1]], true],
    ['outside', [[3, 0], [3, 2]], false],
    ['collinear beyond the boundary', [[3, 2], [4, 2]], false],
    ['close but outside', [[-1, 2.001], [3, 2.001]], false],
    ['open trail without an invented closing segment', [[-1, 1], [-1, 3], [3, 3], [3, 1]], false],
  ] as const)('%s', (_name, pairs, overlaps) => {
    const points = pairs.map(([x, y]) => ({ x, y }));
    expect(findMappingOverlapIds(points, [work()])).toEqual(overlaps ? ['map0'] : []);
  });

  it('finds the crossing from an incremental slice retaining the previous point', () => {
    const trail = xy([[-2, 1], [-1, 1], [3, 1]]);
    expect(findMappingOverlapIds(trail.slice(0, 2), [work()])).toEqual([]);
    expect(findMappingOverlapIds(trail.slice(1), [work()])).toEqual(['map0']);
  });

  it('ignores channels and obstacles and returns unique work IDs in map order', () => {
    const maps = [work(square, 'second'), { ...work(), mapType: 'unicom' },
      { ...work(), mapType: 'obstacle' }, work(), work(square, 'second')];
    expect(findMappingOverlapIds(xy([[1, 1]]), maps)).toEqual(['second', 'map0']);
  });

  it('accepts reversed winding and an explicitly closed polygon', () => {
    expect(findMappingOverlapIds(xy([[1, 1]]), [work([...square, square[0]].reverse())])).toEqual(['map0']);
  });

  it('skips malformed or degenerate maps without inventing edges', () => {
    const maps = [null, {}, { ...work(), mapId: 7 }, work([]), work(square.slice(0, 2)),
      work(xy([[0, 0], [1, 0], [2, 0]])), { ...work(), points: undefined },
      { ...work(), points: {} }, work([...square, { x: NaN, y: 1 }]),
      work([...square, { x: 1, y: Infinity }]), work([...square, null as unknown as LocalPoint])];
    expect(findMappingOverlapIds(xy([[1, 0], [1, 1]]), maps as CachedMap[])).toEqual([]);
  });

  it('handles empty input and invalid samples without connecting across gaps', () => {
    expect(findMappingOverlapIds([], [work()])).toEqual([]);
    expect(findMappingOverlapIds(null as unknown as LocalPoint[], [work()])).toEqual([]);
    expect(findMappingOverlapIds(xy([[1, 1]]), undefined as unknown as CachedMap[])).toEqual([]);
    const gap = [{ x: -1, y: 1 }, { x: NaN, y: 1 }, { x: 3, y: 1 }];
    expect(findMappingOverlapIds(gap, [work()])).toEqual([]);
    expect(findMappingOverlapIds([...gap, { x: 1, y: 1 }], [work()])).toEqual(['map0']);
  });

  it('detects the first map0 entry from the captured rejected map1 recording', () => {
    // Physical save rejection 14:53:40: map0 outline and recording samples 88–89.
    const map0 = xy([
      [-0.62, 3.67], [-0.56, 2.98], [-0.54, 1.77], [-0.48, 1.57],
      [-0.49, 0.46], [-0.16, -0.02], [0.24, -0.27], [0.41, -0.33],
      [0.89, -0.28], [1.04, -0.24], [1.04, -0.16], [1.17, -0.06],
      [1.73, 0.25], [2.02, 0.69], [2.14, 1.16], [2.38, 1.46],
      [2.53, 1.57], [2.68, 1.6], [2.97, 1.81], [3.28, 1.94],
      [3.37, 2.06], [3.58, 3.06], [3.76, 4.56], [3.71, 4.71],
      [1.58, 5.89], [0.87, 5.92], [0.7, 5.86], [0.24, 5.57],
      [-0.12, 5.24], [-0.42, 4.83], [-0.55, 4.42], [-0.48, 4.32],
      [-0.48, 4.09], [-0.59, 3.96],
    ]);
    const before = xy([[3.619565, 6.032769]]);
    const crossing = xy([[3.673665, 3.384875], [3.566865, 3.496724]]);
    expect(findMappingOverlapIds(before, [work(map0)])).toEqual([]);
    expect(findMappingOverlapIds(crossing, [work(map0)])).toEqual(['map0']);
  });
});
