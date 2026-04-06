# ESP32 OTA Provisioning Tool

The Nova-OTA Device is a standalone ESP32-S3 tool with a 3.5" touchscreen that provisions Novabot chargers and mowers, flashes custom firmware via OTA, and re-provisions devices to your home WiFi. No computer or phone needed — everything happens on the device itself.

## Hardware

### Required

| Component | Model | Purpose |
|-----------|-------|---------|
| **ESP32-S3 Board** | JC3248W535EN | Main controller with 3.5" QSPI display |
| **SD Card** | Any microSD | Stores firmware `.deb` files for OTA |
| **USB-C Cable** | — | Initial firmware flash + serial monitor |

### JC3248W535EN Specifications

- **Processor**: ESP32-S3 (240 MHz, dual-core)
- **Display**: 3.5" 320x480 QSPI (AXS15231B)
- **Touch**: Capacitive I2C (CST816D)
- **Memory**: 8 MB PSRAM, 8 MB Flash
- **Storage**: SD card via SD_MMC (1-bit mode)
- **WiFi**: 2.4 GHz b/g/n (AP + STA simultaneous)
- **Bluetooth**: BLE 5.0 (NimBLE)

## Initial Flash (USB)

### Prerequisites

- [PlatformIO](https://platformio.org/install) installed (VS Code extension or CLI)
- USB-C cable connected to the JC3248W535EN board

### Build and Flash

```bash
cd firmware/esp32-tool
pio run -e jc3248w535 -t upload
```

This compiles and uploads the firmware via USB. The device boots into the setup wizard.

### Prepare SD Card

1. Format the SD card as FAT32
2. Copy the mower firmware `.deb` file to the SD card root:
   ```
   /mower_firmware_v6.0.2-custom-21.deb
   ```
3. Optionally add charger firmware:
   ```
   /charger_firmware_v0.4.0.bin
   ```
4. Insert the SD card into the JC3248W535EN board

## OTA Updates (WiFi)

After the initial USB flash, you can update the tool itself over WiFi:

### Via PlatformIO CLI

Connect your computer to the `OpenNova-Setup` WiFi network, then:

```bash
pio run -e ota -t upload
```

This uses HTTP upload to flash the ESP32 wirelessly.

### Via Web UI

1. Connect to `OpenNova-Setup` WiFi (password: `12345678`)
2. Open **http://10.0.0.1** in your browser
3. Scroll to "ESP32 Firmware Update"
4. Select a `.bin` file and click "Flash ESP32"
5. The device reboots with the new firmware

### Via Home WiFi

If the tool is connected to your home WiFi (STA mode), you can flash from your normal network:

```bash
pio run -e ota -t upload
# Uses mDNS: nova-ota.local
```

Or open **http://nova-ota.local** in your browser.

## Wizard Flow

The touchscreen guides you through the complete provisioning process:

### Step 1: WiFi Configuration

On first boot (or if no config is saved), enter your home WiFi credentials:

- **SSID**: Tap to type on the on-screen keyboard
- **Password**: Tap to type
- **MQTT Server**: Your OpenNova server IP address

These are saved to NVS (non-volatile storage) and persist across reboots.

!!! tip "Phone entry"
    Connect your phone to `OpenNova-Setup` WiFi and open **http://10.0.0.1/wifi** for a full-size keyboard.

### Step 2: BLE Scan for Charger (Optional)

The tool scans for nearby `CHARGER_PILE` BLE devices.

- If found: select and provision with home WiFi + MQTT
- If not found after 3 scans: skip to mower
- Charger provisioning is **optional** — you can do it later

### Step 3: Device Status

Shows connected devices:

- **Charger**: WiFi → MQTT status (grey → orange → green)
- **Mower**: WiFi → MQTT status
- Firmware version display (if available)

Wait for the mower to appear, or tap **Scan** to find it via BLE.

### Step 4: BLE Scan for Mower

Scans for `Novabot` or `novabot` BLE devices.

- Select your mower from the list
- The tool provisions it with the **tool's own WiFi AP** (not home WiFi yet)
- This is because stock firmware only accepts `mqtt.lfibot.com` — the tool's DNS redirects this to itself

### Step 5: OTA Firmware Flash

If a `.deb` file is on the SD card:

1. Confirm flash — mower must be on the charger
2. The tool sends the OTA command via MQTT
3. Mower downloads the firmware from the tool's HTTP server
4. Progress: 0-62% download, 62-68% unpack, 68-100% install
5. Mower reboots with custom firmware

!!! warning "Keep mower on charger"
    The mower must remain on the charger during OTA. If power is lost during install, the firmware may be corrupted.

**HTTP Range resume**: If the WiFi connection drops during download, the mower automatically resumes from where it left off.

### Step 6: Wait for Reboot

After OTA, the mower reboots (~30 seconds) and reconnects via MQTT. The tool detects the reconnection.

### Step 7: Re-provision to Home WiFi

The final step switches the mower from the tool's AP to your home WiFi:

1. Sends MQTT config (home server IP) via `extended_commands.py`
2. Sends WiFi switch via `nmcli` (triggers immediate WiFi change)
3. Mower disconnects from tool AP and connects to home WiFi

!!! note "MQTT first, WiFi last"
    MQTT config is sent **before** WiFi switch because `nmcli` drops the connection immediately.

### Step 8: Done!

Confetti animation. Tap to restart the wizard for the next device.

## Web UI

Connect to `OpenNova-Setup` WiFi and open **http://10.0.0.1**:

| Feature | Description |
|---------|-------------|
| **Status** | WiFi AP info, connected clients, wizard state |
| **Console** | Live log output (last 50 lines) |
| **Charger** | WiFi + MQTT status, serial number |
| **Mower** | WiFi + MQTT status, serial number |
| **Firmware** | SD card file info, BLE device count |
| **SD Card** | File manager (upload, delete) |
| **ESP32 OTA** | Flash the tool's own firmware |
| **WiFi Config** | Enter home WiFi + MQTT settings |

## SD Card Files

| File | Purpose |
|------|---------|
| `*.deb` | Mower firmware (Debian package, ARM64) |
| `*.bin` | Charger firmware (ESP32-S3 binary) |
| `*.json` | Firmware metadata (optional) |

The tool auto-detects firmware files on boot and extracts the version from the filename (e.g., `mower_firmware_v6.0.2-custom-21.deb` → version `v6.0.2-custom-21`).

## AES Encryption

The tool handles AES-128-CBC encryption for mower communication:

- **Key**: `abcdabcd1234` + last 4 characters of the mower SN
- **IV**: `abcd1234abcd1234` (static)
- **Padding**: Null bytes to 16-byte boundary

The tool auto-detects whether to use plain or encrypted OTA commands:

1. First attempt: plain text
2. If no progress after 30s: retry with AES encryption (v6.x firmware)
3. If both fail: clean OTA cache and reboot mower

## Troubleshooting

### Display shows nothing / white screen

- Check USB-C connection (some cables are charge-only)
- Verify the board is JC3248W535EN (not Waveshare or other)
- Try `pio run -e jc3248w535 -t upload --upload-port /dev/cu.usbmodem*`

### SD card not detected

- Format as **FAT32** (not exFAT or NTFS)
- Insert before powering on
- Check serial monitor: `[SD] SD_MMC mounted` should appear

### BLE scan finds no devices

- Ensure charger/mower is powered on
- Move the tool within 2 meters of the device
- BLE scan runs for ~10 seconds — wait for it to complete
- Restart the tool if BLE hangs

### OTA download stuck or fails

- Verify `.deb` file is on the SD card root (not in a subfolder)
- Check serial monitor for HTTP download progress
- If stuck at 6%: WiFi stability issue — move tool closer to mower
- If "OTA Failed": tool sends `clean_ota_cache` + reboots mower, then retry

### Mower downloads but install fails

- Verify MD5 hash matches (shown in serial monitor)
- Ensure mower is on charger (battery must not die during install)
- Try `clean_ota_cache` via the tool, then retry

### WiFi drops during download

- The tool uses **HTTP Range resume** — download continues from where it stopped
- This is normal on 2.4 GHz with charger nearby (CCMP frame interference)
- Download completes in 10-20 minutes with retries

## Project Structure

```
firmware/esp32-tool/
  src/
    main.cpp           # Setup + main loop (276 lines)
    wizard.cpp         # State machine (660 lines)
    config.h           # Globals + state enum
    mqtt.cpp           # MQTT broker + AES + OTA
    network.cpp        # WiFi AP + DNS + HTTP server + SD
    ble.cpp            # BLE scan + provisioning
    drivers/           # Hardware drivers (display, touch, BSP)
    ui/                # LVGL display screens + fonts + icons
  platformio.ini       # Build config (USB + OTA environments)
  ota_upload.py        # PlatformIO custom OTA upload script
```

## PlatformIO Environments

| Environment | Protocol | Target | Usage |
|-------------|----------|--------|-------|
| `jc3248w535` | USB | `/dev/cu.usbmodem*` | Initial flash |
| `ota` | HTTP | `nova-ota.local` | WiFi update (home network) |
| `ota-ap` | HTTP | `10.0.0.1` | WiFi update (tool's AP) |
