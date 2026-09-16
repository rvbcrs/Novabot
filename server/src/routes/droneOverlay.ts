/**
 * Drone photo as map backdrop (#124).
 *
 * The open aerial imagery is rectified against a terrain model, so anything
 * with height leans away from the nadir point, and the hedge someone traces
 * sits a metre from where it stands. A consumer drone shoots straight down at
 * a centimetre or two per pixel. This lets a user put that photo under the
 * map: one image per mower, stored on disk, placed by hand (centre, width in
 * metres, rotation), drawn below the polygons as a tracing aid and nothing
 * more. It never feeds a coordinate into a map.
 *
 * Mounted on dashboardRouter, so it sits behind the same LAN/auth gate.
 */
import { Router, type Request, type Response } from 'express';
import express from 'express';
import path from 'path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { deviceSettingsRepo } from '../db/repositories/index.js';
import { imageDimensions } from '../services/imageDimensions.js';

export const droneOverlayRouter = Router();

const SN_RE = /^[A-Za-z0-9_-]{4,32}$/;
const SETTING_KEY = 'drone_overlay';
/** One garden fits in a few metres to a few hundred; anything else is a typo. */
const WIDTH_M = { min: 1, max: 2000 };

export interface OverlayPlacement {
  lat: number;
  lng: number;
  /** Ground width of the image in metres; height follows the pixel aspect. */
  widthM: number;
  rotationDeg: number;
  opacity: number;
}

export interface OverlayMeta {
  file: string;
  width: number;
  height: number;
  mime: 'image/jpeg' | 'image/png';
  size: number;
  updatedAt: string;
  placement: OverlayPlacement | null;
}

function storageDir(): string {
  return path.resolve(process.env.STORAGE_PATH ?? './storage', 'overlays');
}

export function readMeta(sn: string): OverlayMeta | null {
  const row = deviceSettingsRepo.findBySn(sn).find(r => r.key === SETTING_KEY);
  if (!row?.value) return null;
  try { return JSON.parse(row.value) as OverlayMeta; } catch { return null; }
}

function writeMeta(sn: string, meta: OverlayMeta): void {
  deviceSettingsRepo.upsert(sn, SETTING_KEY, JSON.stringify(meta));
}

/** Validate a placement from the client; null when any field is out of range. */
export function parsePlacement(body: unknown): OverlayPlacement | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const lat = num(b.lat), lng = num(b.lng), widthM = num(b.widthM);
  const rotationDeg = b.rotationDeg === undefined ? 0 : num(b.rotationDeg);
  const opacity = b.opacity === undefined ? 0.8 : num(b.opacity);
  if ([lat, lng, widthM, rotationDeg, opacity].some(Number.isNaN)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (widthM < WIDTH_M.min || widthM > WIDTH_M.max) return null;
  if (opacity < 0 || opacity > 1) return null;
  // Normalise the angle so the slider and the stored value agree.
  const rot = ((rotationDeg + 180) % 360 + 360) % 360 - 180;
  return { lat, lng, widthM, rotationDeg: rot, opacity };
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

// PUT /overlay/:sn/image — raw JPEG or PNG body. Optional ?lat=&lng= gives the
// first placement (map centre at upload time, 60 m wide) so the photo is
// visible before anyone has dragged it.
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
    const placement = previous?.placement
      ?? (Number.isFinite(lat) && Number.isFinite(lng)
        ? parsePlacement({ lat, lng, widthM: 60, rotationDeg: 0, opacity: 0.8 })
        : null);
    const meta: OverlayMeta = {
      file, width: dims.width, height: dims.height, mime: dims.mime, size: buf.length,
      updatedAt: new Date().toISOString(), placement,
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
  if (!placement) { res.status(400).json({ error: 'placement needs lat, lng, widthM (1..2000 m), rotationDeg, opacity (0..1)' }); return; }
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
