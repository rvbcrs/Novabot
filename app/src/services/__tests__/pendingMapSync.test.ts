import { describe, it, expect } from 'vitest';
import { markPendingMapSync, hasPendingMapSync, flushPendingMapSync, type PendingStore } from '../pendingMapSync';

function memStore(): PendingStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
    async del(k) { data.delete(k); },
  };
}

describe('pendingMapSync', () => {
  it('niets te doen zonder vlag', async () => {
    const store = memStore();
    let sent = 0;
    expect(await flushPendingMapSync('LFIN1', async () => { sent++; return true; }, store)).toBe('nothing');
    expect(sent).toBe(0);
  });

  it('vlag blijft staan zolang de server/maaier niet bereikbaar is', async () => {
    const store = memStore();
    await markPendingMapSync('LFIN1', store);
    expect(await flushPendingMapSync('LFIN1', async () => false, store)).toBe('failed');
    expect(await hasPendingMapSync('LFIN1', store)).toBe(true);
    // Ook een exception (geen netwerk) mag de vlag niet wissen.
    expect(await flushPendingMapSync('LFIN1', async () => { throw new Error('offline'); }, store)).toBe('failed');
    expect(await hasPendingMapSync('LFIN1', store)).toBe(true);
  });

  it('vlag verdwijnt pas als de server het commando accepteert', async () => {
    const store = memStore();
    await markPendingMapSync('LFIN1', store);
    const sentTo: string[] = [];
    expect(await flushPendingMapSync('LFIN1', async (sn) => { sentTo.push(sn); return true; }, store)).toBe('synced');
    expect(sentTo).toEqual(['LFIN1']);
    expect(await hasPendingMapSync('LFIN1', store)).toBe(false);
    // Daarna is het klaar; geen dubbele uploads.
    expect(await flushPendingMapSync('LFIN1', async () => true, store)).toBe('nothing');
  });

  it('vlaggen zijn per maaier', async () => {
    const store = memStore();
    await markPendingMapSync('LFIN1', store);
    expect(await hasPendingMapSync('LFIN2', store)).toBe(false);
  });
});
