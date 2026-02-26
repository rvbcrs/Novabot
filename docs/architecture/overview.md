# Architecture Overview

## System Diagram

```mermaid
graph TB
    subgraph Internet
        Cloud[app.lfibot.com<br/>Cloud API Server]
        MQTT_Cloud[mqtt.lfibot.com<br/>Cloud MQTT Broker]
    end

    subgraph Local Network
        DNS[novabot-dns<br/>dnsmasq Docker]
        Server[novabot-server<br/>Express + Aedes MQTT]
        Dashboard[novabot-dashboard<br/>React + Leaflet]
        HA[Home Assistant<br/>MQTT Bridge]
    end

    subgraph Devices
        Charger[Charging Station<br/>ESP32-S3 / LFIC1230700XXX]
        Mower[Robot Mower<br/>Horizon X3 / LFIN2230700XXX]
    end

    App[Novabot App<br/>Flutter v2.3.8/v2.4.0]

    DNS -->|Redirects *.lfibot.com| Server
    App -->|HTTP REST API| Server
    App -->|MQTT port 1883| Server
    App <-->|BLE GATT| Charger
    App <-->|BLE GATT| Mower
    Charger -->|MQTT plain JSON| Server
    Mower -->|MQTT AES-128-CBC| Server
    Charger <-->|LoRa 433MHz| Mower
    Server -->|Socket.io| Dashboard
    Server -->|MQTT auto-discovery| HA
    Dashboard -->|HTTP REST| Server

    Cloud -.->|Replaced by local server| Server
    MQTT_Cloud -.->|Replaced by local broker| Server
```

## Communication Layers

```mermaid
graph LR
    subgraph "App ↔ Server"
        A1[HTTP REST<br/>Port 3000]
        A2[MQTT<br/>Port 1883]
    end

    subgraph "Server ↔ Dashboard"
        B1[HTTP REST<br/>Port 3000]
        B2[Socket.io<br/>WebSocket]
    end

    subgraph "Charger ↔ Server"
        C1[MQTT Plain JSON<br/>Port 1883]
    end

    subgraph "Mower ↔ Server"
        D1[MQTT AES-128-CBC<br/>Port 1883]
        D2[HTTP Uploads<br/>Port 3000]
    end

    subgraph "Charger ↔ Mower"
        E1[LoRa 433MHz<br/>Binary packets]
        E2[RTK GPS Relay<br/>NMEA via LoRa]
    end
```

## Technology Stack

### Server (`novabot-server/`)

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js + TypeScript (ESM modules) |
| HTTP | Express.js |
| MQTT Broker | Aedes (port 1883) |
| WebSocket | Socket.io |
| Database | better-sqlite3 (WAL mode) |
| Auth | JWT (jsonwebtoken + bcrypt) |

### Dashboard (`novabot-dashboard/`)

| Layer | Technology |
|-------|-----------|
| Framework | React 18 + TypeScript |
| Build tool | Vite |
| Styling | Tailwind CSS |
| Maps | Leaflet + PDOK aerial imagery |
| Real-time | Socket.io client |

### DNS (`novabot-dns/`)

| Layer | Technology |
|-------|-----------|
| Container | Alpine Linux (~8MB image) |
| DNS | dnsmasq |
| Purpose | Redirect `*.lfibot.com` → local server IP |

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
| `robot_messages` | Device → user messages |
| `work_records` | Mowing session history |
| `equipment_lora_cache` | Cached LoRa parameters (survives unbind) |
| `ota_versions` | OTA firmware versions |
| `map_calibration` | Manual map offset/rotation/scale per mower |
| `dashboard_schedules` | Dashboard mowing schedules (CRUD + MQTT push) |
