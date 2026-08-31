import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient } from '../api';

/**
 * Een hangende server mag de UI niet gijzelen: zonder timeout blijft de
 * login-spinner eeuwig draaien zonder ooit een foutmelding te tonen.
 */
describe('ApiClient request timeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('geeft een foutmelding als de server niet antwoordt', async () => {
    vi.useFakeTimers();
    // Server die nooit antwoordt: resolvet alleen als het abort-signaal afgaat.
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }));

    const api = new ApiClient('https://example.invalid');
    const pending = api.healthCheck();
    const assertion = expect(pending).rejects.toThrow(/did not respond within/);
    await vi.advanceTimersByTimeAsync(21_000);
    await assertion;
  });

  it('laat een normaal antwoord ongemoeid', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ server: 'ok', mqtt: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const api = new ApiClient('https://example.invalid');
    await expect(api.healthCheck()).resolves.toEqual({ server: 'ok', mqtt: 'ok' });
  });
});
