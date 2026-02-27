# Charger Firmware (ESP32-S3)

## Overview

| Property | Value |
|----------|-------|
| MCU | ESP32-S3-WROOM (Xtensa LX7, dual core, 240MHz) |
| Flash | 8MB (GigaDevice GD25Q64) |
| ESP-IDF | v4.4.2-dirty |
| Active firmware | v0.3.6 (ota_0) |
| Inactive firmware | v0.4.0 (ota_1) |
| Architecture | **MQTT ↔ LoRa bridge** |

The charger does NOT execute mowing commands itself — it translates MQTT JSON to binary LoRa packets and vice versa.

## Partition Table

| Partition | Type | Offset | Size | Status |
|-----------|------|--------|------|--------|
| nvs | data | 0x0D000 | 32KB | NVS storage |
| fctry | data | 0x15000 | 16KB | Factory data |
| log_status | data | 0x19000 | 16KB | Log status |
| otadata | data | 0x1D000 | 8KB | OTA boot selection |
| phy_init | data | 0x1F000 | 4KB | PHY calibration |
| **ota_0** | app | 0x20000 | 1856KB | **v0.3.6 (ACTIVE)** |
| ota_1 | app | 0x1F0000 | 1856KB | v0.4.0 (inactive) |
| coredump | data | 0x3C0000 | 64KB | Core dump |
| log_info | data | 0x3D0000 | 64KB | Log info |
| reserved | data | 0x3E0000 | 128KB | Reserved |

OTA boot state: `ota_seq = 7` → `(7-1) % 2 = 0` → **ota_0 is active**.

## NVS Storage

### `"fctry"` namespace (factory data)

| Key | Type | Description |
|-----|------|-------------|
| `sn_code` | string | Serial number |
| `sn_flag` | u8 | SN configured flag |

### `"storage"` namespace (runtime config)

| Key | Type | Size | Description |
|-----|------|------|-------------|
| `wifi_data` | blob | 96 bytes | STA WiFi: SSID (32b) + password (64b) |
| `wifi_ap_data` | blob | 96 bytes | AP WiFi: SSID (32b) + password (64b) |
| `mqtt_data` | blob | 32 bytes | MQTT host (30b) + port (2b, offset 0x1e) |
| `lora_data` | blob | 4 bytes | LoRa addr (2b) + channel (1b) |
| `lora_hc_lc` | blob | 2 bytes | LoRa hc (1b) + lc (1b) |
| `rtk_data` | blob | 40 bytes | RTK position: lat(8b)+NS(1b)+lon(8b)+EW(1b)+alt(8b) |
| `cfg_flag` | u8 | 1 byte | Configuration committed flag |

## FreeRTOS Tasks

| Task | Function | Description |
|------|----------|-------------|
| `mqtt_config_task` | `FUN_4200f078` | MQTT connect, publish loop, command dispatch |
| `lora_config_task` | `FUN_4200b8b8` | LoRa communication, channel scan, heartbeat |
| `advanced_ota_example_task` | `FUN_4205d060` | OTA firmware download |

## MQTT Implementation

| Property | Value |
|----------|-------|

!!! lock "Private section"
    This section contains sensitive security details (encryption keys, credentials,
    vulnerability specifics) and is only available in the private wiki.

| Port | 1883 |
| Client ID | Serial number |
| **No username/password** | Charger v0.3.6 sends no credentials |
| Publish topic | `Dart/Receive_mqtt/<SN>` (QoS 0) |
| Subscribe topic | `Dart/Send_mqtt/<SN>` (QoS 1) |
| Publish interval | ~2 seconds (`up_status_info`) |


!!! lock "Private section"
    This section contains sensitive security details (encryption keys, credentials,
    vulnerability specifics) and is only available in the private wiki.


## Firmware v0.4.0 — Differences from v0.3.6

The only significant difference is the addition of **AES-128-CBC encryption for ALL MQTT messages**.


!!! lock "Private section"
    This section contains sensitive security details (encryption keys, credentials,
    vulnerability specifics) and is only available in the private wiki.


---

## Ghidra Decompilation

Decompiled with Ghidra 12.0.3 (headless, Xtensa processor).
Custom `esp32s3_to_elf.py` script to convert ESP32-S3 app image to ELF.

| File | Description |
|------|-------------|
| `research/charger_ota0_v0.3.6.elf` | ELF for Ghidra v0.3.6 (1.4MB) |
| `research/charger_ota1_v0.4.0.elf` | ELF for Ghidra v0.4.0 (1.4MB) |
| `research/ghidra_output/charger_v036_decompiled.c` | v0.3.6: 7405 functions (7.6MB, 296K lines) |
| `research/ghidra_output/charger_v040_decompiled.c` | v0.4.0: with AES encryption (7.6MB) |

### cJSON Function Mapping

| Firmware Address | cJSON Function |
|-----------------|---------------|
| `FUN_42062380` | `cJSON_CreateObject()` |
| `FUN_42062208` | `cJSON_ParseWithLength()` |
| `FUN_42062220` | `cJSON_Print()` |
| `FUN_42062234` | `cJSON_GetObjectItem()` |
| `FUN_42062300` | `cJSON_AddNumberToObject()` |
| `FUN_42062358` | `cJSON_AddStringToObject()` |
| `FUN_42061d54` | `cJSON_Delete()` |
| `PTR_FUN_420013d4` | `cJSON_IsNull()` (v0.4.0) |
