/**
 * The geometry of a drone photo laid on the map (#124).
 *
 * A placement is the photo's four corners on the map: top-left, top-right,
 * bottom-right, bottom-left of the photo. Four corners are a homography, and
 * that is exactly what a camera that was not quite straight down makes of a
 * flat garden: a trapezium, larger on one side than the other. Two points
 * can only shift, rotate and scale, so a photo like that fits at the two
 * points and drifts away from them; four points pin it everywhere on the
 * ground. Centre, width and rotation are the special case of a rectangle,
 * and the sliders still work on any corner set by rotating and scaling all
 * four about a pivot: the charging station when it lies in the photo, so the
 * one point that is known to be right stays put, else the centre.
 *
 * All arithmetic is in a local flat frame around the garden, x = east and
 * y = south in metres, so photo pixels (y down) and ground share their
 * orientation and a positive rotation is clockwise on screen, as it is for
 * the CSS the layer draws with. Metres per degree of latitude constant,
 * longitude scaled by cos(lat); over a garden that is a fraction of a
 * millimetre.
 */
import type { DroneCorners, LatLng } from '../api/client';

export const M_PER_DEG_LAT = 111_320;

export interface PhotoSize { width: number; height: number; }
export interface PhotoPixel { u: number; v: number; }
export interface XY { x: number; y: number; }
/** A photo pixel and the map point it belongs on; dock marks the charging station, whose map point was known. */
export interface PointPair { px: PhotoPixel; ll: LatLng; dock?: boolean; }
/** 3x3, row-major: [a b c; d e f; g h i], (x, y) -> ((ax+by+c)/(gx+hy+i), (dx+ey+f)/(gx+hy+i)). */
export type Homography = number[];

const rad = (deg: number) => deg * Math.PI / 180;

// ── Local frame ─────────────────────────────────────────────────────────────
export interface Frame { origin: LatLng; mPerDegLng: number; }
export function frameAt(origin: LatLng): Frame {
  return { origin, mPerDegLng: M_PER_DEG_LAT * Math.cos(rad(origin.lat)) };
}
export function toXY(f: Frame, ll: LatLng): XY {
  return { x: (ll.lng - f.origin.lng) * f.mPerDegLng, y: -(ll.lat - f.origin.lat) * M_PER_DEG_LAT };
}
export function toLatLng(f: Frame, p: XY): LatLng {
  return { lat: f.origin.lat - p.y / M_PER_DEG_LAT, lng: f.origin.lng + p.x / f.mPerDegLng };
}
/** Ground distance between two map points, metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const p = toXY(frameAt(a), b);
  return Math.hypot(p.x, p.y);
}
export function centroid(pts: LatLng[]): LatLng {
  return {
    lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
    lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length,
  };
}

// ── Homographies ────────────────────────────────────────────────────────────
export function applyH(h: Homography, p: XY): XY {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

export function multiplyH(a: Homography, b: Homography): Homography {
  const r = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

export function invertH(m: Homography): Homography | null {
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  return [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ].map(v => v / det);
}

const translation = (dx: number, dy: number): Homography => [1, 0, dx, 0, 1, dy, 0, 0, 1];

/** Gauss-Jordan with partial pivoting; null when singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      if (k === 0) continue;
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Hartley normalisation: centroid to the origin, mean distance sqrt(2). Keeps the solve well conditioned. */
function normaliser(pts: XY[]): Homography {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const md = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length;
  const s = md > 0 ? Math.SQRT2 / md : 1;
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

/**
 * Least-squares homography a -> b from four or more pairs (normalised DLT
 * with the last element fixed at 1). Null with fewer pairs or a degenerate
 * set, such as all points on one line.
 */
export function homographyFromPairs(pairs: { a: XY; b: XY }[]): Homography | null {
  if (pairs.length < 4) return null;
  const Ta = normaliser(pairs.map(p => p.a)), Tb = normaliser(pairs.map(p => p.b));
  const rows: number[][] = [], rhs: number[] = [];
  for (const p of pairs) {
    const { x, y } = applyH(Ta, p.a), { x: X, y: Y } = applyH(Tb, p.b);
    rows.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); rhs.push(X);
    rows.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); rhs.push(Y);
  }
  // Normal equations, 8x8: with at most a dozen well-spread points that is plenty.
  const N = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const v = new Array<number>(8).fill(0);
  for (let r = 0; r < rows.length; r++) {
    for (let i = 0; i < 8; i++) {
      v[i] += rows[r][i] * rhs[r];
      for (let j = 0; j < 8; j++) N[i][j] += rows[r][i] * rows[r][j];
    }
  }
  const h = solveLinear(N, v);
  const TbInv = invertH(Tb);
  if (!h || !TbInv) return null;
  return multiplyH(TbInv, multiplyH([...h, 1], Ta));
}

/**
 * Least-squares similarity (rotate, scale, shift) a -> b from two or more
 * pairs. With exactly two it is exact; with more, click errors average out.
 */
export function similarityFromPairs(pairs: { a: XY; b: XY }[]): Homography | null {
  if (pairs.length < 2) return null;
  const n = pairs.length;
  const ca = { x: pairs.reduce((s, p) => s + p.a.x, 0) / n, y: pairs.reduce((s, p) => s + p.a.y, 0) / n };
  const cb = { x: pairs.reduce((s, p) => s + p.b.x, 0) / n, y: pairs.reduce((s, p) => s + p.b.y, 0) / n };
  let sxx = 0, sxy = 0, saa = 0;
  for (const p of pairs) {
    const ax = p.a.x - ca.x, ay = p.a.y - ca.y, bx = p.b.x - cb.x, by = p.b.y - cb.y;
    sxx += ax * bx + ay * by; sxy += ax * by - ay * bx; saa += ax * ax + ay * ay;
  }
  if (saa < 1e-9) return null;
  const s = Math.hypot(sxx, sxy) / saa, t = Math.atan2(sxy, sxx);
  const c = s * Math.cos(t), sn = s * Math.sin(t);
  return [c, -sn, cb.x - (c * ca.x - sn * ca.y), sn, c, cb.y - (sn * ca.x + c * ca.y), 0, 0, 1];
}

// ── Placement ───────────────────────────────────────────────────────────────
const boxCorners = (size: PhotoSize): XY[] => [
  { x: 0, y: 0 }, { x: size.width, y: 0 }, { x: size.width, y: size.height }, { x: 0, y: size.height },
];

/** Photo pixels -> local frame for these corners (exact, four pairs). */
export function cornersHomography(corners: DroneCorners, size: PhotoSize, f: Frame): Homography | null {
  const b = corners.map(c => toXY(f, c));
  return homographyFromPairs(boxCorners(size).map((a, i) => ({ a, b: b[i] })));
}

/** Where photo pixel (u, v) lands on the map. */
export function photoToLatLng(corners: DroneCorners, size: PhotoSize, px: PhotoPixel): LatLng {
  const f = frameAt(centroid(corners));
  const h = cornersHomography(corners, size, f);
  return h ? toLatLng(f, applyH(h, { x: px.u, y: px.v })) : corners[0];
}

/** Which photo pixel sits under this map point; may fall outside the photo. */
export function latLngToPhoto(corners: DroneCorners, size: PhotoSize, ll: LatLng): PhotoPixel {
  const f = frameAt(centroid(corners));
  const h = cornersHomography(corners, size, f);
  const inv = h && invertH(h);
  if (!inv) return { u: NaN, v: NaN };
  const p = applyH(inv, toXY(f, ll));
  return { u: p.x, v: p.y };
}

export function insidePhoto(px: PhotoPixel, size: PhotoSize): boolean {
  return px.u >= 0 && px.v >= 0 && px.u <= size.width && px.v <= size.height;
}

/** Corners of a photo laid flat: centre, ground width in metres, rotation clockwise on screen. */
export function similarityCorners(centre: LatLng, widthM: number, rotationDeg: number, aspect: number): DroneCorners {
  const f = frameAt(centre), w = widthM / 2, h = widthM / aspect / 2;
  const t = rad(rotationDeg), c = Math.cos(t), s = Math.sin(t);
  const at = (x: number, y: number) => toLatLng(f, { x: x * c - y * s, y: x * s + y * c });
  return [at(-w, -h), at(w, -h), at(w, h), at(-w, h)];
}

/** What the sliders show for any corner set: length and heading of the top edge, and the centre. */
export function derivedPlacement(corners: DroneCorners): { widthM: number; rotationDeg: number; centre: LatLng } {
  const centre = centroid(corners), f = frameAt(centre);
  const tl = toXY(f, corners[0]), tr = toXY(f, corners[1]);
  return { widthM: Math.hypot(tr.x - tl.x, tr.y - tl.y), rotationDeg: Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180 / Math.PI, centre };
}

function mapAbout(corners: DroneCorners, pivot: LatLng, fn: (p: XY) => XY): DroneCorners {
  const f = frameAt(pivot);
  return corners.map(c => toLatLng(f, fn(toXY(f, c)))) as DroneCorners;
}
/** Rotate about the pivot (default: the centre), which stays where it is; positive is clockwise on screen. */
export function rotateCorners(corners: DroneCorners, deg: number, pivot?: LatLng): DroneCorners {
  const t = rad(deg), c = Math.cos(t), s = Math.sin(t);
  return mapAbout(corners, pivot ?? centroid(corners), p => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
}
/** Scale about the pivot (default: the centre), which stays where it is. */
export function scaleCorners(corners: DroneCorners, k: number, pivot?: LatLng): DroneCorners {
  return mapAbout(corners, pivot ?? centroid(corners), p => ({ x: p.x * k, y: p.y * k }));
}
export function translateCorners(corners: DroneCorners, dLat: number, dLng: number): DroneCorners {
  return corners.map(c => ({ lat: c.lat + dLat, lng: c.lng + dLng })) as DroneCorners;
}

/**
 * A proper quadrilateral in the photo's own winding (top-left, top-right,
 * bottom-right, bottom-left is clockwise on screen). Rejects folded and
 * mirrored solutions.
 */
export function isConvex(corners: DroneCorners): boolean {
  const f = frameAt(centroid(corners)), p = corners.map(c => toXY(f, c));
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (!(cross > 1e-9)) return false;
  }
  return true;
}

/**
 * The corners that put each photo pixel on its map point.
 *
 * One pair: shift only. Two or three: rotate, scale and shift, least squares.
 * Four or more: the full homography, which also straightens a photo taken
 * with the camera not quite straight down; falls back to the similarity when
 * the points are degenerate (all on a line) or the result folds over.
 */
export function solvePlacement(size: PhotoSize, pairs: PointPair[], current: DroneCorners): DroneCorners {
  if (pairs.length === 0) return current;
  const f = frameAt(centroid(pairs.map(p => p.ll)));
  const P = pairs.map(p => ({ a: { x: p.px.u, y: p.px.v }, b: toXY(f, p.ll) }));
  const cornersOf = (h: Homography) => boxCorners(size).map(p => toLatLng(f, applyH(h, p))) as DroneCorners;
  if (P.length >= 4) {
    const h = homographyFromPairs(P);
    if (h) {
      const c = cornersOf(h);
      if (c.every(q => Number.isFinite(q.lat) && Number.isFinite(q.lng)) && isConvex(c)) return c;
    }
  }
  if (P.length >= 2) {
    const h = similarityFromPairs(P);
    if (h) return cornersOf(h);
  }
  const h0 = cornersHomography(current, size, f);
  if (!h0) return current;
  const now = applyH(h0, P[0].a);
  return cornersOf(multiplyH(translation(P[0].b.x - now.x, P[0].b.y - now.y), h0));
}
