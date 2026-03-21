# STM32 Firmware — Verificatiestatus

Gegenereerd na grondige vergelijking van:
- `research/chassis_serial_protocol.md` — volledig reverse-engineered protocol
- `research/STM32_firmware_feasibility_analysis.md` — hardware analyse
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

### Sub-Command Waarden (alle 35+)
Alle TX (STM32→X3) en RX (X3→STM32) sub-command constanten in `config.h`
zijn geverifieerd tegen de jump table op `0x1ffc50` in de binary. ✅

### Payload Formaten (geverifieerd)
| Sub-cmd | Formaat | Status |
|---------|---------|--------|
| `0x01` Version | `[board_v1,v2,v3, ctrl_v1,v2,v3]` 6 bytes | ✅ Correct |
| `0x02` Velocity | `[left_hi,lo, right_hi,lo, 0,0]` int16 BE mm/s | ✅ Correct |
| `0x0A` MotorCurrent | `[left_hi,lo, right_hi,lo, blade_hi,lo]` int16 BE mA | ✅ Correct |
| `0x0C` HallStatus | `[lf, lb, rb, rf]` 4x uint8 | ✅ Correct |
| `0x18` Incident | 8 bytes, uint64 big-endian | ✅ Correct |
| `0x42` IMU 20602 | `[ax,ay,az,gx,gy,gz]` 6x int16 BE | ✅ Correct |
| `0x43` Magnetometer | `[mx,my,mz]` 3x int16 BE | ✅ Correct |

### Timer Frequenties (berekend)
APB2 = 84 MHz, prescaler = 0, freq = 84MHz / (ARR+1)

| Timer | ARR | Berekend | Doel | Status |
|-------|-----|----------|------|--------|
| TIM1 wielmotoren | 1679 | 84M/1680 = **50.000 Hz** | 50 kHz | ✅ |
| TIM8 blad | 999 | 84M/1000 = **84.000 Hz** | 84 kHz | ✅ |
| TIM8 lift | 3359 | 84M/3360 = **25.000 Hz** | 25 kHz | ✅ |

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

## ⚠️ Onzeker — Verificatie Nodig

### 1. Wheel Speed Payload Formaat (KRITIEK)
**Probleem:** Spec zegt "encoder data + timestamp" maar onze implementatie stuurt
mm/s direct (4 bytes). Het OEM formaat is waarschijnlijk:
- Left encoder ticks (int16 of int32)
- Right encoder ticks (int16 of int32)
- Timestamp in ms (uint32)

De X3 berekent odometrie zelf uit encoder ticks — als wij mm/s sturen maar
de X3 ticks verwacht, gaat de odometrie fout (maaier rijdt niet recht).

**Verificatie:** Ghidra analyse van `chassis_cmd_deal_wheel_speed()` op adres
uit de symbol table, of sniffen van OEM UART met logic analyzer.

**Risico als fout:** Onjuiste odometrie → maaier navigeert verkeerd.

### 2. Battery Payload Compleetheid
**Probleem:** Onze implementatie stuurt 3 velden (soc_pct, voltage_mv, current_ma).
De OEM firmware stuurt minimaal 10 velden (cyclus count, celbalans, FET status,
twee temperaturen, nominale capaciteit, etc.).

**Impact:** Maaier werkt, maar battery management features ontbreken.
`chassis_incident` bevat geen battery-gerelateerde errors.

### 3. Charge Data Payload (sub-cmd 0x0B)
**Probleem:** Log zegt 4 floats, maar of dit IEEE-754 of fixed-point is onbekend.
Onze implementatie gebruikt `value * 100` als uint16 (centi-units).

**Verificatie:** Ghidra analyse van `chassis_cmd_deal_charge_cur_vol()`.

### 4. Maximale Wielsnelheid (WHEEL_MAX_SPEED_MMS = 500)
**Probleem:** De 500 mm/s limiet is niet onderbouwd vanuit bronnen.
Te laag → maaier rijdt langzamer dan mogelijk.
Te hoog → PWM nooit vol (geen echt probleem maar suboptimaal).

**Verificatie:** Meten op echte hardware, of OEM firmware constanten zoeken.

### 5. Battery Voltage Threshold (19.0V)
**Probleem:** Waarde `BATTERY_VOLTAGE_THRESHOLD_V = 19.0f` staat in config.h
maar de bron is onbekend. Gebruikt voor PIN lock detectie.

---

## ❌ Niet Geïmplementeerd (PCB Verificatie Nodig)

Deze onderdelen werken NIET totdat GPIO pinnen op de PCB geverifieerd zijn:

### Motor Richting
- **Probleem:** TIM1 stuurt PWM op 4 kanalen voor richting (CH1=links-vooruit,
  CH2=links-achteruit, CH3=rechts-vooruit, CH4=rechts-achteruit).
- **Alternatief mogelijk:** OEM gebruikt aparte direction GPIO pins i.p.v.
  dual-channel PWM. Zonder PCB trace is richting onzeker.
- **Gevolg:** Motoren draaien mogelijk de verkeerde kant op bij eerste test.

### Hall Sensoren (14 stuks)
- Alle 14 GPIO pinnen onbekend
- Botsing, lift, knop detectie: altijd 0 → incident flags werken niet

### ADC Kanalen
- Batterijspanning, motorstromen, adaptersspanning: altijd 0
- Battery management niet functioneel

### LED Aansturing
- Sub-cmd `0x0D` en `0xF1` handlers zijn leeg
- Geen GPIO of PWM voor LEDs gedefinieerd

### Charge Lock Solenoid
- Sub-cmd `0x22` en `0x46` handlers zijn leeg
- Geen solenoid GPIO gedefinieerd

### Lift Motor Richting
- `motor_blade_up()` en `motor_blade_down()` geven PWM maar geen richting
- Direction GPIO onbekend → beide commando's identiek effect

### LoRa Protocol Framing
- USART3 ontvang buffer werkt, maar DTS module protocol parser is leeg
- RTK data relay van charger naar X3 werkt niet

### LCD Controller
- SPI2 initialisatie aanwezig
- LCD controller IC onbekend (waarschijnlijk ST7789 of ILI9341)
- Geen init sequence, geen pixel output

### IAP Firmware Update
- 8-staps IAP protocol niet geïmplementeerd
- CRC-32 berekening is stub

---

## 🔬 Teststrategie voor Eerste Flash

### Stap 1: Serial Protocol Verificatie (veiligst)
Flash firmware op STM32F407 dev board. Sluit USART1 aan op een computer
via USB-UART adapter. Controleer:
- Ontvangt firmware `[02 02 07 FF ...]` frames correct?
- Stuurt firmware versie rapport `[02 02 00 01 07 01 01 00 01 01 00 XX 03 03]`?
- Klopt de CRC op ontvangen en verzonden frames?

**Gereedschap:** `python3 -c` + `serial` library, of `minicom`.

### Stap 2: Velocity Command Test
Stuur velocity commando `[02 02 07 FF 08 02 00 64 00 64 00 00 XX 03 03]`
(left=100mm/s, right=100mm/s). Verwacht: TIM1 CCR verandert.
Meet PWM output op oscilloscoop of logic analyzer.

### Stap 3: IMU I2C Test
Controleer of ICM-20602 reageert op I2C adres 0x68 (WHO_AM_I = 0x12).
Als I2C niet werkt: GPIO pinnen voor SDA/SCL zijn verkeerd.

### Stap 4: UART GPS Test
Stuur NMEA test string naar UART5. Controleer of firmware dit doorstuurt
als sub-cmd 0x05 frame op USART1.

### Stap 5: Volledige chassis_control_node Test
Sluit dev board aan op X3 (USART1 TX/RX). Start `chassis_control_node`.
Controleer ROS2 topics:
```bash
ros2 topic echo /chassis_version    # Moet versie tonen
ros2 topic echo /odom               # Moet odomtetrie tonen
ros2 topic echo /imu_data           # Moet IMU data tonen
```

---

## 📋 Open Actiepunten

| Prioriteit | Actie | Methode |
|------------|-------|---------|
| 🔴 KRITIEK | Wheel speed payload formaat verifiëren | Ghidra `chassis_cmd_deal_wheel_speed` |
| 🔴 KRITIEK | Motor richting GPIO pinnen meten | Multimeter/scope op PCB |
| 🔴 KRITIEK | Hall sensor GPIO pinnen meten | Multimeter op PCB |
| 🟡 HOOG | ADC kanalen voor batterij/stroom | PCB trace + datasheet |
| 🟡 HOOG | Charge data payload formaat | Ghidra `chassis_cmd_deal_charge_cur_vol` |
| 🟡 HOOG | Battery payload alle velden | OEM firmware string analyse |
| 🟢 LAAG | LED aansturing implementeren | GPIO trace |
| 🟢 LAAG | LCD controller identificeren | I2C/SPI scan op boot |
| 🟢 LAAG | LoRa DTS protocol parser | DTS module datasheet |
| 🟢 LAAG | IAP firmware update | Spec sectie 9 |
