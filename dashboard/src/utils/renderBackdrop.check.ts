// Zelfcheck voor keyBackdrop.
// Draaien: node --experimental-strip-types dashboard/src/utils/renderBackdrop.check.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyBackdrop } from './renderBackdrop.ts';

/** 40×30 picture: a night-style gradient backdrop with a 20×10 island in it. */
function picture() {
  const w = 40, h = 30, px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const island = x >= 10 && x < 30 && y >= 10 && y < 20;
      // Backdrop drifts from (11,19,38) to (23,39,64), like a real night render.
      const t = x / (w - 1);
      const [r, g, b] = island
        ? (x === 10 ? [30, 45, 40] : [60, 140, 60]) // dark hedge on the island's left edge
        : [11 + 12 * t, 19 + 20 * t, 38 + 26 * t];
      px.set([r, g, b, 255], i);
    }
  }
  return { px, w, h };
}

test('keys out the whole gradient backdrop', () => {
  const { px, w, h } = picture();
  const { alpha } = keyBackdrop(px, w, h);
  assert.equal(alpha[0], 0);
  assert.equal(alpha[w - 1], 0);
  assert.equal(alpha[(h - 1) * w + w - 1], 0);
});

test('keeps the island, including its dark edge', () => {
  const { px, w, h } = picture();
  const { alpha, box } = keyBackdrop(px, w, h);
  assert.equal(alpha[15 * w + 20], 255);
  assert.ok(alpha[15 * w + 11] > 0, 'dark hedge next to the backdrop survives');
  // The one-pixel erosion trims the outer ring; the box is the island less it.
  assert.deepEqual(box, { x: 11, y: 11, w: 18, h: 8 });
});
