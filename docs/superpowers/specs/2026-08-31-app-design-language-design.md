# App design language — ontwerp

**Datum:** 2026-08-31
**Status:** goedgekeurd in secties (gebruiker akkoord per sectie), klaar voor implementatieplan
**Issues:** #38 (headers versnipperd), #43 (kaartlijnen te dik / schalen niet mee)

## Probleem

De OpenNova app (19 schermen, ~19k regels in `app/src/screens/`) heeft geen gedeelde
visuele bouwstenen. Inventarisatie (2026-08-31, volledige sweep):

- 19 handgemaakte headers, 0 gedeeld; `headerShown:false` op elke navigator.
- De terugknop bestaat in vijf uitvoeringen (40×40 cirkel, 36×36 vierkant, kaal
  `arrow-back` 24, kaal `chevron-back` 24, kaal `arrow-back` 28).
- Zeven titelmaten (18/20/22/24/28/32, gewicht 700 én 800) voor hetzelfde concept.
- ~180 losse knop/chip-stijldefinities over 25 bestanden; primaire knop in vijf
  varianten, chips in zes vormvarianten (radius 6 t/m 999).
- Zes onboarding-schermen met hardcoded `paddingTop:60/80` (fout op toestellen
  zonder notch en met Dynamic Island); History/Messages hebben in de Home-modals
  een dubbele top-inset.
- Kaarten: MapScreen en MowingProgressMap schalen de hele SVG via een
  Reanimated-transform (lijnen tot 8× te dik en wazig bij inzoomen);
  MapEditScreen schaalt juist de coördinaten in JS (lijnen worden relatief
  dunner). Dezelfde semantische laag heeft per bestand een andere dikte
  (trail 5/6/2, DONE 4/3.5, obstakel 2.5/1).
- `rgba(255,255,255,0.06-0.1)` wordt breed gebruikt als "subtiele knopachtergrond"
  en is in light mode vrijwel onzichtbaar (zelfde fouttype als GH #109).

## Besluiten (goedgekeurd)

1. **Ambitie: uniformeren.** De huidige look (donker, emerald) blijft; we leggen
   per patroon één norm vast en brengen alle schermen daarheen. Geen herontwerp.
2. **Onboarding houdt een eigen, maar genormeerde stijl.** Twee smaken totaal:
   "app-scherm" en "onboarding" (gecentreerd, icooncirkel).
3. **Scope: alleen de app.** Het dashboard volgt later als eigen klus en neemt de
   normen over; alleen de kaartlagen-tabel geldt vanaf nu tweezijdig als norm.

## Normen

### Typografie — zeven tokens

| Token | Stijl | Vervangt |
|---|---|---|
| `title` | 28/700 | titelmaten 18/20/22/24/32 en alle 800-gewichten |
| `modalTitle` | 20/700 | 17, 18, 22, 24 in modals/editors |
| `section` | 13/600, uppercase, letterSpacing 0.5 | bestaand patroon op 4 plekken wordt de enige |
| `body` | 15/400 | 14/15/16 regular door elkaar |
| `bodyBold` | 15/600 | 14/600, 15/600, 16/600 |
| `secondary` | 13/400 | 12, 13 |
| `caption` | 11/500 | 8, 9, 10, 11, 12 |

Gewicht 800 verdwijnt volledig.

### Header

- Opbouw: `insets.top + 8` bovenpadding, rij met gap 12:
  [terugknop indien niet-root] [titel `title`, flex] [0–2 icoonknoppen].
  Vaste marge 16 onder de header. Nooit hardcoded top-padding.
- **Terugknop: kale `arrow-back` 24, geen cirkel/achtergrond, padding 8 + hitSlop.**
  (Meest voorkomende variant, en de expliciete voorkeur van de melder van #38.)
- Modals gebruiken dezelfde header met `modalTitle`.
- Onboarding-variant: gecentreerd, icooncirkel 64 (nu 64/72/80), titel `title`
  (nu ook 32), `insets.top + 24` (nu hardcoded 60/80).
- Reparatie en passant: dubbele inset History/Messages in de Home-modals.

### Knoppen, chips, iconen, radii

- **Primair:** hoogte 48, radius 12, emerald, label 16/600. Kleurvarianten
  (amber/rood/blauw) toegestaan, maat en label niet variabel.
- **Secundair:** zelfde maat, `inputBg` + rand `cardBorder`.
- **Icoonknop:** 36×36 cirkel, `inputBg` + rand, icoon 20. De
  `rgba(255,255,255,…)`-achtergronden verdwijnen overal (light-mode-fout).
- **Chip:** padding 14×8, radius 10; inactief `inputBg` + rand + `textDim`,
  actief gevuld met contextuele accentkleur + wit. `chipSmall` (8×3, radius 6)
  voor niet-tikbare statuschips.
- **Icoonmaten in controls: 16 / 20 / 24** (inline / knop / terugknop).
- **Radii: 10 / 12 / 16 / 999** (kleine controls / knoppen+invoer / kaarten / pills).
  Eenlingen worden naar het dichtstbijzijnde token getrokken.

### Kaartlagen — één semantische diktetabel (app én, als norm, dashboard)

Diktes in scherm-punten, constant op het scherm ongeacht zoom:

| Laag | Dikte |
|---|---|
| grens (actief) | 2 |
| grens (inactief) | 1.5 gestippeld |
| verbindingsroute (unicom) | 2.5 |
| TODO-pad | 1.25 |
| DONE-pad | 3 |
| actieve baan | 3 |
| trail | 2 |
| obstakel | 1.5 gestippeld |
| dok | 2 |

Bewust dunner dan nu (#43: het pad hoort de hartlijn te tonen). Dit is het enige
smaak-stuk dat op een echt toestel beoordeeld wordt; de tabel staat op één plek.

**Zoom-compensatie:** alle diktes gedeeld door de zoomfactor.

- MapEditScreen (JS-state-zoom): continu compenseren — repareert meteen de
  omgekeerde bug (lijnen worden daar nu te dun).
- MapScreen en MowingProgressMap (Reanimated, UI-thread): tijdens het knijpen
  mogen lijnen meeschalen; bij gesture-einde wordt de zoom naar JS-state
  gesynct en worden diktes, maaier-icoon en zonelabels herberekend. Continu
  compenseren zou elke frame een re-render over de bridge kosten.
- Zoomgrens blijft 8×; het is één constante als dat op het toestel te krap blijkt.
- LiveMapView en de StartMowSheet-preview (geen zoom) nemen alleen de
  tabelwaarden over.

## Componenten (nieuw, in `app/src/components/ui/`)

| Component | Doel |
|---|---|
| `ScreenHeader` | titel + optionele terugknop + rechteracties; props `title`, `onBack?`, `actions?`; variant `onboarding` |
| `AppButton` | primair/secundair + kleurvariant |
| `Chip` | toggle-chip + `small`-variant |
| `IconButton` | 36×36 icoonknop |

Tokens komen in het bestaande themasysteem (`app/src/theme/`): `typography`,
`spacing`, `radius`, `iconSize`, `mapStroke` naast het bestaande `colors`.
Alle componenten gebruiken `useStyles`/`useTheme` zoals de rest van de app.

## Uitrol — vier golven, elk apart naar beta en door de gebruiker getest

1. **Fundament:** tokens + de vier componenten. Nul visuele verandering.
2. **Golf 1 — headers:** alle 19 schermen naar `ScreenHeader`. Sluit #38;
   repareert hardcoded paddings en de dubbele-inset-bug.
3. **Golf 2 — kaarten:** diktetabel + zoom-compensatie. Sluit #43.
4. **Golf 3 — knoppen/chips:** de ~180 definities, per scherm in behapbare
   stukken. Grootste golf, minste haast; mag over meerdere sessies.

Per golf: `npx tsc --noEmit` + bestaande vitest-suite groen; visueel oordeel door
de gebruiker op het toestel vóór de volgende golf start. Geen golf wordt
gecommit vóór gebruikers-test (vaste werkafspraak).

## Buiten scope

- Dashboard (volgt later; neemt normen en kaartlagen-tabel over).
- Nieuwe visuele identiteit (kleuren, look) — expliciet afgewezen.
- De 3D-maaier-scène (`mower/MowerScene.tsx` e.o.): eigen illustratieve wereld,
  hardcoded kleuren daar zijn geen doel van deze klus.
- Eslint-afdwinging van tokens: YAGNI voor nu; de normen leven in dit document
  en in de componenten zelf.
