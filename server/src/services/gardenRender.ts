/**
 * Garden render — turns the mower's own map into a 3D-looking picture of the
 * actual garden.
 *
 * Three steps, all server-side:
 *   1. BASE IMAGE. A north-up aerial of the plot: either the user's drone photo
 *      (placed by its four corners) or satellite tiles stitched for the bbox of
 *      the polygons. Both end up as "image + known corner coordinates".
 *   2. COMPOSITE. The work polygons are painted on it in green, the obstacles as
 *      flat red discs and the dock as a small black/white square. That picture
 *      is what fixes the geometry: whatever the image model does afterwards, the
 *      mown area is the area the mower actually mows.
 *   3. RENDER. An image model restyles the composite into a 3D visualisation,
 *      twice: one daytime and one evening version. The endpoint then serves
 *      whichever matches the time of day at the mower's location.
 *
 * The model call is the only part that leaves the machine, it is never
 * automatic, and the key is the user's own (or a relay token). See
 * `docs/guide/garden-render.md`.
 */

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import type { OverlayOptions } from 'sharp';
import { Resvg } from '@resvg/resvg-js';
import { mapRepo, deviceSettingsRepo } from '../db/repositories/index.js';
import { metersPerDegLat, metersPerDegLng } from '../mqtt/mapConverter.js';
import { readMeta } from '../routes/droneOverlay.js';

const TAG = '[garden-render]';

// ── Geometry ────────────────────────────────────────────────────────────────

export interface LatLng { lat: number; lng: number }
interface XY { x: number; y: number }

/** Local metres (charger-relative, as stored in `maps.map_area`) → lat/lng. */
function localToLatLng(p: XY, origin: LatLng, pose: XY): LatLng {
  return {
    lat: origin.lat + (p.y - pose.y) / metersPerDegLat(origin.lat),
    lng: origin.lng + (p.x - pose.x) / metersPerDegLng(origin.lat),
  };
}

/** Web-Mercator helpers, the projection every XYZ tile service uses. */
function lngToTileX(lng: number, z: number): number { return ((lng + 180) / 360) * 2 ** z; }
function latToTileY(lat: number, z: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
}

/**
 * Projection from lat/lng to pixels for a photo pinned by its four corners
 * (the drone overlay). Solved as a plane homography; the corner order is
 * top-left, top-right, bottom-right, bottom-left, matching droneOverlay.ts.
 */
type Pt = readonly [number, number];
/** A plane homography as 9 numbers, row-major, h33 = 1. */
export type Homography = number[];

/** The homography taking src[i] to dst[i], from four point pairs (DLT). */
export function solveHomography(src: Pt[], dst: Pt[]): Homography {
  const A: number[][] = []; const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]; const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gauss-Jordan with partial pivoting; 8x8, so speed is irrelevant here.
  const n = 8;
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    [A[i], A[piv]] = [A[piv], A[i]]; [b[i], b[piv]] = [b[piv], b[i]];
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  return [...A.map((row, i) => b[i] / row[i]), 1];
}

export function applyHomography(h: Homography, x: number, y: number): [number, number] {
  const d = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
}

export function invertHomography(h: Homography): Homography {
  const [a, b, c, d, e, f, g, k, i] = h;
  const A = e * i - f * k, B = -(d * i - f * g), C = d * k - e * g;
  const det = a * A + b * B + c * C;
  const m = [
    A, -(b * i - c * k), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * k - b * g), a * e - b * d,
  ].map(v => v / det);
  return m.map(v => v / m[8]);
}

function cornerProjection(corners: LatLng[], w: number, h: number): (p: LatLng) => [number, number] {
  const lng0 = corners.reduce((s, c) => s + c.lng, 0) / 4;
  const lat0 = corners.reduce((s, c) => s + c.lat, 0) / 4;
  const S = 1e4; // conditioning: degrees are tiny numbers
  const src = corners.map(c => [(c.lng - lng0) * S, (c.lat - lat0) * S] as const);
  const hm = solveHomography(src, [[0, 0], [w, 0], [w, h], [0, h]]);
  return (p: LatLng) => applyHomography(hm, (p.lng - lng0) * S, (p.lat - lat0) * S);
}

// ── Tilt ────────────────────────────────────────────────────────────────────
// The angled render is made from a composite WE have already put in
// perspective, with a camera we chose. The model is asked to keep that framing
// and add height, so the ground plane's mapping into the picture is known
// exactly, and the mower and its lanes can be drawn on it afterwards.

/** Output shape of every angled render. */
export const TILT_W = 1536; export const TILT_H = 1024;

/**
 * Pinhole camera south of the plot, `elevationDeg` above the ground, looking
 * at its centre: the homography from composite pixels to output pixels, with
 * the plot filling `fill` of the output. Far enough away that the perspective
 * stays mild, which is the isometric look people know from the Navimow app.
 */
export function tiltCamera(W: number, H: number, elevationDeg = 55, fill = 0.84): Homography {
  const th = (elevationDeg * Math.PI) / 180;
  const dist = 2.2 * Math.max(W, H);
  const C = [W / 2, H / 2 + dist * Math.cos(th), dist * Math.sin(th)];
  const F = [0, -Math.cos(th), -Math.sin(th)];   // forward: north and down
  const R = [1, 0, 0];                            // right: east
  const U = [0, -Math.sin(th), Math.cos(th)];     // up = F x R
  const proj = (u: number, v: number, f: number): [number, number] => {
    const dx = u - C[0], dy = v - C[1], dz = -C[2];
    const Xc = dx * R[0] + dy * R[1] + dz * R[2];
    const Yc = dx * U[0] + dy * U[1] + dz * U[2];
    const Zc = dx * F[0] + dy * F[1] + dz * F[2];
    return [(f * Xc) / Zc, (-f * Yc) / Zc];
  };
  const corners: Pt[] = [[0, 0], [W, 0], [W, H], [0, H]];
  const unit = corners.map(c => proj(c[0], c[1], 1));
  const xs = unit.map(p => p[0]); const ys = unit.map(p => p[1]);
  const f = Math.min((fill * TILT_W) / (Math.max(...xs) - Math.min(...xs)), (fill * TILT_H) / (Math.max(...ys) - Math.min(...ys)));
  const cx = TILT_W / 2 - (f * (Math.min(...xs) + Math.max(...xs))) / 2;
  const cy = TILT_H / 2 - (f * (Math.min(...ys) + Math.max(...ys))) / 2;
  const dst = corners.map(c => { const [x, y] = proj(c[0], c[1], f); return [x + cx, y + cy] as const; });
  return solveHomography(corners, dst);
}

/** Warp the composite through `h` onto a TILT_W x TILT_H canvas of colour `bg`. */
export async function warpComposite(png: Buffer, W: number, H: number, h: Homography, bg: [number, number, number]): Promise<Buffer> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const inv = invertHomography(h);
  const out = Buffer.alloc(TILT_W * TILT_H * 3);
  for (let y = 0; y < TILT_H; y++) {
    for (let x = 0; x < TILT_W; x++) {
      const [u, v] = applyHomography(inv, x + 0.5, y + 0.5);
      const o = (y * TILT_W + x) * 3;
      const su = u - 0.5, sv = v - 0.5;
      if (su < 0 || sv < 0 || su > W - 1 || sv > H - 1) { out[o] = bg[0]; out[o + 1] = bg[1]; out[o + 2] = bg[2]; continue; }
      const x0 = Math.floor(su), y0 = Math.floor(sv), fx = su - x0, fy = sv - y0;
      const x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
      for (let c = 0; c < 3; c++) {
        const p00 = data[(y0 * W + x0) * 4 + c], p10 = data[(y0 * W + x1) * 4 + c];
        const p01 = data[(y1 * W + x0) * 4 + c], p11 = data[(y1 * W + x1) * 4 + c];
        out[o + c] = Math.round((p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy);
      }
    }
  }
  return sharp(out, { raw: { width: TILT_W, height: TILT_H, channels: 3 } }).png().toBuffer();
}

// ── Base image ──────────────────────────────────────────────────────────────

export type BaseSource = 'aerial' | 'drone';

export interface BaseImage {
  png: Buffer;
  width: number;
  height: number;
  /** lat/lng → pixel for this exact image. */
  project: (p: LatLng) => [number, number];
  source: BaseSource;
  attribution: string;
}

interface TileSource { url: string; maxZoom: number; attribution: string; bounds?: [number, number, number, number] }

/** Mirrors the dashboard's TILE_LAYERS; same imagery the user already sees. */
const TILE_SOURCES: Record<string, TileSource> = {
  pdok: {
    url: 'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg',
    maxZoom: 21, bounds: [50.7, 3.2, 53.7, 7.3],
    attribution: 'PDOK / Beeldmateriaal Nederland',
  },
  usgs: {
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 20, bounds: [24.5, -125, 49.5, -66.9],
    attribution: 'USGS / The National Map',
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
    attribution: 'Esri, Maxar, Earthstar Geographics',
  },
};

function pickTileSource(lat: number, lng: number): [string, TileSource] {
  for (const key of ['pdok', 'usgs'] as const) {
    const s = TILE_SOURCES[key];
    const [south, west, north, east] = s.bounds!;
    if (lat >= south && lat <= north && lng >= west && lng <= east) return [key, s];
  }
  return ['satellite', TILE_SOURCES.satellite];
}

/** The garden's bounding box in lat/lng, plus a margin so the plot has some
 *  context around it. Kept tight on purpose: every metre of margin is a metre
 *  of neighbour's garden in the render, and the zone is what people came for. */
export interface LocalBox { minX: number; maxX: number; minY: number; maxY: number }

export function gardenBounds(
  sn: string, marginM = 9,
): { sw: LatLng; ne: LatLng; origin: LatLng; pose: XY; localBox: LocalBox } | null {
  const gps = mapRepo.getChargerGps(sn);
  if (!gps) return null;
  const pose = dockPose(sn);
  const pts: XY[] = [];
  for (const row of mapRepo.findByMowerSn(sn)) {
    if (!row.map_area) continue;
    try {
      for (const p of JSON.parse(row.map_area) as XY[]) {
        if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) pts.push(p);
      }
    } catch { /* a corrupt row is not this feature's problem */ }
  }
  if (pts.length < 3) return null;
  const xs = pts.map(p => p.x); const ys = pts.map(p => p.y);
  const localBox: LocalBox = {
    minX: Math.min(...xs) - marginM, maxX: Math.max(...xs) + marginM,
    minY: Math.min(...ys) - marginM, maxY: Math.max(...ys) + marginM,
  };
  const sw = localToLatLng({ x: localBox.minX, y: localBox.minY }, gps, pose);
  const ne = localToLatLng({ x: localBox.maxX, y: localBox.maxY }, gps, pose);
  return { sw, ne, origin: gps, pose, localBox };
}

/** The charging pose the polygons are drawn around; (0,0) when unknown. */
function dockPose(sn: string): XY {
  const anchorRow = mapRepo.findAllByMowerSnAndType(sn, 'unicom')
    .find(m => /^map\d+tocharge_unicom$/.test(m.canonical_name ?? m.map_name ?? ''));
  if (anchorRow?.map_area) {
    try {
      const pts = JSON.parse(anchorRow.map_area) as XY[];
      if (pts.length && Number.isFinite(pts[0]?.x)) return { x: pts[0].x, y: pts[0].y };
    } catch { /* fall through */ }
  }
  return { x: 0, y: 0 };
}

const MAX_PX = 2048;

/**
 * Paste tiles onto a blank sheet, then cut the requested box out of it.
 *
 * Two pipelines on purpose. sharp orders operations by kind, not by call
 * order: on one pipeline `extract` runs BEFORE `composite`, so the tiles land
 * on the already-cut canvas at their sheet offsets and the whole picture
 * shifts by (left, top). That put a garden's zone on the neighbour's roof
 * (2026-09-23) while the zone maths was right all along.
 */
export async function stitchAndCrop(
  tiles: OverlayOptions[], canvasW: number, canvasH: number,
  box: { left: number; top: number; width: number; height: number },
): Promise<Buffer> {
  const sheet = await sharp({ create: { width: canvasW, height: canvasH, channels: 3, background: '#000' } })
    .composite(tiles).png().toBuffer();
  return sharp(sheet).extract(box).png().toBuffer();
}

/** Stitch satellite tiles covering the garden into one north-up image. */
async function aerialBase(sn: string): Promise<BaseImage | null> {
  const b = gardenBounds(sn);
  if (!b) return null;
  const [, src] = pickTileSource(b.origin.lat, b.origin.lng);

  // Highest zoom whose stitched image stays under MAX_PX.
  let z = src.maxZoom;
  for (; z > 12; z--) {
    const w = (lngToTileX(b.ne.lng, z) - lngToTileX(b.sw.lng, z)) * 256;
    const h = (latToTileY(b.sw.lat, z) - latToTileY(b.ne.lat, z)) * 256;
    if (w <= MAX_PX && h <= MAX_PX) break;
  }
  const x0 = lngToTileX(b.sw.lng, z); const x1 = lngToTileX(b.ne.lng, z);
  const y0 = latToTileY(b.ne.lat, z); const y1 = latToTileY(b.sw.lat, z);
  const tx0 = Math.floor(x0); const tx1 = Math.floor(x1);
  const ty0 = Math.floor(y0); const ty1 = Math.floor(y1);
  const cols = tx1 - tx0 + 1; const rows = ty1 - ty0 + 1;
  if (cols * rows > 64) { console.warn(`${TAG} ${sn}: ${cols}x${rows} tiles is too many, giving up`); return null; }

  const canvasW = cols * 256; const canvasH = rows * 256;
  const composites: OverlayOptions[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const url = src.url.replace('{z}', String(z)).replace('{x}', String(tx)).replace('{y}', String(ty));
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'OpenNova/1.0 (+https://github.com/rvbcrs/Novabot)' } });
        if (!res.ok) { console.warn(`${TAG} tile ${z}/${tx}/${ty}: HTTP ${res.status}`); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        composites.push({ input: await sharp(buf).png().toBuffer(), left: (tx - tx0) * 256, top: (ty - ty0) * 256 });
      } catch (e) {
        console.warn(`${TAG} tile ${z}/${tx}/${ty} failed: ${(e as Error).message}`);
      }
    }
  }
  if (composites.length === 0) return null;

  // Crop the stitched sheet back to the requested bbox.
  const left = Math.round((x0 - tx0) * 256); const top = Math.round((y0 - ty0) * 256);
  const width = Math.max(64, Math.round((x1 - x0) * 256)); const height = Math.max(64, Math.round((y1 - y0) * 256));
  const png = await stitchAndCrop(composites, canvasW, canvasH,
    { left, top, width: Math.min(width, canvasW - left), height: Math.min(height, canvasH - top) });
  const meta = await sharp(png).metadata();
  const W = meta.width ?? width; const H = meta.height ?? height;

  // The crop is axis-aligned in Web Mercator, so the mapping is a plain scale.
  const project = (p: LatLng): [number, number] => [
    (lngToTileX(p.lng, z) - x0) * 256,
    (latToTileY(p.lat, z) - y0) * 256,
  ];
  return { png, width: W, height: H, project, source: 'aerial', attribution: src.attribution };
}

/** Use the user's own drone photo, placed by its four corners. */
async function droneBase(sn: string): Promise<BaseImage | null> {
  const meta = readMeta(sn);
  if (!meta?.placement?.corners || meta.placement.corners.length !== 4) return null;
  const file = path.resolve(process.env.STORAGE_PATH ?? './storage', 'overlays', meta.file);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file);
  const png = await sharp(raw).png().toBuffer();
  const dims = await sharp(png).metadata();
  const W = dims.width ?? meta.width; const H = dims.height ?? meta.height;
  return {
    png, width: W, height: H, source: 'drone', attribution: 'eigen dronefoto',
    project: cornerProjection(meta.placement.corners, W, H),
  };
}

/** Everything a client needs to put a ground point on an angled render. */
function tiltMeta(sn: string, base: BaseImage, h: Homography): NonNullable<RenderMeta['tilt']> {
  const b = gardenBounds(sn)!;
  const local: Pt[] = [[b.localBox.minX, b.localBox.maxY], [b.localBox.maxX, b.localBox.maxY], [b.localBox.maxX, b.localBox.minY], [b.localBox.minX, b.localBox.minY]];
  const render = local.map(([x, y]) => {
    const [u, v] = base.project(localToLatLng({ x, y }, b.origin, b.pose));
    return applyHomography(h, u, v);
  });
  return {
    homography: h, localToRender: solveHomography(local, render), origin: b.origin, pose: b.pose,
    compositeWidth: base.width, compositeHeight: base.height, width: TILT_W, height: TILT_H,
  };
}

/** The four ground corners of a base image, in the drone-overlay order. For a
 *  tile crop that is the bbox; for a drone photo it is its stored placement. */
function baseCorners(sn: string, base: BaseImage): LatLng[] | null {
  if (base.source === 'drone') {
    const meta = readMeta(sn);
    return meta?.placement?.corners ?? null;
  }
  const b = gardenBounds(sn);
  if (!b) return null;
  return [
    { lat: b.ne.lat, lng: b.sw.lng },   // top-left
    { lat: b.ne.lat, lng: b.ne.lng },   // top-right
    { lat: b.sw.lat, lng: b.ne.lng },   // bottom-right
    { lat: b.sw.lat, lng: b.sw.lng },   // bottom-left
  ];
}

export async function baseImage(sn: string, prefer: BaseSource): Promise<BaseImage | null> {
  if (prefer === 'drone') return (await droneBase(sn)) ?? (await aerialBase(sn));
  return (await aerialBase(sn)) ?? (await droneBase(sn));
}

// ── Composite ───────────────────────────────────────────────────────────────

/**
 * Paint the mower's own geometry onto the base image. Deliberately blunt
 * shapes: the image model copies what it can recognise, and a flat red disc
 * survives the restyle where a drawn bush would become a real bush.
 */
export async function compositeImage(sn: string, base: BaseImage): Promise<Buffer> {
  const gps = mapRepo.getChargerGps(sn);
  if (!gps) throw new Error('no charger GPS');
  const pose = dockPose(sn);
  const px = (p: XY) => base.project(localToLatLng(p, gps, pose));
  const parse = (row: { map_area: string | null }): XY[] => {
    if (!row.map_area) return [];
    try { return (JSON.parse(row.map_area) as XY[]).filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y)); }
    catch { return []; }
  };

  const rows = mapRepo.findByMowerSn(sn);
  const parts: string[] = [];
  const stroke = Math.max(4, Math.round(base.width / 240));

  for (const r of rows.filter(r => r.map_type === 'work')) {
    const pts = parse(r).map(px);
    if (pts.length < 3) continue;
    const d = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    parts.push(`<polygon points="${d}" fill="#6ebe50" fill-opacity="0.58" stroke="#23702c" stroke-width="${stroke}" stroke-linejoin="round"/>`);
  }
  for (const r of rows.filter(r => r.map_type === 'obstacle')) {
    const pts = parse(r).map(px);
    if (pts.length < 3) continue;
    const xs = pts.map(p => p[0]); const ys = pts.map(p => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const rr = Math.max(stroke * 3, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2);
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rr.toFixed(1)}" fill="#e01e1e" stroke="#8c0000" stroke-width="${(stroke * 0.7).toFixed(1)}"/>`);
  }
  const [dx, dy] = px(pose);
  const s = Math.max(stroke * 2.5, base.width / 150);
  parts.push(`<rect x="${(dx - s).toFixed(1)}" y="${(dy - s).toFixed(1)}" width="${(s * 2).toFixed(1)}" height="${(s * 2).toFixed(1)}" rx="${(s * 0.2).toFixed(1)}" fill="#191919"/>`);
  parts.push(`<rect x="${(dx - s * 0.6).toFixed(1)}" y="${(dy - s * 0.45).toFixed(1)}" width="${(s * 1.2).toFixed(1)}" height="${(s * 1.05).toFixed(1)}" rx="${(s * 0.15).toFixed(1)}" fill="#fafafa"/>`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${base.width}" height="${base.height}">${parts.join('')}</svg>`;
  const overlay = new Resvg(svg, { fitTo: { mode: 'width', value: base.width } }).render().asPng();
  return sharp(base.png).composite([{ input: overlay }]).png().toBuffer();
}

// ── Storage ─────────────────────────────────────────────────────────────────

export type Variant = 'day' | 'night';
/** 'iso' is the picture; 'flat' keeps the aerial's framing so it can be laid
 *  on the map with the mower, its trail and the covered lanes on top. */
export type Framing = 'iso' | 'flat';
const VARIANTS: Variant[] = ['day', 'night'];

export interface RenderMeta {
  createdAt: string;
  source: BaseSource;
  attribution: string;
  /** Number of map rows at render time, so we can spot a changed map. */
  mapRows: number;
  variants: Variant[];
  framing: Framing;
  /** Corner coordinates of a flat render, in the drone-overlay order
   *  (top-left, top-right, bottom-right, bottom-left). Null for 'iso'. */
  corners: LatLng[] | null;
  /** The same extent in local metres, for clients that draw in that frame.
   *  Only for a tile crop: a drone photo can be rotated, which a box cannot say. */
  localBox: LocalBox | null;
  /** Angled renders only: the camera we chose, so the ground plane's place in
   *  the picture is known exactly and the mower can be drawn on it. */
  tilt: {
    /** Composite pixels → render pixels. */
    homography: Homography;
    /** Local metres (the map frame, charger-relative) → render pixels. */
    localToRender: Homography;
    /** Local metres = ((lng − origin.lng)·mPerDegLng + pose.x, (lat − origin.lat)·mPerDegLat + pose.y). */
    origin: LatLng;
    pose: XY;
    compositeWidth: number; compositeHeight: number;
    width: number; height: number;
  } | null;
}

/** Same shape droneOverlay.ts accepts. The SN reaches the filesystem below, so
 *  anything with a slash or a dot in it is refused rather than resolved. */
const SN_RE = /^[A-Za-z0-9_-]{4,32}$/;

export function isValidSn(sn: string): boolean { return SN_RE.test(sn); }

function renderDir(sn: string): string {
  if (!SN_RE.test(sn)) throw new Error(`invalid sn: ${sn.slice(0, 32)}`);
  const dir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'renders', sn);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Each framing keeps its own pair of pictures, so making one never costs the
 *  other. JPEG: the model returns a 2-3 MB PNG, a slow load over a VPN for no
 *  visible gain in a photo-like picture. */
export function renderPath(sn: string, v: Variant, framing: Framing): string {
  return path.join(renderDir(sn), `${v}-${framing}.jpg`);
}
/** Renders from before framings existed: one pair, `day.jpg`/`day.png`, plus
 *  a single `meta.json`. They stay readable under the framing that meta names. */
function legacyMeta(sn: string): RenderMeta | null {
  const f = path.join(renderDir(sn), 'meta.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) as RenderMeta; } catch { return null; }
}
function legacyFiles(sn: string, v: Variant): string[] {
  return [path.join(renderDir(sn), `${v}.jpg`), path.join(renderDir(sn), `${v}.png`)];
}
/** The picture to serve, or null when this framing was never made. */
export function renderFile(sn: string, v: Variant, framing: Framing): string | null {
  if (!SN_RE.test(sn)) return null;
  const own = renderPath(sn, v, framing);
  if (fs.existsSync(own)) return own;
  if ((legacyMeta(sn)?.framing ?? 'iso') !== framing) return null;
  return legacyFiles(sn, v).find(f => fs.existsSync(f)) ?? null;
}

/** Path of the composite we sent to the model. Same guard as the renders. */
export function compositePath(sn: string): string {
  return path.join(renderDir(sn), 'composite.png');
}

export function readRenderMeta(sn: string, framing: Framing): RenderMeta | null {
  if (!SN_RE.test(sn)) return null;
  const f = path.join(renderDir(sn), `meta-${framing}.json`);
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')) as RenderMeta; } catch { return null; }
  }
  const legacy = legacyMeta(sn);
  return legacy && (legacy.framing ?? 'iso') === framing ? { ...legacy, framing } : null;
}

export interface FramingStatus { meta: RenderMeta; stale: boolean }
/** What exists for each framing; null when it was never made. */
export function framingStatus(sn: string): Record<Framing, FramingStatus | null> {
  const one = (framing: Framing): FramingStatus | null => {
    const meta = readRenderMeta(sn, framing);
    return meta ? { meta, stale: isStale(sn, meta) } : null;
  };
  return { iso: one('iso'), flat: one('flat') };
}

/** True when the map changed after the render was made. */
export function isStale(sn: string, meta: RenderMeta | null): boolean {
  if (!meta) return false;
  return mapRepo.findByMowerSn(sn).length !== meta.mapRows;
}

// ── Credentials ─────────────────────────────────────────────────────────────

const KEY_SETTING = 'render.openai_key';
const TOKEN_SETTING = 'render.relay_token';
/** Settings live per SN in device_settings; this row holds the server-wide ones. */
const GLOBAL_SN = '_server';

export interface RenderCredentials { mode: 'own-key' | 'relay' | 'none'; key?: string; token?: string }

export function getCredentials(): RenderCredentials {
  // Environment wins: it lets an operator keep the key out of the database
  // entirely, and it is how the test harness supplies one.
  const envKey = process.env.RENDER_OPENAI_KEY;
  if (envKey) return { mode: 'own-key', key: envKey };
  const envToken = process.env.RENDER_RELAY_TOKEN;
  if (envToken) return { mode: 'relay', token: envToken };
  const rows = deviceSettingsRepo.findBySn(GLOBAL_SN);
  const key = rows.find(r => r.key === KEY_SETTING)?.value;
  const token = rows.find(r => r.key === TOKEN_SETTING)?.value;
  if (key) return { mode: 'own-key', key };
  if (token) return { mode: 'relay', token };
  return { mode: 'none' };
}

export function setCredentials(patch: { openaiKey?: string | null; relayToken?: string | null }): void {
  if (patch.openaiKey !== undefined) {
    deviceSettingsRepo.upsert(GLOBAL_SN, KEY_SETTING, patch.openaiKey ?? '');
  }
  if (patch.relayToken !== undefined) {
    deviceSettingsRepo.upsert(GLOBAL_SN, TOKEN_SETTING, patch.relayToken ?? '');
  }
}

// ── The model call ──────────────────────────────────────────────────────────

const MODEL = process.env.RENDER_MODEL ?? 'gpt-image-2.5-sunburst';
const RELAY_URL = process.env.RENDER_RELAY_URL ?? 'https://downloads.ramonvanbruggen.nl/render';

const PROMPT_BASE = `Turn this image into a high-quality 3D isometric CGI render of the property: clean stylised computer graphics, simplified smooth materials, slightly stylised trees and shrubs, soft ambient occlusion and gentle contact shadows, crisp edges, no photographic grain. It must clearly look like a 3D model, not a photograph.

Content comes only from the input image: the same house with its roof shape, the same terrace, sheds, driveway, boundary hedges, trees and roads, every element in its real position, with the plot's proportions kept.

Camera: elevated three-quarter bird's-eye view, roughly 45 degrees, the plot rendered as a neat tilted island of ground on a plain empty background, the whole property inside the frame with margin on all sides.

The semi-transparent green area with the dark green outline is the robot mower's mowing zone: render it as a vivid, freshly mown striped lawn, crisply following that outline, as the visual focus. The flat solid RED discs are obstacle markers, not objects: keep them as flat, opaque red circles lying on the grass, clean-edged, with no texture, plants or shadow. The small black-and-white square is the charging dock: put a small white robot mower on it. No people, no text, no labels.`;

const PROMPT_NIGHT = `${PROMPT_BASE}

Lighting and mood: evening. Deep dark blue-grey empty background, the house glowing warm through its windows, soft warm garden and terrace lighting with subtle light spill on paving and planting. The lawn stays clearly readable in cool moonlight with its mowing stripes, and the red obstacle markers stay flat, opaque and bright. Cinematic but clean, no lens flares.`;

const PROMPT_TILT = `This is an aerial photo of a property that has already been placed in perspective, seen from a raised three-quarter viewpoint, on a plain background. Turn it into a high-quality 3D CGI render of the same property seen from exactly this camera: clean stylised computer graphics, simplified smooth materials, slightly stylised trees and shrubs, soft ambient occlusion and gentle contact shadows, crisp edges, no photographic grain. Give everything its real height: walls rising from the building footprints with roofs on top, hedges, trees, fences and sheds standing up from the ground. The plot is a neat island of ground; the plain background stays plain and empty.

CAMERA, NON-NEGOTIABLE: keep the exact framing and perspective of the input. Every point on the ground stays at exactly the same position on the canvas: the lawn outline, paths, driveway, terrace and the edges of the plot. Do not re-tilt, rotate, zoom or crop.

The semi-transparent green area with the dark green outline is the robot mower's mowing zone: render it as a vivid, freshly mown striped lawn, its outline exactly where it is now. The flat solid RED discs are obstacle markers, not objects: keep them as flat, opaque red discs lying on the grass exactly where they are, clean-edged, no texture, plants or shadow. The small black-and-white square is the charging dock: put a small white robot mower on it. No people, no text, no labels.`;

const PROMPT_TILT_NIGHT = `${PROMPT_TILT}

Lighting and mood: evening. Deep dark blue-grey empty background, the house glowing warm through its windows, soft warm garden and terrace lighting with subtle light spill on paving and planting. The lawn stays clearly readable in cool moonlight with its mowing stripes, and the red obstacle markers stay flat, opaque and bright. Cinematic but clean, no lens flares.`;

const PROMPT_FLAT = `Turn this aerial photo into a clean 3D architectural visualisation of the same property: simplified smooth materials, slightly stylised trees and shrubs, crisp edges, soft even daylight, no photographic grain. It must look rendered, not photographed, but stay faithful to what is there: the same house and roofs, terrace, sheds, driveway with cars, hedges, trees, paths and roads, each in its exact position.

CAMERA, NON-NEGOTIABLE: keep the exact straight-down (nadir) viewpoint and framing of the input. Do not tilt, do not rotate, do not crop or zoom: every roof, hedge and path must stay on the same spot on the canvas as in the input, edge to edge. The output is the same rectangle of ground, redrawn.

The semi-transparent green area with the dark green outline is the robot mower's mowing zone: render it as a freshly mown striped lawn exactly inside that outline. The flat solid RED discs are obstacle markers, not objects: keep them flat, opaque and clean-edged, with no plants or shadow. Leave the small black-and-white dock square as it is. No people, no text, no labels.`;

const PROMPT_FLAT_NIGHT = `${PROMPT_FLAT}

Lighting: evening. Warm light from the house windows, soft garden and street lighting, the lawn readable in cool moonlight. The red markers stay flat and bright.`;

/** The only output shapes the image API offers. */
const OUT_SIZES: Array<[number, number]> = [[1536, 1024], [1024, 1024], [1024, 1536]];

/**
 * A flat render has to come back covering exactly the ground that went in, and
 * the model only draws in the three shapes above. So the composite is padded
 * to the nearest one, and the result is cropped back by the same proportions.
 * Whatever the model invents in the padding is thrown away with it.
 */
async function padToAspect(png: Buffer, w: number, h: number): Promise<{
  png: Buffer; size: [number, number]; crop: { left: number; top: number; width: number; height: number };
}> {
  const want = OUT_SIZES.reduce((best, s) =>
    Math.abs(s[0] / s[1] - w / h) < Math.abs(best[0] / best[1] - w / h) ? s : best);
  const target = want[0] / want[1];
  const padW = w / h < target ? Math.round(h * target) - w : 0;
  const padH = w / h > target ? Math.round(w / target) - h : 0;
  const left = Math.floor(padW / 2); const top = Math.floor(padH / 2);
  const padded = padW || padH
    ? await sharp(png).extend({
        left, top, right: padW - left, bottom: padH - top,
        background: { r: 20, g: 24, b: 28, alpha: 1 },
      }).png().toBuffer()
    : png;
  // The same rectangle, expressed in the output's pixels.
  const k = want[0] / (w + padW);
  return {
    png: padded,
    size: want,
    crop: {
      left: Math.round(left * k), top: Math.round(top * k),
      width: Math.round(w * k), height: Math.round(h * k),
    },
  };
}

async function callImageModel(
  png: Buffer, prompt: string, creds: RenderCredentials, size: [number, number] = [1536, 1024],
): Promise<Buffer> {
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('size', `${size[0]}x${size[1]}`);
  form.append('quality', 'high');
  form.append('image[]', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'garden.png');

  if (creds.mode === 'relay') {
    const res = await fetch(RELAY_URL, { method: 'POST', headers: { Authorization: `Bearer ${creds.token}` }, body: form });
    if (!res.ok) throw new Error(`relay ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (creds.mode !== 'own-key') throw new Error('no render credentials configured');

  form.append('model', MODEL);
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST', headers: { Authorization: `Bearer ${creds.key}` }, body: form,
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json() as { data?: Array<{ b64_json?: string }> };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image');
  return Buffer.from(b64, 'base64');
}

/** How many renders the relay token still has. null when not on a token, or
 *  when the relay cannot be reached — never a reason to block anything. */
export async function relayCredits(): Promise<{ credits: number; used: number } | null> {
  const creds = getCredentials();
  if (creds.mode !== 'relay') return null;
  try {
    const base = RELAY_URL.replace(/\/render\/?$/, '');
    const r = await fetch(`${base}/credits`, {
      headers: { Authorization: `Bearer ${creds.token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const b = await r.json() as { credits?: number; used?: number };
    return Number.isFinite(b.credits) ? { credits: b.credits!, used: b.used ?? 0 } : null;
  } catch {
    return null;
  }
}

export interface GenerateResult { ok: true; meta: RenderMeta }

/** Build the composite and render both variants. Throws with a readable reason. */
export async function generateRenders(
  sn: string,
  opts: { source?: BaseSource; framing?: Framing } = {},
): Promise<GenerateResult> {
  const framing: Framing = opts.framing ?? 'iso';
  const { emitRenderProgress } = await import('../dashboard/socketHandler.js');
  const steps = VARIANTS.length + 1;
  const fail = (phase: string, error: string): never => {
    emitRenderProgress({ sn, phase, error });
    throw new Error(error);
  };

  const creds = getCredentials();
  if (creds.mode === 'none') fail('failed', 'no_credentials');
  emitRenderProgress({ sn, phase: 'base', step: 0, steps });
  const base = await baseImage(sn, opts.source ?? 'aerial');
  if (!base) fail('failed', 'no_base_image');
  emitRenderProgress({ sn, phase: 'composite', step: 1, steps });
  const composite = await compositeImage(sn, base!);
  fs.writeFileSync(path.join(renderDir(sn), 'composite.png'), composite);
  // A flat render is a map layer, so it must cover the same ground as the
  // composite. An angled one is made from the composite put in perspective by
  // a camera we chose, which the model is told to keep, so the ground plane's
  // place in the picture is known exactly (see tiltCamera).
  const padded = framing === 'flat' ? await padToAspect(composite, base!.width, base!.height) : null;
  const tiltH = framing === 'iso' ? tiltCamera(base!.width, base!.height) : null;

  let step = 1;
  for (const v of VARIANTS) {
    emitRenderProgress({ sn, phase: v === 'night' ? 'night' : 'day', step, steps });
    let png: Buffer;
    try {
      const prompt = framing === 'flat'
        ? (v === 'night' ? PROMPT_FLAT_NIGHT : PROMPT_FLAT)
        : (v === 'night' ? PROMPT_TILT_NIGHT : PROMPT_TILT);
      const input = tiltH
        ? await warpComposite(composite, base!.width, base!.height, tiltH, v === 'night' ? [15, 24, 38] : [236, 239, 241])
        : padded?.png ?? composite;
      png = await callImageModel(input, prompt, creds, tiltH ? [TILT_W, TILT_H] : padded?.size);
      if (padded) png = await sharp(png).extract(padded.crop).png().toBuffer();
    } catch (err) {
      return fail('failed', (err as Error).message);
    }
    const jpg = await sharp(png).jpeg({ quality: 92 }).toBuffer();
    fs.writeFileSync(renderPath(sn, v, framing), jpg);
    step += 1;
    console.log(`${TAG} ${sn}: ${v} render written (${jpg.length} bytes, ${framing}, source=${base!.source})`);
  }
  emitRenderProgress({ sn, phase: 'done', step: steps, steps });

  const meta: RenderMeta = {
    createdAt: new Date().toISOString(),
    source: base!.source,
    attribution: base!.attribution,
    mapRows: mapRepo.findByMowerSn(sn).length,
    variants: VARIANTS,
    framing,
    // Only a flat render keeps the aerial's framing, so only then do the
    // bbox corners describe where the picture lies on the ground.
    corners: framing === 'flat' ? baseCorners(sn, base!) : null,
    localBox: framing === 'flat' && base!.source === 'aerial' ? (gardenBounds(sn)?.localBox ?? null) : null,
    tilt: tiltH ? tiltMeta(sn, base!, tiltH) : null,
  };
  fs.writeFileSync(path.join(renderDir(sn), `meta-${framing}.json`), JSON.stringify(meta, null, 2));
  // A pre-framing render of this same framing is superseded now; the other
  // framing's legacy files, if that is what they are, stay.
  if ((legacyMeta(sn)?.framing ?? 'iso') === framing) {
    for (const f of [path.join(renderDir(sn), 'meta.json'), ...VARIANTS.flatMap(v => legacyFiles(sn, v))]) fs.rmSync(f, { force: true });
  }
  return { ok: true, meta };
}

/**
 * Which variant suits the moment at the mower's location. Uses the sunrise and
 * sunset the weather service already fetches for the rain and night guards, so
 * this costs no extra API call. Unknown location or a failed lookup → day.
 */
export async function variantForNow(sn: string, now = Date.now()): Promise<Variant> {
  const gps = mapRepo.getChargerGps(sn);
  if (!gps) return 'day';
  try {
    const { getWeatherForecast, isNight } = await import('./weatherService.js');
    const forecast = await getWeatherForecast(gps.lat, gps.lng);
    return isNight(forecast, now) ? 'night' : 'day';
  } catch {
    return 'day';
  }
}
