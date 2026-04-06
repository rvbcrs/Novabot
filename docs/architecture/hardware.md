# Hardware

## Charging Station (Base Station)

**Model**: N1000 (TÜV rapport CN23XAMH 001)
**Serial**: `LFIC1230700XXX`
**PCB text**: "LFi Charging Station 20230228", "Little Little World, Big Big Novabot"

| Component | Type | Details |
|-----------|------|---------|
| **MCU** | ESP32-S3-WROOM (QFN56 rev v0.2) | Dual Core + LP Core, 240MHz, 2MB PSRAM |
| **Flash** | 8MB SPI (GigaDevice GD25Q64) | Manufacturer 0xC8, Device 0x4017 |
| **GPS/RTK** | UM960 | Top-right on PCB, with SMA antenna |
| **LoRa** | EBYTE E32/E22 series | SMA antenna, UART1 (TX=GPIO17, RX=GPIO18) |
| **UART** | Header "UART0" on PCB | Pins: 3V3, RX, TX, GND (115200 baud) |
| **Power** | DC24-30V | Via connector at top of PCB |

### MAC Address Allocation

| Interface | MAC | Offset |
|-----------|-----|--------|
| WiFi STA | `48:27:E2:1B:A4:08` | Base (BLE - 2) |
| WiFi AP | `48:27:E2:1B:A4:09` | Base - 1 |
| BLE | `48:27:E2:1B:A4:0A` | Base |

### BLE Advertisement

- Name: `CHARGER_PILE`
- Manufacturer data (0xFF): `66 55 48 27 E2 1B A4 0A 45 53 50`
    - `66 55` = Company ID 0x5566 (ESP)
    - `48:27:E2:1B:A4:0A` = BLE MAC
    - `45 53 50` = "ESP" (ASCII)

---

## Robot Mower

**Model**: N2000 (TÜV rapport CN23XAMH 001)
**Serial**: `LFIN2230700XXX`
**PCB text**: "LFI NOVABOT X3A BOARD VerC PLUS" (2023-02-11)

The mower has **two PCBs**:

### X3A Board (Computing)

| Component | Type | Details |
|-----------|------|---------|
| **SoC** | Horizon Robotics X3 (Sunrise X3) | ARM Cortex-A53 quad-core + BPU AI accelerator |
| **SoM** | X3 System-on-Module | Plug-in module with gold edge connector |
| **WiFi/BLE** | AP6212 (AMPAK/Broadcom BCM43438) | 2.4GHz WiFi + BLE 4.2, PCB antenna via U.FL |
| **OS** | Ubuntu/Debian (ARM64) | ROS 2 Galactic, runs as root |
| **UART** | Header top-left: GND / TX / RX / 3V3 | Serial console, 115200 baud |
| **HDMI** | Micro-HDMI (bottom PCB) | Labeled "DEBUG" |
| **USB** | USB 3.0 port (bottom PCB) | For keyboard, ethernet adapter, or storage |
| **Power** | DC12V barrel jack | |
| **Camera 1** | FPC "RGB CAMERA" (J23) | MIPI CSI-2 → Sony IMX307 front camera |
| **Camera 2** | FPC "TOF+RGB SENSOR" (J25) | Combined ToF + panoramic RGB |
| **Camera 3** | FPC "TOF" | PMD Royale ToF depth camera |

### Motor Board (Drive + RF)

| Component | Type | Details |
|-----------|------|---------|
| **MCU** | STM32F407 | Motor/chassis control (fw: `novabot_stm32f407_v3_5_8`) |
| **GPS** | GPS Module (with shielding) | Top-right on PCB |
| **LoRa** | LoRa Receiver Module | SMA antenna connector |
| **Relays** | 2x blue relays | Motor drive |
| **Connectors** | Red JST headers | Motors, sensors, power |

### MAC Address Allocation

| Interface | MAC | Offset |
|-----------|-----|--------|
| WiFi STA | `50:41:1C:39:BD:BF` | Base (BLE - 2) |
| WiFi AP | `50:41:1C:39:BD:C0` | Base - 1 |
| BLE | `50:41:1C:39:BD:C1` | Base |

### BLE Advertisement

- Name: `Novabot` (or `NOVABOT` in provisioning mode)
- Manufacturer data (0xFF): `66 55 50 41 1C 39 BD C1`
    - `66 55` = Company ID 0x5566 (ESP)
    - `50:41:1C:39:BD:C1` = BLE MAC

### Physical Debug Ports

| Port | Location | Status | Use |
|------|----------|--------|-----|
| UART (GND/TX/RX/3V3) | X3A board, top-left | Available | Root shell, 115200 baud |
| Micro-HDMI "DEBUG" | X3A board, bottom-right | Available | Linux console output |
| USB 3.0 | X3A board, bottom-left | Available | Keyboard, USB-ethernet, storage |

!!! warning "IP56 Waterproofing"
    The mower is IP56 waterproof. Open carefully to avoid damaging rubber gaskets/O-rings.
