// Self-check for the re-anchor supervision pulse (GH #158).
// Run: node --experimental-strip-types dashboard/src/utils/reanchorPulse.check.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterPulse, pulseOutcome, REANCHOR_PULSE_MISS_LIMIT } from './reanchorPulse.ts';

test('only the server\'s own refusal ends the cycle', async () => {
  assert.equal(await pulseOutcome(async () => ({ ok: true })), 'ok');
  // reanchorAction returns the 409 body; apiFetch throws an ApiError for a firmware gate.
  assert.equal(await pulseOutcome(async () => ({ ok: false, error: 'Supervision expired.' })), 'refused');
  assert.equal(await pulseOutcome(async () => { throw Object.assign(new Error('unsupported firmware'), { status: 409 }); }), 'refused');
});

test('a lost request is unreachable, not a refusal', async () => {
  assert.equal(await pulseOutcome(async () => { throw new TypeError('Failed to fetch'); }), 'unreachable');
  // A proxy error page is not JSON.
  assert.equal(await pulseOutcome(async () => { throw new SyntaxError('Unexpected token <'); }), 'unreachable');
  assert.equal(await pulseOutcome(async () => ({}) as { ok?: boolean }), 'unreachable');
});

test('keeps the cycle through transport errors until the server window has certainly expired', () => {
  // The server stops after 5 s without a pulse; the wizard pulses every second.
  assert.equal(REANCHOR_PULSE_MISS_LIMIT, 6);
  let misses: number | null = 0;
  for (let i = 1; i < REANCHOR_PULSE_MISS_LIMIT; i++) {
    misses = afterPulse(misses!, 'unreachable');
    assert.equal(misses, i);
  }
  assert.equal(afterPulse(misses!, 'unreachable'), null);
});

test('an acknowledged pulse resets the count, a refusal drops at once', () => {
  assert.equal(afterPulse(REANCHOR_PULSE_MISS_LIMIT - 1, 'ok'), 0);
  assert.equal(afterPulse(0, 'refused'), null);
});
