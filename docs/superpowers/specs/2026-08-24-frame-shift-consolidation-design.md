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

## Kern-inzicht dat het ontwerp stuurt (herzien 2026-08-24)

Tijdens de planvoorbereiding bleek #4 (`POST /api/admin-status/apply-polygon-offset`, `adminStatus.ts:3720-3806`) al precies te doen wat nodig is: het schrijft `polygon_offset_x_m/y_m`, regenereert de kaart met `shiftPoints`, en stuurt het via `sync_map` (wacht op ack) + `save_map type:1` naar de maaier, die de verschoven CSV's op schijf schrijft en de pgm herbouwt. Het verschuift dus de kaart op de maaier en het blijft staan. Het is het mechanisme dat de gebruiker zelf voorstelde ("de CSV's schuiven"), en het is al gebouwd en getest (zelfde patroon als restore-and-realign).

De eerder overwogen pos.json-`utm_origin`-nudge is verworpen: netter op papier, maar niet visueel, niet gebouwd, en hoger risico (teken-verificatie, `reanchor_pos` neveneffecten). #4 dekt de antenne-case: de grens +delta schuiven compenseert de -delta positie-fout van de maaier, zodat hij de echte grens weer raakt.

## Gekozen oplossing: bestaande visuele UI aan bestaand werkend mechanisme koppelen

Twee bestaande stukken combineren i.p.v. nieuw bouwen:

1. **De visuele UI die er al is** — de N/O/Z/W-pijltjes op de dashboard-kaart (nu #3, `MowerMap.tsx` `nudge`/`startCalibrating`), die vandaag alleen een weergave-offset (`offset_lat/lng`) schrijven.
2. **Het mechanisme dat werkt** — #4's `apply-polygon-offset` dat de verschuiving als meter-delta naar de maaier synct.

**Herbedraad de pijltjes zodat ze #4 aanroepen** (dx/dy in meters → `apply-polygon-offset`) i.p.v. de display-only offset. Dan verschuift de knop die de gebruiker al kent écht het maaien. Live-preview op de kaart tijdens het slepen; pas bij "Toepassen" gaat de `sync_map` naar de maaier.

### Eerlijk minpunt van #4 (bewust aanvaard)

#4 sluit het dok-ankerpunt (unicom punt 0) uit de verschuiving. Voor de antenne-case maakt dat niet uit: de grens schuift zodat de maaier de echte grens raakt, en het dokken wordt door ArUco op het laatste stuk gecorrigeerd. Gevolg: de ruwe positie-sense van de maaier blijft 10cm scheef, puur voor het maaien onmerkbaar. Wie het frame écht wil herstellen (positie-sense ook goed) gebruikt re-anchor (#5).

## Consolidatie (opruiming)

- **De dashboard-nudge-pijltjes herbedraden** naar #4 (`apply-polygon-offset`). Dit is de kern-wijziging: de bestaande visuele knop gaat het maaien echt verschuiven.
- **#2 verwijderen** — dood, onbereikbaar, plus ongebruikte i18n (`chargerMoveTitle`/`chargerRelocated`).
- **#4's admin-HTML-pagina opheffen** — de dashboard-nudge vervangt 'm. De `apply-polygon-offset` route + `polygon_offset_x_m/y_m` BLIJVEN (restore-and-realign leunt erop; alleen de losse admin-UI verdwijnt).
- **#1 (charger-pin) en de oude display-only offset (#3)** — de display-only `offset_lat/lng`/`charger_lat/lng` weergave-correctie blijft bestaan maar wordt expliciet gelabeld "alleen satellietkaart, raakt het maaien niet", zodat niemand 'm nog aanziet voor een maai-fix. Niet verwijderen (de render-math gebruikt het), wel herlabelen.
- **#5 (re-anchor), #6/#7 (dok), #8 (import)** blijven apart — echt andere klussen, alleen duidelijker labelen.

Eindbeeld: één visuele "verschuif het maaigebied" (dashboard-nudge → #4-mechanisme), een duidelijk als "alleen weergave" gelabelde satelliet-uitlijning, re-anchor, twee dok-fixes, één admin-import. Elk met een naam die de laag benoemt.

## Scope-afbakening

**Binnen:** dashboard-nudge herbedraden naar #4, #2 verwijderen, #4-admin-UI opheffen, display-only correctie herlabelen.
**Buiten:** re-anchor-wizard, dok-pose-fixes en portable-import ongemoeid (alleen labels). App-kant (mobiel) niet in deze ronde. Geen pos.json-mechaniek.

## Open technische punten (op te lossen in het plan, niet nu aannemen)

1. **Richting/teken van de dx/dy-delta.** De pijltjes leveren noord/oost in meters; `shiftPoints` verwacht een `(x,y)`-lokale-meter-delta. De as-oriëntatie en het teken (schuift +dx de grens oost of west) MOETEN op een bekend punt geverifieerd worden vóór livegang, niet geasserteerd. Fase-0 met gebruikersbevestiging (het is een bewegings-/maai-effect).
2. **Stapelen of absoluut.** `apply-polygon-offset` schrijft `polygon_offset_x_m/y_m`. Bepalen of opeenvolgende nudges stapelen (delta optellen bij de bestaande offset) of de offset absoluut zetten. Kies stapelen zodat herhaald tikken voorspelbaar is; bevestig hoe #4 het nu doet.
3. **Maaier offline.** #4 meldt al "mower will pick up offset on next reconnect". De dashboard-UI moet dat tonen i.p.v. stil falen.
4. **Omkeerbaar.** De offset staat in `polygon_offset_x_m/y_m`; op nul zetten + opnieuw syncen draait terug. Een "reset"-knop meenemen.
5. **Antenne fysiek vastzetten** is de echte fix; software-correctie houdt anders geen stand. Waarschuwing in de UI.

## Bekende consequenties

- #4 sluit het dok-anker uit; de maaier zijn ruwe positie-sense blijft scheef (onmerkbaar voor het maaien, wel voor re-anchor/verify die op `map_position` leunen).
- Omkeerbaar via de offset op nul + resync; een foute richting verschuift tijdelijk de verkeerde kant op tot je 'm terugzet.
