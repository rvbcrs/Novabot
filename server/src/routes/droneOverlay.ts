/**
 * Drone photo as map backdrop (#124).
 *
 * The open aerial imagery is rectified against a terrain model, so anything
 * with height leans away from the nadir point, and the hedge someone traces
 * sits a metre from where it stands. A consumer drone shoots straight down at
 * a centimetre or two per pixel. This lets a user put that photo under the
 * map: one image per mower, stored on disk, placed by its four corners on the
 * map (a homography, so a photo from a tilted camera can still be laid flat),
 * drawn below the polygons as a tracing aid and nothing more. It never feeds
 * a coordinate into a map.
 *
 * Mounted on dashboardRouter, so it sits behind the same LAN/auth gate.
 */
import { Router, type Request, type Response } from 'express';
import express from 'express';
import path from 'path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { deviceSettingsRepo } from '../db/repositories/index.js';
import { imageDimensions } from '../services/imageDimensions.js';
import { photoMetadata, type PhotoMetadata } from '../services/photoMetadata.js';

export const droneOverlayRouter = Router();

const SN_RE = /^[A-Za-z0-9_-]{4,32}$/;
const SETTING_KEY = 'drone_overlay';
/** One garden fits in a few metres to a few hundred; anything else is a typo. */
const EXTENT_M = { min: 1, max: 3000 };
const M_PER_DEG_LAT = 111_320;

export interface LatLng { lat: number; lng: number }
/** Top-left, top-right, bottom-right, bottom-left of the photo, on the map. */
export type Corners = [LatLng, LatLng, LatLng, LatLng];
export interface OverlayPlacement {
  corners: Corners;
  opacity: number;
}
/** What the first betas stored: a rectangle by centre, ground width and rotation. */
interface LegacyPlacement { lat: number; lng: number; widthM: number; rotationDeg?: number; opacity?: number }

/**
 * Corners of a photo laid flat: centre, ground width in metres, rotation
 * clockwise on screen. The same arithmetic as the dashboard's
 * similarityCorners (x east, y south, flat frame); it lives here as well
 * because the server cannot import from the dashboard tree.
 */
export function similarityCorners(centre: LatLng, widthM: number, rotationDeg: number, aspect: number): Corners {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(centre.lat * Math.PI / 180);
  const w = widthM / 2, h = widthM / aspect / 2;
  const t = rotationDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const at = (x: number, y: number): LatLng => {
    const rx = x * c - y * s, ry = x * s + y * c;
    return { lat: centre.lat - ry / M_PER_DEG_LAT, lng: centre.lng + rx / mPerDegLng };
  };
  return [at(-w, -h), at(w, -h), at(w, h), at(-w, h)];
}

export interface OverlayMeta {
  file: string;
  width: number;
  height: number;
  mime: 'image/jpeg' | 'image/png';
  size: number;
  updatedAt: string;
  placement: OverlayPlacement | null;
  /** What the drone wrote into the photo, when it did; placedFromPhoto says the placement came from it. */
  camera?: PhotoMetadata & { placedFromPhoto: boolean };
}

/**
 * The first placement of a fresh photo. With a drone's metadata: centre at
 * its GPS position, ground width from height above take-off and the lens
 * (the 35 mm equivalent focal length is defined on the 36x24 frame's
 * diagonal, 43.27 mm), heading from the gimbal. Without: the map centre the
 * client sent, 60 m wide, north up. Either way the points do the rest.
 */
export function firstPlacement(m: PhotoMetadata, dims: { width: number; height: number }, fallback: LatLng | null): OverlayPlacement | null {
  const hasGps = m.lat !== undefined && m.lng !== undefined && Math.abs(m.lat) <= 90 && Math.abs(m.lng) <= 180 && !(m.lat === 0 && m.lng === 0);
  const centre = hasGps ? { lat: m.lat as number, lng: m.lng as number } : fallback;
  if (!centre) return null;
  let widthM = 60;
  if (m.altitudeM !== undefined && m.altitudeM > 2 && m.focal35 !== undefined && m.focal35 > 0) {
    const halfDiag = Math.atan(43.27 / (2 * m.focal35));
    const halfHorizontal = Math.atan(Math.tan(halfDiag) * dims.width / Math.hypot(dims.width, dims.height));
    widthM = Math.min(EXTENT_M.max / 2, Math.max(EXTENT_M.min, 2 * m.altitudeM * Math.tan(halfHorizontal)));
  }
  const rotationDeg = m.yawDeg !== undefined ? m.yawDeg : 0;
  return { corners: similarityCorners(centre, widthM, rotationDeg, dims.width / dims.height), opacity: 0.8 };
}

function storageDir(): string {
  return path.resolve(process.env.STORAGE_PATH ?? './storage', 'overlays');
}

export function readMeta(sn: string): OverlayMeta | null {
  const row = deviceSettingsRepo.findBySn(sn).find(r => r.key === SETTING_KEY);
  if (!row?.value) return null;
  let meta: OverlayMeta;
  try { meta = JSON.parse(row.value) as OverlayMeta; } catch { return null; }
  // A placement from before the corners model: the rectangle it described.
  const p = meta.placement as unknown;
  if (p && typeof p === 'object' && !('corners' in p)) {
    const l = p as LegacyPlacement;
    meta.placement = {
      corners: similarityCorners({ lat: l.lat, lng: l.lng }, l.widthM, l.rotationDeg ?? 0, meta.width / meta.height),
      opacity: l.opacity ?? 0.8,
    };
  }
  return meta;
}

function writeMeta(sn: string, meta: OverlayMeta): void {
  deviceSettingsRepo.upsert(sn, SETTING_KEY, JSON.stringify(meta));
}

/** Validate a placement from the client; null when any field is out of range. */
export function parsePlacement(body: unknown): OverlayPlacement | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const opacity = b.opacity === undefined ? 0.8 : num(b.opacity);
  if (Number.isNaN(opacity) || opacity < 0 || opacity > 1) return null;
  if (!Array.isArray(b.corners) || b.corners.length !== 4) return null;
  const corners: LatLng[] = [];
  for (const c of b.corners) {
    if (!c || typeof c !== 'object') return null;
    const lat = num((c as Record<string, unknown>).lat), lng = num((c as Record<string, unknown>).lng);
    if (Number.isNaN(lat) || Number.isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    corners.push({ lat, lng });
  }
  // The photo's extent on the ground, as the longest distance between corners.
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(corners[0].lat * Math.PI / 180);
  let extent = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      extent = Math.max(extent, Math.hypot((corners[i].lat - corners[j].lat) * M_PER_DEG_LAT, (corners[i].lng - corners[j].lng) * mPerDegLng));
    }
  }
  if (extent < EXTENT_M.min || extent > EXTENT_M.max) return null;
  return { corners: corners as Corners, opacity };
}

function snOr400(req: Request, res: Response): string | null {
  const sn = String(req.params.sn ?? '').trim();
  if (!SN_RE.test(sn)) { res.status(400).json({ error: 'invalid sn' }); return null; }
  return sn;
}

// GET /overlay/:sn — metadata and placement, 404 when there is no photo.
droneOverlayRouter.get('/:sn', (req, res) => {
  const sn = snOr400(req, res); if (!sn) return;
  const meta = readMeta(sn);
  if (!meta || !existsSync(path.join(storageDir(), meta.file))) {
    res.status(404).json({ error: 'no overlay for this mower' });
    return;
  }
  const { file: _file, ...pub } = meta;
  res.json({ sn, ...pub });
});

// GET /overlay/:sn/image — the file itself. The client appends ?v=updatedAt
// so a re-upload is not served from the browser cache.
droneOverlayRouter.get('/:sn/image', (req, res) => {
  const sn = snOr400(req, res); if (!sn) return;
  const meta = readMeta(sn);
  const file = meta ? path.join(storageDir(), meta.file) : null;
  if (!meta || !file || !existsSync(file)) { res.status(404).json({ error: 'no overlay for this mower' }); return; }
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.type(meta.mime);
  res.sendFile(file);
});

// PUT /overlay/:sn/image — raw JPEG or PNG body. The first placement comes
// from the photo's own metadata when a drone wrote it; otherwise the optional
// ?lat=&lng= (map centre at upload time) with 60 m width, so the photo is
// visible before anyone has dragged it. An existing placement is kept: a
// re-upload of an edited crop must not undo careful work.
droneOverlayRouter.put('/:sn/image',
  express.raw({ type: ['image/jpeg', 'image/png', 'application/octet-stream'], limit: '50mb' }),
  (req, res) => {
    const sn = snOr400(req, res); if (!sn) return;
    const buf = req.body as Buffer | undefined;
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
      res.status(400).json({ error: 'send the image as the raw request body' });
      return;
    }
    const dims = imageDimensions(buf);
    if (!dims) { res.status(415).json({ error: 'not a JPEG or PNG' }); return; }

    const dir = storageDir();
    mkdirSync(dir, { recursive: true });
    const file = `${sn}.${dims.mime === 'image/png' ? 'png' : 'jpg'}`;
    // A previous upload with the other extension must not linger next to it.
    for (const stale of [`${sn}.jpg`, `${sn}.png`]) {
      if (stale !== file && existsSync(path.join(dir, stale))) { try { unlinkSync(path.join(dir, stale)); } catch { /* best effort */ } }
    }
    writeFileSync(path.join(dir, file), buf);

    const previous = readMeta(sn);
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    const photo = dims.mime === 'image/jpeg' ? photoMetadata(buf) : {};
    const fallback = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    const placement: OverlayPlacement | null = previous?.placement ?? firstPlacement(photo, dims, fallback);
    const camera = Object.keys(photo).length
      ? { ...photo, placedFromPhoto: !previous?.placement && photo.lat !== undefined }
      : undefined;
    const meta: OverlayMeta = {
      file, width: dims.width, height: dims.height, mime: dims.mime, size: buf.length,
      updatedAt: new Date().toISOString(), placement, camera,
    };
    writeMeta(sn, meta);
    const { file: _f, ...pub } = meta;
    res.json({ sn, ...pub });
  });

// PUT /overlay/:sn — placement only.
droneOverlayRouter.put('/:sn', (req, res) => {
  const sn = snOr400(req, res); if (!sn) return;
  const meta = readMeta(sn);
  if (!meta) { res.status(404).json({ error: 'upload a photo first' }); return; }
  const placement = parsePlacement(req.body);
  if (!placement) { res.status(400).json({ error: 'placement needs corners (4 x {lat, lng}, 1..3000 m apart) and opacity (0..1)' }); return; }
  writeMeta(sn, { ...meta, placement });
  res.json({ sn, placement });
});

// DELETE /overlay/:sn — photo and placement.
droneOverlayRouter.delete('/:sn', (req, res) => {
  const sn = snOr400(req, res); if (!sn) return;
  const meta = readMeta(sn);
  if (meta) {
    const file = path.join(storageDir(), meta.file);
    if (existsSync(file)) { try { unlinkSync(file); } catch { /* best effort */ } }
    deviceSettingsRepo.remove(sn, SETTING_KEY);
  }
  res.json({ sn, removed: !!meta });
});
