<\!-- Referentiebestand — gebruik @APP-ANALYSIS.md om dit te laden in een sessie -->

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
| `https://novabot-oss.oss-us-east-1.aliyuncs.com/novabot-file/` | OTA firmware bestanden op Alibaba OSS |
| `https://novabot-oss.oss-accelerate.aliyuncs.com/novabot-file/` | OTA firmware (CDN-versneld, charger downloads) |

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

