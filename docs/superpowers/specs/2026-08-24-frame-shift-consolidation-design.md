# Frame-verschuiving consolideren — ontwerp

**Datum:** 2026-08-24
**Status:** goedgekeurde vorm (gebruiker akkoord), open technische punten benoemd
**Probleem:** er zijn 8 overlappende functies die iets met kaart/frame/dok verschuiven, plus 1 dood stuk code. Het is onduidelijk welke het echte maaien raakt. Concreet geval: de RTK-antenne is door wind ~10cm verschoven, het hele gazon maait 10cm verkeerd, en er is geen simpele "verschuif het frame zonder rondrijden"-tool. De gebruiker wil consolideren naar één tool per laag met eerlijke namen.

## Inventaris (read-only vastgesteld, `frame-features-inventory.md`)

| # | Functie | Laag | Raakt live maaien | Rijdt |
|---|---------|------|-------------------|-------|
| 1 | Charger-pin plaatsen | server-weergave | nee | nee |
| 3 | "Kaart kalibratie" pijltjes | server-weergave | nee | nee |
| 2 | Charger relocate | DB-geometrie | dood/onbereikbaar | — |
| 4 | Admin polygon-offset | DB-geometrie → maaier | ja (na sync_map) | nee |
| 5 | Re-anchor wizard | live frame (pos.json) | ja | ja |
| 6 | Recalibrate charging pose | dok-pose | dok | nee (reboot) |
| 7 | Kalibreer laadstation (ArUco) | dok-pose | dok | ja |
| 8 | Admin portable-import | frame+DB+dok | ja | nee |

Bevestigd: "laadstation verplaatsen" (#6/#7) raakt **nooit** pos.json, alleen dok-pose-bestanden. Het enige dat de live-frame schrijft is #5 (rijdt) en #8 (lockt pos.json, zware import). Een no-drive frame-nudge bestaat niet.

## Kern-inzicht dat het ontwerp stuurt

Het dashboard tekent de polygon uit DB-lokale-meters via `localToGps(point, origin)` met de **server-oorsprong** (charger-GPS), die losstaat van de `pos.json utm_origin` op de maaier. Een verschuiving die alleen pos.json aanpast laat het dashboard de oude plek tonen: de preview zou liegen. **De tool moet dezelfde meter-delta op beide oorsprongen toepassen.**

## Gekozen oplossing: één visuele frame-schuif-tool

Een dashboard-tool "Maaigebied verschuiven" die:

1. **Visueel** — de gebruiker sleept de kaart of tikt N/O/Z/W-pijltjes, met live-preview op de satellietfoto. Dit is het visuele dat #4 bood, maar in het dashboard i.p.v. de begraven admin-HTML.
2. **Delta** — de sleep/pijl levert één `(dx, dy)` in meters (noord/oost).
3. **Beide oorsprongen** — de delta gaat naar (a) de server-weergave-oorsprong zodat de preview klopt, en (b) de maaier via de bestaande `reanchor_pos`-handler (nieuwe origin = huidige `wgs84_origin` + delta), die pos.json schrijft en `/load_utm_origin_info` live inlaadt. Geen reboot, geen rondrijden.
4. **Backup + omkeerbaar** — vóór toepassen wordt de huidige pos.json (en de server-oorsprong) gesnapshot, met één knop terug te zetten.

Deze tool **vervangt #4** (zelfde bedoeling, juiste laag, niet meer begraven).

### Waarom pos.json en niet #4's DB-geometrie-schuif

Bij een antenne-verschuiving is het hele GPS-frame verschoven. Eén origin-delta verschuift grens, obstakels, dok en occupancy-grid consistent mee. #4 schoof de geometrie maar **sloot het dok-anker uit**, dus voor dit geval de verkeerde laag. Voor een scheef-opgenomen kaart was #4 juist, maar dat geval dekt de nieuwe tool ook (alles schuift mee, en scheef-opgenomen is zeldzaam).

## Consolidatie (opruiming naast de nieuwe tool)

- **#2 verwijderen** — dood, onbereikbaar, plus ongebruikte i18n (`chargerMoveTitle`/`chargerRelocated`).
- **#1 + #3 samenvoegen** tot één "Weergave-uitlijning (alleen satellietkaart)", expliciet gelabeld dat het het maaien niet raakt.
- **#4 opheffen** ten gunste van de nieuwe tool (admin-HTML-pagina + `apply-polygon-offset` route + `polygon_offset_x_m/y_m` gebruik). Let op: controleer eerst dat geen ander pad (restore-and-realign) de kolommen nog nodig heeft; zo ja, alleen de UI weghalen en het gebruik behouden.
- **#5 (re-anchor), #6/#7 (dok), #8 (import)** blijven apart — echt andere klussen, alleen duidelijker labelen.

Eindbeeld: één visuele frame-schuif, één weergave-uitlijning, re-anchor, twee dok-fixes, één admin-import. Elk met een naam die de laag benoemt.

## Scope-afbakening

**Binnen:** de nieuwe dashboard-tool + de vier opruimacties hierboven.
**Buiten:** re-anchor-wizard, dok-pose-fixes en portable-import ongemoeid (alleen labels). App-kant (mobiel) niet in deze ronde.

## Open technische punten (op te lossen in het plan, niet nu aannemen)

1. **Teken (sign) van de delta.** `local = f(GPS, origin)`; een positieve origin-shift verschuift de maaipositie de andere kant op. De richting MOET op een bekend referentiepunt geverifieerd worden vóór livegang, niet geasserteerd. Fase-0 verificatie met gebruikersbevestiging.
2. **Bron van de server-weergave-oorsprong.** Waarschijnlijk `map_calibration.charger_lat/charger_lng`; bevestigen wie `localToGps` de origin voedt en dáár de delta toepassen zodat dashboard en maaier synchroon blijven.
3. **`reanchor_pos` neveneffecten.** Bevestigd: geen lock, geen reboot, geen `frame_unvalidated`. Verifiëren dat een directe aanroep buiten de wizard geen verify-latch triggert.
4. **Meten vs schatten.** De nudge is een eyeball-correctie (jij geeft 10cm + richting). Re-anchor meet het. Overweeg een "meet"-hulp: maaier op bekend punt, gerapporteerde vs verwachte lokale positie → voorgestelde delta. Optioneel, niet blokkerend.
5. **Antenne fysiek vastzetten** is de echte fix; software-correctie houdt anders geen stand. Waarschuwing in de UI.

## Bekende consequenties

- De tool verschuift het hele frame; scheef-opgenomen-kaart-only-gevallen (waar je juist het dok wilde vastzetten) worden nu ook meegeschoven. Aanvaardbaar: die zijn zeldzaam en re-mappen/andere tools dekken ze.
- Omkeerbaar via de pos.json-backup; een foute richting verdubbelt tijdelijk de fout tot je 'm terugdraait.
