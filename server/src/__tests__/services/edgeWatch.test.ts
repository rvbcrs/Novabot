import { describe, it, expect } from 'vitest';
import { advanceEdgeWatch, type EdgeWatchEntry } from '../../services/scheduleRunner.js';

const base: EdgeWatchEntry = { bladeHeightMm: 40, mapName: 'map0', armedAt: 1000, sawMowing: false };
// Gelijk aan EDGE_WATCH_TIMEOUT_MS in scheduleRunner.ts: ruim genoeg voor een
// maaibeurt met een tussentijdse laadpauze (maaien → dokken → laden → hervatten).
const TIMEOUT = 12 * 60 * 60 * 1000;

describe('advanceEdgeWatch', () => {
  it('markeert sawMowing zodra de maaier maait, vuurt nog niet', () => {
    const r = advanceEdgeWatch(base, 'mowing', 2000, TIMEOUT);
    expect(r.fire).toBe(false);
    expect(r.next?.sawMowing).toBe(true);
  });
  it('vuurt zodra de maaier na het maaien gaat laden', () => {
    const seen = { ...base, sawMowing: true };
    const r = advanceEdgeWatch(seen, 'charging', 3000, TIMEOUT);
    expect(r.fire).toBe(true);
    expect(r.next).toBeNull();
  });
  it('vuurt NIET bij laden als er nog geen maaien is gezien (was al gedockt)', () => {
    const r = advanceEdgeWatch(base, 'charging', 3000, TIMEOUT);
    expect(r.fire).toBe(false);
    expect(r.next?.sawMowing).toBe(false);
  });
  it('vervalt na de timeout zonder te vuren', () => {
    const seen = { ...base, sawMowing: true };
    const r = advanceEdgeWatch(seen, 'other', base.armedAt + TIMEOUT + 1, TIMEOUT);
    expect(r.fire).toBe(false);
    expect(r.next).toBeNull();
  });
  it("blijft wachten bij 'other' (laadpauze midden in de maaibeurt) zonder te vuren", () => {
    const seen = { ...base, sawMowing: true };
    const r = advanceEdgeWatch(seen, 'other', 4000, TIMEOUT);
    expect(r.fire).toBe(false);
    expect(r.next?.sawMowing).toBe(true);
  });
});
