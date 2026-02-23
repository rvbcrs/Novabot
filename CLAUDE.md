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
│       ├── mqtt/broker.ts          Aedes MQTT broker op port 1883
│       └── routes/
│           ├── admin.ts                        GET /api/admin/devices, POST /api/admin/devices/:sn/mac
│           ├── nova-user/appUser.ts            Login, registratie, profiel
│           ├── nova-user/validate.ts           E-mail verificatiecodes
│           ├── nova-user/equipment.ts          Apparaatbeheer (bindingEquipment, getEquipmentBySN, ...)
│           ├── nova-user/otaUpgrade.ts         OTA versie check
│           ├── nova-data/cutGrassPlan.ts       Maaischema's
│           ├── nova-file-server/map.ts         Kaartbestanden (fragmentUpload)
│           ├── nova-file-server/log.ts         App logbestanden
│           └── novabot-message/message.ts      Robot- en werkberichten
├── mqtt_sniffer.py                 Standalone TCP MQTT packet sniffer (diagnostisch)
├── Novabot-Base-Station.pdf        Hardware handleiding laadstation
└── Novabot-Mower.pdf               Hardware handleiding maaier
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

### MQTT cloud credentials (charger, uit getEquipmentBySN response)
- `account`: `li9hep19`
- `password`: `jzd4wac6`

Deze credentials worden door de cloud server teruggegeven in `getEquipmentBySN` en zijn
waarschijnlijk de MQTT username/password die de charger gebruikt bij verbinden met de broker.
Onze lokale broker accepteert alles, dus deze hoeven niet gecheckt te worden.

### Bekende MQTT payload velden (up_status_info van charger)
`charger_status`, `mower_status`, `mower_x`, `mower_y`, `mower_z`, `mower_gps_*`,
`mower_info`, `mower_info1`, `mower_error`

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
Ook: `chargerSn` in `rowToDto` gebruikt nu `charger_sn ?? mower_sn` (charger-only binding).

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

## Open issues / TODO

- [ ] Android Private DNS uitschakelen zodat DNS rewrites werken op Android
- [ ] `charger_status` bitfield volledig decoderen tegen Novabot-Base-Station.pdf
- [ ] Maaier provisioning flow documenteren (BLE commando's voor `Novabot` device)
- [ ] Volledige MQTT message structuur documenteren (app→apparaat commando's)
- [ ] Begrijpen wanneer `mower_error` stopt met tellen (maaier verbindt via LoRa)

## Gedocumenteerde provisioning sessie (februari 2025)

Succesvolle end-to-end provisioning gecaptured in:
- `Novabot.pklg` — Apple PacketLogger BLE capture (macOS)
- `COnsoleLog.txt` — MQTT proxy server console output

**Resultaat**: Charger `LFIC1230700004` succesvol geprovisioneerd.
Na provisioning: charger verbindt met MQTT, publiceert `up_status_info`,
`charger_status` verandert van 0 naar operationele waarden,
`mower_error` telt op (charger zoekt maaier via LoRa).
