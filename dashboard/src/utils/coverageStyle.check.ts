// Zelfcheck voor coverageLaneStrokes: 2D-kaart en 3D-render kleuren een
// maaibaan met dezelfde regels.
// Draaien: node --experimental-strip-types dashboard/src/utils/coverageStyle.check.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageLaneStrokes, GREEN, YELLOW, PENDING, PREVIEW } from './coverageStyle.ts';

const live = { live: true, stale: false };

test('afgemaaide baan: één dikke groene lijn', () => {
  assert.deepEqual(coverageLaneStrokes({ ...live, finished: true, active: false, activePoints: 0 }), [{ ...GREEN, upTo: null }]);
});

test('actieve baan: geel over de hele baan, groen tot het huidige punt', () => {
  assert.deepEqual(coverageLaneStrokes({ ...live, finished: false, active: true, activePoints: 7 }), [
    { ...YELLOW, upTo: null },
    { ...GREEN, upTo: 7 },
  ]);
});

test('actieve baan zonder voortgang: alleen geel', () => {
  assert.deepEqual(coverageLaneStrokes({ ...live, finished: false, active: true, activePoints: 1 }), [{ ...YELLOW, upTo: null }]);
});

test('nog niet gemaaid tijdens een sessie: dunne lichte lijn', () => {
  assert.deepEqual(coverageLaneStrokes({ ...live, finished: false, active: false, activePoints: 0 }), [{ ...PENDING, upTo: null }]);
});

test('statische preview (geen sessie): cyaan, ook als de sensoren nog oude voortgang hebben', () => {
  assert.deepEqual(coverageLaneStrokes({ live: false, stale: false, finished: true, active: true, activePoints: 9 }), [{ ...PREVIEW, upTo: null }]);
});

test('onderdrukte (verouderde) voortgang tijdens een sessie: geen groen of geel', () => {
  assert.deepEqual(coverageLaneStrokes({ live: true, stale: true, finished: true, active: true, activePoints: 9 }), [{ ...PENDING, upTo: null }]);
});
