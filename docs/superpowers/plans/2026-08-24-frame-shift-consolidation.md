# Frame-verschuiving consolideren — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De bestaande visuele kaart-nudge in het dashboard écht het maaien laten verschuiven (via het bewezen `apply-polygon-offset`-mechanisme), en de overlappende/dode frame-tools opruimen zodat er per laag één duidelijk benoemde tool overblijft.

**Architecture:** Geen nieuwe mechaniek. De dashboard-nudge-pijltjes (nu display-only `offset_lat/lng`) worden herbedraad naar `apply-polygon-offset`, dat `polygon_offset_x_m/y_m` zet, de kaart regenereert en via `sync_map`+`save_map type:1` naar de maaier stuurt. De route verhuist van de admin-gate naar de dashboard-router. Dode code (#2) en de losse admin-UI van #4 verdwijnen; de display-only correctie blijft maar wordt helder gelabeld.

**Tech Stack:** TypeScript (Node + better-sqlite3, Express), React + Vite + Leaflet (dashboard), vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-frame-shift-consolidation-design.md`

## Global Constraints

- **Nederlands** in proza, comments en commit messages; NOOIT em-dashes in proza.
- **Geen Co-Authored-By Claude** / AI-attributie in commits.
- Alleen de bestanden stagen die je raakt; werktree heeft ongerelateerde pending changes — nooit `git add -A`.
- Test-DB isolatie: NOOIT `process.env.DB_PATH` in test setup; `vitest.config.ts` regelt `:memory:`.
- Bewegings-/maai-effecten alleen na expliciete gebruikersbevestiging; Fase 0 (richting-verificatie) vereist gebruiker + draaiende maaier vóór livegang.
- `apply-polygon-offset` zet de offset ABSOLUUT (`mapRepo.setPolygonOffset`), stapelt niet. Body = `{ dx_m, dy_m }` in meters, `|.| ≤ MAX_OFFSET_M`.
- Lokaal frame: `+x = oost`, `+y = noord` (uit `gpsToLocal`: `mx=(lng-olng)*mPerDegLng`, `my=(lat-olat)*mPerDegLat`).
- `restore-and-realign` leunt op `polygon_offset_x_m/y_m` via de DB (niet via de HTTP-route) — die kolommen en `regenerateLatestZipFromBackup` blijven ongemoeid.

---

### Task 0: Fase 0 — richting/teken verifiëren op de maaier

Geen code. Handmatige verificatie, vereist de gebruiker en een draaiende maaier; blokkeert livegang van Task 3. Leg de uitkomst vast in de spec.

**Files:**
- Modify (resultaat-notitie): `docs/superpowers/specs/2026-08-24-frame-shift-consolidation-design.md`

- [ ] **Step 1: Bevestig de as-afbeelding op een bekend punt**

Met een geïmplementeerde Task 1-3 op de beta, of met een directe `curl` naar `apply-polygon-offset`: zet een kleine bekende offset (bv. `dx_m: 0.2, dy_m: 0`) en verifieer op de maaier dat de grens 20cm OOST schuift (niet west), en dat een gewone maaibeurt daardoor 20cm oost maait. Draai daarna terug naar `0,0`.

```bash
# lees de huidige coverage/grens vóór en ná; controleer de richting fysiek of via map_position
sshpass -p 'novabot' ssh root@192.168.0.100 "grep -i 'origin' /userdata/lfi/maps/home0/map0.yaml"
```
Expected: `+dx_m` = grens naar oost, `+dy_m` = grens naar noord. **Zo NIET** (teken/as omgekeerd): noteer de werkelijke afbeelding zodat Task 3 de nudge-richting daarop mapt.

- [ ] **Step 2: Leg vast + commit**

```bash
git add docs/superpowers/specs/2026-08-24-frame-shift-consolidation-design.md
git commit -m "docs: Fase 0 richting-verificatie apply-polygon-offset vastgelegd"
```

---

### Task 1: Verplaats `apply-polygon-offset` naar de dashboard-router

De route zit nu achter `authMiddleware + adminMiddleware` (`index.ts:247`); het dashboard roept geen admin-routes aan. Verhuis de route identiek naar de dashboard-router zodat de nudge-UI (dashboard-auth) hem kan aanroepen. De admin-HTML-UI vervalt in Task 6.

**Files:**
- Modify: `server/src/routes/adminStatus.ts` (verwijder de `adminStatusRouter.post('/maps/:sn/apply-polygon-offset', ...)` route, ~3720-3806)
- Modify: `server/src/routes/dashboard.ts` (voeg dezelfde route toe als `dashboardRouter.post('/maps/:sn/apply-offset', ...)`)
- Test: `server/src/__tests__/routes/applyOffsetRoute.test.ts`

**Interfaces:**
- Consumes: `mapRepo.setPolygonOffset(sn, dx, dy)`, `regenerateLatestZipFromBackup(sn)`, `publishToExtended`, `publishToDevice`, `onExtendedResponse`/`offExtendedResponse` (of het exacte sync_map-await-patroon dat de bestaande route gebruikt).
- Produces: `POST /api/dashboard/maps/:sn/apply-offset` body `{ dx_m:number, dy_m:number }` → `{ ok, dx_m, dy_m, syncResult }`; 400 bij niet-eindig of `|.|>MAX_OFFSET_M`.

- [ ] **Step 1: Schrijf de falende test (pure validatie via de dashboard-route)**

De sync/MQTT-kant vergt mocks zoals de andere dashboard-route-tests; test de validatie + dat `setPolygonOffset` wordt aangeroepen. Volg het `vi.mock`-patroon van `edgeDaysDto.test.ts` / `dashboardSystemLogs.test.ts`.

```typescript
// server/src/__tests__/routes/applyOffsetRoute.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
// mock mapSync (publishToExtended/publishToDevice) en mapRepo zodat geen echte MQTT/DB nodig is
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToExtended: vi.fn(), publishToDevice: vi.fn(),
  onExtendedResponse: vi.fn(), offExtendedResponse: vi.fn(),
  awaitCommand: vi.fn(), applyVerbatimToMower: vi.fn(),
}));
const setPolygonOffset = vi.fn();
vi.mock('../../db/repositories/index.js', async (orig) => {
  const m = await orig() as any;
  return { ...m, mapRepo: { ...m.mapRepo, setPolygonOffset } };
});

describe('POST /api/dashboard/maps/:sn/apply-offset', () => {
  beforeEach(() => setPolygonOffset.mockClear());
  it('wijst niet-eindige dx/dy af met 400', async () => {
    const { validateOffsetBody } = await import('../../routes/dashboard.js');
    expect(validateOffsetBody({ dx_m: 'x', dy_m: 0 })).toEqual({ ok: false });
    expect(validateOffsetBody({ dx_m: 0.1, dy_m: 0.2 })).toEqual({ ok: true, dx: 0.1, dy: 0.2 });
  });
});
```

- [ ] **Step 2: Run — verwacht FAIL**

Run: `cd server && npx vitest run src/__tests__/routes/applyOffsetRoute.test.ts`
Expected: FAIL — `validateOffsetBody` bestaat niet / route niet verplaatst.

- [ ] **Step 3: Implementeer**

3a. Knip de volledige route-body uit `adminStatus.ts` (`adminStatusRouter.post('/maps/:sn/apply-polygon-offset', ...)`). Controleer welke imports daardoor ongebruikt raken in `adminStatus.ts` en verwijder alleen die.

3b. Plak in `dashboard.ts` als `dashboardRouter.post('/maps/:sn/apply-offset', ...)`. Voeg bovenaan (bij de andere helpers) een exporteerbare pure validator toe en gebruik die in de route:
```typescript
export function validateOffsetBody(body: unknown): { ok: true; dx: number; dy: number } | { ok: false } {
  const b = body as { dx_m?: unknown; dy_m?: unknown };
  const dx = typeof b.dx_m === 'number' ? b.dx_m : NaN;
  const dy = typeof b.dy_m === 'number' ? b.dy_m : NaN;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { ok: false };
  return { ok: true, dx, dy };
}
```
Zorg dat de route dezelfde `MAX_OFFSET_M`-grens, `setPolygonOffset`, regen + `sync_map`-await + `save_map type:1` doet als het origineel (kopieer verbatim, alleen router + pad gewijzigd). Importeer wat de route nodig heeft in `dashboard.ts` (veel is er al).

- [ ] **Step 4: Run — verwacht PASS + tsc**

Run: `cd server && npx vitest run src/__tests__/routes/applyOffsetRoute.test.ts && npx tsc --noEmit`
Expected: PASS, geen type-fouten.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/dashboard.ts server/src/routes/adminStatus.ts server/src/__tests__/routes/applyOffsetRoute.test.ts
git commit -m "refactor(api): apply-polygon-offset van admin naar dashboard-router (nudge gaat dit aanroepen)"
```

---

### Task 2: Dashboard API-client — offset lezen + toepassen

**Files:**
- Modify: `dashboard/src/api/client.ts`
- Test: geen (dunne fetch-wrappers; gedekt door tsc + Task 3-gebruik)

**Interfaces:**
- Consumes: `POST /api/dashboard/maps/:sn/apply-offset` (Task 1); bestaande calibration-GET voor de huidige offset.
- Produces:
  - `applyPolygonOffset(sn: string, dxM: number, dyM: number): Promise<{ ok: boolean; error?: string }>`
  - `fetchPolygonOffset(sn: string): Promise<{ dxM: number; dyM: number }>` (0,0 als er geen is)

- [ ] **Step 1: Implementeer de twee client-functies**

Zoek in `client.ts` hoe bestaande dashboard-calls `apiFetch` gebruiken en volg dat patroon exact.
```typescript
export async function applyPolygonOffset(sn: string, dxM: number, dyM: number): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`/api/dashboard/maps/${encodeURIComponent(sn)}/apply-offset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dx_m: dxM, dy_m: dyM }),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok && j.ok !== false, error: j.error };
}

// Huidige absolute offset, om een nudge-sessie vanaf te starten (apply is absoluut).
// GET /api/dashboard/calibration/:sn geeft { calibration: <map_calibration row> } via
// mapRepo.getCalibration (SELECT *), dus polygon_offset_x_m/y_m zit erin (bevestigd
// dashboard.ts:2532, maps.ts:221). Geen DTO-uitbreiding nodig.
export async function fetchPolygonOffset(sn: string): Promise<{ dxM: number; dyM: number }> {
  try {
    const res = await apiFetch(`/api/dashboard/calibration/${encodeURIComponent(sn)}`);
    const j = await res.json().catch(() => ({}));
    const cal = j?.calibration ?? {};
    return { dxM: Number(cal.polygon_offset_x_m ?? 0) || 0, dyM: Number(cal.polygon_offset_y_m ?? 0) || 0 };
  } catch { return { dxM: 0, dyM: 0 }; }
}
```

- [ ] **Step 2: Type-check**

Run: `cd dashboard && npx tsc --noEmit -p tsconfig.app.json`
Expected: geen fouten.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/api/client.ts
git commit -m "feat(dashboard): api-client applyPolygonOffset + fetchPolygonOffset"
```

---

### Task 3: Herbedraad de nudge-pijltjes naar het maai-verschuif-mechanisme

De grote task. De nudge accumuleert nu `offsetLat/offsetLng` (graden) in `editCal` met live-preview, en "opslaan" schrijft een display-only offset. Verander alleen wat "Toepassen" doet: converteer de geaccumuleerde offset naar meters en roep `applyPolygonOffset` aan; start de sessie vanaf de huidige absolute offset; toon offline-status; voeg een reset toe. De preview-render blijft.

**Files:**
- Modify: `dashboard/src/components/map/MowerMap.tsx` (`nudge`, `startCalibrating`, `handleSaveCalibration`/apply, de knop-JSX rond 3755-3775, `NUDGE_STEP`)
- Test: handmatig (Vite) + `tsc`/build

**Interfaces:**
- Consumes: `applyPolygonOffset`, `fetchPolygonOffset` (Task 2); `metersPerDegLat/Lng` (client-side helper of inline).
- Produces: nudge "Toepassen" → maaier-sync; "Reset" → offset 0,0 + sync.

- [ ] **Step 1: Sessie starten vanaf de huidige offset**

In `startCalibrating`: haal `fetchPolygonOffset(sn)` op en zet de begin-`editCal` zo dat de preview de reeds toegepaste offset toont (converteer meters→graden voor de preview-state, of houd de edit-state in meters — kies meters om dubbele conversie te vermijden en pas de preview-render daarop aan). Documenteer de keuze in een Nederlandse comment.

- [ ] **Step 2: Fijnere stap voor cm-correctie**

`NUDGE_STEP` is nu ~0.55m/0.35m (graden). Voeg een meter-gebaseerde stap toe (bv. 0.05m) zodat een 10cm-correctie haalbaar is. Toon de huidige totale offset in meters naast de pijltjes (`dx: +0.10 m oost, dy: 0 m`).

- [ ] **Step 3: "Toepassen" roept het maai-mechanisme aan**

Vervang de display-only opslag in de apply-handler door:
```typescript
// editCal is in meters (Step 1). +x oost, +y noord — zelfde frame als shiftPoints.
const r = await applyPolygonOffset(sn, editCal.dxM, editCal.dyM);
if (!r.ok) { toast(r.error ?? 'Verschuiven mislukt', 'error'); return; }
toast('Maaigebied verschoven en naar de maaier gestuurd', 'success');
```
Bij maaier offline: `applyPolygonOffset` geeft de server-melding "mower will pick up offset on next reconnect" door — toon die als waarschuwing, geen error.

- [ ] **Step 4: Reset-knop**

Een "Terugzetten"-knop die `applyPolygonOffset(sn, 0, 0)` stuurt (offset op nul, resync), met bevestiging.

- [ ] **Step 5: Preview == apply**

Zorg dat de preview-render dezelfde transform toont als `shiftPoints` toepast, inclusief dat het dok-ankerpunt (unicom punt 0) NIET meeschuift, zodat wat je ziet is wat de maaier doet. Als de huidige preview alle punten schuift, sluit punt 0 van de unicom uit in de preview-math. Comment in het Nederlands waarom.

- [ ] **Step 6: Labels**

Herbenoem de knop/sectie naar "Maaigebied verschuiven" met subtekst dat dit de maaier stuurt (niet alleen de weergave). i18n-sleutels in en/nl/de/fr.

- [ ] **Step 7: Type-check + build + handmatige test**

Run: `cd dashboard && npx tsc --noEmit -p tsconfig.app.json && npm run build`
Expected: groen. Handmatig (beta): nudge → preview schuift → Toepassen → maaier-sync bevestigd; Reset zet terug; offline toont waarschuwing.

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/components/map/MowerMap.tsx dashboard/src/i18n/locales/*.json
git commit -m "feat(dashboard): kaart-nudge verschuift nu echt het maaigebied (via apply-offset) i.p.v. alleen de weergave"
```

---

### Task 4: Verwijder dode code #2 (relocateCharger)

**Files:**
- Modify: `server/src/routes/dashboard.ts` (verwijder de `relocateCharger`-tak ~2559-2627)
- Modify: `dashboard/src/i18n/locales/{en,nl,de,fr}.json` (verwijder ongebruikte `chargerMoveTitle`/`chargerRelocated`)
- Test: bestaande suite blijft groen (niets consumeert de tak)

- [ ] **Step 1: Verifieer dood + verwijder**

Bevestig geen enkele caller: `grep -rn "relocateCharger" dashboard/src server/src` toont alleen de definitie en de reeds-verwijderde dialoog-referentie. Verwijder de `if (relocateCharger && ...)`-tak en de nu ongebruikte body-velden/typing. Verwijder de twee wees-i18n-sleutels.

- [ ] **Step 2: tsc + suite**

Run: `cd server && npx tsc --noEmit && npx vitest run` en `cd dashboard && npx tsc --noEmit -p tsconfig.app.json`
Expected: groen; geen referentie naar de verwijderde symbolen.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/dashboard.ts dashboard/src/i18n/locales/en.json dashboard/src/i18n/locales/nl.json dashboard/src/i18n/locales/de.json dashboard/src/i18n/locales/fr.json
git commit -m "cleanup: dode relocateCharger-tak + wees-i18n verwijderd (#2 uit inventaris)"
```

---

### Task 5: Verwijder #4's admin-HTML-UI + herlabel de display-only correctie

**Files:**
- Modify: `server/src/routes/adminPage.ts` (verwijder het polygon-offset-blok ~5262-5420)
- Modify: `dashboard/src/components/map/MowerMap.tsx` en/of `dashboard/src/pages/SettingsPage.tsx` + i18n (label de display-only `offset_lat/lng`-correctie expliciet "alleen satellietkaart, raakt het maaien niet")

- [ ] **Step 1: Verwijder de admin-offset-UI**

Haal het `apply-polygon-offset`-formulier uit de admin-HTML-pagina (de route is al verhuisd in Task 1; de admin-UI zou nu een 404/verkeerd pad aanroepen). Verwijder alleen dat blok, laat de rest van de pagina intact.

- [ ] **Step 2: Herlabel de display-only correctie**

Zoek de display-only kalibratie (charger-pin / `offset_lat/lng`-weergave) en pas het label/hulptekst aan naar iets als "Weergave-uitlijning (alleen satellietkaart)" met een regel dat het het maaien niet verandert. i18n in 4 talen. Verwijder de functie NIET (de render-math gebruikt 'm).

- [ ] **Step 3: tsc/build + commit**

Run: `cd dashboard && npx tsc --noEmit -p tsconfig.app.json && npm run build`
```bash
git add server/src/routes/adminPage.ts dashboard/src/components/map/MowerMap.tsx dashboard/src/pages/SettingsPage.tsx dashboard/src/i18n/locales/*.json
git commit -m "cleanup: admin polygon-offset-UI weg (dashboard vervangt); display-only correctie herlabeld"
```

---

### Task 6: Integratie-verificatie

**Files:** geen.

- [ ] **Step 1: Volledige gates**

Run: `cd server && npx tsc --noEmit && npx vitest run` en `cd dashboard && npx tsc --noEmit -p tsconfig.app.json && npm run build`
Expected: alles groen (serversuite is bekend ~1/4 flaky op 3 tests; herdraai bij die 3, faalt hij op iets anders → echt).

- [ ] **Step 2: Handmatige e2e (gebruiker, na Fase 0)**

Op een maaier (na Task 0-richtingverificatie): nudge in het dashboard, Toepassen, en bevestig dat een maaibeurt de verschoven grens volgt. Reset zet terug. Meld op te leveren + het bekende dok-anker-minpunt.

---

## Zelf-review (uitgevoerd)

- **Spec-dekking:** herbedraden nudge→#4 (T1-3), #2 weg (T4), admin-UI weg + display-only herlabeld (T5), Fase-0 richting (T0), e2e (T6). Alle spec-secties gedekt. `restore-and-realign`/kolommen bewust ongemoeid.
- **Placeholders:** geen TBD/TODO; elke code-stap heeft concrete code of een concrete verificatie-instructie. Task 2/3 bevatten twee expliciete "bevestig de exacte route/veldnaam"-checks — dat zijn gerichte verificaties, geen open placeholders.
- **Type-consistentie:** `applyPolygonOffset(sn,dxM,dyM)`, `fetchPolygonOffset(sn)→{dxM,dyM}`, `validateOffsetBody`, route `/api/dashboard/maps/:sn/apply-offset`, body `{dx_m,dy_m}` consistent tussen T1 (definitie) en T2/T3 (gebruik). `+x=oost,+y=noord` consistent gebruikt.
