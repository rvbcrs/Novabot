<\!-- Referentiebestand — gebruik @OTA.md om dit te laden in een sessie -->

## OTA firmware update protocol (volledig reverse-engineered, februari 2026)

**App route**: `/otaPage`

### App-geïnitieerde update flow
1. App vraagt `ota_version_info` via MQTT → `ota_version_info_respond`
2. App checkt API: `GET /api/nova-user/otaUpgrade/checkOtaNewVersion?version=<VER>&upgradeType=serviceUpgrade&equipmentType=<TYPE>`
3. App checkt API: `POST /api/nova-data/appManage/queryNewVersion`
4. Bij beschikbare update: app stuurt `ota_upgrade_cmd` via MQTT
5. Apparaat pusht `ota_upgrade_state` updates (voortgang)
6. Na maaier-update vraagt app: "The charging station can also be upgraded. Would you like to proceed?"

### `ota_upgrade_cmd` JSON formaat (uit firmware analyse)

```json
{
  "ota_upgrade_cmd": {
    "type": "full",
    "content": {
      "upgradeApp": {
        "version": "v5.7.1",
        "downloadUrl": "https://novabot-oss.oss-us-east-1.aliyuncs.com/novabot-file/lfimvp-20240915571-1726376551929.deb",
        "md5": "83c2741d05c9a40ff351332af2082d7c"
      }
    }
  }
}
```

**Upgrade types** (4 gevonden in `ota_client_node`):
| Type | Beschrijving |
|------|-------------|
| `full` | Volledige firmware (.deb), extract + replace + reboot |
| `increment` | Incrementele app update |
| `file_update` | Losse bestanden (.zip met `check.json` manifest) |
| `system` | Voert `sudo apt full-upgrade && reboot -f` uit (!) |

### Maaier OTA architectuur (twee componenten)

| Component | Binary | Functie |
|-----------|--------|---------|
| `ota_client_node` | 5.8MB ROS 2 node | Download engine (libcurl), MD5 verificatie, extractie |
| `mqtt_node` | 6.3MB ROS 2 node | MQTT ↔ ROS 2 bridge, forwardt `ota_upgrade_cmd` naar `/ota_upgrade_srv` |

**ROS 2 service**: `OtaUpgradeSys` (`string ota_cmd` → `bool state, string state_out`)
**Status topic**: `/ota/upgrade_status` → doorgestuurd als `ota_upgrade_state` via MQTT

### OTA download & installatie flow

```
1. mqtt_node ontvangt ota_upgrade_cmd via MQTT
2. Forward JSON naar ota_client_node via /ota_upgrade_srv ROS 2 service
3. ota_client wacht tot maaier OPLAADT (vereist!)
4. Download .deb via libcurl (resume-capable, max 24u timeout)
5. Verificatie MD5 checksum
6. Extract: dpkg -x pakket.deb /root/novabot.new/
7. Kopieer charger firmware naar /userdata/ota/charging_station_pkg/
8. Schrijf "1" naar /userdata/ota/upgrade.txt
9. reboot -f

Na reboot (run_ota.sh):
10. Check upgrade.txt flag
11. Backup: /root/novabot → /root/novabot.bak
12. Deploy: /root/novabot.new → /root/novabot
13. Restore gebruikersdata (kaarten, CSV, charging station config)
14. Verificatie: als run_novabot.sh ontbreekt → ROLLBACK
15. Schrijf "0" naar upgrade.txt, reboot
```

### Charger OTA (via maaier)

De maaier handelt ook charger updates af:
- **TCP socket**: verbindt met charger AP op `192.168.4.1`, stuurt firmware in chunks
- **HTTP POST**: `http://192.168.4.1/setotadata` (alternatief pad in `ota_client_node`)
- Firmware bron: `/userdata/ota/charging_station_pkg/lfi-charging-station_lora.bin`

### Charger eigen OTA (ESP32-S3)

De charger verwerkt `ota_upgrade_cmd` via `esp_https_ota()` (ESP-IDF OTA library).
Downloadt firmware direct van de URL in het commando. Geen code signing, alleen MD5.

### Cloud OTA API bevindingen

- `checkOtaNewVersion` retourneert **dezelfde versie voor ALLE serial numbers**
- SN parameter wordt genegeerd — geen per-device versioning via dit endpoint
- v6.0.3 (gezien bij één gebruiker) werd waarschijnlijk gepusht via:
  - **Direct MQTT**: support stuurde `ota_upgrade_cmd` naar `Dart/Send_mqtt/<SN>` via cloud broker
  - **Database override**: cloud database tijdelijk aangepast voor specifiek SN
- Download URL bevat onvoorspelbare timestamp → niet te raden zonder exacte URL

### OTA bestanden op maaier

| Pad | Beschrijving |
|-----|-------------|
| `/userdata/ota/upgrade.txt` | Flag: "0"=geen update, "1"=update pending |
| `/userdata/ota/upgrade_pkg/` | Gedownloade .deb pakketten |
| `/userdata/ota/run_ota.sh` | OTA startup script (gekopieerd bij update) |
| `/userdata/ota/charging_station_pkg/` | Charger firmware voor relay |
| `/userdata/ota/ota_client.log` | OTA operatie log |
| `/userdata/lfi/system_version.txt` | Huidige firmware versie |
| `/root/novabot/` | Actieve firmware installatie |
| `/root/novabot.new/` | Uitgepakte nieuwe firmware (pre-reboot) |
| `/root/novabot.bak/` | Backup vorige firmware (rollback) |

### OTA security

- **Geen authenticatie** op MQTT OTA commando's — elk bericht op `Dart/Send_mqtt/<SN>` triggert update
- **Geen code signing** — alleen MD5 integriteitscheck
- **Download URL niet gevalideerd** — kan naar elke server wijzen
- **`system` type** voert `apt full-upgrade` uit → kwaadaardige apt repo = arbitrary code execution
- **Charger OTA via HTTP** (niet HTTPS) naar `192.168.4.1`

**UI strings:**
- "Are you sure to upgrade? Expected to take 20-30 minutes"
- "Can be operated in the background during the upgrade. Do not close NOVABOT APP."
- "Upgrading... please do not operate the machine during the upgrade process."

---

## Custom Firmware Builder (februari 2026)

### Maaier firmware aanpassen via OTA

Het build-script `research/build_custom_firmware.sh` neemt de originele maaier .deb (v5.7.1),
pakt hem uit, past shell scripts en configuratie aan, en herbouwt als .deb voor OTA installatie.

**Gebruik:**
```bash
./research/build_custom_firmware.sh --server novabot.ramonvanbruggen.nl --ssh-password novabot
./research/build_custom_firmware.sh --server 192.168.1.50 --remote-ros2
```

**CLI opties:**
| Optie | Default | Beschrijving |
|-------|---------|-------------|
| `--server` | `novabot.local` | Server hostname/IP |
| `--http-port` | `3000` | HTTP port |
| `--ssh-password` | `novabot` | Root SSH wachtwoord |
| `--ssh-port` | `22` | SSH poort |
| `--remote-ros2` | uit | ROS 2 netwerk openzetten (ROS_LOCALHOST_ONLY=0) |
| `--version` | `custom-1` | Versie suffix |

**Wijzigingen t.o.v. origineel:**
| Wijziging | Bestand | Details |
|-----------|---------|---------|
| SSH server | `scripts/start_service.sh` | `apt install openssh-server` bij OTA install |
| Root wachtwoord | `scripts/start_service.sh` | Via `chpasswd` |
| HTTP URL | `scripts/set_server_urls.sh` | Schrijft server URL naar `/userdata/lfi/http_address.txt` bij elke boot |
| Boot hook | `scripts/run_novabot.sh` | Roept `set_server_urls.sh` aan voor main startup |
| Log upload URL | `log_manager.yaml` | `app.lfibot.com` → lokale server |
| Versie | `novabot_api.yaml` | `v5.7.1-custom-N` |

**OTA flash flow:**
1. Bouw .deb: `./research/build_custom_firmware.sh --server <host>`
2. Host bestand: `cd research/firmware && python3 -m http.server 8080`
3. Stuur OTA commando via MQTT (of gebruik `research/firmware/ota_flash_command.json`)
4. Maaier moet OPLADEN → download start automatisch → MD5 check → install → reboot
5. Na reboot: `ssh root@<maaier-ip>` (wachtwoord uit --ssh-password)
6. Bij problemen: automatische rollback naar originele v5.7.1

**Firmware structuur (.deb inhoud):**
| Type | Aantal | Aanpasbaar? |
|------|--------|-------------|
| ELF binaries (C++ compiled) | ~40 ROS 2 nodes | Nee (alleen strings patchen) |
| Shared libraries (.so) | 239 | Nee |
| Shell scripts (.sh) | 575 | **Ja** |
| Python scripts (.py) | 298 | **Ja** |
| Config/YAML | 136 | **Ja** |
| AI modellen (.bin) | 2 (11.1MB) | Nee (Horizon BPU formaat) |
| Totaal | 6237 bestanden | |

**MQTT host configuratie op maaier:**
- MQTT broker host komt uit BLE provisioning → opgeslagen in `/userdata/lfi/json_config.json`
- `mqtt.lfibot.com` in `mqtt_node` binary is alleen fallback/ping target → DNS redirect werkt
- HTTP upload URL wordt gelezen uit `/userdata/lfi/http_address.txt` → `set_server_urls.sh` overschrijft dit
- `app.lfibot.com` hardcoded als HTTP fallback → DNS redirect werkt ook hier

**KRITISCH: `http_address.txt` format — ALLEEN host:port, GEEN `http://` prefix, GEEN trailing newline!**

De firmware (`mqtt_node`) leest `/userdata/lfi/http_address.txt` en bouwt URLs als:
`"http://" + file_content + "/api/..."`. Als het bestand `http://192.168.0.177:3000` bevat,
wordt de URL `http://http://192.168.0.177:3000/api/...` → curl faalt → `net_work_flag` blijft 0.

Correct formaat: `192.168.0.177:3000` (zonder http:// prefix, zonder trailing newline).
Gebruik `printf "%s" "host:port"` i.p.v. `echo` om trailing newline te voorkomen.

### `net_check_fun` — netwerk health check in mqtt_node (maart 2026)

De `net_check_fun` thread in `mqtt_node` controleert periodiek (~27 sec) of de HTTP server
bereikbaar is. Dit is een vereiste voor `net_work_flag=1`, wat andere functies nodig hebben.

**Control flow:**
1. `net_check_fun` stuurt event type 3 via `msgsnd` naar `http_work_fun` thread
2. `http_work_fun` ontvangt via `msgrcv`, leest `/userdata/lfi/http_address.txt`
3. Bouwt URL: `"http://" + file_content + "/api/nova-network/network/connection"`
4. Roept `http_post_upload()` aan die `curl_easy_perform()` doet (5 sec timeout)
5. Bij succes: `net_connect_fail_num = 0`, `net_work_exe_end_flag = 1`
6. Bij falen: `net_connect_fail_num++`, `net_work_exe_end_flag = 1`
7. Terug in `net_check_fun`: checkt `net_connect_fail_num`:
   - `== 0`: zet `net_work_flag = net_work_exe_end_flag` (= 1, SUCCESS)
   - `1-3`: dead zone — flag niet gezet, WiFi niet herconnect
   - `> 3`: probeert WiFi reconnect, dan loop terug

**Relevante BSS symbolen (`nm mqtt_node`):**
| Symbool | Offset | Type | Beschrijving |
|---------|--------|------|-------------|
| `_ZL13net_work_flag` | `0x42aff0` | byte | Netwerk OK vlag (0=fail, 1=ok) |
| `_ZL14mqtt_work_flag` | `0x42af89` | byte | MQTT verbinding OK |
| `_ZL20net_connect_fail_num` | `0x42b6ac` | int32 | Opeenvolgende HTTP failures |
| `_ZL21net_work_exe_end_flag` | `0x42b6b0` | int32 | Check voltooid vlag |
| `_ZL13wifi_rssi_num` | `0x42b6f0` | int32 | WiFi RSSI waarde |
| `_ZL11g_wifi_rssi` | `0x42b154` | int32 | Globale WiFi RSSI |

**Debug via GDB:**
```bash
# PID ophalen
PID=$(pidof mqtt_node.real)
# PIE base ophalen
BASE=$(head -1 /proc/$PID/maps | cut -d'-' -f1)
# Adressen berekenen: base + offset
gdb -batch -p $PID \
  -ex "x/1bx $((0x$BASE + 0x42aff0))" \
  -ex "x/1wx $((0x$BASE + 0x42b6ac))"
```

**Root cause gevonden en gefixt (1 maart 2026):**
- Bug: `build_custom_firmware.sh` schreef `http://host:port` naar `http_address.txt`
- Firmware prepends `http://` → dubbel prefix → curl fail → `net_work_flag` blijft 0
- Extra bug: `echo` voegt trailing newline toe → ook met correct prefix faalt curl
- Fix: `printf "%s" "host:port"` (geen prefix, geen newline)

### Charger firmware patchen

Bestaand patch tool `research/patch_firmware.js` vervangt MQTT hostnames in de charger binary:

```bash
node research/patch_firmware.js --mqtt-host novabot.ramonvanbruggen.nl
```

Gepatche firmware in `research/firmware/charger_v0.3.6_patched.bin` en `charger_v0.4.0_patched.bin`.

### Publieke/private wiki split

Het project heeft een publiek/privaat wiki systeem om gevoelige informatie te beschermen:

- **`docs/`** — Volledige wiki met gevoelige details (AES keys, credentials, fallback IPs, firmware URLs)
- **`docs-public/`** — Gegenereerde publieke versie zonder gevoelige secties
- **`scripts/build-public-wiki.sh`** — Strip script dat `<!-- PRIVATE -->` markers verwijdert
- **`mkdocs-public.yml`** — MkDocs config voor publieke wiki (docs_dir: docs-public)
- **8 bestanden** bevatten PRIVATE markers
- **14 gevoelige strings** geverifieerd op 0 hits in publieke build

**Gebruik:**
```bash
./scripts/build-public-wiki.sh        # Genereer docs-public/ + site-public/
mkdocs serve -f mkdocs-public.yml     # Preview publieke wiki
```

---

## Open issues / TODO

- [ ] Android Private DNS uitschakelen zodat DNS rewrites werken op Android
- [x] `charger_status` bitfield volledig gedecodeerd (bit 0=GPS, bit 8=RTK, byte 3=satelliet-aantal)
- [x] Maaier provisioning flow documenteren (BLE commando's voor `Novabot` device)
- [x] Volledige MQTT commando protocol documenteren (40+ commando's, 39 response types)
- [x] `mower_error` mechanisme opgehelderd: LoRa heartbeat failure counter, reset bij succesvolle maaier response
- [x] AES encryptie-infrastructuur gevonden in APK — CBC mode bevestigd via payload-analyse
- [x] **AES key gekraakt** — via blutter decompilatie van APK v2.4.0: key = `"abcdabcd1234" + SN[-4:]`, IV = `"abcd1234abcd1234"`
- [x] Maaier MQTT berichten ontsleuteld — 3 report types: `report_state_robot`, `report_exception_state`, `report_state_timer_data`
- [x] Maaier BLE provisioning via app werkend krijgen (opgelost: MAC fix + CONNECT flags fix)
- [x] Unbind → re-add flow cloud-identiek geïmplementeerd: userId=0 na unbind, BLE re-provisioning harmless, bindingEquipment altijd rebind
- [x] App userId check reverse-engineered via ARM64 assembly: `userId != 0` → "already bound" toast (client-side, niet server-side)
- [x] App MQTT CONNECT bug fixen (Will QoS met Will Flag=0) — `sanitizeConnectFlags` in broker.ts
- [x] Maaier `account`/`password` = null in cloud response bevestigd en geïmplementeerd
- [x] MAC-adres in responses = BLE MAC (niet WiFi STA) — device_registry bijgewerkt
- [x] Alle foutmeldingen, kaarttypen, app-routes en UI states gedocumenteerd
- [x] App architectuur (controllers, models, interceptors) gedocumenteerd
- [x] Charger ESP32-S3 firmware dump (8MB flash via UART, esptool)
- [x] Blutter decompilatie van libapp.so v2.3.8 — AES wachtwoord-encryptie gevonden, MQTT decryptie ontbreekt
- [x] Blutter decompilatie van libapp.so v2.4.0 — `encrypt_utils.dart` gevonden met volledige AES key derivatie
- [x] DNS rewrite Docker container gebouwd (novabot-dns, Alpine + dnsmasq, 8MB)
- [x] Home Assistant MQTT bridge met auto-discovery sensoren
- [ ] Uitzoeken of `_6688` clientId suffix een vaste waarde of berekend is
- [x] React web dashboard gebouwd (novabot-dashboard): live sensoren, GPS kaart, calibratie tool
- [x] Socket.io real-time updates van MQTT data naar browser
- [x] Kaart calibratie tool: offset, rotatie (-180°/+180°), schaal (0.5x-2.0x), opgeslagen in DB
- [x] PDOK luchtfoto satellite imagery als kaartlaag
- [x] Camera systeem geanalyseerd: dual IMX307 + PMD ToF, ROS 2 topics, geen remote streaming
- [x] Netwerk services geanalyseerd: geen SSH/telnet/VNC, ROS 2 localhost-only, VNC expliciet verwijderd
- [x] Maaier PCB geïdentificeerd: Horizon X3A Board VerC PLUS + Motor Board met STM32F407
- [x] Fysieke debug poorten gevonden: UART (GND/TX/RX/3V3), micro-HDMI "DEBUG", USB 3.0
- [x] WiFi/BLE module geïdentificeerd: AP6212 (AMPAK/Broadcom BCM43438)
- [x] TÜV Rheinland rapport CN23XAMH 001 geanalyseerd (modellen N1000/N2000)
- [ ] Maaier openen voor UART/HDMI/USB toegang (IP56 waterdicht — seals niet beschadigen)
- [ ] SSH installeren op maaier via UART of HDMI+USB console (alternatief: custom firmware via OTA)
- [ ] Camera video streaming implementeren (ROS 2 → MJPEG/WebSocket bridge)
- [ ] Maaier kaartdata ophalen wanneer maaier online is (mapSync via MQTT)
- [x] APK v2.4.0 geanalyseerd met blutter — `encrypt_utils.dart` bevat AES key derivatie
- [x] Server decrypt.ts herschreven met correcte key derivatie (`"abcdabcd1234" + SN[-4:]`)
- [x] HA bridge updaten: ontsleutelde maaier-sensordata doorsturen naar Home Assistant
- [x] Charger firmware v0.3.6 gedecompileerd met Ghidra (7405 functies, MQTT/LoRa/BLE volledig geanalyseerd)
- [x] LoRa protocol volledig reverse-engineered (packet format, command mapping, RSSI scanning)
- [x] Charger = MQTT ↔ LoRa bridge architectuur bevestigd
- [x] LoRa module geïdentificeerd als EBYTE E32/E22 serie (M0=GPIO12, M1=GPIO46)
- [x] Security audit: geen MQTT auth, geen AES, UART console zonder auth, plaintext WiFi in NVS
- [x] Charger firmware v0.4.0 gedecompileerd — AES-128-CBC encryptie + cJSON_IsNull command validatie
- [x] v0.4.0 command protocol ontdekt: `get_lora_info`/`ota_version_info` verwachten `null` waarde, niet `0`
- [x] CONNACK suppression fix: byte-counting i.p.v. buffer-length check (aedes 1-byte writes)
- [x] Raw TCP infrastructure: writeRawPublish() + rawSocketBySn Map voor direct socket writes
- [x] PUBACK bevestigd: ESP-IDF client ontvangt en parst PUBLISH packets correct
- [x] v0.4.0 gepatchte firmware geproduceerd: research/firmware/charger_v0.4.0_patched.bin (MD5: 538f01c8412a7d9936d1de9c298f8918)
- [x] Cloud API authenticatie reverse-engineered: signature = SHA256(echostr + SHA1("qtzUser") + timestamp + token)
- [x] Maaier OTA firmware v5.7.1 gedownload (35MB Debian pakket, ROS 2)
- [x] Charger OTA firmware v0.3.6 gedownload (1.4MB ESP32-S3 binary)
- [x] Maaier firmware geanalyseerd: Horizon Robotics X3 SoC, dual camera (IMX307 + PMD ToF)
- [x] AI obstakeldetectie volledig geïmplementeerd: 2 DNN modellen (8.1MB detectie + 3.6MB segmentatie)
- [x] Detectie klassen: person, animal, obstacle, shoes, wheel, leaf debris, faeces, rock
- [x] Segmentatie klassen: lawn, road, terrain, fixed/static/dynamic obstacle, bush, charging station, glass
- [x] Perception node V0.5.3d: 100Hz inference, Horizon BPU acceleratie, Nav2 costmap integratie
- [x] Cloud data geëxporteerd naar `research/cloud_data/` (50 work records, firmware versies, equipment info)
- [x] Cloud data geïmporteerd in lokale SQLite database + test kaart aangemaakt
- [x] Kaart bouwen analyse: werkt volledig via MQTT (lokaal), cloud upload is alleen backup en mag falen
- [x] Polygon editor gebouwd: tekenen, bewerken, verslepen, midpoint toevoegen, rechtermuisklik verwijderen
- [x] Dashboard maaischema's (Scheduler): CRUD + MQTT timer_task + set_para_info push naar maaier
- [x] MQTT command publishing endpoint: POST /api/dashboard/command/:sn
- [x] Maaier heading marker: roterende SVG pijl op kaart op basis van z/mower_z sensordata
- [x] GPS trail heatmap: kleurverloop (oud→nieuw) met instelbare segmenten
- [x] Coverage statistieken per werkgebied: trail points × 0.25m² → dekkingspercentage
- [x] Polygon oppervlakteberekening (Shoelace formule op GPS coördinaten → m²)
- [x] Map export: ZIP download met Novabot-formaat CSV bestanden vanuit dashboard
- [x] Charger GPS positie doorgeven aan MowerMap voor export referentiepunt
- [x] Polygon editor gebouwd en werkend: bestaande kaarten aanpassen + nieuwe kaarten tekenen op satellietfoto
- [x] Kaart sync naar maaier onderzocht: save_map, area_set, StartCoverageTask geanalyseerd
- [x] Maaier HTTP uploads geanalyseerd: uploadEquipmentMap, uploadEquipmentTrack, saveCutGrassRecord
- [ ] `POST /api/nova-file-server/map/uploadEquipmentMap` endpoint bouwen (maaier kaart-ZIP ontvangen + parsen)
- [ ] `POST /api/nova-file-server/map/uploadEquipmentTrack` endpoint bouwen (maaipad ontvangen)
- [ ] `POST /api/nova-data/cutGrassPlan/queryPlanFromMachine` endpoint bouwen (schema's naar maaier)
- [x] `POST /api/nova-data/equipmentState/saveCutGrassRecord` endpoint gebouwd — retourneert ok(null) bij lege body om retry-loop te stoppen
- [ ] SSH toegang tot maaier voor directe CSV/ZIP upload naar `/userdata/lfi/maps/home0/csv_file/`
- [ ] `start_run` met `polygon_area` parameter implementeren (SPECIFIED_AREA modus)
- [x] OTA push mechanisme volledig reverse-engineered: ota_upgrade_cmd JSON formaat, ota_client_node flow, charger OTA relay
- [x] OTA brute-force: cloud OTA API negeert SN parameter, retourneert altijd v5.7.1
- [x] MkDocs Material wiki gebouwd: docs/ bronbestanden, mkdocs.yml config, site/ gegenereerde output
- [x] Firmware download script geschreven: research/download_firmware.js (cloud login → OTA check → .deb download)
- [x] Charger firmware patch tool geschreven: research/patch_firmware.js (string relocation + SHA256 update)
- [x] Gepatchte firmware geproduceerd: v0.3.6 + v0.4.0 (MQTT → novabot.ramonvanbruggen.nl)
- [x] Custom firmware builder script geschreven: research/build_custom_firmware.sh
- [x] Maaier .deb firmware geanalyseerd: 6237 bestanden, 575 shell scripts, 298 Python, 136 YAML (allemaal aanpasbaar)
- [x] SSH installatie via OTA: openssh-server + root wachtwoord in start_service.sh
- [x] HTTP URL override: set_server_urls.sh schrijft http_address.txt bij elke boot
- [x] `net_check_fun` reverse-engineered: netwerk health check via HTTP POST, BSS symbolen gevonden, URL-formaat bug gefixt (geen http:// prefix, geen trailing newline)
- [x] Publieke/private wiki split: PRIVATE markers in 8 docs, build-public-wiki.sh strip script
- [x] 14 gevoelige strings geverifieerd op 0 hits in publieke wiki build
- [x] Firmware haalbaarheidsanalyse: charger=haalbaar (ESP-IDF), maaier=aanpasbaar via .deb OTA
- [x] Cloud vs lokale server provisioning analyse: 7 response-verschillen gevonden en 6 gefixt (sysVersion, model, userId, queryEquipmentMap, queryRecentCutGrassPlan, queryMsgMenuByUserId)
- [ ] Fix `model` per deviceType in `userEquipmentList` (N1000 voor charger, N2000 voor mower)
- [x] Fix `chargerChannel` in DB en code: cloud slaat 16 op (gevraagd kanaal), niet 15 (toegewezen). `rowToCloudDto()` retourneert nu ALTIJD null voor mower chargerAddress/chargerChannel
- [ ] Fix `queryEquipmentMap` response formaat: retourneer cloud-identiek object i.p.v. lege array
- [ ] Bevestigen of maaier BLE aan heeft tijdens lokale provisioning poging
- [ ] v0.4.0 null-value commando's testen: `{"get_lora_info":null}` naar reserve charger
- [ ] OTA flash reserve charger via `ota_upgrade_cmd` MQTT commando
- [ ] HTTPS server opzetten voor charger OTA (esp_https_ota vereist mogelijk HTTPS)
- [ ] Custom firmware flashen op maaier via OTA (vereist: maaier aan lader + WiFi internet)
- [ ] SSH verbinding testen na OTA flash
- [ ] Charger eigen ESP-IDF firmware project opzetten (MQTT↔LoRa bridge)
- [ ] Camera streaming via eigen ROS 2 node (na SSH toegang)
- [ ] Publieke wiki deployen (site-public/ of docs-public/ + mkdocs-public.yml)

