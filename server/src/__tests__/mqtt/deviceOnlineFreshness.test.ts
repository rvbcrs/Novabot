/**
 * Een device dat net verbonden is maar nog niets gepubliceerd heeft telde als
 * offline. Vlak na een serverherstart weigerde het dashboard daardoor het
 * wissen van een kaart terwijl de maaier gewoon online was (live 2026-09-11:
 * klik 1,4 s na CONNECT, 7 s na serverstart).
 */
import { describe, it, expect } from 'vitest';
import { hasFreshSignal } from '../../mqtt/broker.js';

const NOW = 1_000_000_000;
const STALE_MS = 90_000;

describe('hasFreshSignal', () => {
  it('nooit gezien = offline', () => {
    expect(hasFreshSignal(undefined, undefined, NOW)).toBe(false);
  });

  it('net verbonden zonder bericht = online', () => {
    expect(hasFreshSignal(undefined, NOW - 1_400, NOW)).toBe(true);
  });

  it('recent bericht = online, ook zonder connect-tijd', () => {
    expect(hasFreshSignal(NOW - 5_000, undefined, NOW)).toBe(true);
  });

  it('oude verbinding zonder berichten = offline', () => {
    expect(hasFreshSignal(undefined, NOW - STALE_MS - 1, NOW)).toBe(false);
  });

  it('oud bericht maar verse reconnect = online', () => {
    expect(hasFreshSignal(NOW - 10 * STALE_MS, NOW - 500, NOW)).toBe(true);
  });
});
