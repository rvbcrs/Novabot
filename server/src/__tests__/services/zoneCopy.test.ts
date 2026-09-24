/**
 * Zone kopiëren tussen maaiers: geometrie en regels.
 * Spec: docs/superpowers/specs/2026-09-24-copy-zone-between-mowers-design.md
 */
import { describe, it, expect } from 'vitest';
import {
  transformPoints, nearestBoundaryPoint, polygonsOverlap, polygonGap, segmentCrossesPolygon, straightChannel, STEP_M,
} from '../../services/zoneCopy.js';

export const square = (x0: number, y0: number, size = 10) => [
  { x: x0, y: y0 }, { x: x0 + size, y: y0 }, { x: x0 + size, y: y0 + size }, { x: x0, y: y0 + size },
];
export const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

describe('zoneCopy geometrie', () => {
  it('transformPoints: gelijk dock = identiteit, anders zuivere verschuiving', () => {
    const pts = square(0, 0);
    expect(transformPoints(pts, { x: 1, y: 2 }, { x: 1, y: 2 })).toEqual(pts);
    const [p] = transformPoints([{ x: 0, y: 0 }], { x: 0.03, y: 0.73 }, { x: 11.2, y: 18.3 });
    expect(p.x).toBeCloseTo(11.17, 6);
    expect(p.y).toBeCloseTo(17.57, 6);
  });

  it('nearestBoundaryPoint: vanaf buiten en vanaf binnen naar de rand', () => {
    const sq = square(0, 0);
    const out = nearestBoundaryPoint({ x: 15, y: 5 }, sq);
    expect(out.dist).toBeCloseTo(5, 6);
    expect(out.point).toEqual({ x: 10, y: 5 });
    const inside = nearestBoundaryPoint({ x: 1, y: 5 }, sq);
    expect(inside.dist).toBeCloseTo(1, 6);
    expect(inside.point).toEqual({ x: 0, y: 5 });
  });

  it('nearestBoundaryPoint: dubbele opeenvolgende punten (lengte-0 rand) breken niets', () => {
    const poly = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const r = nearestBoundaryPoint({ x: -1, y: 0 }, poly);
    expect(r.dist).toBeCloseTo(1, 6);
    expect(Number.isFinite(r.point.x) && Number.isFinite(r.point.y)).toBe(true);
  });

  it('polygonsOverlap: los, hoekpunt binnen, en kruisend zonder hoekpunt binnen', () => {
    expect(polygonsOverlap(square(0, 0), square(20, 0))).toBe(false);
    expect(polygonsOverlap(square(0, 0), square(5, 5))).toBe(true);
    const horiz = rect(-10, 4, 10, 6);
    const vert = rect(4, -10, 6, 10);
    expect(polygonsOverlap(horiz, vert)).toBe(true);
  });

  it('polygonGap: 0 bij overlap, anders afstand met randpunten aan beide kanten', () => {
    expect(polygonGap(square(0, 0), square(5, 5)).dist).toBe(0);
    const g = polygonGap(square(0, 0), square(11, 0));
    expect(g.dist).toBeCloseTo(1, 6);
    expect(g.onA.x).toBeCloseTo(10, 6);
    expect(g.onB.x).toBeCloseTo(11, 6);
  });

  it('segmentCrossesPolygon: kruisend, erlangs, en volledig erbinnen', () => {
    const sq = square(0, 0);
    expect(segmentCrossesPolygon({ x: -5, y: 5 }, { x: 15, y: 5 }, sq)).toBe(true);
    expect(segmentCrossesPolygon({ x: -5, y: 15 }, { x: 15, y: 15 }, sq)).toBe(false);
    expect(segmentCrossesPolygon({ x: 2, y: 2 }, { x: 8, y: 8 }, sq)).toBe(true);
  });

  it('straightChannel: begint bij from, eindigt bij to, stappen van hoogstens STEP_M', () => {
    const pts = straightChannel({ x: 0, y: 0 }, { x: 0, y: 1 });
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 0, y: 1 });
    expect(pts).toHaveLength(5);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)).toBeLessThanOrEqual(STEP_M + 1e-9);
    }
    expect(straightChannel({ x: 3, y: 3 }, { x: 3, y: 3 })).toEqual([{ x: 3, y: 3 }, { x: 3, y: 3 }]);
  });
});
