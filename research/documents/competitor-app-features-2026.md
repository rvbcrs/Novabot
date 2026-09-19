# Concurrent-apps vergeleken met OpenNova (september 2026)

Bronnen: App Store/Play Store changelogs, fabrikant-blogs en support-KB's, en 2026-reviews van
Segway Navimow, Mammotion (Luba/Yuka), TerraMow, Husqvarna Automower Connect, Ecovacs Goat,
Dreame (A1/A2/A3) en eufy (E15/E18). Vergeleken met de OpenNova-app + server op `master`
(`e90d02ee`). Links onderaan.

Legenda haalbaarheid: **[app]** alleen app, **[server]** server (+ evt. app-toggle),
**[fw]** vereist custom firmware / firmware-onderzoek, **[?]** onbekend of het kan.

---

## 1. Wat wij al hebben (en waar we gelijk of voor lopen)

| Concurrent-feature | Wie | OpenNova |
|---|---|---|
| Doodle / decoratieve maaipatronen | Navimow "Doodle", Mammotion "Tennis Ball" etc. | StartMowSheet: pattern picker, plaatsen op preview, rotatie/grootte |
| Redraw Section / partial remap | Mammotion, Navimow "boundary redrawing" | MapEditScreen: punten, push/pull-brush, obstakels, apply/undo |
| Real View / textured map | Mammotion "Real View", Navimow "Real Scene" | Drone-foto overlay met homography + 3D terrain view |
| Auto Mapping | Navimow 4.0, eufy, TerraMow | Autonomous mapping (beta) |
| Resume task from exact point | Mammotion 2.3.19 | Firmware `coverContinueDeal` + resume_navigation; rain-resume hervat geparkeerde taak |
| Rain protection (weather + sensor) | Mammotion, Navimow, Husqvarna | Open-Meteo forecast (mm, kans, look-ahead) + rain overlay + return-reason modal |
| Edge cutting / EdgeSense | Navimow 4.1.3, Dreame EdgeMaster, eufy Ride-on-Edge | Edge-cut via NTCP `only_edge_mode` + edge offset shrink/expand |
| Home Assistant | Navimow (pas sinds 4.1.3), Ecovacs via Homey | MQTT discovery: lawn_mower-entity, map-camera, online-sensor |
| Push notificaties | Mammotion "task completion notifications" | ntfy, HA, Expo push, stock-app Messages; 17 event-types |
| Cloud backup van kaarten | Mammotion (10 maps), Navimow | Export/import ZIP, portable backup/restore, Novabot-cloud import |
| Remote restart | Mammotion 1.14.3 | Mower Settings → Restart Mower |
| Firmware-updates via app | allemaal | OTA-scherm + FirmwareUpdateBanner |
| Message center | Mammotion 2.2.1 | Messages-tab |
| Multi-zone + channels | allemaal | Maps + channels + channel-missing banner |
| Work records | TerraMow, Mammotion "Mowing Report" | HistoryScreen (min, m², hoogte, richting, uitkomstlabel) |

Uniek voor ons: volledig lokaal/offline, geen account bij fabrikant, custom firmware, re-anchor
wizard, kaart-migratie tussen maaiers.

---

## 2. Aanbevolen om over te nemen (gerangschikt op waarde / kosten)

### A. Nacht-/egelbescherming: niet maaien tussen zonsondergang en zonsopkomst  **[server]**
Mammotion "Wildlife Safe Mode", Navimow "independent day/night alerts". In NL/DE/UK een echt
thema (egels). Wij ondersteunen juist nachtmaaien (LED-patch), dus dit is een expliciete
gebruikerskeuze. Implementatie: Open-Meteo, dezelfde call als `weatherService.ts`, kan
`daily=sunrise,sunset` meegeven. Schedule-runner slaat een run over (result `skipped`, reden
"night guard") of stelt uit tot zonsopkomst. Toggle in Mower Settings → Rain-sectie hernoemen
naar "Weer & tijden". Klein.

### B. Auto-reverse maairichting per run  **[server]**
Mammotion 2.3.19 "Auto-Reverse Mowing Direction" (minder platliggend gras, mooiere strepen).
Wij hebben `path_direction` per schedule. Eén kolom `alternate_direction` + bij elke run
`(path_direction + 90) % 360` of toggle 0/90. Ook als optie in StartMowSheet ("wissel richting
t.o.v. vorige run", vorige richting staat al in work_records). Zeer klein.

### C. Vorstbewaking  **[server]**
Husqvarna "Frost guard" smart routine (2026). Extend `weatherService.ts` met
`hourly=temperature_2m`; schedule overslaan als T < drempel (default 3 °C, instelbaar).
Zelfde plumbing als de regen-guard. Klein.

### D. Statistieken / maairapport  **[app][server]**
Mammotion "Task Report" (tijd bespaard, jaarcijfers), Husqvarna "statistics & tips",
TerraMow "Work Records". Wij tonen alleen losse records. Data zit al in `work_records`:
header boven de HistoryScreen-lijst met "deze week / maand / seizoen: N runs, X u, Y m²",
plus totaal maai-uren. Eén endpoint `GET /api/dashboard/work-records/summary`. Klein-middel.
Het "milieu-impact"-deel van Mammotion is fluff, overslaan.

### E. Onderhoudsherinnering messen  **[app][server]**
Mammotion "wheel maintenance reminders", Husqvarna "tips". Bouwt op D: "messen vervangen op
<datum>" + maai-uren sindsdien → banner na N uur (instelbaar, default nader bepalen; ik heb geen
bron voor Novabot-mesduur). Klein.

### F. Aanbevolen schema  **[server][app]**
Navimow "auto-generated schedules", Husqvarna EPOS "recommended schedule based on mower
capacity and work area". Wij kennen per map de `Est. mow`-tijd en accu-gedrag. Genereer een
weekvoorstel (bv. 2 zones × 3 runs/week binnen ingestelde venster) dat de gebruiker met één tik
overneemt. Middel. Goed voor nieuwe gebruikers die nu een leeg schedule-scherm zien.

### G. Geofence / buiten-kaart alert  **[server]**
Husqvarna "boundary alerts", Navimow "anti-theft/Find My". Wij hebben al de out-of-map safety
stop; er ontbreekt alleen een notification-event `out_of_map` (positie buiten alle polygonen
terwijl niet aan het mappen). Klein: hook in bestaande detectie + type toevoegen aan
`notifications/types.ts`. Echte anti-diefstal (mower uit, gestolen) kunnen we niet: geen
4G/GPS zonder stroom.

### H. "Meld een probleem" in de app  **[app]**
Navimow 4.3.0 "Contact Customer Support from the app", TerraMow "in-app feedback". Voor ons:
knop in Settings die de GitHub new-issue-URL opent met het issue-template en voorgevulde
velden (app-versie, server-versie, firmware-versie, maaier-model, laatste error_status).
Scheelt triage-heen-en-weer (zie #135, #112). Klein.

### I. Notificatie-voorkeuren per categorie  **[app][server]**
Navimow 3.1.0 "customizable notifications", Mammotion "task completion notifications".
Toggles in AppSettings: start/klaar, fouten, veiligheid, batterij, verbinding. Server filtert
per push-token. Klein-middel. (ntfy-gebruikers kunnen nu al filteren op tag.)

### J. Signaal & positionering-pagina in de app  **[app]**
Mammotion 2.2.1 "Signal & Positioning page overhaul", 1.14.5 "RTK signal detection".
Dashboard heeft `SignalChart` + `signal_history` (RSSI, sats, loc_quality). In de app zit alleen
de readiness-check bij mapping. Een diagnostiekscherm (RTK fix-type, sats, LoRa/WiFi RSSI,
24u-grafiek) helpt precies bij de vragen die we in issues krijgen. Klein-middel, data bestaat.

### K. Resterende tijd tijdens maaien  **[app]**
Ecovacs "continuous updates on how much lawn area has been mowed". Wij tonen progress-%,
geen ETA. Firmware levert `cov_remaining_area`; met `Est. mow`-snelheid per map of de gemeten
snelheid van de huidige run is "nog ~23 min" één regel in HomeScreen. Klein.

### L. Snapshot bij stuck/safety-event  **[server]**
Ecovacs/Dreame verkopen "security patrol"; dat is groot. De kleine variant: bij `stuck`,
`safety` of `dock_failed` een frame van `camera_stream.py` pakken en als bijlage in de
ntfy/Expo push meesturen. Middel-klein; vereist draaiende camera-stream. Sterk voor diagnose
op afstand.

### M. Eenvoudig / expert-modus in StartMowSheet  **[app]**
Mammotion 2.3.7 "Dual-mode task settings". Onze StartMowSheet toont alles (zone, hoogte,
richting, edge offset, pattern, preview). Standaard alleen zone + hoogte, "Geavanceerd"
uitklappen. Klein, puur UI.

---

## 3. Firmware-afhankelijk of onzeker (eerst onderzoeken, niet beloven)

| Feature | Wie | Status |
|---|---|---|
| Charge limit (80 %) / smart night charging / off-peak | TerraMow, Mammotion | **[?]** Charger-fw is stock (nooit custom). Onbekend of mower-fw laden kan stoppen. Onderzoek: BMS-commando's in `mqtt_node`/STM32. |
| Adaptive recharge (net genoeg laden om af te maken) | Mammotion | **[?]** Firmware `coverContinueDeal` heeft accu-gate 96 %. Alleen als de gate instelbaar blijkt. |
| Path spacing, perimeter laps, no-go zone laps, path order, start progress | Mammotion task settings | **[fw]** Check `coverage_planner_server`-params. Edge-cut hebben we al via NTCP. |
| Travel speed vs mow speed, blade speed | Mammotion | **[fw]** cmd_vel max 0.33 m/s bekend; blade-rpm-parameter onbekend. |
| Do Not Disturb / volume | Navimow 4.2.0 | Speaker-toggle bestaat al; een tijdvenster is laag in waarde. |
| Zone splitsen/samenvoegen in app | Navimow 2.2.5 | Groot; MapEdit dekt het praktische deel. |
| Security patrol met waypoints, sirene | Ecovacs, Dreame | Groot; zie L voor de kleine variant. |
| Low-temp battery preheat, EcoSleep charger | Mammotion | Hardware/charger-fw, nee. |
| Apple Find My | Navimow 4.0 | Hardware, nee. |
| Device sharing tussen accounts | Navimow, Mammotion | Niet nodig: eigen container per gebruiker, één login per huishouden. |

---

## 4. Voorstel volgorde

1. **B** (auto-reverse) + **A** (nachtbescherming) + **C** (vorst): drie kleine server-guards
   op dezelfde plumbing als de regen-guard, samen één PR.
2. **D** + **E** (stats + mes-onderhoud): één endpoint, header in History.
3. **H** (meld probleem) + **K** (ETA) + **M** (simple/expert): losse kleine app-PR's.
4. **G** + **I** (out-of-map event, notificatie-voorkeuren).
5. **J** (signaal-pagina), **F** (aanbevolen schema), **L** (snapshot bij event).

---

## Bronnen

- Navimow App Store versiegeschiedenis: https://apps.apple.com/us/app/navimow/id1602205067
- Navimow i1 V4.3.0 release notes: https://segwaynavimow.zendesk.com/hc/en-us/articles/61156018051353--Navimow-i1-V4-3-0-Firmware-App-Release-Notes-updated-2026-8
- Navimow X4 V4.2.0 (DND, Smooth Zero-Turn): https://navimow-support.zendesk.com/hc/en-us/articles/59076592432537--Navimow-X4-V4-2-0-Firmware-App-Release-Notes-updated-2026-6
- Navimow review (app usability, anti-theft): https://mowerbotlab.com/best/segway-navimow/
- Mammotion App 2026 features (EU): https://eu.mammotion.com/blogs/news/mammotion-app-new-features
- Mammotion App features (US): https://us.mammotion.com/blogs/news/mammotion-app-features
- Mammotion App Store versiegeschiedenis: https://apps.apple.com/us/app/mammotion/id1626028673
- Mammotion Task Settings KB: https://support.mammotion.com/portal/en/kb/articles/task-settings
- TerraMow V1000 review (9to5mac): https://9to5mac.com/2026/08/14/review-terramow-v1000-is-the-easiest-iphone-controlled-robot-lawn-mower-ive-tested/
- TerraMow Play Store (charge limit, work records): https://play.google.com/store/apps/details?id=com.roboterra.app
- Husqvarna Automower Connect: https://www.husqvarna.com/uk/services/automower-connect/
- Ecovacs Goat review: https://mowerbotlab.com/best/ecovacs-goat/
- Ecovacs Goat G1 (patrol/guarding spots): https://www.ecovacs.com/au/shop/goat-robotic-lawn-mower/goat-g1
- Dreame A2 test: https://basic-tutorials.com/reviews/gadget-reviews/dreame-a2-test/
- Dreame A2 productpagina (security patrol): https://global.dreametech.com/products/a2
- eufy E15/E18 key features: https://service.eufy.com/article-description/Introducing-the-Key-Features-of-the-E15-and-E18-Robot-Lawn-Mowers
- Marktoverzicht 2026: https://www.androidauthority.com/best-robot-mowers-of-2026-3673460/
