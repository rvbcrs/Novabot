// Zelfcheck voor mapApplyView en de Error-140-uitzondering in deriveHasError.
// Draaien: node --experimental-strip-types dashboard/src/utils/mapApply.check.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapApplyView } from './mapApply.ts';
import { deriveHasError } from './mowerActivity.ts';

test('geen status = niets aan de hand', () => {
  assert.deepEqual(mapApplyView({}), { state: 'idle' });
  assert.deepEqual(mapApplyView({ map_apply_phase: '' }), { state: 'idle' });
});

test('de drie stappen, genummerd', () => {
  assert.deepEqual(mapApplyView({ map_apply_phase: 'syncing' }), { state: 'busy', phase: 'syncing', step: 1 });
  assert.deepEqual(mapApplyView({ map_apply_phase: 'regenerating' }), { state: 'busy', phase: 'regenerating', step: 2 });
  assert.deepEqual(mapApplyView({ map_apply_phase: 'settling' }), { state: 'busy', phase: 'settling', step: 3 });
});

test('mislukt, met reden', () => {
  assert.deepEqual(mapApplyView({ map_apply_phase: 'failed', map_apply_error: 'sync_timeout' }), { state: 'failed', error: 'sync_timeout' });
});

test('onbekende fase telt niet als bezig', () => {
  assert.deepEqual(mapApplyView({ map_apply_phase: 'whatever' }), { state: 'idle' });
});

test('Error 140 tijdens onze eigen push is geen blokkerende fout, daarbuiten wel', () => {
  assert.equal(deriveHasError({ error_status: '140', map_apply_phase: 'settling' }), false);
  assert.equal(deriveHasError({ error_status: 'Error (140)', map_apply_phase: 'regenerating' }), false);
  assert.equal(deriveHasError({ error_status: '140' }), true);
  assert.equal(deriveHasError({ error_status: '140', map_apply_phase: 'failed' }), true);
});

test('een andere fout blijft blokkeren, ook tijdens de push', () => {
  assert.equal(deriveHasError({ error_status: '151', map_apply_phase: 'settling' }), true);
});
