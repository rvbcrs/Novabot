# Haalbaarheidsanalyse: Open-Source STM32 Motor Controller Firmware

**Datum**: 20 maart 2026
**Binary**: `novabot_stm32f407_v3_6_0_NewMotor25082301.bin` (444,144 bytes)
**MCU**: STM32F407 (168MHz Cortex-M4F, 1MB Flash, 192KB RAM)
**Analyse**: Python + capstone disassembler, 3 parallelle analyse-agents

---

## 1. Wat doet de huidige firmware?

### Architectuur
- **Bare-metal** (geen RTOS) — super-loop met timer-interrupts
- **1.481 functies**, 10.532 function calls naar 2.231 unieke targets
- 29 actieve interrupt handlers, SysTick op 1ms
- 128KB SRAM volledig gebruikt, 64KB CCM RAM ook actief

### Hardware-aansturing

| Subsysteem | Hardware | Details |
|-----------|----------|---------|
| **4 motoren** | TIM1 + TIM8 (PWM) | Links/rechts wiel, mes, lift (maaihoogte) |
| **Motor bescherming** | ADC1/2/3 | Overcurrent, stall detectie, voltage monitoring |
| **GPS/RTK** | UART5 → UM980 | NovAtel BESTPOSA/BESTVELA/PSRDOPA @ 0.2s |
| **LoRa** | UART/SPI | Charger positie, RSSI monitoring, kanaal management |
| **Display** | SPI2 + LVGL | Kleur LCD, 9 talen, QR code |
| **IMU** | I2C1 | Accelerometer/gyro (tilt/botsing detectie) |
| **ROS2 link** | USART1 | Serieel protocol 0x0202...0x0303 framing, CRC-8 |
| **Watchdog** | IWDG + WWDG | Dual watchdog (IEC 60335 Class B) |
| **USB** | OTG_FS | Debug/firmware update |

### PWM Configuratie
- **TIM1 + TIM8**: Symmetrisch, 16 referenties elk
- **CCER = 0x1111**: 4 kanalen enabled, GEEN complementaire outputs
- **PWM frequenties**: 50kHz (wielmotoren), 84kHz (mes motor), 25kHz (alternatief)
- H-bridge: richting via GPIO + PWM magnitude (niet complementair)

### Serieel Protocol (USART1 → ROS2 X3)
- Frame: `[02 02] [LEN] [CMD PAYLOAD... CRC8] [03 03]`
- CRC tabel op 0x08057A4C — custom variant (geen standaard polynoom)
- 1200-byte ontvangstbuffer per UART
- Dit is de KRITIEKE interface naar chassis_control_node op de X3

### Safety (IEC 60335 Class B)
- **Volledige ST STL library** ("IEC60335 test @ARMc")
- Boot: CPU register test (R0-R12 checkerboard), Flash CRC-32, RAM March C-
- Runtime: klok cross-meting, stack overflow detectie, control flow monitoring, ADC VREFINT check
- FailSafe_Handler op 0x08013E24 — stopt alles bij testfout
- CmBacktrace crash analyse met 20+ foutbeschrijvingen

---

## 2. Code Breakdown

| Subsysteem | Geschatte grootte | % | Replicatie nodig? |
|-----------|----------------:|---:|:---:|
| STM32 HAL drivers | ~60 KB | 14% | Gratis (ST open-source) |
| Display resources (fonts, strings, 9 talen) | ~70 KB | 16% | Grotendeels skipbaar |
| LVGL GUI | ~50 KB | 12% | Vereenvoudigen |
| Motor control + PID | ~40 KB | 9% | **JA — kritiek** |
| Application logic / state machine | ~30 KB | 7% | **JA** |
| Safety/Class B (STL) | ~25 KB | 6% | Skipbaar voor DIY |
| Serieel protocol (0x0202/0x0303) | ~25 KB | 6% | **JA — kritiek** |
| QR code generatie | ~20 KB | 5% | Skipbaar |
| LoRa communicatie | ~15 KB | 3% | **JA** |
| RTK/GPS processing | ~15 KB | 3% | **JA** |
| Factory test mode | ~15 KB | 3% | Skipbaar |
| Math/utility | ~15 KB | 3% | HAL + arm_math |
| CmBacktrace | ~10 KB | 2% | Skipbaar |
| IMU | ~10 KB | 2% | **JA** |
| PIN/lock systeem | ~10 KB | 2% | Skipbaar (al gepatcht) |
| Startup/init | ~10 KB | 2% | Standaard |
| USB | ~5 KB | 1% | Later |
| Overig | ~19 KB | 4% | - |

**Skipbaar**: ~190 KB (44%) — Class B, QR code, 8 talen, factory test, CmBacktrace, PIN lock
**Nodig**: ~245 KB (56%) — maar HAL is gratis, dus echt te schrijven: ~130 KB

---

## 3. Wat we al weten vs. wat nog ontdekt moet worden

### Bekend (uit onze analyse + patches)

| Onderdeel | Status | Bron |
|-----------|--------|------|
| check_pin_lock() volledige structuur | ✅ Volledig | Capstone disassembly |
| set_error_byte(), set_incident_flag() | ✅ Volledig | Patch scripts |
| Motor types (links, rechts, mes, lift) | ✅ Volledig | String analyse |
| PWM config (TIM1/TIM8, CCER, frequenties) | ✅ Goed | Register analyse |
| UART toewijzing (USART1=X3, UART5=LoRa/GPS) | ✅ Goed | ISR analyse |
| Serieel frame formaat (0x0202/0x0303, CRC-8) | ✅ Basis | Patch + string analyse |
| RTK module (UM980, BESTPOS/BESTVEL commando's) | ✅ Goed | String analyse |
| LoRa commando codes (0x34 data, 0x36 kanaal) | ✅ Basis | String analyse |
| Safety structuur (STL, fault handlers) | ✅ Volledig | String + code analyse |
| Display (SPI2, LVGL, 9 talen) | ✅ Goed | String analyse |
| Watchdog config (IWDG 0xCCCC/0x5555/0xAAAA) | ✅ Volledig | Register analyse |
| RAM layout (1695 variabelen, key globals) | ✅ Goed | RAM referentie analyse |
| GPIO poorten (A-H, alle actief) | ✅ Basis | Peripheral scan |

### Onbekend (moet nog ontdekt worden)

| Onderdeel | Methode | Moeilijkheid |
|-----------|---------|:---:|
| **Serieel protocol commando's + payloads** | Logic analyzer / seriële sniffer | HOOG |
| **PID constanten voor wielmotoren** | Disassembly of experimentation | MEDIUM |
| **ADC kanaal mapping** (welke pin = welke meting) | PCB trace of disassembly | MEDIUM |
| **GPIO pin toewijzingen** (motor richting, enable, Hall) | PCB trace of disassembly | MEDIUM |
| **LoRa frame formaat** (positie encoding) | Sniffer + charger analyse | MEDIUM |
| **Display controller type** (ILI9341? ST7789?) | PCB inspectie | LAAG |
| **Stroomshunt waarden** (voor ADC calibratie) | Hardware meting | LAAG |
| **Voltage divider ratio** (voor battery voltage) | Hardware meting | LAAG |

---

## 4. Haalbaarheid

### Conclusie: **HAALBAAR maar significant werk**

De firmware is complex (1481 functies, 434KB) maar ~44% kan worden overgeslagen voor een DIY versie. De kernfunctionaliteit (motor control, serieel protocol, sensoren) is ~130KB aan te schrijven code.

### Belangrijkste voordeel

**Wij controleren BEIDE kanten van de communicatie.** Sinds we `open_decision` (Python) op de ROS2 kant draaien, hoeven we het proprietary serieel protocol NIET exact na te bouwen. We kunnen een **eigen, schoner protocol** definiëren — zolang beide kanten (STM32 + open_decision) het spreken.

### Ontwikkelplan

| Fase | Scope | Duur | Resultaat |
|------|-------|------|-----------|
| **1** | Motor PWM + watchdog + serieel echo | 2-3 weken | Motoren draaien, MCU blijft leven |
| **2** | Serieel protocol framing + cmd parsing | 3-4 weken | ROS2 kan velocity sturen |
| **3** | ADC + overcurrent bescherming | 1-2 weken | Veilige motor aansturing |
| **4** | LoRa + RTK integratie | 3-4 weken | Charger GPS positie ontvangen |
| **5** | IMU integratie | 1-2 weken | Tilt/botsing detectie |
| **6** | Minimale LCD display | 1-2 weken | Status feedback |
| **7** | Volledige LVGL GUI (optioneel) | 4-6 weken | Complete UI |

**Totaal: 11-17 weken voor functionele vervanging, 15-23 weken voor feature parity.**
Geschatte code: **10.000-18.000 regels C**.

### Risico's

| Risico | Impact | Mitigatie |
|--------|--------|-----------|
| Serieel protocol onbekend | HOOG | Logic analyzer op USART1, of eigen protocol definieren |
| PID tuning | MEDIUM | Start met lage snelheid, experimenteel tunen |
| ADC calibratie | MEDIUM | Hardware metingen met multimeter |
| GPIO mapping | MEDIUM | PCB foto's + systematische test |
| LoRa protocol | MEDIUM | Charger firmware al geanalyseerd (Ghidra) |
| Motor schade bij fout | HOOG | Eerst overcurrent bescherming, dan pas snelheid |

---

## 5. Patch vs. Rewrite: Vergelijking

| Aspect | Patching (huidige aanpak) | Volledige rewrite |
|--------|:---:|:---:|
| **Tijd tot resultaat** | Uren-dagen | Maanden |
| **Risico** | Laag (bewezen werkend) | Hoog (nieuwe bugs) |
| **Controle** | Beperkt (NOP patches) | Volledig |
| **Nieuwe features** | Zeer moeilijk | Eenvoudig |
| **Onderhoud** | Per firmware-update opnieuw | Eigen controle |
| **Begrip** | Oppervlakkig | Diep |
| **Veiligheid** | OEM safety + patches | Eigen verantwoordelijkheid |

### Aanbeveling

**Korte termijn**: Blijf patchen (v3.6.12 werkt, motoren + PIN fix bewezen).

**Middellange termijn**: Begin met serieel protocol reverse engineering (logic analyzer op USART1 TX/RX). Dit is het fundament voor alles — zonder protocol kennis is een rewrite onmogelijk.

**Lange termijn**: Als het serieel protocol volledig in kaart is gebracht EN we eigen protocol controle willen (via open_decision), dan is een rewrite haalbaar als project van 3-6 maanden.

---

## 6. Factory Test Menu (referentie voor hardware test)

Het factory test menu onthult alle hardware componenten:

```
001: KEY TEST          — Knoppen
002: HALL IO TEST      — Hall sensoren (wielen, mes, lift)
003: SCREEN TEST       — Display
004: LED TEST          — Status LEDs
005: BEEP TEST         — Buzzer
006: RELAY TEST        — Relais (laadfunctie)
008: GPS SIGNAL TEST   — RTK GPS
009: LEFT MOTOR TEST   — Links wielmotor
010: RIGHT MOTOR TEST  — Rechts wielmotor
011: BLADE MOTOR TEST  — Maai-mes motor
012: LIFT MOTOR TEST   — Maaihoogte motor
013: IMU TEST          — Accelerometer/gyro
014: BATTERY TRANS TEST — Accu communicatie
015: BATTERY CHARGE TEST — Laad functie
016: X3 TRANS TEST     — Seriële link naar ROS2 board
FRONT WHEEL HALL TEST  — Voorwiel hall sensoren
SHELL HALL TEST        — Behuizing hall sensoren
LIFT HALL TEST         — Lift hall sensoren
UPRAISE TEST           — Ophef test
```

---

## Bronbestanden

- `/tmp/stm32_firmware_analysis.md` — Volledige firmware analyse rapport (agent 1)
- `/tmp/stm32_deep_analysis.md` — Deep motor/safety/display analyse (agent 2)
- `/tmp/stm32_strings_categorized.md` — Gecategoriseerde string analyse (agent 3)
- `research/firmware/STM32/patch_v3_6_12.py` — Huidige patch script (werkend)
- `research/firmware/STM32/novabot_stm32f407_v3_6_0_NewMotor25082301.bin` — Stock firmware
