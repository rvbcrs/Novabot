# OpenNova Wiki

Welcome to the complete technical documentation for the **OpenNova** project -- an open-source local server replacement for Novabot robot mowers.

This project replaces the Novabot cloud (`app.lfibot.com` / `mqtt.lfibot.com`) with a local Node.js/TypeScript server, enabling the robot mower and charging station to operate fully offline. Devices are provisioned via **BLE with direct IP addresses**, so DNS rewrites and custom firmware are optional.

!!! success "Getting started"
    The recommended setup uses the **OpenNova mobile app** + **BLE provisioning** to point devices directly at your local server IP. No DNS rewrites or custom mower firmware required for basic operation.

!!! warning "Novabot Cloud Offline (March 2026)"
    Both `app.lfibot.com` and `mqtt.lfibot.com` are unreachable since March 8, 2026. This local server replacement is now the **only way** to keep Novabot devices operational.

## Project Components

| Component | Directory | Technology | Purpose |
|-----------|-----------|-----------|---------|
| **Server** | `server/` | Express + Aedes MQTT + Socket.io | Local cloud replacement |
| **Dashboard** | `dashboard/` | React + Vite + Tailwind + Leaflet | Web-based control panel |
| **ESP32 OTA Tool** | `firmware/esp32-tool/` | PlatformIO + LVGL | Charger firmware flash tool |
| **Mower** | `mower/` | Python + ROS 2 | Open robot_decision replacement |
| **Bootstrap wizard** | `bootstrap/` | Node.js + noble BLE | First-time setup, firmware patching, mDNS |
| **Docker container** | — | Node.js + dnsmasq | Production deployment (server + dashboard + DNS) |

## Current Firmware Versions

| Device | Firmware | MCU | Key Features |
|--------|----------|-----|--------------|
| Mower | `v6.0.2-custom-16` | STM32 v3.6.6 | SSH, mDNS discovery, camera stream, PIN lock fix |
| Charger | `v0.4.0` (patched) | — | MQTT host patched to local server |

## Known Devices

| Device | Serial Number | Type | MQTT Client ID |
|--------|--------------|------|----------------|
| Charger (Base Station) | `LFIC1230700XXX` | ESP32-S3 | `ESP32_XXXXXX` |
| Mower | `LFIN2230700XXX` | Horizon X3 (ARM64) | `LFIN2230700XXX_6688` |

## What's Optional?

| Feature | Required? | Details |
|---------|-----------|---------|
| **OpenNova server** | Yes | Local cloud replacement (Docker or native) |
| **BLE provisioning** | Yes | Configures devices with direct server IP |
| **DNS rewrites** | No | Only needed if using the official Novabot app instead of OpenNova app |
| **Custom mower firmware** | No | Only needed for mDNS discovery, SSH access, camera streaming |

## Documentation Sections

- **[Architecture](architecture/overview.md)** -- System design, hardware, network topology, distribution model
- **[HTTP API](api/overview.md)** -- All REST endpoints (cloud API, dashboard, mower-to-server)
- **[MQTT Protocol](mqtt/overview.md)** -- Complete MQTT command reference with payloads
- **[BLE Protocol](ble/overview.md)** -- Bluetooth Low Energy provisioning commands
- **[LoRa Protocol](firmware/lora-protocol.md)** -- Charger <-> Mower radio communication
- **[Firmware](firmware/charger.md)** -- Charger (ESP32-S3) and Mower (Horizon X3) firmware analysis
- **[Custom Firmware](firmware/custom-firmware.md)** -- Build script, STM32 patches, extended commands (OPTIONAL)
- **[Flow Diagrams](flows/charger-provisioning.md)** -- Mermaid diagrams for all key workflows

## Quick Start

```bash
# Start the wiki
docker compose -f docker-compose.wiki.yml up

# Open in browser
open http://localhost:8100
```
