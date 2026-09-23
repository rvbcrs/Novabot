/**
 * SPIEGEL van server/src/maps/editGeometry.ts — NIET los aanpassen.
 * Wijzigingen eerst server-side (bron van waarheid + tests), dan hierheen kopiëren.
 * Pure, dependency-vrij. Alle afstanden in meters, lokale frame (charger = 0,0).
 */
export interface XY { x: number; y: number }

/** Shoelace-oppervlak, altijd positief (winding-onafhankelijk). */
export function polygonArea(pts: XY[]): number {
  if (pts.length < 3) return 0;
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    acc += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(acc) / 2;
}

/** Ray-casting point-in-polygon. */
export function pointInPolygon(p: XY, poly: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y)
        && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Voeg punten in zodat geen segment (incl. sluitend segment) langer is dan maxSpacing. */
export function densifyPolygon(pts: XY[], maxSpacing: number): XY[] {
  if (!(maxSpacing > 0)) return pts.slice();
  if (pts.length < 3) return pts.slice();
  const out: XY[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    out.push(a);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.ceil(d / maxSpacing) - 1;
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

function perpDist(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

function rdp(pts: XY[], eps: number): XY[] {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

/**
 * Ramer-Douglas-Peucker voor GESLOTEN polygon: splits op het verste puntenpaar
 * zodat het sluitsegment correct behandeld wordt.
 */
export function simplifyPolygon(pts: XY[], tolerance: number): XY[] {
  if (pts.length < 4) return pts.slice();
  let far = 1, maxD = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (d > maxD) { maxD = d; far = i; }
  }
  const half1 = rdp(pts.slice(0, far + 1), tolerance);
  const half2 = rdp(pts.slice(far).concat([pts[0]]), tolerance);
  const out = half1.slice(0, -1).concat(half2.slice(0, -1));
  return out.length >= 3 ? out : pts.slice();
}

/**
 * Strikte tekentest: collinear/rakend = ongedefinieerd (orientatie-afhankelijk).
 * Bewust — float-drags raken dit praktisch nooit; NIET "fixen" in de RN-spiegel.
 */
function segIntersects(a: XY, b: XY, c: XY, d: XY): boolean {
  const cross = (o: XY, p: XY, q: XY) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** True als niet-aangrenzende randen elkaar kruisen (O(n²), prima voor ≤ ~500 punten). */
export function selfIntersects(pts: XY[]): boolean {
  const n = pts.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // aangrenzend via sluiting
      if (segIntersects(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** inner volledig binnen outer: alle vertices binnen ÉN geen rand-kruisingen. */
export function polygonContains(outer: XY[], inner: XY[]): boolean {
  for (const p of inner) if (!pointInPolygon(p, outer)) return false;
  const n = outer.length, m = inner.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (segIntersects(outer[i], outer[(i + 1) % n], inner[j], inner[(j + 1) % m])) return false;
    }
  }
  return true;
}

function distToSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Max over edited-punten van min-afstand tot de originele polygon-rand (meters).
 * Eénzijdig: alleen verplaatsing van NIEUWE punten weg van de oude rand telt
 * (krimp/verwijdering geeft 0; richting binnen/buiten wordt niet onderscheiden).
 */
export function maxDisplacement(edited: XY[], original: XY[]): number {
  if (original.length < 2) return 0;
  let worst = 0;
  for (const p of edited) {
    let best = Infinity;
    for (let i = 0; i < original.length; i++) {
      best = Math.min(best, distToSegment(p, original[i], original[(i + 1) % original.length]));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

export interface MapSetInput {
  work: { canonical: string; points: XY[] }[];
  obstacles: { canonical: string; parentMap: string; points: XY[] }[];
}
export type ValidationCode = 'too_few_points' | 'self_intersect' | 'too_small' | 'outside_work' | 'unknown_parent' | 'large_displacement';
/**
 * `message` is plain English (logs/tests); UI renders `messageKey` + `messageParams`
 * through i18n t().
 */
export interface ValidationIssue {
  canonical: string;
  code: ValidationCode;
  message: string;
  messageKey: string;
  messageParams?: Record<string, string | number>;
}
export interface ValidationResult { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] }

export const MIN_OBSTACLE_AREA_M2 = 0.05; // kleine obstakels (paaltje/sproeier, ~0.2 m2) zijn legitiem
export const MIN_WORK_AREA_M2 = 5;
export const DISPLACEMENT_WARN_M = 1.0;

/**
 * Valideer de volledige (merged) set. `originals` = canonical → originele punten
 * (alleen voor displacement-warning; lege Map = geen warning-check).
 */
export function validateMapSet(input: MapSetInput, originals: Map<string, XY[]>, editedCanonicals?: Set<string>): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const isEdited = (canonical: string) => !editedCanonicals || editedCanonicals.has(canonical);
  const checkCommon = (canonical: string, pts: XY[], minArea: number) => {
    if (pts.length < 3) { errors.push({ canonical, code: 'too_few_points', message: 'At least 3 points needed', messageKey: 'stValTooFewPoints' }); return false; }
    if (selfIntersects(pts)) { errors.push({ canonical, code: 'self_intersect', message: 'Line crosses itself', messageKey: 'stValSelfIntersect' }); return false; }
    if (polygonArea(pts) < minArea) { errors.push({ canonical, code: 'too_small', message: `Area smaller than ${minArea} m²`, messageKey: 'stValTooSmall', messageParams: { min: minArea } }); return false; }
    const orig = originals.get(canonical);
    if (orig && maxDisplacement(pts, orig) > DISPLACEMENT_WARN_M) {
      warnings.push({ canonical, code: 'large_displacement', message: `Moved more than ${DISPLACEMENT_WARN_M} m: outside the area ever scanned, navigation behaviour is unproven`, messageKey: 'stValLargeDisplacement', messageParams: { m: DISPLACEMENT_WARN_M } });
    }
    return true;
  };
  for (const w of input.work) {
    if (isEdited(w.canonical)) checkCommon(w.canonical, w.points, MIN_WORK_AREA_M2);
  }
  for (const o of input.obstacles) {
    if (!isEdited(o.canonical)) continue;
    if (!checkCommon(o.canonical, o.points, MIN_OBSTACLE_AREA_M2)) continue;
    const parent = input.work.find(w => w.canonical === o.parentMap);
    if (parent === undefined) {
      errors.push({ canonical: o.canonical, code: 'unknown_parent', message: `Unknown work map ${o.parentMap}`, messageKey: 'stValUnknownParent', messageParams: { map: o.parentMap } });
    } else if (!polygonContains(parent.points, o.points)) {
      errors.push({ canonical: o.canonical, code: 'outside_work', message: `Obstacle extends outside ${o.parentMap}`, messageKey: 'stValOutsideWork', messageParams: { map: o.parentMap } });
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Duw/trek-brush: verplaats punten binnen `radius` van `anchor` met `delta`,
 * cosinus-falloff naar de rand. Densify VOORAF (clients doen densifyPolygon
 * met spacing radius/4) zodat er genoeg punten zijn om te verplaatsen.
 */
export function applyBrush(pts: XY[], anchor: XY, delta: XY, radius: number): XY[] {
  return pts.map(p => {
    const d = Math.hypot(p.x - anchor.x, p.y - anchor.y);
    if (d >= radius) return p;
    const f = 0.5 * (1 + Math.cos(Math.PI * d / radius));
    return { x: p.x + delta.x * f, y: p.y + delta.y * f };
  });
}

/** Index van dichtstbijzijnde vertex binnen tol, anders -1. */
export function hitTestVertex(pts: XY[], p: XY, tol: number): number {
  let best = -1, bestD = tol;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - p.x, pts[i].y - p.y);
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Dichtstbijzijnde rand binnen tol: insertIndex (nieuwe punt-index) + projectiepunt. */
export function hitTestEdge(pts: XY[], p: XY, tol: number): { insertIndex: number; point: XY } | null {
  let best: { insertIndex: number; point: XY } | null = null;
  let bestD = tol;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) continue;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d <= bestD) { bestD = d; best = { insertIndex: i + 1, point: q }; }
  }
  return best;
}
