# Flow: Charger Provisioning

Complete flow from unboxing to operational charger.

```mermaid
sequenceDiagram
    actor User
    participant App as Novabot App
    participant BLE as Charger (BLE)
    participant WiFi as Charger (WiFi)
    participant MQTT as Local MQTT Broker
    participant API as Local Server

    rect rgb(240, 248, 255)
        Note over User,API: Phase 1: BLE Provisioning
        User->>App: Enter charger SN (LFIC...)
        User->>App: Enter home WiFi SSID + password

        App->>BLE: BLE Scan for "CHARGER_PILE"
        App->>BLE: BLE Connect
        App->>BLE: GATT Discover Services (UUID 0x1234)
        App->>BLE: Subscribe to Char 0x2222 Notify

        App->>BLE: get_signal_info
        BLE-->>App: {wifi: 0, rtk: 17}
        Note over App: Show: WiFi=Strong, GPS=Strong
    end

    rect rgb(255, 248, 240)
        Note over User,API: Phase 2: Configuration
        User->>App: Click "Next"

        App->>BLE: set_wifi_info {sta: {ssid, passwd}, ap: {SN, "12345678"}}
        BLE-->>App: {result: 0}

        App->>BLE: set_mqtt_info {addr: "mqtt.lfibot.com", port: 1883}
        BLE-->>App: {result: 0}

        App->>BLE: set_lora_info {addr: 718, channel: 16, hc: 20, lc: 14}
        BLE-->>App: {value: 15} ← assigned channel!

        App->>BLE: set_rtk_info
        BLE-->>App: {result: 0}

        App->>BLE: set_cfg_info (commit)
        BLE-->>App: {result: 0}
    end

    rect rgb(240, 255, 240)
        Note over User,API: Phase 3: WiFi + MQTT Connection
        Note over BLE,WiFi: Charger disconnects BLE,<br/>connects to home WiFi
        WiFi->>MQTT: MQTT CONNECT (clientId: ESP32_XXXXXX)
        MQTT-->>WiFi: CONNACK
        WiFi->>MQTT: SUBSCRIBE Dart/Send_mqtt/LFIC1230700XXX
        WiFi->>MQTT: PUBLISH Dart/Receive_mqtt/LFIC1230700XXX<br/>{up_status_info: ...}
    end

    rect rgb(255, 240, 255)
        Note over User,API: Phase 4: Equipment Registration
        App->>API: POST getEquipmentBySN {sn: "LFIC1230700XXX"}
        API-->>App: {macAddress, chargerAddress: 718, account, password}

        App->>API: POST bindingEquipment {chargerSn, chargerChannel: 15}
        API-->>App: {value: null}

        App->>API: POST userEquipmentList
        API-->>App: Charger in device list ✓
    end
```

## Key Observations

1. **chargerChannel** = value from `set_lora_info_respond` (15), NOT the requested channel (16)
2. **set_mqtt_info** sends NO credentials — charger v0.3.6 doesn't use MQTT auth
3. **Charger AP password** is always `12345678`
4. After provisioning, charger tries both plain MQTT (1883) and TLS (fails with "Connection reset")
