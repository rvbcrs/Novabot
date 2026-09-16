/**
 * Which patch of ground the mapping view draws (#116).
 *
 * The module is app code, but it is arithmetic with no React in it and the app
 * has no test runner, so it is checked from the server suite like the other
 * app utils. Getting this wrong means the user drives a boundary while looking
 * at the wrong piece of garden.
 */
import { describe, it, expect } from 'vitest';
import { mapWindow } from '../../../../app/src/utils/liveMapLayout.js';

const bounds = { minX: -30, minY: -20, maxX: 10, maxY: 12 };
const canvas = { width: 360, height: 240 };      // wider than tall, as on a phone
const mower = { x: 4, y: -3 };

describe('live map window', () => {
  it('fits everything when no zoom is asked for', () => {
    for (const r of [null, 0, -5]) {
      expect(mapWindow(bounds, canvas, mower, r))
        .toEqual({ minX: -30, minY: -20, width: 40, height: 32 });
    }
  });

  it('falls back to fitting when there is no mower to centre on', () => {
    expect(mapWindow(bounds, canvas, null, 8))
      .toEqual({ minX: -30, minY: -20, width: 40, height: 32 });
  });

  it('centres the window on the mower', () => {
    const w = mapWindow(bounds, canvas, mower, 8);
    expect(w.minX + w.width / 2).toBeCloseTo(mower.x, 9);
    expect(w.minY + w.height / 2).toBeCloseTo(mower.y, 9);
  });

  it('keeps a metre across the same size as a metre down', () => {
    // A square window on a 3:2 canvas would squash the drawing; the window has
    // to carry the canvas aspect so the scale comes out equal on both axes.
    const w = mapWindow(bounds, canvas, mower, 8);
    expect(w.width / w.height).toBeCloseTo(canvas.width / canvas.height, 9);
    const scaleX = canvas.width / w.width, scaleY = canvas.height / w.height;
    expect(scaleX).toBeCloseTo(scaleY, 9);
  });

  it('shows the asked-for distance on the short side, so the radius means something', () => {
    const wide = mapWindow(bounds, { width: 360, height: 240 }, mower, 8);
    expect(Math.min(wide.width, wide.height)).toBeCloseTo(8, 9);
    const tall = mapWindow(bounds, { width: 240, height: 360 }, mower, 8);
    expect(Math.min(tall.width, tall.height)).toBeCloseTo(8, 9);
    expect(tall.width / tall.height).toBeCloseTo(240 / 360, 9);
  });

  it('is independent of how far away the existing maps are', () => {
    const near = mapWindow({ minX: 3, minY: -4, maxX: 5, maxY: -2 }, canvas, mower, 8);
    const far = mapWindow({ minX: -900, minY: -900, maxX: 900, maxY: 900 }, canvas, mower, 8);
    expect(near).toEqual(far);
  });

  it('survives a zero-height canvas instead of dividing by it', () => {
    const w = mapWindow(bounds, { width: 300, height: 0 }, mower, 8);
    expect(Number.isFinite(w.width) && Number.isFinite(w.height)).toBe(true);
  });
});
