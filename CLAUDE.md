# Novabot Reverse Engineering — Project Context

Dit project is een lokale vervanging van de Novabot cloud (app.lfibot.com / mqtt.lfibot.com).
Het bestaat uit een Node.js/TypeScript/Express server + een embedded aedes MQTT broker.

## Doel
De Novabot app (v2.3.8, Flutter/Dart) praat met de lokale server i.p.v. de echte cloud,
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
│       ├── mqtt/decrypt.ts         AES decryptie-pogingen voor maaier MQTT berichten
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

### charger_status bitfield (geobserveerde waarden)
| Waarde (dec) | Waarde (hex)   | Situatie                              |
|--------------|----------------|---------------------------------------|
| 0            | `0x00000000`   | Direct na eerste MQTT connect (idle)  |
| 268435713    | `0x10000101`   | Na reset/reconnect, operationeel      |
| 285212929    | `0x11000101`   | Operationeel (variant)                |
| 234881281    | `0x0E000101`   | Operationeel (variant)                |

Bits `0x01` en `0x100` lijken altijd aan te staan in operationele toestand.
Hoge byte verschilt per toestand (0x0E, 0x10, 0x11 = 14, 16, 17 dec).

### mower_error gedrag
Telt op van 0 → 2 → 3 → ... → 9 (en herhaalt mogelijk).
Waarschijnlijk: charger zoekt maaier via LoRa en telt het aantal mislukte pogingen.
Zodra maaier gevonden is via LoRa, zal `mower_error` → 0 gaan.

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

## Maaier MQTT berichten — AES-versleuteld

De maaier (`LFIN2230700238`) stuurt **AES-versleutelde** MQTT berichten, in tegenstelling tot de
charger die plain JSON stuurt. De app heeft twee aparte handlers:

| Handler (APK)                        | Apparaat | Formaat              |
|--------------------------------------|----------|----------------------|
| `_handlerChargerMsg@856158221`       | Charger  | Plain JSON           |
| `_handlerMowerMsg@856158221`         | Maaier   | AES-128 versleuteld  |

### Encryptie-infrastructuur in APK
- **Module**: `package:flutter_novabot/common/aes.dart`
- **Klasse**: `AesEncryptor`
- **Methoden**: `_aesDecrypt@1364065024`, `_aesEncrypt@1364065024`
- **Bibliotheek**: `package:encrypt/` + `package:pointycastle/` (SIC Block Cipher = CTR mode)
- **Statische key kandidaat**: `1234123412ABCDEF` (offset `0x1084fe` in `libapp.so`, naast `AesEngine`)
- **Algoritme**: APK verwijst naar `SICBlockCipher` + `AesCipherNoPadding` → **AES-CTR** (niet CBC)
- **Decryptie-poging**: `novabot-server/src/mqtt/decrypt.ts`, gehooked in `broker.ts` publish handler

### AES key status: ONBEKEND (runtime-derived)
De statische key `1234123412ABCDEF` uit de APK **werkt niet**. Er zijn 4300+ combinaties
geprobeerd met diverse keys, IVs en modi (CBC, ECB, CTR, AES-128 en AES-256):

| Categorie                  | Aantal geteste combinaties |
|----------------------------|---------------------------|
| UTF-8 directe strings      | ~15 keys × 6 IVs × 3 modi |
| Hex-gedecodeerde strings   | ~5 keys × 6 IVs × 3 modi  |
| MD5/SHA-256 hashes          | ~11 inputs × 3 hash types × 6 IVs × 3 modi |
| AES-256 varianten          | ~4 keys × 6 IVs × 2 modi  |

**Conclusie**: de AES key is **runtime-derived** en niet als statische constante in de APK opgeslagen.
De cloud retourneert `account: null, password: null` voor de maaier, dus de key komt ook niet
uit de cloud API. Mogelijke key-bronnen:
- Afgeleid van device-specifieke data (SN, MAC) via een niet-triviale hash
- Uitgewisseld tijdens BLE provisioning (niet zichtbaar in onze captures)
- Hardcoded in ESP32 firmware + berekend in Dart code via onbekend algoritme

**Mogelijke next steps voor key-discovery:**
1. **Frida** — dynamic instrumentation op de app, hook `_aesDecrypt` en log key/IV
2. **blutter** — Dart AOT decompiler voor `libapp.so`, reconstrueer `AesEncryptor` klasse
3. **ESP32 firmware dump** — lees flash geheugen van maaier, zoek naar key materiaal

De server hoeft maaier-berichten **niet** te ontsleutelen voor normale werking —
hij relayt de encrypted bytes ongewijzigd naar de app die ze zelf decrypteert.

### Maaier MQTT berichten (geobserveerd, februari 2026)
Topic: `Dart/Receive_mqtt/LFIN2230700238`, clientId: `LFIN2230700238_6688`

De maaier stuurt 3 soorten berichten per cyclus (elke ~5 seconden):
- **~677 bytes** — vaste header, waarschijnlijk status + GPS positie
- **~181 bytes** — kleiner statusbericht
- **~517-533 bytes** — variabele data (mogelijk kaart/pad-informatie)

De eerste ~30 bytes zijn consistent (vast AES-IV + encrypted block header).
Payload analyse: entropie 7.5-7.8 bits/byte, uniforme byte-distributie — bevestigt sterke encryptie.
Gecaptured in `novabot-server/captured/` als `.bin` bestanden voor offline analyse.
De server hoeft deze data **niet** te ontsleutelen — hij relayt het alleen naar de app.

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
| `mqtt/mqtt.dart` | MQTT client klasse (`Mqtt`) |
| `mqtt/mqtt_data_handler.dart` | Message routing (`MqttDataHandler`, singleton) |

De `MqttDataHandler` heeft twee aparte handlers:
- `_handlerChargerMsg` — parst plain JSON van charger
- `_handlerMowerMsg` — decrypteert AES en parst JSON van maaier

Routering: `targetIsMower` flag bepaalt of bericht naar charger of maaier handler gaat.

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
| `https://app.lfibot.com` | Hoofd API server |
| `mqtt.lfibot.com:1883` | MQTT broker |
| `https://lfibot.zendesk.com/hc/en-gb` | Klantenservice / helpcentrum |
| `https://novabot.com/` | Publieke website |
| `https://novabot-oss.oss-us-east-1.aliyuncs.com/novabot-document/` | Handleidingen (PDF) op Alibaba OSS |

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
- [ ] `charger_status` bitfield volledig decoderen tegen Novabot-Base-Station.pdf
- [x] Maaier provisioning flow documenteren (BLE commando's voor `Novabot` device)
- [x] Volledige MQTT commando protocol documenteren (40+ commando's, 39 response types)
- [ ] Begrijpen wanneer `mower_error` stopt met tellen (maaier verbindt via LoRa)
- [x] AES encryptie-infrastructuur gevonden in APK (`AesEncryptor`, `SICBlockCipher`)
- [ ] AES key achterhalen — statische key `1234123412ABCDEF` werkt niet, key is runtime-derived (4300+ combinaties getest). Volgende stappen: Frida, blutter, of ESP32 firmware dump
- [ ] Maaier MQTT berichten ontsleutelen en payload structuur documenteren
- [x] Maaier BLE provisioning via app werkend krijgen (opgelost: MAC fix + CONNECT flags fix)
- [x] App MQTT CONNECT bug fixen (Will QoS met Will Flag=0) — `sanitizeConnectFlags` in broker.ts
- [x] Maaier `account`/`password` = null in cloud response bevestigd en geïmplementeerd
- [x] MAC-adres in responses = BLE MAC (niet WiFi STA) — device_registry bijgewerkt
- [x] Alle foutmeldingen, kaarttypen, app-routes en UI states gedocumenteerd
- [x] App architectuur (controllers, models, interceptors) gedocumenteerd
- [ ] Uitzoeken of `_6688` clientId suffix een vaste waarde of berekend is
- [ ] Eigen app bouwen — alle MQTT commando's en data models zijn gedocumenteerd als referentie

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
Maaier al verbonden met WiFi+MQTT en stuurt AES-versleutelde berichten.
`mower_error` op charger telt op tot >90 (charger zoekt maaier via LoRa maar vindt hem niet).

### Maaier provisioning via cloud (februari 2026)
- `Novabot-Mower-cloud.pklg` — Apple PacketLogger BLE capture (macOS)
- `ConsoleLogMower.txt` — MQTT/HTTP proxy console output

**Resultaat**: Maaier `LFIN2230700238` BLE provisioning flow gecaptured via echte cloud.
Belangrijkste bevindingen: maaier gebruikt alleen `ap` WiFi (geen `sta`), geen `set_rtk_info`,
`set_cfg_info` bevat timezone, `set_lora_info_respond` geeft `value: null`.
Nieuw endpoint ontdekt: `POST /api/nova-network/network/connection` (connectivity check).
Maaier stuurt AES-versleutelde MQTT berichten, charger stuurt plain JSON.

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

4. **AES decryptie** — Maaier stuurt AES-versleutelde MQTT berichten. Key `1234123412ABCDEF`
   uit APK werkt niet. 4300+ key/IV/mode combinaties getest, allemaal mislukt.
   Key is runtime-derived. Decryptie-hook aanwezig in `broker.ts` voor toekomstig gebruik.

**Resultaat**: Maaier succesvol toegevoegd via lokale server na fixes 1-3.
Maaier-berichten worden als encrypted bytes doorgestuurd naar de app (die ze zelf decrypteert).
