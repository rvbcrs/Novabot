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
import { droneOverlayRouter, parsePlacement } from '../../routes/droneOverlay.js';
import { imageDimensions } from '../../services/imageDimensions.js';
import { db } from '../../db/database.js';

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
  it('accepts a sane placement and normalises the angle', () => {
    expect(parsePlacement({ lat: 52.14, lng: 6.23, widthM: 60, rotationDeg: 370, opacity: 0.5 }))
      .toEqual({ lat: 52.14, lng: 6.23, widthM: 60, rotationDeg: 10, opacity: 0.5 });
  });
  it('rejects nonsense', () => {
    expect(parsePlacement({ lat: 52, lng: 6, widthM: 0 })).toBeNull();
    expect(parsePlacement({ lat: 52, lng: 6, widthM: 5000 })).toBeNull();
    expect(parsePlacement({ lat: 95, lng: 6, widthM: 60 })).toBeNull();
    expect(parsePlacement({ lat: 52, lng: 6, widthM: 60, opacity: 2 })).toBeNull();
    expect(parsePlacement({ lat: '52', lng: 6, widthM: 60 })).toBeNull();
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
    expect(up.body.placement).toMatchObject({ lat: 52.140889, lng: 6.231036, widthM: 60, rotationDeg: 0 });
    expect(up.body.file).toBeUndefined();          // disk layout is not the client's business
    expect(existsSync(path.join(storage, 'overlays', `${SN}.jpg`))).toBe(true);

    const meta = await request(app).get(`/overlay/${SN}`);
    expect(meta.status).toBe(200);
    expect(meta.body.width).toBe(4032);

    const img = await request(app).get(`/overlay/${SN}/image`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/jpeg');
  });

  it('keeps the placement when the photo is replaced', async () => {
    await request(app).put(`/overlay/${SN}/image?lat=52&lng=6`).set('Content-Type', 'image/jpeg').send(jpeg(100, 50));
    await request(app).put(`/overlay/${SN}`).send({ lat: 52.1, lng: 6.2, widthM: 42, rotationDeg: -15, opacity: 0.6 });
    const again = await request(app).put(`/overlay/${SN}/image?lat=0&lng=0`).set('Content-Type', 'image/png').send(png(300, 200));
    expect(again.status).toBe(200);
    expect(again.body.placement).toMatchObject({ lat: 52.1, lng: 6.2, widthM: 42, rotationDeg: -15 });
    // The JPEG from before must not linger next to the PNG.
    expect(existsSync(path.join(storage, 'overlays', `${SN}.jpg`))).toBe(false);
    expect(existsSync(path.join(storage, 'overlays', `${SN}.png`))).toBe(true);
  });

  it('refuses a file that is not an image, and a placement without a photo', async () => {
    const bad = await request(app).put(`/overlay/${SN}/image`).set('Content-Type', 'application/octet-stream').send(Buffer.from('hello'));
    expect(bad.status).toBe(415);
    const noPhoto = await request(app).put(`/overlay/${SN}`).send({ lat: 52, lng: 6, widthM: 60 });
    expect(noPhoto.status).toBe(404);
  });

  it('validates the placement', async () => {
    await request(app).put(`/overlay/${SN}/image`).set('Content-Type', 'image/png').send(png(10, 10));
    const r = await request(app).put(`/overlay/${SN}`).send({ lat: 52, lng: 6, widthM: 9999 });
    expect(r.status).toBe(400);
  });

  it('removes photo and placement together', async () => {
    await request(app).put(`/overlay/${SN}/image?lat=52&lng=6`).set('Content-Type', 'image/png').send(png(10, 10));
    const del = await request(app).delete(`/overlay/${SN}`);
    expect(del.body).toEqual({ sn: SN, removed: true });
    expect(existsSync(path.join(storage, 'overlays', `${SN}.png`))).toBe(false);
    expect((await request(app).get(`/overlay/${SN}`)).status).toBe(404);
    expect((await request(app).delete(`/overlay/${SN}`)).body.removed).toBe(false);
  });

  it('rejects a bad serial', async () => {
    expect((await request(app).get('/overlay/x')).status).toBe(400);
  });
});
