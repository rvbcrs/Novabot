/**
 * Dashboard geometry for "resume from N%" (#86). Lives in the server test
 * run (like liveMapWindow) because the dashboard has no vitest of its own.
 */
import { describe, it, expect } from 'vitest';
import { remainingPolygon, sweepCoordinate, sweepExtent, polygonArea } from '../../../../dashboard/src/utils/remainingArea.js';

const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

describe('remainingPolygon', () => {
  it('lanes north-south (0°): sweep runs east-west, mowed west half leaves the east half', () => {
    // mower stood at x=4; the trail (mowed) lies at smaller x → mowedSign -1
    const s0 = sweepCoordinate({ x: 4, y: 3 }, 0);
    const rest = remainingPolygon(square, 0, s0, -1);
    expect(polygonArea(rest)).toBeCloseTo(60, 6);
    expect(Math.min(...rest.map(p => p.x))).toBeCloseTo(4, 6);
  });

  it('lanes east-west (90°): sweep runs north-south', () => {
    const s0 = sweepCoordinate({ x: 2, y: 7 }, 90);
    // trail at y < 7 lies at larger sweep coordinate (s = -y) → mowedSign +1
    const rest = remainingPolygon(square, 90, s0, 1);
    expect(polygonArea(rest)).toBeCloseTo(30, 6);
    expect(Math.min(...rest.map(p => p.y))).toBeCloseTo(7, 6);
  });

  it('a diagonal cut (45°) leaves the triangle beyond the lane x - y = 2', () => {
    const s0 = sweepCoordinate({ x: 6, y: 4 }, 45);
    const rest = remainingPolygon(square, 45, s0, -1);
    expect(rest.length).toBe(3);
    expect(polygonArea(rest)).toBeCloseTo(32, 6);
  });

  it('sweepExtent spans the polygon and the ends give all or nothing', () => {
    const { min, max } = sweepExtent(square, 0);
    expect(remainingPolygon(square, 0, min, -1).length).toBe(4);
    expect(polygonArea(remainingPolygon(square, 0, max, -1))).toBeCloseTo(0, 6);
  });
});
