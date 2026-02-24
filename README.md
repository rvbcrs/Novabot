# Novabot Local Server — Setup Guide

Vervangt de Novabot cloud (app.lfibot.com / mqtt.lfibot.com) met een lokale server,
zodat de Novabot app en apparaten volledig op je eigen netwerk werken.

Inclusief Home Assistant integratie met automatische sensor-discovery.

---

## Architectuur

```
Novabot App (iOS/Android)
        |  HTTPS :443
        v
Nginx Proxy Manager          <-- TLS terminatie, wildcard cert *.lfibot.com
        |  HTTP :3000
        v
Node.js Express Server       <-- REST API (alle /api/* endpoints)
        +
Aedes MQTT Broker :1883      <-- MQTT voor app <-> apparaat communicatie
        |
        +----> HA MQTT Bridge ----> Home Assistant Mosquitto :1883
        |                           (auto-discovery sensoren)
        ^                ^
        | MQTT :1883     | MQTT :1883
Laadstation (ESP32)    Maaier (ESP32)
   plain JSON         AES-128-CBC
```

DNS rewrite (kies een van de opties):
- Router DNS rewrite: `app.lfibot.com` + `mqtt.lfibot.com` -> Mac IP
- AdGuard Home / Pi-hole DNS rewrite
- **novabot-dns** Docker container (zie Stap 5)

---

## Vereisten

| Software | Versie | Waarvoor |
|----------|--------|----------|
| Node.js  | >= 20  | Express server + MQTT broker |
| npm      | >= 10  | Packages installeren |
| openssl  | any    | Certificaten aanmaken |
| Nginx Proxy Manager | any | HTTPS/TLS termination |
| Docker (optioneel) | any | novabot-dns container of NPM |

Nginx Proxy Manager draait het makkelijkst als Docker container:
```bash
# docker-compose.yml voor NPM
version: '3'
services:
  npm:
    image: jc21/nginx-proxy-manager:latest
    ports:
      - "80:80"
      - "443:443"
      - "81:81"   # NPM admin UI
    volumes:
      - ./npm/data:/data
      - ./npm/letsencrypt:/etc/letsencrypt
```

---

## Stap 1 — Repository opzetten

```bash
git clone <repo-url>
cd Novabot/novabot-server
npm install
```

---

## Stap 2 — Omgevingsvariabelen (.env)

Maak `novabot-server/.env` aan (of pas de bestaande aan):

```env
# Node.js luistert op HTTP — TLS via nginx proxy manager
PORT=3000

# Sterke random string, minimaal 32 tekens
JWT_SECRET=verander_dit_naar_een_lange_willekeurige_string_hier

# SQLite database locatie
DB_PATH=./novabot.db

# Opslag voor kaartbestanden en app-logs
STORAGE_PATH=./storage

# ── Home Assistant MQTT Bridge (optioneel) ────────────────────
# Uncomment en configureer om sensordata door te sturen naar HA
# HA_MQTT_HOST=192.168.1.50
# HA_MQTT_PORT=1883
# HA_MQTT_USER=novabot
# HA_MQTT_PASS=novabot
# HA_THROTTLE_MS=2000
# HA_DISCOVERY_PREFIX=homeassistant
```

Genereer een goede JWT_SECRET:
```bash
openssl rand -hex 32
```

---

## Stap 3 — SSL-certificaat aanmaken

Het certificaat is geldig voor `app.lfibot.com` en `*.lfibot.com` (10 jaar).
Een eigen CA wordt aangemaakt die we op de telefoon installeren.

```bash
cd novabot-server
bash scripts/generate-certs.sh
```

Output in `novabot-server/certs/`:
| Bestand | Gebruik |
|---------|---------|
| `ca.crt` | installeren op telefoon als vertrouwde CA |
| `fullchain.pem` | uploaden in Nginx Proxy Manager als "Certificate" |
| `server.key` | uploaden in Nginx Proxy Manager als "Private Key" |

### CA installeren op Android

1. Kopieer `ca.crt` naar de telefoon (AirDrop, USB, of email)
2. Instellingen -> Beveiliging -> Encryptie & referenties -> CA-certificaat installeren
3. Kies het `ca.crt` bestand
4. Bevestig de waarschuwing

**Let op:** Schakel Android Private DNS uit (Instellingen -> Netwerk -> Prive-DNS -> Uit),
anders wordt de router DNS bypass en werken de DNS rewrites niet.

### CA installeren op iOS

1. Mail `ca.crt` naar jezelf en open het op de iPhone
2. Instellingen -> Profiel gedownload -> Installeer
3. Instellingen -> Algemeen -> Info -> Certificaatvertrouwensinstellingen
4. Zet de schakelaar aan bij "Novabot Local CA"

### App op macOS (Apple Silicon)

De iOS Novabot app (v2.3.9) kan ook op een Mac met Apple Silicon draaien.
Installeer `ca.crt` in de Sleutelhangertoegang en vertrouw het:
```bash
security add-trusted-cert -r trustRoot \
  -k ~/Library/Keychains/login.keychain-db \
  novabot-server/certs/ca.crt
```

---

## Stap 4 — Nginx Proxy Manager configureren

1. Open NPM admin UI op `http://<mac-ip>:81`
2. Ga naar **SSL Certificates** -> **Add SSL Certificate** -> **Custom**
3. Upload:
   - Certificate (PEM): `certs/fullchain.pem`
   - Private Key (PEM): `certs/server.key`
4. Ga naar **Proxy Hosts** -> **Add Proxy Host**:
   - Domain name: `app.lfibot.com`
   - Scheme: `http`
   - Forward Hostname/IP: `127.0.0.1` (of Mac IP)
   - Forward Port: `3000`
   - SSL: kies het zojuist geuploade certificaat
   - Vink aan: "Force SSL", "HTTP/2 Support"

---

## Stap 5 — DNS rewrites

Beide domeinen moeten naar het Mac IP wijzen **voor alle apparaten op het netwerk**
(telefoon, laadstation, maaier). Dit moet op netwerkniveau, niet alleen in `/etc/hosts`.

### Optie A — Router DNS (UniFi / FritzBox / OpenWrt)

**UniFi Network:**
Instellingen -> Networks -> Local DNS -> voeg toe:
```
app.lfibot.com   ->  <mac-ip>     (bijv. 192.168.1.50)
mqtt.lfibot.com  ->  <mac-ip>
```

**FritzBox:**
Heimnetz -> Netzwerk -> DNS-Rebind-Schutz uitschakelen voor lfibot.com,
daarna in Heimnetz -> Netzwerk -> DNS host overschrijvingen toevoegen.

**OpenWrt:**
```
# /etc/config/dhcp
config domain
    option name 'app.lfibot.com'
    option ip '192.168.1.50'

config domain
    option name 'mqtt.lfibot.com'
    option ip '192.168.1.50'
```

### Optie B — AdGuard Home / Pi-hole

**AdGuard Home:**
Filters -> DNS rewrites -> Toevoegen:
```
app.lfibot.com   ->  192.168.1.50
mqtt.lfibot.com  ->  192.168.1.50
```

**Pi-hole:**
Local DNS -> DNS Records:
```
app.lfibot.com   ->  192.168.1.50
mqtt.lfibot.com  ->  192.168.1.50
```

### Optie C — novabot-dns Docker container

Een zelfstandige DNS-server als Docker container (Alpine + dnsmasq, ~8MB).
Handig als je geen router-toegang hebt of een aparte DNS wilt.

```bash
cd novabot-dns

# Pas TARGET_IP aan naar je Mac IP in docker-compose.yml
docker compose up -d
```

`docker-compose.yml`:
```yaml
services:
  novabot-dns:
    build: .
    container_name: novabot-dns
    restart: unless-stopped
    ports:
      - "53:53/udp"
      - "53:53/tcp"
    environment:
      TARGET_IP: 192.168.1.50    # <-- jouw Mac IP
      UPSTREAM_DNS: 8.8.8.8      # upstream voor overige domeinen
```

Stel vervolgens op je router DHCP de DNS-server in op het IP waar deze container draait.
Alle `*.lfibot.com` queries worden dan naar `TARGET_IP` gestuurd; overige queries gaan
naar de upstream DNS.

### DNS rewrite controleren

```bash
# Vanaf een apparaat op het netwerk:
nslookup app.lfibot.com
# Moet jouw Mac IP teruggeven, niet een extern IP

nslookup mqtt.lfibot.com
# Zelfde
```

---

## Stap 6 — macOS firewall (poorten openzetten)

macOS vraagt bij de eerste keer of Node.js inkomende verbindingen mag accepteren.
Klik **Toestaan** wanneer dit dialoogvenster verschijnt. Als je eerder Weigeren hebt geklikt:

```bash
# Controleer huidige status
/usr/libexec/ApplicationFirewall/socketfilterfw --getblockall

# Voeg node toe aan de allowlist
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which node)
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp $(which node)
```

Of via Systeeminstellingen -> Netwerk -> Firewall -> Opties -> voeg `node` toe.

**Benodigde poorten:**
| Poort | Protocol | Gebruik |
|-------|----------|---------|
| 3000  | TCP | Node.js HTTP (intern, alleen vanuit nginx) |
| 1883  | TCP | MQTT broker (apparaten + app) |
| 80    | TCP | nginx HTTP (redirect naar 443) |
| 443   | TCP | nginx HTTPS (app API calls) |

---

## Stap 7 — Server starten

### Development (met auto-reload)
```bash
cd novabot-server
npm run dev
```

### Productie
```bash
cd novabot-server
npm run build
npm start
```

Verwachte output bij opstarten:
```
[DB] Database initialised
[MQTT] Broker luistert op port 1883
[HA-MQTT] Verbonden met HA Mosquitto op mqtt://192.168.1.50:1883
[SERVER] HTTP listening on port 3000
[SERVER] Verwacht nginx proxy manager voor TLS termination op app.lfibot.com
```

---

## Stap 8 — Eerste gebruikersaccount aanmaken

De app heeft een account nodig. Registreer via curl of de app zelf.

### Via curl (aanbevolen voor eerste setup):
```bash
curl -k -X POST https://app.lfibot.com/api/nova-user/appUser/regist \
  -H "Content-Type: application/json" \
  -d '{"email":"jouw@email.nl","password":"jouwwachtwoord"}'
```

### Via de app:
Open de Novabot app -> Account aanmaken -> voer e-mail en wachtwoord in.
De verificatiecode verschijnt in de server console:
```
[VALIDATE] Register code for jouw@email.nl: 123456
```

---

## Stap 9 — MAC-adressen registreren (optioneel, versnelt setup)

Als je de BLE manufacturer data hebt uitgelezen met nRF Connect, kun je de MAC-adressen
alvast registreren zodat de app ze direct herkent bij BLE scan:

```bash
# Laadstation (BLE MAC)
curl -X POST http://localhost:3000/api/admin/devices/LFIC1230700004/mac \
  -H "Content-Type: application/json" \
  -d '{"macAddress":"48:27:E2:1B:A4:0A"}'

# Maaier (BLE MAC)
curl -X POST http://localhost:3000/api/admin/devices/LFIN2230700238/mac \
  -H "Content-Type: application/json" \
  -d '{"macAddress":"50:41:1C:39:BD:C1"}'
```

**Let op:** Gebruik het **BLE MAC-adres** (niet WiFi STA). De app matcht apparaten
op basis van BLE manufacturer data. WiFi STA MAC = BLE MAC - 2.

Alternatiref worden MAC-adressen automatisch geleerd zodra apparaten via MQTT verbinden.

---

## Stap 10 — Apparaten toevoegen in de app

1. Open de Novabot app en log in
2. Ga naar **Apparaat toevoegen** -> **Laadstation toevoegen**
3. Voer het serienummer in (bijv. `LFIC1230700004`)
4. Voer je WiFi-netwerknaam en wachtwoord in (alleen 2.4 GHz!)
5. Ga naar het laadstation toe — de app verbindt via BLE
6. Wacht tot WiFi en GPS als "Sterk" worden weergegeven
7. Tik op **Volgende** — de app configureert het laadstation via BLE

**Let op:** Zorg dat het laadstation verbonden is met een **2.4 GHz** netwerk.
De ESP32 in het laadstation ondersteunt geen 5 GHz WiFi.

---

## Home Assistant integratie

De server kan sensordata automatisch doorsturen naar Home Assistant via MQTT auto-discovery.
Sensoren verschijnen automatisch in HA zodra apparaten data versturen.

### Configuratie

Stel in `novabot-server/.env` de HA Mosquitto verbinding in:

```env
HA_MQTT_HOST=192.168.1.50      # IP van je Home Assistant / Mosquitto broker
HA_MQTT_PORT=1883
HA_MQTT_USER=novabot            # Mosquitto gebruiker
HA_MQTT_PASS=novabot            # Mosquitto wachtwoord
HA_THROTTLE_MS=2000             # Minimale interval tussen updates (ms)
HA_DISCOVERY_PREFIX=homeassistant
```

Zorg dat in Home Assistant de **Mosquitto broker** add-on draait en een gebruiker
`novabot` is aangemaakt (of gebruik een bestaande MQTT-gebruiker).

### Wat verschijnt er in HA?

Na het (her)starten van de server verschijnen er twee apparaten in HA:

**Novabot Charger** (uit `up_status_info`, plain JSON):
| Sensor | Beschrijving |
|--------|-------------|
| Charger Status | Idle / Operational |
| Mower Status | Returning to charger / Mowing / etc. |
| Battery | Batterij percentage (%) |
| LoRa Search Count | Teller voor LoRa zoekpogingen naar maaier |
| Work Mode / State / Status | Werkmodus en -status |
| Mowing Progress | Maaivoortgang (%) |
| Error Code / Message | Foutinformatie |
| Mower Position X/Y/Z | Positie (via charger LoRa) |
| Online | Verbindingsstatus |

**Novabot Mower** (uit AES-ontsleutelde berichten):
| Sensor | Beschrijving |
|--------|-------------|
| Battery | Batterij percentage (%) |
| Battery State | Charging / Not charging / Discharging |
| CPU Temperature | Processor temperatuur (C) |
| WiFi Signal | WiFi signaalsterkte (dBm) |
| RTK Satellites | Aantal GPS/RTK satellieten |
| Firmware Version | Huidige firmware versie |
| Location Quality | Lokalisatiekwaliteit (%) |
| Localization | Not initialized / Initializing / Initialized |
| Blade Work Time | Totale maaiblad-werktijd (sec) |
| Mow Speed | Huidige maaisnelheid |
| Covering / Finished Area | Oppervlakte dekkingsinfo |
| Position X/Y/Z | Maaier positie |
| Emergency Stop | Noodstop ingedrukt (binary sensor) |
| Chassis Error | Chassis foutcode |
| Online | Verbindingsstatus |

### MQTT topics

| Topic | Inhoud |
|-------|--------|
| `novabot/<SN>/<veld>` | Individuele sensorwaarde (retained) |
| `novabot/<SN>/availability` | `online` / `offline` (retained) |
| `novabot/<SN>/raw/<command>` | Volledige JSON payload (retained) |
| `novabot/bridge/status` | Bridge status + LWT (retained) |
| `homeassistant/sensor/novabot_<SN>_<veld>/config` | Auto-discovery config |
| `homeassistant/binary_sensor/novabot_<SN>_*/config` | Binary sensor discovery |

### Maaier AES-128-CBC decryptie

De maaier versleutelt alle MQTT berichten met AES-128-CBC.
De server ontsleutelt deze automatisch voordat ze naar HA worden doorgestuurd.

| Eigenschap | Waarde |
|------------|--------|
| Algoritme | AES-128-CBC |
| Key | `"abcdabcd1234" + SN[-4:]` (bijv. `abcdabcd12340238`) |
| IV | `abcd1234abcd1234` (statisch) |
| Padding | Null-byte padding naar 64-byte grens |

De charger stuurt plain JSON — daar is geen decryptie nodig.

---

## Diagnostiek

### Server logs begrijpen

| Log prefix | Betekenis |
|------------|-----------|
| `[MQTT] CONNECT DEV clientId="ESP32_1bA408"` | Laadstation verbonden |
| `[MQTT] CONNECT DEV clientId="LFIN2230700238_6688"` | Maaier verbonden |
| `[MQTT] CONNECT APP clientId="<uuid>"` | App verbonden |
| `[MQTT] SUBSCRIBE X -> [Dart/Send_mqtt/LFIC...]` | Apparaat luistert naar commando's |
| `[MQTT] PUBLISH X ->DEV Dart/Send_mqtt/...` | App stuurt commando naar apparaat |
| `[MQTT] PUBLISH X <-DEV Dart/Receive_mqtt/...` | Apparaat reageert |
| `[MQTT] PUBLISH ... [AES] {...}` | Ontsleuteld maaier-bericht |
| `[MQTT] PUBLISH ... [encrypted 800B]` | Niet-ontsleuteld bericht (fout) |
| `[HA-MQTT] Verbonden met HA Mosquitto` | HA bridge actief |
| `[HA-MQTT] LFIN2230700238 -> online` | Apparaat online in HA |
| `[REQ] POST /api/...` | HTTP verzoek van de app |
| `[UNKNOWN] POST /api/...` | Nog niet geimplementeerd endpoint |

### Alle verbonden apparaten bekijken

```bash
curl http://localhost:3000/api/admin/devices | python3 -m json.tool
```

### DNS werkt niet?

```bash
# Test vanaf Mac zelf
curl -v https://app.lfibot.com/api/nova-user/appUser/login \
  --cacert novabot-server/certs/ca.crt \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"test@test.nl","password":"test"}'
```

### MQTT bereikbaar?

```bash
# Test MQTT verbinding (installeer mosquitto-clients als nodig)
brew install mosquitto
mosquitto_pub -h mqtt.lfibot.com -p 1883 -t test -m "hello"
```

### Apparaat verschijnt niet in MQTT logs?

Mogelijke oorzaken:
1. **DNS rewrite werkt niet** voor het apparaat — controleer of `nslookup mqtt.lfibot.com` het juiste IP geeft
2. **macOS firewall** blokkeert poort 1883 — zie Stap 6
3. **5 GHz WiFi** — het apparaat kan alleen verbinden met 2.4 GHz netwerken
4. **Verkeerd WiFi-wachtwoord** tijdens provisioning
5. **Android Private DNS** — schakelt DNS rewrites uit (zie Stap 3)

### HA sensoren verschijnen niet?

1. Controleer of `HA_MQTT_HOST` correct is in `.env`
2. Controleer de server logs voor `[HA-MQTT] Verbonden met HA Mosquitto`
3. Sensoren verschijnen pas als een apparaat daadwerkelijk data stuurt (lazy discovery)
4. Controleer in HA: Instellingen -> Apparaten -> zoek "Novabot"

---

## Apparaten referentie

### Laadstation (Charger / Base Station) — Novabot N2000
| Eigenschap | Waarde |
|------------|--------|
| Serienummer | `LFIC1230700004` |
| MQTT clientId | `ESP32_1bA408` |
| MQTT username | `LFIC1230700004` |
| BLE naam | `CHARGER_PILE` |
| BLE MAC | `48:27:E2:1B:A4:0A` |
| WiFi AP MAC | `48:27:E2:1B:A4:09` (BLE-1) |
| WiFi STA MAC | `48:27:E2:1B:A4:08` (BLE-2) |
| Hardware | ESP32-S3-WROOM, 8MB flash, UM960 RTK GPS |
| Firmware | v0.3.6 (actief) / v0.4.0 (inactief) |
| MQTT data | Plain JSON (`up_status_info`) |

### Maaier (Mower) — Novabot N2000
| Eigenschap | Waarde |
|------------|--------|
| Serienummer | `LFIN2230700238` |
| MQTT clientId | `LFIN2230700238_6688` |
| MQTT username | `LFIN2230700238` |
| BLE naam | `Novabot` |
| BLE MAC | `50:41:1C:39:BD:C1` |
| WiFi STA MAC | `50:41:1C:39:BD:BF` (BLE-2) |
| Firmware | v0.3.25 |
| MQTT data | AES-128-CBC versleuteld |

### ESP32 MAC-adres patroon
ESP32 wijst MAC-adressen opeenvolgend toe:
- WiFi STA = basis MAC (verbindt met router)
- WiFi AP  = basis MAC + 1
- BLE      = basis MAC + 2

De cloud en onze server retourneren het **BLE MAC** in API responses.
De app matcht dit tegen BLE manufacturer data tijdens scanning.

BLE manufacturer data uitlezen met nRF Connect -> Advertised Data -> Manufacturer Specific Data (0xFF):
```
66 55  XX XX XX XX XX XX  [45 53 50]
 ^^^   ^^^^^^^^^^^^^^^     "ESP"
 ESP    BLE MAC adres
company ID (0x5566)
```

---

## Bestandsstructuur

```
Novabot/
├── novabot-server/                  De lokale vervangingsserver
│   ├── src/
│   │   ├── index.ts                 Entry point (Express + MQTT)
│   │   ├── db/database.ts           SQLite schema + migraties
│   │   ├── types/index.ts           TypeScript interfaces
│   │   ├── middleware/auth.ts       JWT authenticatie
│   │   ├── mqtt/
│   │   │   ├── broker.ts            Aedes MQTT broker (poort 1883)
│   │   │   ├── decrypt.ts           AES-128-CBC decryptie maaier
│   │   │   └── homeassistant.ts     HA MQTT bridge + auto-discovery
│   │   ├── proxy/
│   │   │   ├── httpProxy.ts         HTTP proxy naar cloud (PROXY_MODE=cloud)
│   │   │   └── mqttBridge.ts        MQTT bridge naar upstream
│   │   └── routes/
│   │       ├── admin.ts             GET /api/admin/devices
│   │       ├── nova-user/
│   │       │   ├── appUser.ts       Login, registratie, profiel
│   │       │   ├── validate.ts      E-mail verificatiecodes
│   │       │   ├── equipment.ts     Apparaatbeheer
│   │       │   └── otaUpgrade.ts    OTA versie check
│   │       ├── nova-data/
│   │       │   └── cutGrassPlan.ts  Maaischema's
│   │       ├── nova-file-server/
│   │       │   ├── map.ts           Kaartbestanden
│   │       │   └── log.ts           App logbestanden
│   │       ├── nova-network/
│   │       │   └── network.ts       Connectivity check
│   │       └── novabot-message/
│   │           └── message.ts       Robot- en werkberichten
│   ├── certs/                       SSL certificaten
│   │   ├── ca.crt                   CA cert -> telefoon installeren
│   │   ├── fullchain.pem            -> Nginx Proxy Manager
│   │   └── server.key               -> Nginx Proxy Manager
│   ├── scripts/
│   │   └── generate-certs.sh        Certificaat generator
│   ├── captured/                    MQTT traffic captures (.bin)
│   ├── storage/                     Kaarten en logs (auto-aangemaakt)
│   ├── novabot.db                   SQLite database
│   ├── .env                         Omgevingsvariabelen
│   └── package.json
│
├── novabot-dns/                     DNS rewrite Docker container
│   ├── Dockerfile                   Alpine + dnsmasq (~8MB image)
│   ├── entrypoint.sh                Genereert dnsmasq.conf
│   └── docker-compose.yml           TARGET_IP + UPSTREAM_DNS config
│
├── NOVABOT_2.3.8_APKPure/           Gededisassembleerde APK (apktool)
├── blutter_output/                  Blutter decompilatie v2.3.8
├── blutter_output_v2.4.0/           Blutter decompilatie v2.4.0
├── NOVABOT_2.4.0_arm64/             Uitgepakte v2.4.0 APK
├── charger_firmware_2.bin           ESP32-S3 flash dump (8MB)
└── CLAUDE.md                        Uitgebreide reverse engineering docs
```

---

## Opnieuw beginnen (factory reset van de DB)

```bash
cd novabot-server
rm novabot.db novabot.db-shm novabot.db-wal
npm run dev   # maakt automatisch een nieuw schema aan
```

---

## Technische details

- **App**: Novabot v2.3.9 (iOS) / v2.4.0 (Android), Flutter/Dart
- **Model**: Novabot N2000
- **API base**: `https://app.lfibot.com` -> nginx -> Node.js :3000
- **MQTT**: `mqtt.lfibot.com:1883` -> direct naar aedes :1883 (geen TLS)
- **Apparaten**: ESP32-S3, verbinden via 2.4 GHz WiFi, gebruiken MQTT voor telemetrie
- **Provisioning**: BLE GATT, commando's: `set_wifi_info`, `set_mqtt_info`, `set_lora_info`, `set_rtk_info`
- **Auth**: JWT tokens, 7 dagen geldig
- **Database**: better-sqlite3 (synchroon, geen verbindingsbeheer nodig)
- **Maaier encryptie**: AES-128-CBC, key = `"abcdabcd1234" + SN[-4:]`, IV = `"abcd1234abcd1234"`
- **HA integratie**: MQTT auto-discovery, lazy sensor creation, changed-value filter + throttle
