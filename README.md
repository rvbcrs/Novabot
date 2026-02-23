# Novabot Local Server — Setup Guide

Vervangt de Novabot cloud (app.lfibot.com / mqtt.lfibot.com) met een lokale server,
zodat de Novabot app volledig op je eigen netwerk werkt.

---

## Architectuur

```
Novabot App (iOS/Android)
        │  HTTPS :443
        ▼
Nginx Proxy Manager          ← TLS terminatie, wildcard cert *.lfibot.com
        │  HTTP :3000
        ▼
Node.js Express Server       ← REST API (alle /api/* endpoints)
        +
Aedes MQTT Broker :1883      ← MQTT voor app ↔ apparaat communicatie

        ▲                ▲
        │ MQTT :1883     │ MQTT :1883
Laadstation (ESP32)    Maaier (ESP32)
```

DNS op thuisrouter:
- `app.lfibot.com`  → Mac IP (nginx)
- `mqtt.lfibot.com` → Mac IP (aedes, direct)

---

## Vereisten

| Software | Versie | Waarvoor |
|----------|--------|----------|
| Node.js  | ≥ 20   | Express server + MQTT broker |
| npm      | ≥ 10   | Packages installeren |
| openssl  | any    | Certificaten aanmaken |
| Nginx Proxy Manager | any | HTTPS/TLS termination |

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

Maak `novabot-server/.env` aan (of kopieer de bestaande):

```env
# Node.js luistert op HTTP — TLS via nginx proxy manager
PORT=3000

# Sterke random string, minimaal 32 tekens
JWT_SECRET=verander_dit_naar_een_lange_willekeurige_string_hier

# SQLite database locatie
DB_PATH=./novabot.db

# Opslag voor kaartbestanden en app-logs
STORAGE_PATH=./storage
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
| `ca.crt` | → installeren op telefoon als vertrouwde CA |
| `fullchain.pem` | → uploaden in Nginx Proxy Manager als "Certificate" |
| `server.key` | → uploaden in Nginx Proxy Manager als "Private Key" |

### CA installeren op Android

1. Kopieer `ca.crt` naar de telefoon (AirDrop, USB, of email)
2. Instellingen → Beveiliging → Encryptie & referenties → CA-certificaat installeren
3. Kies het `ca.crt` bestand
4. Bevestig de waarschuwing

### CA installeren op iOS

1. Mail `ca.crt` naar jezelf en open het op de iPhone
2. Instellingen → Profiel gedownload → Installeer
3. Instellingen → Algemeen → Info → Certificaatvertrouwensinstellingen
4. Zet de schakelaar aan bij "Novabot Local CA"

---

## Stap 4 — Nginx Proxy Manager configureren

1. Open NPM admin UI op `http://<mac-ip>:81`
2. Ga naar **SSL Certificates** → **Add SSL Certificate** → **Custom**
3. Upload:
   - Certificate (PEM): `certs/fullchain.pem`
   - Private Key (PEM): `certs/server.key`
4. Ga naar **Proxy Hosts** → **Add Proxy Host**:
   - Domain name: `app.lfibot.com`
   - Scheme: `http`
   - Forward Hostname/IP: `127.0.0.1` (of Mac IP)
   - Forward Port: `3000`
   - SSL: kies het zojuist geüploade certificaat
   - Vink aan: "Force SSL", "HTTP/2 Support"

---

## Stap 5 — DNS rewrites op de router

Beide domeinen moeten naar het Mac IP wijzen **voor alle apparaten op het netwerk**
(telefoon, laadstation, maaier). Dit moet op routerniveau, niet alleen in `/etc/hosts`.

### Optie A — Router DNS (UniFi / FritzBox / OpenWrt)

**UniFi Network:**
Instellingen → Networks → Local DNS → voeg toe:
```
app.lfibot.com   →  <mac-ip>     (bijv. 192.168.1.50)
mqtt.lfibot.com  →  <mac-ip>
```

**FritzBox:**
Heimnetz → Netzwerk → DNS-Rebind-Schutz uitschakelen voor lfibot.com,
daarna in Heimnetz → Netzwerk → DNS host overschrijvingen toevoegen.

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
Filters → DNS rewrites → Toevoegen:
```
app.lfibot.com   →  192.168.1.50
mqtt.lfibot.com  →  192.168.1.50
```

**Pi-hole:**
Local DNS → DNS Records:
```
app.lfibot.com   →  192.168.1.50
mqtt.lfibot.com  →  192.168.1.50
```

### Controleer de DNS rewrite

```bash
# Vanaf telefoon of apparaat op het netwerk:
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

Of via Systeeminstellingen → Netwerk → Firewall → Opties → voeg `node` toe.

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
Open de Novabot app → Account aanmaken → voer e-mail en wachtwoord in.
De verificatiecode verschijnt in de server console:
```
[VALIDATE] Register code for jouw@email.nl: 123456
```

---

## Stap 9 — MAC-adressen registreren (optioneel, versnelt setup)

Als je de BLE manufacturer data hebt uitgelezen met nRF Connect, kun je de MAC-adressen
alvast registreren zodat de app ze direct kent:

```bash
# Laadstation
curl -X POST http://localhost:3000/api/admin/devices/LFIC1230700004/mac \
  -H "Content-Type: application/json" \
  -d '{"macAddress":"48:27:E2:1B:A4:0A"}'

# Maaier (WiFi STA MAC = BLE MAC − 2)
curl -X POST http://localhost:3000/api/admin/devices/LFIN2230700238/mac \
  -H "Content-Type: application/json" \
  -d '{"macAddress":"50:41:1C:39:BD:BF"}'
```

Alternatiref worden MAC-adressen automatisch geleerd zodra apparaten via MQTT verbinden.

---

## Stap 10 — Apparaten toevoegen in de app

1. Open de Novabot app en log in
2. Ga naar **Apparaat toevoegen** → **Laadstation toevoegen**
3. Voer het serienummer in (bijv. `LFIC1230700004`)
4. Voer je WiFi-netwerknaam en wachtwoord in (alleen 2.4 GHz!)
5. Ga naar het laadstation toe — de app verbindt via BLE
6. Wacht tot WiFi en GPS als "Sterk" worden weergegeven
7. Tik op **Volgende** — de app configureert het laadstation via BLE

**Let op:** Zorg dat het laadstation verbonden is met een **2.4 GHz** netwerk.
De ESP32 in het laadstation ondersteunt geen 5 GHz WiFi.

---

## Diagnostiek

### Server logs begrijpen

| Log prefix | Betekenis |
|------------|-----------|
| `[MQTT] CONNECT clientId="ESP32_1bA408"` | Laadstation verbonden |
| `[MQTT] CONNECT clientId="LFIN2230700238_6688"` | Maaier verbonden |
| `[MQTT] CONNECT clientId="<uuid>"` | App verbonden |
| `[MQTT] SUBSCRIBE X -> [Dart/Send_mqtt/LFIC...]` | Apparaat luistert naar commando's |
| `[MQTT] PUBLISH X →DEV Dart/Send_mqtt/...` | App stuurt commando naar apparaat |
| `[MQTT] PUBLISH X ←DEV Dart/Receive_mqtt/...` | Apparaat reageert |
| `[REQ] POST /api/...` | HTTP verzoek van de app |
| `[UNKNOWN] POST /api/...` | Nog niet geïmplementeerd endpoint |

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

---

## Apparaten referentie

### Laadstation (Charger / Base Station)
| Eigenschap | Waarde |
|------------|--------|
| Serienummer | `LFIC1230700004` |
| MQTT clientId | `ESP32_1bA408` |
| MQTT username | `LFIC1230700004` |
| BLE naam | `CHARGER_PILE` |
| BLE MAC | `48:27:E2:1B:A4:0A` |
| WiFi AP MAC | `48:27:E2:1B:A4:09` (BLE−1) |
| WiFi STA MAC | `48:27:E2:1B:A4:08` (BLE−2) |

### Maaier (Mower)
| Eigenschap | Waarde |
|------------|--------|
| Serienummer | `LFIN2230700238` |
| MQTT clientId | `LFIN2230700238_6688` |
| MQTT username | `LFIN2230700238` |
| BLE naam | `Novabot` |
| BLE MAC | `50:41:1C:39:BD:C1` |
| WiFi STA MAC | `50:41:1C:39:BD:BF` (BLE−2) |

BLE MAC uitlezen met nRF Connect → Advertised Data → Manufacturer Specific Data (0xFF):
```
66 55  XX XX XX XX XX XX  [45 53 50]
 ↑↑↑   ↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑   "ESP"
 ESP    BLE MAC adres
company ID
```
WiFi STA MAC = BLE MAC − 2, WiFi AP MAC = BLE MAC − 1.

---

## Bestandsstructuur

```
novabot-server/
├── src/
│   ├── index.ts                  Entry point
│   ├── db/database.ts            SQLite schema + migraties
│   ├── types/index.ts            TypeScript interfaces
│   ├── middleware/auth.ts        JWT authenticatie
│   ├── mqtt/broker.ts            Aedes MQTT broker (poort 1883)
│   └── routes/
│       ├── admin.ts              Diagnostische endpoints (geen auth)
│       ├── nova-user/            Gebruikers- en apparaatbeheer
│       ├── nova-data/            Maaischema's
│       ├── nova-file-server/     Kaarten en logs
│       └── novabot-message/      Berichten en werkhistorie
├── certs/
│   ├── ca.crt                   CA certificaat → installeren op telefoon
│   ├── fullchain.pem            → uploaden in Nginx Proxy Manager
│   └── server.key               → uploaden in Nginx Proxy Manager
├── scripts/
│   └── generate-certs.sh        Maakt nieuwe CA + servercertificaat aan
├── storage/                     Kaartbestanden en logs (automatisch aangemaakt)
├── novabot.db                   SQLite database
├── .env                         Omgevingsvariabelen
└── package.json
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

- **App**: Novabot v2.3.8, Flutter/Dart, gecompileerd naar `libapp.so`
- **API base**: `https://app.lfibot.com` → nginx → Node.js :3000
- **MQTT**: `mqtt.lfibot.com:1883` → direct naar aedes :1883 (geen TLS)
- **Apparaten**: ESP32, verbinden via 2.4 GHz WiFi, gebruiken MQTT voor telemetrie
- **Provisioning**: BLE GATT, commando's: `set_wifi_info`, `set_mqtt_info`, `set_lora_info`, `set_rtk_info`
- **Auth**: JWT tokens, 7 dagen geldig
- **Database**: better-sqlite3 (synchroon, geen verbindingsbeheer nodig)
