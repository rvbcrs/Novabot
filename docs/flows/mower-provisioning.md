# Flow: Mower Provisioning

Complete flow for adding a mower to the system.

```mermaid
sequenceDiagram
    actor User
    participant App as Novabot App
    participant BLE as Mower (BLE)
    participant WiFi as Mower (WiFi)
    participant MQTT as Local MQTT Broker
    participant API as Local Server

    rect rgb(240, 248, 255)
        Note over User,API: Phase 1: BLE Connection
        User->>App: Enter mower SN (or scan QR)
        User->>App: Enter home WiFi credentials

        App->>BLE: BLE Scan for "novabot"
        App->>BLE: BLE Connect
        App->>BLE: get_signal_info
        BLE-->>App: {wifi: 0, rtk: 17}
    end

    rect rgb(255, 248, 240)
        Note over User,API: Phase 2: Configuration (different order!)
        App->>BLE: set_wifi_info {ap: {ssid, passwd}} ← NO sta!
        BLE-->>App: {result: 0}

        App->>BLE: set_lora_info {addr, channel, hc, lc}
        BLE-->>App: {value: null} ← NOT a channel number!

        App->>BLE: set_mqtt_info {addr, port}
        BLE-->>App: {result: 0}

        App->>BLE: set_cfg_info {cfg_value: 1, tz: "Europe/Amsterdam"}
        BLE-->>App: {result: 0}
    end

    rect rgb(240, 255, 240)
        Note over User,API: Phase 3: Connection
        Note over BLE,WiFi: Mower disconnects BLE,<br/>connects to WiFi
        WiFi->>MQTT: MQTT CONNECT (clientId: LFIN..._6688)
        WiFi->>MQTT: PUBLISH (AES-128-CBC encrypted)

        loop Every ~5 seconds
            WiFi->>MQTT: report_state_robot (encrypted)
            WiFi->>MQTT: report_exception_state (encrypted)
            WiFi->>MQTT: report_state_timer_data (encrypted)
        end
    end

    rect rgb(255, 240, 255)
        Note over User,API: Phase 4: Registration
        App->>API: POST getEquipmentBySN {sn: "LFIN..."}
        API-->>App: {macAddress: "50:41:1C:39:BD:C1", account: null, password: null}

        App->>API: POST bindingEquipment {mowerSn, chargerSn}
        API-->>App: {value: null}
    end
```

## Key Differences from Charger

| Aspect | Charger | Mower |
|--------|---------|-------|
| WiFi config | `sta` + `ap` | **Only `ap`** |
| RTK config | `set_rtk_info` sent | **Not sent** |
| Config commit | `set_cfg_info: 1` | `set_cfg_info: {cfg_value: 1, tz: "..."}` |
| LoRa response | Channel number | `null` |
| MQTT messages | Plain JSON | AES-128-CBC encrypted |
| Cloud credentials | `account`/`password` present | `null`/`null` |
