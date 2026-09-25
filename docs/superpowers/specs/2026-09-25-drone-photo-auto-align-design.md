# Dronefoto automatisch uitlijnen op de luchtfoto: ontwerp

**Datum:** 2026-09-25
**Status:** ontwerp, in gesprek goedgekeurd (deel 1 gebruikersflow 2026-09-24, deel 2 herkenner 2026-09-25: DISK)
**Probleem:** een dronefoto wordt nu met de hand geplaatst, met slepen, schuifjes of aangewezen punten. De foto van LFIN1231000211/LFIN2230700238 lag daardoor 2,9° gedraaid en 2,6% te klein, en alles wat op de foto getekend of gekopieerd werd, lag tot een meter naast de plek waar de maaier rijdt. De gebruiker wil de foto na het uploaden ruwweg neerleggen, waarna de server hem precies op de luchtfoto uitlijnt.

## Feiten waar het ontwerp op rust (gemeten 2026-09-24/25)

1. **Het kaartframe van de maaier is UTM min een oorsprong.** `robot_combination_localization` projecteert met `+proj=utm` en trekt `utm_origin` af, dus de kaartassen volgen UTM-noord. Dat wijkt hier 2,19° af van echt noord. Het dashboard en de 3D-render rekenen sinds 7be50332 langs UTM (`dashboard/src/utils/coords.ts`, `server/src/mqtt/mapConverter.ts` `gridLocalToGps`), getoetst tegen PROJ tot onder 1 cm. Dit corrigeert feit 1 van de zone-kopie-spec van 2026-09-24, die ENU aannam.
2. **De oude foto was op de verkeerde referentie uitgelijnd.** Hij lag 2,9° met de klok mee gedraaid en 2,6% te klein ten opzichte van PDOK. Twee onafhankelijke metingen: automatisch −2,90° ± 0,3 met schaal 0,974, handmatig −3,45° ± 0,4 met schaal 0,969. Het grootste deel komt doordat hij met de hand was gelegd op zones die in de oude projectie 2,2° scheef stonden. De rest is handwerk en de eigen vervorming van de foto (links −3,5°, rechts −2,9°).
3. **Geen van beide docks is op de foto zichtbaar.** Pins die op de foto worden gezet zijn dus inschattingen, op een halve tot een hele meter.
4. **De luchtfotobronnen verschillen sterk:**
   - PDOK is scherp tot z21 (8 cm), maar "Actueel" wijst nu naar een grove snelopname van 2026. De jaargang `2025_orthoHR` is scherp.
   - Esri levert hier tot z22 een 200-antwoord, maar alleen z20 (9,2 cm) is echt. z21/z22 zijn opgeschaald, en ontbrekende niveaus geven een grijze placeholder-JPEG met HTTP 200.
   - PDOK geeft net over de grens (België, Duitsland) witte tegels met HTTP 200. `pickTileSource` kiest daar toch PDOK. Dat is een bestaande bug, ook voor de 3D-render.
5. **Herkenners, gemeten op deze foto vanuit 19 ruwe startposities** (tot ±10°, ±10% en 8 m ernaast, tot 16 m fout op de verste hoek). Tijden gemeten op een Apple M2, alleen CPU, minimum van 3 runs op een niet-stille machine:

   | Model (licentie) | PDOK typisch / max | Esri z20 | 1 kern | 4 kernen | Geheugen |
   |---|---|---|---|---|---|
   | DISK + LightGlue (Apache-2.0) | 0,21 / 0,43 m, draaiing ≤ 0,18°, schaal −0,3..+0,9% | faalt, veilig afgewezen | 60 s | 25 s | ~1,1 GB (Python), ~0,6 GB node zonder arena |
   | XFeat + LighterGlue (Apache-2.0) | 0,47 / 1,10 m | faalt | 10 s | 3,4 s | ~0,4 GB |
   | ALIKED + LightGlue (BSD-3/Apache) | 0,57 / 1,32 m | faalt | 45 s | 16 s | ~1,5-1,9 GB |
   | SuperPoint + LightGlue | 0,33 / 0,51 m | faalt | 30 s | 11 s | ~0,6 GB |

   SuperPoint valt af: de licentie is "academic or non-profit organization noncommercial research use only" en verbiedt derden toegang te geven. Bij DISK geeft één fijne ronde al 0,20 / 0,40 m; een tweede ronde verbetert niets.
6. **De server heeft onnxruntime-node 1.24.3 al** (vastgepind door `@huggingface/transformers`). Modellen komen nooit in de image: ze worden bij gebruik gedownload naar `STORAGE_PATH/models`. `InferenceSession.run` blokkeert de event loop, dus de herkenner moet in een apart proces. Eén kern: met vier kernen vol reageerde de server op 2026-09-14 niet meer.

## Doel en niet-doelen

**Doel:** na een ruwe plaatsing stelt de server een plaatsing voor die in Nederland binnen ongeveer een halve meter, 0,5° en 1% op PDOK ligt. De gebruiker bevestigt of annuleert.

**Niet-doelen:**
- Volautomatisch plaatsen zonder ruwe start. De zoekruimte is begrensd op ±10°, ±10% en ongeveer 8 m.
- Een betrouwbaar voorstel buiten Nederland beloven. Tegen Esri faalt elk getest model in deze tuin. De server wijst dat af en de gebruiker lijnt met de hand uit.
- Iets veranderen aan zones (kaartmeters) of aan wat naar de maaier gaat.

## Gebruikersflow

1. **Uploaden.** Een JPEG met drone-EXIF (GPS, hoogte, richting) ligt meteen ruwweg goed (`firstPlacement`). Anders sleept en draait de gebruiker de foto grofweg op zijn plek, zoals nu.
2. **"Uitlijnen op luchtfoto"** in het plaatspaneel. De server start een uitlijnjob en het paneel toont de voortgang: luchtfoto ophalen, grove ronde, fijne ronde. Annuleren kan altijd.
3. **Voorstel.** De voorgestelde hoeken worden het concept (`droneDraft`), met ernaast:
   - de correctie in graden, procent en meters
   - het aantal overeenkomsten
   - de bron (bijv. "PDOK 2025, 8 cm")
   - een betrouwbaarheidslabel

   Opslaan gaat via het bestaande pad, zodat "Vorige plaatsing" blijft werken.
4. **Afgewezen of mislukt.** De server zegt waarom, in gewone taal: geen luchtfoto hier, te weinig overeenkomsten, luchtfoto te grof. De handmatige middelen blijven beschikbaar.
5. **Pins bewegen mee.** Bij opslaan schuift de dockpin mee van elke maaier waarvan de pin binnen de foto ligt. Hij blijft op hetzelfde fotopixel staan. Dat geldt voor alle maaiers met deze foto. "Vorige plaatsing" zet de pins ook terug.
6. **Blijvende controle.** Na een bevestigde uitlijning bewaart de server die plaatsing als referentie. Wijkt een latere handmatige plaatsing daar meer dan 1°, 1,5% of 1 m van af, dan toont het paneel een waarschuwing met de knop "Opnieuw uitlijnen". Dat is een goedkope, geometrische vergelijking, zonder herkenner.

## Architectuur

### 1. `server/src/services/aerialTiles.ts` (nieuw, gedeeld met de 3D-render)

Haalt `TILE_SOURCES`, `pickTileSource`, `lngToTileX`/`latToTileY`, `stitchAndCrop` en de zoomkeuze uit `gardenRender.ts`. `gardenRender` gebruikt dezelfde module, en de 3D-render werkt daarna ongewijzigd, op de tegelcontrole na.

- `fetchAerial({ sw, ne, mPerPx, source? })` → `{ png, width, height, project, validMask, sourceKey, layer, zoom, attribution }`.
- **Bronnen:**
  - PDOK met een vaste jaargang (`2025_orthoHR`, instelbaar), niet `Actueel`.
  - Esri met maximaal z20 als echte resolutie. De code hoeft de native zoom niet elders te bepalen.
  - USGS ongewijzigd.
- **Tegelcontrole:** witte, uniforme of placeholder-tegels (Esri ETag `"vvvvvvvvvvvvf"`, grootte ~2,5 KB, uniform grijs of wit) en mislukte tegels zijn ongeldig. Ze gaan in `validMask` en tellen niet mee bij het matchen. Is meer dan 30% van het gebied ongeldig, dan valt de bron af en is de volgende aan de beurt (PDOK, dan Esri). Dat lost ook de witte 3D-render in België en Duitsland op.
- **Ophalen:** timeout van 10 s per tegel, maximaal 4 tegels tegelijk, User-Agent zoals nu. Het uitgesneden stuk wordt bij de uitlijning bewaard (`storage/overlays/<sn>.aerial.jpg`), zodat de controle en een uitleg later offline kunnen.

### 2. `server/src/services/droneAlign/worker.ts` (nieuw, apart proces)

- Draait als `child_process.fork`, niet als worker_thread, zodat al het geheugen na afloop terug naar het OS gaat.
- Laadt `onnxruntime-node` (de bestaande 1.24.3, geen tweede kopie) met `intraOpNumThreads: 1`, `interOpNumThreads: 1` en `enableCpuMemArena: false`.
- **Model:** `disk_lightglue_pipeline.ort.onnx` uit fabio-sim/LightGlue-ONNX release v2.0.
  - 50.161.858 bytes, sha256 `20b35e9d3c4e505ae718f25fc4a95a5ec666c001f18308e600a93d158b43b5a8`.
  - Downloaden bij het eerste gebruik naar `STORAGE_PATH/models/`, met een vaste URL, een sha256-controle en een atomische rename.
- **Protocol:** de parent stuurt `{ drone: rgba-buffer + size, aerial: buffer + size + validMask, start: corners, params }` en krijgt `progress`-berichten en één `result` of `error` terug.
- **Pijplijn** (zoals de proef):
  1. Warp de dronefoto via de starthoeken naar het luchtfotoraster op 15 cm/px.
  2. Grove ronde op het hele beeld.
  3. RANSAC-similariteit (0,5 m) en Tukey-IRLS.
  4. Opnieuw warpen via de grove schatting.
  5. Eén fijne ronde op tegels van 384 px op 7,5 cm/px, batch 1.
  6. RANSAC (0,25 m) en IRLS.
  7. Uitkomst: rotatie, schaal, verschuiving, overeenkomsten, bedekkingsgraad en restfout.
- **Geheugenbewaking:** de parent start de worker alleen als er genoeg vrij is. Hij leest `memory.max` en `memory.current` van de cgroup (v2, met v1 als fallback), en `/proc/meminfo` alleen buiten een container. De ondergrens is standaard 900 MB (`DRONE_ALIGN_MIN_FREE_MB`).
- **Wederzijdse uitsluiting:** er draait nooit een uitlijning terwijl het terreinmodel geladen is, en andersom. Er is één uitlijnjob tegelijk per server.
- **Uitschakelbaar** met `DRONE_ALIGN=0`, voor borden met 1 GB.

### 3. `server/src/services/droneAlign/index.ts` (nieuw)

- `startAlign(sn)`: leest de foto en plaatsing, bepaalt het zoekgebied (de voetafdruk plus 12 m), haalt de luchtfoto op, start de worker, bewaakt een totale timeout (standaard 10 minuten) en past de afwijzingsregels toe.
- Het resultaat wordt `{ corners, deltaRotDeg, deltaScalePct, shiftM, inliers, hull, residualM, source, layer, zoom, capturedAt, confidence }`. De hoeken rekent de parent uit door de gevonden similariteit toe te passen op de huidige hoeken.
- De voortgang gaat naar het dashboard via Socket.io (`forwardToDashboard(sn, map_align_*)`), op dezelfde manier als de kaarttoepassing.

### 4. Afwijzingsregels (voorlopig, uit één tuin)

- Grof: minstens 30 overeenkomsten en een bedekking van minstens 0,3 van de voetafdruk. In de proef had PDOK er 89 tot 123 en Esri 4 tot 16.
- Fijn: minstens 100 overeenkomsten en een bedekking van minstens 0,35. PDOK: 179 tot 221. Esri: niet gehaald.
- Schaal tussen 0,85 en 1,15. Draaiing en verschuiving binnen het zoekgebied: 12° en 12 m.
- Faalt er één, dan komt er geen voorstel, en een reden in gewone taal. Alle drempels staan als constanten in één bestand, met een verwijzing naar deze spec.

### 5. API (achter de bestaande LAN/auth-poort, `droneOverlay.ts`)

- `POST /overlay/:sn/align` start een job, of geeft de lopende job terug. Antwoord: 202 met `{ jobId }`. Met 409 als er al een job loopt voor een andere maaier, of als de uitlijning is uitgeschakeld.
- `GET /overlay/:sn/align` geeft de status: `{ phase, progress, result?, reason? }`.
- `DELETE /overlay/:sn/align` annuleert en beëindigt de worker.
- `PUT /overlay/:sn` krijgt een optionele `pinsFollow: true`. In één DB-transactie gebeurt dan het volgende:
  - `history` krijgt de oude plaatsing, plus een pin-snapshot per maaier.
  - Voor elke maaier met dezelfde foto (dezelfde bestandsgrootte en dezelfde hoeken, of via een nieuw veld `sharedWith`) wordt de plaatsing bijgewerkt.
  - Van die maaiers schuift de pin mee: `photoToLatLng(nieuw, latLngToPhoto(oud, pin))`, alleen als de pin binnen de foto ligt. Het schrijven gaat via `mapRepo.setCalibration` met merge, nooit via `PUT /calibration` met een half object.
  - Dit wordt geweigerd met 409 zolang `posJsonRequested(sn)` waar is.
  - Een bevestigde uitlijning bewaart `alignment: { corners, source, layer, zoom, capturedAt }` als referentie voor de blijvende controle.
- `copy-from` neemt `alignment` en `sharedWith` mee.

### 6. Dashboard

- Het plaatspaneel (`MowerMap.tsx`) krijgt de knop "Uitlijnen op luchtfoto", een voortgangsregel met Annuleren, het voorstel als concept met correctie-info, en de waarschuwingsregel van de blijvende controle.
- **Punten aanwijzen** koppelt het eerste punt niet langer automatisch aan de dockpin. De luchtfoto is de referentie, niet de pin. Dat de pin eerste punt was, veroorzaakte deze keer juist de fout.
- De geometrie hergebruikt `droneOverlayMath.ts`: `photoToLatLng`, `latLngToPhoto`, `insidePhoto` en `similarityFromPairs` voor de afwijking tussen twee plaatsingen.
- De vertalingen in nl/en/de/fr krijgen nieuwe `map.droneAlign*`-sleutels.
- `docs/user-guide/dashboard.md` zegt nu "Do not align to the aerial imagery". Dat wordt: lijn uit op de luchtfoto, zet daarna de dockpin op de foto.

## Veiligheid voor het maaien

- Uitlijnen schrijft alleen de overlay-meta (`device_settings`) en, bij bevestigen, `map_calibration.charger_lat/lng`. Het schrijft nooit `maps.map_area` en stuurt niets via MQTT.
- Sinds c0204c77 gaat de pin niet meer als pos.json naar de maaier, behalve in het `posJsonGate`-venster, en daarin weigert `pinsFollow`.
- Een test legt vast dat `startAlign` plus bevestigen geen rij in `maps` verandert en `publishToExtended` niet aanroept.

## Fouten en randgevallen

- **Geen internet of bron onbereikbaar:** reden "luchtfoto niet op te halen", geen voorstel.
- **Buiten de dekking van PDOK en USGS:** Esri, en bij afwijzing een uitleg dat de luchtfoto hier te grof of anders is.
- **Download van het model mislukt of de sha256 klopt niet:** reden, en het bestand wordt verwijderd.
- **Te weinig geheugen, of de terreinherkenning loopt:** 409 met reden, opnieuw proberen kan.
- **Worker crasht of timeout:** de job gaat naar `error`, het proces wordt beëindigd en de server draait door.
- **Schuine foto (EXIF-pitch > −80°):** de similariteit dekt de vervorming niet. Het voorstel komt met een waarschuwing dat vier of meer handmatige punten beter zijn.
- **Heel grote foto (tot 50 MB):** het decoderen gebeurt met een resize naar de werkresolutie. Het origineel komt nooit volledig in het geheugen.

## Testen

- **Eenheidstests, zonder model:**
  - de afwijzingsregels, op vastgelegde overeenkomsten uit de proef (JSON-fixtures voor PDOK goed en Esri fout)
  - de similariteitsfit en IRLS
  - het meeschuiven van pins
  - de afwijking tussen twee plaatsingen
  - de tegelcontrole, met witte, grijze en mislukte tegels
- **Worker-protocol:** een ingespoten nep-sessie; tests downloaden nooit een model.
- **Routetests:** job starten, status, annuleren, 409-gevallen en `pinsFollow` inclusief transactie en posJsonGate. Plus de vaste test dat zones en MQTT onaangeroerd blijven.
- **Release-smoketest:** `release.sh` en `release-beta.sh` maken een `InferenceSession` op een klein meegeleverd ONNX-model, voor arm64 én amd64.
- **Verplicht vóór een release:**
  1. Meting op een echte Raspberry Pi 4 en 5: tijd en piekgeheugen van de hele pijplijn.
  2. Toetsing op minstens één andere tuin in Nederland en één locatie buiten Nederland, met de drempels uit dit document.

## Open punten

- De maximale tijd op een Pi is onbekend. Als het meer dan 5 minuten blijkt, wordt de fijne ronde verkleind, met minder tegels of 10 cm/px, en opnieuw gemeten.
- Of een tweede herkenner (XFeat) tegen Esri beter werkt, is niet onderzocht. Buiten Nederland blijft de uitlijning voorlopig handwerk.
- Het `sharedWith`-veld versus herkennen via bestandsgrootte en hoeken: de keuze valt in het plan.
- Het model staat als GitHub-release-asset op een persoonlijke repo (fabio-sim). Of er een eigen mirror komt, bijvoorbeeld op downloads.ramonvanbruggen.nl, beslist Ramon.
- De zoekgrenzen (12°, 12 m) liggen iets ruimer dan wat getoetst is (±10°, ±10%, 8 m). De Pi-meting en de tweede tuin moeten laten zien of ze zo kunnen blijven.
