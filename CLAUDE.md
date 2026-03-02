# Novabot — Lokale cloud vervanging voor robotmaaier + laadstation

De Novabot app (Flutter/Dart, v2.3.8/v2.4.0 Android, v2.3.9 iOS) praat met onze lokale server
i.p.v. `app.lfibot.com` / `mqtt.lfibot.com`, zodat maaier en laadstation volledig offline werken.

## Gebruikersregels (ALTIJD volgen)
- **DNS werkt prima** — nooit suggereren dat DNS redirect niet werkt. Setup is stabiel.
- **Firewall staat UIT** — nooit suggereren dat macOS firewall poort 1883 blokkeert.
- **GEEN shortcuts/hacks** — geen handmatige DB inserts als workaround. Server moet cloud flow exact nabouwen voor hergebruik door anderen.
- **ALLEEN cloud API kopie** — geen BLE vanuit server, geen UART. Maaier komt online via normale app flow.

---

## Bekende apparaten

| Apparaat | SN | IP | MQTT clientId |
|----------|----|----|---------------|
| Laadstation | `LFIC1230700004` | — | `ESP32_1bA408` |
| Reserve charger board | `LFIC2230700017` | `192.168.2.2` | `ESP32_1bA3D0` |
| Maaier | `LFIN2230700238` | `192.168.0.244` | `LFIN2230700238_6688` |

SSH maaier: `sshpass -p 'novabot' ssh root@192.168.0.244`

| Apparaat | BLE MAC | BLE naam | MQTT credentials |
|----------|---------|----------|-----------------|
| Charger | `48:27:E2:1B:A4:0A` | `CHARGER_PILE` | user=`li9hep19` pass=`jzd4wac6` |
| Maaier | `50:41:1C:39:BD:C1` | `Novabot` | user=null pass=null |

ESP32 MAC patroon: WiFi STA = basis, WiFi AP = basis+1, BLE = basis+2

---

## AES Encryptie (alle LFI* apparaten, v0.4.0 charger + v6+ maaier)

```
Algoritme : AES-128-CBC
Key       : "abcdabcd1234" + SN[-4:]   (bijv. "abcdabcd12340238" voor LFIN...0238)
IV        : "abcd1234abcd1234"  (statisch)
Padding   : null-bytes naar 16-byte grens (GEEN PKCS7)
```

`publishToDevice()` in `mapSync.ts` versleutelt automatisch voor alle `LFI*` SNs.

---

## MQTT Topics

| Richting | Topic |
|----------|-------|
| App/server → Apparaat | `Dart/Send_mqtt/<SN>` |
| Apparaat → App | `Dart/Receive_mqtt/<SN>` |
| Maaier → Server (alleen) | `Dart/Receive_server_mqtt/<SN>` |

Broker: aedes op `0.0.0.0:1883`. DNS: `mqtt.lfibot.com` + `nova-mqtt.ramonvanbruggen.nl` → Mac IP.

---

## Server architectuur (`novabot-server/src/`)

| Bestand | Functie |
|---------|---------|
| `index.ts` | Entry point (Express + Socket.io + MQTT) |
| `db/database.ts` | SQLite schema + initDb() |
| `mqtt/broker.ts` | Aedes broker, sanitizeConnectFlags, CONNACK fix, raw TCP, **OTA interceptie** |
| `mqtt/decrypt.ts` | AES-128-CBC decryptie maaier berichten |
| `mqtt/mapSync.ts` | publishToDevice(), publishRawToDevice(), onMowerConnected() |
| `mqtt/sensorData.ts` | Sensor definities + data cache |
| `mqtt/mapConverter.ts` | GPS ↔ lokale coördinaten + ZIP formaat |
| `dashboard/socketHandler.ts` | Socket.io real-time updates |
| `routes/nova-user/equipment.ts` | bindingEquipment, getEquipmentBySN, rowToCloudDto() |
| `routes/nova-user/otaUpgrade.ts` | checkOtaNewVersion |
| `routes/dashboard.ts` | Dashboard REST + OTA trigger + firmware serving |

Dashboard: `novabot-dashboard/src/` (React + Vite + Tailwind + Leaflet)

---

## Database tabellen

| Tabel | Doel |
|-------|------|
| `users` | Accounts (email, bcrypt password) |
| `equipment` | Gekoppelde apparaten (mower_sn PK, charger_sn, mac_address, user_id) |
| `device_registry` | Automatisch geleerd via MQTT CONNECT |
| `maps` | Kaartpolygonen per maaier |
| `map_calibration` | Offset/rotatie/schaal per maaier |
| `dashboard_schedules` | Maaischema's (CRUD + MQTT push) |
| `ota_versions` | OTA firmware versies + download URLs |
| `equipment_lora_cache` | LoRa params bewaren na unbind |
| `cut_grass_plans` | Maaischema's (app-zijde) |
| `work_records` | Maaihistorie |

DB locatie: `novabot-server/novabot.db`

---

## Kritieke implementatiedetails

**rowToCloudDto() in equipment.ts:**
- `chargerAddress/chargerChannel`: charger → 718/16, maaier → altijd `null`
- `userId`: 0 als `user_id = NULL` in DB (→ app doet BLE provisioning)
- `sysVersion`: charger → `charger_version`, maaier → `mower_version`
- `account/password`: charger → `li9hep19`/`jzd4wac6`, maaier → `null`/`null`

**onMowerConnected() in mapSync.ts:**
- Wacht 3s dan stuurt: `ota_version_info: null` + `get_map_list`
- **GEEN `set_cfg_info` (timezone)** — veroorzaakt OTA bug (zie hieronder)

**OTA — KRITIEK (bewezen werkend 2 maart 2026):**
- `checkOtaNewVersion` MOET `upgradeFlag: 1` retourneren als er een update is
- Download URLs MOETEN `http://` zijn (geen TLS)
- **BROKER-LEVEL OTA FIX in `broker.ts` (`authorizePublish`):**
  - mqtt_node op de maaier verandert `type:"full"` → `type:"increment"` als er een `tz` veld in het commando zit
  - De Novabot app stuurt ALTIJD `tz:"Europe/Amsterdam"` mee in `ota_upgrade_cmd`
  - mqtt_node pakt die tz uit het commando en schrijft naar `/userdata/ota/novabot_timezone.txt`
  - Met `type:"increment"` start ota_client GEEN volledige firmware download
  - **FIX**: broker intercepteert app→maaier berichten, decrypteert, verwijdert `tz`, zet `type:"full"`, herversleutelt
  - **NOOIT VERWIJDEREN** — zonder deze fix werkt OTA niet via de app
- OTA trigger endpoint: `POST /api/dashboard/ota/trigger/:sn` met `{version_id, force?}`

**saveCutGrassRecord**: retourneert `ok(null)` bij lege/onparseerbare body (maaier stuurt multipart → retry loop anders).

---

## Development

```bash
cd novabot-server && npm run dev          # Server (tsx watch, port 3000)
cd novabot-dashboard && npm run dev       # Dashboard (Vite, port 5173)
npx tsc --noEmit                          # TypeScript check (vanuit novabot-server/)
```

Firmware: `research/firmware/` — mower custom builds via `research/build_custom_firmware.sh`
Maaier firmware versie: `v6.0.2-custom-5` (OTA via app geslaagd 2 maart 2026)

---

## Referentiebestanden (laden met @BESTANDSNAAM.md)

| Bestand | Inhoud |
|---------|--------|
| `@MQTT.md` | Volledig MQTT commando protocol, status reports, payload velden, charger_status bitfield |
| `@BLE.md` | BLE provisioning protocol, exacte payloads, charger + maaier flows |
| `@API.md` | Alle cloud + admin + dashboard API endpoints |
| `@FIRMWARE-CHARGER.md` | Charger ESP32-S3 analyse, LoRa protocol, Ghidra decompilatie, v0.4.0 |
| `@FIRMWARE-MOWER.md` | Maaier ROS 2 analyse, AI perceptie, camera systeem, netwerk services |
| `@MAP-SYNC.md` | Kaart synchronisatie, CSV/ZIP formaat, StartCoverageTask, maaier HTTP uploads |
| `@OTA.md` | OTA firmware protocol, custom firmware builder, open issues/TODO |
| `@APP-ANALYSIS.md` | APK/blutter analyse, AES key derivatie, app architectuur, foutmeldingen |
| `@SESSIONS.md` | Gedocumenteerde sessies, provisioning fixes, equipment binding lifecycle |
