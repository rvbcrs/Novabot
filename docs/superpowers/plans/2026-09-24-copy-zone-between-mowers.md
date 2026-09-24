# Zone kopiëren tussen maaiers — implementatieplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** een werkgebied (plus obstakels) van maaier A in het dashboard op de kaart van maaier B plaatsen, met een automatisch dock- of tussenkanaal waar dat veilig kan, zodat B de zone maait zonder opnieuw te mappen.

**Architecture:** een pure service (`zoneCopy.ts`) doet de translatie op basis van één fysieke correspondentie (waar A's laadstation op B's kaart staat) en beslist over kanalen; twee dunne routes in `dashboard.ts` hangen die service aan de bestaande "getekende zone"-flow (DB-rij met `source: 'drawn'` → `autoPushMapsInBackground`). Het dashboard krijgt een paneel met een sleepbare marker en een gestippelde preview, en hergebruikt daarna de bestaande kanaal-prompt.

**Tech Stack:** Node/TypeScript (Express, better-sqlite3, vitest + supertest) in `server/`; React + react-leaflet + i18next in `dashboard/`.

**Spec:** `docs/superpowers/specs/2026-09-24-copy-zone-between-mowers-design.md` — lees die eerst; dit plan verwijst ernaar voor het "waarom".

## Global Constraints

- Transformatie is **zuivere translatie**: `p_B = p_A − dockA_in_A + dockA_in_B`, rotatie 0. Nooit pos.json, live GPS of `map_calibration` van de andere maaier gebruiken (spec §Feiten 2).
- Knoppen, exact: `DOCK_MAX_M = 3`, `LINK_MAX_M = 1.5`, `STEP_M = 0.25`, `MAX_SLOT = 4`, `MAX_DOCK_DISTANCE_M = 500`.
- Nieuwe DB-rijen krijgen `source: 'drawn'` (bestaande `MapSource`-union, geen nieuwe waarde).
- Kanaalconventie: rij 1 van `mapNtocharge_unicom` is het dock; tussenkanaal heet `mapKtomapN_<i>_unicom` met K de bestaande zone.
- De server tekent **nooit** een tussenkanaal langer dan `LINK_MAX_M` (trap-incident, `docs/reference/COSTMAP-UNICOM-NAV.md`).
- Elke nieuwe servertekst (`T\`...\`` en `M\`...\``) krijgt een entry in `server/src/services/apiText.catalog.ts` (nl-sleutel met `{0}`,`{1}` voor interpolaties; en/fr/de), anders faalt `serverText.coverage.test.ts`.
- Dashboard-teksten in alle vier locale-bestanden (`nl.json`, `en.json`, `de.json`, `fr.json`) onder `map.*`. Geen `window.alert`/`confirm`.
- Commit-berichten in het Engels, **zonder** Co-Authored-By of andere AI-attributie.
- Firmware-gate: routes weigeren op stock firmware via het bestaande `rejectUnlessOpenNova`.

## Review Focus

1. Bronpolygoon met dubbele opeenvolgende punten (lengte-0 randen) mag `nearestBoundaryPoint` niet laten delen door nul → test in Task 1.
2. Dock exact op de rand van de kopie → dockkanaal van 2 identieke punten, geen crash, geen lege CSV → test in Task 2.
3. `map_area` van de bron met een `null`-coördinaat (JSON.stringify van NaN) → punt wordt weggelaten, kopie slaagt → test in Task 3.
4. Achtergebleven `map0tocharge_unicom`-rij op B bij slot 0 → vervangen, nooit een dubbele rij → test in Task 3.
5. Body zonder `dockAtB` → 400 `bad_dock`, geen rij geschreven → test in Task 4.

---

### Task 1: Geometrie-helpers en de pure kern van `zoneCopy.ts`

**Files:**
- Modify: `server/src/maps/editGeometry.ts:121` (`segIntersects` exporteren)
- Modify: `server/src/services/canonicalNaming.ts` (`WorkSlot`, `workSlots`, `distanceToPolygon`, `dockPoint`, `nextChannelIndex` exporteren)
- Create: `server/src/services/zoneCopy.ts`
- Test: `server/src/__tests__/services/zoneCopy.test.ts`

**Interfaces:**
- Consumes: `pointInPolygon(p, poly)`, `segIntersects(a,b,c,d)` uit `maps/editGeometry.ts`; `XY = { x: number; y: number }`.
- Produces: `transformPoints(pts: XY[], dockAInA: XY, dockAInB: XY): XY[]`, `nearestBoundaryPoint(p: XY, poly: XY[]): { point: XY; dist: number }`, `polygonsOverlap(a: XY[], b: XY[]): boolean`, `polygonGap(a: XY[], b: XY[]): { dist: number; onA: XY; onB: XY }`, `segmentCrossesPolygon(p: XY, q: XY, poly: XY[]): boolean`, `straightChannel(from: XY, to: XY, step?: number): XY[]`, constanten `DOCK_MAX_M`, `LINK_MAX_M`, `STEP_M`, `MAX_SLOT`.

- [ ] **Step 1: Exporteer de privé-helpers**

In `server/src/maps/editGeometry.ts` regel 121: `function segIntersects(` → `export function segIntersects(`.

In `server/src/services/canonicalNaming.ts`: `interface WorkSlot {` → `export interface WorkSlot {`; `function workSlots(` → `export function workSlots(`; `function distanceToPolygon(` → `export function distanceToPolygon(`; `function dockPoint(` → `export function dockPoint(`; `function nextChannelIndex(` → `export function nextChannelIndex(`. Verder niets wijzigen.

- [ ] **Step 2: Schrijf de falende test**

`server/src/__tests__/services/zoneCopy.test.ts`:

```ts
/**
 * Zone kopiëren tussen maaiers: geometrie en regels.
 * Spec: docs/superpowers/specs/2026-09-24-copy-zone-between-mowers-design.md
 */
import { describe, it, expect } from 'vitest';
import {
  transformPoints, nearestBoundaryPoint, polygonsOverlap, polygonGap, segmentCrossesPolygon, straightChannel, STEP_M,
} from '../../services/zoneCopy.js';

export const square = (x0: number, y0: number, size = 10) => [
  { x: x0, y: y0 }, { x: x0 + size, y: y0 }, { x: x0 + size, y: y0 + size }, { x: x0, y: y0 + size },
];
export const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

describe('zoneCopy geometrie', () => {
  it('transformPoints: gelijk dock = identiteit, anders zuivere verschuiving', () => {
    const pts = square(0, 0);
    expect(transformPoints(pts, { x: 1, y: 2 }, { x: 1, y: 2 })).toEqual(pts);
    const [p] = transformPoints([{ x: 0, y: 0 }], { x: 0.03, y: 0.73 }, { x: 11.2, y: 18.3 });
    expect(p.x).toBeCloseTo(11.17, 6);
    expect(p.y).toBeCloseTo(17.57, 6);
  });

  it('nearestBoundaryPoint: vanaf buiten en vanaf binnen naar de rand', () => {
    const sq = square(0, 0);
    const out = nearestBoundaryPoint({ x: 15, y: 5 }, sq);
    expect(out.dist).toBeCloseTo(5, 6);
    expect(out.point).toEqual({ x: 10, y: 5 });
    const inside = nearestBoundaryPoint({ x: 1, y: 5 }, sq);
    expect(inside.dist).toBeCloseTo(1, 6);
    expect(inside.point).toEqual({ x: 0, y: 5 });
  });

  it('nearestBoundaryPoint: dubbele opeenvolgende punten (lengte-0 rand) breken niets', () => {
    const poly = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const r = nearestBoundaryPoint({ x: -1, y: 0 }, poly);
    expect(r.dist).toBeCloseTo(1, 6);
    expect(Number.isFinite(r.point.x) && Number.isFinite(r.point.y)).toBe(true);
  });

  it('polygonsOverlap: los, hoekpunt binnen, en kruisend zonder hoekpunt binnen', () => {
    expect(polygonsOverlap(square(0, 0), square(20, 0))).toBe(false);
    expect(polygonsOverlap(square(0, 0), square(5, 5))).toBe(true);
    const horiz = rect(-10, 4, 10, 6);
    const vert = rect(4, -10, 6, 10);
    expect(polygonsOverlap(horiz, vert)).toBe(true);
  });

  it('polygonGap: 0 bij overlap, anders afstand met randpunten aan beide kanten', () => {
    expect(polygonGap(square(0, 0), square(5, 5)).dist).toBe(0);
    const g = polygonGap(square(0, 0), square(11, 0));
    expect(g.dist).toBeCloseTo(1, 6);
    expect(g.onA.x).toBeCloseTo(10, 6);
    expect(g.onB.x).toBeCloseTo(11, 6);
  });

  it('segmentCrossesPolygon: kruisend, erlangs, en volledig erbinnen', () => {
    const sq = square(0, 0);
    expect(segmentCrossesPolygon({ x: -5, y: 5 }, { x: 15, y: 5 }, sq)).toBe(true);
    expect(segmentCrossesPolygon({ x: -5, y: 15 }, { x: 15, y: 15 }, sq)).toBe(false);
    expect(segmentCrossesPolygon({ x: 2, y: 2 }, { x: 8, y: 8 }, sq)).toBe(true);
  });

  it('straightChannel: begint bij from, eindigt bij to, stappen van hoogstens STEP_M', () => {
    const pts = straightChannel({ x: 0, y: 0 }, { x: 0, y: 1 });
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 0, y: 1 });
    expect(pts).toHaveLength(5);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)).toBeLessThanOrEqual(STEP_M + 1e-9);
    }
    expect(straightChannel({ x: 3, y: 3 }, { x: 3, y: 3 })).toEqual([{ x: 3, y: 3 }, { x: 3, y: 3 }]);
  });
});
```

- [ ] **Step 3: Draai de test, verwacht falen**

Run: `cd server && npx vitest run src/__tests__/services/zoneCopy.test.ts`
Expected: FAIL met "Failed to resolve import" / "Cannot find module '../../services/zoneCopy.js'".

- [ ] **Step 4: Schrijf `server/src/services/zoneCopy.ts` (deel 1: geometrie)**

```ts
/**
 * Zone kopiëren van maaier A naar maaier B.
 * Spec: docs/superpowers/specs/2026-09-24-copy-zone-between-mowers-design.md
 *
 * Twee maaiers delen geen absoluut GPS-frame: elke charger zendt zijn eigen
 * zelf-ingemeten RTK-basispositie uit (live 23 m verschil tussen .244 en
 * .100). De enige betrouwbare koppeling is één fysieke correspondentie, waar
 * het laadstation van A staat in B's frame, met rotatie 0 (beide ENU).
 */
import { pointInPolygon, polygonContains, segIntersects, type XY } from '../maps/editGeometry.js';

/** ponytail: knop. Max afstand dock→zone voor een gegenereerd dockkanaal. */
export const DOCK_MAX_M = 3;
/** ponytail: knop. Max opening tussen twee zones voor een voorgesteld tussenkanaal. */
export const LINK_MAX_M = 1.5;
/** Puntafstand in een gegenereerd kanaal. */
export const STEP_M = 0.25;
/** Firmware-cap: map0..map4 (memory multi-map-limit). */
export const MAX_SLOT = 4;

/** Zuivere translatie: p_B = p_A − dockA_in_A + dockA_in_B. */
export function transformPoints(pts: XY[], dockAInA: XY, dockAInB: XY): XY[] {
  const dx = dockAInB.x - dockAInA.x;
  const dy = dockAInB.y - dockAInA.y;
  return pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
}

/** Dichtstbijzijnde punt op de RAND van poly, gezien vanaf p (ook als p erbinnen ligt). */
export function nearestBoundaryPoint(p: XY, poly: XY[]): { point: XY; dist: number } {
  let best = { point: poly[0], dist: Infinity };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.dist) best = { point: q, dist: d };
  }
  return best;
}

/** Raken/overlappen: een hoekpunt in de ander, of snijdende randen. */
export function polygonsOverlap(a: XY[], b: XY[]): boolean {
  if (a.some(p => pointInPolygon(p, b)) || b.some(p => pointInPolygon(p, a))) return true;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segIntersects(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

/**
 * Kortste opening tussen twee polygonen: 0 bij overlap. Voor niet-overlappende
 * polygonen ligt het minimum altijd op een hoekpunt van de een en de rand van
 * de ander, dus hoekpunt→rand in beide richtingen volstaat.
 */
export function polygonGap(a: XY[], b: XY[]): { dist: number; onA: XY; onB: XY } {
  if (polygonsOverlap(a, b)) return { dist: 0, onA: a[0], onB: b[0] };
  let best = { dist: Infinity, onA: a[0], onB: b[0] };
  for (const p of a) {
    const n = nearestBoundaryPoint(p, b);
    if (n.dist < best.dist) best = { dist: n.dist, onA: p, onB: n.point };
  }
  for (const p of b) {
    const n = nearestBoundaryPoint(p, a);
    if (n.dist < best.dist) best = { dist: n.dist, onA: n.point, onB: p };
  }
  return best;
}

/** Lijnstuk p→q kruist de rand van poly, of ligt er helemaal in. */
export function segmentCrossesPolygon(p: XY, q: XY, poly: XY[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (segIntersects(p, q, poly[i], poly[(i + 1) % poly.length])) return true;
  }
  return pointInPolygon(p, poly) && pointInPolygon(q, poly);
}

/** Rechte lijn from→to, verdicht per step; `from` is altijd rij 1 (firmware: dock eerst). */
export function straightChannel(from: XY, to: XY, step: number = STEP_M): XY[] {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(1, Math.ceil(len / step));
  const out: XY[] = [];
  for (let i = 0; i <= n; i++) {
    out.push({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
  }
  return out;
}

// polygonContains wordt in deel 2 (planZoneCopy) gebruikt; import staat er alvast.
void polygonContains;
```

- [ ] **Step 5: Draai de test, verwacht slagen**

Run: `cd server && npx vitest run src/__tests__/services/zoneCopy.test.ts`
Expected: PASS (7 tests). Draai ook `npx vitest run src/__tests__/services/canonicalNaming.test.ts` om te zien dat de exports niets braken.

- [ ] **Step 6: Commit**

```bash
git add server/src/maps/editGeometry.ts server/src/services/canonicalNaming.ts server/src/services/zoneCopy.ts server/src/__tests__/services/zoneCopy.test.ts
git commit -m "feat(zone-copy): geometry helpers for copying a zone between mowers"
```

---

### Task 2: `planZoneCopy` — de plaatsings- en kanaalregels

**Files:**
- Modify: `server/src/services/zoneCopy.ts` (deel 2 toevoegen, `void polygonContains;` verwijderen)
- Modify: `server/src/__tests__/services/zoneCopy.test.ts`

**Interfaces:**
- Consumes: Task 1-helpers; `distanceToPolygon(p, poly)` uit `canonicalNaming.ts`; `polygonContains(outer, inner)` uit `editGeometry.ts`.
- Produces:

```ts
export interface ExistingZone { slot: number; canonical: string; points: XY[]; obstacles: XY[][] }
export type ChannelKind = 'dock' | 'link';
export interface ChannelPlan { canonical: string; kind: ChannelKind; points: XY[]; replaces: boolean }
export type CopyRefusal = 'slot_limit' | 'target_no_dock' | 'too_far_from_dock' | 'dock_channel_blocked';
export type CopyWarning = 'full_overlap' | 'existing_zones_unlinked';
export interface PlanInput {
  slot: number; work: XY[]; obstacles: XY[][]; existing: ExistingZone[]; dock: XY | null;
  dockChannelRowExists: boolean; linkIndex: (from: number, to: number) => number;
}
export interface CopyPlan {
  ok: boolean; refusal?: CopyRefusal; slot: number; canonical: string; work: XY[];
  obstacles: { canonical: string; points: XY[] }[]; channels: ChannelPlan[];
  connectedVia: string | null; needsChannel: boolean; warnings: CopyWarning[]; dockDistanceM: number | null;
}
export function planZoneCopy(i: PlanInput): CopyPlan
```

- [ ] **Step 1: Schrijf de falende tests**

Voeg toe aan `zoneCopy.test.ts` (imports uitbreiden met `planZoneCopy, DOCK_MAX_M, MAX_SLOT, type PlanInput`):

```ts
describe('planZoneCopy', () => {
  const zone = (slot: number, points: ReturnType<typeof square>, obstacles: ReturnType<typeof square>[] = []) =>
    ({ slot, canonical: `map${slot}`, points, obstacles });
  const input = (over: Partial<PlanInput>): PlanInput => ({
    slot: 0, work: square(0, 0), obstacles: [], existing: [], dock: { x: 5, y: 5 },
    dockChannelRowExists: false, linkIndex: () => 0, ...over,
  });

  it('slot 0, dock in de zone: kort dockkanaal met het dock als rij 1, geen kanaal nodig', () => {
    const p = planZoneCopy(input({ dock: { x: 1, y: 5 } }));
    expect(p.ok).toBe(true);
    expect(p.canonical).toBe('map0');
    expect(p.channels).toHaveLength(1);
    expect(p.channels[0]).toMatchObject({ canonical: 'map0tocharge_unicom', kind: 'dock', replaces: false });
    expect(p.channels[0].points[0]).toEqual({ x: 1, y: 5 });
    expect(p.channels[0].points.at(-1)).toEqual({ x: 0, y: 5 });
    expect(p.needsChannel).toBe(false);
    expect(p.dockDistanceM).toBe(0);
  });

  it('slot 0, dock exact op de rand: dockkanaal van twee gelijke punten', () => {
    const p = planZoneCopy(input({ dock: { x: 0, y: 5 } }));
    expect(p.ok).toBe(true);
    expect(p.channels[0].points).toEqual([{ x: 0, y: 5 }, { x: 0, y: 5 }]);
  });

  it('slot 0, dock 2 m buiten de zone: dockkanaal van 2 m', () => {
    const p = planZoneCopy(input({ dock: { x: 12, y: 5 } }));
    expect(p.ok).toBe(true);
    expect(p.dockDistanceM).toBeCloseTo(2, 6);
    expect(p.channels[0].points.at(-1)).toEqual({ x: 10, y: 5 });
  });

  it('slot 0, dock verder dan DOCK_MAX_M: weigering too_far_from_dock', () => {
    const p = planZoneCopy(input({ dock: { x: 10 + DOCK_MAX_M + 0.5, y: 5 } }));
    expect(p).toMatchObject({ ok: false, refusal: 'too_far_from_dock', channels: [] });
  });

  it('slot 0, dockkanaal door een gekopieerd obstakel: weigering dock_channel_blocked', () => {
    // Dock (5,3) → dichtstbijzijnde rand (5,0); obstakel x 4..6, y 1..2 ligt op die lijn.
    const p = planZoneCopy(input({ dock: { x: 5, y: 3 }, obstacles: [rect(4, 1, 6, 2)] }));
    expect(p).toMatchObject({ ok: false, refusal: 'dock_channel_blocked' });
  });

  it('slot 1, kopie overlapt map0: geen kanaal, verbonden via map0', () => {
    const p = planZoneCopy(input({ slot: 1, work: square(5, 0), existing: [zone(0, square(0, 0))], dock: { x: 1, y: 1 } }));
    expect(p).toMatchObject({ ok: true, canonical: 'map1', connectedVia: 'map0', channels: [], needsChannel: false, warnings: [] });
  });

  it('slot 1, kopie omsluit map0 volledig: verbonden, met waarschuwing full_overlap', () => {
    const p = planZoneCopy(input({ slot: 1, work: square(-10, -10, 30), existing: [zone(0, square(0, 0))], dock: { x: 1, y: 1 } }));
    expect(p).toMatchObject({ ok: true, connectedVia: 'map0', warnings: ['full_overlap'] });
  });

  it('slot 1, opening van 1 m naar map0: tussenkanaal met randpunten aan beide kanten', () => {
    const p = planZoneCopy(input({ slot: 1, work: square(11, 0), existing: [zone(0, square(0, 0))], dock: { x: 1, y: 1 }, linkIndex: () => 2 }));
    expect(p.ok).toBe(true);
    expect(p.connectedVia).toBeNull();
    expect(p.channels).toHaveLength(1);
    expect(p.channels[0]).toMatchObject({ canonical: 'map0tomap1_2_unicom', kind: 'link' });
    expect(p.channels[0].points[0].x).toBeCloseTo(10, 6);
    expect(p.channels[0].points.at(-1)!.x).toBeCloseTo(11, 6);
    expect(p.needsChannel).toBe(false);
  });

  it('slot 1, opening > LINK_MAX_M maar dock dichtbij: dockkanaal als terugval + waarschuwing', () => {
    const p = planZoneCopy(input({ slot: 1, work: square(20, 0), existing: [zone(0, square(0, 0))], dock: { x: 18, y: 5 } }));
    expect(p.ok).toBe(true);
    expect(p.channels.map(c => c.canonical)).toEqual(['map1tocharge_unicom']);
    expect(p.warnings).toEqual(['existing_zones_unlinked']);
    expect(p.needsChannel).toBe(false);
  });

  it('slot 1, opening > LINK_MAX_M en dock ver weg: geen kanaal, prompt nodig', () => {
    const p = planZoneCopy(input({ slot: 1, work: square(20, 0), existing: [zone(0, square(0, 0))], dock: { x: 1, y: 1 } }));
    expect(p).toMatchObject({ ok: true, channels: [], needsChannel: true });
  });

  it('slot 1, tussenkanaal door een obstakel in de opening: geen voorstel, doorvallen', () => {
    const p = planZoneCopy(input({ slot: 1, work: square(11, 0), existing: [zone(0, square(0, 0), [rect(10.2, -1, 10.8, 1)])], dock: { x: 1, y: 1 } }));
    expect(p).toMatchObject({ ok: true, channels: [], needsChannel: true });
  });

  it('slot 0 met een verweesde map3 (na cascade-delete): dockkanaal én tussenkanaal', () => {
    const p = planZoneCopy(input({ slot: 0, work: square(0, 0), existing: [zone(3, square(-11, 0))], dock: { x: 1, y: 5 } }));
    expect(p.ok).toBe(true);
    expect(p.channels.map(c => c.canonical)).toEqual(['map0tocharge_unicom', 'map3tomap0_0_unicom']);
    expect(p.warnings).toEqual([]);
  });

  it('obstakels worden hernummerd naar het nieuwe slot', () => {
    const p = planZoneCopy(input({ slot: 2, obstacles: [square(1, 1, 2), square(6, 6, 2)], dock: { x: 1, y: 5 } }));
    expect(p.obstacles.map(o => o.canonical)).toEqual(['map2_0_obstacle', 'map2_1_obstacle']);
  });

  it('slot boven de firmware-cap: weigering slot_limit', () => {
    expect(planZoneCopy(input({ slot: MAX_SLOT + 1 })).refusal).toBe('slot_limit');
  });

  it('zonder dock op B: weigering target_no_dock', () => {
    expect(planZoneCopy(input({ dock: null })).refusal).toBe('target_no_dock');
  });

  it('bestaande map0tocharge_unicom-rij wordt gemarkeerd als te vervangen', () => {
    const p = planZoneCopy(input({ dock: { x: 1, y: 5 }, dockChannelRowExists: true }));
    expect(p.channels[0].replaces).toBe(true);
  });
});
```

- [ ] **Step 2: Draai de tests, verwacht falen**

Run: `cd server && npx vitest run src/__tests__/services/zoneCopy.test.ts`
Expected: FAIL met "planZoneCopy is not a function" (of "does not provide an export named").

- [ ] **Step 3: Voeg `planZoneCopy` toe aan `zoneCopy.ts`**

Verwijder de regel `void polygonContains;` en voeg onderaan toe; voeg bovenin de import `import { distanceToPolygon } from './canonicalNaming.js';` toe:

```ts
// ── Regels ────────────────────────────────────────────────────────────────

export interface ExistingZone { slot: number; canonical: string; points: XY[]; obstacles: XY[][] }
export type ChannelKind = 'dock' | 'link';
export interface ChannelPlan {
  canonical: string;
  kind: ChannelKind;
  points: XY[];
  /** Er bestaat al een rij met deze canonieke naam op B; die wordt vervangen. */
  replaces: boolean;
}
export type CopyRefusal = 'slot_limit' | 'target_no_dock' | 'too_far_from_dock' | 'dock_channel_blocked';
export type CopyWarning = 'full_overlap' | 'existing_zones_unlinked';

export interface PlanInput {
  slot: number;
  /** Getransformeerd naar B's frame. */
  work: XY[];
  obstacles: XY[][];
  /** B's bestaande werkgebieden met hun obstakels. */
  existing: ExistingZone[];
  /** B's dock (anker of live pose). */
  dock: XY | null;
  /** Bestaat er al een rij `map<slot>tocharge_unicom` op B (achtergebleven)? */
  dockChannelRowExists: boolean;
  /** Eerste vrije index voor mapAtomapB_K_unicom. */
  linkIndex: (from: number, to: number) => number;
}

export interface CopyPlan {
  ok: boolean;
  refusal?: CopyRefusal;
  slot: number;
  canonical: string;
  work: XY[];
  obstacles: { canonical: string; points: XY[] }[];
  channels: ChannelPlan[];
  connectedVia: string | null;
  needsChannel: boolean;
  warnings: CopyWarning[];
  dockDistanceM: number | null;
}

/**
 * Spec §Plaatsings- en kanaalregels. Stap 1: verbinding met bestaande zones
 * (overlap = klaar, opening ≤ LINK_MAX_M = voorstel). Stap 2: dockkanaal,
 * verplicht voor slot 0 (het is ook het anker), anders alleen als stap 1
 * niets opleverde. Nooit een lange lijn tussen zones (trap-incident).
 */
export function planZoneCopy(i: PlanInput): CopyPlan {
  const canonical = `map${i.slot}`;
  const obstacles = i.obstacles.map((points, k) => ({ canonical: `map${i.slot}_${k}_obstacle`, points }));
  const base: CopyPlan = {
    ok: false, slot: i.slot, canonical, work: i.work, obstacles,
    channels: [], connectedVia: null, needsChannel: false, warnings: [], dockDistanceM: null,
  };
  if (i.slot > MAX_SLOT) return { ...base, refusal: 'slot_limit' };
  if (!i.dock) return { ...base, refusal: 'target_no_dock' };
  const dock = i.dock;
  const dockDistanceM = distanceToPolygon(dock, i.work);
  const warnings: CopyWarning[] = [];

  // Stap 1: bestaande zones.
  let connectedVia: string | null = null;
  let link: ChannelPlan | null = null;
  let nearest: { zone: ExistingZone; gap: ReturnType<typeof polygonGap> } | null = null;
  for (const z of i.existing) {
    const gap = polygonGap(z.points, i.work);
    if (gap.dist === 0) {
      connectedVia = z.canonical;
      if (polygonContains(i.work, z.points) || polygonContains(z.points, i.work)) warnings.push('full_overlap');
      break;
    }
    if (!nearest || gap.dist < nearest.gap.dist) nearest = { zone: z, gap };
  }
  if (!connectedVia && nearest && nearest.gap.dist <= LINK_MAX_M) {
    const { zone, gap } = nearest;
    const blocked = [...zone.obstacles, ...i.obstacles].some(o => segmentCrossesPolygon(gap.onA, gap.onB, o));
    if (!blocked) {
      link = {
        canonical: `map${zone.slot}tomap${i.slot}_${i.linkIndex(zone.slot, i.slot)}_unicom`,
        kind: 'link',
        points: straightChannel(gap.onA, gap.onB),
        replaces: false,
      };
    }
  }

  // Stap 2: dockkanaal.
  let dockChannel: ChannelPlan | null = null;
  const wantDock = i.slot === 0 || (!connectedVia && !link);
  if (wantDock && dockDistanceM <= DOCK_MAX_M) {
    const to = nearestBoundaryPoint(dock, i.work).point;
    if (i.obstacles.some(o => segmentCrossesPolygon(dock, to, o))) {
      if (i.slot === 0) return { ...base, refusal: 'dock_channel_blocked', dockDistanceM };
    } else {
      dockChannel = {
        canonical: `map${i.slot}tocharge_unicom`,
        kind: 'dock',
        points: straightChannel(dock, to),
        replaces: i.dockChannelRowExists,
      };
    }
  } else if (wantDock && i.slot === 0) {
    return { ...base, refusal: 'too_far_from_dock', dockDistanceM };
  }

  const channels = [...(dockChannel ? [dockChannel] : []), ...(link ? [link] : [])];
  if (dockChannel && i.existing.length > 0 && !connectedVia && !link) warnings.push('existing_zones_unlinked');
  return {
    ...base, ok: true, channels, connectedVia,
    needsChannel: !connectedVia && channels.length === 0,
    warnings, dockDistanceM,
  };
}
```

- [ ] **Step 4: Draai de tests, verwacht slagen**

Run: `cd server && npx vitest run src/__tests__/services/zoneCopy.test.ts`
Expected: PASS (23 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/zoneCopy.ts server/src/__tests__/services/zoneCopy.test.ts
git commit -m "feat(zone-copy): placement and channel rules for a copied zone"
```

---

### Task 3: `previewZoneCopy` en `persistZoneCopy` (DB-orkestratie)

**Files:**
- Modify: `server/src/services/zoneCopy.ts` (deel 3)
- Modify: `server/src/__tests__/services/zoneCopy.test.ts`

**Interfaces:**
- Consumes: `mapRepo` (`findBySnAndCanonical`, `findAllByMowerSnAndType`, `create`, `deleteByIdAndMower`, `findByMowerSn`), `db.transaction`, `getPolygonAnchor(sn)` (`services/anchor.ts`), `getDockPose(sn)` (`mqtt/sensorData.ts`), `dockPoint`, `workSlots`, `nextFreeWorkSlot`, `nextChannelIndex` (`canonicalNaming.ts`), `polygonArea`, `MIN_WORK_AREA_M2` (`editGeometry.ts`), `translator`/`Translate` (`serverText.ts`).
- Produces:

```ts
export const MAX_DOCK_DISTANCE_M = 500;
export interface PreviewOk { ok: true; plan: CopyPlan; sourceAlias: string | null; areaM2: number }
export interface PreviewFail { ok: false; status: 400 | 404 | 409; reason: 'bad_canonical' | 'source_not_found' | 'source_no_anchor' | 'bad_dock' | 'dock_too_far' | 'target_no_dock' | 'too_small'; error: string }
export type PreviewResult = PreviewOk | PreviewFail;
export function previewZoneCopy(targetSn: string, sourceSn: string, sourceCanonical: string, dockAtB: { x?: unknown; y?: unknown } | undefined, opts?: { withObstacles?: boolean }, T?: Translate): PreviewResult
export interface PersistResult { mapId: string; createdAt: string; mapMaxMin: { minX: number; maxX: number; minY: number; maxY: number }; channels: string[]; obstacles: string[] }
export function persistZoneCopy(targetSn: string, plan: CopyPlan, opts: { alias: string | null; acceptChannel: boolean }): PersistResult
```

- [ ] **Step 1: Schrijf de falende tests**

Bovenaan `zoneCopy.test.ts`, vóór de service-import, de sensor-mock (zelfde patroon als `canonicalNaming.test.ts`), en de extra imports:

```ts
import { vi, beforeEach } from 'vitest';
vi.mock('../../mqtt/sensorData.js', () => ({
  getDockPose: vi.fn().mockReturnValue(null),
}));
import { mapRepo } from '../../db/repositories/index.js';
import { getDockPose } from '../../mqtt/sensorData.js';
import { previewZoneCopy, persistZoneCopy, MAX_DOCK_DISTANCE_M } from '../../services/zoneCopy.js';
```

En het nieuwe describe-blok:

```ts
describe('previewZoneCopy / persistZoneCopy (in-memory DB)', () => {
  const A = 'LFIN_COPY_SRC';
  const B = 'LFIN_COPY_DST';
  const addRow = (sn: string, canonical: string, type: 'work' | 'obstacle' | 'unicom', pts: unknown[], alias: string | null = null) =>
    mapRepo.create({ map_id: `${sn}-${canonical}`, mower_sn: sn, map_name: alias, map_type: type, map_area: JSON.stringify(pts), canonical_name: canonical });
  const dockA = { x: 0.03, y: 0.73 };
  const dockB = { x: 0.1, y: -0.5 };

  beforeEach(() => {
    for (const sn of [A, B]) for (const m of mapRepo.findByMowerSn(sn)) mapRepo.deleteById(m.map_id);
    vi.mocked(getDockPose).mockReturnValue(null);
    // A: 10x10 zone met het dock erin, één obstakel, dockkanaal (rij 1 = dock).
    addRow(A, 'map0', 'work', square(0, 0), 'Grote tuin');
    addRow(A, 'map0_0_obstacle', 'obstacle', square(2, 2, 2));
    addRow(A, 'map0tocharge_unicom', 'unicom', [dockA, { x: -0.4, y: 0.94 }]);
    // B: alleen een (achtergebleven) dockkanaal; geen werkgebieden.
    addRow(B, 'map0tocharge_unicom', 'unicom', [dockB, { x: 0.3, y: -0.8 }]);
  });

  it('transformeert zone + obstakel naar B, slot 0, dockkanaal vervangt de oude rij, alias komt mee', () => {
    const r = previewZoneCopy(B, A, 'map0', dockB);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sourceAlias).toBe('Grote tuin');
    expect(r.areaM2).toBeCloseTo(100, 6);
    expect(r.plan.ok).toBe(true);
    expect(r.plan.canonical).toBe('map0');
    expect(r.plan.work[0].x).toBeCloseTo(dockB.x - dockA.x, 6);
    expect(r.plan.work[0].y).toBeCloseTo(dockB.y - dockA.y, 6);
    expect(r.plan.obstacles).toHaveLength(1);
    expect(r.plan.obstacles[0].canonical).toBe('map0_0_obstacle');
    expect(r.plan.obstacles[0].points[0].x).toBeCloseTo(2 + dockB.x - dockA.x, 6);
    expect(r.plan.channels[0]).toMatchObject({ canonical: 'map0tocharge_unicom', kind: 'dock', replaces: true });
    expect(r.plan.channels[0].points[0]).toEqual(dockB);
  });

  it('withObstacles=false laat de obstakels weg', () => {
    const r = previewZoneCopy(B, A, 'map0', dockB, { withObstacles: false });
    expect(r.ok && r.plan.obstacles).toEqual([]);
  });

  it('een null-coördinaat in de bron wordt weggelaten, de kopie slaagt', () => {
    for (const m of mapRepo.findByMowerSn(A)) if (m.canonical_name === 'map0') mapRepo.deleteById(m.map_id);
    addRow(A, 'map0', 'work', [...square(0, 0), { x: null, y: 3 }], 'Grote tuin');
    const r = previewZoneCopy(B, A, 'map0', dockB);
    expect(r.ok && r.plan.work).toHaveLength(4);
  });

  it('zonder alias (map_name == canonical) is sourceAlias null', () => {
    for (const m of mapRepo.findByMowerSn(A)) if (m.canonical_name === 'map0') mapRepo.deleteById(m.map_id);
    addRow(A, 'map0', 'work', square(0, 0), 'map0');
    const r = previewZoneCopy(B, A, 'map0', dockB);
    expect(r.ok && r.sourceAlias).toBeNull();
  });

  it('bron zonder anker en niet gedockt: 409 source_no_anchor; gedockt live: anker uit getDockPose', () => {
    for (const m of mapRepo.findByMowerSn(A)) if (m.map_type === 'unicom') mapRepo.deleteById(m.map_id);
    expect(previewZoneCopy(B, A, 'map0', dockB)).toMatchObject({ ok: false, status: 409, reason: 'source_no_anchor' });
    vi.mocked(getDockPose).mockImplementation(sn => (sn === A ? { x: 1, y: 2, orientation: 0, capturedAt: 0 } : null));
    const r = previewZoneCopy(B, A, 'map0', dockB);
    expect(r.ok && r.plan.work[0].x).toBeCloseTo(dockB.x - 1, 6);
  });

  it('invoerfouten: canonical, onbekende zone, dock, te ver, geen dock op B', () => {
    expect(previewZoneCopy(B, A, 'map0tocharge_unicom', dockB)).toMatchObject({ ok: false, status: 400, reason: 'bad_canonical' });
    expect(previewZoneCopy(B, A, 'map7', dockB)).toMatchObject({ ok: false, status: 404, reason: 'source_not_found' });
    expect(previewZoneCopy(B, A, 'map0', undefined)).toMatchObject({ ok: false, status: 400, reason: 'bad_dock' });
    expect(previewZoneCopy(B, A, 'map0', { x: 'a', y: 1 })).toMatchObject({ ok: false, status: 400, reason: 'bad_dock' });
    expect(previewZoneCopy(B, A, 'map0', { x: dockB.x + MAX_DOCK_DISTANCE_M + 1, y: dockB.y })).toMatchObject({ ok: false, status: 400, reason: 'dock_too_far' });
    for (const m of mapRepo.findByMowerSn(B)) mapRepo.deleteById(m.map_id);
    expect(previewZoneCopy(B, A, 'map0', dockB)).toMatchObject({ ok: false, status: 409, reason: 'target_no_dock' });
  });

  it('te kleine zone: 409 too_small', () => {
    for (const m of mapRepo.findByMowerSn(A)) if (m.canonical_name === 'map0') mapRepo.deleteById(m.map_id);
    addRow(A, 'map0', 'work', square(0, 0, 1));
    expect(previewZoneCopy(B, A, 'map0', dockB)).toMatchObject({ ok: false, status: 409, reason: 'too_small' });
  });

  it('B met bestaande map0: kopie wordt map1, obstakels hernummerd, bestaande obstakels tellen mee', () => {
    addRow(B, 'map0', 'work', square(-30, -30));
    addRow(B, 'map0_0_obstacle', 'obstacle', square(-28, -28, 2));
    const r = previewZoneCopy(B, A, 'map0', dockB);
    expect(r.ok && r.plan.canonical).toBe('map1');
    expect(r.ok && r.plan.obstacles[0].canonical).toBe('map1_0_obstacle');
  });

  it('persistZoneCopy schrijft work + obstakels + kanalen, vervangt het oude dockkanaal zonder dubbele rij', () => {
    const r = previewZoneCopy(B, A, 'map0', dockB);
    if (!r.ok) throw new Error('preview failed');
    const saved = persistZoneCopy(B, r.plan, { alias: 'Grote tuin (kopie)', acceptChannel: true });
    const rows = mapRepo.findByMowerSn(B);
    expect(rows.map(x => x.canonical_name).sort()).toEqual(['map0', 'map0_0_obstacle', 'map0tocharge_unicom']);
    const work = mapRepo.findBySnAndCanonical(B, 'map0')!;
    expect(work.map_id).toBe(saved.mapId);
    expect(work.map_name).toBe('Grote tuin (kopie)');
    expect(work.source).toBe('drawn');
    expect(JSON.parse(work.map_max_min!)).toEqual(saved.mapMaxMin);
    const dock = mapRepo.findBySnAndCanonical(B, 'map0tocharge_unicom')!;
    expect(JSON.parse(dock.map_area!)[0]).toEqual(dockB);
    expect(saved.channels).toEqual(['map0tocharge_unicom']);
    expect(saved.obstacles).toEqual(['map0_0_obstacle']);
  });

  it('persistZoneCopy met acceptChannel=false schrijft geen kanaal en laat het oude staan', () => {
    const r = previewZoneCopy(B, A, 'map0', dockB);
    if (!r.ok) throw new Error('preview failed');
    const saved = persistZoneCopy(B, r.plan, { alias: null, acceptChannel: false });
    expect(saved.channels).toEqual([]);
    const dock = mapRepo.findBySnAndCanonical(B, 'map0tocharge_unicom')!;
    expect(JSON.parse(dock.map_area!)[1]).toEqual({ x: 0.3, y: -0.8 });
  });
});
```

- [ ] **Step 2: Draai de tests, verwacht falen**

Run: `cd server && npx vitest run src/__tests__/services/zoneCopy.test.ts`
Expected: FAIL met "previewZoneCopy is not a function".

- [ ] **Step 3: Voeg deel 3 toe aan `zoneCopy.ts`**

Imports bovenin uitbreiden:

```ts
import { db } from '../db/database.js';
import { mapRepo } from '../db/repositories/index.js';
import { pointInPolygon, polygonArea, polygonContains, segIntersects, MIN_WORK_AREA_M2, type XY } from '../maps/editGeometry.js';
import { distanceToPolygon, dockPoint, nextChannelIndex, nextFreeWorkSlot, workSlots } from './canonicalNaming.js';
import { getPolygonAnchor } from './anchor.js';
import { getDockPose } from '../mqtt/sensorData.js';
import { translator, type Translate } from './serverText.js';
```

Onderaan toevoegen:

```ts
// ── DB-orkestratie ────────────────────────────────────────────────────────

/** dockAtB verder dan dit van B's eigen dock is een typefout, geen tuin. */
export const MAX_DOCK_DISTANCE_M = 500;

export interface PreviewOk { ok: true; plan: CopyPlan; sourceAlias: string | null; areaM2: number }
export interface PreviewFail {
  ok: false;
  status: 400 | 404 | 409;
  reason: 'bad_canonical' | 'source_not_found' | 'source_no_anchor' | 'bad_dock' | 'dock_too_far' | 'target_no_dock' | 'too_small';
  error: string;
}
export type PreviewResult = PreviewOk | PreviewFail;

function parsePoints(raw: string | null): XY[] {
  if (!raw) return [];
  try {
    const pts = JSON.parse(raw);
    return Array.isArray(pts) ? pts.filter((p: XY) => Number.isFinite(p?.x) && Number.isFinite(p?.y)) : [];
  } catch {
    return [];
  }
}

/** Obstakels van slot N, op volgorde van index. */
function obstaclesOf(sn: string, slot: number): XY[][] {
  const re = new RegExp(`^map${slot}_\\d+_obstacle$`);
  return mapRepo.findAllByMowerSnAndType(sn, 'obstacle')
    .filter(r => re.test(r.canonical_name ?? ''))
    .sort((a, b) => (a.canonical_name ?? '').localeCompare(b.canonical_name ?? '', undefined, { numeric: true }))
    .map(r => parsePoints(r.map_area))
    .filter(p => p.length >= 3);
}

/** A's dock in A's frame: het anker (rij 1 van map0tocharge_unicom), anders de live gedockte pose. */
function sourceDock(sn: string): XY | null {
  const anchor = getPolygonAnchor(sn);
  if (anchor) return { x: anchor.x, y: anchor.y };
  const live = getDockPose(sn);
  if (live && (live.x !== 0 || live.y !== 0)) return { x: live.x, y: live.y };
  return null;
}

export function previewZoneCopy(
  targetSn: string,
  sourceSn: string,
  sourceCanonical: string,
  dockAtB: { x?: unknown; y?: unknown } | undefined,
  opts: { withObstacles?: boolean } = {},
  T: Translate = translator('en'),
): PreviewResult {
  const m = sourceCanonical.match(/^map(\d+)$/);
  if (!m) return { ok: false, status: 400, reason: 'bad_canonical', error: T`Kies een werkgebied (map0, map1, ...) om te kopiëren.` };
  const src = mapRepo.findBySnAndCanonical(sourceSn, sourceCanonical);
  const srcPts = src && src.map_type === 'work' ? parsePoints(src.map_area) : [];
  if (!src || srcPts.length < 3) {
    return { ok: false, status: 404, reason: 'source_not_found', error: T`Werkgebied ${sourceCanonical} van maaier ${sourceSn} niet gevonden.` };
  }
  const areaM2 = polygonArea(srcPts);
  if (areaM2 < MIN_WORK_AREA_M2) return { ok: false, status: 409, reason: 'too_small', error: T`Het werkgebied is kleiner dan ${MIN_WORK_AREA_M2} m².` };
  const dockAInA = sourceDock(sourceSn);
  if (!dockAInA) {
    return { ok: false, status: 409, reason: 'source_no_anchor', error: T`De bronmaaier heeft geen dock-anker (geen map0tocharge_unicom en niet gedockt online); zonder anker is de zone niet te plaatsen.` };
  }
  const x = Number(dockAtB?.x);
  const y = Number(dockAtB?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, status: 400, reason: 'bad_dock', error: T`Geef de positie van het laadstation van de bronmaaier op deze kaart (dockAtB.x/y).` };
  }
  const dockB = dockPoint(targetSn);
  if (!dockB) {
    return { ok: false, status: 409, reason: 'target_no_dock', error: T`Het dock van deze maaier is onbekend: zet de maaier op het dock of teken eerst een dockkanaal.` };
  }
  if (Math.hypot(x - dockB.x, y - dockB.y) > MAX_DOCK_DISTANCE_M) {
    return { ok: false, status: 400, reason: 'dock_too_far', error: T`De aangewezen plek ligt meer dan ${MAX_DOCK_DISTANCE_M} m van het dock van deze maaier.` };
  }

  const dockAInB = { x, y };
  const slot = nextFreeWorkSlot(targetSn);
  const work = transformPoints(srcPts, dockAInA, dockAInB);
  const obstacles = opts.withObstacles === false
    ? []
    : obstaclesOf(sourceSn, parseInt(m[1], 10)).map(o => transformPoints(o, dockAInA, dockAInB));
  const existing: ExistingZone[] = workSlots(targetSn)
    .filter(w => w.poly.length >= 3)
    .map(w => ({ slot: w.slot, canonical: `map${w.slot}`, points: w.poly, obstacles: obstaclesOf(targetSn, w.slot) }));
  const plan = planZoneCopy({
    slot, work, obstacles, existing, dock: dockB,
    dockChannelRowExists: !!mapRepo.findBySnAndCanonical(targetSn, `map${slot}tocharge_unicom`),
    linkIndex: (from, to) => nextChannelIndex(targetSn, from, to),
  });
  const sourceAlias = src.map_name && src.map_name !== sourceCanonical ? src.map_name : null;
  return { ok: true, plan, sourceAlias, areaM2 };
}

export interface PersistResult {
  mapId: string;
  createdAt: string;
  mapMaxMin: { minX: number; maxX: number; minY: number; maxY: number };
  channels: string[];
  obstacles: string[];
}

function bounds(pts: XY[]): PersistResult['mapMaxMin'] {
  return {
    minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)),
    minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y)),
  };
}

/**
 * Schrijft de kopie als DB-rijen (work + obstakels + geaccepteerde kanalen) in
 * één transactie, precies zoals de tekenroute dat doet (source 'drawn', geen
 * file_name). Pushen naar de maaier doet de route (autoPushMapsInBackground).
 */
export function persistZoneCopy(
  targetSn: string,
  plan: CopyPlan,
  opts: { alias: string | null; acceptChannel: boolean },
): PersistResult {
  if (!plan.ok) throw new Error(`persistZoneCopy: plan is refused (${plan.refusal})`);
  const ts = Date.now();
  const mapId = `copy_${plan.canonical}_${ts}`;
  const create = (canonical: string, mapType: 'work' | 'obstacle' | 'unicom', points: XY[], alias: string | null) => {
    mapRepo.create({
      source: 'drawn',
      map_id: mapType === 'work' ? mapId : `copy_${canonical}_${ts}`,
      mower_sn: targetSn,
      map_name: alias,
      map_type: mapType,
      map_area: JSON.stringify(points),
      map_max_min: JSON.stringify(bounds(points)),
      canonical_name: canonical,
    });
  };
  const channels = opts.acceptChannel ? plan.channels : [];
  db.transaction(() => {
    create(plan.canonical, 'work', plan.work, opts.alias);
    for (const o of plan.obstacles) create(o.canonical, 'obstacle', o.points, null);
    for (const c of channels) {
      const old = mapRepo.findBySnAndCanonical(targetSn, c.canonical);
      if (old) mapRepo.deleteByIdAndMower(old.map_id, targetSn);
      create(c.canonical, 'unicom', c.points, null);
    }
  })();
  return {
    mapId,
    createdAt: new Date(ts).toISOString(),
    mapMaxMin: bounds(plan.work),
    channels: channels.map(c => c.canonical),
    obstacles: plan.obstacles.map(o => o.canonical),
  };
}
```

- [ ] **Step 4: Catalogus-entries voor de nieuwe teksten**

In `server/src/services/apiText.catalog.ts` (alfabetisch invoegen, zelfde vorm als de buren; `{0}`/`{1}` op de plek van de interpolaties):

```ts
  "De aangewezen plek ligt meer dan {0} m van het dock van deze maaier.": {
    en: "The chosen spot is more than {0} m from this mower's dock.",
    fr: "L'emplacement choisi est à plus de {0} m de la station de cette tondeuse.",
    de: "Die gewählte Stelle liegt mehr als {0} m vom Dock dieses Mähers entfernt.",
  },
  "De bronmaaier heeft geen dock-anker (geen map0tocharge_unicom en niet gedockt online); zonder anker is de zone niet te plaatsen.": {
    en: "The source mower has no dock anchor (no map0tocharge_unicom and not docked online); without an anchor the zone cannot be placed.",
    fr: "La tondeuse source n'a pas d'ancre de station (pas de map0tocharge_unicom et pas amarrée en ligne) ; sans ancre la zone ne peut pas être placée.",
    de: "Der Quellmäher hat keinen Dock-Anker (kein map0tocharge_unicom und nicht online angedockt); ohne Anker lässt sich die Zone nicht platzieren.",
  },
  "Geef de positie van het laadstation van de bronmaaier op deze kaart (dockAtB.x/y).": {
    en: "Give the position of the source mower's charging station on this map (dockAtB.x/y).",
    fr: "Indiquez la position de la station de charge de la tondeuse source sur cette carte (dockAtB.x/y).",
    de: "Geben Sie die Position der Ladestation des Quellmähers auf dieser Karte an (dockAtB.x/y).",
  },
  "Het dock van deze maaier is onbekend: zet de maaier op het dock of teken eerst een dockkanaal.": {
    en: "This mower's dock is unknown: put the mower on the dock or draw a dock channel first.",
    fr: "La station de cette tondeuse est inconnue : placez la tondeuse sur la station ou tracez d'abord un couloir vers la station.",
    de: "Das Dock dieses Mähers ist unbekannt: Mäher aufs Dock stellen oder zuerst einen Dockkanal zeichnen.",
  },
  "Het werkgebied is kleiner dan {0} m².": {
    en: "The work area is smaller than {0} m².",
    fr: "La zone de travail fait moins de {0} m².",
    de: "Der Arbeitsbereich ist kleiner als {0} m².",
  },
  "Kies een werkgebied (map0, map1, ...) om te kopiëren.": {
    en: "Choose a work area (map0, map1, ...) to copy.",
    fr: "Choisissez une zone de travail (map0, map1, ...) à copier.",
    de: "Wählen Sie einen Arbeitsbereich (map0, map1, ...) zum Kopieren.",
  },
  "Werkgebied {0} van maaier {1} niet gevonden.": {
    en: "Work area {0} of mower {1} not found.",
    fr: "Zone de travail {0} de la tondeuse {1} introuvable.",
    de: "Arbeitsbereich {0} von Mäher {1} nicht gefunden.",
  },
```

- [ ] **Step 5: Draai de tests, verwacht slagen**

Run: `cd server && npx vitest run src/__tests__/services/zoneCopy.test.ts src/__tests__/services/serverText.coverage.test.ts`
Expected: PASS. Faalt de coverage-test op een sleutel, neem dan letterlijk de sleutel over die de test noemt (de test bepaalt hoe `${...}` naar `{n}` wordt vertaald).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/zoneCopy.ts server/src/services/apiText.catalog.ts server/src/__tests__/services/zoneCopy.test.ts
git commit -m "feat(zone-copy): preview and persist a copied zone from the database"
```

---

### Task 4: Routes `copy-from/:source/preview` en `copy-from/:source`

**Files:**
- Modify: `server/src/routes/dashboard.ts` (na de `dashboardRouter.post('/maps/:sn', ...)`-route, vóór `// PATCH /api/dashboard/maps/:sn/:mapId`, rond regel 1885)
- Modify: `server/src/services/apiText.catalog.ts`
- Test: `server/src/__tests__/routes/dashboardZoneCopy.test.ts`

**Interfaces:**
- Consumes: `previewZoneCopy`, `persistZoneCopy`, `DOCK_MAX_M`, `type CopyPlan` (Task 3); bestaande `rejectUnlessOpenNova`, `reqT`, `M`, `isDeviceOnline`, `autoPushMapsInBackground` (functie-declaratie verderop in hetzelfde bestand, dus bruikbaar).
- Produces (HTTP):
  - `POST /api/dashboard/maps/:sn/copy-from/:source/preview` body `{ canonical, dockAtB:{x,y}, withObstacles? }` → 200 `CopyPlan & { sourceAlias, areaM2, error? }`; 400/404/409 `{ ok:false, reason, error }`.
  - `POST /api/dashboard/maps/:sn/copy-from/:source` body als preview + `{ name?, acceptChannel? }` → 200 `{ ok:true, map:{ mapId, mapName, canonicalName, mapType:'work', mapArea, mapMaxMin, createdAt }, obstacles: string[], channels: string[], needsChannel, warnings }`; 409 `offline` / refusal.

- [ ] **Step 1: Schrijf de falende route-test**

`server/src/__tests__/routes/dashboardZoneCopy.test.ts`. Kopieer regels 10 t/m 97 uit `server/src/__tests__/routes/dashboardMapWriteStock.test.ts` letterlijk (de drie imports van express/supertest/vitest en de `vi.mock(...)`-blokken voor broker, socketHandler, mapSync, mapConverter, demoSimulator, sensorData en mowerFileCapability, inclusief `const fw = vi.hoisted(...)`), en voeg in het `sensorData`-mock-object één regel toe: `getDockPose: vi.fn().mockReturnValue(null),`. Daarna:

```ts
import { dashboardRouter } from '../../routes/dashboard.js';
import { publishToExtended } from '../../mqtt/mapSync.js';
import { isDeviceOnline } from '../../mqtt/broker.js';
import { mapRepo } from '../../db/repositories/index.js';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);
const server = app.listen(0);
afterAll(() => new Promise<void>(r => { server.close(() => r()); }));

const A = 'LFIN_COPY_A';
const B = 'LFIN_COPY_B';
const square = (x0: number, y0: number, size = 10) => [
  { x: x0, y: y0 }, { x: x0 + size, y: y0 }, { x: x0 + size, y: y0 + size }, { x: x0, y: y0 + size },
];
const dockA = { x: 0.03, y: 0.73 };
const dockB = { x: 0.1, y: -0.5 };
const addRow = (sn: string, canonical: string, type: string, pts: unknown[], alias: string | null = null) =>
  mapRepo.create({ map_id: `${sn}-${canonical}`, mower_sn: sn, map_name: alias, map_type: type, map_area: JSON.stringify(pts), canonical_name: canonical });
const url = (suffix = '') => `/api/dashboard/maps/${B}/copy-from/${A}${suffix}`;

describe('zone copy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fw.supported = true;
    vi.mocked(isDeviceOnline).mockReturnValue(true);
    for (const sn of [A, B]) for (const m of mapRepo.findByMowerSn(sn)) mapRepo.deleteById(m.map_id);
    addRow(A, 'map0', 'work', square(0, 0), 'Grote tuin');
    addRow(A, 'map0_0_obstacle', 'obstacle', square(2, 2, 2));
    addRow(A, 'map0tocharge_unicom', 'unicom', [dockA, { x: -0.4, y: 0.94 }]);
    addRow(B, 'map0tocharge_unicom', 'unicom', [dockB, { x: 0.3, y: -0.8 }]);
  });

  it('preview: 200 met plan, geen DB-mutatie, geen push', async () => {
    const res = await request(server).post(url('/preview')).send({ canonical: 'map0', dockAtB: dockB });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.canonical).toBe('map0');
    expect(res.body.sourceAlias).toBe('Grote tuin');
    expect(res.body.channels[0].canonical).toBe('map0tocharge_unicom');
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
    expect(publishToExtended).not.toHaveBeenCalled();
  });

  it('preview: refusal komt als 200 met ok:false en leesbare tekst', async () => {
    const res = await request(server).post(url('/preview')).send({ canonical: 'map0', dockAtB: { x: 50, y: 50 } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.refusal).toBe('too_far_from_dock');
    expect(typeof res.body.error).toBe('string');
  });

  it('preview zonder dockAtB: 400 bad_dock, niets geschreven', async () => {
    const res = await request(server).post(url('/preview')).send({ canonical: 'map0' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('bad_dock');
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
  });

  it('copy: rijen + sync_map-push, antwoord zoals de tekenroute', async () => {
    const res = await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.map.canonicalName).toBe('map0');
    expect(res.body.map.mapName).toMatch(/^Grote tuin \((copy|kopie)\)$/);
    expect(res.body.map.mapType).toBe('work');
    expect(res.body.obstacles).toEqual(['map0_0_obstacle']);
    expect(res.body.channels).toEqual(['map0tocharge_unicom']);
    expect(res.body.needsChannel).toBe(false);
    const rows = mapRepo.findByMowerSn(B).map(r => r.canonical_name).sort();
    expect(rows).toEqual(['map0', 'map0_0_obstacle', 'map0tocharge_unicom']);
    await new Promise(r => setTimeout(r, 0));
    const sent = vi.mocked(publishToExtended).mock.calls.map(c => Object.keys(c[1] as object)[0]);
    expect(sent).toEqual(['sync_map']);
  });

  it('copy: eigen naam wint van de bron-alias', async () => {
    const res = await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB, name: 'Achtertuin' });
    expect(res.body.map.mapName).toBe('Achtertuin');
  });

  it('copy: 409 offline, niets geschreven', async () => {
    vi.mocked(isDeviceOnline).mockReturnValue(false);
    const res = await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('offline');
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
  });

  it('copy: 409 met refusal-reden als het plan weigert', async () => {
    const res = await request(server).post(url()).send({ canonical: 'map0', dockAtB: { x: 50, y: 50 } });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('too_far_from_dock');
    expect(mapRepo.findByMowerSn(B)).toHaveLength(1);
  });

  it('stock firmware: 409 unsupported_firmware op beide routes', async () => {
    fw.supported = false;
    expect((await request(server).post(url('/preview')).send({ canonical: 'map0', dockAtB: dockB })).body.reason).toBe('unsupported_firmware');
    expect((await request(server).post(url()).send({ canonical: 'map0', dockAtB: dockB })).body.reason).toBe('unsupported_firmware');
  });
});
```

De alias-suffix komt uit de catalogus; welke taal `reqT` zonder `X-Lang`-header kiest is niet van belang voor de test, vandaar de regex.

- [ ] **Step 2: Draai de test, verwacht falen**

Run: `cd server && npx vitest run src/__tests__/routes/dashboardZoneCopy.test.ts`
Expected: FAIL: 404 op de routes (bestaan nog niet).

- [ ] **Step 3: Voeg de routes toe in `dashboard.ts`**

Import bovenin (naast `canonicalForDrawnMap`):

```ts
import { previewZoneCopy, persistZoneCopy, DOCK_MAX_M, type CopyPlan } from '../services/zoneCopy.js';
```

Direct na de `dashboardRouter.post('/maps/:sn', ...)`-route:

```ts
// ── Zone kopiëren van een andere maaier ───────────────────────────────────
// Spec: docs/superpowers/specs/2026-09-24-copy-zone-between-mowers-design.md
// De kopie is een getekende zone met voorgevulde geometrie: zelfde rijen,
// zelfde push (autoPushMapsInBackground), zelfde kanaal-prompt in het dashboard.
interface ZoneCopyBody {
  canonical?: string;
  dockAtB?: { x?: unknown; y?: unknown };
  withObstacles?: boolean;
  name?: string;
  acceptChannel?: boolean;
}

function zoneCopyRefusalText(refusal: NonNullable<CopyPlan['refusal']>, T: Translate): string {
  switch (refusal) {
    case 'slot_limit':
      return T`Deze maaier heeft al vijf werkgebieden (map0 t/m map4); de firmware kan er niet meer aan.`;
    case 'target_no_dock':
      return T`Het dock van deze maaier is onbekend: zet de maaier op het dock of teken eerst een dockkanaal.`;
    case 'too_far_from_dock':
      return T`De zone ligt meer dan ${DOCK_MAX_M} m van het dock; als eerste zone moet ze bij het dock liggen, anders kan er geen dockkanaal gemaakt worden.`;
    case 'dock_channel_blocked':
      return T`Het dockkanaal zou door een obstakel lopen; verwijder dat obstakel na het kopiëren of kies een andere zone.`;
  }
}

dashboardRouter.post('/maps/:sn/copy-from/:source/preview', (req: Request, res: Response) => {
  const T = reqT(req);
  const { sn, source } = req.params;
  if (rejectUnlessOpenNova(sn, req, res, M`Een zone kopiëren`)) return;
  const body = (req.body ?? {}) as ZoneCopyBody;
  const r = previewZoneCopy(sn, source, String(body.canonical ?? ''), body.dockAtB, { withObstacles: body.withObstacles !== false }, T);
  if (!r.ok) { res.status(r.status).json({ ok: false, reason: r.reason, error: r.error }); return; }
  res.json({
    ...r.plan,
    sourceAlias: r.sourceAlias,
    areaM2: r.areaM2,
    error: r.plan.refusal ? zoneCopyRefusalText(r.plan.refusal, T) : undefined,
  });
});

dashboardRouter.post('/maps/:sn/copy-from/:source', (req: Request, res: Response) => {
  const T = reqT(req);
  const { sn, source } = req.params;
  if (rejectUnlessOpenNova(sn, req, res, M`Een zone kopiëren`)) return;
  if (!isDeviceOnline(sn)) {
    res.status(409).json({ ok: false, reason: 'offline', error: T`Maaier offline: kopiëren vereist een online maaier, zodat die de nieuwe zone meteen ontvangt.` });
    return;
  }
  const body = (req.body ?? {}) as ZoneCopyBody;
  // Altijd server-side herberekenen: de client stuurt alleen de correspondentie, nooit geometrie.
  const r = previewZoneCopy(sn, source, String(body.canonical ?? ''), body.dockAtB, { withObstacles: body.withObstacles !== false }, T);
  if (!r.ok) { res.status(r.status).json({ ok: false, reason: r.reason, error: r.error }); return; }
  if (!r.plan.ok) {
    res.status(409).json({ ok: false, reason: r.plan.refusal, error: zoneCopyRefusalText(r.plan.refusal!, T) });
    return;
  }
  const typedName = (body.name ?? '').trim();
  const alias = typedName || (r.sourceAlias ? `${r.sourceAlias} (${T`kopie`})` : null);
  const acceptChannel = body.acceptChannel !== false;
  const saved = persistZoneCopy(sn, r.plan, { alias, acceptChannel });
  res.json({
    ok: true,
    map: {
      mapId: saved.mapId,
      mapName: alias,
      canonicalName: r.plan.canonical,
      mapType: 'work',
      mapArea: r.plan.work,
      mapMaxMin: saved.mapMaxMin,
      createdAt: saved.createdAt,
    },
    obstacles: saved.obstacles,
    channels: saved.channels,
    needsChannel: acceptChannel ? r.plan.needsChannel : !r.plan.connectedVia,
    warnings: r.plan.warnings,
  });
  autoPushMapsInBackground(sn);
});
```

- [ ] **Step 4: Catalogus-entries**

In `apiText.catalog.ts` toevoegen:

```ts
  "De zone ligt meer dan {0} m van het dock; als eerste zone moet ze bij het dock liggen, anders kan er geen dockkanaal gemaakt worden.": {
    en: "The zone is more than {0} m from the dock; as the first zone it must sit near the dock, otherwise no dock channel can be made.",
    fr: "La zone est à plus de {0} m de la station ; en tant que première zone elle doit être proche de la station, sinon aucun couloir vers la station ne peut être créé.",
    de: "Die Zone liegt mehr als {0} m vom Dock entfernt; als erste Zone muss sie nahe am Dock liegen, sonst kann kein Dockkanal angelegt werden.",
  },
  "Deze maaier heeft al vijf werkgebieden (map0 t/m map4); de firmware kan er niet meer aan.": {
    en: "This mower already has five work areas (map0 to map4); the firmware cannot run more.",
    fr: "Cette tondeuse a déjà cinq zones de travail (map0 à map4) ; le firmware n'en gère pas davantage.",
    de: "Dieser Mäher hat bereits fünf Arbeitsbereiche (map0 bis map4); die Firmware kann nicht mehr verarbeiten.",
  },
  "Een zone kopiëren": {
    en: "Copying a zone",
    fr: "Copier une zone",
    de: "Eine Zone kopieren",
  },
  "Het dockkanaal zou door een obstakel lopen; verwijder dat obstakel na het kopiëren of kies een andere zone.": {
    en: "The dock channel would run through an obstacle; remove that obstacle after copying or choose another zone.",
    fr: "Le couloir vers la station traverserait un obstacle ; supprimez cet obstacle après la copie ou choisissez une autre zone.",
    de: "Der Dockkanal würde durch ein Hindernis verlaufen; entfernen Sie das Hindernis nach dem Kopieren oder wählen Sie eine andere Zone.",
  },
  "kopie": {
    en: "copy",
    fr: "copie",
    de: "Kopie",
  },
  "Maaier offline: kopiëren vereist een online maaier, zodat die de nieuwe zone meteen ontvangt.": {
    en: "Mower offline: copying needs an online mower so it receives the new zone right away.",
    fr: "Tondeuse hors ligne : la copie nécessite une tondeuse en ligne pour qu'elle reçoive la nouvelle zone immédiatement.",
    de: "Mäher offline: Kopieren braucht einen Online-Mäher, damit er die neue Zone sofort erhält.",
  },
```

- [ ] **Step 5: Draai de tests, verwacht slagen**

Run: `cd server && npx vitest run src/__tests__/routes/dashboardZoneCopy.test.ts src/__tests__/routes/dashboardMapWriteStock.test.ts src/__tests__/services/serverText.coverage.test.ts && npx tsc --noEmit`
Expected: PASS, geen type-fouten.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/dashboard.ts server/src/services/apiText.catalog.ts server/src/__tests__/routes/dashboardZoneCopy.test.ts
git commit -m "feat(zone-copy): dashboard endpoints to preview and copy a zone from another mower"
```

---

### Task 5: Dashboard-client en vertalingen

**Files:**
- Modify: `dashboard/src/api/client.ts` (na `createMap`, regel ~296)
- Modify: `dashboard/src/i18n/locales/nl.json`, `en.json`, `de.json`, `fr.json` (in het `"map"`-object, direct na `"channelPromptLater"`)

**Interfaces:**
- Consumes: bestaande `post(url, body)` (gooit `Error(server.error)` bij een niet-2xx), `BASE`, `LocalPoint`, `MapData`.
- Produces:

```ts
export interface ZoneCopyChannel { canonical: string; kind: 'dock' | 'link'; points: LocalPoint[]; replaces: boolean }
export interface ZoneCopyPlan { ok: boolean; refusal?: string; error?: string; slot: number; canonical: string; work: LocalPoint[]; obstacles: { canonical: string; points: LocalPoint[] }[]; channels: ZoneCopyChannel[]; connectedVia: string | null; needsChannel: boolean; warnings: string[]; dockDistanceM: number | null; sourceAlias: string | null; areaM2: number }
export interface ZoneCopyResult { ok: boolean; map?: MapData; obstacles?: string[]; channels?: string[]; needsChannel?: boolean; warnings?: string[] }
export async function previewZoneCopy(sn: string, source: string, canonical: string, dockAtB: LocalPoint, withObstacles?: boolean): Promise<ZoneCopyPlan>
export async function copyZone(sn: string, source: string, canonical: string, dockAtB: LocalPoint, opts?: { withObstacles?: boolean; name?: string; acceptChannel?: boolean }): Promise<ZoneCopyResult>
```

- [ ] **Step 1: Client-functies**

In `dashboard/src/api/client.ts` na `createMap`:

```ts
// ── Zone kopiëren van een andere maaier ───────────────────────────────────
export interface ZoneCopyChannel { canonical: string; kind: 'dock' | 'link'; points: LocalPoint[]; replaces: boolean }
export interface ZoneCopyPlan {
  ok: boolean;
  refusal?: 'slot_limit' | 'target_no_dock' | 'too_far_from_dock' | 'dock_channel_blocked';
  /** Leesbare reden (in de taal van de lezer) bij een refusal. */
  error?: string;
  slot: number;
  canonical: string;
  work: LocalPoint[];
  obstacles: { canonical: string; points: LocalPoint[] }[];
  channels: ZoneCopyChannel[];
  connectedVia: string | null;
  needsChannel: boolean;
  warnings: ('full_overlap' | 'existing_zones_unlinked')[];
  dockDistanceM: number | null;
  sourceAlias: string | null;
  areaM2: number;
}
export interface ZoneCopyResult {
  ok: boolean;
  map?: MapData;
  obstacles?: string[];
  channels?: string[];
  needsChannel?: boolean;
  warnings?: string[];
}

/** Plan zonder te schrijven. Invoerfouten (400/404/409) komen als Error met de servertekst. */
export async function previewZoneCopy(sn: string, source: string, canonical: string, dockAtB: LocalPoint, withObstacles = true): Promise<ZoneCopyPlan> {
  const res = await post(`${BASE}/maps/${encodeURIComponent(sn)}/copy-from/${encodeURIComponent(source)}/preview`, { canonical, dockAtB, withObstacles });
  return res.json();
}

export async function copyZone(
  sn: string, source: string, canonical: string, dockAtB: LocalPoint,
  opts: { withObstacles?: boolean; name?: string; acceptChannel?: boolean } = {},
): Promise<ZoneCopyResult> {
  const res = await post(`${BASE}/maps/${encodeURIComponent(sn)}/copy-from/${encodeURIComponent(source)}`, { canonical, dockAtB, ...opts });
  return res.json();
}
```

- [ ] **Step 2: Vertalingen**

`nl.json`, in `"map"` na `"channelPromptLater": "Later",`:

```json
    "copyZone": "Zone kopiëren van andere maaier",
    "copyZoneNoSources": "Geen andere maaier bekend op deze server.",
    "copyZoneSource": "Bronmaaier",
    "copyZoneChoose": "Kies…",
    "copyZoneZone": "Zone",
    "copyZoneWithObstacles": "Obstakels meenemen",
    "copyZoneHint": "Sleep de oranje marker (of klik op de kaart) naar de plek waar het laadstation van {{name}} echt staat. De zone schuift mee.",
    "copyZoneMarker": "Laadstation {{name}}",
    "copyZoneVerdictOk": "Wordt {{slot}} ({{m2}} m²)",
    "copyZoneConnected": "Overlapt {{zone}}: geen kanaal nodig",
    "copyZoneChannelDock": "Dockkanaal van {{m}} m wordt aangemaakt",
    "copyZoneChannelLink": "Kanaal naar {{zone}} wordt voorgesteld (blauw gestippeld)",
    "copyZoneNeedsChannel": "Geen kanaal mogelijk: teken er na het plaatsen zelf een.",
    "copyZoneWarn": {
      "full_overlap": "De ene zone omsluit de andere volledig; dat is in de firmware nooit getest.",
      "existing_zones_unlinked": "De bestaande zones krijgen geen kanaal naar deze zone."
    },
    "copyZonePlace": "Plaatsen",
    "copyZonePlacing": "Bezig…",
    "copyZoneDone": "{{name}} geplaatst als {{slot}}; de maaier ontvangt de zone nu.",
    "copyZoneFailed": "Kopiëren is niet gelukt.",
```

`en.json`:

```json
    "copyZone": "Copy zone from another mower",
    "copyZoneNoSources": "No other mower known to this server.",
    "copyZoneSource": "Source mower",
    "copyZoneChoose": "Choose…",
    "copyZoneZone": "Zone",
    "copyZoneWithObstacles": "Include obstacles",
    "copyZoneHint": "Drag the orange marker (or click the map) to where {{name}}'s charging station really stands. The zone follows.",
    "copyZoneMarker": "Charging station {{name}}",
    "copyZoneVerdictOk": "Becomes {{slot}} ({{m2}} m²)",
    "copyZoneConnected": "Overlaps {{zone}}: no channel needed",
    "copyZoneChannelDock": "A {{m}} m dock channel will be created",
    "copyZoneChannelLink": "A channel to {{zone}} is proposed (blue dashed)",
    "copyZoneNeedsChannel": "No channel possible: draw one yourself after placing.",
    "copyZoneWarn": {
      "full_overlap": "One zone fully encloses the other; never tested in the firmware.",
      "existing_zones_unlinked": "The existing zones get no channel to this zone."
    },
    "copyZonePlace": "Place",
    "copyZonePlacing": "Placing…",
    "copyZoneDone": "{{name}} placed as {{slot}}; the mower is receiving it now.",
    "copyZoneFailed": "Copying failed.",
```

`de.json`:

```json
    "copyZone": "Zone von anderem Mäher kopieren",
    "copyZoneNoSources": "Kein anderer Mäher auf diesem Server bekannt.",
    "copyZoneSource": "Quellmäher",
    "copyZoneChoose": "Wählen…",
    "copyZoneZone": "Zone",
    "copyZoneWithObstacles": "Hindernisse übernehmen",
    "copyZoneHint": "Ziehen Sie die orange Markierung (oder klicken Sie auf die Karte) dorthin, wo die Ladestation von {{name}} wirklich steht. Die Zone folgt.",
    "copyZoneMarker": "Ladestation {{name}}",
    "copyZoneVerdictOk": "Wird {{slot}} ({{m2}} m²)",
    "copyZoneConnected": "Überlappt {{zone}}: kein Kanal nötig",
    "copyZoneChannelDock": "Ein {{m}} m langer Dockkanal wird angelegt",
    "copyZoneChannelLink": "Ein Kanal zu {{zone}} wird vorgeschlagen (blau gestrichelt)",
    "copyZoneNeedsChannel": "Kein Kanal möglich: nach dem Platzieren selbst einen zeichnen.",
    "copyZoneWarn": {
      "full_overlap": "Eine Zone umschließt die andere vollständig; in der Firmware nie getestet.",
      "existing_zones_unlinked": "Die bestehenden Zonen erhalten keinen Kanal zu dieser Zone."
    },
    "copyZonePlace": "Platzieren",
    "copyZonePlacing": "Wird platziert…",
    "copyZoneDone": "{{name}} als {{slot}} platziert; der Mäher erhält die Zone jetzt.",
    "copyZoneFailed": "Kopieren fehlgeschlagen.",
```

`fr.json`:

```json
    "copyZone": "Copier une zone d'une autre tondeuse",
    "copyZoneNoSources": "Aucune autre tondeuse connue sur ce serveur.",
    "copyZoneSource": "Tondeuse source",
    "copyZoneChoose": "Choisir…",
    "copyZoneZone": "Zone",
    "copyZoneWithObstacles": "Inclure les obstacles",
    "copyZoneHint": "Faites glisser le repère orange (ou cliquez sur la carte) à l'endroit réel de la station de charge de {{name}}. La zone suit.",
    "copyZoneMarker": "Station de charge {{name}}",
    "copyZoneVerdictOk": "Deviendra {{slot}} ({{m2}} m²)",
    "copyZoneConnected": "Chevauche {{zone}} : pas de couloir nécessaire",
    "copyZoneChannelDock": "Un couloir de {{m}} m vers la station sera créé",
    "copyZoneChannelLink": "Un couloir vers {{zone}} est proposé (pointillé bleu)",
    "copyZoneNeedsChannel": "Aucun couloir possible : tracez-en un après le placement.",
    "copyZoneWarn": {
      "full_overlap": "Une zone englobe entièrement l'autre ; jamais testé dans le firmware.",
      "existing_zones_unlinked": "Les zones existantes n'auront pas de couloir vers cette zone."
    },
    "copyZonePlace": "Placer",
    "copyZonePlacing": "Placement…",
    "copyZoneDone": "{{name}} placée comme {{slot}} ; la tondeuse la reçoit maintenant.",
    "copyZoneFailed": "La copie a échoué.",
```

- [ ] **Step 3: Controleer**

Run: `cd dashboard && npx tsc --noEmit && node -e "for (const l of ['nl','en','de','fr']) { const j = require('./src/i18n/locales/' + l + '.json'); if (!j.map.copyZoneWarn.full_overlap) throw new Error(l); } console.log('locales ok')"`
Expected: geen type-fouten, `locales ok`.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/api/client.ts dashboard/src/i18n/locales/nl.json dashboard/src/i18n/locales/en.json dashboard/src/i18n/locales/de.json dashboard/src/i18n/locales/fr.json
git commit -m "feat(dashboard): API client and translations for copying a zone between mowers"
```

---

### Task 6: Dashboard-UI in `MowerMap.tsx`

**Files:**
- Modify: `dashboard/src/components/map/MowerMap.tsx`

**Interfaces:**
- Consumes: `previewZoneCopy`, `copyZone`, `type ZoneCopyPlan`, `fetchDevices`, `fetchMaps`, `fetchCalibration` (client); `DeviceState`, `LocalPoint`, `MapData` (types); bestaande component-state: `sn`, `maps`, `chargerGps`, `chargingPose`, `mapWriteSupported`, `reloadMaps`, `setSelectedMapId`, `setChannelPrompt`, `setEditStatus`, `setEditStatusKind`, `toast`, `t`, `editMode`, `railFlyout`/`setRailFlyout`, `railRow`, `activeCal` (regel ~1767), `polyCenter` (useMemo rond regel 3436), `calibratePoints`, `ChargerPlacer`, `AREA_STYLES`, `Copy`/`X`-iconen (al geïmporteerd).
- Produces: UI-gedrag volgens spec §Componenten/Dashboard.

- [ ] **Step 1: Imports**

Voeg `previewZoneCopy, copyZone, type ZoneCopyPlan, fetchDevices` toe aan de tweede `from '../../api/client'`-import (regel 24-35). Voeg `DeviceState, LocalPoint` toe aan `import type { MapData, MapCalibration, GpsPoint } from '../../types';`.

- [ ] **Step 2: Module-level type**

Direct na het `AREA_STYLES`-blok (regel ~96):

```ts
/** Paneelstate voor "zone kopiëren van andere maaier" (spec 2026-09-24). */
interface CopyPanelState {
  sources: DeviceState[];
  sourceSn: string | null;
  sourceMaps: MapData[];
  canonical: string | null;
  /** Waar het laadstation van de bronmaaier op DEZE kaart staat (lat, lng). */
  marker: [number, number] | null;
  withObstacles: boolean;
  plan: ZoneCopyPlan | null;
  busy: boolean;
  error: string | null;
}
```

- [ ] **Step 3: State en handlers (blok A)**

Direct na de `startDrawMap`-callback (die eindigt met `}, [mapWriteSupported, t]);`, regel ~1964):

```tsx
  // ── Zone kopiëren van een andere maaier ────────────────────────────────
  // Eén fysieke correspondentie: waar het laadstation van de bronmaaier op
  // DEZE kaart staat. De zone volgt met rotatie 0. GPS/pos.json van de andere
  // maaier is onbruikbaar: twee maaiers delen geen absoluut GPS-frame (elke
  // charger zendt zijn eigen ingemeten RTK-basispositie uit).
  const [copyPanel, setCopyPanel] = useState<CopyPanelState | null>(null);
  const copyPreviewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyMarkerIcon = useMemo(() => L.divIcon({
    className: '',
    html: '<div style="width:22px;height:22px;border-radius:50%;background:#f59e0b;border:3px solid #fff;box-shadow:0 0 0 2px #f59e0b"></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  }), []);

  /** Klik/sleep op de kaart → lokale meters van deze maaier, dezelfde formule als tekenen. */
  const copyLocalFromLatLng = useCallback((lat: number, lng: number): LocalPoint | null => {
    if (!isUsableChargerGps(chargerGps)) return null;
    const l = gpsToLocal({ lat, lng }, chargerGps);
    return { x: l.x + (chargingPose?.x ?? 0), y: l.y + (chargingPose?.y ?? 0) };
  }, [chargerGps, chargingPose]);

  const runCopyPreview = useCallback((state: CopyPanelState) => {
    if (!sn || !state.sourceSn || !state.canonical || !state.marker) return;
    const local = copyLocalFromLatLng(state.marker[0], state.marker[1]);
    if (!local) return;
    if (copyPreviewTimer.current) clearTimeout(copyPreviewTimer.current);
    const sourceSn = state.sourceSn;
    const canonical = state.canonical;
    const withObstacles = state.withObstacles;
    copyPreviewTimer.current = setTimeout(async () => {
      try {
        const plan = await previewZoneCopy(sn, sourceSn, canonical, local, withObstacles);
        setCopyPanel(prev => (prev ? { ...prev, plan, error: null } : prev));
      } catch (err) {
        setCopyPanel(prev => (prev ? { ...prev, plan: null, error: err instanceof Error ? err.message : String(err) } : prev));
      }
    }, 250);
  }, [sn, copyLocalFromLatLng]);

  const openCopyPanel = useCallback(async () => {
    if (!mapWriteSupported) { setEditStatus(t('map.drawStockNotice')); setEditStatusKind('error'); return; }
    const sources = (await fetchDevices()).filter(d => d.deviceType === 'mower' && d.sn !== sn);
    setSelectedMapId(null);
    setCopyPanel({ sources, sourceSn: null, sourceMaps: [], canonical: null, marker: null, withObstacles: true, plan: null, busy: false, error: null });
  }, [mapWriteSupported, sn, t]);

  const chooseCopySource = useCallback(async (sourceSn: string) => {
    const [{ maps: srcMaps }, cal] = await Promise.all([fetchMaps(sourceSn), fetchCalibration(sourceSn)]);
    const work = srcMaps.filter(m => m.mapType === 'work' && m.canonicalName);
    // Voorgevuld op de kaartpositie van het laadstation van de bron; de
    // gebruiker sleept hem naar de echte plek op de foto.
    const marker: [number, number] | null = cal.chargerLat && cal.chargerLng
      ? [cal.chargerLat, cal.chargerLng]
      : (isUsableChargerGps(chargerGps) ? [chargerGps.lat, chargerGps.lng] : null);
    setCopyPanel(prev => {
      if (!prev) return prev;
      const next: CopyPanelState = { ...prev, sourceSn, sourceMaps: work, canonical: work[0]?.canonicalName ?? null, marker, plan: null, error: null };
      runCopyPreview(next);
      return next;
    });
  }, [chargerGps, runCopyPreview]);

  const setCopyMarker = useCallback((lat: number, lng: number) => {
    setCopyPanel(prev => {
      if (!prev) return prev;
      const next: CopyPanelState = { ...prev, marker: [lat, lng] };
      runCopyPreview(next);
      return next;
    });
  }, [runCopyPreview]);

  const updateCopyPanel = useCallback((patch: Partial<CopyPanelState>) => {
    setCopyPanel(prev => {
      if (!prev) return prev;
      const next: CopyPanelState = { ...prev, ...patch, plan: null };
      runCopyPreview(next);
      return next;
    });
  }, [runCopyPreview]);

  const placeCopiedZone = useCallback(async () => {
    if (!sn || !copyPanel?.sourceSn || !copyPanel.canonical || !copyPanel.marker || !copyPanel.plan?.ok) return;
    const local = copyLocalFromLatLng(copyPanel.marker[0], copyPanel.marker[1]);
    if (!local) return;
    setCopyPanel(prev => (prev ? { ...prev, busy: true, error: null } : prev));
    try {
      const r = await copyZone(sn, copyPanel.sourceSn, copyPanel.canonical, local, { withObstacles: copyPanel.withObstacles, acceptChannel: true });
      if (!r.ok || !r.map) throw new Error(t('map.copyZoneFailed'));
      await reloadMaps();
      setSelectedMapId(r.map.mapId);
      setCopyPanel(null);
      const slot = r.map.canonicalName ?? '';
      toast(t('map.copyZoneDone', { name: r.map.mapName ?? slot, slot }), 'success');
      if (r.needsChannel && r.map.canonicalName) {
        setChannelPrompt({ canonical: r.map.canonicalName, name: r.map.mapName ?? r.map.canonicalName });
      }
    } catch (err) {
      setCopyPanel(prev => (prev ? { ...prev, busy: false, error: err instanceof Error ? err.message : String(err) } : prev));
    }
  }, [sn, copyPanel, copyLocalFromLatLng, reloadMaps, t, toast]);

  const copySourceName = copyPanel
    ? (copyPanel.sources.find(d => d.sn === copyPanel.sourceSn)?.nickname || copyPanel.sourceSn || '')
    : '';
```

- [ ] **Step 4: Projectie (blok B)**

Direct na het `polyCenter`-useMemo (sluit rond regel 3445; `activeCal` staat al eerder), zodat beide bestaan vóór gebruik:

```tsx
  /** Lokale meters van deze maaier → Leaflet-posities, dezelfde projectie als gpsMaps/draftOverlays. */
  const copyPositions = useCallback((pts: LocalPoint[]): [number, number][] => {
    if (!isUsableChargerGps(chargerGps)) return [];
    const offX = chargingPose?.x ?? 0;
    const offY = chargingPose?.y ?? 0;
    const gps = pts.flatMap(p => {
      const g = localToGps({ x: p.x - offX, y: p.y - offY }, chargerGps);
      return Number.isFinite(g.lat) && Number.isFinite(g.lng) ? [g] : [];
    });
    return calibratePoints(gps, activeCal, polyCenter);
  }, [chargerGps, chargingPose, activeCal, polyCenter]);
```

- [ ] **Step 5: Rail-item**

In het `railFlyout === 'edit'`-paneel, direct na de `map.drawNew`-knop (en vóór het `{!mapWriteSupported && (...)}`-blok, regel ~4438):

```tsx
                      <button
                        onClick={() => { void openCopyPanel(); setRailFlyout(null); }}
                        className={`${railRow(false)} ${!mapWriteSupported ? 'opacity-40 cursor-not-allowed' : ''}`}
                        disabled={!mapWriteSupported}
                        title={!mapWriteSupported ? t('map.drawStockNotice') : undefined}
                      >
                        <Copy className="w-4 h-4 opacity-70" />{t('map.copyZone')}
                      </button>
```

- [ ] **Step 6: Kaartlagen**

Direct na `{placingCharger && <ChargerPlacer onPlace={handlePlaceCharger} />}` (regel ~4059):

```tsx
          {/* Zone kopiëren: klik verplaatst de marker, marker is sleepbaar, preview gestippeld */}
          {copyPanel && editMode === 'none' && <ChargerPlacer onPlace={setCopyMarker} />}
          {copyPanel?.marker && (
            <Marker
              position={copyPanel.marker}
              icon={copyMarkerIcon}
              draggable
              zIndexOffset={1000}
              eventHandlers={{
                dragend: (e) => { const { lat, lng } = e.target.getLatLng(); setCopyMarker(lat, lng); },
              }}
            >
              <Tooltip direction="top" offset={[0, -12]} permanent>{t('map.copyZoneMarker', { name: copySourceName })}</Tooltip>
            </Marker>
          )}
          {copyPanel?.plan && copyPanel.plan.work.length >= 3 && (
            <Polygon positions={copyPositions(copyPanel.plan.work)} pathOptions={{ ...AREA_STYLES.work, dashArray: '6 4', fillOpacity: 0.15 }} />
          )}
          {copyPanel?.plan?.obstacles.map(o => (
            <Polygon key={`copy-${o.canonical}`} positions={copyPositions(o.points)} pathOptions={{ ...AREA_STYLES.obstacle, dashArray: '6 4', fillOpacity: 0.2 }} />
          ))}
          {copyPanel?.plan?.channels.map(c => (
            <Polyline key={`copy-${c.canonical}`} positions={copyPositions(c.points)} pathOptions={{ ...AREA_STYLES.unicom, dashArray: '6 4', weight: 4 }} />
          ))}
```

- [ ] **Step 7: Paneel**

Direct vóór `{/* Na het tekenen van een werkgebied: kanaal erheen vragen */}` (regel ~4941):

```tsx
        {/* Zone kopiëren van een andere maaier */}
        {copyPanel && editMode === 'none' && (
          <div className="absolute top-3 left-3 z-[1000] bg-gray-900/95 backdrop-blur border border-amber-600/60 rounded-lg p-3 shadow-xl w-[calc(100vw-1.5rem)] sm:w-72 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-amber-400">{t('map.copyZone')}</span>
              <button onClick={() => setCopyPanel(null)} className="text-gray-500 hover:text-gray-300" title={t('common.cancel')}>
                <X className="w-4 h-4" />
              </button>
            </div>
            {copyPanel.sources.length === 0 ? (
              <p className="text-[11px] text-gray-400">{t('map.copyZoneNoSources')}</p>
            ) : (
              <>
                <label className="block text-[11px] text-gray-400">
                  {t('map.copyZoneSource')}
                  <select
                    value={copyPanel.sourceSn ?? ''}
                    onChange={e => void chooseCopySource(e.target.value)}
                    className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
                  >
                    <option value="" disabled>{t('map.copyZoneChoose')}</option>
                    {copyPanel.sources.map(d => <option key={d.sn} value={d.sn}>{d.nickname || d.sn}</option>)}
                  </select>
                </label>
                {copyPanel.sourceSn && (
                  <label className="block text-[11px] text-gray-400">
                    {t('map.copyZoneZone')}
                    <select
                      value={copyPanel.canonical ?? ''}
                      onChange={e => updateCopyPanel({ canonical: e.target.value })}
                      className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
                    >
                      {copyPanel.sourceMaps.map(m => (
                        <option key={m.mapId} value={m.canonicalName ?? ''}>
                          {m.mapName ? `${m.mapName} (${m.canonicalName})` : m.canonicalName}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="flex items-center gap-2 text-[11px] text-gray-400">
                  <input type="checkbox" checked={copyPanel.withObstacles} onChange={e => updateCopyPanel({ withObstacles: e.target.checked })} />
                  {t('map.copyZoneWithObstacles')}
                </label>
                {copyPanel.sourceSn && (
                  <p className="text-[11px] leading-snug text-gray-400">{t('map.copyZoneHint', { name: copySourceName })}</p>
                )}
                {copyPanel.error && <p className="text-[11px] text-red-400">{copyPanel.error}</p>}
                {copyPanel.plan && (
                  <div className="text-[11px] leading-snug space-y-0.5">
                    {copyPanel.plan.ok ? (
                      <>
                        <div className="text-emerald-300">{t('map.copyZoneVerdictOk', { slot: copyPanel.plan.canonical, m2: Math.round(copyPanel.plan.areaM2) })}</div>
                        {copyPanel.plan.connectedVia && <div className="text-gray-300">{t('map.copyZoneConnected', { zone: copyPanel.plan.connectedVia })}</div>}
                        {copyPanel.plan.channels.map(c => (
                          <div key={c.canonical} className="text-blue-300">
                            {c.kind === 'dock'
                              ? t('map.copyZoneChannelDock', { m: (copyPanel.plan?.dockDistanceM ?? 0).toFixed(1) })
                              : t('map.copyZoneChannelLink', { zone: c.canonical.replace(/tomap.*$/, '') })}
                          </div>
                        ))}
                        {copyPanel.plan.needsChannel && <div className="text-amber-300">{t('map.copyZoneNeedsChannel')}</div>}
                        {copyPanel.plan.warnings.map(w => <div key={w} className="text-amber-300">{t(`map.copyZoneWarn.${w}`)}</div>)}
                      </>
                    ) : (
                      <div className="text-red-300">{copyPanel.plan.error ?? t('map.copyZoneFailed')}</div>
                    )}
                  </div>
                )}
                <div className="flex items-center gap-2 pt-1">
                  <button onClick={() => setCopyPanel(null)} className="flex-1 text-xs px-2 py-1.5 rounded bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors">
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={() => void placeCopiedZone()}
                    disabled={!copyPanel.plan?.ok || copyPanel.busy}
                    className="flex-1 text-xs px-2 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-40 transition-colors"
                  >
                    {copyPanel.busy ? t('map.copyZonePlacing') : t('map.copyZonePlace')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
```

- [ ] **Step 8: Type-check en lint**

Run: `cd dashboard && npx tsc --noEmit && npm run lint`
Expected: geen fouten. Klaagt lint over `no-use-before-define` op `copyPositions`, verplaats blok B dan naar direct vóór de `return (` van de component.

- [ ] **Step 9: Handmatige rooktest met de dev-server**

Run: `cd dashboard && npm run dev` (tegen de lokale server op poort 3000, `cd server && npm run dev`). Open de kaart van een maaier met OpenNova-firmware → Bewerken → "Zone kopiëren van andere maaier" → kies bron en zone → marker verschijnt, slepen of klikken → gestippelde zone + verdict; Annuleren sluit alles zonder resten. Plaats **niet** op een productiemaaier tijdens deze rooktest; de echte plaatsing volgt de testprocedure in de spec.

- [ ] **Step 10: Commit**

```bash
git add dashboard/src/components/map/MowerMap.tsx
git commit -m "feat(dashboard): copy a zone from another mower with a draggable dock marker and preview"
```

---

### Task 7: Documentatie en kwaliteitspoorten

**Files:**
- Modify: `docs/user-guide/dashboard.md` (sectie "Editing maps", na de bullet "Channels")
- Modify: `docs/superpowers/specs/2026-09-24-copy-zone-between-mowers-design.md` (Status-regel)

- [ ] **Step 1: Gebruikersgids**

Na de bullet die begint met `- **Channels**:` in `docs/user-guide/dashboard.md`:

```markdown
- **Copy zone from another mower**: put a work area (with its obstacles)
  that another mower on this server drove onto this mower's map. Pick the
  source mower and zone, then drag the orange marker to where the *source
  mower's* charging station really stands on this map; the zone follows.
  Two mowers never share a GPS frame (each charger broadcasts its own
  surveyed RTK base position), so this one physical reference is what
  places the copy. The preview shows the zone dashed, with the dock
  channel or the proposed channel to a neighbouring zone. A first zone must
  lie within 3 m of the dock; a later zone that overlaps or sits within
  1.5 m of an existing zone gets a channel proposed, otherwise the usual
  "draw a channel" prompt follows. After placing, check the coverage
  preview before the first mow.
```

- [ ] **Step 2: Spec-status**

Zet in de spec de Status-regel op: `**Status:** geïmplementeerd (plan 2026-09-24); live testprocedure open`.

- [ ] **Step 3: Volledige poorten**

Run:

```bash
cd server && npx vitest run && npx tsc --noEmit
cd ../dashboard && npx tsc --noEmit && npm run lint
```

Expected: alle tests groen, geen type- of lintfouten. Faalt iets buiten de nieuwe bestanden, dan is dat een regressie van dit werk: oplossen vóór de commit.

- [ ] **Step 4: Commit**

```bash
git add docs/user-guide/dashboard.md docs/superpowers/specs/2026-09-24-copy-zone-between-mowers-design.md
git commit -m "docs: describe copying a zone between mowers in the dashboard guide"
```

---

## Na het plan (niet in de taken, wel in de spec): live testprocedure

Volg spec §Testprocedure op de setup van de gebruiker (θ-check, map0 van .244 wissen, .100 map0 kopiëren naar .244, bestanden op de maaier controleren, maaipad-preview, eerste maaibeurt onder toezicht). Pas daarna een release overwegen; geen beta zonder expliciete vraag.
