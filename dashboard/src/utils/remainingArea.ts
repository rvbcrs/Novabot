/**
 * The part of a work area that is still to mow after a lost task (#86).
 *
 * The planner mows in parallel lanes along `directionDeg` (degrees from
 * north, the same number the start command carries) and sweeps across them.
 * "Where the mower got to" is therefore one lane: the line through its last
 * position, parallel to the lanes. Everything on the mowed side of that line
 * is done; the other side is the remaining area, sent as a plain polygon.
 * All coordinates are local metres (x east, y north), like the map rows.
 */
export interface XY { x: number; y: number }

/** Sweep-axis coordinate: distance across the lanes. */
export function sweepCoordinate(p: XY, directionDeg: number): number {
  const rad = (directionDeg * Math.PI) / 180;
  return p.x * Math.cos(rad) - p.y * Math.sin(rad);
}

/** Range of the sweep coordinate over a polygon. */
export function sweepExtent(poly: XY[], directionDeg: number): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const p of poly) {
    const s = sweepCoordinate(p, directionDeg);
    if (s < min) min = s;
    if (s > max) max = s;
  }
  return { min, max };
}

/**
 * Clip `poly` to the half-plane on the side of the lane at sweep coordinate
 * `s0` that is NOT mowed. `mowedSign` says on which side the mowed part
 * lies (+1: larger sweep coordinates, -1: smaller). Sutherland–Hodgman
 * against one line; the result keeps the lane as a new straight edge.
 */
export function remainingPolygon(poly: XY[], directionDeg: number, s0: number, mowedSign: 1 | -1): XY[] {
  const inside = (p: XY) => (sweepCoordinate(p, directionDeg) - s0) * mowedSign <= 0;
  const out: XY[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ia = inside(a), ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const sa = sweepCoordinate(a, directionDeg) - s0;
      const sb = sweepCoordinate(b, directionDeg) - s0;
      const t = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** Shoelace area, for the "N% left" label. */
export function polygonArea(poly: XY[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}
