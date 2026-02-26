# Flow: OTA Firmware Update

```mermaid
sequenceDiagram
    participant App
    participant Server as Local Server
    participant Charger
    participant Mower
    participant Cloud as Alibaba OSS

    rect rgb(240, 248, 255)
        Note over App,Cloud: Phase 1: Version Check
        App->>Charger: MQTT: ota_version_info
        Charger-->>App: ota_version_info_respond<br/>{mower: "v5.7.1", charger: "v0.3.6", mcu: "v3.5.8"}

        App->>Server: GET checkOtaNewVersion?version=v0.3.6
        App->>Server: POST queryNewVersion
    end

    rect rgb(255, 248, 240)
        Note over App,Cloud: Phase 2: Charger OTA
        Note over App: "Are you sure to upgrade?<br/>Expected to take 20-30 minutes"
        App->>Charger: MQTT: ota_upgrade_cmd {url, version}
        Note over Charger: Handled locally (no LoRa relay)
        Charger->>Cloud: HTTPS GET firmware binary
        Note over Cloud: novabot-oss.oss-accelerate.aliyuncs.com<br/>/novabot-file/lfi-charging-station_lora-*.bin

        loop Download progress
            Charger->>App: ota_upgrade_state {progress: 45%, state: "downloading"}
        end

        Charger->>Charger: Write to inactive OTA partition
        Charger->>Charger: Switch boot partition (otadata)
        Charger->>Charger: Reboot

        Charger->>App: ota_upgrade_state {state: "completed"}
    end

    rect rgb(240, 255, 240)
        Note over App,Cloud: Phase 3: Mower OTA (optional)
        Note over App: "The charging station can also be upgraded.<br/>Would you like to proceed?"
        App->>Mower: MQTT: ota_upgrade_cmd {url, version}
        Mower->>Cloud: HTTPS GET firmware .deb package
        Note over Cloud: novabot-oss.oss-us-east-1.aliyuncs.com<br/>/novabot-file/lfimvp-*.deb

        loop Download progress
            Mower->>App: ota_upgrade_state {progress, state}
        end

        Mower->>Mower: dpkg -i firmware.deb
        Mower->>Mower: Restart ROS 2 services
    end
```

## OTA Download URLs

| Device | URL Pattern |
|--------|------------|
| Charger | `https://novabot-oss.oss-accelerate.aliyuncs.com/novabot-file/lfi-charging-station_lora-{timestamp}.bin` |
| Mower | `https://novabot-oss.oss-us-east-1.aliyuncs.com/novabot-file/lfimvp-{date}{version}-{timestamp}.deb` |

## Known Firmware Versions

| Device | Version | Size | Notes |
|--------|---------|------|-------|
| Charger | v0.3.6 (active) | 1.4 MB | ESP32-S3, ESP-IDF v4.4.2 |
| Charger | v0.4.0 (inactive) | 1.4 MB | Adds AES MQTT encryption |
| Mower | v5.7.1 | 35 MB | Debian/ROS 2, Horizon X3 |
| MCU | v3.5.8 | — | STM32F407 motor controller |

## Charger OTA Partition Scheme

```mermaid
graph LR
    OTAData[otadata<br/>ota_seq = 7] -->|"(7-1) % 2 = 0"| OTA0[ota_0: v0.3.6<br/>ACTIVE]
    OTAData -.-> OTA1[ota_1: v0.4.0<br/>inactive]

    style OTA0 fill:#9f9,stroke:#333
    style OTA1 fill:#ddd,stroke:#333
```

After OTA, the charger writes the new firmware to the **inactive** partition and updates `otadata` to boot from it.
