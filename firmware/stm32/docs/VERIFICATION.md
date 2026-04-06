# STM32 Firmware — Verificatiestatus

Gegenereerd na grondige vergelijking van:
- `research/chassis_serial_protocol.md` — volledig reverse-engineered protocol
- `research/STM32_firmware_feasibility_analysis.md` — hardware analyse
- OEM binary disassembly (Capstone ARM Thumb)
- `open_decision/` — Python ROS2 beslissingsnode (wat de maaier verwacht)

---

## ✅ Geverifieerd Correct

### Serial Protocol Frame
| Element | Waarde | Bron |
|---------|--------|------|
| Header bytes | `0x02 0x02` | Binary analyse chassis_control_node |
| Footer bytes | `0x03 0x03` | Binary analyse chassis_control_node |
| Frame overhead | 7 bytes | Spec sectie 1 |
| RX buffer | 1200 bytes | "Matches OEM firmware" — spec sectie 1 |
| X3→STM32 cmd_id | `0x07FF` | Binary symbolen + jump table |
| STM32→X3 cmd_id | `0x0001` of `0x0002` | `chassis_cmd_deal()` dispatch |
| Sub-cmd positie | payload[0] | Jump table op 0x1ffc50 |

### CRC-8
| Element | Waarde | Bron |
|---------|--------|------|
| Polynomial | 0x07 (ITU-T) | Lookup table `crc8Table` op 0x1f7170 |
| Init waarde | 0x00 | Binary analyse |
| Lookup tabel | 256 entries — identiek aan OEM | Byte-voor-byte geverifieerd |
| Scope | Over payload[0..N-2], CRC in payload[N-1] | Spec sectie 3 |

### CRC-32
| Element | Waarde | Bron |
|---------|--------|------|
| Polynomial | 0x04C11DB7 (IEEE 802.3) | IAP protocol analyse |
| Init waarde | 0xFFFFFFFF | Standaard Ethernet/ZIP |
| Lookup tabel | 256 entries — volledig geïmplementeerd | ✅ |

### Sub-Command Waarden (alle 35+)
Alle TX (STM32→X3) en RX (X3→STM32) sub-command constanten in `config.h`
zijn geverifieerd tegen de jump table op `0x1ffc50` in de binary. ✅

### Payload Formaten (Ghidra-geverifieerd)
| Sub-cmd | Formaat | Status |
|---------|---------|--------|
| `0x01` Version | `[board_v1,v2,v3, ctrl_v1,v2,v3]` 6 bytes | ✅ Correct |
| `0x02` Velocity RX | `[left_hi,lo, right_hi,lo, 0,0]` int16 BE mm/s | ✅ Correct |
| `0x03` Wheel Speed TX | `[left_hi,lo, right_hi,lo, pad, ts(8), trail]` 14 bytes | ✅ Ghidra verified |
| `0x0A` MotorCurrent | `4x float32 LE (Amperes)` 16 bytes | ✅ Ghidra verified |
| `0x0B` ChargeData | `4x float32 LE (V, mA, V, V)` 16 bytes | ✅ Ghidra verified |
| `0x0C` HallStatus | `11x uint8 (all sensors)` | ✅ Ghidra verified |
| `0x18` Incident | `4x uint32 BE (event/warn/err/classB)` 16 bytes | ✅ Ghidra REV verified |
| `0x42` IMU 20602 | `[az,ax,ay,gz,gx,gy]` 6x int16 BE (Z-X-Y order!) | ✅ Ghidra verified |
| `0x43` Magnetometer | `[mx,my,mz]` 3x int16 BE | ✅ Correct |

### Timer Frequenties (berekend)
APB2 = 84 MHz, prescaler = 0, freq = 84MHz / (ARR+1)

| Timer | ARR | Berekend | Doel | Status |
|-------|-----|----------|------|--------|
| TIM1 wielmotoren | 1679 | 84M/1680 = **50.000 Hz** | 50 kHz | ✅ |
| TIM8 blad | 999 | 84M/1000 = **84.000 Hz** | 84 kHz | ✅ |
| TIM8 lift | 3359 | 84M/3360 = **25.000 Hz** | 25 kHz | ✅ |

### Display Controller (21 maart 2026)
| Element | Waarde | Bron |
|---------|--------|------|
| Controller IC | **ST7789V** | OEM binary disassembly (init at 0x08009D78) |
| Resolutie | 240x320 (portrait) / 320x240 (landscape) | Rotation function at 0x0800A074 |
| Kleurformaat | RGB565 (16-bit, 65K kleuren) | COLMOD 0x3A → 0x05 |
| Framerate | 60 Hz | FRCTR2 = 0x0F |
| Interface | SPI2 + DC pin + RST pin | lcd_write_cmd at 0x0800A010 |
| PORCTRL (0xB2) | 0x0C, 0x0C, 0x00, 0x33, 0x33 | ST7789V-specifiek |
| GCTRL (0xB7) | 0x35 | ST7789V-specifiek |
| VCOMS (0xBB) | 0x35 | ST7789V-specifiek |
| MADCTL orientaties | 0x00, 0x60, 0xC0, 0xA0 | 4 rotaties |

### Hardware Constanten (geverifieerd uit URDF)
| Parameter | Waarde | Bron |
|-----------|--------|------|
| Wielafstand | 0.40342 m | URDF `novabot_chassis.urdf` |
| Wieldiameter | 0.22356 m | URDF `novabot_chassis.urdf` |
| GPS offset X | +0.186 m | URDF nieuwe hardware variant |
| GPS offset Z | +0.15 m | URDF nieuwe hardware variant |
| IMU offset X | -0.082 m | URDF nieuwe hardware variant |
| IMU offset Z | +0.07 m | URDF nieuwe hardware variant |
| IMU yaw | 1.5707 rad (90°) | URDF mounting |
| IMU roll bias | -0.0081 rad | Spec sectie 11 (default) |
| IMU kalibratie | 18.0 s | Spec sectie 11 `imu_zero_bias_sample_time` |
| I2C IMU adres | 0x68 | ICM-20602 datasheet |
| I2C mag adres | 0x10 | BMM150 datasheet |
| UART baud X3 | 115200 | Spec sectie 2 |
| UART baud GPS | 115200 | UM960 standaard |
| UART baud LoRa | 115200 | OEM firmware analyse |

---

## ⚠️ Onzeker — PCB Verificatie Nodig

Deze onderdelen zijn geïmplementeerd met best-guess pin assignments.
Ze compileren en zijn functioneel maar de GPIO pinnen moeten op de PCB
geverifieerd worden voordat ze correct werken.

### GPIO Pin Assignments (best-guess, niet geverifieerd)
| Functie | Pin | Basis | Status |
|---------|-----|-------|--------|
| I2C1 SCL | PB6 | STM32F407 standaard | ⚠️ Waarschijnlijk correct |
| I2C1 SDA | PB7 | STM32F407 standaard | ⚠️ Waarschijnlijk correct |
| SPI2 SCK | PB13 | STM32F407 standaard | ⚠️ Waarschijnlijk correct |
| SPI2 MOSI | PB15 | STM32F407 standaard | ⚠️ Waarschijnlijk correct |
| SPI2 CS | PB12 | STM32F407 standaard | ⚠️ Waarschijnlijk correct |
| Display DC | PB14 | Gangbaar voor SPI LCD | ⚠️ Onzeker |
| Display RST | PB1 | Gangbaar | ⚠️ Onzeker |
| LED | PA1 | OEM `display_lock()` analyse | ✅ Bewezen |
| USART1 TX | PA9 | STM32F407 standaard | ⚠️ Waarschijnlijk correct |
| USART1 RX | PA10 | STM32F407 standaard | ⚠️ Waarschijnlijk correct |
| UART5 TX | PC12 | STM32F407 standaard | ⚠️ Waarschijnlijk correct |
| UART5 RX | PD2 | STM32F407 standaard | ⚠️ Waarschijnlijk correct |
| USART3 TX | PB10 | STM32F407 standaard | ⚠️ Waarschijnlijk correct |
| USART3 RX | PB11 | STM32F407 standaard | ⚠️ Waarschijnlijk correct |
| Collision LF | PE7 | Best-guess | ❌ Onzeker |
| Collision LB | PE8 | Best-guess | ❌ Onzeker |
| Collision RB | PE9 | Best-guess | ❌ Onzeker |
| Collision RF | PE10 | Best-guess | ❌ Onzeker |
| Uplift L | PE11 | Best-guess | ❌ Onzeker |
| Uplift R | PE12 | Best-guess | ❌ Onzeker |
| Key1 | PE13 | Best-guess | ❌ Onzeker |
| Key2 | PE14 | Best-guess | ❌ Onzeker |
| Front wheel | PD8 | Best-guess | ❌ Onzeker |
| Shell | PD9 | Best-guess | ❌ Onzeker |
| Lift sensor | PD10 | Best-guess | ❌ Onzeker |
| Charge lock | PE2 | Best-guess | ❌ Onzeker |
| Lift direction | PD13 | Best-guess | ❌ Onzeker |
| ADC Battery | PA0/CH0 | Best-guess | ❌ Onzeker |
| ADC Left motor | PA2/CH2 | Best-guess | ❌ Onzeker |
| ADC Right motor | PA3/CH3 | Best-guess | ❌ Onzeker |
| ADC Blade motor | PA4/CH4 | Best-guess | ❌ Onzeker |
| ADC Adapter | PA5/CH5 | Best-guess | ❌ Onzeker |

### Maximale Wielsnelheid (WHEEL_MAX_SPEED_MMS = 500)
Waarde niet onderbouwd vanuit bronnen. Meten op echte hardware.

### Battery Voltage Threshold (19.0V)
Waarde `BATTERY_VOLTAGE_THRESHOLD_V = 19.0f` — bron onbekend.

### ADC Conversie Constanten
- Resistor divider ratio (11:1) is aangenomen
- Current shunt (0.1Ω) en amplifier gain (20x) zijn aangenomen
- Moeten worden geverifieerd met oscilloscoop/multimeter

---

## ❌ Niet Geïmplementeerd

| Feature | Reden | Prioriteit |
|---------|-------|-----------|
| IAP firmware update (8-staps protocol) | Complex, geen urgentie | LAAG |
| WWDG (Window Watchdog) | IWDG is voldoende voor nu | LAAG |
| IEC 60335 Class B RAM test | Veiligheidscertificering niet nodig voor hobby | LAAG |
| IEC 60335 Class B Flash CRC | Idem | LAAG |
| Blade Hall commutation | TIM8 encoder input, niet GPIO | LAAG |

---

## 📋 Open Actiepunten

| Prioriteit | Actie | Methode |
|------------|-------|---------|
| 🔴 KRITIEK | Motor richting GPIO pinnen verifiëren | Multimeter/scope op PCB |
| 🔴 KRITIEK | Hall sensor GPIO pinnen verifiëren | Multimeter op PCB |
| 🟡 HOOG | ADC kanalen verifiëren (batterij/stroom) | PCB trace + datasheet |
| 🟡 HOOG | Display DC/RST pinnen verifiëren | PCB trace |
| 🟢 LAAG | Charge lock GPIO verifiëren | PCB trace |
| 🟢 LAAG | Lift motor direction GPIO verifiëren | PCB trace |
