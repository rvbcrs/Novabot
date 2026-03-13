<\!-- Referentiebestand — gebruik @MAP-SYNC.md.md om dit te laden in een sessie -->
## Kaart synchronisatie naar maaier — deep analysis (februari 2026)

### Twee coördinatensystemen

De maaier werkt met **twee coördinatensystemen**:

1. **Intern**: Lokale x,y meters relatief t.o.v. het laadstation (CSV bestanden in `/userdata/lfi/maps/home0/csv_file/`)
2. **Extern**: GPS lat/lng via UTM projectie (`+proj=utm +zone=N +north +ellps=WGS84`), gerapporteerd via MQTT als `map_position`

De localisatie module (`robot_combination_localization`) doet de conversie:
- GPS (WGS84) → UTM → lokaal referentiekader (relatief t.o.v. charging station)
- UTM origin wordt opgeslagen en geladen via `SaveUtmOriginInfo` / `LoadUtmOriginInfo` ROS services
- Firmware log: `"Setting utm origin: zone: %d utm_x: %.3f utm_y:%.3f longitude: %.7f latitude: %.7f"`

### CSV/ZIP kaartformaat (bevestigd uit firmware)

Kaarten worden opgeslagen in `/userdata/lfi/maps/home0/csv_file/`:

```
csv_file/
├── map_info.json          (charging_pose + per-kaart map_size)
├── map0_work.csv          (werkgebied 0 - x,y meters)
├── map0_0_obstacle.csv    (obstakel 0 bij werkgebied 0)
├── map0tocharge_unicom.csv (kanaal van werkgebied 0 naar laadstation)
├── map1_work.csv          (werkgebied 1)
└── map_0_unicom.csv       (kanaal type 2)
```

**CSV formaat**: comma-separated x,y lokale coördinaten (meters, float):
```
-0.0306977,-0.918932
-0.0388416,-0.868202
-9.62,-8.29
```

**map_info.json**:
```json
{
  "charging_pose": { "orientation": 1.326, "x": -0.048, "y": -0.180 },
  "map0_work.csv": { "map_size": 149.28 },
  "map1_work.csv": { "map_size": 26.62 }
}
```

Onze `mapConverter.ts` genereert **exact dit formaat** vanuit GPS polygonen.

### MQTT commando's relevant voor kaart-synchronisatie

#### `save_map` (cpp:3606) — Finaliseer mapping sessie

Slaat de **huidige intern gebouwde** kaart op. Accepteert GEEN externe coördinaten.

```json
{"save_map": {"mapName": "home"}}
```

ROS service: `/robot_decision/save_map` → `SaveMap.srv`:
```
string mapname      # Kaartnaam
float32 resolution  # Grid resolutie (meters, typisch 0.02-0.05)
int64 type          # Kaarttype (0=work, 1=obstacle, 2=unicom)
---
string data
uint8 result
uint8 error_code    # 1=OVERLAPING_OTHER_MAP, 2=OVERLAPING_OTHER_UNICOM, 3=CROSS_MULTI_MAPS
```

#### `area_set` (cpp:7437) — Definieer gebied via GPS bounding box

Stuurt GPS coördinaten naar de maaier om een gebied te definiëren.

```json
{
  "area_set": {
    "latitude1": 52.1409,
    "longitude1": 6.2310,
    "latitude2": 52.1412,
    "longitude2": 6.2315,
    "map_name": "map0"
  }
}
```
Response: `area_set_respond`

ROS service: `/robot_decision/add_area`

#### `update_virtual_wall` (cpp:7400) — Update obstakelbarrières

```json
{
  "update_virtual_wall": {
    "virtual_wall": [...],
    "map_name": "map0"
  }
}
```
Response: `update_virtual_wall_respond`

#### `delete_map` (cpp:3812) — Verwijder kaart

```json
{"delete_map": {"map_name": "map0", "map_type": 0}}
```
Response: `delete_map_respond`

ROS service: `/robot_decision/delete_map` → `DeleteMap.srv`:
```
uint8 maptype       # 0=work, 1=obstacle, 2=unicom
string mapname
```

### StartCoverageTask — Maaien starten MET polygoon

De belangrijkste ontdekking: bij het starten van een maaissessie kan de maaier
**GPS polygoon-coördinaten** accepteren in `SPECIFIED_AREA` modus.

ROS service: `/robot_decision/start_cov_task` → `StartCoverageTask.srv`:
```
uint8 NORMAL=0              # Normaal: maai opgeslagen kaart
uint8 SPECIFIED_AREA=1      # Maai binnen meegegeven polygoon
uint8 BOUNDARY_COV=2        # Alleen randen maaien

uint8 cov_mode              # Maaien modus (0/1/2)
uint8 request_type          # Bron: 11=app normaal, 12=schema, 21=MCU normaal, 22=MCU schema
uint32 map_ids              # Kaart ID (als map_id > 0, prioriteit boven map_names)
string[] map_names          # Kaart namen om te maaien
geometry_msgs/Point[] polygon_area  # GPS polygoon punten (voor SPECIFIED_AREA)
uint8[] blade_heights       # Maaihoogtes (0-7, hoogte = (level+2)*10 mm)
bool specify_direction
uint8 cov_direction         # Maairichting 0-180°
uint8 light                 # LED helderheid
bool specify_perception_level
uint8 perception_level      # 0=uit, 1=detectie, 2=segmentatie, 3=gevoelig
uint8 blade_info_level      # 0=default, 1=alles uit, 2=buzzer, 3=LED, 4=alles aan
bool night_light            # Nacht LED toestaan
bool enable_loc_weak_mapping  # Mapping bij zwak GPS signaal
bool enable_loc_weak_working  # Maaien bij zwak GPS signaal
---
bool result
```

**MQTT → ROS mapping** (in `mqtt_node`):
- `start_run` MQTT commando op charger → LoRa relay → maaier
- Op maaier zelf: `mqtt_node` vertaalt JSON naar `StartCoverageTask` service call
- Velden uit MQTT JSON (cpp:13362-13389): `workArea`, `cutGrassHeight`, `mapNames`, `startWay`, `schedule`, `scheduleId`

### GenerateCoveragePath — Preview maaipad

```json
{"generate_preview_cover_path": {"map_ids": 0, "cov_direction": 90}}
```
Response: `generate_preview_cover_path_respond`

ROS service: `/robot_decision/generate_preview_cover_path` → `GenerateCoveragePath.srv`:
```
uint32 map_ids
bool specify_direction
uint8 cov_direction     # 0-180°
---
bool result
```

### Alle ROS 2 services voor kaarten/navigatie

| ROS Service | MQTT Trigger | Beschrijving |
|-------------|-------------|-------------|
| `/robot_decision/start_mapping` | `start_scan_map` | Start handmatig kaart bouwen |
| `/robot_decision/add_area` | `area_set` | Gebied toevoegen via GPS bbox |
| `/robot_decision/map_stop_record` | `stop_scan_map` | Stop mapping opname |
| `/robot_decision/reset_mapping` | `reset_map` | Reset mapping sessie |
| `/robot_decision/save_map` | `save_map` | Sla kaart op als CSV/ZIP |
| `/robot_decision/start_assistant_mapping` | `start_assistant_build_map` | Automatisch kaart bouwen |
| `/robot_decision/delete_map` | `delete_map` | Verwijder kaart |
| `/robot_decision/start_erase` | `start_erase_map` | Wis deel van kaart |
| `/robot_decision/save_charging_pose` | `save_recharge_pos` | Sla laadstation positie op |
| `/robot_decision/nav_to_recharge` | `go_to_charge` | Navigeer naar laadstation |
| `/robot_decision/cancel_recharge` | `stop_to_charge` | Stop terugkeer naar laadstation |
| `/robot_decision/auto_recharge` | `auto_recharge` | Automatisch herladen |
| `/robot_decision/start_cov_task` | `start_run` | Start maaien |
| `/robot_decision/stop_task` | `stop_run` | Stop maaien |
| `/robot_decision/cancel_task` | (intern) | Annuleer taak |
| `/robot_decision/generate_preview_cover_path` | `generate_preview_cover_path` | Genereer maaipad preview |
| `/robot_decision/quit_mapping_mode` | `quit_mapping_mode` | Verlaat mapping modus |
| `/robot_decision/map_position` | (subscription) | Maaier positie tijdens mapping |

### ROS 2 topics voor mapping

| Topic | Beschrijving |
|-------|-------------|
| `/robot_decision/map_position` | Real-time maaier positie tijdens mapping |
| `/novabot_mapping/in_map_area` | Boolean: maaier binnen gedefinieerd gebied? |
| `/novabot_mapping/if_closed_cycle` | Polygoon gesloten detectie |
| `/novabot_mapping/save_csv_file` | Bestandsnaam na CSV save |
| `/novabot_mapping/start_build_unicom_area` | Start kanaal-detectie tussen kaarten |
| `/novabot_mapping/if_unicom_can_stop` | Kanaal bouwen klaar? |

### Mapping flow: hoe kaarten worden gebouwd

**Fysieke mapping (normaal gebruik):**
1. App stuurt `start_scan_map` (handmatig) of `start_assistant_build_map` (automatisch)
2. Maaier rijdt rond de grens, registreert GPS/lokale punten
3. Tijdens rijden: `/novabot_mapping/if_closed_cycle` detecteert wanneer polygoon gesloten is
4. App stuurt `stop_scan_map` → maaier stopt opname
5. App stuurt `save_map` met `mapName` → maaier schrijft CSV + map_info.json
6. Na save: overlapping validatie (error codes 1-3)
7. Automatisch: `start_build_unicom_area` detecteert kanalen tussen werkgebieden
8. Maaier publiceert `report_state_map_outline` met GPS polygoon via MQTT
9. App/server ontvangt outline → opslaan in database

**BLE bestandsoverdracht (firmware):**
- mqtt_node heeft BLE file handler (cpp:12107-12332) voor ZIP transfer
- Stuurt/ontvangt ZIP bestanden vanuit `/userdata/lfi/maps/home0/csv_file/`

**Cloud upload door maaier (cpp:6820-6850):**
- Maaier uploadt zelf de ZIP naar cloud: `http://<server>/api/nova-file-server/map/uploadEquipmentMap`
- Server adres gelezen uit `/userdata/lfi/http_address.txt`
- Dit is **maaier → cloud** richting, niet andersom

### Conclusie: drie synchronisatie-opties

**Optie 1: Dashboard-polygonen meesturen bij start_run (SPECIFIED_AREA modus)**
- `StartCoverageTask.srv` accepteert `polygon_area` (GPS punten) + `cov_mode=1`
- Geen opgeslagen kaart nodig op de maaier
- Dashboard tekent gebied → bij "Start maaien" stuur polygoon als parameter mee
- **Meest haalbaar zonder fysieke toegang**

**Optie 2: CSV/ZIP direct op maaier plaatsen (vereist SSH)**
- `mapConverter.ts` genereert exact het juiste formaat
- Kopieer naar `/userdata/lfi/maps/home0/csv_file/`
- Vereist eerst UART/HDMI toegang om SSH te installeren
- **Meest complete oplossing** — kaarten persistent op maaier

**Optie 3: Dashboard-kaarten als visuele referentie**
- Kaarten in database zijn puur informatief
- Opgehaald van maaier via `get_map_outline` → `report_state_map_outline`
- Nieuwe tekeningen lokaal opgeslagen, niet automatisch naar maaier gestuurd
- **Huidige situatie**

### Maaier HTTP uploads naar server (firmware → cloud)

De maaier firmware (`mqtt_node`) heeft een eigen HTTP client (`http_work_fun`, cpp:6820+) die
data uploadt naar de server. Door DNS rewrite stuurt de maaier naar onze lokale server.
De server-URL wordt gelezen uit `/userdata/lfi/http_address.txt`.

**Endpoints die de maaier aanroept:**

| Endpoint | Event | Beschrijving |
|----------|-------|-------------|
| `POST /api/nova-file-server/map/uploadEquipmentMap` | `UPDATA_EVENT_MAP` | **Kaart ZIP upload** na mapping |
| `POST /api/nova-file-server/map/uploadEquipmentTrack` | `UPDATA_EVENT_PATH_LIST` | Maaipad upload (planned_path) |
| `POST /api/nova-data/cutGrassPlan/queryPlanFromMachine` | `UPDATA_EVENT_PLAN` | Maaischema ophalen |
| `POST /api/nova-data/equipmentState/saveCutGrassRecord` | `UPDATA_EVENT_WORK_RESULT` | Maairesultaat opslaan |
| `POST /api/nova-message/machineMessage/saveCutGrassMessage` | `UPDATA_EVENT_CLICK_EVENT_RESULT` | Maai-notificatie opslaan |
| `POST /api/nova-user/equipment/machineReset` | `UPDATA_EVENT_UNBIND` | Apparaat reset/unbind |
| `POST /api/nova-network/network/connection` | (periodiek) | Connectivity check |

#### `uploadEquipmentMap` — kaart upload van maaier

De maaier uploadt de kaart-ZIP via `curl_formadd` (libcurl multipart/form-data):

**Upload velden (uit firmware strings cpp:6421-6700):**
| Veld | Beschrijving |
|------|-------------|
| `local_file` | Het ZIP bestand (binary) |
| `local_file_name` | Bestandsnaam van de ZIP |
| `zipMd5` | MD5 checksum van de ZIP |
| `sn` | Serienummer van de maaier |
| `jsonBody` | Extra metadata (JSON) |

**Upload flow:**
1. Na `save_map` genereert de maaier een ZIP: `zip -r -q` in `/userdata/lfi/maps/home0/`
2. `generate_map_file_name` subscriber ontvangt bestandsnaam van mapping module
3. `UPDATA_EVENT_MAP` triggert de HTTP upload thread
4. Maaier checkt of ZIP bestaat (`access_MAP_PATH_DIR_sn_zip_file_exist`)
5. Bouwt URL: `http://<server>/api/nova-file-server/map/uploadEquipmentMap`
6. Stuurt via `curl_formadd` multipart POST
7. Bij succes (`success=true code=200`): klaar
8. Bij fout: logt `curl_easy_perform_failed` of `success=false or code=405`

**✅ Status: VOLLEDIG GEÏMPLEMENTEERD (maart 2026)**

Beide endpoints werken:

| Aspect | App endpoint | Maaier endpoint |
|--------|-------------|-----------------|
| Route | `POST .../fragmentUploadEquipmentMap` | `POST .../uploadEquipmentMap` |
| Auth | JWT token (authMiddleware) | **Geen auth** — maaier identificeert via `sn` |
| Upload methode | Chunked (chunkIndex/chunksTotal) | Enkele multipart POST |
| Velden | `file`, `sn`, `uploadId`, `mapName`, `mapArea` | `local_file`, `local_file_name`, `zipMd5`, `sn`, `jsonBody` |
| Bron | Flutter app | Maaier firmware (curl) |
| Na upload | Slaat op in DB + `_latest.zip` kopie | Parseert ZIP → GPS polygonen → DB + `_latest.zip` kopie |

#### `uploadEquipmentTrack` — maaipad upload

De maaier uploadt ook het geplande maaipad:
- Bron: `/userdata/lfi/maps/home0/planned_path/`
- Endpoint: `POST /api/nova-file-server/map/uploadEquipmentTrack`
- Zelfde `curl_formadd` formaat als kaart upload
- **✅ Status: Geïmplementeerd** — slaat tracks op in `/data/storage/tracks/`

#### Overige maaier HTTP calls

| Endpoint | Status | Beschrijving |
|----------|--------|-------------|
| `queryPlanFromMachine` | ❌ Niet geïmplementeerd | Maaier haalt maaischema's op van server |
| `saveCutGrassRecord` | ✅ Geïmplementeerd | Maaier slaat maairesultaten op (retourneert ok(null) bij lege body om retry-loop te stoppen) |
| `saveCutGrassMessage` | ❌ Niet geïmplementeerd | Maaier stuurt notificatieberichten |
| `machineReset` | ✅ Geïmplementeerd | Apparaat unbind/reset |
| `network/connection` | ✅ Geïmplementeerd | Connectivity check → `{"success":true,"code":200}` |

### queryEquipmentMap — App haalt kaarten op van server (maart 2026)

**Endpoint:** `GET /api/nova-file-server/map/queryEquipmentMap?sn=<SN>` (JWT auth)

Dit is hoe de Novabot app kaarten ophaalt om te tonen. **De app downloadt GEEN kaarten van de maaier** — de maaier uploadt zelf naar de server, en de app vraagt de server.

**Complete flow:**
1. Maaier uploadt ZIP → `POST uploadEquipmentMap` → server parseert ZIP → DB + `_latest.zip`
2. Dashboard maakt kaart → server slaat GPS polygonen op in DB + genereert ZIP
3. App roept `queryEquipmentMap?sn=` aan → server bouwt JSON response uit DB

**App parsing (blutter analyse v2.4.0, maart 2026):**

De app doet `data as Map<String, dynamic>` — `data` MOET een JSON object zijn, geen base64 string:
- `data["work"]` → `List<MapEntityItem>` (werkgebieden)
- `data["unicom"]` → `List<MapEntityItem>` (kanalen naar laadstation)
- `MapEntityItem.fromJson()` leest: `fileName`, `alias`, `type`, `url`, `fileHash`, `mapArea`, `obstacle`
- `machineExtendedField["chargingPose"]` → `ChargingPostion.fromJson()` (let op typo in origineel!)
  - `ChargingPostion` verwacht `x`, `y`, `orientation` als **strings** (doet `double._parse()`)
- De `noMapIntercept` guard checkt `lawnController.mapList.value.isEmpty()` — als `work` leeg is → "No map!"

**Typische response:**
```json
{
  "data": {
    "work": [{
      "fileName": "map0_work.csv",
      "alias": "Work area 1",
      "type": "work",
      "url": null,
      "fileHash": "md5_hash",
      "mapArea": "[{\"lat\":52.14,\"lng\":6.23}, ...]",
      "obstacle": []
    }],
    "unicom": []
  },
  "md5": "zip_md5_hash",
  "machineExtendedField": {
    "chargingPose": { "x": "6.231", "y": "52.140", "orientation": "0" }
  }
}
```

### OTA push mechanisme analyse (februari 2026)

Volledige reverse engineering van het OTA update systeem uit drie bronnen:
- `mqtt_node` binary (6.3MB, strings analyse voor OTA command handlers)
- `ota_client_node` binary (5.8MB, download engine en installatie logica)
- `run_ota.sh` startup script (boot-time upgrade, rollback mechanisme)
- Ghidra decompilatie charger firmware (esp_https_ota flow)

**Resultaat**: OTA push mechanisme volledig begrepen.
- `ota_upgrade_cmd` MQTT commando bevat: `type` (full/increment/file_update/system), `content.upgradeApp.{version, downloadUrl, md5}`
- Maaier wacht tot hij oplaadt → download via libcurl → MD5 check → dpkg extract → reboot → run_ota.sh doet atomic swap met rollback
- Charger OTA via maaier: TCP socket naar `192.168.4.1` of HTTP POST naar `/setotadata`
- Cloud OTA API negeert SN parameter (alle SNs krijgen v5.7.1)
- v6.0.3 werd waarschijnlijk direct via MQTT gepusht naar specifiek SN
- Scripts: `research/download_firmware.js` (downloader), `research/bruteforce_firmware.js` (SN scanner)

### MkDocs wiki (februari 2026)
- MkDocs Material wiki gebouwd in `docs/` met `mkdocs.yml` configuratie
- 30 markdown bestanden: architectuur, API's, MQTT, BLE, LoRa, firmware, flows
- Gegenereerde site in `site/` (2.4MB statische HTML)
- Gebouwd met: `mkdocs build` (of `mkdocs serve` voor lokaal)

### Charger firmware patching (februari 2026)

Firmware patch tool geschreven om hardcoded MQTT hostnames/IPs in de charger firmware te vervangen
zodat de charger volledig lokaal kan opereren zonder DNS rewrites.

**Binary analyse bevindingen:**
- `mqtt.lfibot.com` staat NIET in de firmware binary — alleen in NVS (gezet via BLE provisioning)
- `mqtt-dev.lfibot.com` op offset 0x005F10 (DROM, 20-byte slot) — factory default MQTT host
- `mqtt://47.253.57.111` op offset 0x00951C (DROM, 24-byte slot) — hardcoded fallback URI
- OTA URL op offset 0x020500 (92-byte slot) — Alibaba OSS firmware download URL
- 1.028 bytes ongebruikte DROM ruimte beschikbaar op 0x0181D8 voor string relocation
- SHA256 hash als laatste 32 bytes van de binary (moet bijgewerkt worden na patching)

**ESP32-S3 image structuur:**
- Magic byte: 0xE9, 6 segmenten (DROM 305KB, DRAM 17KB, IRAM 6KB, IROM 1019KB, IRAM2 72KB, RTC 16B)
- Memory map: DROM op 0x3C000000+, IROM op 0x42000000+
- String referenties: 4-byte little-endian virtuele adressen in literal pools

**Patch tool**: `research/patch_firmware.js` (Node.js)
- Parseert ESP32 image headers en segmenten
- Vindt alle target strings en hun locaties + code-referenties
- In-place patching wanneer vervanging past in bestaande slot
- String relocation wanneer vervanging langer is (schrijft naar ongebruikte DROM ruimte, update code refs)
- Bijwerken SHA256 hash na patching
- Genereert MD5 voor OTA command + deployment instructies

**Gebruik:**
```bash
node research/patch_firmware.js                          # Patch met defaults
node research/patch_firmware.js --analyze                # Alleen analyseren
node research/patch_firmware.js --mqtt-host 192.168.1.50 # Kort IP (past in-place)
node research/patch_firmware.js --mqtt-host my.server.nl # Lang hostname (relocation)
```

**Gepatchte firmwares:**

| Versie | Bestand | MD5 | Status |
|--------|---------|-----|--------|
| v0.3.6 | `research/firmware/charger_v0.3.6_patched.bin` | `fb7427789bf0e164ed00ef9ea8f9dbf0` | Klaar voor deployment |
| v0.4.0 | `research/firmware/charger_v0.4.0_patched.bin` | `538f01c8412a7d9936d1de9c298f8918` | Op reserve charger, testing |

Beide firmwares:
- `mqtt-dev.lfibot.com` → `novabot.ramonvanbruggen.nl` (gereloceerd, code-ref bijgewerkt)
- `mqtt://47.253.57.111` → `mqtt://novabot.ramonvanbruggen.nl` (gereloceerd, code-ref bijgewerkt)
- SHA256 hash bijgewerkt en geverifieerd
- Bestandsgrootte identiek aan origineel (1.4MB)

**Deployment**: Host binary op HTTP(S) server, stuur `ota_upgrade_cmd` via MQTT:
```json
{
  "ota_upgrade_cmd": {
    "type": "full",
    "content": {
      "upgradeApp": {
        "version": "v0.3.6-local",
        "downloadUrl": "http://<IP>:8080/charger_v0.3.6_patched.bin",
        "md5": "fb7427789bf0e164ed00ef9ea8f9dbf0"
      }
    }
  }
}
```

**Belangrijke opmerkingen:**
- Charger `esp_https_ota()` kan HTTPS vereisen — als HTTP faalt, HTTPS server opzetten
- NVS config (set via BLE provisioning) wordt NIET beïnvloed door OTA — voor productie-MQTT host ook re-provisioning via BLE nodig
- Bij OTA fout: charger boot automatisch van andere OTA partitie
- Recovery via UART: druk op `b` om handmatig van OTA partitie te wisselen
- ALTIJD eerst testen op reserve moederbord!
- **v0.4.0 commando's vereisen `null` waarden** — zie "Charger firmware v0.4.0" sectie hierboven

### Reserve charger v0.4.0 OTA testing (februari 2026)

Reserve charger moederbord (LFIC2230700017) met gepatchte v0.4.0 firmware aangesloten.
Charger verbindt met MQTT broker via `novabot.ramonvanbruggen.nl` op WiFi `ABERSONPLEIN-IoT`.

**Bevindingen:**
1. **Charger verbindt succesvol** — clientId `ESP32_1bA3D0`, subscribe op `Dart/Send_mqtt/LFIC2230700017`
2. **AES-encrypted `up_status_info`** — elke ~2 seconden, correct ontsleuteld met key `abcdabcd12340017`
3. **Eigen CONNACK nodig** — aedes' CONNACK werd onderdrukt maar fix faalde door 1-byte writes
4. **CONNACK fix**: byte-counting aanpak die exact 4 bytes opslurpt ongeacht chunking
5. **PUBACK ontvangen** — QoS 1 PUBLISH packets worden correct ontvangen door ESP-IDF client (PUBACK `40 02 00 01`)
6. **Geen command response** — charger reageert niet op `{"get_lora_info":0}` (verkeerde waarde)
7. **Root cause gevonden** — v0.4.0 gebruikt `cJSON_IsNull()` check, verwacht `null` niet `0`
8. **Nog niet getest** — charger ging offline (clean DISCONNECT) voordat `{"get_lora_info":null}` getest kon worden

**Volgende stap**: Wanneer charger herverbindt, test `{"get_lora_info":null}` via:
```bash
curl -s -X POST http://localhost:3000/api/dashboard/raw-tcp/LFIC2230700017 \
  -H 'Content-Type: application/json' \
  -d '{"command":{"get_lora_info":null},"qos":1}'
```
Bij succes: stuur `ota_upgrade_cmd` om firmware te flashen.

### Firmware aanpassing en publieke wiki (februari 2026)
- Custom firmware builder geschreven: `research/build_custom_firmware.sh`
- Maaier .deb v5.7.1 geanalyseerd en aangepast: SSH + lokale server URLs
- Output: `research/firmware/mower_firmware_v5.7.1-custom-1.deb` (35MB, MD5: 6a29052606a69c12e9d1c386b99cdbbf)
- OTA flash instructies en JSON commando gegenereerd
- Publieke/private wiki split geimplementeerd met `<!-- PRIVATE -->` markers in 8 bestanden
- Build script `scripts/build-public-wiki.sh` stript PRIVATE secties, vervangt met admonition notices
- 14 gevoelige strings (AES keys, credentials, fallback IPs, firmware URLs) geverifieerd op 0 hits
- Beveiligingsaudit samengesteld: 19 issues (5 kritiek, 8 hoog, 6 medium) + 6 uitdagingen

**Resultaat**:
- Maaier firmware klaar om te flashen via OTA → SSH toegang na reboot
- Publieke wiki klaar voor deployment (geen secrets, geen credentials)
- Volledige beveiligingsanalyse gedocumenteerd
