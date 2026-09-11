# OpenNova — self-hosted Novabot cloud replacement

Run your Novabot robot mower and charging station entirely on your own network. This image replaces the manufacturer's cloud: the mower, the charging station and the mobile app all talk to your server instead. No cloud account, no outages, no dependency on a service that can disappear.

Not affiliated with, endorsed by, or supported by the manufacturer.

- **Source and documentation:** https://github.com/rvbcrs/Novabot
- **Issues and questions:** https://github.com/rvbcrs/Novabot/issues
- **Support the project:** [GitHub Sponsors](https://github.com/sponsors/rvbcrs) · [Buy Me a Coffee](https://buymeacoffee.com/rvbcrs) · [PayPal](https://paypal.me/rvbcrs)

## What it does

One container with everything the hardware expects:

- **MQTT broker** on port 1883, where the mower and the charging station connect.
- **Cloud API** on ports 80 and 443, compatible with the official Novabot app.
- **Web dashboard** with a live map, mowing control, schedules, map editing and firmware updates.
- **DNS redirect** (optional) so `mqtt.lfibot.com` and `app.lfibot.com` resolve to your server.
- **TLS** (optional) which the iOS app requires.
- **Home Assistant integration** over MQTT discovery.

Platforms: `linux/amd64` and `linux/arm64`. It runs on a NAS, a mini PC, a Raspberry Pi 4 or 5, or any machine on the same network as the mower.

## Quick start

```yaml
services:
  opennova:
    image: rvbcrs/opennova:latest
    container_name: opennova
    restart: unless-stopped
    init: true
    ports:
      - "80:80"         # API, admin panel, dashboard
      - "443:443"       # HTTPS, required for the iOS app
      - "1883:1883"     # MQTT broker
      - "5353:5353/udp" # mDNS discovery
    environment:
      TZ: Europe/Amsterdam
      PORT: 80
      ENABLE_TLS: "true"
      TARGET_IP: "192.168.1.10"   # this server's LAN IP
    volumes:
      - opennova-data:/data

volumes:
  opennova-data:
```

```bash
docker compose up -d
```

Then point the mower at your server. Either enable the built-in DNS redirect, or add two rewrites in your own DNS server or router so `mqtt.lfibot.com` and `app.lfibot.com` resolve to this machine. The setup wizard at `http://<server>/admin` walks through it.

## Tags

| Tag | Meaning |
|---|---|
| `latest` | Current stable release. Use this one. |
| `beta` | Next release under test. Newer, and occasionally rough. |
| `2026.MMDD.HHMM` | Immutable release, pinned by date and time. |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TZ` | `UTC` | Timezone, must match the one used when creating schedules |
| `PORT` | `80` | Internal HTTP port |
| `ENABLE_TLS` | `false` | Serve HTTPS on 443, required for the iOS app |
| `TARGET_IP` | — | This server's LAN IP, needed for TLS and DNS |
| `ENABLE_DNS` | `false` | Built-in DNS redirect, also publish port 53/udp |
| `UPSTREAM_DNS` | `8.8.8.8` | Forwarder for everything else |
| `ENABLE_DASHBOARD` | `false` | Web dashboard |
| `DB_PATH` | `/data/novabot.db` | Database location |
| `STORAGE_PATH` | `/data/storage` | Maps and uploads |
| `FIRMWARE_PATH` | `/data/firmware` | Firmware images served to devices |

All state lives under `/data`, so a single volume is enough to keep your pairing, maps and history across updates.

## Updating

```bash
docker compose pull && docker compose up -d
```

The database migrates itself on start. Keep a copy of the volume before a major jump.
