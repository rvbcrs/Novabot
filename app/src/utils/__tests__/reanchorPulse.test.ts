import { describe, it, expect } from 'vitest';
import { afterPulse, pulseOutcome, REANCHOR_PULSE_MISS_LIMIT } from '../reanchorPulse';

// GH #158: one failed pulse dropped supervision for good, so the server
// stopped a healthy re-anchor five seconds later.
describe('re-anchor supervision pulse', () => {
  it('reads only the server\'s own refusal as the end of the cycle', async () => {
    expect(await pulseOutcome(async () => ({ ok: true }))).toBe('ok');
    // ApiClient.request throws on a 409 instead of returning the body.
    expect(await pulseOutcome(async () => { throw new Error('HTTP 409: {"ok":false,"error":"Supervision expired."}'); })).toBe('refused');
    expect(await pulseOutcome(async () => { throw Object.assign(new Error('unsupported firmware'), { status: 409 }); })).toBe('refused');
    expect(await pulseOutcome(async () => ({ ok: false }))).toBe('refused');
  });

  it('treats a lost request as unreachable, not as a refusal', async () => {
    expect(await pulseOutcome(async () => { throw new TypeError('Network request failed'); })).toBe('unreachable');
    expect(await pulseOutcome(async () => { throw new Error('Server did not respond within 20s (http://x)'); })).toBe('unreachable');
    expect(await pulseOutcome(async () => { throw new Error('HTTP 502: Bad Gateway'); })).toBe('unreachable');
    expect(await pulseOutcome(async () => ({}) as { ok?: boolean })).toBe('unreachable');
  });

  it('keeps the cycle through transport errors until the server window has certainly expired', () => {
    // The server stops after 5 s without a pulse; the wizard pulses every second.
    expect(REANCHOR_PULSE_MISS_LIMIT).toBe(6);
    let misses: number | null = 0;
    for (let i = 1; i < REANCHOR_PULSE_MISS_LIMIT; i++) {
      misses = afterPulse(misses!, 'unreachable');
      expect(misses).toBe(i);
    }
    expect(afterPulse(misses!, 'unreachable')).toBeNull();
  });

  it('starts counting again after an acknowledged pulse', () => {
    expect(afterPulse(REANCHOR_PULSE_MISS_LIMIT - 1, 'ok')).toBe(0);
    expect(afterPulse(0, 'unreachable')).toBe(1);
  });

  it('drops the cycle at once when the server refuses', () => {
    expect(afterPulse(0, 'refused')).toBeNull();
  });
});
