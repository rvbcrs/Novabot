// server/src/services/patrolRoute.ts
/**
 * Night patrol route: checkpoints along each chosen zone's border, a little
 * inside it. The mower drives them with nav2 (blades off) and re-checks every
 * point against its own zone files, so a point that lands wrong is skipped
 * there, never driven. Pure: no DB, no MQTT.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import { pointInPolygon, type XY } from '../maps/editGeometry.js';

export const PATROL_INSET_M = 0.6;
/** The mower refuses more (extended_commands.py PATROL_MAX_POINTS). */
export const PATROL_MAX_POINTS = 60;
/** The mower's own bound for patrol points (research/extended_commands.py validate_patrol_params). */
export const PATROL_MAX_COORD_M = 500;

export interface PatrolZone { zone: string; points: Array<[number, number]> }

function segDist(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

export function distToBoundary(p: XY, poly: XY[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

function signedArea(poly: XY[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/**
 * Every `spacingM` metres along the border take the border point, step
 * `insetM` along that edge's inward normal, and keep the point only when it
 * lies inside and at least 0.8 * insetM from every edge. A narrow neck or a
 * sharp corner then gives no checkpoint rather than one in the hedge.
 * `spacingM` must be at least 0.5 m. A smaller or non-numeric spacing plans
 * nothing: the walk along an edge takes len / spacingM steps, so a tiny value
 * would never finish.
 */
export function patrolCheckpoints(poly: XY[], spacingM = 6, insetM = PATROL_INSET_M): XY[] {
  if (poly.length < 3 || !(spacingM >= 0.5)) return [];
  const ccw = signedArea(poly) > 0;
  const out: XY[] = [];
  let carry = spacingM / 2;   // the first checkpoint half a step along the border
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    // Interior lies left of each edge on a counter-clockwise polygon.
    const nx = (ccw ? -(b.y - a.y) : (b.y - a.y)) / len;
    const ny = (ccw ? (b.x - a.x) : -(b.x - a.x)) / len;
    let s = carry;
    for (; s <= len; s += spacingM) {
      const t = s / len;
      const q = { x: a.x + t * (b.x - a.x) + nx * insetM, y: a.y + t * (b.y - a.y) + ny * insetM };
      if (pointInPolygon(q, poly) && distToBoundary(q, poly) >= 0.8 * insetM) out.push(q);
    }
    carry = s - len;
  }
  return out;
}

/** The zone the dock stands in, or beside within 2 m (the anchor can sit just outside). */
function dockZone(polys: Map<string, XY[]>, dock: XY | null): string | null {
  if (!dock) return null;
  let best: { d: number; zone: string } | null = null;
  for (const [zone, poly] of polys) {
    const d = pointInPolygon(dock, poly) ? 0 : distToBoundary(dock, poly);
    if (d <= 2 && (!best || d < best.d)) best = { d, zone };
  }
  return best?.zone ?? null;
}

/**
 * The plan for the chosen zones: the dock's zone first, then the rest by
 * slot. No choice, or a choice of only zones that no longer exist, means the
 * dock's zone only. Above `maxPoints` every zone is thinned by the same
 * stride, so a big garden still gets checkpoints all round.
 * At most `maxPoints` zones are planned (the dock's zone survives that cut).
 * A cap below 1, or a spacing below 0.5 m or NaN, plans nothing. A zone with a
 * vertex beyond PATROL_MAX_COORD_M is skipped whole.
 */
export function buildPatrolZones(
  rows: Array<{ canonical_name: string | null; map_area: string | null }>,
  wanted: string[], spacingM: number, dock: XY | null, maxPoints = PATROL_MAX_POINTS,
): PatrolZone[] {
  if (maxPoints < 1) return [];
  if (!(spacingM >= 0.5)) return [];
  const polys = new Map<string, XY[]>();
  const existing = new Set<string>();   // every zone with a row, usable polygon or not
  for (const r of rows) {
    const zone = r.canonical_name?.match(/^map\d+$/)?.[0];
    if (zone) existing.add(zone);
    // The rows come newest first (mapRepo.findWorkMaps): the first usable row
    // of a zone wins, as everywhere else.
    if (!zone || !r.map_area || polys.has(zone)) continue;
    try {
      const poly = JSON.parse(r.map_area) as XY[];
      const ok = Array.isArray(poly) && poly.length >= 3
        && poly.every(p => p != null && Number.isFinite(p.x) && Number.isFinite(p.y)
          && Math.abs(p.x) <= PATROL_MAX_COORD_M && Math.abs(p.y) <= PATROL_MAX_COORD_M);
      if (ok) polys.set(zone, poly);
    } catch { /* a broken polygon row is skipped */ }
  }
  const home = dockZone(polys, dock);
  // A saved choice outlives the zones: a slot deleted since is no choice, so a
  // choice of only deleted zones is the dock's zone, like an empty one. A zone
  // that exists but has no usable polygon stays chosen and plans nothing (the
  // start is refused, the card shows it ticked) instead of being swapped.
  const picked = wanted.filter(z => existing.has(z));
  const chosen = [...new Set(picked.length ? picked : home ? [home] : [])].filter(z => polys.has(z));
  const slot = (z: string) => Number(z.slice(3));
  chosen.sort((a, b) => (a === home ? -1 : b === home ? 1 : slot(a) - slot(b)));
  // At most maxPoints zones: the dock's zone sorts first, so it survives the cut.
  const zones = chosen.slice(0, maxPoints).map(zone => ({ zone, pts: patrolCheckpoints(polys.get(zone)!, spacingM) }));
  const kept = (stride: number) => zones.reduce((n, z) => n + Math.ceil(z.pts.length / stride), 0);
  let stride = 1;
  while (kept(stride) > maxPoints) stride++;
  return zones
    .map(z => ({
      zone: z.zone,
      points: z.pts.filter((_, i) => i % stride === 0)
        .map(p => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100] as [number, number]),
    }))
    .filter(z => z.points.length > 0);
}
