import { describe, it, expect } from 'vitest';
import { advanceEdgeWatch, type EdgeWatchEntry } from '../../services/scheduleRunner.js';

const base: EdgeWatchEntry = {
  scheduleId: 'sched-1', bladeHeightMm: 40, mapName: 'map0', armedAt: 1000, sawMowing: false,
};
// Gelijk aan EDGE_WATCH_TIMEOUT_MS in scheduleRunner.ts: ruim genoeg voor een
// maaibeurt met een tussentijdse laadpauze (maaien → dokken → laden → hervatten).
const TIMEOUT = 12 * 60 * 60 * 1000;
// Gelijk aan EDGE_MOW_START_WINDOW_MS in scheduleRunner.ts: de gearmde beurt
// moet binnen dit venster als 'mowing' zijn waargenomen, anders vervalt de arm.
const WINDOW = 30 * 60 * 1000;

describe('advanceEdgeWatch', () => {
  it('markeert sawMowing zodra de maaier maait, vuurt nog niet', () => {
    const r = advanceEdgeWatch(base, 'mowing', 2000, TIMEOUT, WINDOW);
    expect(r.fire).toBe(false);
    expect(r.next?.sawMowing).toBe(true);
  });
  it('vuurt zodra de maaier na het maaien gaat laden', () => {
    const seen = { ...base, sawMowing: true };
    const r = advanceEdgeWatch(seen, 'charging', 3000, TIMEOUT, WINDOW);
    expect(r.fire).toBe(true);
    expect(r.next).toBeNull();
  });
  it('vuurt NIET bij laden als er nog geen maaien is gezien (was al gedockt)', () => {
    const r = advanceEdgeWatch(base, 'charging', 3000, TIMEOUT, WINDOW);
    expect(r.fire).toBe(false);
    expect(r.next?.sawMowing).toBe(false);
  });
  it('vervalt na de timeout zonder te vuren', () => {
    const seen = { ...base, sawMowing: true };
    const r = advanceEdgeWatch(seen, 'other', base.armedAt + TIMEOUT + 1, TIMEOUT, WINDOW);
    expect(r.fire).toBe(false);
    expect(r.next).toBeNull();
  });
  // De timeout-check MOET vóór de vuur-check staan. Zonder die volgorde zou een
  // watcher die uren geleden is gearmd alsnog vuren zodra de maaier toevallig
  // gaat laden (bijvoorbeeld na een handmatige beurt 's avonds): een spookstart
  // van een echt bewegingscommando, uren na de maaibeurt waar hij bij hoorde.
  it('vuurt NIET als de entry zowel verlopen is als zou vuren (timeout gaat voor)', () => {
    const seen = { ...base, sawMowing: true };
    const r = advanceEdgeWatch(seen, 'charging', base.armedAt + TIMEOUT + 1, TIMEOUT, WINDOW);
    expect(r.fire).toBe(false);
    expect(r.next).toBeNull();
  });

  it("blijft wachten bij 'other' (laadpauze midden in de maaibeurt) zonder te vuren", () => {
    const seen = { ...base, sawMowing: true };
    const r = advanceEdgeWatch(seen, 'other', 4000, TIMEOUT, WINDOW);
    expect(r.fire).toBe(false);
    expect(r.next?.sawMowing).toBe(true);
  });

  // ── Identiteit van de run (finding 4, whole-branch review) ────────────────

  // Startvenster: is er binnen het venster geen maaien gezien, dan is de
  // gearmde beurt nooit begonnen. De arm vervalt — óók (juist!) wanneer de
  // eerste 'mowing'-waarneming pas ná het venster komt: dat is per definitie
  // een andere (handmatige) beurt en die mag de arm niet adopteren. Zonder
  // deze regel vuurde een ochtend-arm van een stil mislukte beurt 's avonds
  // een randmaai af op de handmatige beurt van de gebruiker: verkeerde zone,
  // verkeerde hoogte, zonder toezicht.
  it('vervalt zonder maaien binnen het startvenster (fase other)', () => {
    const r = advanceEdgeWatch(base, 'other', base.armedAt + WINDOW + 1, TIMEOUT, WINDOW);
    expect(r.fire).toBe(false);
    expect(r.next).toBeNull();
  });
  it('adopteert GEEN maaien dat pas na het startvenster begint', () => {
    const r = advanceEdgeWatch(base, 'mowing', base.armedAt + WINDOW + 1, TIMEOUT, WINDOW);
    expect(r.fire).toBe(false);
    expect(r.next).toBeNull();
  });
  it('vuurt NIET op laden na het startvenster zonder gezien maaien', () => {
    const r = advanceEdgeWatch(base, 'charging', base.armedAt + WINDOW + 1, TIMEOUT, WINDOW);
    expect(r.fire).toBe(false);
    expect(r.next).toBeNull();
  });
  it('maaien binnen het venster gezien → arm overleeft het venster (laadpauze-scenario)', () => {
    const seen = { ...base, sawMowing: true };
    const r = advanceEdgeWatch(seen, 'other', base.armedAt + WINDOW + 1, TIMEOUT, WINDOW);
    expect(r.fire).toBe(false);
    expect(r.next?.sawMowing).toBe(true);
  });

  // 'aborted' = de beurt is definitief afgebroken (gebruikersstop,
  // tijdslimiet, fout). Ná gezien maaien ontwapent dat de arm: de beurt waar
  // hij bij hoorde bestaat niet meer, dus een latere handmatige beurt mag geen
  // randmaai meer uitlokken.
  it("ontwapent op 'aborted' nadat maaien is gezien, zonder te vuren", () => {
    const seen = { ...base, sawMowing: true };
    const r = advanceEdgeWatch(seen, 'aborted', 5000, TIMEOUT, WINDOW);
    expect(r.fire).toBe(false);
    expect(r.next).toBeNull();
  });
  // Vóór gezien maaien wordt 'aborted' genegeerd: een verouderde stopcode van
  // gisteren hangt vaak nog in de sensor-cache op het moment van armen; die
  // mag een verse arm niet direct doden. Loopt de nieuwe beurt echt niet, dan
  // ruimt het startvenster de arm alsnog op.
  it("negeert 'aborted' vóór er maaien is gezien (verouderde stopcode in cache)", () => {
    const r = advanceEdgeWatch(base, 'aborted', 5000, TIMEOUT, WINDOW);
    expect(r.fire).toBe(false);
    expect(r.next).toEqual(base);
  });
});
