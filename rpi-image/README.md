# OpenNova Raspberry Pi Image

All-in-one Novabot cloud replacement on a Raspberry Pi Zero 2 W.

## What it does

- **BLE provisioning** — configures charger + mower via Bluetooth
- **WiFi AP** — temporary hotspot for initial setup
- **DNS** — resolves mqtt.lfibot.com to itself
- **MQTT broker** — receives mower/charger data
- **HTTP server** — Novabot app API replacement
- **OTA** — flashes custom firmware on mower
- **mDNS** — advertises as opennovabot.local

## Hardware

- Raspberry Pi Zero 2 W (~€18) or Pi 3/4/5
- Micro SD card (8GB+)
- USB power supply

## User setup

1. Download `opennovabot.img.gz`
2. Flash to SD card with Raspberry Pi Imager
3. Insert SD, power on RPi
4. Connect to `OpenNova-Setup` WiFi on phone
5. Open http://opennovabot.local → setup wizard
6. Enter home WiFi credentials + LFI account
7. RPi provisions charger + mower via BLE automatically
8. Install mobileconfig profile on phone
9. Done — use the Novabot app as normal

## Build the image

```bash
./build-image.sh
```

Requires: Raspberry Pi OS Lite base image, Docker (for cross-compilation).
