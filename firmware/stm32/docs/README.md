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
│ • LED       │                  │             │
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
| Display | **ST7789V** 240x320 color LCD (SPI2, RGB565, 60Hz) |
| Hall sensors | 14 total (4 collision, 2 uplift, 2 key, 3 blade, 3 other) |
| ADC | Battery voltage, motor currents, adapter voltage |
| LED | PA1 GPIO (identified from OEM `display_lock()`) |

## Source Files

| File | Purpose | Status |
|------|---------|--------|
| `main.c` | System init, clock config, main super-loop | ✅ Complete |
| `serial_protocol.c/h` | Frame parser + builder, all send functions | ✅ Ghidra-verified |
| `command_handler.c/h` | X3 command dispatch + periodic reporting | ✅ Complete |
| `motor_control.c/h` | TIM1/TIM8 PWM, velocity, blade, lift, LED | ✅ Complete |
| `sensors.c/h` | IMU, magnetometer, ADC, Hall sensors, tilt | ✅ Complete |
| `gps.c/h` | UM960 UART relay, GGA parsing | ✅ Complete |
| `lora.c/h` | DTS LoRa module protocol + charger comms | ✅ Complete |
| `display.c/h` | ST7789V driver, text, OpenNova boot animation | ✅ Complete |
| `crc.c/h` | CRC-8 (serial) + CRC-32 (IAP) | ✅ Complete |
| `config.h` | All hardware defines, pin assignments, protocol | ✅ Complete |

## Boot Sequence

1. HAL init + 168 MHz clock
2. IWDG watchdog (~4s timeout)
3. GPIO port clock enable
4. Peripheral init (serial, motors, sensors, GPS, LoRa, display)
5. **OpenNova boot animation** on ST7789V display
6. IMU zero-bias calibration (18s, robot must be still)
7. Version display + "Ready" status
8. Main loop: serial RX, GPS relay, LoRa, sensors, reports, watchdog

## Building

Requires [PlatformIO](https://platformio.org/):

```bash
cd stm32-firmware
pio run                    # Build
pio run -t upload          # Flash via ST-Link
pio device monitor         # Serial monitor
```

## Safety

- **Blade motor safety switch**: `BLADE_MOTOR_DISABLED` in `config.h`
  prevents blade from spinning. Remove define to enable.
- **IWDG watchdog**: ~4s timeout, resets MCU if main loop hangs
- **Emergency stop**: `motor_emergency_stop()` kills all PWM immediately
- **Incident flags**: collision, uplift, tilt, overcurrent, IMU fault

## Status

**All stubs filled** — complete firmware with verified serial protocol.

GPIO pin assignments for Hall sensors, ADC channels, and some motor pins
are best-guess and need PCB verification before first flash.

See `docs/VERIFICATION.md` for detailed verification status.

## References

- `research/chassis_serial_protocol.md` — Complete serial protocol
- `research/STM32_firmware_feasibility_analysis.md` — Hardware analysis
