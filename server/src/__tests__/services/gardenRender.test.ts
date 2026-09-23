/**
 * The composite is what fixes the geometry: the image model copies the painted
 * shapes, so if the projection is wrong the render is wrong in a way no prompt
 * can repair. These tests pin the two things that can silently break it — the
 * mapping from local metres to pixels, and that every map type ends up on the
 * canvas — without touching the network or any image model.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import sharp from 'sharp';
import path from 'node:path';

vi.mock('../../routes/droneOverlay.js', () => ({ readMeta: () => null }));

import { compositeImage, compositePath, gardenBounds, isValidSn, readRenderMeta, renderPath, type BaseImage } from '../../services/gardenRender.js';
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

  it('returns null without a charger position', () => {
    db.prepare('DELETE FROM map_calibration WHERE mower_sn = ?').run(SN);
    expect(gardenBounds(SN)).toBeNull();
  });
});

describe('compositeImage', () => {
  it('paints the work polygon green and the obstacle as a red disc', async () => {
    const png = await compositeImage(SN, await fakeBase());
    // Green fill over white: the 0.58-alpha #6ebe50 lands near (166, 208, 150).
    expect(await countNear(png, [166, 208, 150])).toBeGreaterThan(500);
    expect(await countNear(png, [224, 30, 30])).toBeGreaterThan(50);
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

describe('serial numbers reaching the filesystem', () => {
  it('refuses anything that could escape the storage directory', () => {
    for (const bad of ['../../etc', 'a/b', '..', 'sn.with.dots', '', 'x'.repeat(33)]) {
      expect(isValidSn(bad)).toBe(false);
      expect(readRenderMeta(bad)).toBeNull();
      expect(() => renderPath(bad, 'day')).toThrow(/invalid sn/);
      expect(() => compositePath(bad)).toThrow(/invalid sn/);
    }
    expect(isValidSn('LFIN1231000211')).toBe(true);
    // And a good one stays inside the renders directory.
    const root = path.resolve(process.env.STORAGE_PATH ?? './storage', 'renders');
    expect(compositePath('LFIN1231000211').startsWith(root + path.sep)).toBe(true);
  });
});
