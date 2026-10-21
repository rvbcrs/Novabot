import { describe, it, expect, vi, afterEach } from 'vitest';

import { ApiClient } from '../api';

/**
 * A failed map install blocks the re-anchor, and the app had no way to finish
 * it (LFIN1231000265, Oct 2026). The wizard's Retry installation button asks
 * the server to install its maps again: the route the map gate lets through
 * while an install is pending.
 */
describe('ApiClient.retryMapInstall', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('posts to the map apply route of that mower', async () => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await new ApiClient('https://example.invalid').retryMapInstall('LFIN1231000265');

    expect(calls).toEqual([{ url: 'https://example.invalid/api/dashboard/maps/LFIN1231000265/apply', method: 'POST' }]);
  });
});
