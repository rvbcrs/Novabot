# Novabot Reverse Engineering Wiki

Welcome to the complete technical documentation for the **Novabot local server replacement** project.

This project replaces the Novabot cloud (`app.lfibot.com` / `mqtt.lfibot.com`) with a local Node.js/TypeScript server, enabling the robot mower and charging station to operate fully offline.

## Project Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **novabot-server** | Express + Aedes MQTT + Socket.io | Local cloud replacement |
| **novabot-dashboard** | React + Vite + Tailwind + Leaflet | Web-based control panel |
| **novabot-dns** | Alpine + dnsmasq (Docker) | DNS redirect to local server |

## Known Devices

| Device | Serial Number | Type | MQTT Client ID |
|--------|--------------|------|----------------|
| Charger (Base Station) | `LFIC1230700XXX` | ESP32-S3 | `ESP32_XXXXXX` |
| Mower | `LFIN2230700XXX` | Horizon X3 (ARM64) | `LFIN2230700XXX_6688` |

## Documentation Sections

- **[Architecture](architecture/overview.md)** — System design, hardware, network topology
- **[HTTP API](api/overview.md)** — All REST endpoints (cloud API, dashboard, mower-to-server)
- **[MQTT Protocol](mqtt/overview.md)** — Complete MQTT command reference with payloads
- **[BLE Protocol](ble/overview.md)** — Bluetooth Low Energy provisioning commands
- **[LoRa Protocol](firmware/lora-protocol.md)** — Charger ↔ Mower radio communication
- **[Firmware](firmware/charger.md)** — Charger (ESP32-S3) and Mower (Horizon X3) firmware analysis
- **[Flow Diagrams](flows/charger-provisioning.md)** — Mermaid diagrams for all key workflows

## Quick Start

```bash
# Start the wiki
docker compose -f docker-compose.wiki.yml up

# Open in browser
open http://localhost:8100
```
