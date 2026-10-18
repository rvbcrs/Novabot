// server/src/__tests__/services/patrolRoute.test.ts
import { describe, it, expect } from 'vitest';
import { patrolCheckpoints, buildPatrolZones, distToBoundary, PATROL_MAX_POINTS, PATROL_INSET_M } from '../../services/patrolRoute.js';
import { pointInPolygon } from '../../maps/editGeometry.js';

const SQ = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
const shift = (poly: Array<{ x: number; y: number }>, dx: number) => poly.map(p => ({ x: p.x + dx, y: p.y }));
const row = (zone: string, poly: Array<{ x: number; y: number }>) => ({ canonical_name: zone, map_area: JSON.stringify(poly) });
const key = (ps: Array<{ x: number; y: number }>) => ps.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).sort();
/** A 20 m long strip `width` metres wide. */
const strip = (width: number) => [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: width }, { x: 0, y: width }];

describe('patrol checkpoints', () => {
  // First live patrol, 2026-10-15: checkpoints 0.6 m inside the border were
  // occupied costmap cells (hedge overhang, pool edge).
  it('lie inside the zone, 1.0 m from the border, about every spacing metres', () => {
    expect(PATROL_INSET_M).toBe(1.0);
    const pts = patrolCheckpoints(SQ, 5);
    expect(pts).toHaveLength(8);
    for (const p of pts) {
      expect(pointInPolygon(p, SQ)).toBe(true);
      expect(distToBoundary(p, SQ)).toBeCloseTo(1.0, 5);
    }
  });

  it('do not depend on the winding of the polygon', () => {
    expect(key(patrolCheckpoints([...SQ].reverse(), 5))).toEqual(key(patrolCheckpoints(SQ, 5)));
  });

  // A point is kept only when it lies at least 0.8 * inset (0.8 m) from every
  // edge, so the opposite border of a strip must be 0.8 m beyond the checkpoint.
  it('a strip narrower than 1.8 m (the inset plus 0.8 m) gets no checkpoint', () => {
    for (const width of [1, 1.5, 1.7]) {
      expect(patrolCheckpoints(strip(width), 3), `${width} m wide`).toEqual([]);
    }
  });

  it('a 1.5 m wide strip yields no checkpoints while a 3 m wide one does', () => {
    expect(patrolCheckpoints(strip(1.5), 3)).toEqual([]);
    const wide = patrolCheckpoints(strip(3), 3);
    expect(wide.length).toBeGreaterThan(0);
    for (const p of wide) {
      expect(pointInPolygon(p, strip(3))).toBe(true);
      expect(distToBoundary(p, strip(3))).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('a 1.9 m wide strip is the narrowest that keeps its checkpoints: the margin is 0.8 m, not the old 0.48 m', () => {
    const pts = patrolCheckpoints(strip(1.9), 3);
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) expect(distToBoundary(p, strip(1.9))).toBeGreaterThanOrEqual(0.8);
  });

  it('a degenerate polygon gets none', () => {
    expect(patrolCheckpoints([{ x: 0, y: 0 }, { x: 1, y: 1 }], 3)).toEqual([]);
  });
});

describe('patrol checkpoints and recorded obstacles', () => {
  // 2026-10-18 on LFIN2230700238: a checkpoint beside the trampoline. The
  // border inset knows nothing about obstacles; the planner does.
  const trampoline = [{ x: 0, y: 4 }, { x: 2.5, y: 4 }, { x: 2.5, y: 6 }, { x: 0, y: 6 }];   // against the west border
  const obstacle = (zone: string) => ({ canonical_name: `${zone}_0_obstacle`, map_area: JSON.stringify(trampoline) });
  it('drops a checkpoint in or within 0.8 m of an obstacle of its zone', () => {
    const plain = buildPatrolZones([row('map0', SQ)], ['map0'], 2, null)[0].points;
    const kept = buildPatrolZones([row('map0', SQ)], ['map0'], 2, null, undefined, [obstacle('map0')])[0].points;
    expect(plain.some(([x, y]) => pointInPolygon({ x, y }, trampoline))).toBe(true);
    expect(kept.length).toBe(plain.length - 1);
    for (const [x, y] of kept) {
      expect(pointInPolygon({ x, y }, trampoline)).toBe(false);
      expect(distToBoundary({ x, y }, trampoline)).toBeGreaterThanOrEqual(0.8);
    }
  });
  it("an obstacle of another zone, or a broken one, changes nothing", () => {
    const plain = buildPatrolZones([row('map0', SQ)], ['map0'], 2, null)[0].points;
    expect(buildPatrolZones([row('map0', SQ)], ['map0'], 2, null, undefined, [obstacle('map1')])[0].points).toEqual(plain);
    expect(buildPatrolZones([row('map0', SQ)], ['map0'], 2, null, undefined, [{ canonical_name: 'map0_0_obstacle', map_area: '{oops' }])[0].points).toEqual(plain);
  });
});

describe('patrol plan', () => {
  it("without a choice patrols only the dock's zone", () => {
    const plan = buildPatrolZones([row('map0', SQ), row('map1', shift(SQ, 20))], [], 5, { x: 1, y: 1 });
    expect(plan.map(z => z.zone)).toEqual(['map0']);
  });

  // A saved choice outlives the zones. A slot that was deleted since is no
  // choice at all: the card hides it, so the owner sees nothing ticked and
  // expects the dock's zone, not a refusal that nobody sees.
  it("a choice of only deleted zones patrols the dock's zone, like no choice", () => {
    const rows = [row('map0', SQ), row('map1', shift(SQ, 20))];
    const plan = buildPatrolZones(rows, ['map9'], 5, { x: 1, y: 1 });
    expect(plan.map(z => z.zone)).toEqual(['map0']);
    expect(plan).toEqual(buildPatrolZones(rows, [], 5, { x: 1, y: 1 }));
  });

  it('a deleted zone among the chosen ones is dropped and the rest is planned as chosen', () => {
    const rows = [row('map0', SQ), row('map1', shift(SQ, 20))];
    // The dock's zone is not added to a choice that leaves it out ...
    expect(buildPatrolZones(rows, ['map1', 'map9'], 5, { x: 1, y: 1 }).map(z => z.zone)).toEqual(['map1']);
    // ... and it goes first when the choice has it.
    expect(buildPatrolZones(rows, ['map0', 'map1', 'map9'], 5, { x: 21, y: 1 }).map(z => z.zone)).toEqual(['map1', 'map0']);
  });

  // A zone that exists is still a choice, usable polygon or not: the card shows
  // it ticked, so a refusal is explained, while a swap for the dock's zone
  // would patrol something the owner did not pick.
  it("a chosen zone that exists but has no usable polygon is not swapped for the dock's zone", () => {
    const plan = buildPatrolZones([row('map0', SQ), { canonical_name: 'map1', map_area: '{oops' }], ['map1'], 5, { x: 1, y: 1 });
    expect(plan).toEqual([]);
  });

  it("puts the dock's zone first and the rest by slot", () => {
    const plan = buildPatrolZones([row('map2', shift(SQ, 40)), row('map0', SQ), row('map1', shift(SQ, 20))],
      ['map2', 'map1', 'map0'], 5, { x: 21, y: 1 });
    expect(plan.map(z => z.zone)).toEqual(['map1', 'map0', 'map2']);
  });

  // mapRepo.findWorkMaps lists the newest row first; every other caller takes
  // the first row of a zone.
  it('of two rows of one zone the newest wins', () => {
    const plan = buildPatrolZones([row('map0', SQ), row('map0', shift(SQ, 100))], ['map0'], 5, null);
    expect(plan).toHaveLength(1);
    expect(plan[0].points.length).toBeGreaterThan(0);
    expect(plan[0].points.every(([x]) => x < 20)).toBe(true);
  });

  it('a broken newest row falls back to the next row of that zone', () => {
    const plan = buildPatrolZones([{ canonical_name: 'map0', map_area: '{oops' }, row('map0', shift(SQ, 100))],
      ['map0'], 5, null);
    expect(plan[0].points.every(([x]) => x > 90)).toBe(true);
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
    // A square turned 30 degrees: its raw checkpoints are off the centimetre grid.
    const a = Math.PI / 6;
    const turned = SQ.map(p => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }));
    expect(patrolCheckpoints(turned, 5).some(p => Math.round(p.x * 100) / 100 !== p.x)).toBe(true);
    const plan = buildPatrolZones([row('map0', turned)], ['map0'], 5, null);
    expect(plan[0].points.length).toBeGreaterThan(0);
    for (const [x, y] of plan[0].points) {
      expect(Math.round(x * 100) / 100).toBe(x);
      expect(Math.round(y * 100) / 100).toBe(y);
    }
  });

  it('plans nothing when the cap is zero', () => {
    expect(buildPatrolZones([row('map0', SQ)], ['map0'], 5, null, 0)).toEqual([]);
  });

  it('caps the plan at 60 points across 61 zones and keeps the dock zone first', () => {
    // 61 squares from x = -300 m to x = 305 m, all inside the 500 m bound.
    const zones = Array.from({ length: 61 }, (_, i) => row(`map${i}`, [
      { x: i * 10 - 300, y: 0 }, { x: i * 10 - 295, y: 0 }, { x: i * 10 - 295, y: 5 }, { x: i * 10 - 300, y: 5 },
    ]));
    const wanted = zones.map(r => r.canonical_name);
    const plan = buildPatrolZones(zones, wanted, 5, { x: 302.5, y: 2.5 });
    expect(plan.reduce((n, z) => n + z.points.length, 0)).toBeLessThanOrEqual(PATROL_MAX_POINTS);
    expect(plan[0].zone).toBe('map60');
  });

  it('skips a polygon with a malformed vertex and keeps the good zones', () => {
    const plan = buildPatrolZones([
      { canonical_name: 'map1', map_area: JSON.stringify([null, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]) },
      { canonical_name: 'map2', map_area: '[{"x":"a","y":0},{"x":10,"y":0},{"x":10,"y":10},{"x":0,"y":10}]' },
      row('map0', SQ),
    ], ['map0', 'map1', 'map2'], 5, null);
    expect(plan.map(z => z.zone)).toEqual(['map0']);
  });

  it('skips a polygon with a vertex 1e12 m away and still plans the other zones', () => {
    const plan = buildPatrolZones([
      { canonical_name: 'map1', map_area: JSON.stringify([{ x: 0, y: 0 }, { x: 1e12, y: 0 }, { x: 1e12, y: 10 }, { x: 0, y: 10 }]) },
      row('map0', SQ),
    ], ['map0', 'map1'], 5, null);
    expect(plan.map(z => z.zone)).toEqual(['map0']);
  });

  it('skips a polygon with a vertex just outside the 500 m bound', () => {
    const plan = buildPatrolZones([
      row('map1', [{ x: 501, y: 0 }, { x: 511, y: 0 }, { x: 511, y: 10 }, { x: 501, y: 10 }]),
      row('map0', SQ),
    ], ['map0', 'map1'], 5, null);
    expect(plan.map(z => z.zone)).toEqual(['map0']);
  });

  it('keeps polygons inside the 500 m bound, vertices on it included', () => {
    const plan = buildPatrolZones([
      row('map0', [{ x: 480, y: 480 }, { x: 500, y: 480 }, { x: 500, y: 500 }, { x: 480, y: 500 }]),
      row('map1', [{ x: -500, y: -500 }, { x: -480, y: -500 }, { x: -480, y: -480 }, { x: -500, y: -480 }]),
    ], ['map0', 'map1'], 5, null);
    expect(plan.map(z => z.zone)).toEqual(['map0', 'map1']);
  });

  it('plans nothing at 0.1 m spacing', () => {
    expect(patrolCheckpoints(SQ, 0.1)).toHaveLength(0);
    expect(buildPatrolZones([row('map0', SQ)], ['map0'], 0.1, null)).toEqual([]);
  });

  it('plans nothing at a tiny spacing that would walk the border forever', () => {
    expect(buildPatrolZones([row('map0', SQ)], ['map0'], 1e-9, null)).toEqual([]);
  });

  it('plans nothing for a NaN, zero or negative spacing', () => {
    for (const spacingM of [NaN, 0, -3]) {
      expect(patrolCheckpoints(SQ, spacingM)).toHaveLength(0);
      expect(buildPatrolZones([row('map0', SQ)], ['map0'], spacingM, null)).toEqual([]);
    }
  });

  it('still plans at the half-metre minimum spacing', () => {
    expect(patrolCheckpoints(SQ, 0.5).length).toBeGreaterThan(0);
    const plan = buildPatrolZones([row('map0', SQ)], ['map0'], 0.5, null);
    expect(plan.map(z => z.zone)).toEqual(['map0']);
    expect(plan[0].points.length).toBeLessThanOrEqual(PATROL_MAX_POINTS);
  });
});
