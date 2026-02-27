# Security Analysis

## Overview

This page documents all security vulnerabilities and weaknesses discovered during reverse engineering of the Novabot charger (ESP32-S3) and mower (Horizon X3) firmware, the cloud API, and the mobile app.

!!! warning "Responsible Disclosure"
    These findings are documented for research and local-operation purposes. The goal is to understand the system, not to exploit it maliciously. The Novabot cloud is no longer actively maintained for these devices.

---

## Severity Classification

| Severity | Count | Description |
|----------|-------|-------------|
| **Critical** | 5 | Direct remote code execution or full device takeover |
| **High** | 8 | Authentication bypass, data exposure, or significant control |
| **Medium** | 6 | Limited impact or requires local network access |
| **Low/Info** | 6 | Design weaknesses or challenges |

---

## Critical Vulnerabilities

### 1. No MQTT Authentication on OTA Commands

| Property | Value |
|----------|-------|
| **Affected** | Mower + Charger |
| **Vector** | Network (MQTT) |
| **Impact** | Arbitrary firmware installation |

Any MQTT message published to `Dart/Send_mqtt/<SN>` containing `ota_upgrade_cmd` triggers a firmware download and installation. There is **no sender authentication**, no command signing, and no user confirmation required on the device side.

**Attack scenario:** An attacker on the same MQTT broker can push malicious firmware to any device by knowing its serial number (which is broadcast in MQTT topics).

### 2. No Code Signing on Firmware

| Property | Value |
|----------|-------|
| **Affected** | Mower + Charger |
| **Vector** | Network (OTA) |
| **Impact** | Malicious firmware execution |

Firmware integrity is verified only by **MD5 checksum** — no digital signatures, no certificate pinning, no secure boot chain. An attacker who can modify the download URL can serve arbitrary firmware.

<!-- PRIVATE -->
### 3. `system` OTA Upgrade Type — Remote Code Execution

| Property | Value |
|----------|-------|
| **Affected** | Mower |
| **Vector** | Network (MQTT) |
| **Impact** | Arbitrary command execution as root |

The `ota_client_node` supports a `type: "system"` upgrade that executes:

```bash
sudo apt-get update && sudo apt full-upgrade && sleep 2 && reboot -f
```

If the mower's APT sources were modified (via compromised DNS, man-in-the-middle, or a malicious firmware update), this would allow **arbitrary code execution** as root.

### 4. UART Debug Console Without Authentication (Charger)

| Property | Value |
|----------|-------|
| **Affected** | Charger (ESP32-S3) |
| **Vector** | Physical (UART) |
| **Impact** | Full device control |

The charger firmware has a UART debug console on UART0 (115200 baud) that accepts single-character commands **without any authentication**:

| Command | Action |
|---------|--------|
| `SN_SET,<sn>,<mqtt>` | Change serial number + MQTT server |
| `d` | **Erase ALL NVS partitions** + reboot |
| `@` | Erase factory NVS + reboot |
| `b` | Switch to other OTA partition |
| `o` | Trigger OTA update |

Physical access to the 4-pin UART header (GND, TX, RX, 3V3) gives complete control over the device.

### 5. Download URL Not Validated in OTA

| Property | Value |
|----------|-------|
| **Affected** | Mower + Charger |
| **Vector** | Network (MQTT) |
| **Impact** | Firmware from arbitrary source |

The `downloadUrl` in `ota_upgrade_cmd` is used directly by libcurl (mower) or `esp_https_ota` (charger) without validation. It can point to any HTTP/HTTPS server. Combined with #1, this allows flashing firmware from a completely untrusted source.
<!-- /PRIVATE -->

---

## High Severity

### 6. No MQTT Broker Authentication

| Property | Value |
|----------|-------|
| **Affected** | All devices |
| **Vector** | Network |
| **Impact** | Command injection, eavesdropping |

The charger firmware (v0.3.6) uses **no username or password** for MQTT connections. The mower uses its serial number as client ID. Any device on the network can connect to the MQTT broker and:

- Subscribe to all device topics
- Publish commands to any device
- Intercept status reports

<!-- PRIVATE -->
### 7. Weak AES Key Derivation

| Property | Value |
|----------|-------|
| **Affected** | Mower MQTT, Charger v0.4.0 MQTT |
| **Vector** | Network |
| **Impact** | Decryption of all MQTT traffic |

The AES-128-CBC encryption uses a **predictable key**: `"abcdabcd1234" + SN[-4:]` with a **static IV**: `"abcd1234abcd1234"`.

Weaknesses:

- Key prefix is hardcoded (`abcdabcd1234`) — only 4 characters vary
- IV is static (same IV for every message = CBC IV reuse)
- Serial numbers are public (in MQTT topics, BLE advertisements, product labels)
- Null-byte padding instead of PKCS7
- Key is trivially derivable from the serial number
<!-- /PRIVATE -->

### 8. WiFi Credentials Stored in Plaintext

| Property | Value |
|----------|-------|
| **Affected** | Charger + Mower |
| **Vector** | Physical / firmware dump |
| **Impact** | Home WiFi credential theft |

WiFi SSID and password are stored in plaintext in NVS (charger) and `json_config.json` (mower). The charger also prints WiFi credentials to the UART debug log during boot.

### 9. Cloud Stores WiFi Passwords in Plaintext

| Property | Value |
|----------|-------|
| **Affected** | Cloud API |
| **Vector** | API access |
| **Impact** | Home WiFi credential exposure |

The cloud API returns WiFi credentials (`wifiName`, `wifiPassword`) in the `userEquipmentList` response. These are stored server-side in plaintext and accessible to anyone with the user's API token.

### 10. BLE Provisioning Without Secure Pairing

| Property | Value |
|----------|-------|
| **Affected** | Charger + Mower |
| **Vector** | BLE radio range (~10m) |
| **Impact** | Device reconfiguration |

BLE provisioning commands (`set_wifi_info`, `set_mqtt_info`, `set_lora_info`) can redirect a device to a different MQTT broker or WiFi network. The charger uses a static BLE passkey; the mower uses no pairing at all for provisioning.

### 11. Charger HTTP OTA Without TLS

| Property | Value |
|----------|-------|
| **Affected** | Charger (via mower relay) |
| **Vector** | Local network |
| **Impact** | Firmware interception/modification |

The mower pushes charger firmware via HTTP (not HTTPS) to `192.168.4.1`. A man-in-the-middle on the local network could intercept and modify the firmware in transit.

### 12. No Rate Limiting on MQTT Commands

| Property | Value |
|----------|-------|
| **Affected** | All devices |
| **Vector** | Network |
| **Impact** | Device denial of service |

There is no rate limiting on MQTT command processing. Flooding a device with commands could cause resource exhaustion or unpredictable behavior.

### 13. Mower Runs as Root

| Property | Value |
|----------|-------|
| **Affected** | Mower |
| **Vector** | Any code execution |
| **Impact** | Full system compromise |

All ROS 2 nodes on the mower run as `root`. There is no privilege separation, no sandboxing, and no AppArmor/SELinux profiles. Any exploitable bug in any ROS node gives full system access.

---

## Medium Severity

### 14. Static MQTT Credentials for Charger

| Property | Value |
|----------|-------|
| **Affected** | Charger (cloud broker) |
| **Vector** | API response capture |

<!-- PRIVATE -->
The cloud returns static MQTT credentials (`li9hep19` / `jzd4wac6`) for ALL chargers. These credentials are the same for every device and appear in every `getEquipmentBySN` and `userEquipmentList` response.
<!-- /PRIVATE -->

The cloud returns identical MQTT credentials for all chargers — one compromised credential set exposes all chargers on the cloud broker.

<!-- PRIVATE -->
### 15. Hardcoded Fallback IP in Charger

| Property | Value |
|----------|-------|
| **Affected** | Charger |
| **Vector** | DNS failure |

The charger firmware contains a hardcoded fallback MQTT URI: `mqtt://47.253.57.111` (Alibaba Cloud). If DNS resolution fails, the charger falls back to this IP. An attacker who gains control of this IP can intercept all charger traffic.
<!-- /PRIVATE -->

### 16. ESP-IDF Example Code as Foundation

| Property | Value |
|----------|-------|
| **Affected** | Charger |
| **Vector** | Code quality |

The charger firmware is built on ESP-IDF example projects (`SEC_GATTS_DEMO`, `MQTT_EXAMPLE`, `advanced_ota_example_task`) with minimal custom security hardening. Default configurations and example patterns may contain known weaknesses.

### 17. TLS Attempted But Fails

| Property | Value |
|----------|-------|
| **Affected** | Charger |
| **Vector** | Network |

The charger attempts TLS MQTT connections (mbedTLS stack present) but they fail with `Connection reset by peer`. The device falls back to unencrypted TCP. This suggests TLS was intended but never successfully deployed.

### 18. Predictable Serial Number Format

| Property | Value |
|----------|-------|
| **Affected** | All devices |
| **Vector** | Enumeration |

Serial numbers follow a predictable format (`LFI[C|N]YYMM00XXXX`). Combined with the lack of MQTT authentication, an attacker could enumerate all devices on the cloud broker.

### 19. OTA API Ignores Serial Number

| Property | Value |
|----------|-------|
| **Affected** | Cloud OTA API |
| **Vector** | API |

The `checkOtaNewVersion` API endpoint ignores the `sn` parameter and returns the same firmware version for all devices. This prevents per-device version management and makes targeted rollbacks impossible.

---

## Design Weaknesses & Challenges

### 20. No Remote Access Built-In (Mower)

The mower has no SSH, telnet, VNC, or HTTP server. ROS 2 is restricted to localhost (`ROS_LOCALHOST_ONLY=1`). VNC is explicitly removed during startup (`apt purge -y x11vnc`). Remote access requires physical intervention via UART or HDMI+USB.

### 21. Camera System Has No Remote Streaming

Camera data (dual IMX307 + PMD ToF) is used exclusively for autonomous navigation via ROS 2 topics. There is no RTSP, WebRTC, MJPEG, or P2P streaming capability. The cameras were marketed as a live-view feature but never implemented in software.

### 22. IP56 Waterproofing Complicates Hardware Access

The mower's IP56-rated enclosure makes physical access to debug ports (UART, HDMI, USB) difficult without risking the waterproof seals. The charger's UART header is more accessible.

### 23. Compiled Binaries Cannot Be Easily Modified

~40 ELF binaries and 239 shared libraries in the mower firmware are compiled C++. While shell scripts (575), Python scripts (298), and YAML configs (136) can be modified, the core ROS nodes require the original source code to rebuild.

### 24. LoRa Communication Unencrypted

The LoRa link between charger and mower uses a proprietary binary protocol but with **no encryption or authentication**. Command bytes are sent in cleartext. An attacker with a compatible LoRa radio could inject commands or intercept status data.

### 25. Single-Factor Device Binding

Device binding (`bindingEquipment`) only requires a serial number. There is no device-side confirmation, no physical button press, and no challenge-response. Anyone with a valid SN can bind a device to their account.

---

## Summary Matrix

| # | Finding | Charger | Mower | Cloud | Severity |
|---|---------|:-------:|:-----:|:-----:|----------|
| 1 | No MQTT OTA authentication | x | x | | Critical |
| 2 | No code signing | x | x | | Critical |
| 3 | `system` OTA type = RCE | | x | | Critical |
| 4 | UART console no auth | x | | | Critical |
| 5 | OTA URL not validated | x | x | | Critical |
| 6 | No MQTT broker auth | x | x | | High |
| 7 | Weak AES key derivation | x | x | | High |
| 8 | WiFi plaintext (device) | x | x | | High |
| 9 | WiFi plaintext (cloud) | | | x | High |
| 10 | BLE no secure pairing | x | x | | High |
| 11 | Charger OTA no TLS | x | | | High |
| 12 | No MQTT rate limiting | x | x | | High |
| 13 | Mower runs as root | | x | | High |
| 14 | Static MQTT credentials | x | | x | Medium |
| 15 | Hardcoded fallback IP | x | | | Medium |
| 16 | ESP-IDF example code | x | | | Medium |
| 17 | TLS fails silently | x | | | Medium |
| 18 | Predictable serial numbers | x | x | x | Medium |
| 19 | OTA API ignores SN | | | x | Medium |
| 20 | No remote access | | x | | Info |
| 21 | No camera streaming | | x | | Info |
| 22 | IP56 complicates access | | x | | Info |
| 23 | Compiled binaries | | x | | Info |
| 24 | LoRa unencrypted | x | x | | Info |
| 25 | Single-factor binding | x | x | x | Info |
