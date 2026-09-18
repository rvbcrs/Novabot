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

    MDNS[opennova-mdns<br/>host network, advertises opennova.local]

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
    Mower -.->|mDNS opennova.local| MDNS
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
        A1[HTTP REST<br/>Port 80]
        A2[MQTT<br/>Port 1883]
    end

    subgraph "App <-> Server"
        B1[HTTP REST<br/>Port 80]
        B2[Socket.io<br/>WebSocket]
    end

    subgraph "Charger <-> Server"
        C1[MQTT Plain JSON<br/>Port 1883]
    end

    subgraph "Mower <-> Server"
        D1[MQTT AES-128-CBC<br/>Port 1883]
        D2[HTTP Uploads<br/>Port 80]
    end

    subgraph "Charger <-> Mower"
        E1[LoRa 433MHz<br/>Binary packets]
        E2[RTK GPS Relay<br/>NMEA via LoRa]
    end
```

!!! note "Port 3000 is dev-only"
    The server binds both port 80 (production-facing, what the mower firmware and `app.lfibot.com` rewrites talk to) and port 3000 (LAN dev bypass, used by `npm run dev` and direct LAN testing). In production deployments behind NGINX Proxy Manager, all traffic terminates on port 80.

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

### DNS redirect (optional)

The container bundles `dnsmasq` but it is **OFF by default** (only started when `ENABLE_DNS=true` and `TARGET_IP` are set in `docker-compose.yml`). Most deployments use an external resolver instead.

| Option | Recommended for |
|--------|-----------------|
| External AdGuard Home / Pi-hole rewrite | Self-hosted networks, multi-device LANs |
| NGINX Proxy Manager + LAN DNS | Reverse-proxy setups, TLS termination for iOS |
| Bundled `dnsmasq` (set `ENABLE_DNS=true`) | Single-host quick start, no external resolver available |

See [guide/dns-setup.md](../guide/dns-setup.md) for setup instructions.

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
| **opennova-mdns** | Same host, host network | Advertises `opennova.local` for custom-firmware mowers |
| **Custom mower firmware** | Mower | SSH, URL patches, camera, mDNS discovery |

### Server Discovery

The mower finds the local server via a fallback cascade (custom firmware v6.0.2-custom-16+):

1. **WiFi wait** for STA connection to complete
2. **mDNS query** for `opennovabot.local` (8 second timeout)
3. **DNS query** for `mqtt.lfibot.com` (resolves to LAN IP via AdGuard / dnsmasq rewrite)
4. **Last-known IP** from previous successful connection
5. **Fallback host** (hardcoded during firmware build)
6. **Skip** -- mower continues without server connection

!!! info "mDNS runs in its own container on the host network"
    A bridged container only ever hears its own multicast, so the standard compose runs a second, tiny container `opennova-mdns` with `network_mode: host` that advertises `opennova.local`. On Docker Desktop (macOS, Windows) even that sits inside a VM and cannot be heard; the mower then falls through to the DNS step. See [Discovery by Name](../guide/auto-discovery.md).

## Database Schema

| Table | Purpose |
|-------|---------|
| `users` | User accounts (email, bcrypt password, machine_token) |
| `email_codes` | Temporary verification codes |
| `equipment` | Bound devices (mower_sn PK, charger_sn, mac_address) |
| `maps` | Map metadata (polygons stored as JSON) |
| `map_uploads` | Fragmented map upload tracking |
| `cut_grass_plans` | Mowing schedules per device |
| `robot_messages` | Device-to-user messages |
| `work_records` | Mowing session history |
| `ota_versions` | OTA firmware versions |
| `device_registry` | Auto-learned via MQTT CONNECT (sn, mac, last_seen) |
| `device_factory` | Factory inventory imported from LFI account (sn, mac, type) |
| `equipment_lora_cache` | Cached LoRa parameters (survives unbind) |
| `dashboard_schedules` | Dashboard mowing schedules (CRUD + MQTT push) |
| `signal_history` | Time-series WiFi / LoRa / RTK signal samples |
| `map_calibration` | Manual map offset/rotation/scale per mower |
| `device_settings` | Per-device preference flags (rain delay, LED, etc.) |
| `push_tokens` | Expo push notification tokens per user/device |
| `remote_support_identities` | Remote-support tunnel identity + token per instance |
| `import_audit` | Audit log of LFI cloud imports (device pulls, dedup) |
| `rain_sessions` | Detected rain events (rain sensor history) |
| `rain_settings` | Per-mower rain delay configuration |
| `virtual_walls` | No-go zones / virtual boundaries per mower |
