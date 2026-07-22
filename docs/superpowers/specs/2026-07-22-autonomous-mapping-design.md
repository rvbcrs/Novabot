# Autonoom karteren — ontwerp (route B: BoundaryFollow + gras-rand-relay)

**Datum:** 2026-07-22
**Status:** ontwerp goedgekeurd in gesprek; wacht op Ramons spec-review
**Bouwt voort op:** maart-onderzoek BoundaryFollow (auto-memory `autonomous-mapping.md`),
perceptie-RE (`obstacle-avoidance-perception.md`), en de terrain-pijplijn van juli.

## Doel

De maaier karteert een tuin zonder handmatige boundary-rit: hij zoekt zelf de
grasrand, volgt die rond, en de firmware genereert de kaart zoals bij een
handmatige karteersessie. De gebruiker beoordeelt en corrigeert het resultaat
in het dashboard vóórdat de kaart actief wordt.

**Routekeuze (expliciet):** dit is route B uit de verkenning. Route A
(graskaart-contour uit de terrain-pijplijn) is het gedocumenteerde vangnet als
fase 0 aantoont dat rand-volgen onbetrouwbaar blijft; route C (eigen
segmentatiemodel) is latere escalatie. Beslist door Ramon op 2026-07-22.

## Kerninzichten uit eerder werk (waarom dit ontwerp)

1. **Maart 2026:** BoundaryFollow werkte 40-90 s langs nette randen, maar
   verloor de rand bij overgangen én zag de heg niet (label 1 "background"
   i.p.v. 8 "bush"). De losse onderdelen (label_relay, costmap-params) waren
   niet OTA-bestendig en zijn inmiddels van de maaier verdwenen.
2. **Juli 2026 (terrain-metingen):** het segmentatiemodel is alléén
   betrouwbaar in gras-herkenning (label 2). Alle andere labels zijn ruizig
   (94% van de objectcellen was generiek label 1).
3. **Perceptie-RE:** de "uitgeschakelde" functie is de fusion-modus (det+seg
   tegelijk), niet een model. BoundaryFollow draait op het segmentatiemodel
   dat gewoon actief is; het detectiemodel is hier irrelevant.

## Kernkeuzes (goedgekeurd)

### 1. De rand = gras/niet-gras, niet "herkende obstakels"
Nieuwe relay-node (`lawn_edge_relay`): abonneert op
`/perception/points_labeled`, hermapt **elk punt dat niet label 2 (lawn) is**
naar label 5 (fixed obstacle) en publiceert op
`/perception/points_relabeled`. De costmap ziet daardoor de gras-rand als
obstakelwand, ongeacht of het een heg, schutting, border of stoep is — de
heg-als-background-zwakte wordt irrelevant.

- Hoogte-/afstandsfilters van de bestaande pijplijn blijven van kracht
  (punten buiten 0,3-2 m diepte en buiten −0,3..1,5 m hoogte vervallen al).
- Risico: losse niet-gras-misdetecties óp het gazon worden fantoompjes in de
  local costmap. Demping: costmap raytrace-clearing + decay; zo nodig een
  N-van-M-stemfilter in de relay (pas bouwen als fase 0 het nodig bewijst).

### 2. De firmware neemt op (geen eigen GPS-recording)
De autonome rit draait bínnen een normale firmware-karteersessie: de
orkestratie start `start_scan_map` (zoals de app bij handmatig karteren),
BoundaryFollow stuurt in plaats van de joystick, en bij LOOP_CLOSED volgt de
normale afrondreeks (stop_scan_map → save_map type:0 → save_recharge_pos →
save_map type:1 — exact de bewezen BLE-mapping-flow, maar dan zonder mens).
De firmware genereert kaartbestanden zoals altijd; alles stroomafwaarts
(map-sync, dashboard, app) werkt ongewijzigd. De kapotte `recording_edge`
uit maart wordt niet gebruikt.

### 3. Goedkeuring door de gebruiker (uit de eerdere ontwerpronde)
De gegenereerde kaart wordt NIET automatisch actief. Hij komt als voorstel in
het dashboard (bestaande kaartweergave + bewerk-tools); de gebruiker
corrigeert en accepteert. Pas dan wordt hij de actieve kaart.

### 4. Veiligheid: RTK-geofence als vangnet
Tijdens de autonome rit bewaakt de orkestratie de RTK-positie: verder dan
een instelbare straal van het laadstation (default 30 m) → onmiddellijk
stoppen (bestaand stop-commando). BoundaryFollow zelf blijft op de grasrand
(dat is zijn taak), de geofence vangt ontsporing. Bestaande bumper/
obstakelvermijding blijft actief. De rit vereist RTK Fixed bij start.

### 5. OTA-bestendig vanaf dag één
Alle maaier-onderdelen (relay-node, orkestratie-uitbreiding in
`extended_commands.py`, systemd/start-script-hooks) gaan in
`research/build_custom_firmware.sh`, zodat een firmware-update ze niet meer
wist (de les van de verdwenen maart-bestanden). Runtime-costmap-parameters
worden bij elke start van de rit opnieuw gezet via `set_parameters`
(`/local_costmap/local_costmap`, pointcloud.topic →
`/perception/points_relabeled`) — nooit via YAML-patches (worden niet
geladen, maart-les).

## Architectuur

```
[dashboard "Autonoom karteren"-knop]
        │ POST /api/dashboard/auto-map/:sn/start
        ▼
[server: autoMap orchestrator]  ──────────── status/voortgang via socket
        │ extended_commands (MQTT)
        ▼
[maaier: extended_commands.py]
   1. preflight: RTK Fixed? accu >40%? geofence-config?
   2. costmap runtime-params zetten (topic → points_relabeled)
   3. lawn_edge_relay starten (of verifiëren dat hij draait)
   4. start_scan_map (firmware-opname aan)
   5. BoundaryFollow-goal sturen (follow_mode=0)
   6. bewaken: geofence, timeout (max 20 min), result-codes
   7. LOOP_CLOSED → afrondreeks (stop_scan_map, save_map 0,
      save_recharge_pos, save_map 1)  |  anders → nette abort + rapport
        ▼
[firmware genereert kaart zoals bij handmatig karteren]
        ▼
[server markeert kaart als "voorstel"; dashboard toont review-flow;
 gebruiker corrigeert/accepteert → kaart actief]
```

### Componenten

| Component | Plek | Verantwoordelijkheid |
|---|---|---|
| `lawn_edge_relay.py` | maaier (custom fw) | niet-gras → obstakel hermappen; N-van-M-filter optioneel |
| `start_auto_map` command | maaier, `extended_commands.py` | preflight, params, sessie-orkestratie, bewaking, afronding |
| `autoMap.ts` | server | start/stop/status-API, socket-voortgang, voorstel-markering |
| Review-flow | dashboard | voorstel tonen, bestaande bewerk-tools, accepteren/verwerpen |

### Result-afhandeling (BoundaryFollow-codes uit maart)

| Code | Actie |
|---|---|
| 0 LOOP_CLOSED | afrondreeks, kaart als voorstel |
| 1 NO_VALID_BOUNDARY | abort met melding "geen grasrand gevonden op startpunt" |
| 3 FOLLOW_FAILED | abort; sessie-log + laatste positie in rapport (input voor route-A-beslissing) |
| 4 SEARCHING_START_FAILED | één automatische retry vanaf 2 m verderop, daarna abort |
| timeout/geofence | stop + stop_scan_map zonder save (geen halve kaart) |

## Fasering

- **Fase 0 — kale volg-test (geen opname).** Relay + costmap-params +
  BoundaryFollow-goal, handmatig gestart via rs-exec/dashboard-knop
  "testmodus". Meetdoel: hoe ver komt hij langs de moeilijke randen
  (zandbak-overgang = maart-breekpunt)? Succescriterium: ≥1 volledige ronde
  om het testgazon zonder FOLLOW_FAILED. **Dit is de go/no-go voor de rest
  van route B; faalt dit structureel → route A.**
- **Fase 1 — opname + afronding.** start_scan_map-integratie, afrondreeks,
  kaart-als-voorstel op de server.
- **Fase 2 — dashboard-UX.** Startknop, live voortgang (bestaande
  terrain/2D-weergave), review/accepteer-flow.
- **Fase 3 — hardening.** Geofence-config in UI, retries, meertaligheid,
  documentatie voor andere gebruikers.

## Testen

- Relay: unit-tests op de hermapping (pure functie, zelfde teststijl als
  terrain_scan).
- Orkestratie: preflight-gates en result-afhandeling met gemockte
  ROS-antwoorden (zelfde patroon als bestaande extended_commands-tests).
- Server/dashboard: route-tests voor start/status/voorstel-flow (vitest).
- Veld: fase-0-protocol met meetbare uitkomst per rand-type (heg, border,
  stoep, zandbak), vastgelegd in research/documents.

## Buiten scope (bewust)

- Route A (graskaart-contour) — gedocumenteerd vangnet, geen bouwwerk nu.
- Eigen segmentatiemodel (route C).
- Multi-zone autonoom karteren (eerst één aaneengesloten gazon).
- App-UX (dashboard eerst, zoals bij objectherkenning).
