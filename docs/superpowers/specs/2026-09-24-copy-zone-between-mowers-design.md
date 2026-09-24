# Zone kopiëren tussen maaiers — ontwerp

**Datum:** 2026-09-24
**Status:** goedgekeurd door gebruiker (klik-gebaseerde plaatsing, dashboard-only, obstakels mee, drempels 3 m / 1,5 m)
**Probleem:** twee maaiers in één tuin, elk met een eigen laadstation op een andere plek. Een zone die op maaier A nauwkeurig is ingereden moet op maaier B bruikbaar worden zonder opnieuw te mappen. Omdat de docks verschillen, moet de zone in B's frame terechtkomen én moet B er kunnen komen: via een kort dockkanaal, of via een kanaal naar een bestaande zone.

## Feiten waar het ontwerp op rust (live vastgesteld 2026-09-24)

1. **Maaierframe = ENU minus eigen origin, geen rotatie.** Localization is GPS/RTK-only (`docs/reference/REANCHOR.md`, Ghidra-geverifieerd); pos.json-origin en live gedockte GPS kloppen per maaier tot 10-20 cm (.244: GPS−origin (−0,06, +0,78) vs charging pose (0,03, 0,73); .100: (+0,14, −0,34) vs (0,13, −0,52)).
2. **Twee maaiers delen GEEN absoluut GPS-frame.** Elke charger zendt zijn eigen zelf-ingemeten RTK-basispositie uit; de rover is alleen relatief daaraan cm-nauwkeurig. .244 en .100 verschillen 23 m (zuivere translatie): per GPS staan hun docks 9,7 m NW van elkaar, fysiek ~20 m NO (gebruiker + drone-foto). Dus pos.json, live GPS én `map_calibration` zijn alle drie onbruikbaar als transformatiebron. Memory: `mower-gps-frames-not-shared.md`.
3. **De relatieve rotatie tussen de frames is 0** (beide ENU; een basisfout is een translatie). Nog te verifiëren met de Kabsch-fit in `GET /api/admin-status/position-trail/:sn` (`derivedThetaDeg` ≈ 0 op beide maaiers na een rit); de preview op de foto maakt een rotatie bovendien direct zichtbaar.
4. **Firmware genereert alleen het dockkanaal zelf**, als rechte lijn van het dock naar het dichtstbijzijnde kaartpunt (`chargingPileUnicomGen`, `research/documents/novabot-mapping-pgm-occupancy-flow.md`), en alleen tijdens een mapping-operatie. Tussenkanalen worden gereden, nooit gegenereerd. Server-gegenereerde lange tussenkanalen zijn eerder door een trap gelopen en teruggedraaid (`docs/reference/COSTMAP-UNICOM-NAV.md`).
5. **Bestaande flow voor een nieuwe zone** in het dashboard: `POST /api/dashboard/maps/:sn` (tekenen) → `canonicalForDrawnMap` → DB-rij → `autoPushMapsInBackground` (zip + `sync_map` + `regenerate_per_map_files`) → bij `mapN` met N≥1 de kanaal-prompt (`channelPrompt` in `MowerMap.tsx`), waarna de gebruiker een kanaal tekent (`mapKtomapN_0_unicom` of `mapNtocharge_unicom`, naam afgeleid uit de eindpunten). De kopie is "een getekende zone met voorgevulde geometrie" en volgt dit pad exact.
6. `getPolygonAnchor` / `dockPoint()` lezen het eerste punt van `mapNtocharge_unicom` als dock-anker; het dashboard projecteert opgeslagen lokale punten als `localToGps(p − chargingPose, chargerGps)` en slaat getekende punten op als `gpsToLocal(gps, chargerGps) + chargingPose`.

## Transformatie

Eén fysieke correspondentie plus rotatie 0:

```
p_B = p_A − dockA_in_A + dockA_in_B
```

- `dockA_in_A`: eerste punt van A's `map0tocharge_unicom` in de DB (`getPolygonAnchor(A)`); fallback `getDockPose(A)` als A gedockt online is; anders 409 `source_no_anchor`. A hoeft niet online te zijn.
- `dockA_in_B`: de gebruiker klikt/sleept op B's kaart (met B's drone-foto) waar het laadstation van A fysiek staat. De client rekent dat om met dezelfde formule als tekenen (`gpsToLocal(click, chargerGpsB) + chargingPoseB`) en stuurt `{x, y}` in B's lokale meters. Marker voorgevuld op A's `map_calibration.charger_lat/lng` (klopt op de setup van de gebruiker fysiek), anders het kaartcentrum.
- Nauwkeurigheid: foto-plaatsing van B plus klik, in de praktijk 10-30 cm. Een meetstand (B fysiek bij/op dock A zetten, `map_position` overnemen) is een latere, aparte toevoeging; niet in deze ronde.

## Plaatsings- en kanaalregels (pure functie, in B's frame)

Constanten bovenin de service, als knoppen: `DOCK_MAX_M = 3`, `LINK_MAX_M = 1.5`, `STEP_M = 0.25`.

Invoer: getransformeerde work-polygoon + obstakels, B's bestaande work-zones (DB), B's dock (`dockPoint(B)`: anker, anders live dockpose; ontbreekt beide → 409 `target_no_dock`), het doelslot `N = nextFreeWorkSlot(B)`.

- **Slot > 4** → 409 `slot_limit` (firmware-cap map0..map4, `multi-map-limit.md`).
- **`d_dock`** = kortste afstand van B's dock tot de rand van de kopie (0 als het dock erin ligt).
- **Slot 0 (B heeft geen map0):** dockkanaal verplicht, want het is tevens het anker voor re-anchor en `dockPoint`. Gate `d_dock ≤ DOCK_MAX_M`, anders 409 `too_far_from_dock`. Kanaal `map0tocharge_unicom` = rechte lijn dock → dichtstbijzijnde randpunt, eerste rij is het dock (firmware-conventie), verdicht per `STEP_M`, minimaal 2 punten. Kruist de lijn een gekopieerd obstakel → 409 `dock_channel_blocked`. Een bestaande rij `map0tocharge_unicom` (bv. achtergebleven na het wissen van de oude map0) wordt vervangen, zoals `naming.replaces` in de tekenroute.
- **Slot ≥ 1**, in deze volgorde:
  1. Kopie overlapt of raakt een bestaande zone K (hoekpunt binnen de ander, of randen snijden) → geen kanaal, `connectedVia: mapK`. Omsluit de een de ander volledig → waarschuwing `full_overlap` (nooit getest in firmware), geen blokkade.
  2. Kleinste opening tot een zone K `≤ LINK_MAX_M` → voorstel `mapKtomapN_0_unicom` (eerste vrije index) tussen de twee dichtstbijzijnde randpunten, verdicht; kruist het een obstakel van K of van de kopie → doorvallen naar 4.
  3. `d_dock ≤ DOCK_MAX_M` → voorstel `mapNtocharge_unicom` (zelfde generatie als slot 0; geblokkeerd → 4).
  4. Anders geen kanaal, `needsChannel: true` → het dashboard toont de bestaande kanaal-prompt (bestaand gedrag; gebruiker tekent zelf).
- Voorgestelde kanalen (2 en 3) worden in de preview getoond en pas bij "Plaatsen" met `acceptChannel: true` opgeslagen.

## Obstakels

A's `map<a>_i_obstacle` → `map<N>_j_obstacle`, j hernummerd 0..; zelfde transformatie. Standaard mee (`withObstacles: true`); daarna te verwijderen via de bestaande bewerkmodus.

## Componenten

**Service `server/src/services/zoneCopy.ts`** (pure kern + één DB-lezende orkestratie):
- `transformPoints(pts, dockA_in_A, dockA_in_B)`.
- geometrie-helpers: `distanceToPolygon` (nu privé in `canonicalNaming.ts`, wordt geëxporteerd of verhuist naar `maps/editGeometry.ts`), `polygonsOverlap`, `polygonGap` (kortste afstand + de twee randpunten), `segmentCrossesPolygon`, `straightChannel(from, to, step)`.
- `planZoneCopy(input): CopyPlan` — de regels hierboven, puur, unit-testbaar.
- `previewZoneCopy(B, A, canonical, dockAtB, opts)` — leest DB, bouwt input, geeft `CopyPlan` (`ok`, `slot`, `canonical`, `work`, `obstacles[]`, `channel {canonical, points, kind:'dock'|'link'} | null`, `connectedVia`, `needsChannel`, `warnings[]`, `refusal {reason, error}`).

**Routes in `server/src/routes/dashboard.ts`** (naast de tekenroute, achter `rejectUnlessOpenNova`):
- `POST /api/dashboard/maps/:sn/copy-from/:source/preview` body `{ canonical, dockAtB:{x,y}, withObstacles? }` → `CopyPlan`.
- `POST /api/dashboard/maps/:sn/copy-from/:source` body als preview + `{ name?, acceptChannel? }` → vereist B online (409 `offline`); herberekent het plan server-side (nooit client-geometrie vertrouwen); in één transactie `mapEditsRepo.saveVersion` (snapshot, zodat "Revert" werkt) + `mapRepo.create` voor work (`source: 'copied'`, `map_id: copy_<canonical>_<ts>`, alias = `name` of A's alias + " (kopie)"), obstakels en geaccepteerd kanaal; daarna `autoPushMapsInBackground(B)`; antwoord `{ ok, map, obstacles, channel, needsChannel }` in dezelfde vorm als de tekenroute.

**Dashboard `MowerMap.tsx`** (+ `api/client.ts`, 4 locale-bestanden):
- Rail-flyout-item naast "Tekenen": "Zone kopiëren van andere maaier".
- Paneel (zelfde stijl als de kanaal-prompt): bronmaaier (`fetchDevices`, type mower, ≠ B), zone (work-maps van A), instructie "sleep de marker naar het laadstation van maaier A", draggable marker (voorgevuld), verdict-tekst, knoppen Plaatsen/Annuleren.
- Preview-laag: gestippelde work-polygoon + obstakels + voorgesteld kanaal, herberekend (debounced) bij elke marker-verplaatsing. Plaatsen uitgeschakeld bij `refusal`.
- Na plaatsen: `reloadMaps`, nieuwe zone selecteren, bij `needsChannel` de bestaande `setChannelPrompt`.
- Geen native alerts (bestaande `useDialog`/panelen).

## Foutafhandeling en voorwaarden

- B: OpenNova-firmware (bestaande 409 `unsupported_firmware`), online voor de definitieve kopie. Niet vereist: gedockt (net als tekenen); wel aanbevolen in de UI-tekst.
- A: alleen DB-data; ontbreekt het anker → `source_no_anchor`.
- Ongeldige `dockAtB` (niet eindig, of > 500 m van B's dock) → 400.
- Push-fout: rijen blijven staan (zelfde als tekenen); de bestaande pending-sync-melding dekt dit.
- Validatie van de kopie via `validateMapSet` (zelf-snijding, minimumoppervlak, obstakel binnen work) vóór opslaan; onaangeraakte bestaande zones niet hard valideren.

## Testen

- Unit (`server/src/__tests__/services/zoneCopy.test.ts`): transformatie (identiteit bij gelijk dock; verschuiving); slot 0 dichtbij/te ver/dock-in-polygoon/geblokkeerd door obstakel; slot ≥ 1 overlap, volledige omsluiting (waarschuwing), opening ≤ 1,5 m met kanaalpunten op beide randen, opening > 1,5 m maar dock dichtbij, niets → `needsChannel`; obstakel-hernummering; slot-cap; vervangen van bestaande `map0tocharge_unicom`.
- Route (`server/src/__tests__/routes/zoneCopy.test.ts`, supertest, push gemockt zoals `mapEdit.test.ts`): preview zonder DB-mutatie, copy maakt rijen + snapshot + roept push aan, 409-paden.
- Dashboard: `npx tsc --noEmit` + `npm run lint`; handmatige test volgens onderstaande procedure.

## Testprocedure op de setup van de gebruiker

Doel: `.100` map0 (214 m², 5 obstakels) → `.244`. De gebruiker wist eerst map0 van `.244`, zodat de kopie slot 0 krijgt en het dock erin ligt.

1. Vooraf, één keer: na een korte rit van elke maaier `derivedThetaDeg` opvragen via position-trail; verwacht |θ| < 1° op beide. Afwijking > 1° = ontwerpaanname fout, stoppen.
2. `.244`: map0 wissen via het dashboard. Controleren wat achterblijft: `map3_work`, `map0tomap3_0_unicom` (blijft geldig: eindpunt (−0,01, 0,78) ligt straks in de nieuwe map0), `map0tocharge_unicom` (dock-kanaal is niet wisbaar; wordt door de kopie vervangen).
3. `.244` gedockt, online, RTK Fixed. Dashboard `.244` → Zone kopiëren → bron `.100`, zone map0 → marker op het dock van `.100` (terras, rechtsboven op de foto) → preview: slot 0, dock in polygoon, kort dockkanaal, mogelijk overlap/opening met map3.
4. Plaatsen. Op de maaier: `csv_file/` bevat `map0_work.csv` (~2495 punten), `map0_0..4_obstacle.csv`, nieuwe `map0tocharge_unicom.csv` (rij 1 ≈ (0,03, 0,73)), `map0tomap3_0_unicom.csv` ongewijzigd; `map_info.json` `map0_work.csv.map_size` ≈ 213,7; `md5sum map0.pgm map3.pgm` verschillend.
5. Dashboard "toon maaipad" voor map0: pad blijft op het gazon in de foto.
6. Eerste maaibeurt onder toezicht, stop bij de hand.

## Scope-afbakening

**Binnen:** service + twee endpoints + dashboardpaneel/preview + i18n (nl/en/de/fr) + tests + korte gebruikersdoc-sectie in `docs/user-guide/dashboard.md`.
**Buiten:** app (mobiel); meetstand via `map_position`; kopiëren van A's kanalen; automatische lange tussenkanalen; wijzigingen aan firmware/extended_commands.
