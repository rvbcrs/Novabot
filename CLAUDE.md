# Novabot Reverse Engineering — Project Context

Dit project is een lokale vervanging van de Novabot cloud (app.lfibot.com / mqtt.lfibot.com).
Het bestaat uit een Node.js/TypeScript/Express server + een embedded aedes MQTT broker.

## Doel
De Novabot app (v2.3.8/v2.4.0 Android / v2.3.9 iOS, Flutter/Dart) praat met de lokale server i.p.v. de echte cloud,
zodat de robotmaaier en het laadstation volledig offline werken.

---

## Mappenstructuur

```
/Users/rvbcrs/GitHub/Novabot/
├── NOVABOT_2.3.8_APKPure/          Gededisassembleerde APK (apktool output)
│   └── lib/arm64-v8a/libapp.so     Gecompileerde Dart-code (strings extraheren met: strings libapp.so | grep ...)
├── novabot-server/                 De lokale vervangingsserver
│   └── src/
│       ├── index.ts                Entry point (Express + MQTT broker starten)
│       ├── db/database.ts          SQLite schema + initDb()
│       ├── types/index.ts          Gedeelde TypeScript interfaces + ok()/fail()
│       ├── middleware/auth.ts      JWT auth middleware
│       ├── mqtt/broker.ts          Aedes MQTT broker op port 1883 + sanitizeConnectFlags
│       ├── mqtt/decrypt.ts         AES-128-CBC decryptie voor maaier MQTT berichten
│       ├── mqtt/homeassistant.ts   Home Assistant MQTT bridge met auto-discovery sensoren
│       ├── proxy/httpProxy.ts      HTTP proxy naar echte cloud (PROXY_MODE=cloud)
│       └── routes/
│           ├── admin.ts                        GET /api/admin/devices, POST /api/admin/devices/:sn/mac
│           ├── nova-user/appUser.ts            Login, registratie, profiel
│           ├── nova-user/validate.ts           E-mail verificatiecodes
│           ├── nova-user/equipment.ts          Apparaatbeheer (bindingEquipment, getEquipmentBySN, ...)
│           ├── nova-user/otaUpgrade.ts         OTA versie check
│           ├── nova-data/cutGrassPlan.ts       Maaischema's
│           ├── nova-file-server/map.ts         Kaartbestanden (fragmentUpload)
│           ├── nova-file-server/log.ts         App logbestanden
│           ├── nova-network/network.ts          Connectivity check (connection endpoint)
│           └── novabot-message/message.ts      Robot- en werkberichten
├── novabot-dns/                    DNS rewrite Docker container (dnsmasq)
│   ├── Dockerfile                  Alpine + dnsmasq, 8MB image
│   ├── entrypoint.sh               Genereert dnsmasq.conf uit env vars
│   └── docker-compose.yml          TARGET_IP + UPSTREAM_DNS configuratie
├── blutter_output/                 Blutter decompilatie van v2.3.8 libapp.so (Dart 3.2.3)
│   ├── asm/                        Gedecompileerde Dart assembly per library
│   ├── pp.txt                      Object pool (string constanten, class refs)
│   ├── objs.txt                    Object dump
│   └── blutter_frida.js            Gegenereerde Frida hooks
├── blutter_output_v2.4.0/          Blutter decompilatie van v2.4.0 libapp.so (Dart 3.6.1)
│   ├── asm/flutter_novabot/mqtt/encrypt_utils.dart   ← AES key derivatie gevonden!
│   ├── asm/flutter_novabot/mqtt/mqtt.dart            MQTT client met decode() aanroep
│   ├── asm/flutter_novabot/mqtt/mqtt_data_handler.dart  Message handlers
│   ├── pp.txt                      Object pool
│   └── blutter_frida.js            Gegenereerde Frida hooks
├── NOVABOT_2.4.0_arm64/            Uitgepakte v2.4.0 APK (arm64-v8a)
│   └── lib/arm64-v8a/libapp.so     Dart AOT binary (12MB, ELF 64-bit ARM aarch64)
├── charger_firmware_2.bin          ESP32-S3 flash dump (8MB) van laadstation
├── charger_ota0_v0.3.6.bin         Extracted ota_0 partitie (1.8MB, actieve firmware)
├── charger_ota0_v0.3.6.elf         ELF conversie voor Ghidra (Xtensa LX7, 32-bit LSB)
├── charger_ota1_v0.4.0.bin         Extracted ota_1 partitie (1.8MB, inactieve firmware)
├── charger_ota1_v0.4.0.elf         ELF conversie voor Ghidra
├── ghidra_output/                  Ghidra decompilatie output
│   ├── charger_v036_decompiled.c   Gedecompileerde C-code (7.6MB, 296K regels, 7405 functies)
│   └── charger_v036/               Ghidra project directory (interactieve analyse)
├── mqtt_sniffer.py                 Standalone TCP MQTT packet sniffer (diagnostisch)
├── Novabot-Base-Station.pdf        Hardware handleiding laadstation
├── Novabot-Mower.pdf               Hardware handleiding maaier
├── ConsoleLogMower.txt             MQTT/HTTP proxy output maaier sessie (cloud capture)
└── COnsoleLog.txt                  MQTT/HTTP proxy output charger sessie (cloud capture)
```

---

## Bekende apparaten

### Laadstation (Charger / Base Station)
| Eigenschap       | Waarde                        |
|------------------|-------------------------------|
| Serienummer (SN) | `LFIC1230700004`              |
| MQTT clientId    | `ESP32_1bA408`                |
| MQTT username    | `LFIC1230700004`              |
| BLE naam         | `CHARGER_PILE`                |
| BLE MAC          | `48:27:E2:1B:A4:0A`          |
| WiFi AP MAC      | `48:27:E2:1B:A4:09` (BLE−1)  |
| WiFi STA MAC     | `48:27:E2:1B:A4:08` (BLE−2)  |

BLE manufacturer data (type 0xFF): `66 55 48 27 E2 1B A4 0A 45 53 50`
- `66 55` = Company ID 0x5566 (ESP)
- `48 27 E2 1B A4 0A` = BLE MAC
- `45 53 50` = "ESP" (ASCII)

**Hardware (uit PCB inspectie + firmware dump, februari 2026):**
| Component | Type | Details |
|-----------|------|---------|
| MCU | ESP32-S3-WROOM (QFN56 rev v0.2) | Dual Core + LP Core, 240MHz, 2MB PSRAM |
| Flash | 8MB SPI (GigaDevice GD25Q64) | Manufacturer 0xC8, Device 0x4017 |
| GPS/RTK | UM960 | Op PCB rechtsboven, met SMA antenne |
| LoRa | Module met SMA antenne | Op PCB rechtsboven |
| UART | Header "UART0" op PCB | Pinnen: 3V3, RX, TX, GND (115200 baud) |
| Voeding | DC24-30V | Via connector bovenaan PCB |

PCB tekst: "LFi Charging Station 20230228", "Little Little World, Big Big Novabot", "No Boundaries, No Worries"
PCB serienummer label: `GRHCDJB23/0226`

### Maaier (Mower)
| Eigenschap       | Waarde                        |
|------------------|-------------------------------|
| Serienummer (SN) | `LFIN2230700238`              |
| MQTT clientId    | `LFIN2230700238_6688`         |
| MQTT username    | `LFIN2230700238`              |
| BLE naam         | `Novabot`                     |
| BLE MAC          | `50:41:1C:39:BD:C1`          |
| WiFi AP MAC      | `50:41:1C:39:BD:C0` (BLE−1)  |
| WiFi STA MAC     | `50:41:1C:39:BD:BF` (BLE−2)  |

BLE manufacturer data (type 0xFF): `66 55 50 41 1C 39 BD C1`
- `66 55` = Company ID 0x5566 (ESP)
- `50 41 1C 39 BD C1` = BLE MAC

---

## ESP32 MAC-adres patroon
ESP32 wijst MAC-adressen opeenvolgend toe aan zijn interfaces:
- WiFi STA = basis MAC (verbindt met thuisrouter)
- WiFi AP  = basis MAC + 1 (eigen access point)
- BLE      = basis MAC + 2

De BLE manufacturer data bevat altijd het BLE MAC. Het WiFi STA MAC (wat in de router
ARP-tabel staat en in MQTT-packets verschijnt) is BLE MAC − 2.

---

## MQTT Protocol

### Broker
- Extern adres: `mqtt.lfibot.com:1883`
- Lokaal: onze aedes broker op `0.0.0.0:1883`
- DNS redirect: `mqtt.lfibot.com` → Mac IP (via router of Pi-hole)

### Topic structuur
| Richting       | Topic patroon                    |
|----------------|----------------------------------|
| Apparaat → App | `Dart/Receive_mqtt/<SN>`         |
| App → Apparaat | `Dart/Send_mqtt/<SN>`            |

Apparaten gebruiken hun SN als topic-suffix. De app subscribeert op `Dart/Receive_mqtt/<SN>`
en publiceert commando's op `Dart/Send_mqtt/<SN>`.

### MQTT authenticatie
- Devices: username = SN, password = (onbekend, wij accepteren alles)
- App: clientId = appUserId (UUID), credentials via login session

### MQTT cloud credentials (uit getEquipmentBySN / userEquipmentList response)
| Apparaat | `account`    | `password`   |
|----------|-------------|-------------|
| Charger  | `li9hep19`  | `jzd4wac6`  |
| Maaier   | `null`      | `null`      |

De charger krijgt MQTT credentials mee van de cloud; de maaier **niet**.
Dit is bevestigd via cloud proxy capture (`ConsoleLogMower.txt`).
De maaier verbindt met de MQTT broker via een ander mechanisme (waarschijnlijk hardcoded in firmware).
Onze lokale broker accepteert alles, dus credentials hoeven niet gecheckt te worden.

### MQTT CONNECT flags bug (app) — sanitizeConnectFlags fix
De Novabot app stuurt een MQTT CONNECT packet met **Will QoS=1** terwijl **Will Flag=0**.
Dit is een schending van de MQTT 3.1.1 specificatie (sectie 3.1.2.6):
> "If the Will Flag is set to 0, then the Will QoS MUST be set to 0 (0x00)"

Aedes (onze MQTT broker) weigert deze verbinding met de foutmelding:
`Will QoS must be set to zero when Will Flag is set to 0`

**Fix**: `sanitizeConnectFlags()` in `broker.ts` (line 36) patcht de raw TCP bytes
van het CONNECT packet **voordat** aedes het parst. Het wist de Will QoS bits (3-4)
en Will Retain (bit 5) wanneer Will Flag (bit 2) niet gezet is.
De functie wordt aangeroepen op het eerste TCP chunk in de `socket.once('data', ...)` handler.

### MAC-adres in cloud response = BLE MAC (niet WiFi STA)
De cloud retourneert het **BLE MAC** adres in `macAddress`, niet het WiFi STA MAC:
- Charger: `48:27:E2:1B:A4:0A` (BLE MAC, WiFi STA = `...08`)
- Maaier:  `50:41:1C:39:BD:C1` (BLE MAC, WiFi STA = `...BF`)

De app matcht dit MAC-adres tegen BLE manufacturer data tijdens scanning.
Onze `device_registry` en `equipment` tabellen moeten daarom het BLE MAC bevatten.

### Compleet MQTT commando protocol (uit APK analyse)

Alle commando's worden gepubliceerd als JSON op `Dart/Send_mqtt/<SN>` (app→apparaat)
en ontvangen op `Dart/Receive_mqtt/<SN>` (apparaat→app).

**Maaien:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `start_run` | `start_run_respond` | Start maaien |
| `stop_run` | `stop_run_respond` | Stop maaien |
| `pause_run` | `pause_run_respond` | Pauzeer maaien |
| `resume_run` | `resume_run_respond` | Hervat maaien |

**Navigatie:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `start_navigation` | `start_navigation_respond` | Start punt-naar-punt navigatie |
| `stop_navigation` | `stop_navigation_respond` | Stop navigatie |
| `pause_navigation` | `pause_navigation_respond` | Pauzeer navigatie |
| `resume_navigation` | `resume_navigation_respond` | Hervat navigatie |

**Handmatige besturing (joystick, app route `/manulController`):**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `start_move` | _(geen)_ | Start handmatige beweging (joystick data) |
| `stop_move` | _(geen)_ | Stop handmatige beweging |

De joystick-pagina (`ManulControllerPageLogic`) stuurt continue positie-updates via `start_move`.
De `writeDataForMove` methode berekent richting/snelheid vanuit de joystick offset.

**Opladen / docking:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `go_to_charge` | `go_to_charge_respond` | Ga naar laadstation |
| `go_pile` | `go_pile_respond` | Ga naar laadpaal |
| `stop_to_charge` | `stop_to_charge_respond` | Stop opladen |
| `auto_recharge` | `auto_recharge_respond` | Automatisch herladen |
| `get_recharge_pos` | `get_recharge_pos_respond` | Haal laadstation positie op |
| `save_recharge_pos` | `save_recharge_pos_respond` | Sla laadstation positie op |

**Kaart bouwen (mapping):**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `start_scan_map` | `start_scan_map_respond` | Start handmatig grens scannen |
| `stop_scan_map` | `stop_scan_map_respond` | Stop scannen |
| `add_scan_map` | `add_scan_map_respond` | Voeg scan-datapunt toe |
| `start_erase_map` | `start_erase_map_respond` | Start kaartgebied wissen |
| `stop_erase_map` | `stop_erase_map_respond` | Stop wissen |
| `start_assistant_build_map` | `start_assistant_build_map_respond` | Start automatisch kaart bouwen |
| `quit_mapping_mode` | _(geen)_ | Verlaat mapping modus |

**Kaart beheer:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `get_map_list` | `get_map_list_respond` | Haal lijst van alle kaarten op |
| `get_map_outline` | _(via report)_ | Haal kaartgrens op |
| `get_map_plan_path` | `get_map_plan_path_respond` | Haal gepland maaipad op |
| `get_preview_cover_path` | `get_preview_cover_path_respond` | Haal coverage preview op |
| `generate_preview_cover_path` | `generate_preview_cover_path_respond` | Genereer coverage preview |
| `request_map_ids` | _(geen)_ | Verzoek beschikbare kaart-IDs |
| `save_map` | `save_map_respond` | Sla kaart op |
| `delete_map` | `delete_map_respond` | Verwijder kaart |
| `reset_map` | `reset_map_respond` | Reset kaart |

**Apparaat parameters (via BLE én MQTT):**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `get_para_info` | `get_para_info_respond` | Haal geavanceerde instellingen op |
| `set_para_info` | `set_para_info_respond` | Wijzig geavanceerde instellingen |

Parameters: `obstacle_avoidance_sensitivity`, `target_height`, `defaultCuttingHeight`,
`path_direction`, `cutGrassHeight`

**PIN code:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `dev_pin_info` | `dev_pin_info_respond` | PIN code opvragen/instellen |
| `no_set_pin_code` | _(flag)_ | Geeft aan dat geen PIN code is ingesteld |

**OTA firmware update:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `ota_version_info` | `ota_version_info_respond` | Firmware versie opvragen |
| `ota_upgrade_cmd` | _(via state)_ | Start OTA upgrade |
| `ota_upgrade_state` | _(unsolicited)_ | OTA voortgang (apparaat pusht dit) |

**Timer/planning:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `timer_task` | _(geen)_ | Timer/gepland taak commando |

**Overig:**
| Commando | Response | Beschrijving |
|----------|----------|-------------|
| `auto_connect` | _(geen)_ | Auto-connect commando |

### Status reports (apparaat → app, unsolicited)

Deze berichten worden periodiek door het apparaat gepusht (niet op verzoek):

| Report type | Beschrijving |
|-------------|-------------|
| `up_status_info` | Hoofd-statusupdate van charger (bevat alle charger/mower velden) |
| `report_state_robot` | Robot status rapport |
| `report_state_battery` | Batterij status rapport |
| `report_state_work` | Werk/maai status rapport |
| `report_state_map_outline` | Kaartgrens data |
| `report_state_timer_data` | Timer/planning data rapport |
| `report_exception_state` | Fout/uitzondering rapport |
| `ota_upgrade_state` | OTA upgrade voortgang |
| `connection_state` | Verbindingsstatus wijziging |

### MQTT payload velden

**`up_status_info` velden (charger → app):**
| Veld | Beschrijving |
|------|-------------|
| `charger_status` | Charger status bitfield (zie hieronder) |
| `mower_status` | Maaier operationele status |
| `mower_x` | Maaier X positie |
| `mower_y` | Maaier Y positie |
| `mower_z` | Maaier Z positie / heading |
| `mower_info` | Maaier info veld 1 |
| `mower_info1` | Maaier info veld 2 |
| `mower_error` | Fout-teller / error code |
| `battery_capacity` | Batterij percentage |

**Werk/status velden:**
| Veld | Beschrijving |
|------|-------------|
| `work_mode` | Huidige werkmodus |
| `work_state` | Huidige werkstatus |
| `work_status` | Werkstatus |
| `task_mode` | Taakmodus |
| `recharge_status` | Oplaadstatus |
| `prev_state` | Vorige status |
| `mowing_progress` | Maaivoortgang (percentage) |
| `error_code` | Numerieke foutcode |
| `error_msg` | Foutmelding tekst |
| `error_status` | Foutstatus |
| `cmd_num` | Commando volgnummer |

**Kaart-gerelateerde velden:**
| Veld | Beschrijving |
|------|-------------|
| `map_id` | Kaart identifier |
| `map_ids` | Lijst van kaart-IDs |
| `map_name` | Kaart naam |
| `map_type` | Kaart type (werkgebied, obstakel, kanaal) |
| `map_position` | Kaart positie data |
| `plan_path` | Gepland maaipad |
| `cover_path` | Coverage pad |
| `preview_cover_path` | Preview coverage pad |
| `path_direction` | Maaipad richting |
| `covering_area` | Huidig dekkingsgebied |
| `finished_area` | Afgewerkt gebeid |
| `cov_direction` | Coverage richting |

**Positie velden:**
| Veld | Beschrijving |
|------|-------------|
| `longitude` | GPS lengtegraad |
| `latitude` | GPS breedtegraad |
| `orient_flag` | Oriëntatie vlag |

### charger_status bitfield (volledig gedecodeerd uit firmware decompilatie)

| Bit(s) | Mask | Bron | Betekenis |
|--------|------|------|-----------|
| Bit 0 | `0x00000001` | GPS NMEA parser | GPS valid (< 5 opeenvolgende GNGGA parse failures) |
| Bit 8 | `0x00000100` | RTK quality check | RTK quality OK (< 5 opeenvolgende altitude deviaties) |
| Midden bits | `DAT_420013b8` | LoRa RSSI | OR'd wanneer LoRa RSSI in valid range (1-145) |
| **Bits 24-31** | `0xFF000000` | GNGGA veld 8 | **GPS satelliet-aantal** (verschoven << 24) |

**Reconstructie van geobserveerde waarden:**
| Waarde (hex)   | Byte 3 (sats) | Bits | Betekenis |
|----------------|--------------|------|-----------|
| `0x00000000`   | 0 sats       | geen | Geen GPS, geen RTK, geen LoRa |
| `0x0E000101`   | **14 sats**  | GPS + RTK | 14 satellieten, GPS en RTK OK |
| `0x10000101`   | **16 sats**  | GPS + RTK | 16 satellieten, GPS en RTK OK |
| `0x11000101`   | **17 sats**  | GPS + RTK | 17 satellieten, GPS en RTK OK |

Het hoge byte is letterlijk het GPS satelliet-aantal uit de GNGGA NMEA zin!

### mower_error gedrag (opgehelderd uit firmware decompilatie)

`mower_error` is **geen fout-teller van de maaier**, maar een **LoRa heartbeat failure counter** op de charger:

1. Charger pollt de maaier met LoRa pakket `[0x34, 0x01]` elke ~1.5 seconden
2. Als maaier antwoordt met `[0x34, 0x02, ...]` (status report) → counter reset naar **0**
3. Als maaier niet antwoordt → counter **increment met 1**
4. In `up_status_info` wordt `mower_error` alleen gerapporteerd als counter **>= 2** (om korte onderbrekingen te filteren)
5. Bij counter < 2 wordt `mower_error: 0` gerapporteerd

De counter stijgt continu zolang de maaier niet bereikbaar is via LoRa (bijv. uit bereik, uitgeschakeld, of LoRa kanaal mismatch).

---

## BLE Provisioning Protocol

De app configureert apparaten via BLE GATT (niet via WiFi AP HTTP of MQTT).
Commando's worden verstuurd als JSON over een GATT characteristic.

### Provisioning commando's (app → apparaat via BLE)
| Commando               | Beschrijving                             |
|------------------------|------------------------------------------|
| `get_signal_info`      | Lees WiFi RSSI + GPS kwaliteit           |
| `get_wifi_rssi`        | Lees WiFi signaalsterkte                 |
| `set_wifi_info`        | Stuur WiFi SSID + wachtwoord             |
| `set_mqtt_info`        | Stuur MQTT broker host/port             |
| `set_lora_info`        | LoRa configuratie (charger ↔ mower)      |
| `set_rtk_info`         | RTK GPS configuratie                     |
| `set_para_info`        | Overige parameters                       |
| `set_cfg_info`         | Algemene configuratie / commit           |

Elk commando heeft een bijbehorend `*_respond` van apparaat → app.

### Exacte BLE payload structuren (gecaptured uit Novabot.pklg)

BLE frames worden gesplitst in chunks van ~27 bytes, omgeven door `ble_start`/`ble_end` markers.

```json
// get_signal_info — lees WiFi RSSI + GPS satellieten
{"get_signal_info":0}
// Response:
{"type":"get_signal_info_respond","message":{"result":0,"value":{"wifi":0,"rtk":17}}}
// wifi = RSSI (0 = sterk), rtk = aantal GPS satellieten (17 = goed)

// set_wifi_info — thuisnetwerk + charger eigen AP instellen
{
  "set_wifi_info": {
    "sta": {"ssid":"<thuisnetwerk>","passwd":"<wachtwoord>","encrypt":0},
    "ap":  {"ssid":"<SN>",          "passwd":"12345678",    "encrypt":0}
  }
}
// Response:
{"type":"set_wifi_info_respond","message":{"result":0,"value":null}}

// set_mqtt_info — alleen host + port (geen credentials via BLE!)
{"set_mqtt_info":{"addr":"mqtt.lfibot.com","port":1883}}
// Response:
{"type":"set_mqtt_info_respond","message":{"result":0,"value":null}}

// set_lora_info — LoRa parameters
{"set_lora_info":{"addr":718,"channel":16,"hc":20,"lc":14}}
// Response: value = TOEGEWEZEN kanaal (niet null!)
{"type":"set_lora_info_respond","message":{"value":15}}

// set_rtk_info — RTK GPS configuratie
{"set_rtk_info":0}
// Response:
{"type":"set_rtk_info_respond","message":{"result":0,"value":null}}

// set_cfg_info — commit/activeer configuratie
{"set_cfg_info":1}
// Response:
{"type":"set_cfg_info_respond","message":{"result":0,"value":null}}
```

**Belangrijke observaties:**
- `set_mqtt_info` stuurt GEEN credentials — die worden apart geconfigureerd (via MQTT zelf of hardcoded)
- `set_wifi_info` bevat altijd twee sub-objecten: `sta` (thuisnet) + `ap` (charger's eigen AP met passwd=`12345678`)
- `set_lora_info_respond.value` = het werkelijk **toegewezen** LoRa kanaal (kan afwijken van gevraagd `channel`)
- `bindingEquipment` gebruikt de `value` uit `set_lora_info_respond` als `chargerChannel` (niet de gevraagde waarde)

### "Add Charging Station" flow (stappen in app)
1. Voer SN in van het laadstation
2. Voer thuisnetwerk WiFi in (SSID + wachtwoord)
3. BLE connect → `get_signal_info` → toont WiFi=Sterk, GPS=Sterk
4. Klik Next → BLE commando's in volgorde:
   - `set_wifi_info` (sta + ap)
   - `set_mqtt_info` (addr + port)
   - `set_lora_info` → response geeft `chargerChannel`
   - `set_rtk_info`
   - `set_cfg_info` (commit)
5. Charger herverbindt met WiFi + MQTT (disconnect + reconnect zichtbaar in logs)
6. App doet `getEquipmentBySN` → krijgt `chargerAddress` + MQTT credentials terug
7. App doet `bindingEquipment` met `chargerChannel` = waarde uit `set_lora_info_respond`
8. App doet `userEquipmentList` → laadstation verschijnt op startscherm

### "Add Mower" BLE provisioning flow (gecaptured via cloud, februari 2026)

Capture bestanden: `Novabot-Mower-cloud.pklg` (BLE) + `ConsoleLogMower.txt` (MQTT/HTTP proxy)

**Belangrijke verschillen met charger flow:**
- BLE device naam: `Novabot` (niet `CHARGER_PILE`)
- `set_wifi_info` bevat ALLEEN `ap` sub-object (geen `sta`!) — maaier verbindt via charger AP, niet direct met thuisnetwerk
- Commando volgorde: wifi → lora → mqtt → cfg (geen `set_rtk_info`!)
- `set_cfg_info` bevat extra veld `tz` (timezone)
- `set_lora_info_respond` geeft `value: null` (niet een kanaalnummer zoals bij charger)

**BLE commando's (exacte payloads uit Novabot-Mower-cloud.pklg):**
```json
// set_wifi_info — ALLEEN ap (maaier verbindt via charger AP)
{"set_wifi_info":{"ap":{"ssid":"<thuisnetwerk>","passwd":"<wachtwoord>","encrypt":0}}}
// Response:
{"type":"set_wifi_info_respond","message":{"result":0,"value":null}}

// set_lora_info — zelfde parameters als charger
{"set_lora_info":{"addr":718,"channel":15,"hc":20,"lc":14}}
// Response: value = null (NIET een kanaalnummer!)
{"type":"set_lora_info_respond","message":{"result":0,"value":null}}

// set_mqtt_info — host + port
{"set_mqtt_info":{"addr":"mqtt.lfibot.com","port":1883}}
// Response:
{"type":"set_mqtt_info_respond","message":{"result":0,"value":null}}

// set_cfg_info — met timezone!
{"set_cfg_info":{"cfg_value":1,"tz":"Europe/Amsterdam"}}
// Response:
{"type":"set_cfg_info_respond","message":{"result":0,"value":null}}
```

**Stappen:**
1. Voer SN in van de maaier (of scan QR code)
2. Voer thuisnetwerk WiFi in (SSID + wachtwoord)
3. BLE connect → `get_signal_info`
4. BLE commando's in volgorde:
   - `set_wifi_info` (alleen `ap`!)
   - `set_lora_info` → response `value: null`
   - `set_mqtt_info` (addr + port)
   - `set_cfg_info` (met timezone)
5. Maaier herverbindt met WiFi + MQTT
6. App doet `getEquipmentBySN` + `bindingEquipment`

### `POST /api/nova-network/network/connection` — connectivity check

Nieuw endpoint ontdekt in ConsoleLogMower.txt. De app roept dit elke ~5 seconden aan.
Cloud response: `{"success":true,"code":200,"message":"request success","value":1}`
Geïmplementeerd in `novabot-server/src/routes/nova-network/network.ts`.

### Mogelijke oorzaak "Network configuration error"
- App (MQTT client) kan port 1883 niet bereiken op de Mac (macOS firewall!)
- BLE verbinding valt weg tijdens WiFi herverbinding (ESP32 instabiliteit)
- Charger subscribeert niet op `Dart/Send_mqtt/LFIC1230700004` na MQTT reconnect

---

## Alle API endpoints (app → server)

Alle endpoints op `https://app.lfibot.com` → lokaal `http://Mac-IP:3000`

| Service           | Endpoint                                              | Geïmplementeerd |
|-------------------|-------------------------------------------------------|-----------------|
| nova-user         | POST appUser/login                                    | ✅              |
| nova-user         | POST appUser/regist                                   | ✅              |
| nova-user         | POST appUser/loginOut                                 | ✅              |
| nova-user         | GET  appUser/appUserInfo?email=                       | ✅              |
| nova-user         | POST appUser/appUserInfoUpdate                        | ✅              |
| nova-user         | POST appUser/appUserPwdUpdate                         | ✅              |
| nova-user         | POST appUser/deleteAccount                            | ✅              |
| nova-user         | POST appUser/updateAppUserMachineToken                | ✅              |
| nova-user         | POST equipment/bindingEquipment                       | ✅              |
| nova-user         | POST equipment/getEquipmentBySN                       | ✅              |
| nova-user         | POST equipment/userEquipmentList                      | ✅              |
| nova-user         | POST equipment/unboundEquipment                       | ✅              |
| nova-user         | POST equipment/updateEquipmentNickName                | ✅              |
| nova-user         | POST equipment/updateEquipmentVersion                 | ✅              |
| nova-user         | GET  otaUpgrade/checkOtaNewVersion?version=           | ✅              |
| nova-user         | POST validate/sendAppRegistEmailCode                  | ✅              |
| nova-user         | POST validate/sendAppResetPwdEmailCode                | ✅              |
| nova-user         | POST validate/validAppRegistEmailCode                 | ✅              |
| nova-user         | POST validate/verifyAndResetAppPwd                    | ✅              |
| nova-data         | GET  appManage/queryCutGrassPlan                      | ✅              |
| nova-data         | POST appManage/saveCutGrassPlan                       | ✅              |
| nova-data         | POST appManage/updateCutGrassPlan                     | ✅              |
| nova-data         | POST appManage/deleteCutGrassPlan                     | ✅              |
| nova-data         | POST appManage/queryNewVersion                        | ✅              |
| nova-data         | GET  cutGrassPlan/queryRecentCutGrassPlan             | ✅              |
| nova-file-server  | GET  map/queryEquipmentMap?sn=                        | ✅              |
| nova-file-server  | POST map/fragmentUploadEquipmentMap                   | ✅              |
| nova-file-server  | POST map/updateEquipmentMapAlias                      | ✅              |
| nova-file-server  | POST log/uploadAppOperateLog                          | ✅              |
| novabot-message   | GET  message/queryRobotMsgPageByUserId                | ✅              |
| novabot-message   | POST message/queryMsgMenuByUserId                     | ✅              |
| novabot-message   | POST message/updateMsgByUserId                        | ✅              |
| novabot-message   | POST message/deleteMsgByUserId                        | ✅              |
| novabot-message   | GET  message/queryCutGrassRecordPageByUserId          | ✅              |
| nova-network      | POST network/connection                                | ✅              |

### Admin endpoints (lokaal, geen auth)
- `GET  /api/admin/devices` — alle bekende apparaten uit device_registry
- `POST /api/admin/devices/:sn/mac` — handmatig MAC registreren `{macAddress: "AA:BB:..."}`

---

## Database tabellen

| Tabel            | Doel                                                        |
|------------------|-------------------------------------------------------------|
| users            | Gebruikersaccounts (email, bcrypt password, machine_token)  |
| email_codes      | Tijdelijke verificatiecodes voor registratie/wachtwoord reset|
| equipment        | Gekoppelde apparaten (mower_sn PK, charger_sn, mac_address) |
| device_registry  | Automatisch geleerd via MQTT CONNECT (sn, mac, last_seen)   |
| maps             | Kaartmetadata (binaire data op disk in storage/maps/)       |
| map_uploads      | Tracking van gefragmenteerde kaartuploads                   |
| cut_grass_plans  | Maaischema's per apparaat                                   |
| robot_messages   | Berichten van apparaat naar gebruiker                       |
| work_records     | Maaiopnames/werkhistorie                                    |
| equipment_lora_cache | Cached LoRa parameters (behouden na unbind voor re-bind) |
| ota_versions     | OTA firmware versies                                        |

---

## Bekende MAC-adres extractie patronen (broker.ts)

```typescript
const MAC_SEP_RE  = /([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}/;   // AA:BB:CC:DD:EE:FF
const MAC_FLAT_RE = /(?<![0-9A-Fa-f])([0-9A-Fa-f]{12})(?![0-9A-Fa-f])/; // AABBCCDDEEFF
const SN_RE       = /LFI[A-Z][0-9]+/;                              // LFIC... of LFIN...
const ESP32_RE    = /ESP32_([0-9A-Fa-f]{6})$/i;                    // ESP32_1bA408
```

---

## APK analyse tips

```bash
# Alle strings uit Dart binary
strings NOVABOT_2.3.8_APKPure/lib/arm64-v8a/libapp.so | grep -i "zoekterm"

# Genummerde output voor context rond een string
strings -n 4 libapp.so | grep -n "Network configuration error"

# Strings met context
strings libapp.so | grep -B3 -A3 "set_mqtt_info"

# Alle API endpoints
strings libapp.so | grep "^/api/"
```

De APK is een Flutter app; de eigenlijke logica zit in `libapp.so` (Dart AOT).
Smali bestanden zijn de Java/Android wrapper, niet interessant voor de app logica.

---

## "Network configuration error. Please retry." — analyse

### Broncode locatie (APK)
String op binary offset `0xa2a1c` in `libapp.so`. Twee code paden:

1. **`AddChargerPageLogic._getMsgFromDevice@877113495`** — BLE provisioning
   Getriggerd als charger niet-nul error code teruggeeft op
   `set_wifi_info_respond` OF `set_mqtt_info_respond` via BLE.

2. **`_getChargerRealPosition@943392371`** — home/detail pagina
   Getriggerd als charger niet reageert op MQTT positie-verzoek (timeout).

### Volledige BLE provisioning volgorde (AddChargerPageLogic @877113495)
1. `_connectDevice` → BLE connect CHARGER_PILE
2. `_discoverServices` → GATT services
3. `_listenBleData` → BLE listener
4. `_writeGetSignalInfo` → `get_signal_info` → WiFi RSSI + GPS
5. (Scherm: WiFi=Sterk, GPS=Sterk) — gebruiker klikt Next
6. `_writeWifiDataToDevice` → `set_wifi_info` {ssid, bssid, password}
7. `_writeMqttInfo` → `set_mqtt_info` {host, port, username, password, addr}
8. `_writeSetLoraInfo` → `set_lora_info`
9. `_writeSetRtkInfo` → `set_rtk_info`
10. `_writeSetConfigInfo` → `set_cfg_info`
11. `_bindCharger` → `bindingEquipment` API

Stap 6/7 fout → "Network configuration error. Please retry."
Stap 8/9 fout → "Network configuration error. Please ensure the antenna is connected properly..."

### isOnline fix (geïmplementeerd)
Server stuurde altijd `isOnline: true`, ook voor niet-verbonden apparaten.
Oorzaak: app ging naar detail-scherm i.p.v. BLE provisioning, MQTT timeout → error.
Fix: `isDeviceOnline(sn)` in broker.ts houdt in-memory Set bij van verbonden SN's.

### Veldnaam fix: `isOnline` → `online`, `mowerSn` verwijderd (geïmplementeerd)
APK analyse (`strings libapp.so`) toont exact welke velden `EquipmentEntity.fromJson` parseert:
`chargerSn`, `chargerVersion`, `equipmentId`, `equipmentNickName`, `equipmentTypeH`,
`macAddress`, `mowerVersion`, `online`, `status`, `chargerAddress`, `chargerChannel`, `userId`

NIET aanwezig: `isOnline`, `mowerSn`
Fix: alle `isOnline:` → `online:`, alle `mowerSn:` verwijderd uit responses.

### getEquipmentBySN response fix (geïmplementeerd, februari 2026)
De server response kwam niet overeen met de echte cloud response (COnsoleLog.txt regels 234-260).
**Oude response** had verkeerde veldnamen (`chargerSn`, `equipmentTypeH`, `online`, `mowerVersion`)
en miste cruciale velden (`account`, `password`, `deviceType`, `sn`, `equipmentCode`, etc.).

**Cloud response voorbeeld** (voor charger LFIC1230700004):
```json
{
  "equipmentId": 755, "email": "", "deviceType": "charger",
  "sn": "LFIC1230700004", "equipmentCode": "LFIC1230700004",
  "equipmentName": "LFIC1230700004", "equipmentType": "LFIC1",
  "userId": 0, "sysVersion": "v0.3.6", "period": "2029-02-22 00:00:00",
  "status": 1, "activationTime": "2026-02-21 18:32:12",
  "importTime": "2023-08-23 18:22:48", "batteryState": null,
  "macAddress": "48:27:E2:1B:A4:0A",
  "chargerAddress": 718, "chargerChannel": 16,
  "account": "li9hep19", "password": "jzd4wac6"
}
```

**Fix**: `rowToCloudDto()` in equipment.ts bouwt nu exact dezelfde structuur.
- `account`/`password` = MQTT credentials (hardcoded `li9hep19`/`jzd4wac6`)
- `chargerAddress`/`chargerChannel` = integers (niet strings)
- `userId` = 0 (niet null), `status` = 1 (niet 0)
- `equipmentType` = eerste 5 tekens van SN (bijv. `LFIC1`, `LFIN2`)
- `deviceType` = `charger` voor LFIC*, `mower` voor LFIN*

### userEquipmentList response fix (geïmplementeerd, februari 2026)
**Cloud response** gebruikt `pageList`/`pageNo`/`pageSize`/`totalSize`/`totalPage` paginering.
Onze server gebruikte `records`/`total`/`size`/`current` → app kon lijst niet parsen.
Fix: paginering-structuur aangepast + extra velden (`videoTutorial`, `model`, `wifiName`, etc.).

### bindingEquipment response fix (geïmplementeerd, februari 2026)
Cloud retourneert `value: null`. Onze server stuurde `{ equipmentId: "..." }` → nu `null`.

### rowToCloudDto SN-selectie bug (gefixt, februari 2026)
`const sn = r.charger_sn ?? r.mower_sn` pakte voor de maaier-rij (waar `charger_sn` gevuld is)
het **charger SN** i.p.v. het maaier SN. De app zag dan twee chargers en geen maaier.
Fix: `const sn = r.mower_sn` — mower_sn is altijd de primaire key in de equipment tabel.

### machineToken = FCM push notificatie token (niet voor MQTT)

### Android DNS failure (gai_error = 7)
ADB logcat toont `gai_error = 7` (EAI_AGAIN = DNS lookup tijdelijk mislukt) voor de Novabot app.
Oorzaak: Android Private DNS (DNS-over-TLS) bypast de router DNS (AdGuard Home).
Fix opties:
1. Android → Instellingen → Netwerk → Privé-DNS → Uit (of "Automatisch")
2. Router DHCP DNS forceren naar AdGuard IP
3. Gebruik iPhone (iCloud Private Relay uitschakelen volstaat)

### BLE GATT structuur (charger CHARGER_PILE / ESP32_1bA408)
- Service UUID: `0x1234`
- Characteristic `0x2222`: Write Without Response + Notify (app → apparaat commando's)
- Characteristic `0x3333`: Read + Write Without Response

BLE commando's als JSON, direct als root object (NIET `{"cmd":"..."}` wrapper):
- `{"get_signal_info":0}`
- `{"set_wifi_info":{"sta":{...},"ap":{...}}}`
- `{"set_mqtt_info":{"addr":"...","port":1883}}`
- `{"set_lora_info":{"addr":718,"channel":16,"hc":20,"lc":14}}`
- `{"set_rtk_info":0}`
- `{"set_cfg_info":1}`

Grote payloads worden gesplitst over meerdere GATT writes (~27 bytes/chunk),
omgeven door ASCII markers `ble_start` en `ble_end`.

Charger reageert NIET op BLE commando's als hij al verbonden is met WiFi+MQTT
(hij zit dan in operationele mode, niet in provisioning mode).

---

## Maaier MQTT berichten — AES-128-CBC versleuteld (GEKRAAKT)

### AES key derivatie (ontdekt via blutter v2.4.0, februari 2026)

De maaier (`LFIN2230700238`) stuurt **AES-128-CBC versleutelde** MQTT berichten.
De encryptie is volledig reverse-engineered via blutter decompilatie van APK v2.4.0.

| Eigenschap | Waarde |
|------------|--------|
| **Algoritme** | AES-128-CBC |
| **Key formule** | `"abcdabcd1234" + SN.substring(SN.length - 4)` |
| **Key voorbeeld** | `abcdabcd12340238` (voor maaier `LFIN2230700238`) |
| **IV** | `abcd1234abcd1234` (statisch, hardcoded) |
| **Padding** | Null-byte padding naar 64-byte grens (niet PKCS7) |
| **Encoding** | UTF-8 voor key en IV |
| **Dart package** | `package:encrypt/encrypt.dart` (`Encrypter`, `AES`, `Key`, `IV`) |
| **Bronbestand** | `package:flutter_novabot/mqtt/encrypt_utils.dart` (nieuw in v2.4.0) |

**Key constructie stap-voor-stap:**
1. Neem het apparaat-serienummer (bijv. `LFIN2230700238`)
2. Pak de laatste 4 karakters: `0238`
3. Concateneer: `"abcdabcd1234"` + `"0238"` = `"abcdabcd12340238"` (16 bytes)
4. Converteer naar bytes via UTF-8 → AES-128 key
5. IV = `"abcd1234abcd1234"` geconverteerd via `Encrypted.fromUtf8()` (altijd vast)

**Broncode (uit blutter decompilatie van encrypt_utils.dart):**
```
// encode():
0x76cc9c: r16 = "abcdabcd1234"           // Key prefix (12 chars)
0x76ccb4: r0 = _interpolate()             // "abcdabcd1234${snSuffix}" → 16 chars
0x76ccd8: r0 = Uint8List.fromList()       // Key als bytes
0x76cd84: r0 = Key()                      // encrypt package Key object
0x76cdac: r0 = AES()                      // AES cipher setup
0x76cdb0: r0 = Encrypter()                // Encrypter wrapper
0x76cdcc: r2 = "abcd1234abcd1234"         // IV string (16 chars)
0x76cdd8: r0 = Encrypted.fromUtf8()       // IV object
0x76cde8: r0 = encryptBytes()             // Encrypt!

// In mqtt.dart, aanroep van decode():
0x765bf8: sub x1, x4, #4                  // length - 4
0x765c0c: r0 = substring()                // SN.substring(len-4) = laatste 4 chars
0x765c18: r0 = decode()                   // EncryptUtils.decode(data, snSuffix)
```

### AES in de app — twee gescheiden systemen

**1. Wachtwoord-encryptie (v2.3.8+):**
| Eigenschap | Waarde |
|------------|--------|
| Klasse | `AesEncryption` in `flutter_novabot/common/aes.dart` |
| Key | `1234123412ABCDEF` (UTF-8, 16 bytes) |
| IV | `1234123412ABCDEF` (zelfde als key) |
| Mode | AES-CBC met PKCS7 padding |
| Output | Base64 encoded |
| Gebruik | Login, registratie, wachtwoord reset — **NIET voor MQTT** |

**2. Maaier MQTT decryptie:**
- **v2.3.8**: `_handlerMowerMsg` doet direct `jsonDecode()` **zonder** decryptie → FormatException → silently dropped
- **v2.4.0**: `mqtt.dart` roept `EncryptUtils.decode(data, SN[-4:])` aan **vóór** `jsonDecode()` → werkt correct
- De decryptiecode (`encrypt_utils.dart`) is **nieuw in v2.4.0** — ontbreekt volledig in v2.3.8

### Ontsleutelde maaier berichten (3 typen per cyclus)

De maaier stuurt **3 JSON berichten per cyclus** (elke ~5 seconden), AES-versleuteld:

#### Type 0: `report_state_robot` (800B versleuteld → ~750B JSON)
Hoofd-statusrapport met positie, batterij, werkstatus, GPS en foutinfo.

| Veld | Voorbeeld | Beschrijving |
|------|-----------|-------------|
| `battery_power` | `100` | Batterij percentage |
| `battery_state` | `"CHARGING"` | Oplaadstatus |
| `work_status` | `0` | Werkstatus (0=idle) |
| `error_status` | `132` | Foutcode (132="Data transmission loss") |
| `error_msg` | `""` | Foutmelding tekst |
| `cpu_temperature` | `35` | CPU temperatuur (°C) |
| `x`, `y`, `z` | `0`, `0`, `0` | Positie coördinaten |
| `loc_quality` | `100` | Lokalisatiekwaliteit (%) |
| `current_map_id` | `""` | Actieve kaart ID |
| `prev_state` | `0` | Vorige status |
| `work_mode` | `0` | Werkmodus |
| `task_mode` | `0` | Taakmodus |
| `recharge_status` | `0` | Oplaadstatus |
| `charger_status` | `0` | Charger verbindingsstatus |
| `mow_blade_work_time` | `72720` | Maaiblad werktijd (sec) |
| `working_hours` | `0` | Huidige werkuren |
| `ota_state` | `0` | OTA update status |
| `mowing_progress` | `0` | Maaivoortgang (%) |
| `covering_area` | `0` | Dekkingsgebied |
| `finished_area` | `0` | Afgewerkt gebied |
| `sw_version` | `"v0.3.25"` | Firmware versie maaier |
| `mow_speed` | `0.0` | Maaisnelheid |

#### Type 1: `report_exception_state` (144B versleuteld → ~100B JSON)
Uitzondering/sensor statusrapport.

| Veld | Voorbeeld | Beschrijving |
|------|-----------|-------------|
| `button_stop` | `false` | Noodstop ingedrukt |
| `chassis_err` | `0` | Chassis foutcode |
| `pin_code` | `""` | PIN code status |
| `rtk_sat` | `29` | RTK GPS satellieten |
| `wifi_rssi` | `55` | WiFi signaalsterkte |

#### Type 2: `report_state_timer_data` (480-496B versleuteld → ~440B JSON)
Batterij, GPS positie, lokalisatie en timer-taken.

| Veld | Voorbeeld | Beschrijving |
|------|-----------|-------------|
| `battery_capacity` | `100` | Batterij percentage |
| `battery_state` | `"CHARGING"` | Oplaadstatus |
| `latitude` | `52.1409...` | GPS breedtegraad |
| `longitude` | `6.2310...` | GPS lengtegraad |
| `orient_flag` | `0` | Oriëntatie vlag |
| `localization_state` | `"NOT_INITIALIZED"` | Lokalisatie status |
| `timer_task` | `[{...}]` | Array met geplande taken |

`timer_task` bevat objecten met: `task_id`, `start_time`, `end_time`, `map_id`, `map_name`,
`repeat_type`, `is_timer`, `work_mode`, `task_mode`, `cov_direction`, `path_direction`, etc.

### Maaier MQTT berichten (transport details)
Topic: `Dart/Receive_mqtt/LFIN2230700238`, clientId: `LFIN2230700238_6688`

| Type | Versleuteld | Blokken | Plaintext | Inhoud |
|------|------------|---------|-----------|--------|
| Type 0 | 800B | 50 | `report_state_robot` | Status, batterij, GPS, fouten |
| Type 1 | 144B | 9 | `report_exception_state` | Sensoren, noodstop, WiFi |
| Type 2 | 480-496B | 30-31 | `report_state_timer_data` | GPS coördinaten, timer taken |

MQTT overhead per bericht: 37 bytes. Totale TCP-pakketten: 837B, 181B, 517B/533B.
Groottevariatie type 2 (480↔496B) komt door null-byte padding naar 64-byte grens.

Gecaptured in `novabot-server/captured/` als `.bin` bestanden.

### Bewijs voor AES-CBC mode
1. Alle payloads zijn **exact deelbaar door 16** (AES blokgrootte)
2. Shannon entropie **7.5-7.8 bits/byte** — uniforme byte-distributie
3. **Blokgrens-divergentie**: twee type-2 payloads (480B vs 496B) identiek tot byte 208,
   daarna 100% afwijkend — dit is het CBC cascade-effect
4. Bevestigd door succesvolle decryptie met AES-128-CBC

---

## Charger ESP32-S3 Firmware Dump (februari 2026)

Flash dump via UART0 header met esptool (`charger_firmware_2.bin`, 8MB).
Verbinding: USB-serial adapter op `/dev/tty.usbserial-130`, 115200 baud.
esptool reset via RTS pin (`--before default_reset`), geen BOOT knop nodig.

### Partitie-tabel

| Partitie | Type | Offset | Grootte | Status |
|----------|------|--------|---------|--------|
| nvs | data | 0x0D000 | 32KB | NVS opslag |
| fctry | data | 0x15000 | 16KB | Factory data (leeg) |
| log_status | data | 0x19000 | 16KB | Log status |
| otadata | data | 0x1D000 | 8KB | OTA boot selectie |
| phy_init | data | 0x1F000 | 4KB | PHY calibratie |
| ota_0 | app | 0x20000 | 1856KB | **v0.3.6 (ACTIEF)** |
| ota_1 | app | 0x1F0000 | 1856KB | v0.4.0 (inactief) |
| coredump | data | 0x3C0000 | 64KB | Core dump |
| log_info | data | 0x3D0000 | 64KB | Log info |
| reserved | data | 0x3E0000 | 128KB | Gereserveerd |

OTA boot state: `ota_seq = 7` → `(7-1) % 2 = 0` → **ota_0 (v0.3.6) is actief**.

### Firmware versies
| Partitie | Firmware | ESP-IDF | LoRa FW |
|----------|----------|---------|---------|
| ota_0 (ACTIEF) | **v0.3.6** | v4.4.2-dirty | - |
| ota_1 (inactief) | **v0.4.0** | v4.4.2-dirty | 0.38 |

### NVS inhoud (Non-Volatile Storage)
| Key | Waarde | Opmerkingen |
|-----|--------|-------------|
| `sn_code` | `LFIC2230700017` | Afwijkend van ons SN (mogelijk factory default) |
| MQTT host | `mqtt.lfibot.com:1883` | |
| WiFi (thuisnet) | `ABERSONPLEIN-IoT` / `ramonvanbruggen` | |
| WiFi (factory) | `abcd1234` / `12345678` | |
| WiFi (LFI dev) | `lfi-abc` / `nlfi@upenn123` | Intern dev netwerk |
| AP SSID | `LFIC2230700017` | Charger's eigen AP |
| AP passwd | `12345678` | |
| RTK positie | ~52.141°N, ~6.231°E, ~8.82m | Nederland |
| LoRa params | hc=20, lc=14 | |
| BLE IRK | `587587b89901833629c1d9307c12817d` | Bonding key |

### Belangrijke firmware strings
| String | Locatie | Betekenis |
|--------|---------|-----------|
| `mqtt.lfibot.com` | NVS | Productie MQTT broker |
| `mqtt-dev.lfibot.com` | Hardcoded | **Development MQTT broker** |
| `mqtt://47.253.57.111` | Hardcoded | **Fallback IP** (Alibaba Cloud) |
| `Dart/Receive_mqtt/%s` | Code | Publish topic (SN als format arg) |
| `Dart/Send_mqtt/%s` | Code | Subscribe topic |
| `https://novabot-oss.oss-us-east-1.aliyuncs.com/novabot-file/lfi-charging-station_lora.bin` | Code | OTA download URL (geeft 404) |

### Key kandidaat in firmware v0.4.0
In ota_1 (v0.4.0, offset 0x23b600) staat: `abcdabcd12341234abcdabcd12341234`
Deze string ontbreekt in v0.3.6 en staat in een BLE-gerelateerde datastructuur.
**Relatie tot AES key**: het prefix `abcdabcd1234` komt overeen met de ontdekte key-prefix
uit `encrypt_utils.dart`. De firmware string is waarschijnlijk een test/default key variant.
De werkelijke key is `"abcdabcd1234" + SN[-4:]` — device-specifiek, niet deze vaste string.

### Charger UART debug output
Bij 115200 baud op UART0 toont de charger:
- NMEA GPS data: `rev_msg1_WORK=$GNGGA,,,,,,0,,,,,,,,*78`
- TLS MQTT fouten: `esp-tls: [sock=54] delayed connect error: Connection reset by peer`
- MQTT reconnect pogingen elke ~5 seconden

De charger probeert **twee** MQTT verbindingen: plain TCP (1883, werkt) en TLS (waarschijnlijk 8883, faalt).

### Charger UART debug console (SECURITY — geen authenticatie!)

De firmware heeft een UART debug console op UART0 (115200 baud) die single-character commando's accepteert **zonder enige authenticatie**:

| Commando | Actie |
|----------|-------|
| `SN_GET` | Lees serienummer uit NVS "fctry" partitie |
| `SN_SET,<sn>,<mqtt>` | **Wijzig SN + redirect MQTT naar `mqtt-dev.lfibot.com:1883`** |
| `LORARSSI_<data>` | Parse LoRa RSSI data (5+ velden) |
| `v` | Print firmware versie |
| `a` / `m` / `f` | RTK GPS mode: auto / manual / factory |
| `o` | Trigger OTA firmware update |
| `w` | WiFi reconnect |
| `d` | **Wis ALLE NVS partities** (storage, fctry, log_status) + reboot |
| `@` | **Wis factory NVS** + reboot |
| `r` | Reboot |
| `b` | **Switch naar andere OTA partitie** + volledige herinitialisatie |

### Ghidra decompilatie (februari 2026)

Firmware v0.3.6 gedecompileerd met Ghidra 12.0.3 (headless mode, Tensilica Xtensa processor).
Custom `esp32s3_to_elf.py` script geschreven om ESP32-S3 app image naar ELF te converteren
(bestaande `esp32_image_parser` ondersteunt geen ESP32-S3).

| Bestand | Beschrijving |
|---------|-------------|
| `charger_ota0_v0.3.6.elf` | ELF voor Ghidra (1.4MB, 6 segments) |
| `charger_ota1_v0.4.0.elf` | ELF voor Ghidra (1.4MB, 6 segments) |
| `ghidra_output/charger_v036_decompiled.c` | Gedecompileerde C-code (7.6MB, 296K regels, 7405 functies) |
| `ghidra_output/charger_v036/` | Ghidra project directory (interactieve analyse) |

### Firmware architectuur (uit decompilatie)

De charger firmware is een **MQTT ↔ LoRa bridge**. Hij voert zelf geen maai-commando's uit,
maar vertaalt alle MQTT JSON commando's naar binaire LoRa pakketten en vice versa.

**FreeRTOS taken:**
| Taak | Functie | Beschrijving |
|------|---------|-------------|
| `mqtt_config_task` | `FUN_4200f078` | MQTT connect, publish loop, command dispatch |
| `lora_config_task` | `FUN_4200b8b8` | LoRa communicatie, channel scan, heartbeat |
| `advanced_ota_example_task` | `FUN_4205d060` | OTA firmware download (esp_https_ota) |

**cJSON functies (key mapping):**
| Firmware functie | cJSON equivalent |
|------------------|-----------------|
| `FUN_42062380` | `cJSON_CreateObject()` |
| `FUN_42062208` | `cJSON_ParseWithLength()` |
| `FUN_42062220` | `cJSON_Print()` |
| `FUN_42062234` | `cJSON_GetObjectItem()` |
| `FUN_42062300` | `cJSON_AddNumberToObject()` |
| `FUN_42062358` | `cJSON_AddStringToObject()` |
| `FUN_42061d54` | `cJSON_Delete()` |

### MQTT implementatie in firmware

**Verbinding:**
- Fallback URI: `mqtt://47.253.57.111` (hardcoded Alibaba Cloud IP)
- Poort: 1883 (0x75b)
- Client ID: serienummer (SN) van het apparaat
- **Geen MQTT username/password** — de charger gebruikt geen credentials in v0.3.6
- Publish topic: `Dart/Receive_mqtt/<SN>` (QoS 0, retain 0)
- Subscribe topic: `Dart/Send_mqtt/<SN>` (QoS 1)
- Factory default MQTT: `mqtt-dev.lfibot.com` (development, niet productie!)

**`up_status_info` wordt gepubliceerd elke ~2 seconden** (counter telt tot 4 bij 500ms polling interval).

**MQTT → LoRa command mapping:**
| MQTT Command | LoRa Queue | LoRa Payload | Beschrijving |
|---|---|---|---|
| `start_run` | `0x20` | `[0x35, 0x01, mapName, area, cutterhigh]` | Start maaien (5 bytes) |
| `pause_run` | `0x21` | `[0x35, 0x03]` | Pauzeer maaien |
| `resume_run` | `0x22` | `[0x35, 0x05]` | Hervat maaien |
| `stop_run` | `0x23` | `[0x35, 0x07]` | Stop maaien |
| `stop_time_run` | `0x24` | `[0x35, 0x09]` | Stop timer taak |
| `go_pile` | `0x25` | `[0x35, 0x0B]` | Ga naar laadstation |

Elke commando wordt via FreeRTOS queue naar de LoRa taak gestuurd, die wacht max 3 seconden op een ACK van de maaier.
Lokaal afgehandeld (geen LoRa): `get_lora_info`, `ota_version_info`, `ota_upgrade_cmd`.

### LoRa communicatie protocol (uit firmware decompilatie)

**Hardware:**
- LoRa module: **EBYTE E32/E22 serie** (gebaseerd op M0/M1 pin mode control + 0xC0/0xC1 config protocol)
- UART1: TX=GPIO17, RX=GPIO18 (data communicatie)
- Mode pins: M0=GPIO12, M1=GPIO46
  - M0=0, M1=0: Normal/transparent mode (data)
  - M0=1, M1=1: Configuration mode (AT-commands)
- RTK/GPS module (UM960): UART2 TX=GPIO19, RX=GPIO20

**LoRa packet format:**
```
Charger → Maaier:
[0x02][0x02][0x00][0x03][len+1][payload...][XOR checksum][0x03][0x03]

Maaier → Charger:
[0x02][0x02][0x00][0x01][len+1][payload...][XOR checksum][0x03][0x03]
```

| Offset | Grootte | Waarde | Beschrijving |
|--------|---------|--------|-------------|
| 0-1 | 2 | `0x02, 0x02` | Start bytes |
| 2-3 | 2 | `0x00, 0x03` (TX) / `0x00, 0x01` (RX) | Adres (charger=0x03, mower=0x01) |
| 4 | 1 | `len+1` | Payload lengte + 1 |
| 5..5+n | n | varies | Payload (command byte + data) |
| 5+n | 1 | XOR | XOR checksum over alle payload bytes |
| 6+n, 7+n | 2 | `0x03, 0x03` | End bytes |

**LoRa command categorieën (eerste byte van payload):**
| Byte | Categorie | Beschrijving |
|------|-----------|-------------|
| `0x30` ('0') | CHARGER | Charger hardware (Hall sensor ACK, IRQ ACK) |
| `0x31` ('1') | RTK_RELAY | RTK GPS NMEA data relay naar maaier |
| `0x32` ('2') | CONFIG | Configuratie commando's |
| `0x33` ('3') | GPS | GPS positie data (lat/lon/alt, 16 bytes) |
| `0x34` ('4') | REPORT | Status reports (heartbeat poll + maaier data) |
| `0x35` ('5') | ORDER | Maai-commando's (start/pause/stop/go_pile) |
| `0x36` ('6') | SCAN_CHANNEL | LoRa kanaal scan |

**Maaier status data via LoRa (REPORT sub-cmd 0x02, 19 bytes):**
| LoRa offset | Grootte | Globale var | MQTT veld |
|------------|---------|-------------|-----------|
| [7-10] | 4 bytes (uint32 LE) | `DAT_42000c54` | `mower_status` |
| [11-14] | 4 bytes (uint32 LE) | `DAT_42000c58` | `mower_info` |
| [15-17] | 3 bytes (uint24 LE) | `DAT_42000c5c` | `mower_x` |
| [18-20] | 3 bytes (uint24 LE) | `DAT_42000c60` | `mower_y` |
| [21-23] | 3 bytes (uint24 LE) | `DAT_42000c64` | `mower_z` |
| [24-25] | 2 bytes (uint16 LE) | `DAT_42000c68` | `mower_info1` |

**LoRa RSSI meting:**
- Query: `[0xC0, 0xC1, 0xC2, 0xC3, 0x00, 0x01]` (6 bytes naar LoRa module)
- Response: `[0xC1, 0x00, 0x01, <RSSI>]` (RSSI als byte 0-255)
- Threshold: RSSI < 146 (0x92) = goed signaal
- Kanaal scan: probeert alle kanalen van lc tot hc, sorteert op RSSI (bubble sort), kiest beste

**RTK GPS relay:**
De charger ontvangt GNGGA NMEA zinnen van de UM960 RTK module en relayt deze naar de maaier
via LoRa command `[0x31, NMEA_data...]`. De maaier gebruikt dit voor centimeter-nauwkeurige navigatie.

### NVS opslag structuur (uit firmware decompilatie)

**`"fctry"` namespace (factory data):**
| Key | Type | Grootte | Beschrijving |
|-----|------|---------|-------------|
| `sn_code` | string | ~20 bytes | Serienummer |
| `sn_flag` | u8 | 1 byte | SN geconfigureerd vlag |

**`"storage"` namespace (runtime config):**
| Key | Type | Grootte | Beschrijving |
|-----|------|---------|-------------|
| `wifi_data` | blob | 96 bytes | STA WiFi: SSID (32b) + password (64b) |
| `wifi_ap_data` | blob | 96 bytes | AP WiFi: SSID (32b) + password (64b) |
| `mqtt_data` | blob | 32 bytes | MQTT host (30b) + port (2b, offset 0x1e) |
| `lora_data` | blob | 4 bytes | LoRa addr (2b) + channel (1b) + reserved |
| `lora_hc_lc` | blob | 2 bytes | LoRa hc (1b) + lc (1b) |
| `rtk_data` | blob | 40 bytes | RTK positie: lat(8b)+NS(1b)+lon(8b)+EW(1b)+alt(8b) |
| `cfg_flag` | u8 | 1 byte | Configuratie gecommit vlag |

### Security bevindingen (uit firmware decompilatie)

1. **Geen MQTT authenticatie** — de charger v0.3.6 gebruikt geen username/password voor MQTT. De credentials `li9hep19`/`jzd4wac6` uit cloud responses worden niet door de charger zelf gebruikt.
2. **Geen AES encryptie voor charger MQTT** — in tegenstelling tot de maaier stuurt de charger plain JSON. Er is geen `abcdabcd1234` key of encrypt_utils in v0.3.6.
3. **WiFi wachtwoorden in plaintext** in NVS, geprint naar UART debug log (`ssid: %s`, `password: %s`).
4. **UART console zonder authenticatie** — volledige factory access: SN wijzigen, NVS wissen, firmware switchen, MQTT redirecten.
5. **Statische BLE passkey** — BLE pairing met DisplayYesNo IO capability + MITM, maar statische passkey.
6. **Hardcoded fallback IP** — `47.253.57.111` (Alibaba Cloud) als DNS faalt.
7. **ESP-IDF voorbeeld-code** — firmware gebouwd op ESP-IDF examples (`SEC_GATTS_DEMO`, `MQTT_EXAMPLE`, `advanced_ota_example_task`), beperkte custom security hardening.
8. **TLS wordt geprobeerd maar faalt** — mbedTLS stack aanwezig, maar TLS MQTT verbindingen falen (`Connection reset by peer`).

---

## Blutter Decompilatie (februari 2026)

### App v2.3.8 (Dart 3.2.3)

Dart AOT decompiler `blutter` toegepast op `NOVABOT_2.3.8_APKPure/lib/arm64-v8a/libapp.so`.
Output in `blutter_output/` (asm/, pp.txt, objs.txt, blutter_frida.js).

- Dart 3.2.3, Snapshot: `f71c76320d35b65f1164dbaa6d95fe09`
- Target: android arm64, compressed-pointers, null-safety

**MQTT receive-path (geen decryptie):**
1. `mqtt.dart` ontvangt MQTT berichten
2. `MqttPublishPayload::bytesToStringAsString()` converteert bytes naar string (geen decryptie)
3. `MqttDataHandler::mqttResHandler()` routeert naar charger of mower handler
4. Beide handlers doen direct `jsonDecode()` — bij AES-ciphertext: FormatException → silently dropped
5. **De decryptiecode voor maaier-berichten ontbreekt in v2.3.8**

**AES voor wachtwoorden (enige AES-gebruik in v2.3.8):**
- `AesEncryption::encryption()` op adres `0x82bc18`
- Key + IV = `"1234123412ABCDEF"` (UTF-8)
- Mode: AES-CBC, PKCS7 padding, base64 output
- Alleen aangeroepen vanuit login, signup, forgot password pagina's

### App v2.4.0 (Dart 3.6.1) — AES key gevonden!

Blutter toegepast op `NOVABOT_2.4.0_arm64/lib/arm64-v8a/libapp.so`.
Output in `blutter_output_v2.4.0/`. APK bron: APKPure (arm64 XAPK).

- Dart 3.6.1
- Target: android arm64, compressed-pointers, null-safety

**Cruciale nieuwe module: `encrypt_utils.dart`** (ontbreekt in v2.3.8!):
- `EncryptUtils.encode(data, snSuffix)` — versleutelt met `"abcdabcd1234" + snSuffix`
- `EncryptUtils.decode(data, snSuffix)` — ontsleutelt met dezelfde key
- `EncryptUtils.iv()` — retourneert statische IV `"abcd1234abcd1234"`
- Gebruikt `package:encrypt/encrypt.dart` (`Encrypter`, `AES`, `Key`, `IV`)

**MQTT receive-path (MET decryptie):**
1. `mqtt.dart` ontvangt MQTT berichten als `Uint8List`
2. `substring(length - 4)` extraheert laatste 4 chars van SN → `snSuffix`
3. `EncryptUtils.decode(data, snSuffix)` ontsleutelt → plaintext JSON string
4. `jsonDecode()` parst de JSON
5. `MqttDataHandler` routeert naar de juiste handler

**v2.4.0 bevat ook een custom AES implementatie** (`@1401282659`):
- Hand-rolled `_keyExpansion`, `_invCipher`, `_cbc`, `_addPadding` methoden
- `AesCipherUtil` helper klasse
- Deze wordt **NIET** gebruikt voor MQTT — de `encrypt` package wordt gebruikt
- Mogelijk fallback of test implementatie

### AES mode map (uit object pool pp.txt)
| Index | Mode | Gebruik |
|-------|------|---------|
| 0 | CBC | **Default** (wachtwoord + MQTT encryptie) |
| 1 | CFB-64 | Niet gebruikt |
| 2 | CTR | Niet gebruikt |
| 3 | ECB | Niet gebruikt |
| 6 | SIC | Niet gebruikt |
| 7 | GCM | Niet gebruikt |

---

### `_6688` suffix in maaier clientId
`LFIN2230700238_6688` — de `_6688` suffix is niet gevonden als constante in de APK.
Waarschijnlijk berekend/dynamisch (protocol versie, hardware variant, of connection instance).
De charger heeft geen suffix: clientId = `ESP32_1bA408`.

---

## "Add Mower" flow (AddMowerPageLogic @883255105)

### Methoden (uit APK strings)
- `_getMowerFromServer@883255105` — roept `getEquipmentBySN` aan met maaier SN
- `_connectDevice@883255105` — BLE connect naar apparaat met naam `novabot`
- `_discoverServices@883255105` — GATT service discovery
- `_listenBleData@883255105` — BLE data listener
- `_writeWifiDataToDevice@883255105` — `set_wifi_info`
- `_writeMqttInfo@883255105` — `set_mqtt_info`
- `_writeSetLoraInfo@883255105` — `set_lora_info`
- `_writeSetConfigInfo@883255105` — `set_cfg_info`
- `_bindMower@883255105` — `bindingEquipment` API call
- `_scanBarCode@883255105` — QR code scanner voor SN invoer

### BLE device name matching
De app matcht BLE device names **case-insensitive**:
- Charger: zoekt `chargerpile` (matcht `CHARGER_PILE`)
- Maaier: zoekt `novabot` (matcht `Novabot` of `NOVABOT`)

### "No device was found, please make sure the device is powered on"
Deze foutmelding verschijnt wanneer de BLE scan geen apparaat vindt met de verwachte naam.

**Oorzaak**: de maaier heeft zijn BLE radio UIT als hij al verbonden is met WiFi+MQTT
(zelfde gedrag als de charger in operationele mode). De app kan hem dan niet via BLE vinden.

**Workaround**: maaier handmatig binden via database INSERT (zie hieronder).
De maaier is al geconfigureerd met WiFi/MQTT/LoRa — BLE provisioning is niet meer nodig.

### Maaier BLE capture (Novabot-Mower.pklg)
BLE capture toont dat de maaier als `NOVABOT` (hoofdletters) adverteert wanneer in provisioning mode:
- BLE MAC: `50:41:1C:39:BD:C1`
- Manufacturer data: `66 55 50 41 1C 39 BD C1`
- GATT service discovery + characteristic reads/writes zijn zichtbaar
- Dezelfde service UUID `0x1234` en characteristics `0x2222`/`0x3333` als de charger

---

## Handmatig maaier binden (workaround)

Als de maaier al op het WiFi/MQTT netwerk zit maar BLE provisioning niet lukt:

```sql
-- Zoek eerst de user ID
SELECT app_user_id, email FROM users;

-- Zoek de maaier in device_registry (moet al verbonden zijn geweest via MQTT)
SELECT * FROM device_registry WHERE sn = 'LFIN2230700238';

-- Voeg maaier toe aan equipment tabel
INSERT INTO equipment (
  equipment_id, user_id, mower_sn, charger_sn,
  equipment_nick_name, equipment_type_h,
  charger_address, charger_channel, mac_address
) VALUES (
  '<uuid>', '<app_user_id>', 'LFIN2230700238', 'LFIC1230700004',
  'Novabot Mower', 'Novabot',
  '718', '15', '50:41:1C:39:BD:BF'
);
```

**Let op**: `mower_sn` is de primaire key, `charger_sn` is de referentie naar het laadstation.
De `charger_channel` waarde (`15`) komt uit de `set_lora_info_respond` tijdens charger provisioning.

---

## Maaier foutmeldingen (uit `mower_error_text.dart`)

De app mapt numerieke foutcodes (`error_code` / `report_exception_state`) naar gebruikersberichten:

**Motor/hardware fouten (PIN code vereist om te ontgrendelen):**
- Blade motor is stalled. Please check and enter the PIN code to unlock.
- Blade motor overcurrent. Please check and enter the PIN code to unlock.
- Wheel motor is stalled. Please check and enter the PIN code to unlock.
- Wheel motor overcurrent. Please check and enter the PIN code to unlock.
- NOVABOT has been emergency stopped. Please enter the PIN code to unlock.
- NOVABOT is lifted. Please put it back on the ground and enter the PIN code to unlock.
- NOVABOT is tilted. Please manually move it to a flat ground, and enter the PIN code to unlock.
- NOVABOT turn over! Please manually turn it back upright and enter the PIN code to unlock.

**Fysieke obstakels:**
- NOVABOT collided. Please assist it in getting unstuck.
- The wheels are slipping, please check.
- The lawnmower is outside the map. Please move it back inside the map.

**Batterij:**
- NOVABOT is out of power, please wait for charging to complete.
- The lawnmower has low battery and cannot start working.
- The machine has a low battery. This function is unavailable.

**Hardware sensoren:**
- The TOF sensor has a hardware malfunction. Please contact after-sales service.
- The front camera sensor has a hardware malfunction. Please contact after-sales service.
- Machine chassis error. Please view the control panel screen.

**Mapping/navigatie:**
- Internal service error in the mapping module. Please restart the machine and try again.
- The mapping service request is unreasonable. Please restart the machine and try again.
- Cover module internal error. Please restart the machine or try again later.
- Cover module action error. Please restart the machine or try again later.
- Lora configuration error. Please restart the machine or try again later.
- Mapping failed, please re-mapping.
- The map was created successfully, but the upload failed. Please retry in an area with a strong network signal.

**Laadstation:**
- Failed to obtain the charging location. Please restart the machine or try again later.
- Failed to return to the charging station, please try again or remotely control the machine to return.
- Return to charging station failed, please retry or manually move NOVABOT back.
- Go to charging station failed, please try again.
- The charging signal cannot be found. Please verify that the charging station is connected to power.
- The QR code signal cannot be found. Please verify that the QR code on the charging station is not blocked.
- The lawnmower is unable to leave the charging station. Please ensure there are no obstacles blocking its path.

**GPS/signaal:**
- GPS signal is weak and cannot be initialized. Please try moving the antenna to an open area and retry.
- The GPS signal is weak, please make sure the antenna is installed in an unobstructed area.
- Poor location quality, please move the lawnmower to an open area to start.

**Netwerk:**
- Network configuration error. Please retry.
- Network configuration error. Please ensure the antenna is connected properly and try again.
- Network connection timed out. Please retry.
- WiFi connection failed. Please verify that the WiFi name and password entered are correct.
- Bluetooth connection failed.
- NOVABOT's Bluetooth is disconnected. Please move closer to the machine and try again.

---

## Kaarttypen en beperkingen

De app ondersteunt 3 kaarttypen (`map_type`):

| Type | Beschrijving | Beperkingen |
|------|-------------|-------------|
| **Working area** | Gazon dat gemaaid moet worden | Max 3 werkgebieden |
| **Obstacle area** | Gebieden om te vermijden | Min 1m afstand tot grens |
| **Channel area** | Smalle doorgangen tussen gazons | Min 1m breed, max 10m recht |

**Overige beperkingen (uit app UI strings):**
- Max 3 kaarten + 3 kanaalgebieden tegelijk
- Kanaal nodig als pad naar laadstation > 1.5m of niet recht tegenover gazon
- Bij mapping: volg maaier binnen 2 meter
- Min 20% batterij op telefoon én maaier voor mapping
- Maaiertijd aanbeveling: minimaal 30 minuten

---

## Geavanceerde instellingen (para_info)

Via de app-pagina `/advancedSettings` en MQTT commando's `get_para_info` / `set_para_info`:

| Parameter | Beschrijving |
|-----------|-------------|
| `obstacle_avoidance_sensitivity` | Gevoeligheid obstakeldetectie |
| `target_height` | Doelhoogte voor maaien |
| `defaultCuttingHeight` | Standaard maaihoogte |
| `path_direction` | Maaipad richting |
| `cutGrassHeight` | Maaihoogte instelling |

---

## App navigatie routes

Alle in-app routes (voor eigen app ontwikkeling):

| Route | Beschrijving |
|-------|-------------|
| `/entrance` | Splash/welkom scherm |
| `/login` | Inloggen |
| `/signup` | Registreren |
| `/forgetPassword` | Wachtwoord vergeten |
| `/resetPassword` | Wachtwoord resetten |
| `/home` | Hoofdscherm (apparaat status) |
| `/profile` | Gebruikersprofiel |
| `/settings` | Instellingen |
| `/about` | Over de app |
| `/language` | Taal selectie |
| `/deleteAccount` | Account verwijderen |
| `/addCharger` | Laadstation toevoegen (BLE provisioning) |
| `/addMower` | Maaier toevoegen (BLE provisioning) |
| `/equipmentDetail` | Apparaat detail pagina |
| `/renameDevice` | Apparaat hernoemen |
| `/viewPin` | PIN code bekijken |
| `/advancedSettings` | Geavanceerde instellingen (para_info) |
| `/otaPage` | Firmware update (OTA) |
| `/lawn` | Gazon/kaart weergave |
| `/buildMap` | Kaart bouwen |
| `/chooseMapType` | Kaarttype kiezen (werkgebied/obstakel/kanaal) |
| `/preBuildMap` | Pre-build kaart instructies |
| `/manulController` | Handmatige joystick besturing (let op: typo "manul") |
| `/schedule` | Maaischema's beheren |
| `/message` | Berichten |
| `/robotMessage` | Robot berichten |
| `/workingRecords` | Werkhistorie |
| `/scanner` | QR code scanner (voor SN invoer) |
| `/webview` | WebView pagina |
| `/pdfview` | PDF viewer |
| `/videoPlay` | Video afspelen |
| `/logs` | Logs bekijken |

---

## App architectuur (uit APK source paden)

**Framework**: Flutter/Dart met GetX state management

### MQTT laag
| Bestand | Beschrijving |
|---------|-------------|
| `mqtt/mqtt.dart` | MQTT client klasse (`Mqtt`) — ontvangt berichten, decrypteert maaier data (v2.4.0+) |
| `mqtt/mqtt_data_handler.dart` | Message routing (`MqttDataHandler`, singleton) |
| `mqtt/encrypt_utils.dart` | AES-128-CBC encryptie/decryptie (nieuw in v2.4.0) |

De `MqttDataHandler` heeft twee aparte handlers:
- `_handlerChargerMsg` — parst plain JSON van charger
- `_handlerMowerMsg` — parst JSON (in v2.4.0 al ontsleuteld door `mqtt.dart`)

Routering: `targetIsMower` flag bepaalt of bericht naar charger of mower handler gaat.

**Versieverschil**: In v2.3.8 doet `mqtt.dart` direct `jsonDecode()` op maaier bytes → FormatException
op ciphertext → silently dropped. In v2.4.0 roept `mqtt.dart` eerst `EncryptUtils.decode()` aan,
waarna de JSON correct geparst wordt. Maaier-status is alleen zichtbaar in app v2.4.0+.

### Controllers (GetX)
| Controller | Beschrijving |
|-----------|-------------|
| `charger_status_controller.dart` | Charger status state management |
| `mower_status_controller.dart` | Maaier status state management |
| `equipment_controller.dart` | Apparaat beheer |
| `lawn_controller.dart` | Gazon/kaart state |
| `user_controller.dart` | Gebruiker state |

### Data models
| Model | Velden |
|-------|--------|
| `EquipmentEntity` | `chargerSn`, `chargerVersion`, `equipmentId`, `equipmentNickName`, `equipmentTypeH`, `macAddress`, `mowerVersion`, `online`, `status`, `chargerAddress`, `chargerChannel`, `userId` |
| `MapEntity` / `MapEntityItem` | `map_id`, `map_ids`, `map_name`, `map_type`, `map_position` |
| `WorkPlanEntity` / `WorkPlanEntityItem` | `startTime`, `endTime`, `mapId`, `work_mode` |
| `ChargingPostion` _(typo in APK)_ | Laadstation positie data |
| `CoveringData` | `covering_area`, `cov_direction`, `finished_area`, `mowing_progress` |
| `PlanPath` | `plan_path`, `path_direction` |
| `UserEntity` | Gebruikersaccount data |
| `RobotMessageEntity` | Robot notificatie berichten |
| `WorkMessageEntity` | Werk/maai berichten |

### UI interceptors (guard conditions)
De app blokkeert bepaalde acties met deze checks:
| Check | Beschrijving |
|-------|-------------|
| `noMapIntercept` | Geen kaart aanwezig |
| `noMower` | Geen maaier gekoppeld |
| `noChargingStation` | Geen laadstation gekoppeld |
| `lowBatteryIntercept` | Batterij te laag |
| `backingIntercept` | Maaier keert terug |
| `workingIntercept` | Machine is aan het werk (blokkeert verwijderen/bewerken) |
| `pinCodeIntercept` | PIN code vereist |
| `mapNoUnicomIntercept` | Kaarten niet verbonden via kanaal |

### "Niet meer herinneren" voorkeurkeys
| Key | Beschrijving |
|-----|-------------|
| `dont_remind_build_map` | Kaart bouwen waarschuwing |
| `dont_remind_obstacle` | Obstakelgebied waarschuwing |
| `dont_remind_channel3` | Kanaalgebied waarschuwing |
| `dont_remind_modify_map` | Kaart wijzigen waarschuwing |
| `dont_remind_pre_build` | Pre-build waarschuwing |

---

## Externe URLs en diensten

| URL | Beschrijving |
|-----|-------------|
| `https://app.lfibot.com` | Hoofd API server (cloud retourneert 500 op sommige endpoints) |
| `mqtt.lfibot.com:1883` | MQTT broker (plain TCP) |
| `mqtt-dev.lfibot.com` | Development MQTT broker (uit firmware) |
| `47.253.145.99` | Cloud server IP (app.lfibot.com) |
| `47.253.57.111` | Fallback MQTT IP (uit charger firmware) |
| `https://lfibot.zendesk.com/hc/en-gb` | Klantenservice / helpcentrum |
| `https://novabot.com/` | Publieke website |
| `https://novabot-oss.oss-us-east-1.aliyuncs.com/novabot-document/` | Handleidingen (PDF) op Alibaba OSS |
| `https://novabot-oss.oss-us-east-1.aliyuncs.com/novabot-file/` | OTA firmware (bucket listing geblokkeerd, URLs geven 404) |

**Developer info gelekt in binary**: `file:///Users/jiangcongde/Desktop/project/flutter_novabot/`

---

## Maaier status weergave (UI widgets)

De app toont verschillende widgets afhankelijk van de maaier-status:

| Widget | Beschrijving |
|--------|-------------|
| `OnlineView` | Apparaat online, wacht op commando's |
| `OfflineView` | Apparaat offline |
| `MowingWidget` | Bezig met maaien |
| `ChargingWidget` | Bezig met opladen |
| `BackingChargerWidget` | Keert terug naar laadstation |
| `WaitCommandWidget` | Standby, wacht op commando's |
| `LoadFailedView` | Laden mislukt |

### Display states (afgeleid uit widget/string namen)
| State | Beschrijving |
|-------|-------------|
| `backingCharger` | Maaier keert terug naar laadstation |
| `backedCharger` | Maaier bij laadstation aangekomen |
| `pauseAndCharging` | Gepauzeerd en aan het opladen |
| `gotoCharging` | Onderweg naar laadstation |
| `startMowing` | Start met maaien |
| `startMapping` | Start met kaart bouwen |
| `noMowingUncharged` | Kan niet maaien (batterij leeg) |

---

## OTA firmware update protocol

**App route**: `/otaPage`

**Flow:**
1. App vraagt `ota_version_info` via MQTT → `ota_version_info_respond`
2. App checkt API: `GET /api/nova-user/otaUpgrade/checkOtaNewVersion?version=<VER>&upgradeType=serviceUpgrade&equipmentType=<TYPE>`
3. App checkt API: `POST /api/nova-data/appManage/queryNewVersion`
4. Bij beschikbare update: app stuurt `ota_upgrade_cmd` via MQTT
5. Apparaat pusht `ota_upgrade_state` updates (voortgang)
6. Na maaier-update vraagt app: "The charging station can also be upgraded. Would you like to proceed?"

**UI strings:**
- "Are you sure to upgrade? Expected to take 20-30 minutes"
- "Can be operated in the background during the upgrade. Do not close NOVABOT APP."
- "Upgrading... please do not operate the machine during the upgrade process."

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
- [ ] Eigen app bouwen — alle MQTT commando's en data models zijn gedocumenteerd als referentie
- [ ] Maaier ESP32 firmware dump (voor verdere reverse engineering)
- [x] APK v2.4.0 geanalyseerd met blutter — `encrypt_utils.dart` bevat AES key derivatie
- [x] Server decrypt.ts herschreven met correcte key derivatie (`"abcdabcd1234" + SN[-4:]`)
- [x] HA bridge updaten: ontsleutelde maaier-sensordata doorsturen naar Home Assistant
- [x] Charger firmware v0.3.6 gedecompileerd met Ghidra (7405 functies, MQTT/LoRa/BLE volledig geanalyseerd)
- [x] LoRa protocol volledig reverse-engineered (packet format, command mapping, RSSI scanning)
- [x] Charger = MQTT ↔ LoRa bridge architectuur bevestigd
- [x] LoRa module geïdentificeerd als EBYTE E32/E22 serie (M0=GPIO12, M1=GPIO46)
- [x] Security audit: geen MQTT auth, geen AES, UART console zonder auth, plaintext WiFi in NVS
- [x] Charger firmware v0.4.0 gedecompileerd — enige verschil is AES-128-CBC encryptie voor MQTT

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

**Resultaat**: Maaier succesvol toegevoegd via lokale server na fixes 1-3.
Maaier-berichten worden als AES-ciphertext doorgestuurd naar de app.
De server kan nu ook zelf ontsleutelen (key derivatie bekend).

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
