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
<!-- PRIVATE -->
| Fallback URI | `mqtt://47.253.57.111` |
<!-- /PRIVATE -->
| Port | 1883 |
| Client ID | Serial number |
| **No username/password** | Charger v0.3.6 sends no credentials |
| Publish topic | `Dart/Receive_mqtt/<SN>` (QoS 0) |
| Subscribe topic | `Dart/Send_mqtt/<SN>` (QoS 1) |
| Publish interval | ~2 seconds (`up_status_info`) |

<!-- PRIVATE -->
## UART Debug Console

!!! danger "No authentication"
    The UART debug console has **no authentication**. Full factory access via single-character commands.

| Command | Action |
|---------|--------|
| `SN_GET` | Read serial number from NVS |
| `SN_SET,<sn>,<mqtt>` | Change SN + redirect MQTT to dev server |
| `LORARSSI_<data>` | Parse LoRa RSSI data |
| `v` | Print firmware version |
| `a` / `m` / `f` | RTK GPS mode: auto / manual / factory |
| `o` | Trigger OTA firmware update |
| `w` | WiFi reconnect |
| `d` | **Erase ALL NVS partitions** + reboot |
| `@` | **Erase factory NVS** + reboot |
| `r` | Reboot |
| `b` | **Switch to other OTA partition** + reinitialize |

## Security Findings

1. **No MQTT authentication** — charger v0.3.6 uses no username/password
2. **No AES encryption in v0.3.6** — charger sends plain JSON (unlike mower). **v0.4.0 adds AES-128-CBC encryption**
3. **WiFi passwords in plaintext** in NVS, printed to UART debug log
4. **UART console without authentication** — full factory access
5. **Static BLE passkey** — BLE pairing with static passkey
6. **Hardcoded fallback IP** — `47.253.57.111` (Alibaba Cloud)
7. **ESP-IDF example code** — built on ESP-IDF examples, minimal custom security
8. **TLS attempted but fails** — mbedTLS present, but TLS MQTT connections fail
<!-- /PRIVATE -->

## Firmware v0.4.0 — Differences from v0.3.6

The only significant difference is the addition of **AES-128-CBC encryption for ALL MQTT messages**.

<!-- PRIVATE -->
### AES Encryption (new in v0.4.0)

| Property | Value |
|----------|-------|
| Algorithm | AES-128-CBC (same as mower) |
| Key formula | `"abcdabcd1234" + SN[-4:]` (16 bytes UTF-8) |
| IV | `"abcd1234abcd1234"` (static) |
| Padding | Null-byte padding to 16-byte boundary (NOT PKCS7) |
| Direction | **Both**: publish (encrypt) AND subscribe (decrypt) |

### MQTT_EVENT_DATA Handler (v0.4.0)

1. Check `mqtt_rec_data_flag` — if already 1, skip (previous message still being processed)
2. Length validation: `>0`, `<1024`, `%16==0` (AES block size check)
3. AES-128-CBC decrypt with key `"abcdabcd1234" + SN[-4:]`
4. Set `mqtt_rec_data_flag = 1` and signal FreeRTOS queue

### Command Value Validation — cJSON_IsNull (CRITICAL)

!!! danger "v0.4.0 expects `null` values, not `0` or `{}`"
    The v0.4.0 command processor uses `cJSON_IsNull()` to validate certain command values.
    Commands like `get_lora_info` and `ota_version_info` **must** have a JSON `null` value,
    not a numeric `0` or empty object `{}`.

```c title="Decompiled command processor (FUN_4200e8c4)"
// get_lora_info handler:
item = cJSON_GetObjectItem(root, "get_lora_info");
if (item != NULL) {
    if (cJSON_IsNull(item) == 1) {  // Only proceeds if value IS null
        printf("get_lora_info null");
        // Build and publish LoRa info response
    }
    // If value is 0, {}, or anything else → silently skipped!
}

// ota_version_info handler — same pattern:
item = cJSON_GetObjectItem(root, "ota_version_info");
if (item != NULL) {
    if (cJSON_IsNull(item) == 1) {
        printf("ota_version_info null");
        // Build and publish version info response
    }
}
```

**Correct command syntax for v0.4.0:**

```json title="Commands expecting null value"
{"get_lora_info": null}
{"ota_version_info": null}
```

```json title="Commands expecting object value"
{"ota_upgrade_cmd": {"type":"full","content":{"upgradeApp":{"version":"...","downloadUrl":"...","md5":"..."}}}}
```

### Firmware Patching

Patched firmware available: `research/firmware/charger_v0.4.0_patched.bin` (MD5: `538f01c8412a7d9936d1de9c298f8918`)

- `mqtt-dev.lfibot.com` → `novabot.ramonvanbruggen.nl`
- `mqtt://47.253.57.111` → `mqtt://novabot.ramonvanbruggen.nl`
- SHA256 hash updated and verified
<!-- /PRIVATE -->

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
