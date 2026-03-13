<\!-- Referentiebestand — gebruik @SESSIONS.md.md om dit te laden in een sessie -->
## Gedocumenteerde sessies

### Charger provisioning (februari 2025)
- `Novabot.pklg` — Apple PacketLogger BLE capture (macOS)
- `COnsoleLog.txt` — MQTT proxy server console output

**Resultaat**: Charger `LFIC1230700004` succesvol geprovisioneerd.
Na provisioning: charger verbindt met MQTT, publiceert `up_status_info`,
`charger_status` verandert van 0 naar operationele waarden,
`mower_error` telt op (charger zoekt maaier via LoRa).

### Maaier BLE scan (februari 2026)
- `Novabot-Mower.pklg` — Apple PacketLogger BLE capture (macOS)

**Resultaat**: Maaier `LFIN2230700238` zichtbaar als `NOVABOT` in BLE scan.
Maaier al verbonden met WiFi+MQTT en stuurt AES-CBC versleutelde berichten.
`mower_error` op charger telt op tot >90 (charger zoekt maaier via LoRa maar vindt hem niet).

### Maaier provisioning via cloud (februari 2026)
- `Novabot-Mower-cloud.pklg` — Apple PacketLogger BLE capture (macOS)
- `ConsoleLogMower.txt` — MQTT/HTTP proxy console output

**Resultaat**: Maaier `LFIN2230700238` BLE provisioning flow gecaptured via echte cloud.
Belangrijkste bevindingen: maaier gebruikt alleen `ap` WiFi (geen `sta`), geen `set_rtk_info`,
`set_cfg_info` bevat timezone, `set_lora_info_respond` geeft `value: null`.
Nieuw endpoint ontdekt: `POST /api/nova-network/network/connection` (connectivity check).
Maaier stuurt AES-CBC versleutelde MQTT berichten, charger stuurt plain JSON.

### Charger toevoegen via lokale server (februari 2026)
Charging station succesvol toegevoegd na fix van `getEquipmentBySN`, `userEquipmentList`
en `bindingEquipment` responses. App doorloopt volledige BLE provisioning flow.

### Maaier toevoegen via lokale server (februari 2026)

**Probleem**: App kon maaier niet toevoegen — meerdere issues:

1. **"Device not found"** — App roept `getEquipmentBySN` aan om `macAddress` op te halen,
   matcht deze tegen BLE manufacturer data. Server retourneerde `macAddress: null`.
   **Fix**: Maaier BLE MAC (`50:41:1C:39:BD:C1`) pre-geregistreerd in `device_registry`.

2. **App MQTT CONNECT geweigerd** — Aedes wees app af vanwege Will QoS=1 met Will Flag=0.
   **Fix**: `sanitizeConnectFlags()` in `broker.ts` patcht de raw CONNECT flags.

3. **Mower-specifieke null velden** — Cloud retourneert `account: null, password: null,
   chargerAddress: null, chargerChannel: null` voor maaier (anders dan charger!).
   **Fix**: `rowToCloudDto()` in `equipment.ts` retourneert nu conditionally null per deviceType.

4. **AES-versleutelde berichten** — Maaier stuurt AES-128-CBC versleutelde MQTT berichten.
   App v2.3.8 mist de decryptiestap — `jsonDecode()` faalt op ciphertext.
   **Opgelost**: key = `"abcdabcd1234" + SN[-4:]`, IV = `"abcd1234abcd1234"` (ontdekt via blutter v2.4.0).

5. **"The device has already been bound"** — Client-side toast in Flutter app.
   App's `_getMowerFromServer()` checkt `userId` veld uit `getEquipmentBySN` response.
   ARM64 assembly analyse (adres `0x96a504`): `stp xzr, x0, [SP]` → vergelijkt userId met 0.
   Als `userId != 0` → toast "already bound". Als `userId == 0` of `null` → BLE provisioning.
   **Fix**: Server retourneert `userId: 0` voor unbound apparaten (`user_id = NULL` in DB).

6. **Unbind → re-add flow** (cloud-identiek, februari 2026):
   - `unboundEquipment`: `UPDATE SET user_id = NULL` (record blijft, alleen binding weg)
   - `getEquipmentBySN`: retourneert `userId: 0` als `user_id` NULL → app doet BLE provisioning
   - BLE re-provisioning stuurt zelfde WiFi/MQTT/LoRa credentials → apparaat herverbindt normaal
   - `bindingEquipment`: staat altijd rebinding toe (lokale server = single-household)
   - WiFi wordt NIET verbroken: zelfde credentials worden opnieuw gestuurd via BLE

7. **`chargerChannel: 15` in plaats van `16`** — Cloud slaat het GEVRAAGDE LoRa kanaal op (16),
   niet het door de charger TOEGEWEZEN kanaal (15). Onze server retourneerde 15.
   **Fix**: `rowToCloudDto()` fallback naar 16 voor chargers, ALTIJD null voor mowers.

8. **Mower chargerAddress/chargerChannel niet-null** — Cloud retourneert altijd `null` voor deze
   velden bij de maaier. Onze server retourneerde 718/15 (stale DB waarden van vorige binding).
   **Fix**: `rowToCloudDto()` retourneert ALTIJD null voor mowers, ongeacht DB waarden:
   ```typescript
   chargerAddress: isCharger ? (r.charger_address ? Number(r.charger_address) : 718) : null,
   chargerChannel: isCharger ? (r.charger_channel ? Number(r.charger_channel) : 16) : null,
   ```

9. **`saveCutGrassRecord` retry-loop** — De maaier bombardeerde onze server met 1712 HTTP calls
   in ~85 seconden (elke ~50ms) naar `/api/nova-data/equipmentState/saveCutGrassRecord` met lege
   body `{}`. Oorzaak: maaier stuurt multipart/form-data die Express niet parseert → sn ontbreekt
   → server retourneert 400 → maaier retry → oneindige loop.
   **Fix**: retourneer `ok(null)` bij ontbrekende sn i.p.v. 400 error.
   **Belangrijk**: deze retry-loop blokkeerde mogelijk het MQTT reconnect mechanisme van mqtt_node.

10. **Maaier herstart was nodig na eerste BLE provisioning** — Bij de eerste test verbond de maaier
    niet met MQTT na BLE provisioning. Oorzaak: combinatie van verkeerde chargerAddress/chargerChannel
    waarden (718/15 i.p.v. null) en saveCutGrassRecord retry-loop die mqtt_node blokkeerde.
    Na fixes 7-9 en unbind → re-add test verbindt de maaier **zonder herstart**.

**Resultaat (28 februari 2026)**: Maaier volledig werkend via lokale server!
- Unbind → re-add flow werkt identiek aan de cloud
- BLE provisioning compleet: WiFi blijft verbonden na re-provisioning
- Maaier verbindt met MQTT **zonder herstart** (na fixes chargerChannel + saveCutGrassRecord)
- Maaier-berichten worden als AES-ciphertext doorgestuurd naar de app
- De server ontsleutelt zelf ook (key derivatie bekend)
- Volledige end-to-end flow getest en bevestigd werkend

### App userId check — ARM64 assembly bewijs (februari 2026)

Bron: blutter decompilatie `add_mower_page/logic.dart`, methode `_getMowerFromServer@883255105`.

**Exacte assembly (adres 0x96a4a8-0x96a538):**
```
0x96a4a8: r30 = "userId"           // Lees userId uit response
0x96a4c8: cmp w0, NULL             // Als null → skip naar 0x96a538
0x96a4cc: b.eq #0x96a538
0x96a4d4: r30 = "userId"           // Lees userId waarde
0x96a4f4: r1 = 59                  // Class ID 59 (Smi = small integer)
0x96a4f8: branchIfSmi(r0, 0x96a504) // Type check
0x96a504: stp xzr, x0, [SP]       // Push 0 (xzr=zero register) + userId op stack
0x96a514: blr lr                   // Dispatch call (operator ==)
0x96a518: tbz w0, #4, #0x96a538   // Als bit4=0 (true) → skip "already bound"
0x96a51c: r16 = "The device has already been bound."
```

**Dart equivalent:**
```dart
var userId = response['userId'];
if (userId != null && userId != 0) {
  showToast("The device has already been bound.");
  return;
}
// Ga door met BLE provisioning...
```

**Implicaties voor server:**
- `userId: 0` of `userId: null` → app gaat door met BLE provisioning (normaal)
- `userId: <elke waarde != 0>` → "already bound" toast (zelfs voor eigen apparaat!)
- Cloud retourneert `userId: 86` voor gebonden apparaat, `userId: 0` na unbind
- Na unbind triggert de app dus altijd BLE re-provisioning — dit is by design

### Equipment binding lifecycle (cloud-identiek, februari 2026)

**Database schema**: `equipment.user_id` is nullable (`TEXT`). Cloud verwijdert records nooit.

| Actie | `user_id` in DB | `getEquipmentBySN` response | App gedrag |
|-------|----------------|----------------------------|------------|
| Fabriek (nieuw) | `NULL` | `userId: 0` | BLE provisioning |
| Na binding | `<app_user_id>` | `userId: <numeric_id>` | Apparaat in lijst, "already bound" bij re-add |
| Na unbind | `NULL` | `userId: 0` | BLE provisioning (zelfde WiFi → geen verlies) |
| Na re-bind | `<app_user_id>` | `userId: <numeric_id>` | Apparaat terug in lijst |

**`bindingEquipment` handler** (equipment.ts):
- Check `existing` record op `mower_sn` of `charger_sn`
- Als bestaat: `UPDATE SET user_id = ?, charger_channel = COALESCE(...)` (altijd, geen "already bound" reject)
- Als niet bestaat: `INSERT` nieuw record

**`unboundEquipment` handler** (equipment.ts):
- `UPDATE SET user_id = NULL WHERE id = ?` (niet DELETE)
- LoRa parameters worden gecached in `equipment_lora_cache` voor re-bind

### Cloud vs lokale server — maaier provisioning analyse (februari 2026)

Systematische vergelijking van cloud-proxy capture (`ConsoleLogMower.txt`) en lokale server responses
om te verklaren waarom maaier WiFi provisioning lokaal faalt maar via cloud werkt.

**Bronbestanden:**
- `ConsoleLogMower.txt` — Cloud-proxy capture van maaier OPERATIONELE sessie (apparaten al gebonden)
- `COnsoleLog.txt` — Lokale server capture van CHARGER toevoegen (niet maaier!)
- `Novabot-Mower-cloud.pklg` — BLE capture cloud maaier provisioning
- `Novabot-Local.pklg` — BLE capture lokale charger provisioning (207KB, 4+ retry cycles)
- Blutter v2.4.0 ARM64 assembly analyse van `AddMowerPageLogic`

**Belangrijke correctie**: `COnsoleLog.txt` is de capture van het CHARGER toevoegen (niet de maaier).
Het toevoegen van het charging station werkt lokaal prima. Het probleem is specifiek de MAAIER.

**Gebruikersbevestiging**: BLE staat/uit is NIET het probleem. Toevoegen via cloud route (lfibot.com)
werkt direct, daarna via lokale server niet, zonder tussentijdse BLE wijziging. De app zelf controleert
BLE — als het werkt met cloud moet het ook werken met lokaal. Het verschil zit PUUR in de server responses.

**Firmware versie correctie**: v0.3.6 is CHARGER firmware. v5.7.1 en v6.0.0 zijn MAAIER firmwares.

**Blutter-bevinding: app gebruikt ALLEEN `macAddress` en `userId` uit `getEquipmentBySN` voor BLE provisioning.**
BLE commando parameters (WiFi SSID/passwd, LoRa addr/channel, MQTT host/port) komen uit user input
en hardcoded waarden — NIET uit de server response. De LoRa channel voor de maaier komt uit de
charger's equipment record (uit `userEquipmentList`), niet uit de maaier's eigen record.

Assembly bewijs (blutter `_writeSetLoraInfo` op 0x91bebc):
- `r0->field_23 -> field_1b` → equipment controller field (charger's chargerChannel)
- `"addr"` = vaste waarde 718
- `"channel"` = gelezen uit charger equipment record

Assembly bewijs (blutter `_getMowerFromServer` op 0x921e48):
- `0x921f2c: r16 = "macAddress"` → gevalideerd op niet-null
- `0x921f58: "Device is missing mac address."` → error als null
- `0x921f74: r30 = "userId"` → vergelijking met 0 voor "already bound" check

**Gevonden en GEFIXT response-verschillen (cloud vs lokaal, feb 2026):**

| # | Verschil | Cloud response | Was lokaal | Fix |
|---|----------|---------------|-----------|-----|
| 1 | `sysVersion` voor maaier | `"v6.0.0"` | `"v0.3.6"` (charger FW!) | **GEFIXT**: rowToCloudDto gebruikt nu mower_version voor mowers, default `"v5.7.1"` |
| 2 | `model` voor maaier | `"N2000"` | `"N1000"` (hardcoded) | **GEFIXT**: `N2000` voor mowers, `N1000` voor chargers |
| 3 | `userId` in `userEquipmentList` | **Ontbreekt** | `userId: 0` | **GEFIXT**: userId verwijderd uit list entries |
| 4 | `queryEquipmentMap` response | `{data:null, md5:null, ...}` | `[]` (array) | **GEFIXT**: retourneert nu cloud-identiek object |
| 5 | `queryRecentCutGrassPlan` | Null-velden object | `null` | **GEFIXT**: retourneert nu cloud-identiek null-velden object |
| 6 | `queryMsgMenuByUserId` | `{workRecordMsg, robotMsg, ...}` | `{robotMsgUnreadCount, ...}` | **GEFIXT**: retourneert nu cloud-identiek formaat |
| 7 | `chargerChannel` charger record | `16` (gevraagd kanaal) | `15` (toegewezen kanaal) | **GEFIXT**: DB en code op 16 gezet, mower altijd null |

**Mogelijke resterende oorzaak: `macAddress: null` bij verse installatie.**
Als de maaier nog niet verbonden is met de lokale MQTT broker (bijv. net na DNS switch),
retourneert `getEquipmentBySN` `macAddress: null`. De app toont dan "Device is missing mac address"
en kan geen BLE scan doen. De cloud heeft de MAC altijd (factory-geïmporteerd).
Fix: BLE MAC pre-registreren in device_registry, of `wifiStaToBle()` ARP-detectie afwachten.

### APK v2.4.0 blutter analyse (februari 2026)
- `NOVABOT_2.4.0_APKPure-arm64.xapk` — ARM64 XAPK van APKPure
- Blutter output in `blutter_output_v2.4.0/`

**Resultaat**: AES encryptie volledig reverse-engineered.
- Nieuwe module `encrypt_utils.dart` gevonden (ontbreekt in v2.3.8)
- Key formule: `"abcdabcd1234" + SN.substring(SN.length - 4)` (16 bytes UTF-8 → AES-128)
- IV: `"abcd1234abcd1234"` (statisch)
- Alle 4 gecaptured payloads succesvol ontsleuteld naar valide JSON
- 3 report types geïdentificeerd: `report_state_robot`, `report_exception_state`, `report_state_timer_data`
- Maaier data: batterij 100%, status CHARGING, GPS ~52.14°N/6.23°E, 29 RTK sats, WiFi RSSI 55, CPU 35°C

### Charger firmware Ghidra decompilatie (februari 2026)
- `charger_ota0_v0.3.6.elf` — ELF conversie via custom `esp32s3_to_elf.py`
- `ghidra_output/charger_v036_decompiled.c` — 7405 functies gedecompileerd (7.6MB)

**Resultaat**: Charger firmware architectuur volledig reverse-engineered.
- **Charger = MQTT ↔ LoRa bridge** — vertaalt JSON MQTT commando's naar binaire LoRa pakketten
- **LoRa module**: EBYTE E32/E22 serie op UART1 (TX=GPIO17, RX=GPIO18, M0=GPIO12, M1=GPIO46)
- **LoRa packet format**: `[02 02 00 03][len+1][payload][XOR checksum][03 03]`
- **6 LoRa command categorieën**: CHARGER(0x30), RTK_RELAY(0x31), CONFIG(0x32), GPS(0x33), REPORT(0x34), ORDER(0x35)
- **MQTT → LoRa mapping**: start_run→0x35/0x01, pause→0x35/0x03, resume→0x35/0x05, stop→0x35/0x07, go_pile→0x35/0x0B
- **charger_status bitfield gedecodeerd**: bit 0=GPS valid, bit 8=RTK valid, byte 3=GPS satelliet-aantal
- **mower_error = LoRa heartbeat failure counter** (reset bij succesvolle maaier response, alleen gerapporteerd als >= 2)
- **Maaier positie via LoRa**: mower_x/y/z als 3-byte (uint24) waarden, mower_status/info als 4-byte (uint32)
- **RTK GPS relay**: charger relayt GNGGA NMEA van UM960 naar maaier via LoRa voor cm-nauwkeurige navigatie
- **Security**: geen MQTT auth, geen AES, UART debug console zonder auth, WiFi wachtwoorden in plaintext NVS
- **NVS structuur**: fctry (sn_code, sn_flag) + storage (wifi_data, wifi_ap_data, mqtt_data, lora_data, rtk_data, cfg_flag)
- **BLE provisioning**: 20-byte chunks (niet 27 — verschil door ATT header overhead), 30ms inter-chunk delay

### Cloud API reverse-engineering en data export (februari 2026)
- Cloud login via AES-versleuteld wachtwoord naar `47.253.145.99`
- Request signature algoritme gekraakt via blutter + brute-force verificatie
- Alle historische data geëxporteerd naar `research/cloud_data/`
- OTA firmware bestanden gedownload: charger v0.3.6 (1.4MB) + maaier v5.7.1 (35MB)
- Cloud data geïmporteerd in lokale SQLite database (50 work records + test kaart)
- Script: `/tmp/novabot_cloud_fetch.js` (herbruikbaar voor toekomstige data export)

**Resultaat**: Cloud API volledig reverse-engineered. Signature formule:
`SHA256(echostr + SHA1("qtzUser") + timestamp_ms + token)`.
Maaier firmware blijkt een Debian pakket met ROS 2 op Horizon Robotics X3 SoC.

### Maaier firmware diepe analyse (februari 2026)
- `mower_firmware_v5.7.1.deb` uitgepakt (7570 bestanden, ROS 2 Galactic)
- AI perceptie systeem volledig geanalyseerd

**Resultaat**: AI obstakeldetectie is VOLLEDIG GEÏMPLEMENTEERD en ACTIEF:
- **Hardware**: Horizon Robotics X3 SoC met BPU AI accelerator
- **Camera's**: Sony IMX307 (1920x1080 RGB) + PMD Royale (ToF depth)
- **Detectie model**: `novabot_detv2_11_960_512.bin` (8.1MB) — 9 klassen (person, animal, obstacle, shoes, wheel, leaf debris, faeces, rock, background)
- **Segmentatie model**: `bisenetv2-seg_2023-11-27_512-960_vanilla.bin` (3.6MB BiSeNet-v2) — 14 klassen (lawn, road, terrain, obstacles, bush, charging station, glass)
- **Inference**: 100 Hz op Horizon BPU, geïntegreerd met Nav2 costmap voor padplanning
- **Versie**: V0.5.3d (2024/06/12), actief doorontwikkeld door developer `youfeng`

### React dashboard + kaart calibratie (februari 2026)
- React dashboard gebouwd met Vite + Tailwind + Leaflet + Socket.io
- PDOK luchtfoto satellite imagery als kaartlaag (7.5cm resolutie Nederland)
- Kaart calibratie tool: offset (nudge N/S/E/W), rotatie (-180°/+180°), schaal (0.5x-2.0x)
- GeoJSON polygon van tuin geïmporteerd als werkgebied voor LFIN2230700238
- Polygon click highlight (custom highlight i.p.v. Leaflet default selectie)
- Backend: sensorData.ts (shared cache), socketHandler.ts, dashboard REST routes, map_calibration tabel

### Dashboard uitbreiding: scheduler, heatmap, heading, export (februari 2026)

**Maaischema systeem (Scheduler):**
- Nieuwe `dashboard_schedules` tabel in SQLite (schedule_id, mower_sn, start/end_time, weekdays, cutting_height, etc.)
- CRUD REST endpoints: GET/POST/PATCH/DELETE `/api/dashboard/schedules/:sn[/:scheduleId]`
- MQTT push: `timer_task` + `set_para_info` naar maaier bij aanmaken en via `/send` endpoint
- React component: `Scheduler.tsx` — weekdag selector, kaart keuze, maaihoogte slider, pad richting
- Integratie in DashboardPage als uitklapbaar zijpaneel (Calendar knop in header)

**MQTT command publishing:**
- `POST /api/dashboard/command/:sn` — stuur willekeurig MQTT commando naar apparaat
- `publishToDevice()` in mapSync.ts geëxporteerd voor hergebruik vanuit dashboard routes

**Maaier heading weergave:**
- MowerMap ontvangt nu `heading` prop (uit `z` / `mower_z` sensor)
- Custom SVG DivIcon met groene cirkel + witte pijl, roteert met heading
- Vervangt standaard Leaflet marker

**GPS trail heatmap:**
- Toggle knop "Heat" op kaart toolbar
- Trail gesplitst in ~30 segmenten met kleurverloop: rood (oud) → groen (nieuw)
- Opacity stijgt van 0.3 naar 0.8 voor recentere segmenten

**Coverage statistieken:**
- Per werkgebied polygon: tel trail points binnen polygon (ray casting)
- Schatting: elke trail point ≈ 0.25m² (0.5m maaibreedte × 0.5m spacing)
- Voortgangsbalk met percentage in kaart info panel

**Polygon oppervlakte:**
- Shoelace formule op GPS coördinaten → m² (met cos(lat) correctie)
- Getoond in kaart info panel naast puntenaantal

**Map export:**
- `POST /api/dashboard/maps/:sn/export-zip` → genereert Novabot-formaat ZIP
- Charger GPS positie als referentiepunt (doorgestuurd vanuit DashboardPage)
- Download knop op kaart toolbar

**Overige wijzigingen:**
- `chargerLat`/`chargerLng` props doorgestuurd naar MowerMap vanuit charger device sensors
- `Schedule` TypeScript interface toegevoegd aan dashboard types
- API client uitgebreid: `sendCommand`, `exportMaps`, `fetchSchedules`, `createSchedule`, `updateSchedule`, `deleteSchedule`, `sendSchedule`

### BLE Traffic Logger (februari 2026)

Real-time BLE traffic logger, parallel aan de bestaande MQTT logger.

**Server-side (`novabot-server/src/ble/bleLogger.ts`):**
- Background passive BLE scanner via Noble (CoreBluetooth op macOS)
- Logt advertisements van Novabot devices (naam-filter: `novabot`, `charger_pile`, `charger`)
- Extraheert MAC uit manufacturer data (company ID 0x5566)
- Deduplicatie: zelfde device max elke 2 seconden
- `pushBleLog(entry)` — toevoegen aan buffer + Socket.io broadcast
- `initBleLogger(emit)` — start background scan met Socket.io emit functie
- `sendBleLogHistory(emit)` — stuur buffer naar nieuwe dashboard client
- `pauseBackgroundScan()` / `resumeBackgroundScan()` — coördinatie met provisioner

**BleLogEntry interface:**
```typescript
{
  ts: number;
  type: 'advertisement' | 'connect' | 'disconnect' | 'write' | 'notify' | 'read' | 'error';
  deviceName: string;
  mac: string;
  rssi: number;
  service?: string;
  characteristic?: string;
  data?: string;        // hex (advertisements) of JSON (GATT operations)
  direction?: '→DEV' | '←DEV' | '';
}
```

**Socket.io events:**
| Event | Richting | Beschrijving |
|-------|----------|-------------|
| `ble:log` | server → browser | Enkel BLE log entry (real-time) |
| `ble:log:history` | server → browser | Buffer bij connect (max 500 entries) |

**Dashboard integratie:**
- `useDevices()` hook retourneert nu ook `bleLogs: BleLogEntry[]`
- `useSocket()` luistert op `ble:log` en `ble:log:history`
- `LogConsole` component heeft MQTT/BLE tab-toggle
- BLE entries tonen: timestamp, type badge, device naam, MAC, RSSI, service/char, data
- Kleurcodering: mower=emerald (Novabot), charger=yellow (CHARGER_PILE)

**Provisioner integratie:**
- `provisioner.ts` logt alle GATT writes en notify responses via `pushBleLog()`
- Connect/disconnect events worden gelogd
- Background scan wordt gepauzeerd tijdens provisioning/raw diagnostic

### Camera en netwerk analyse maaier (februari 2026)
- Camera systeem volledig geanalyseerd: dual Sony IMX307 + PMD ToF, GDC fisheye correctie
- Video streaming **niet geïmplementeerd** — was selling point maar nooit gebouwd in software
- Geen remote toegang: geen SSH, telnet, VNC (expliciet verwijderd), HTTP server
- ROS 2 is localhost-only, camera data verlaat maaier nooit
- Debug mode in firmware was gepland maar uitgecommentarieerd
- PCB foto's geanalyseerd (eigen + TÜV rapport CN23XAMH 001):
  - X3A Board: Horizon X3 SoM, AP6212 WiFi/BLE, UART header, micro-HDMI "DEBUG", USB 3.0
  - Motor Board: STM32F407, GPS module, LoRa receiver, relays
- Fysieke toegang mogelijk via UART (115200 baud) of HDMI+USB keyboard
- IP56 waterdicht — voorzichtig openen om seals niet te beschadigen

### Cloud API data export (februari 2026)
Cloud data opgehaald via directe API calls naar `47.253.145.99` (app.lfibot.com).

**Resultaat**: Alle historische data geëxporteerd naar `research/cloud_data/`:
- `work_records.json` — 50 maairecords (april-juli 2024), geïmporteerd in lokale database
- `firmware_versions.json` — OTA versies per equipment type
- Maaier details: model N2000, cloud versie v6.0.0, verloopt 2026-11-16
- Charger details: model N1000, versie v0.3.6, verloopt 2029-02-22
- Cloud slaat WiFi wachtwoorden op in plaintext (zichtbaar in equipment response)
- Robot messages endpoint gebroken (cloud retourneert 500)

### Cloud API authenticatie (reverse-engineered, februari 2026)

HTTP request signature algoritme ontdekt via blutter decompilatie van `flutter_novabot/common/http.dart`
en geverifieerd via brute-force testing tegen bekende proxy log waarden.

**Login:**
- `POST /api/nova-user/appUser/login`
- Wachtwoord versleuteld met AES-128-CBC: key/IV = `1234123412ABCDEF`, base64 output
- Response bevat UUID `accessToken` (niet JWT)

**Request headers (alle authenticated requests):**
| Header | Waarde | Beschrijving |
|--------|--------|-------------|
| `Authorization` | `<accessToken>` | UUID token uit login |
| `echostr` | `p` + 12 random hex chars | Random nonce |
| `nonce` | `1453b963a29b5441b839b18939aaf0817944300b` | **Statisch**: SHA1("qtzUser") |
| `timestamp` | `String(Date.now())` | Milliseconden |
| `signature` | SHA256(echostr + nonce + timestamp + token) | Request handtekening |
| `source` | `app` | Vast |
| `userlanguage` | `en` | Taalinstelling |

**Signature formule:**
```javascript
const nonce = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
const sig = crypto.createHash('sha256').update(echostr + nonce + ts + token, 'utf8').digest('hex');
```

**Let op:** Header naming is opzettelijk misleidend:
- `echostr` = random waarde (is eigenlijk de nonce)
- `nonce` = statische hash (is eigenlijk een constante)

**Backend:** Spring Boot microservices achter nginx + Spring Cloud Gateway.
5 services: nova-user, nova-data, nova-file-server, novabot-message, nova-network.
Swagger niet gedeployed (404), Spring Boot Actuator geblokkeerd door nginx (403).

### OTA firmware downloads (februari 2026)

Firmware bestanden gedownload vanuit cloud OTA API en opgeslagen in project root:

| Bestand | Grootte | MD5 | Beschrijving |
|---------|---------|-----|-------------|
| `charger_ota_v0.3.6_cloud.bin` | 1.4 MB | `5a2712054309211cbdbb5d25a3d279f1` | Charger ESP32-S3 OTA |
| `mower_firmware_v5.7.1.deb` | 35 MB | `83c2741d05c9a40ff351332af2082d7c` | Maaier Linux/ROS 2 Debian pakket |

**OTA systeem**: Cloud retourneert altijd alleen de laatst beschikbare versie per apparaattype.
Geen tussenversies beschikbaar. Alibaba OSS bucket listing is geblokkeerd.

**Download URLs:**
- Charger: `https://novabot-oss.oss-accelerate.aliyuncs.com/novabot-file/lfi-charging-station_lora-1709264279437.bin`
- Maaier: `https://novabot-oss.oss-us-east-1.aliyuncs.com/novabot-file/lfimvp-20240915571-1726376551929.deb`

---

