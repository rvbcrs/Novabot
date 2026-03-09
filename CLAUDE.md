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

**OTA — KRITIEK (bewezen werkend via APP + DASHBOARD, 2 maart 2026):**
- `checkOtaNewVersion` MOET `upgradeFlag: 1` retourneren als er een update is
- Download URLs MOETEN `http://` zijn (geen TLS)
- **EXACT OTA payload (NOOIT WIJZIGEN):**
  ```json
  {"ota_upgrade_cmd":{"cmd":"upgrade","type":"full","content":"app","url":"http://...","version":"...","md5":"..."}}
  ```
  - `cmd:"upgrade"` — verplicht, mqtt_node negeert commando zonder dit veld
  - `type:"full"` — verplicht, "increment" downloadt niet
  - `content:"app"` — verplicht, mqtt_node negeert commando zonder dit veld
  - **GEEN `tz` veld** — mqtt_node zet anders type:"increment"
- **BROKER-LEVEL OTA FIX in `broker.ts` (`authorizePublish`):**
  - De Novabot app stuurt ALTIJD `tz:"Europe/Amsterdam"` mee in `ota_upgrade_cmd`
  - mqtt_node pakt die tz, schrijft naar timezone file, zet type:"increment"
  - **FIX**: broker intercepteert app→maaier, verwijdert `tz`, zet `type:"full"`, herversleutelt
  - **NOOIT VERWIJDEREN** — zonder deze fix werkt OTA niet via de app
- **Dashboard OTA trigger**: stuurt exact hetzelfde payload als de app (zonder tz)
  - Endpoint: `POST /api/dashboard/ota/trigger/:sn` met `{version_id, force?}`
  - Dashboard dist MOET gerebuild worden na frontend wijzigingen: `cd novabot-dashboard && npm run build`

**BLE Provisioning — VOLLEDIG WERKEND (9 maart 2026):**
- Native BLE via `@stoprocent/noble` in bootstrap wizard (`bootstrap/src/ble.ts`)
- **MQTT redirect via BLE werkt**: `set_mqtt_info` wijzigt `json_config.json` succesvol
- **`result:1` betekent NIET "afgewezen"** — het is "acknowledged/applied" (bewezen: WiFi wachtwoord WEL gewijzigd ondanks result:1)
- **Werkende command sequence** (exact als officiële Novabot app):
  1. `get_signal_info` (handshake, non-fatal)
  2. `set_wifi_info` (mower: `{ap:{ssid,passwd,encrypt:0}}`, charger: `{sta:{...},ap:{...}}`)
  3. `set_lora_info` (`{addr:718, channel:15, hc:20, lc:14}`)
  4. `set_mqtt_info` (`{addr:"<server-ip>", port:1883}`)
  5. `set_cfg_info` (mower: `{cfg_value:1, tz:"Europe/Amsterdam"}`, charger: `1`)
- **`tz` in BLE `set_cfg_info` is VEILIG** — BLE handler schrijft naar json_config.json. De OTA tz-bug is specifiek over MQTT `ota_upgrade_cmd` (ander codepad).
- Mower responses komen op char `0x0011` (writeChar), NIET op `0x0021`
- Frame protocol: `ble_start` → 20-byte JSON chunks (30ms) → `ble_end`
- Novabot company ID: `0x5566` in BLE manufacturer data

**saveCutGrassRecord**: retourneert `ok(null)` bij lege/onparseerbare body (maaier stuurt multipart → retry loop anders).

**queryEquipmentMap — KRITIEK (maart 2026):**
- App v2.4.0 verwacht `data` als `Map<String, dynamic>` (JSON object), NIET base64 of array
- Response: `{ data: { work: [MapEntityItem...], unicom: [...] }, md5, machineExtendedField }`
- `MapEntityItem`: `{ fileName, alias, type, url, fileHash, mapArea, obstacle[] }`
- `mapArea` = GPS coördinaten als JSON string
- `chargingPose` velden (`x`, `y`, `orientation`) moeten **strings** zijn (app doet `double._parse()`)
- `data: null` als geen kaarten → app toont "No map!"
- Kaart-flow is upload-only: maaier→server, app→server. Maaier downloadt NOOIT kaarten.

---

## Development

```bash
cd novabot-server && npm run dev          # Server (tsx watch, port 3000)
cd novabot-dashboard && npm run dev       # Dashboard (Vite, port 5173)
npx tsc --noEmit                          # TypeScript check (vanuit novabot-server/)
docker compose build --no-cache           # Docker rebuild (ALTIJD --no-cache na code wijzigingen)
docker compose down && docker compose up -d  # Container herstarten
```

**Docker belangrijk:**
- `docker compose build` produceert image `novabot-novabot` — gebruik dit, NIET `docker build -t opennovabot .`
- Na source wijzigingen ALTIJD `docker compose build --no-cache` — anders pakt Docker gecachte layers
- Dashboard dist wordt INSIDE de container gebouwd (Dockerfile kopieert src/ en runt `npm run build`)

Firmware: `research/firmware/` — mower custom builds via `research/build_custom_firmware.sh`
Maaier firmware versie: `v6.0.2-custom-5` (OTA via app geslaagd 2 maart 2026)

---

## Hardware Reparatie (bron: `research/NOVABOT Disassembly Guide.pdf`)

Tools: **PH2** Phillips + **T20** Torx schroevendraaier. Oranje schroeven = constructie, blauw = specifieke componenten.

### Hall Sensors — KRITIEK
Alle Hall sensors moeten in de JUISTE RICHTING geplaatst zijn. Verkeerde richting → functie werkt niet.

| Sensor | Locatie | Aantal |
|--------|---------|--------|
| Collision | Binnenklep (6.2) | 4× |
| STOP button | Binnenklep (6.3) | 2× + 2 magneten |
| Liftdetectie | Basis assembly (5.2/5.4) | 3× + 2× |
| **Charge in place** (laadstation) | Charging station binnenin | 1× |

**Laadprobleem → controleer "Charge in place Hall" + magneet aan maaier-onderkant.**

### PCB Connectors (Basis assembly, linker→rechts)
LoRa antenne (links!) — RTK antenne — AI board — Display — Battery Pack (2 kabels!) — Charging port — Rijmotoren L+R — Motor lift — Liftmotor — Maaiermotor — Lift sensor

### LoRa Antenne
Gouden coil spring via **u.FL/IPEX connector**, linkerzijde hoofd-PCB.
Losse connector → LoRa icoon ontbreekt in app. Fix: connector stevig indrukken.

### Waterproofing (ALTIJD controleren na reparatie)
- Afdichtingsring rondom basis moet in groef zitten
- Rubberen hoes maaiermotor moet in groef (sectie 8)
- O-ring rijmotor niet vergeten (sectie 7)

### FPC kabels (camera's, display)
Zwart vergrendelplaatje **omhoog** draaien vóór loskoppelen. Dubbele tape houdt kabels vast.

### Laadstation Binnenin
Charge in place Hall, LoRa antenne, RTK antenne, WiFi/BT antenne, Burn switch (UART flash), Debug serial port.

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
| `@MOWER-INTERNALS.md` | Boot sequence, systemd services, ROS2 nodes, map recognition flow, mqtt_node internals |
| `@SESSIONS.md` | Gedocumenteerde sessies, provisioning fixes, equipment binding lifecycle |
