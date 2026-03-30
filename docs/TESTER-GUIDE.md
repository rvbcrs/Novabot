# OpenNova Tester Guide

Complete handleiding om een werkende OpenNova server op te zetten en je Novabot maaier + laadstation te verbinden.

---

## Wat is OpenNova?

OpenNova is een **lokale vervanging** voor de Novabot cloud. In plaats van dat je maaier en laadstation met `app.lfibot.com` praten, praten ze met een server op je eigen netwerk. Dit geeft je:

- Volledige controle over je apparaten
- Geen afhankelijkheid van de Novabot cloud
- Blijf gewoon de **originele Novabot app** gebruiken voor dagelijkse bediening

---

## Wat heb je nodig?

| Item | Beschrijving |
|------|-------------|
| **Docker host** | Mac, Linux PC, NAS (Synology/QNAP), of Raspberry Pi 4/5 |
| **Novabot maaier** | LFIN-serie (bijv. LFIN2230700238) |
| **Novabot laadstation** | LFIC-serie (bijv. LFIC1230700004) |
| **WiFi netwerk** | 2.4 GHz (maaier/charger ondersteunen geen 5 GHz) |
| **Telefoon** | iPhone of Android met Bluetooth (voor eenmalige provisioning) |

---

## Stap 1: Server installeren met Docker

### 1.1 Docker installeren

Als je Docker nog niet hebt:
- **Mac**: Download [Docker Desktop](https://docker.com/products/docker-desktop)
- **Linux**: `sudo apt install docker.io docker-compose-plugin`
- **Synology NAS**: Container Manager (ingebouwd)
- **Raspberry Pi**: `curl -fsSL https://get.docker.com | sh`

### 1.2 OpenNova starten

Maak een directory aan en maak een configuratiebestand:

```bash
mkdir opennova && cd opennova

# Maak docker-compose.yml aan:
cat > docker-compose.yml << 'EOF'
services:
  opennova:
    image: rvbcrs/opennova:latest
    container_name: opennova
    restart: unless-stopped
    ports:
      - "3000:80"    # API
      - "1883:1883"  # MQTT broker
    environment:
      PORT: 80
      JWT_SECRET: verander-dit-naar-iets-willekeurigs
      DB_PATH: /data/novabot.db
      STORAGE_PATH: /data/storage
      FIRMWARE_PATH: /data/firmware
    volumes:
      - novabot-data:/data

volumes:
  novabot-data:
EOF

# Start de server
docker compose up -d
```

### 1.3 Controleer of de server draait

```bash
curl http://<server-ip>:3000/api/setup/health
```

Je zou een JSON response moeten krijgen. Noteer het **IP-adres** van je server (bijv. `192.168.0.177`) — dit heb je nodig bij het provisionen.

> **Tip**: Gebruik `hostname -I` (Linux) of `ifconfig | grep inet` (Mac) om je IP te vinden.

---

## Stap 2: Account aanmaken

Open `http://<server-ip>:3000` in je browser en maak een account aan:

1. Vul je email en wachtwoord in
2. Klik op **Create Account**
3. De eerste gebruiker wordt automatisch admin

> Dit account gebruik je later om met de Novabot app in te loggen op je lokale server.

---

## Stap 3: Apparaten provisionen

De provisioning configureert je charger en maaier om met jouw lokale server te verbinden in plaats van de Novabot cloud. Dit is een **eenmalige actie** — daarna verbinden de apparaten automatisch bij elke herstart.

### Provisioning app installeren

Download de OpenNova provisioning app:
- **Android**: Download de APK van de [GitHub Releases](https://github.com/rvbcrs/Novabot/releases) pagina
- **iOS**: Vraag een TestFlight uitnodiging aan bij de ontwikkelaar

### Provisioning starten

1. Open de provisioning app
2. Log in met je server URL (`http://<server-ip>:3000`) en het account uit stap 2
3. Ga naar **Settings** → **Re-provision Device**

### Wizard doorlopen

#### Scherm 1: Server selectie
- Het MQTT adres wordt automatisch ingevuld met je server IP
- Poort: `1883`
- Klik **Next**

#### Scherm 2: Apparaat kiezen
- Kies **Charger**, **Mower**, of **Both**
- **Begin altijd met de charger!**

#### Scherm 3: WiFi instellingen
- Vul je **WiFi SSID** in (moet een **2.4 GHz** netwerk zijn!)
- Vul je **WiFi wachtwoord** in
- Klik **Next**

#### Scherm 4: BLE scan
- De app scant 10 seconden naar Bluetooth apparaten in de buurt
- Je charger verschijnt als `CHARGER_PILE`, je maaier als `Novabot`
- **Sta dicht bij het apparaat** (< 5 meter)
- Selecteer het juiste apparaat en klik **Provision**

#### Scherm 5: Provisioning uitvoering
De app configureert het apparaat stap voor stap:
1. Verbinden via Bluetooth
2. WiFi credentials instellen
3. MQTT server adres instellen (direct IP — geen DNS nodig)
4. LoRa parameters configureren
5. Instellingen opslaan

Wacht tot alle stappen groen zijn. Het apparaat herstart automatisch en verbindt met je server.

### Belangrijk: Charger eerst, dan Maaier

| Stap | Apparaat | Waarom |
|------|----------|--------|
| 1 | **Charger** | De charger heeft de GPS module en is het referentiepunt voor de maaier |
| 2 | **Maaier** | De maaier verbindt via LoRa met de charger voor GPS correcties |

### Verificatie

Na provisioning van beide apparaten controleer je of ze online zijn:

```bash
# Check server logs
docker logs opennova -f --tail 50
```

Je zou moeten zien:
- `[MQTT] LFIC... connected` (charger)
- `[MQTT] LFIN... connected` (maaier)

---

## Stap 4: Dagelijks gebruik met de Novabot app

Na provisioning gebruik je gewoon de **originele Novabot app** voor dagelijkse bediening. De app werkt identiek — het enige verschil is dat de communicatie via jouw lokale server loopt.

De Novabot app biedt:
- Real-time maaier status (battery, positie, activiteit)
- Maaien starten/stoppen/pauzeren
- Kaart bekijken en bewerken
- Maaischema's instellen
- Handmatige besturing (joystick)
- Maaigeschiedenis

> **Let op**: De Novabot app moet het IP-adres van je server kunnen bereiken. Zorg dat je telefoon op hetzelfde WiFi netwerk zit als de server.

---

## Veelgestelde vragen

### Mijn charger/maaier verschijnt niet na provisioning

1. **WiFi**: Is je netwerk 2.4 GHz? 5 GHz werkt niet met de apparaten.
2. **MQTT bereikbaar**: Kan het apparaat poort `1883` bereiken op de server?
   ```bash
   nc -zv <server-ip> 1883
   ```
3. **BLE bereik**: Sta dicht bij het apparaat tijdens provisioning (< 5 meter).
4. **Herstart**: Schakel het apparaat uit en weer aan. Het verbindt automatisch opnieuw.
5. **Logs**: Bekijk de server logs voor meer informatie:
   ```bash
   docker logs opennova -f --tail 100
   ```

### Maaier toont "error 151"

Dit is een localisatie-fout. De maaier moet even rijden om zijn heading (richting) te bepalen via GPS. Dit lost zichzelf op zodra de maaier een korte afstand heeft gereden.

### Kan ik terug naar de Novabot cloud?

Ja. Provisioning via de originele Novabot app herstelt de verbinding met de Novabot cloud. De apparaten kunnen maar met één server tegelijk verbonden zijn.

### Werkt de Novabot app via mobiel internet (4G/5G)?

Alleen als je server bereikbaar is van buitenaf (via VPN of port forwarding). Standaard werkt het alleen op je lokale WiFi netwerk.

### Docker container updaten

```bash
docker compose pull
docker compose down && docker compose up -d
```

Je database en instellingen blijven bewaard (volume `novabot-data`).

---

## Probleemoplossing

### Server logs bekijken
```bash
docker logs opennova -f --tail 100
```

### Database resetten (alle data wissen)
```bash
docker compose down
docker volume rm opennova_novabot-data
docker compose up -d
```

### Poorten controleren
```bash
# Check of de server draait
curl http://<server-ip>:3000/api/setup/health

# Check of MQTT bereikbaar is
nc -zv <server-ip> 1883
```

---

## Technische details

### Poorten

| Poort | Protocol | Doel |
|-------|----------|------|
| 3000 | HTTP | API server |
| 1883 | MQTT | Apparaat communicatie |

### Hoe het werkt

```
Novabot App (telefoon)
    ↕ HTTP (poort 3000)
OpenNova Server (Docker)
    ↕ MQTT (poort 1883)
Charger + Maaier (WiFi)
```

De server draait een MQTT broker waar je apparaten mee verbinden, en een HTTP API waar de Novabot app mee communiceert. Alle communicatie is AES-128-CBC versleuteld.

---

## Roadmap

De volgende features zijn in ontwikkeling:

- **OpenNova Dashboard** — webinterface voor monitoring, maaischema's, kaartbeheer, OTA updates en handmatige besturing via de browser
- **OpenNova App** — eigen iOS/Android app als volledig alternatief voor de Novabot app, met real-time status, kaart, schema's, joystick en meer
- **Home Assistant integratie** — MQTT bridge voor sensors en bediening vanuit HA
