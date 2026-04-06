# Charger Provisioning Flow

## Prerequisites

- Charger powered on (DC24-30V)
- Charger NOT connected to WiFi/MQTT (must be in provisioning mode)
- Phone Bluetooth enabled
- Charger serial number known (e.g., `LFIC1230700XXX`)

## BLE Device

| Property | Value |
|----------|-------|
| BLE Name | `CHARGER_PILE` |
| BLE MAC | `48:27:E2:1B:A4:0A` |
| Service UUID | `0x1234` |
| Command Characteristic | `0x2222` |

## Step-by-Step Flow

!!! danger "CRITICAL: `set_wifi_info` MUST be the first command"
    The charger has an internal state machine that switches from "provisioning" mode to "info" mode after receiving `get_signal_info`. If `get_signal_info` is sent first, the charger ignores subsequent configuration commands. Always send `set_wifi_info` before any other command.

```mermaid
sequenceDiagram
    participant User
    participant App
    participant Charger as Charger (BLE)
    participant Server as Local Server
    participant Cloud as Cloud API

    User->>App: Enter charger SN
    User->>App: Enter home WiFi credentials
    App->>Charger: BLE Connect (CHARGER_PILE)
    App->>Charger: Discover Services

    Note over App,Charger: Configuration (set_wifi_info MUST be first!)
    App->>Charger: set_wifi_info {sta + ap}
    Charger-->>App: set_wifi_info_respond {result: 0}

    App->>Charger: set_rtk_info
    Charger-->>App: set_rtk_info_respond {result: 0}

    App->>Charger: set_lora_info {addr, channel, hc, lc}
    Charger-->>App: set_lora_info_respond {value: 15}
    Note over App: Save assigned channel (15)

    App->>Charger: set_mqtt_info {addr, port}
    Charger-->>App: set_mqtt_info_respond {result: 0}

    App->>Charger: set_cfg_info (commit)
    Charger-->>App: set_cfg_info_respond {result: 0}

    Note over Charger: Disconnects BLE<br/>Reconnects WiFi + MQTT

    Note over App,Server: Equipment Registration
    App->>Server: POST getEquipmentBySN {sn}
    Server-->>App: {macAddress, chargerAddress, account, password}

    App->>Server: POST bindingEquipment {chargerSn, chargerChannel: 15}
    Server-->>App: {value: null}

    App->>Server: POST userEquipmentList
    Server-->>App: Charger appears in device list
```

## BLE Command Sequence

!!! danger "CRITICAL: `set_wifi_info` MUST be the first command"
    The charger has an internal state machine that switches from "provisioning" mode to "info" mode after receiving `get_signal_info`. Sending `get_signal_info` first causes the charger to ignore all subsequent configuration commands.

| Step | Command | Key Data |
|------|---------|----------|
| 1 | `set_wifi_info` | **MUST be first** -- `sta` (home WiFi) + `ap` (charger AP, passwd=12345678) |
| 2 | `set_rtk_info` | RTK GPS configuration |
| 3 | `set_lora_info` | `addr`: 718, `channel`: 16, `hc`: 20, `lc`: 14 |
| 4 | `set_mqtt_info` | `addr`: server IP or hostname, `port`: 1883 |
| 5 | `set_cfg_info` | Commit all settings (value: 1) -- causes reboot |

## After Provisioning

Once `set_cfg_info` is sent:

1. Charger disconnects from BLE
2. Charger connects to home WiFi (STA mode)
3. Charger connects to MQTT broker on port 1883
4. Charger starts publishing `up_status_info` every ~2 seconds
5. `charger_status` changes from 0 to operational values
6. `mower_error` counter starts incrementing (charger looking for mower via LoRa)

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Network configuration error. Please retry." | `set_wifi_info` or `set_mqtt_info` returned error | Check WiFi credentials, check MQTT broker reachable |
| "Network configuration error. Please ensure antenna..." | `set_lora_info` or `set_rtk_info` error | Check antenna connection |
| Charger not appearing in device list | `getEquipmentBySN` returns wrong data | Verify MAC address in device_registry matches BLE MAC |
| App can't find CHARGER_PILE | Charger already in operational mode | Power cycle charger to enter provisioning mode |
