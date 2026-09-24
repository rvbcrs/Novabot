/**
 * Zone kopiëren van maaier A naar maaier B.
 * Spec: docs/superpowers/specs/2026-09-24-copy-zone-between-mowers-design.md
 *
 * Twee maaiers delen geen absoluut GPS-frame: elke charger zendt zijn eigen
 * zelf-ingemeten RTK-basispositie uit (live 23 m verschil tussen .244 en
 * .100). De enige betrouwbare koppeling is één fysieke correspondentie, waar
 * het laadstation van A staat in B's frame, met rotatie 0 (beide ENU).
 */
import { pointInPolygon, polygonContains, segIntersects, type XY } from '../maps/editGeometry.js';

/** ponytail: knop. Max afstand dock→zone voor een gegenereerd dockkanaal. */
export const DOCK_MAX_M = 3;
/** ponytail: knop. Max opening tussen twee zones voor een voorgesteld tussenkanaal. */
export const LINK_MAX_M = 1.5;
/** Puntafstand in een gegenereerd kanaal. */
export const STEP_M = 0.25;
/** Firmware-cap: map0..map4 (memory multi-map-limit). */
export const MAX_SLOT = 4;

/** Zuivere translatie: p_B = p_A − dockA_in_A + dockA_in_B. */
export function transformPoints(pts: XY[], dockAInA: XY, dockAInB: XY): XY[] {
  const dx = dockAInB.x - dockAInA.x;
  const dy = dockAInB.y - dockAInA.y;
  return pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
}

/** Dichtstbijzijnde punt op de RAND van poly, gezien vanaf p (ook als p erbinnen ligt). */
export function nearestBoundaryPoint(p: XY, poly: XY[]): { point: XY; dist: number } {
  let best = { point: poly[0], dist: Infinity };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.dist) best = { point: q, dist: d };
  }
  return best;
}

/** Raken/overlappen: een hoekpunt in de ander, of snijdende randen. */
export function polygonsOverlap(a: XY[], b: XY[]): boolean {
  if (a.some(p => pointInPolygon(p, b)) || b.some(p => pointInPolygon(p, a))) return true;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segIntersects(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

/**
 * Kortste opening tussen twee polygonen: 0 bij overlap. Voor niet-overlappende
 * polygonen ligt het minimum altijd op een hoekpunt van de een en de rand van
 * de ander, dus hoekpunt→rand in beide richtingen volstaat.
 */
export function polygonGap(a: XY[], b: XY[]): { dist: number; onA: XY; onB: XY } {
  if (polygonsOverlap(a, b)) return { dist: 0, onA: a[0], onB: b[0] };
  let best = { dist: Infinity, onA: a[0], onB: b[0] };
  for (const p of a) {
    const n = nearestBoundaryPoint(p, b);
    if (n.dist < best.dist) best = { dist: n.dist, onA: p, onB: n.point };
  }
  for (const p of b) {
    const n = nearestBoundaryPoint(p, a);
    if (n.dist < best.dist) best = { dist: n.dist, onA: n.point, onB: p };
  }
  return best;
}

/** Lijnstuk p→q kruist de rand van poly, of ligt er helemaal in. */
export function segmentCrossesPolygon(p: XY, q: XY, poly: XY[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (segIntersects(p, q, poly[i], poly[(i + 1) % poly.length])) return true;
  }
  return pointInPolygon(p, poly) && pointInPolygon(q, poly);
}

/** Rechte lijn from→to, verdicht per step; `from` is altijd rij 1 (firmware: dock eerst). */
export function straightChannel(from: XY, to: XY, step: number = STEP_M): XY[] {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(1, Math.ceil(len / step));
  const out: XY[] = [];
  for (let i = 0; i <= n; i++) {
    out.push({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
  }
  return out;
}

// polygonContains wordt in deel 2 (planZoneCopy) gebruikt; import staat er alvast.
void polygonContains;
