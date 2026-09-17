import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewMapIdsFromCanonicals } from './mqtt.ts';

test('previewMapIdsFromCanonicals maps arbitrary map slots to decimal mask digits', () => {
  assert.equal(previewMapIdsFromCanonicals(['map0']), 1);
  assert.equal(previewMapIdsFromCanonicals(['map3']), 1000);
  assert.equal(previewMapIdsFromCanonicals(['map6']), 1000000);
});

test('previewMapIdsFromCanonicals preserves multi-map positional semantics', () => {
  assert.equal(previewMapIdsFromCanonicals(['map0', 'map2', 'map4']), 10101);
  assert.equal(previewMapIdsFromCanonicals(['map2', 'map2', 'map0']), 101);
});

test('previewMapIdsFromCanonicals ignores non-work names and keeps map0 fallback', () => {
  assert.equal(previewMapIdsFromCanonicals(['unicom0', 'work-area']), 1);
});
