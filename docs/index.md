# OpenNova Wiki

**OpenNova** replaces the Novabot cloud with a server on your own network, so
your Novabot mower and charging station keep working now that the company
behind them is gone. This wiki is the documentation for it: how to install and
use it, and, further down, how the mower, the charger and their protocols
actually work.

!!! success "Start here"
    **[Installing OpenNova](guide/docker.md)**: one page, one `docker-compose.yml`,
    one line to change. Then **[DNS Setup](guide/dns-setup.md)** to point the
    mower at it, and **[First Run](guide/getting-started.md)** for the app.

    No Docker experience? The **[Raspberry Pi Installer](guide/raspberry-pi-installer.md)**
    writes a ready-made SD card.

## Using OpenNova

- **[Admin Panel](user-guide/admin-panel.md)**: devices, maps, firmware, diagnostics
- **[OpenNova App](user-guide/opennova-app.md)**: the mobile app that needs no DNS tricks
- **[Stock vs. Custom Firmware](user-guide/stock-vs-custom-firmware.md)**: what custom firmware adds, and what it costs
- **[Troubleshooting](user-guide/troubleshooting.md)**: start with *Why is it not coming online?* in the admin panel

## What is optional?

| Feature | Needed? | When |
|---|---|---|
| OpenNova server | Yes | Always. Docker on Linux is the place for it. |
| DNS redirect of `*.lfibot.com` | Usually | Needed for the official Novabot app and for stock firmware. |
| BLE provisioning | Once | Points a device at your server directly, through the OpenNova app or the bootstrap tool. |
| Custom mower firmware | No | Adds discovery by name, SSH, camera stream, and the map editing the dashboard builds on. |

## How it works

- **[Architecture](architecture/overview.md)**: system design, hardware, network topology
- **[HTTP API](api/overview.md)**: every REST endpoint (cloud API, dashboard, mower to server)
- **[MQTT Protocol](mqtt/overview.md)**: the command reference with payloads
- **[BLE Protocol](ble/overview.md)**: Bluetooth provisioning
- **[LoRa Protocol](firmware/lora-protocol.md)**: charger to mower radio
- **[Firmware](firmware/charger.md)**: charger (ESP32-S3) and mower (Horizon X3) analysis
- **[Custom Firmware](firmware/custom-firmware.md)**: the build, the patches, the extended commands
- **[Flow Diagrams](flows/charger-provisioning.md)**: the key workflows as diagrams

## The project

| Component | Directory | Technology |
|---|---|---|
| Server | `server/` | Express, Aedes MQTT, Socket.io |
| OpenNova app | `app/` | React Native, Expo |
| Dashboard | `dashboard/` | React, Vite, Leaflet |
| Bootstrap tool | `bootstrap/` | Node.js, noble BLE |
| ESP32 OTA tool | `firmware/esp32-tool/` | PlatformIO, LVGL |
| Mower modules | `mower/` | Python, ROS 2 |

Source: [github.com/rvbcrs/Novabot](https://github.com/rvbcrs/Novabot). Bugs and
wishes go to [GitHub Issues](https://github.com/rvbcrs/Novabot/issues).
