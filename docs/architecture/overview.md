# Architecture Overview

!!! warning "Novabot Cloud Unreliable"
    The Novabot cloud (`app.lfibot.com` / `mqtt.lfibot.com`) has been experiencing frequent outages since March 2026. OpenNova keeps your mower operational regardless of cloud status.

## System Diagram

```mermaid
graph TB
    subgraph Internet
        Cloud[app.lfibot.com<br/>Cloud API Server<br/>Unreliable since March 2026]
        MQTT_Cloud[mqtt.lfibot.com<br/>Cloud MQTT Broker<br/>Unreliable since March 2026]
    end

    subgraph "Docker Container (Mac/NAS/RPi)"
        DNS[dnsmasq<br/>DNS rewrite *.lfibot.com]
        Server[server<br/>Express + Aedes MQTT]
    end

    subgraph "Host Machine (native)"
        Bootstrap[Bootstrap Wizard<br/>BLE provisioning + mDNS]
    end

    subgraph Devices
        Charger[Charging Station<br/>ESP32-S3 / LFIC1230700XXX]
        Mower[Robot Mower<br/>Horizon X3 / LFIN2230700XXX]
    end

    App[OpenNova App<br/>React Native]
    HA[Home Assistant<br/>MQTT Bridge]

    DNS -->|Redirects *.lfibot.com| Server
    App -->|HTTP REST + Socket.io| Server
    App <-->|BLE GATT| Charger
    App <-->|BLE GATT| Mower
    Bootstrap <-->|BLE provisioning| Charger
    Bootstrap <-->|BLE provisioning| Mower
    Charger -->|MQTT plain JSON| Server
    Mower -->|MQTT AES-128-CBC| Server
    Charger <-->|LoRa 433MHz| Mower
    Server -->|MQTT auto-discovery| HA

    Cloud -.->|Replaced by local server| Server
    MQTT_Cloud -.->|Replaced by local broker| Server
```

## Communication Layers

```mermaid
graph LR
    subgraph "App <-> Server"
        A1[HTTP REST<br/>Port 3000]
        A2[MQTT<br/>Port 1883]
    end

    subgraph "App <-> Server"
        B1[HTTP REST<br/>Port 3000]
        B2[Socket.io<br/>WebSocket]
    end

    subgraph "Charger <-> Server"
        C1[MQTT Plain JSON<br/>Port 1883]
    end

    subgraph "Mower <-> Server"
        D1[MQTT AES-128-CBC<br/>Port 1883]
        D2[HTTP Uploads<br/>Port 3000]
    end

    subgraph "Charger <-> Mower"
        E1[LoRa 433MHz<br/>Binary packets]
        E2[RTK GPS Relay<br/>NMEA via LoRa]
    end
```

## Technology Stack

### Server (`server/`)

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js + TypeScript (ESM modules) |
| HTTP | Express.js |
| MQTT Broker | Aedes (port 1883) |
| WebSocket | Socket.io |
| Database | better-sqlite3 (WAL mode) |
| Auth | JWT (jsonwebtoken + bcrypt) |

### OpenNova App (`app/`)

| Layer | Technology |
|-------|-----------|
| Framework | React Native + Expo |
| Platforms | iOS + Android |
| BLE | NimBLE (provisioning) |
| Maps | SVG-based with GPS conversion |
| Real-time | Socket.io client |

### Bootstrap Wizard (`bootstrap/`)

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js + TypeScript |
| BLE | @stoprocent/noble (native) + Web BLE (browser fallback) |
| mDNS | Bonjour/Avahi advertisement |
| Purpose | First-time firmware patching, BLE provisioning, mDNS `opennovabot.local` |

### DNS (inside Docker container)

| Layer | Technology |
|-------|-----------|
| Container | Alpine Linux (~8MB image) |
| DNS | dnsmasq |
| Purpose | Redirect `*.lfibot.com` to local server IP |

## Distribution Model

The project uses a Docker-based distribution where the server runs on the user's local network (Mac/NAS/Raspberry Pi), NOT on the mower itself.

### Why Not On The Mower?

- CPU load impacts mowing performance
- Battery drain from running Node.js server
- Heat buildup from continuous server operation
- Brick risk if server crashes
- No app access when mower is offline/sleeping

### Components

| Component | Runs On | Purpose |
|-----------|---------|---------|
| **Docker container** | Mac/NAS/RPi | server + dnsmasq |
| **Bootstrap wizard** | Host machine (native) | Initial setup, firmware patching, mDNS advertising |
| **Custom mower firmware** | Mower | SSH, URL patches, camera, mDNS discovery |

### Server Discovery

The mower finds the local server via a fallback cascade (custom firmware v6.0.2-custom-16+):

1. **mDNS query** for `opennovabot.local` (8 second timeout)
2. **Last-known IP** from previous successful connection
3. **Fallback host** (hardcoded during firmware build)
4. **Skip** -- mower continues without server connection

!!! info "mDNS runs on the host, not in Docker"
    The bootstrap wizard advertises `opennovabot.local` via mDNS on the host machine. Docker bridge networking blocks multicast on macOS, so mDNS runs natively in the bootstrap tool, not inside Docker.

## Database Schema

| Table | Purpose |
|-------|---------|
| `users` | User accounts (email, bcrypt password, machine_token) |
| `email_codes` | Temporary verification codes |
| `equipment` | Bound devices (mower_sn PK, charger_sn, mac_address) |
| `device_registry` | Auto-learned via MQTT CONNECT (sn, mac, last_seen) |
| `maps` | Map metadata (polygons stored as JSON) |
| `map_uploads` | Fragmented map upload tracking |
| `cut_grass_plans` | Mowing schedules per device |
| `robot_messages` | Device to user messages |
| `work_records` | Mowing session history |
| `equipment_lora_cache` | Cached LoRa parameters (survives unbind) |
| `ota_versions` | OTA firmware versions |
| `map_calibration` | Manual map offset/rotation/scale per mower |
| `dashboard_schedules` | Dashboard mowing schedules (CRUD + MQTT push) |
| `virtual_walls` | No-go zones / virtual boundaries per mower |
