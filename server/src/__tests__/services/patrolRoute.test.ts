// server/src/__tests__/services/patrolRoute.test.ts
import { describe, it, expect } from 'vitest';
import { patrolCheckpoints, buildPatrolZones, distToBoundary, PATROL_MAX_POINTS } from '../../services/patrolRoute.js';
import { pointInPolygon } from '../../maps/editGeometry.js';

const SQ = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
const shift = (poly: Array<{ x: number; y: number }>, dx: number) => poly.map(p => ({ x: p.x + dx, y: p.y }));
const row = (zone: string, poly: Array<{ x: number; y: number }>) => ({ canonical_name: zone, map_area: JSON.stringify(poly) });
const key = (ps: Array<{ x: number; y: number }>) => ps.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).sort();

describe('patrol checkpoints', () => {
  it('lie inside the zone, 0.6 m from the border, about every spacing metres', () => {
    const pts = patrolCheckpoints(SQ, 5);
    expect(pts).toHaveLength(8);
    for (const p of pts) {
      expect(pointInPolygon(p, SQ)).toBe(true);
      expect(distToBoundary(p, SQ)).toBeCloseTo(0.6, 5);
    }
  });

  it('do not depend on the winding of the polygon', () => {
    expect(key(patrolCheckpoints([...SQ].reverse(), 5))).toEqual(key(patrolCheckpoints(SQ, 5)));
  });

  it('a strip narrower than twice the inset gets no checkpoint', () => {
    const strip = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 1 }, { x: 0, y: 1 }];
    expect(patrolCheckpoints(strip, 3)).toEqual([]);
  });

  it('a degenerate polygon gets none', () => {
    expect(patrolCheckpoints([{ x: 0, y: 0 }, { x: 1, y: 1 }], 3)).toEqual([]);
  });
});

describe('patrol plan', () => {
  it("without a choice patrols only the dock's zone", () => {
    const plan = buildPatrolZones([row('map0', SQ), row('map1', shift(SQ, 20))], [], 5, { x: 1, y: 1 });
    expect(plan.map(z => z.zone)).toEqual(['map0']);
  });

  it("puts the dock's zone first and the rest by slot", () => {
    const plan = buildPatrolZones([row('map2', shift(SQ, 40)), row('map0', SQ), row('map1', shift(SQ, 20))],
      ['map2', 'map1', 'map0'], 5, { x: 21, y: 1 });
    expect(plan.map(z => z.zone)).toEqual(['map1', 'map0', 'map2']);
  });

  it('skips obstacle rows, broken polygons and zones that do not exist', () => {
    const plan = buildPatrolZones([row('map0_0_obstacle', SQ), { canonical_name: 'map1', map_area: '{oops' }, row('map0', SQ)],
      ['map0', 'map1', 'map7'], 5, null);
    expect(plan.map(z => z.zone)).toEqual(['map0']);
  });

  it('thins a big garden to the cap and keeps every zone', () => {
    const big = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const plan = buildPatrolZones([row('map0', big), row('map1', shift(big, 200))], ['map0', 'map1'], 3, null);
    expect(plan.reduce((n, z) => n + z.points.length, 0)).toBeLessThanOrEqual(PATROL_MAX_POINTS);
    expect(plan.map(z => z.zone)).toEqual(['map0', 'map1']);
    expect(plan.every(z => z.points.length > 0)).toBe(true);
  });

  it('rounds points to centimetres for the wire', () => {
    const plan = buildPatrolZones([row('map0', SQ)], ['map0'], 5, null);
    for (const [x, y] of plan[0].points) {
      expect(Math.round(x * 100) / 100).toBe(x);
      expect(Math.round(y * 100) / 100).toBe(y);
    }
  });
});
