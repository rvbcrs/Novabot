# OpenNova — Self-hosted Novabot Cloud Replacement

Replace the Novabot cloud with your own local server. Your mower and charging station connect to **your server** on your own network — no cloud dependency, no outages, full control.

!!! The Novabot cloud has been experiencing frequent outages since March 2026. OpenNova keeps your mower operational regardless of cloud status.

## What is OpenNova?

A single Docker container that includes everything your Novabot needs:

- **MQTT Broker** (port 1883) — mower and charger connect here
- **Cloud API** (port 3000) — compatible with the official Novabot app
- **DNS Server** (optional) — redirects `mqtt.lfibot.com` to your server
- **TLS/HTTPS** (optional) — for iOS Novabot app compatibility

The official Novabot app continues to work — it just talks to your server instead of the cloud.

## Quick Start

### 1. Pull the Docker image

```bash
docker pull rvbcrs/opennova:latest
```

### 2. Create docker-compose.yml

```yaml
services:
  opennova:
    image: rvbcrs/opennova:latest
    container_name: opennova
    restart: unless-stopped
    ports:
      - "3000:80"     # API
      - "1883:1883"   # MQTT broker
    environment:
      PORT: 80
      JWT_SECRET: change_me_to_a_random_secret
    volumes:
      - novabot-data:/data

volumes:
  novabot-data:
```

### 3. Start the server

```bash
docker compose up -d
```

### 4. Verify it's running

```bash
curl http://localhost:3000/api/setup/health
```

Expected response:
```json
{"server":"ok","mqtt":"ok"}
```

### 5. Set up DNS redirect

Your mower needs to find your server when it looks up `mqtt.lfibot.com`. You have several options:

#### Option A: Pi-hole / AdGuard Home (recommended)

Add DNS rewrites in your Pi-hole or AdGuard admin panel:

| Domain | IP Address |
|--------|-----------|
| `mqtt.lfibot.com` | `YOUR_SERVER_IP` |
| `app.lfibot.com` | `YOUR_SERVER_IP` |

Then point your router's DHCP DNS to your Pi-hole/AdGuard IP.

#### Option B: Router DNS override

Some routers (Fritz!Box, ASUS) support custom DNS records. Add entries for `mqtt.lfibot.com` and `app.lfibot.com` pointing to your server IP.

#### Option C: Built-in DNS (simplest)

Enable the built-in DNS server in docker-compose.yml:

```yaml
ports:
  - "3000:80"
  - "1883:1883"
  - "53:53/udp"       # DNS
environment:
  PORT: 80
  JWT_SECRET: your_secret_here
  ENABLE_DNS: "true"
  TARGET_IP: "192.168.0.100"   # Your server's LAN IP
```

Then point your router's DHCP DNS server to your server IP.

#### Verify DNS is working

From any device on your network:

```bash
# macOS / Linux
dig mqtt.lfibot.com +short

# Windows
nslookup mqtt.lfibot.com
```

Should return your server IP. If it shows `47.253.145.99` (Novabot cloud), DNS is not redirected yet.

### 6. Restart your mower

Power off the mower, wait 10 seconds, power on. It will reconnect to WiFi and get the new DNS from your router. It should now connect to your server via MQTT.

Check the server logs:

```bash
docker compose logs -f opennova | grep CONNECT
```

You should see your mower's serial number (LFIN...) connecting.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | — | Auth token secret (**required** — generate with `openssl rand -hex 32`) |
| `PORT` | `80` | Internal HTTP port |
| `ENABLE_DNS` | `false` | Enable built-in DNS redirect |
| `TARGET_IP` | — | Your server's LAN IP (required for DNS/TLS) |
| `UPSTREAM_DNS` | `8.8.8.8` | Fallback DNS server |
| `ENABLE_TLS` | `false` | Enable HTTPS for iOS Novabot app |
| `ENABLE_DASHBOARD` | `false` | Enable web dashboard (beta, not for public use yet) |

### Optional: Home Assistant Integration

Bridge mower data to Home Assistant via MQTT auto-discovery:

```yaml
environment:
  HA_MQTT_HOST: "192.168.0.200"
  HA_MQTT_PORT: 1883
  HA_MQTT_USER: "mqtt"
  HA_MQTT_PASS: "mqtt"
```

Entities auto-appear in Home Assistant under the mower/charger serial number.

### Optional: TLS for iOS

The original Novabot iOS app requires HTTPS. Enable with:

```yaml
ports:
  - "443:443"
environment:
  ENABLE_TLS: "true"
  TARGET_IP: "192.168.0.100"
```

A self-signed certificate is auto-generated. Install the CA profile on your iPhone via `http://YOUR_SERVER_IP:3000/api/setup/ios-profile`.

## Data & Backup

All data is stored in the `novabot-data` Docker volume:

```bash
# Backup
docker compose cp opennova:/data ./opennova-backup

# Restore
docker compose cp ./opennova-backup/. opennova:/data
docker compose restart opennova
```

## Upgrading

```bash
docker pull rvbcrs/opennova:latest
docker compose down && docker compose up -d
```

Database migrations run automatically on startup.

## Troubleshooting

### Mower not connecting

1. **Check DNS**: `dig mqtt.lfibot.com +short` should show your server IP
2. **Check MQTT port**: `nc -zv YOUR_SERVER_IP 1883` should succeed
3. **Check logs**: `docker compose logs opennova | grep MQTT`
4. **WiFi**: Mower only supports **2.4 GHz** — 5 GHz networks are invisible to it
5. **Restart mower**: Power off, wait 10s, power on (picks up new DNS from router)

### Port 53 conflict (Linux)

```bash
sudo systemctl stop systemd-resolved
sudo systemctl disable systemd-resolved
```

### Container won't start

```bash
docker compose logs opennova
```

Common issues: port 1883 already in use (another MQTT broker), missing JWT_SECRET.

## Supported Devices

| Device | Status |
|--------|--------|
| Novabot N1000 Mower | Fully supported |
| Novabot N2000 Mower | Fully supported |
| Novabot Charging Station | Fully supported |

## What's Next

We're working on additional tools (not yet ready for public release):

- **OpenNova App** — dedicated mobile app (iOS/Android) that doesn't need DNS redirects
- **Bootstrap Tool** — desktop app for easy first-time Bluetooth provisioning
- **ESP32 OTA Tool** — standalone hardware device for provisioning + custom firmware
- **Open source firmware modules** — replacing closed-source binaries on the mower

## Documentation

Full wiki with detailed guides: **[wiki.ramonvanbruggen.nl](https://wiki.ramonvanbruggen.nl)**

- [Docker Container Guide](https://wiki.ramonvanbruggen.nl/guide/docker/)
- [DNS Setup Guide](https://wiki.ramonvanbruggen.nl/guide/dns-setup/)

## Community

- [GitHub Issues](https://github.com/rvbcrs/Novabot/issues) — Bug reports and feature requests

## License

This project is for personal, non-commercial use with Novabot devices you own.

---

**This is beta software. Use at your own risk. Your mower is an expensive device — test carefully.**
