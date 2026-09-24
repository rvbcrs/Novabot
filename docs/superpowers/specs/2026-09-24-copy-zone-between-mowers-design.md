# Zone kopiëren tussen maaiers — ontwerp

**Datum:** 2026-09-24
**Status:** goedgekeurd door gebruiker (klik-gebaseerde plaatsing, dashboard-only, obstakels mee, drempels 3 m / 1,5 m); kanaalregels verfijnd na vondst dat `deleteWithCascade` van map0 ook `map0tocharge_unicom` en `map0tomap3_0_unicom` wist
**Plan:** `docs/superpowers/plans/2026-09-24-copy-zone-between-mowers.md`
**Probleem:** twee maaiers in één tuin, elk met een eigen laadstation op een andere plek. Een zone die op maaier A nauwkeurig is ingereden moet op maaier B bruikbaar worden zonder opnieuw te mappen. Omdat de docks verschillen, moet de zone in B's frame terechtkomen én moet B er kunnen komen: via een kort dockkanaal, of via een kanaal naar een bestaande zone.

## Feiten waar het ontwerp op rust (live vastgesteld 2026-09-24)

1. **Maaierframe = ENU minus eigen origin, geen rotatie.** Localization is GPS/RTK-only (`docs/reference/REANCHOR.md`, Ghidra-geverifieerd); pos.json-origin en live gedockte GPS kloppen per maaier tot 10-20 cm (.244: GPS−origin (−0,06, +0,78) vs charging pose (0,03, 0,73); .100: (+0,14, −0,34) vs (0,13, −0,52)).
2. **Twee maaiers delen GEEN absoluut GPS-frame.** Elke charger zendt zijn eigen zelf-ingemeten RTK-basispositie uit; de rover is alleen relatief daaraan cm-nauwkeurig. .244 en .100 verschillen 23 m (zuivere translatie): per GPS staan hun docks 9,7 m NW van elkaar, fysiek ~20 m NO (gebruiker + drone-foto). Dus pos.json, live GPS én `map_calibration` zijn alle drie onbruikbaar als transformatiebron. Memory: `mower-gps-frames-not-shared.md`.
3. **De relatieve rotatie tussen de frames is 0** (beide ENU; een basisfout is een translatie). Nog te verifiëren met de Kabsch-fit in `GET /api/admin-status/position-trail/:sn` (`derivedThetaDeg` ≈ 0 op beide maaiers na een rit); de preview op de foto maakt een rotatie bovendien direct zichtbaar.
4. **Firmware genereert alleen het dockkanaal zelf**, als rechte lijn van het dock naar het dichtstbijzijnde kaartpunt (`chargingPileUnicomGen`, `research/documents/novabot-mapping-pgm-occupancy-flow.md`), en alleen tijdens een mapping-operatie. Tussenkanalen worden gereden, nooit gegenereerd. Server-gegenereerde lange tussenkanalen zijn eerder door een trap gelopen en teruggedraaid (`docs/reference/COSTMAP-UNICOM-NAV.md`).
5. **Bestaande flow voor een nieuwe zone** in het dashboard: `POST /api/dashboard/maps/:sn` (tekenen) → `canonicalForDrawnMap` → DB-rij → `autoPushMapsInBackground` (zip + `sync_map` + `regenerate_per_map_files`) → bij `mapN` met N≥1 de kanaal-prompt (`channelPrompt` in `MowerMap.tsx`), waarna de gebruiker een kanaal tekent (`mapKtomapN_0_unicom` of `mapNtocharge_unicom`, naam afgeleid uit de eindpunten). De kopie is "een getekende zone met voorgevulde geometrie" en volgt dit pad exact, inclusief `source: 'drawn'` (de bestaande `MapSource`-union).
6. `getPolygonAnchor` / `dockPoint()` lezen het eerste punt van `mapNtocharge_unicom` als dock-anker; het dashboard projecteert opgeslagen lokale punten als `localToGps(p − chargingPose, chargerGps)` en slaat getekende punten op als `gpsToLocal(gps, chargerGps) + chargingPose`.
7. **`deleteWithCascade` van een werkgebied wist alles met dat prefix**: obstakels én alle kanalen waarin het slot voorkomt (`map0to*`, `*tomap0_*`, `map0tocharge_unicom`). Na het wissen van map0 blijft een eventuele map3 dus verweesd achter, zonder anker en zonder kanaal. De kopie moet dat kunnen herstellen.

## Transformatie

Eén fysieke correspondentie plus rotatie 0:

```
p_B = p_A − dockA_in_A + dockA_in_B
```

- `dockA_in_A`: eerste punt van A's `map0tocharge_unicom` in de DB (`getPolygonAnchor(A)`); fallback `getDockPose(A)` als A gedockt online is; anders 409 `source_no_anchor`. A hoeft niet online te zijn.
- `dockA_in_B`: de gebruiker klikt/sleept op B's kaart (met B's drone-foto) waar het laadstation van A fysiek staat. De client rekent dat om met dezelfde formule als tekenen (`gpsToLocal(click, chargerGpsB) + chargingPoseB`) en stuurt `{x, y}` in B's lokale meters. Marker voorgevuld op A's `map_calibration.charger_lat/lng` (klopt op de setup van de gebruiker fysiek), anders B's laadstation.
- Nauwkeurigheid: foto-plaatsing van B plus klik, in de praktijk 10-30 cm. Een meetstand (B fysiek bij/op dock A zetten, `map_position` overnemen) is een latere, aparte toevoeging; niet in deze ronde.

## Plaatsings- en kanaalregels (pure functie `planZoneCopy`, in B's frame)

Constanten bovenin de service, als knoppen: `DOCK_MAX_M = 3`, `LINK_MAX_M = 1.5`, `STEP_M = 0.25`, `MAX_SLOT = 4`.

Invoer: getransformeerde work-polygoon + obstakels, B's bestaande work-zones met hun obstakels (DB), B's dock (`dockPoint(B)`: anker, anders live dockpose), het doelslot `N = nextFreeWorkSlot(B)`.

- **Slot > 4** → weigering `slot_limit` (firmware-cap map0..map4, `multi-map-limit.md`). **Geen dock bekend** → `target_no_dock`.
- **`d_dock`** = kortste afstand van B's dock tot de rand van de kopie (0 als het dock erin ligt).
- **Stap 1, verbinding met bestaande zones (elk slot):**
  - overlapt of raakt de kopie een bestaande zone K (hoekpunt binnen de ander, of randen snijden) → `connectedVia: mapK`, geen tussenkanaal. Omsluit de een de ander volledig → waarschuwing `full_overlap` (nooit getest in firmware), geen blokkade;
  - anders: kleinste opening tot een zone K `≤ LINK_MAX_M` → voorstel `mapKtomapN_<i>_unicom` (eerste vrije index) tussen de twee dichtstbijzijnde randpunten, verdicht per `STEP_M`; kruist het een obstakel van K of van de kopie → geen voorstel.
- **Stap 2, dockkanaal:** verplicht voor slot 0 (het is ook het anker voor re-anchor en `dockPoint`); voor slot ≥ 1 alleen als stap 1 niets opleverde. Gate `d_dock ≤ DOCK_MAX_M`. Kanaal `mapNtocharge_unicom` = rechte lijn dock → dichtstbijzijnde randpunt, eerste rij is het dock (firmware-conventie), verdicht per `STEP_M`, minimaal 2 punten. Kruist de lijn een gekopieerd obstakel → slot 0: weigering `dock_channel_blocked`, anders geen dockkanaal. Te ver → slot 0: weigering `too_far_from_dock`, anders geen dockkanaal. Een bestaande rij met dezelfde canonieke naam wordt vervangen (`replaces`).
- **Uitkomst:** `channels[]` (0, 1 of 2: dock en/of link), `connectedVia`, `needsChannel = geen verbinding én geen kanaal` → het dashboard toont de bestaande kanaal-prompt (bestaand gedrag; gebruiker tekent zelf). Heeft B andere zones, is er geen verbinding/link maar wél een dockkanaal → waarschuwing `existing_zones_unlinked`.
- Voorgestelde kanalen worden in de preview getoond en pas bij "Plaatsen" (`acceptChannel`, standaard aan) opgeslagen.

Concreet voor het testgeval (map0 van .244 gewist, map3 blijft, kopie wordt map0 met het dock erin): dockkanaal `map0tocharge_unicom` + voorstel `map3tomap0_0_unicom` als de opening ≤ 1,5 m is.

## Obstakels

A's `map<a>_i_obstacle` → `map<N>_j_obstacle`, j hernummerd 0..; zelfde transformatie. Standaard mee (`withObstacles: true`); daarna te verwijderen via de bestaande bewerkmodus.

## Componenten

**Service `server/src/services/zoneCopy.ts`** (pure kern + DB-orkestratie):
- `transformPoints(pts, dockAInA, dockAInB)`.
- geometrie: `nearestBoundaryPoint`, `polygonsOverlap`, `polygonGap`, `segmentCrossesPolygon`, `straightChannel`; hergebruik van `pointInPolygon`, `polygonContains`, `polygonArea`, `segIntersects` (`maps/editGeometry.ts`, laatste wordt geëxporteerd) en `distanceToPolygon`, `dockPoint`, `workSlots`, `nextChannelIndex`, `nextFreeWorkSlot` (`services/canonicalNaming.ts`, de privé-helpers worden geëxporteerd).
- `planZoneCopy(input): CopyPlan` — de regels hierboven, puur, unit-testbaar.
- `previewZoneCopy(B, A, canonical, dockAtB, opts, T)` — leest DB, bouwt input, geeft plan + `sourceAlias` + `areaM2`, of een invoerfout (400/404/409).
- `persistZoneCopy(B, plan, {alias, acceptChannel})` — schrijft work + obstakels + geaccepteerde kanalen in één transactie; vervangt bestaande rijen met dezelfde canonieke naam.

**Routes in `server/src/routes/dashboard.ts`** (naast de tekenroute, achter `rejectUnlessOpenNova`):
- `POST /api/dashboard/maps/:sn/copy-from/:source/preview` body `{ canonical, dockAtB:{x,y}, withObstacles? }` → 200 met `CopyPlan` (+ `sourceAlias`, `areaM2`, leesbare `error` bij een refusal); 400/404/409 bij ongeldige invoer.
- `POST /api/dashboard/maps/:sn/copy-from/:source` body als preview + `{ name?, acceptChannel? }` → vereist B online (409 `offline`); herberekent het plan server-side (nooit client-geometrie vertrouwen); 409 met refusal-tekst als het plan weigert; anders `persistZoneCopy` + `autoPushMapsInBackground(B)`; antwoord `{ ok, map, obstacles, channels, needsChannel, warnings }` met `map` in dezelfde vorm als de tekenroute. Alias = `name`, anders A's alias + " (kopie)", anders geen alias.

**Dashboard `MowerMap.tsx`** (+ `api/client.ts`, 4 locale-bestanden):
- Rail-flyout-item onder "Bewerken" naast "Nieuw gebied tekenen": "Zone kopiëren van andere maaier".
- Paneel (zelfde stijl als de kanaal-prompt): bronmaaier (`fetchDevices`, type mower, ≠ B), zone (work-maps van A), obstakels-vinkje, instructie, verdict-tekst, knoppen Annuleren/Plaatsen.
- Oranje sleepbare marker (klik op de kaart verplaatst hem ook, via de bestaande `ChargerPlacer`), voorgevuld op A's kalibratiepositie.
- Preview-laag: gestippelde work-polygoon (groen), obstakels (rood), kanalen (blauw), herberekend (250 ms debounce) bij elke wijziging. Plaatsen uitgeschakeld zolang het plan weigert.
- Na plaatsen: `reloadMaps`, nieuwe zone selecteren, toast, bij `needsChannel` de bestaande `setChannelPrompt`.
- Geen native alerts.

## Foutafhandeling en voorwaarden

- B: OpenNova-firmware (bestaande 409 `unsupported_firmware`), online voor de definitieve kopie. Niet vereist: gedockt (net als tekenen).
- A: alleen DB-data; ontbreekt het anker → `source_no_anchor`.
- Ongeldige `dockAtB` (niet eindig) → 400 `bad_dock`; meer dan 500 m van B's dock → 400 `dock_too_far`.
- Validatie van de kopie: alleen puntenaantal (≥ 3) en minimumoppervlak (`MIN_WORK_AREA_M2`, 409 `too_small`). Géén zelf-snijdingscheck: maaier-polygonen zijn vaak licht zelf-kruisend door GPS-ruis (zie `mapEdit.ts`), en de zone was op A al maaibaar. Obstakels worden vertrouwd zoals ze van de maaier kwamen.
- Push-fout: rijen blijven staan (zelfde als tekenen); de bestaande pending-sync-melding dekt dit. Ongedaan maken = de zone verwijderen (bestaande delete, cascade).
- Nieuwe servertekst gaat in `services/apiText.catalog.ts` (nl-sleutel, en/fr/de), anders faalt `serverText.coverage.test.ts`.

## Testen

- Unit (`server/src/__tests__/services/zoneCopy.test.ts`): geometrie-helpers; `planZoneCopy` per regel (slot 0 dichtbij/te ver/dock-in-polygoon/geblokkeerd; slot ≥ 1 overlap, volledige omsluiting, opening ≤ 1,5 m, opening > 1,5 m met dock dichtbij, niets; geblokkeerd tussenkanaal; slot 0 met verweesde zone; obstakel-hernummering; slot-cap; vervangen dockkanaal); `previewZoneCopy`/`persistZoneCopy` tegen de in-memory DB.
- Route (`server/src/__tests__/routes/dashboardZoneCopy.test.ts`, supertest, push gemockt zoals `dashboardMapWriteStock.test.ts`): preview zonder DB-mutatie, copy maakt rijen + roept `sync_map` aan, 409-paden, stock-firmware-gate.
- Dashboard: `npx tsc --noEmit` + `npm run lint`; handmatige test volgens onderstaande procedure.

## Testprocedure op de setup van de gebruiker

Doel: `.100` map0 (214 m², 5 obstakels) → `.244`. De gebruiker wist eerst map0 van `.244`, zodat de kopie slot 0 krijgt en het dock erin ligt.

1. Vooraf, één keer: na een korte rit van elke maaier `derivedThetaDeg` opvragen via position-trail; verwacht |θ| < 1° op beide. Afwijking > 1° = ontwerpaanname fout, stoppen.
2. `.244`: map0 wissen via het dashboard. Verwachte staat daarna (cascade): alleen `map3_work` over; `map0tocharge_unicom` en `map0tomap3_0_unicom` zijn weg, ook op de maaier.
3. `.244` gedockt, online, RTK Fixed. Dashboard `.244` → Bewerken → Zone kopiëren → bron `.100`, zone map0 → marker op het dock van `.100` (terras, rechtsboven op de foto) → preview: "Wordt map0", dockkanaal (dock ligt in de zone), voorstel `map3tomap0_0_unicom` of overlap met map3.
4. Plaatsen. Op de maaier: `csv_file/` bevat `map0_work.csv` (~2495 punten), `map0_0..4_obstacle.csv`, `map0tocharge_unicom.csv` (rij 1 ≈ (0,03, 0,73)), `map3tomap0_0_unicom.csv`; `map_info.json` `map0_work.csv.map_size` ≈ 213,7; `md5sum map0.pgm map3.pgm` verschillend.
5. Dashboard "toon maaipad" voor map0: pad blijft op het gazon in de foto.
6. Eerste maaibeurt onder toezicht, stop bij de hand.

## Scope-afbakening

**Binnen:** service + twee endpoints + dashboardpaneel/preview + i18n (nl/en/de/fr) + servertekst-catalogus + tests + korte sectie in `docs/user-guide/dashboard.md`.
**Buiten:** app (mobiel); meetstand via `map_position`; kopiëren van A's kanalen; automatische lange tussenkanalen; wijzigingen aan firmware/extended_commands; versie-snapshot/revert (delete met cascade volstaat).
