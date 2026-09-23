/**
 * The composite is what fixes the geometry: the image model copies the painted
 * shapes, so if the projection is wrong the render is wrong in a way no prompt
 * can repair. These tests pin the two things that can silently break it — the
 * mapping from local metres to pixels, and that every map type ends up on the
 * canvas — without touching the network or any image model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sharp from 'sharp';
import path from 'node:path';

vi.mock('../../routes/droneOverlay.js', () => ({ readMeta: () => null }));

import {
  applyHomography, checkView, compositeImage, compositePath, framingStatus, gardenBounds, invertHomography, isValidSn, readRenderMeta,
  renderFile, renderPath, solveHomography, stitchAndCrop, tiltCamera, warpComposite, TILT_W, TILT_H, type BaseImage,
} from '../../services/gardenRender.js';
import fs from 'node:fs';
import { mapRepo } from '../../db/repositories/index.js';
import { db } from '../../db/database.js';

const SN = 'LFIN_RENDER_TEST';
const CHARGER = { lat: 52.14, lng: 6.23 };

/** A flat white canvas with a linear lat/lng → pixel mapping, like a tile crop. */
async function fakeBase(width = 400, height = 400): Promise<BaseImage> {
  const span = 0.001; // degrees covered by the canvas, both axes
  return {
    png: await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer(),
    width, height, source: 'aerial', attribution: 'test',
    project: (p) => [
      ((p.lng - (CHARGER.lng - span / 2)) / span) * width,
      ((CHARGER.lat + span / 2 - p.lat) / span) * height,
    ],
  };
}

function seed(): void {
  mapRepo.setCalibration(SN, { charger_lat: CHARGER.lat, charger_lng: CHARGER.lng });
  mapRepo.create({
    map_id: `${SN}-w`, mower_sn: SN, map_name: 'map0', canonical_name: 'map0',
    file_name: 'map0_work.csv', map_type: 'work',
    map_area: JSON.stringify([{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }]),
  });
  mapRepo.create({
    map_id: `${SN}-o`, mower_sn: SN, map_name: 'map0_0_obstacle', canonical_name: 'map0_0_obstacle',
    file_name: 'map0_0_obstacle.csv', map_type: 'obstacle',
    map_area: JSON.stringify([{ x: 2, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 5 }, { x: 2, y: 5 }]),
  });
  mapRepo.create({
    map_id: `${SN}-u`, mower_sn: SN, map_name: 'map0tocharge_unicom', canonical_name: 'map0tocharge_unicom',
    file_name: 'map0tocharge_unicom.csv', map_type: 'unicom',
    map_area: JSON.stringify([{ x: 0, y: 0 }, { x: 1, y: 1 }]),
  });
}

/** Count pixels close to a colour, so we can assert "this got painted". */
async function countNear(png: Buffer, rgb: [number, number, number], tol = 40): Promise<number> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (Math.abs(data[i] - rgb[0]) < tol && Math.abs(data[i + 1] - rgb[1]) < tol && Math.abs(data[i + 2] - rgb[2]) < tol) n++;
  }
  return n;
}

beforeEach(() => {
  db.prepare('DELETE FROM maps WHERE mower_sn = ?').run(SN);
  db.prepare('DELETE FROM map_calibration WHERE mower_sn = ?').run(SN);
  seed();
});

describe('gardenBounds', () => {
  it('covers every polygon plus the margin, around the charger', () => {
    const b = gardenBounds(SN, 18)!;   // explicit margin; the default is tighter
    expect(b).not.toBeNull();
    // 10 m of polygon + 18 m of margin ≈ 28 m each way, well under 0.001 deg lat (~111 m).
    expect(b.ne.lat).toBeGreaterThan(CHARGER.lat);
    expect(b.sw.lat).toBeLessThan(CHARGER.lat);
    const northM = (b.ne.lat - CHARGER.lat) * 111132;
    expect(northM).toBeGreaterThan(25);
    expect(northM).toBeLessThan(35);
  });

  it('keeps the default margin tight, so the plot fills the render', () => {
    const wide = gardenBounds(SN, 18)!;
    const tight = gardenBounds(SN)!;
    expect(tight.ne.lat).toBeLessThan(wide.ne.lat);
    // Still some context around the 10 m polygon, just not a neighbourhood.
    expect((tight.ne.lat - CHARGER.lat) * 111132).toBeGreaterThan(15);
  });

  it('reports the same extent in local metres, for clients that draw in that frame', () => {
    const b = gardenBounds(SN, 5)!;
    // The seeded work polygon spans -10..10 in both axes.
    expect(b.localBox).toEqual({ minX: -15, maxX: 15, minY: -15, maxY: 15 });
    // And the corners agree with it: north-east is maxX/maxY.
    expect(b.ne.lat).toBeGreaterThan(b.sw.lat);
    expect(b.ne.lng).toBeGreaterThan(b.sw.lng);
  });

  it('takes a requested view as the rectangle, with a matching local box', () => {
    const view = { south: CHARGER.lat - 0.0002, west: CHARGER.lng - 0.0004, north: CHARGER.lat + 0.0002, east: CHARGER.lng + 0.0004 };
    const b = gardenBounds(SN, 9, view)!;
    expect(b.sw).toEqual({ lat: view.south, lng: view.west });
    // The dock pose of the seed is (0,0), so the box is symmetric around it.
    expect(b.localBox.minX).toBeCloseTo(-b.localBox.maxX, 6);
    expect(b.localBox.maxY).toBeCloseTo(0.0002 * 111_260, -1);
  });

  it('refuses a view that does not hold the garden or is too big', () => {
    const ok = { south: CHARGER.lat - 0.0002, west: CHARGER.lng - 0.0004, north: CHARGER.lat + 0.0002, east: CHARGER.lng + 0.0004 };
    expect(checkView(SN, ok)).toEqual(ok);
    expect(checkView(SN, { ...ok, south: CHARGER.lat + 0.0001 })).toBeUndefined();   // dock outside
    expect(checkView(SN, { ...ok, north: CHARGER.lat + 0.01 })).toBeUndefined();      // > 250 m
    expect(checkView(SN, { south: 'x' })).toBeUndefined();
  });

  it('returns null without a charger position', () => {
    db.prepare('DELETE FROM map_calibration WHERE mower_sn = ?').run(SN);
    expect(gardenBounds(SN)).toBeNull();
  });
});

describe('compositeImage', () => {
  it('paints the work polygon green and the obstacle red', async () => {
    const png = await compositeImage(SN, await fakeBase());
    // Green fill over white: the 0.58-alpha #6ebe50 lands near (166, 208, 150).
    expect(await countNear(png, [166, 208, 150])).toBeGreaterThan(500);
    expect(await countNear(png, [224, 30, 30])).toBeGreaterThan(50);
  });

  it('paints an obstacle in its own shape, not as a disc around it', async () => {
    // Big enough canvas that the 3x3 m square is drawn as itself. A disc of
    // half its side would leave the corners white.
    const base = await fakeBase(1600, 1600);
    const png = await compositeImage(SN, base);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const corner = base.project({ lat: CHARGER.lat + 4.8 / 111_320, lng: CHARGER.lng + 4.8 / (111_320 * Math.cos((CHARGER.lat * Math.PI) / 180)) });
    const i = (Math.round(corner[1]) * info.width + Math.round(corner[0])) * info.channels;
    expect(data[i]).toBeGreaterThan(150);
    expect(data[i + 1]).toBeLessThan(80);
  });

  it('puts the zone where the projection says, not in the corner', async () => {
    const base = await fakeBase();
    const png = await compositeImage(SN, base);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    // Just off-centre: inside the 20x20 m square but clear of the dock marker
    // that sits exactly on the charging pose.
    const [cr, cg, cb] = at(Math.round(base.width * 0.45), Math.round(base.height * 0.45));
    expect(cg).toBeGreaterThan(cr); expect(cg).toBeGreaterThan(cb);
    const [er, eg, eb] = at(5, 5);
    expect([er, eg, eb]).toEqual([255, 255, 255]);
  });

  it('refuses without a charger position rather than drawing at (0,0)', async () => {
    db.prepare('DELETE FROM map_calibration WHERE mower_sn = ?').run(SN);
    await expect(compositeImage(SN, await fakeBase())).rejects.toThrow(/charger GPS/);
  });
});

describe('stitchAndCrop', () => {
  it('cuts the box out of the pasted sheet, not the sheet out of the box', async () => {
    // Four 64 px tiles in distinct colours, then a box starting inside the
    // top-left tile. Its origin must show that tile, and its far corner the
    // bottom-right one; with the operations reordered, both come out wrong.
    const tile = (bg: string) => sharp({ create: { width: 64, height: 64, channels: 3, background: bg } }).png().toBuffer();
    const tiles = [
      { input: await tile('#ff0000'), left: 0, top: 0 }, { input: await tile('#00ff00'), left: 64, top: 0 },
      { input: await tile('#0000ff'), left: 0, top: 64 }, { input: await tile('#ffff00'), left: 64, top: 64 },
    ];
    const png = await stitchAndCrop(tiles, 128, 128, { left: 40, top: 40, width: 80, height: 80 });
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([80, 80]);
    const at = (x: number, y: number) => Array.from(data.slice((y * 80 + x) * info.channels, (y * 80 + x) * info.channels + 3));
    expect(at(0, 0)).toEqual([255, 0, 0]);       // sheet (40,40): red
    expect(at(79, 79)).toEqual([255, 255, 0]);   // sheet (119,119): yellow
    expect(at(79, 0)).toEqual([0, 255, 0]);      // sheet (119,40): green
  });
});

describe('tilt', () => {
  it('solves, applies and inverts a homography consistently', () => {
    const src = [[0, 0], [10, 0], [10, 8], [0, 8]] as const;
    const dst = [[2, 1], [13, 2], [12, 10], [1, 9]] as const;
    const h = solveHomography([...src], [...dst]);
    src.forEach((p, i) => {
      const [x, y] = applyHomography(h, p[0], p[1]);
      expect(x).toBeCloseTo(dst[i][0], 6); expect(y).toBeCloseTo(dst[i][1], 6);
    });
    const [u, v] = applyHomography(invertHomography(h), 7, 5.5);
    const [x, y] = applyHomography(h, u, v);
    expect(x).toBeCloseTo(7, 6); expect(y).toBeCloseTo(5.5, 6);
  });

  it('puts the far edge at the top, the plot inside the canvas, and a mark where it says', async () => {
    const W = 200, H = 160;
    const h = tiltCamera(W, H);
    const top = applyHomography(h, W / 2, 0); const bottom = applyHomography(h, W / 2, H);
    expect(top[1]).toBeLessThan(bottom[1]);
    // Perspective: the far (north) edge is shorter than the near one.
    const farW = applyHomography(h, W, 0)[0] - applyHomography(h, 0, 0)[0];
    const nearW = applyHomography(h, W, H)[0] - applyHomography(h, 0, H)[0];
    expect(farW).toBeLessThan(nearW);
    for (const [u, v] of [[0, 0], [W, 0], [W, H], [0, H]] as const) {
      const [x, y] = applyHomography(h, u, v);
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(TILT_W); expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(TILT_H);
    }
    // A red square on a white composite lands where the homography says.
    const src = await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
      .composite([{ input: await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ff0000' } }).png().toBuffer(), left: 60, top: 40 }])
      .png().toBuffer();
    const out = await warpComposite(src, W, H, h, [0, 0, 0]);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => Array.from(data.slice((Math.round(y) * info.width + Math.round(x)) * 3, (Math.round(y) * info.width + Math.round(x)) * 3 + 3));
    const [cx, cy] = applyHomography(h, 70, 50);   // centre of the square
    expect(px(cx, cy)).toEqual([255, 0, 0]);
    const [wx, wy] = applyHomography(h, 150, 120);  // plain composite
    expect(px(wx, wy)).toEqual([255, 255, 255]);
    expect(px(2, 2)).toEqual([0, 0, 0]);            // outside the plot: background
  });
});

describe('renders made before framings existed', () => {
  // One pair of pictures and a single meta.json, from before each framing had
  // its own files. They must stay visible under the framing that meta names
  // (angled, when it names none), and never show up as the other framing.
  // compositePath() creates the directory, so it is asked for per test: the
  // clean-up after each test removes it again.
  const rdir = () => path.dirname(compositePath(SN));
  afterEach(() => { fs.rmSync(rdir(), { recursive: true, force: true }); });

  it('keeps serving a legacy render as the framing it was', () => {
    const dir = rdir();
    // mapRows 2 while the seed has 3: the map changed since, so it is stale.
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ createdAt: 'x', source: 'aerial', attribution: 'a', mapRows: 2, variants: ['day', 'night'] }));
    fs.writeFileSync(path.join(dir, 'day.png'), 'png');
    expect(readRenderMeta(SN, 'iso')?.framing).toBe('iso');
    expect(readRenderMeta(SN, 'flat')).toBeNull();
    expect(renderFile(SN, 'day', 'iso')).toBe(path.join(dir, 'day.png'));
    expect(renderFile(SN, 'day', 'flat')).toBeNull();
    const st = framingStatus(SN);
    expect(st.iso?.stale).toBe(true);
    expect(st.flat).toBeNull();
  });

  it('prefers a framing\'s own files over the legacy pair', () => {
    const dir = rdir();
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ framing: 'flat', mapRows: 3, variants: ['day'] }));
    fs.writeFileSync(path.join(dir, 'day.png'), 'old');
    fs.writeFileSync(path.join(dir, 'day-flat.jpg'), 'new');
    expect(renderFile(SN, 'day', 'flat')).toBe(path.join(dir, 'day-flat.jpg'));
    expect(readRenderMeta(SN, 'iso')).toBeNull();
  });
});

describe('serial numbers reaching the filesystem', () => {
  it('refuses anything that could escape the storage directory', () => {
    for (const bad of ['../../etc', 'a/b', '..', 'sn.with.dots', '', 'x'.repeat(33)]) {
      expect(isValidSn(bad)).toBe(false);
      expect(readRenderMeta(bad, 'iso')).toBeNull();
      expect(() => renderPath(bad, 'day', 'flat')).toThrow(/invalid sn/);
      expect(() => compositePath(bad)).toThrow(/invalid sn/);
    }
    expect(isValidSn('LFIN1231000211')).toBe(true);
    // And a good one stays inside the renders directory.
    const root = path.resolve(process.env.STORAGE_PATH ?? './storage', 'renders');
    expect(compositePath('LFIN1231000211').startsWith(root + path.sep)).toBe(true);
  });
});
