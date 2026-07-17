# Object-lagen + native app-viewer voor de 3D-terreinkaart — ontwerp

**Datum:** 2026-07-17
**Status:** ontwerp goedgekeurd door Ramon (A+B gecombineerd; C uitgesteld)
**Bouwt voort op:** `2026-07-17-terrain-3d-map-design.md` (terrein-pipeline, live werkend
sinds de smoke van vandaag: 75k cellen per beurt, mediaan 701 samples/cel).

## Scope-besluit

| Deelproject | Status |
|---|---|
| A. 3D-terrein + live maaier in de app | **deze spec** |
| B. Object-lagen (ToF+RGB) op het terrein | **deze spec** |
| C. 2D-kaart echt vervangen (zone-selectie/start-flow in 3D) | uitgesteld tot A+B bewezen |
| Icoon-stilering van objecten | follow-up na voxels |

## Beslissingen (met Ramon afgestemd)

- **App-viewer: native** — `expo-gl` + `three` + `@react-three/fiber/native`.
  Bewust geaccepteerd nadeel: twee viewer-implementaties (web + native) die
  we synchroon houden; gedeelde platte parsers beperken de drift.
- **Objecten: voxel-vorm eerst** — gelabelde punten worden 5 cm-kolommen in
  klasse-kleur; geen soort-gok, de echte vorm telt (een trampoline is
  zichtbaar als rond vlak op poothoogte). Iconen later.
- **Plek in de app: 2D⇄3D-toggle op het Map-scherm** — zelfde plek als de
  huidige kaart, 2D blijft één tik weg.
- **Eerlijke verwachting**: het seg-model kent geen "trampoline" of "boom";
  wel `bush`/`fixed`/`static obstacle`/`charging station`. Objecten
  verschijnen als klasse-gekleurde vormen, niet met naam.

## Databron objecten

`/perception/points_labeled` (PointCloud2): de firmware fuseert ToF-diepte
met RGB-segmentatie (BiSeNet-v2, 14 klassen) en publiceert gelabelde
3D-punten tijdens het maaien. Wij bouwen géén eigen fusie.

**Persistente klassen die de kaart op gaan:** `bush` (8), `fixed obstacle`
(5), `static obstacle` (6), `charging station` (10).
**Bewust NIET opgeslagen:** `dynamic obstacle` (7 — mensen/dieren horen niet
permanent op de kaart), `faeces`/`dirt`/`sunlight`/`glass`/`unlabeled`/
`background`/`lawn`/`road`/`terrain` (ruis of al gedekt door het terrein).

## Componenten

### 1. Maaier: uitbreiding `terrain_scan.py`

- Tweede subscriber op `/perception/points_labeled`, zelfde pose-gating en
  rate-limit (≤2 fps) als het terrein.
- Accumulatie per **(cel, klasse)**: max-hoogte + count (max, niet mean —
  een objectkolom is zo hoog als zijn hoogste punt).
- Eigen RAM-cap (zelfde stijl als MAX_CELLS; objecten zijn schaars dus een
  lagere cap volstaat, bv. 500k (cel,klasse)-entries).
- Sessie-formaat **TGO1** (little-endian): `'TGO1'` · `float64 cell_size` ·
  `int32 n` · per entry `int32 ix · int32 iy · uint8 label · float32 max_h ·
  uint32 cnt` (17 B/entry).
- Flush + upload in dezelfde levenscyclus als het terrein (zelfde 120 s
  idle-flush, zelfde retry/rotatie, aparte bestandsextensie `.tgo`).

### 2. Server

- Upload-endpoint naast het terrein-endpoint (zelfde raw-octet-stream
  patroon, zelfde SN-whitelist): `POST /api/nova-file-server/terrain/uploadObjectGrid?sn=`.
- Merge-formaat **TGM-O** analoog aan TGM1: per (cel,klasse) laatste 7
  sessie-max-hoogtes (mediaan voor display) + cumulatieve count.
  Cel die in recente sessies GEEN label meer krijgt terwijl de maaier er
  wél langskwam, veroudert vanzelf uit de 7-slot-ring → verplaatste
  trampoline verdwijnt na een paar beurten.
- `GET /api/dashboard/terrain-objects/:sn` → gzip TGO1-display.
- Metadata in bestaande `terrain_grids`-rij (extra kolommen `obj_cells`,
  `obj_sessions`).

### 3. Viewer-uitbreidingen (dashboard eerst)

- **Object-voxels**: instanced boxes (5 cm voetafdruk, hoogte = display-max)
  in klasse-kleur (bush groen, fixed/static obstacle oranje/rood, charging
  station blauw). Legenda + toggle per klasse.
- **Live maaier-marker**: bestaande socket-positie (map_position) → marker
  op terreinhoogte + korte trail (laatste ~50 posities). Dashboard gebruikt
  het bestaande socket-kanaal.

### 4. Native app-viewer

- Deps: `three`, `@react-three/fiber` (native), `expo-gl`.
- Gedeelde platte parsers (TGR1/TGO1) in `app/src/utils/` — byte-identiek
  aan de dashboard-parsers.
- `TerrainView3D`-component: mesh-bouw geport van de dashboard-versie
  (expliciete vertex-coördinaten — de Y-flip-les), object-voxels,
  maaier-marker uit `useMowerState`, pan/pinch/orbit gestures.
- MapScreen krijgt een 2D⇄3D-toggle; 3D-modus toont terrein + objecten +
  live maaier. Zone-selectie e.d. blijft in 2D (project C).
- Verifiëren in de eerste app-taak: RN-fetch pakt de gzip transparant uit
  (OkHttp/NSURLSession doen dat op de Content-Encoding header).

### 5. Live groei (periodieke tussentijdse upload) — amendement, door Ramon gevraagd

De kaart moet zichtbaar groeien TIJDENS het maaien, niet pas na het docken.
Gekozen: periodieke incrementele upload (geen echte streaming — bewuste
afweging: minuut-live tegen een fractie van de complexiteit, en robuust
tegen WiFi-gaten).

- **Maaier**: tijdens een actieve sessie uploadt de daemon elke **60 s** het
  actuele sessie-grid (terrein én objectlaag) naar de bestaande endpoints,
  met `&session=<start-ts>&final=0`. De eind-flush stuurt `final=1`.
- **Server**: bewaart de actieve sessie APART (`<sn>.active.tgr/.tgo` +
  onthouden sessie-id). Tussentijdse uploads met dezelfde sessie-id
  VERVANGEN de actieve laag (idempotent — telt niet 60× mee). Bij
  `final=1` (of een nieuwe sessie-id) wordt de sessie definitief in de
  TGM-ring gevouwen en de actieve laag gewist.
- **Display**: GET-endpoints mergen on-the-fly TGM + actieve laag, zodat
  de viewer altijd het levende beeld ziet.
- **Viewer** (dashboard + app): pollt elke **20 s** zolang de maaier
  actief is (activity uit de bestaande socket-state), anders niet.
- Backwards-compat: uploads ZONDER session-parameter gedragen zich als
  final=1 (het huidige daemon-gedrag blijft geldig tijdens de migratie).

## Fase 0 — verificatie vóór de bouw (op .244)

1. Publiceert `/perception/points_labeled` tijdens het maaien? Rate?
2. Veld-layout: waar zit het label per punt (veldnaam, datatype, offset)?
3. Frame: cam-frame of al base/map-frame? (Bepaalt of onze transform nodig is.)
4. Steekproef: kloppen de labels grofweg (struik = 8, obstakel = 5/6)?

## Risico's (bewust geaccepteerd)

- points_labeled-gedrag onbekend tot fase 0 (rate kan laag zijn: alleen bij
  obstakels in beeld — dan groeit de objectlaag langzamer dan het terrein).
- RN-GL-performance op oudere telefoons; mitigatie: één BufferGeometry voor
  het terrein + instanced mesh voor voxels.
- Twee viewers om te onderhouden (expliciete keuze van Ramon).
- Perceptie-modus: labels vereisen seg-mode; op OpenNova-firmware staat die
  standaard goed (SEGMENTATION sinds juni), stock-varianten kunnen afwijken.

## Fasering

| Fase | Inhoud |
|---|---|
| 0 | points_labeled-verificatie op .244 |
| 1 | terrain_scan.py objectlaag + TGO1 + upload + server-merge + GET |
| 2 | Dashboard: voxel-lagen + legenda + live maaier-marker |
| 3 | App: native viewer (terrein + objecten + maaier) + 2D⇄3D-toggle |
| later | Icoon-stilering; project C (2D-vervanging) |
