<\!-- Referentiebestand — gebruik @FIRMWARE-CHARGER.md.md om dit te laden in een sessie -->
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
| `research/charger_ota0_v0.3.6.elf` | ELF voor Ghidra (1.4MB, 6 segments) |
| `research/charger_ota1_v0.4.0.elf` | ELF voor Ghidra (1.4MB, 6 segments) |
| `research/ghidra_output/charger_v036_decompiled.c` | Gedecompileerde C-code v0.3.6 (7.6MB, 296K regels, 7405 functies) |
| `research/ghidra_output/charger_v040_decompiled.c` | Gedecompileerde C-code v0.4.0 (7.6MB) |
| `research/ghidra_output/charger_v036.rep/` | Ghidra project directory v0.3.6 |
| `research/ghidra_output/charger_v040.rep/` | Ghidra project directory v0.4.0 |

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

### Charger firmware v0.4.0 — verschillen met v0.3.6 (februari 2026)

Firmware v0.4.0 gedecompileerd met Ghidra en vergeleken met v0.3.6. Het enige significante
verschil is de toevoeging van **AES-128-CBC encryptie voor ALLE MQTT berichten**.

**AES encryptie (nieuw in v0.4.0):**
| Eigenschap | Waarde |
|------------|--------|
| Algoritme | AES-128-CBC (zelfde als maaier) |
| Key formule | `"abcdabcd1234" + SN[-4:]` (16 bytes UTF-8) |
| IV | `"abcd1234abcd1234"` (statisch) |
| Padding | Null-byte padding naar 16-byte grens (niet PKCS7) |
| Richting | **Beide**: publish (encrypt) EN subscribe (decrypt) |
| Firmware string | `abcdabcd12341234abcdabcd12341234` op offset 0x23b600 |

**MQTT_EVENT_DATA handler** (decompilatie regel 34106-34143):
1. Check `mqtt_rec_data_flag` — als al 1, skip (vorig bericht nog niet verwerkt)
2. Lengte validatie: `>0`, `<1024`, `%16==0` (AES blokgrootte check)
3. AES-128-CBC decrypt met key `"abcdabcd1234" + SN[-4:]`
4. Zet `mqtt_rec_data_flag = 1` en signal FreeRTOS queue

**Commando verwerking — cJSON_IsNull check (KRITISCH):**

De command processor (`FUN_4200e8c4`, regels 34234-34548) gebruikt `PTR_FUN_420013d4`
(waarschijnlijk `cJSON_IsNull`) om de waarde van bepaalde commando-keys te valideren:

```c
// get_lora_info handler (regel 34524-34542):
iVar4 = cJSON_GetObjectItem(root, "get_lora_info");
if (iVar4 != NULL) {
    iVar4 = cJSON_IsNull(iVar4);    // PTR_FUN_420013d4
    if (iVar4 == 1) {                // Alleen als waarde NULL is
        printf("get_lora_info null");
        // Build en publish LoRa info response
        goto publish_response;
    }
}

// ota_version_info handler (regel 34509-34522):
iVar4 = cJSON_GetObjectItem(root, "ota_version_info");
if (iVar4 != NULL) {
    iVar4 = cJSON_IsNull(iVar4);     // Zelfde check
    if (iVar4 == 1) {
        printf("ota_version_info null");
        // Build en publish versie info response
    }
}
```

**Impact**: v0.4.0 firmware verwacht `{"get_lora_info":null}` (cJSON NULL type),
NIET `{"get_lora_info":0}` (cJSON Number type). Bij een verkeerde waarde retourneert
`cJSON_IsNull` 0 en wordt de handler overgeslagen — geen response, geen error log.

**Commando's die NULL waarde verwachten:**
- `get_lora_info` → `get_lora_info_respond`
- `ota_version_info` → `ota_version_info_respond`

**Commando's die een object/string waarde verwachten:**
- `ota_upgrade_cmd` → parst `downloadUrl`, `md5`, `version` als strings (cJSON_IsString)

**Correcte commando-syntax voor v0.4.0:**
```json
{"get_lora_info": null}
{"ota_version_info": null}
{"ota_upgrade_cmd": {"type":"full","content":{"upgradeApp":{"version":"...","downloadUrl":"...","md5":"..."}}}}
```

**PUBACK bevestiging**: ESP-IDF MQTT client stuurt PUBACK (`40 02 00 01`) terug voor QoS 1
PUBLISH packets, wat bevestigt dat de charger het bericht ontvangt en parst. Het probleem
zit puur in de cJSON waarde-validatie, niet in de MQTT transport laag.

### Aedes MQTT broker patches (broker.ts)

De broker heeft meerdere patches om compatibel te zijn met ESP32/app MQTT clients:

**1. sanitizeConnectFlags** — Fix voor app MQTT CONNECT bug (Will QoS met Will Flag=0).

**2. CONNACK suppression** — Aedes stuurt een CONNACK maar wij sturen ook een eigen CONNACK
(met returnCode=0) voordat aedes de connectie verwerkt. Aedes schrijft in **1-byte chunks**,
dus de oorspronkelijke check `buf.length >= 2 && buf[0] === 0x20` faalde altijd.
Fix: byte-counting aanpak die exact 4 bytes (CONNACK = `0x20 0x02 0x00 0x00`) opslurpt
ongeacht chunking.

**3. Raw TCP infrastructure** — `writeRawPublish()` functie + `rawSocketBySn` Map voor het
direct schrijven van MQTT PUBLISH packets naar device TCP sockets, aedes volledig omzeilend.
Gebruikt voor debugging en voor het sturen van AES-encrypted commando's naar de charger.
Endpoint: `POST /api/dashboard/raw-tcp/:sn` met `{"command":{...}, "qos":0|1}`.

**4. RAW-IN data tap** — Socket.emit override die ALLE inkomende bytes van apparaten
logt vóór aedes-verwerking: packet type, grootte, hex dump. Detecteert SUBSCRIBE,
PUBLISH, PUBACK, PINGREQ, etc.

---

