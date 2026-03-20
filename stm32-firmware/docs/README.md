# Open-Source STM32F407 Firmware — Novabot Mower

Open-source replacement firmware for the STM32F407VGT6 motor controller
in the Novabot robotic mower.

## Architecture

The STM32 handles all low-level motor control, sensor reading, and
communication relay. It talks to the X3 SoC (Horizon Robotics, runs ROS 2)
via USB serial (`/dev/ttyACM*` on X3 side, USART1 on STM32 side).

```
┌─────────────┐    USART1/USB    ┌─────────────┐
│   STM32F407 │ ◄──────────────► │   X3 SoC    │
│  (this fw)  │   serial protocol│  (ROS 2)    │
│             │                  │             │
│ • Motors    │    UART5         │ • Navigation│
│ • IMU       │ ◄── UM960 GPS   │ • Planning  │
│ • Hall (14) │                  │ • MQTT      │
│ • ADC       │    USART3        │ • Camera    │
│ • Display   │ ◄── LoRa (DTS)  │ • AI        │
└─────────────┘                  └─────────────┘
```

## Serial Protocol

Frame format (both directions):
```
[02 02] [CMD_HI CMD_LO] [PAYLOAD_LEN] [PAYLOAD ... CRC8] [03 03]
```

- **X3 → STM32**: `cmd_id = 0x07FF`, sub-command in `payload[0]`
- **STM32 → X3**: `cmd_id = 0x0001` or `0x0002`, sub-command in `payload[0]`
- **CRC-8**: ITU-T polynomial 0x07, init 0x00

Full protocol specification: `research/chassis_serial_protocol.md`

## Hardware

| Component | Details |
|-----------|---------|
| MCU | STM32F407VGT6 (168 MHz, Cortex-M4F, 1MB Flash, 192KB RAM) |
| Wheel motors | TIM1, 50 kHz PWM, 4 channels (2 per wheel: fwd/rev) |
| Blade motor | TIM8, 84 kHz PWM |
| Lift motor | TIM8, 25 kHz PWM |
| IMU | ICM-20602 (I2C1, addr 0x68) — 6-axis accel/gyro |
| Magnetometer | BMM150 (I2C1, addr 0x10) — 3-axis |
| GPS | UM960 RTK (UART5, 115200 baud) |
| LoRa | DTS module (USART3, 115200 baud) — charger communication |
| Display | Color LCD (SPI2) |
| Hall sensors | 14 total (4 collision, 2 uplift, 2 key, 3 blade, 3 other) |
| ADC | Battery voltage, motor currents, adapter voltage |

## Building

Requires [PlatformIO](https://platformio.org/):

```bash
cd stm32-firmware
pio run                    # Build
pio run -t upload          # Flash via ST-Link
pio device monitor         # Serial monitor
```

## Status

**Early development** — project skeleton with verified protocol implementation.

Working:
- Serial protocol frame parser + builder (verified against OEM binary)
- CRC-8 lookup table (identical to OEM firmware)
- All sub-command definitions (35+ receive, 18+ send)
- Motor PWM timer configuration
- IMU + magnetometer I2C drivers
- GPS UART relay

TODO (needs PCB verification):
- GPIO pin assignments for motor direction, Hall sensors, ADC channels
- Motor direction control (GPIO + PWM, not complementary)
- LCD controller identification (likely ST7789 or ILI9341)
- LoRa module protocol framing
- IAP firmware update (CRC-32 + 8-step protocol)
- IEC 60335 Class B safety checks (dual watchdog, RAM test, Flash CRC)

## References

- `research/chassis_serial_protocol.md` — Complete serial protocol
- `research/STM32_firmware_feasibility_analysis.md` — Hardware analysis
- `charger-firmware/` — ESP32-S3 charger firmware (similar project)
