/**
 * Drone overlay: upload, placement, serving and removal (#124).
 *
 * The router is mounted on its own express app here; the real one hangs off
 * dashboardRouter behind the LAN/auth gate, which has its own tests.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { droneOverlayRouter, parsePlacement, similarityCorners } from '../../routes/droneOverlay.js';
import { imageDimensions } from '../../services/imageDimensions.js';
import { db } from '../../db/database.js';
import { droneJpeg } from '../services/photoMetadata.test.js';

const SN = 'LFIN2230700238';
const storage = mkdtempSync(path.join(tmpdir(), 'overlay-'));
process.env.STORAGE_PATH = storage;
afterAll(() => rmSync(storage, { recursive: true, force: true }));

const app = express();
app.use(express.json());
app.use('/overlay', droneOverlayRouter);

/** A minimal but valid 3x2 PNG (IHDR only matters to us). */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12);
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}
/** SOI, then an SOF0 frame header declaring height x width. */
function jpeg(width: number, height: number): Buffer {
  const b = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  b.writeUInt16BE(height, 7); b.writeUInt16BE(width, 9);
  return b;
}

beforeEach(() => {
  db.prepare('DELETE FROM device_settings WHERE key = ?').run('drone_overlay');
  for (const f of readdirSync(storage)) rmSync(path.join(storage, f), { recursive: true, force: true });
});

describe('image header parsing', () => {
  it('reads PNG and JPEG sizes and refuses the rest', () => {
    expect(imageDimensions(png(4000, 3000))).toEqual({ width: 4000, height: 3000, mime: 'image/png' });
    expect(imageDimensions(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024, mime: 'image/jpeg' });
    expect(imageDimensions(Buffer.from('GIF89a'))).toBeNull();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();   // JPEG with no frame
    expect(imageDimensions(Buffer.alloc(0))).toBeNull();
  });
});

describe('placement validation', () => {
  const rect = similarityCorners({ lat: 52.14, lng: 6.23 }, 60, 0, 4 / 3);
  // metres east between two points, with cos(lat) at the photo's centre as the model uses it
  const east = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => (b.lng - a.lng) * 111_320 * Math.cos(52.14 * Math.PI / 180);

  it('lays a photo flat from centre, width and rotation', () => {
    // top edge 60 m east-west, left edge 45 m north-south, corners clockwise from top-left
    expect(east(rect[0], rect[1])).toBeCloseTo(60, 6);
    expect(rect[1].lat).toBeCloseTo(rect[0].lat, 12);
    expect((rect[0].lat - rect[3].lat) * 111_320).toBeCloseTo(45, 6);
    expect(rect[2].lng).toBeCloseTo(rect[1].lng, 12);
  });

  it('accepts a sane placement', () => {
    expect(parsePlacement({ corners: rect, opacity: 0.5 })).toEqual({ corners: rect, opacity: 0.5 });
    expect(parsePlacement({ corners: rect })?.opacity).toBe(0.8);
  });

  it('rejects nonsense', () => {
    expect(parsePlacement({ corners: rect.slice(0, 3) })).toBeNull();
    expect(parsePlacement({ corners: similarityCorners({ lat: 52, lng: 6 }, 5000, 0, 1) })).toBeNull();   // 7 km across
    expect(parsePlacement({ corners: similarityCorners({ lat: 52, lng: 6 }, 0.1, 0, 1) })).toBeNull();
    expect(parsePlacement({ corners: [{ lat: 95, lng: 6 }, ...rect.slice(1)] })).toBeNull();
    expect(parsePlacement({ corners: [{ lat: '52', lng: 6 }, ...rect.slice(1)] })).toBeNull();
    expect(parsePlacement({ corners: rect, opacity: 2 })).toBeNull();
    expect(parsePlacement({ lat: 52.14, lng: 6.23, widthM: 60 })).toBeNull();   // the first betas' shape is read, never written
    expect(parsePlacement(null)).toBeNull();
  });
});

describe('the overlay routes', () => {
  it('has nothing until a photo is uploaded', async () => {
    const r = await request(app).get(`/overlay/${SN}`);
    expect(r.status).toBe(404);
  });

  it('stores an upload, places it at the map centre, and serves it back', async () => {
    const up = await request(app).put(`/overlay/${SN}/image?lat=52.140889&lng=6.231036`)
      .set('Content-Type', 'image/jpeg').send(jpeg(4032, 3024));
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ sn: SN, width: 4032, height: 3024, mime: 'image/jpeg' });
    expect(up.body.placement).toEqual({ corners: similarityCorners({ lat: 52.140889, lng: 6.231036 }, 60, 0, 4032 / 3024), opacity: 0.8 });
    expect(up.body.file).toBeUndefined();          // disk layout is not the client's business
    expect(existsSync(path.join(storage, 'overlays', `${SN}.jpg`))).toBe(true);

    const meta = await request(app).get(`/overlay/${SN}`);
    expect(meta.status).toBe(200);
    expect(meta.body.width).toBe(4032);

    const img = await request(app).get(`/overlay/${SN}/image`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/jpeg');
  });

  it('places a drone photo from its own metadata, and says so', async () => {
    const up = await request(app).put(`/overlay/${SN}/image?lat=1&lng=1`).set('Content-Type', 'image/jpeg').send(droneJpeg(4000, 3000));
    expect(up.status).toBe(200);
    const c = up.body.placement.corners;
    expect((c[0].lat + c[2].lat) / 2).toBeCloseTo(52.140889, 7);        // the photo's GPS wins over the map centre
    expect((c[0].lng + c[2].lng) / 2).toBeCloseTo(6.231036, 7);
    expect(up.body.camera).toEqual({ lat: 52.140889, lng: 6.231036, altitudeM: 40, yawDeg: 17.3, pitchDeg: -90, focal35: 24, placedFromPhoto: true });
    // a replacement keeps the placement, so it no longer counts as placed from the photo
    const again = await request(app).put(`/overlay/${SN}/image`).set('Content-Type', 'image/jpeg').send(droneJpeg(4000, 3000));
    expect(again.body.placement).toEqual(up.body.placement);
    expect(again.body.camera.placedFromPhoto).toBe(false);
  });

  it('keeps the placement when the photo is replaced', async () => {
    await request(app).put(`/overlay/${SN}/image?lat=52&lng=6`).set('Content-Type', 'image/jpeg').send(jpeg(100, 50));
    const placed = { corners: similarityCorners({ lat: 52.1, lng: 6.2 }, 42, -15, 2), opacity: 0.6 };
    await request(app).put(`/overlay/${SN}`).send(placed);
    const again = await request(app).put(`/overlay/${SN}/image?lat=0&lng=0`).set('Content-Type', 'image/png').send(png(300, 200));
    expect(again.status).toBe(200);
    expect(again.body.placement).toEqual(placed);
    // The JPEG from before must not linger next to the PNG.
    expect(existsSync(path.join(storage, 'overlays', `${SN}.jpg`))).toBe(false);
    expect(existsSync(path.join(storage, 'overlays', `${SN}.png`))).toBe(true);
  });

  it('refuses a file that is not an image, and a placement without a photo', async () => {
    const bad = await request(app).put(`/overlay/${SN}/image`).set('Content-Type', 'application/octet-stream').send(Buffer.from('hello'));
    expect(bad.status).toBe(415);
    const noPhoto = await request(app).put(`/overlay/${SN}`).send({ corners: similarityCorners({ lat: 52, lng: 6 }, 60, 0, 1) });
    expect(noPhoto.status).toBe(404);
  });

  it('validates the placement', async () => {
    await request(app).put(`/overlay/${SN}/image`).set('Content-Type', 'image/png').send(png(10, 10));
    const r = await request(app).put(`/overlay/${SN}`).send({ corners: similarityCorners({ lat: 52, lng: 6 }, 9999, 0, 1) });
    expect(r.status).toBe(400);
  });

  it('reads a placement stored by the first betas as the rectangle it described', async () => {
    await request(app).put(`/overlay/${SN}/image`).set('Content-Type', 'image/png').send(png(400, 300));
    const row = db.prepare("SELECT value FROM device_settings WHERE sn = ? AND key = 'drone_overlay'").get(SN) as { value: string };
    const meta = JSON.parse(row.value);
    meta.placement = { lat: 52.1, lng: 6.2, widthM: 40, rotationDeg: 0, opacity: 0.7 };
    db.prepare("UPDATE device_settings SET value = ? WHERE sn = ? AND key = 'drone_overlay'").run(JSON.stringify(meta), SN);
    const r = await request(app).get(`/overlay/${SN}`);
    expect(r.body.placement).toEqual({ corners: similarityCorners({ lat: 52.1, lng: 6.2 }, 40, 0, 400 / 300), opacity: 0.7 });
  });

  it('removes photo and placement together', async () => {
    await request(app).put(`/overlay/${SN}/image?lat=52&lng=6`).set('Content-Type', 'image/png').send(png(10, 10));
    const del = await request(app).delete(`/overlay/${SN}`);
    expect(del.body).toEqual({ sn: SN, removed: true });
    expect(existsSync(path.join(storage, 'overlays', `${SN}.png`))).toBe(false);
    expect((await request(app).get(`/overlay/${SN}`)).status).toBe(404);
    expect((await request(app).delete(`/overlay/${SN}`)).body.removed).toBe(false);
  });

  it('copies photo and placement from another mower', async () => {
    await request(app).put(`/overlay/${SN}/image?lat=52.14&lng=6.23`).set('Content-Type', 'image/png').send(png(3, 2));
    const other = 'LFIN1231000211';
    const r = await request(app).post(`/overlay/${other}/copy-from/${SN}`);
    expect(r.status).toBe(200);
    expect(r.body.sn).toBe(other);
    expect(r.body.placement).toEqual((await request(app).get(`/overlay/${SN}`)).body.placement);
    expect(existsSync(path.join(storage, 'overlays', `${other}.png`))).toBe(true);
    // Source untouched, target independent from here on.
    await request(app).delete(`/overlay/${SN}`);
    expect((await request(app).get(`/overlay/${other}/image`)).status).toBe(200);
    // Nothing to copy, or copying onto itself.
    expect((await request(app).post(`/overlay/${other}/copy-from/LFIN9999999999`)).status).toBe(404);
    expect((await request(app).post(`/overlay/${other}/copy-from/${other}`)).status).toBe(400);
  });

  it('rejects a bad serial', async () => {
    expect((await request(app).get('/overlay/x')).status).toBe(400);
  });
});
