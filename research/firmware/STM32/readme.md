# STM32 Chassis MCU Firmware — Onderzoek & Documentatie

Reverse-engineering en firmware-patching van de STM32F407 chassis MCU in de Novabot maaier.

---

## Hardware

- **Microcontroller**: STM32F407 op de chassis-PCB
- **Verbinding**: USB serial `/dev/ttyACM0` naar de ARM SoC (Horizon Robotics X3)
- **Taken**: touchscreen display, motorsturing, sensoren, PIN-vergrendeling, LoRa-communicatie
- **Display/PIN-invoer**: wordt volledig door de STM32 afgehandeld, NIET door de Linux/ROS-kant
- Er bestaan **geen** `/dev/input/` devices aan de Linux-kant — het touchscreen heeft geen Linux input subsystem

---

## Firmware Details

| Eigenschap | Waarde |
|------------|--------|
| Origineel bestand | `novabot_stm32f407_v3_6_0_NewMotor25082301.bin` |
| Bestandsgrootte | 444.144 bytes |
| Originele MD5 | `68df957769cb4579734c1989dc29d51d` |
| Versie-bytes | File offset `0x47638`: `[03 06 00]` = v3.6.0 |
| CRC-32 | Offset `0x6BA40`, dekt bytes `0x00000`–`0x6BA3F` |
| CRC-algoritme | STM32 hardware CRC32, polynoom `0x04C11DB7`, byte-swapped input words |
| Locatie op maaier | `/root/novabot/install/chassis_control/share/chassis_control/MCU_BIN/` |

---

## Serial Protocol

### Frame-formaat (15 bytes voor PIN-commando's)

```
[02 02] [CMD_ID_H CMD_ID_L] [PAYLOAD_LEN] [PAYLOAD...] [03 03]
```

| Veld | Bytes | Beschrijving |
|------|-------|--------------|
| STX | `02 02` | Start of frame |
| CMD_ID | `07 FF` | Commando-ID (big-endian), specifiek voor PIN |
| PAYLOAD_LEN | `08` | Lengte van de inner payload |
| PAYLOAD | 8 bytes | Zie inner payload hieronder |
| ETX | `03 03` | End of frame |

### PIN commando inner payload (8 bytes)

```
[0x23] [type] [PIN_0] [PIN_1] [PIN_2] [PIN_3] [0x00] [CRC-8]
```

| Byte | Beschrijving |
|------|--------------|
| `0x23` | PIN commando-byte (vast) |
| `type` | Commando-type (0=query, 1=set, 2=verify) |
| `PIN_0`–`PIN_3` | PIN-cijfers als ASCII (`'0'`=0x30, `'1'`=0x31, etc.) |
| `0x00` | Padding |
| CRC-8 | Polynoom `0x07` (ITU-T), init=`0x00`, berekend over de eerste 7 inner bytes |

---

## PIN Commando Types

| Type (`cfg_value`) | Functie | Stock firmware | Gepatcht firmware |
|--------------------|---------|----------------|-------------------|
| 0 | Query PIN (retourneert huidige code) | result=0, value="NNNN" | Werkt |
| 1 | Set/wijzig PIN | result=0 | Werkt |
| 2 | Verifieer & ontgrendel (remote PIN invoer) | result=1 (geweigerd) | Ontgrendelt display |
| 3+ | Onbekend | result=1 (geweigerd) | result=1 (geweigerd) |

---

## MQTT Flow voor PIN Commando's

De volledige keten van dashboard/app naar STM32 en terug:

```
Dashboard/App
    │
    ▼ MQTT: {"dev_pin_info": {"cfg_value": <type>, "code": "<4cijfers>"}}
    │
mqtt_node (Linux, ROS 2)
    │  api_dev_pin_info() → parst cfg_value en pin_code
    │  Spawnt pin_set_fun thread
    │  Roept pin_send_goal(uint8 type, string code) aan
    │
    ▼ ROS 2 Action Goal: chassis_pin_code_set
    │
chassis_control_node (Linux, ROS 2)
    │  action_config_pin_code_set()
    │  Bouwt serial frame en stuurt naar STM32
    │
    ▼ USB serial /dev/ttyACM0
    │
STM32F407
    │  Verwerkt commando, retourneert response
    │
    ▼ (zelfde pad terug)
    │
MQTT response: {"message":{"result":0,"value":"3053"},"type":"dev_pin_info_respond"}
```

**Let op**: het veld heet `code` in de MQTT JSON, maar intern (in mqtt_node) wordt het `pin_code` genoemd.

---

## ROS 2 Action: ChassisPinCodeSet

```
# Goal
uint8 type    # 0=query, 1=set, 2=verify (gepatcht)
string code   # 4-cijferige PIN
---
# Result
uint8 status  # 0=success (opmerking in broncode: "返回0 成功，返回其他都是失败")
string code   # resultaatdata
---
# Feedback
uint8 status
```

---

## Gepatchte Firmware: PIN Unlock (type=2)

Het script `patch_pin_unlock.py` voegt remote PIN-verificatie en ontgrendeling toe aan de stock firmware.

### Werking

De patch bestaat uit drie onderdelen:

#### 1. Trampoline (4 bytes bij file offset `0x46138`)

Stuurt de PIN-commando dispatcher om naar de nieuwe code.

| | Waarde |
|--|--------|
| Originele bytes | `01 28 08 D1` (= `CMP R0, #1` + `BNE +0x10`) |
| Gepatchte bytes | Branch naar nieuwe code op `0x4E448` |

#### 2. Patch-code (118 bytes bij file offset `0x4E448`)

Geplaatst in een nul-gevuld gebied binnen het CRC-bereik. De logica:

1. Controleert het type:
   - **type==1** → spring naar originele type=1 handler (set PIN)
   - **type==2** → ga door naar verificatie
   - **overige** → spring naar originele exit
2. Voor type==2:
   - Roept `get_stored_pin()` aan om de opgeslagen PIN op te halen
   - Vergelijkt elk cijfer van de ontvangen PIN met de opgeslagen PIN
   - **Match**: roept `screen_switch(0x0C)` aan om naar het home-scherm te schakelen (ONTGRENDELT!)
   - **Match**: wist `error_flag_byte` op RAM `0x20000368` (display error state)
   - **Match**: wist `incident_flag_byte` op RAM `0x200004CE` (serial incident report, v3.6.3)
   - **Match**: stuurt response met status=2 (verificatie geslaagd)
   - **Mismatch**: stuurt response met status=3 (verificatie mislukt)

#### 3. CRC herberekend (bij `0x6BA40`)

Na het patchen wordt de CRC-32 opnieuw berekend zodat `chassis_control_node` de firmware accepteert.

### Belangrijke adressen

Flash-adres = file offset + `0x08010000`

| Functie | Flash-adres | File offset |
|---------|-------------|-------------|
| `get_stored_pin` | `0x08050C54` | `0x40C54` |
| `screen_switch` | `0x080509BC` | `0x409BC` |
| `send_response` | `0x080215CA` | `0x115CA` |
| `type1_handler` | `0x0805613C` | `0x4613C` |
| `exit_dispatch` | `0x0805614E` | `0x4614E` |
| `error_flag_byte` | RAM `0x20000368` | (RAM, display error state) |
| `incident_flag_byte` | RAM `0x200004CE` | (RAM, serial incident report) |
| `error_flag_clear` (normaal) | `0x08052228` | `0x42228` |
| `error_flag_set` | `0x08045D58` | `0x35D58` (schrijft naar BEIDE bytes) |

### Gepatchte binary

| Eigenschap | Waarde |
|------------|--------|
| Bestand | `novabot_stm32f407_v3_6_0_NewMotor25082301_pin_unlock.bin` |
| Versie | v3.6.3 (byte op `0x4763A` gewijzigd van `0x00` naar `0x03`) |

### Type=2 protocol (verify & unlock)

```
Stuur:    [02 02] [07 FF] [08] [23 02 d0 d1 d2 d3 00 CC] [03 03]
Succes:   [02 02] [07 FF] [08] [23 02 d0 d1 d2 d3 CC ??] [03 03]  status=2
Fout:     [02 02] [07 FF] [08] [23 03 d0 d1 d2 d3 CC ??] [03 03]  status=3
```
*(d0–d3 = ASCII PIN-cijfers, CC = CRC-8)*

---

## MCU Update Mechanisme

- `chassis_control_node` bevat de klasse `CChassisMcuUpdata` met IAP (In-Application Programming) protocol
- `check_mcu_version_and_updata()` vergelijkt de draaiende MCU-versie met de bestandsversie
- `sub_startMcuUpdata_cb` is een subscriber callback (exacte topic-naam NIET gevonden in binary)
- **Update triggert ALLEEN bij een VOLLEDIGE BOOT**, niet bij een node-restart
- IAP protocol stappen: `GotoIAP` → `SendFileSize` → `SendBlkInfo` → `SendBlkData` → `SendCrcData` → `GotoApp`
- UM960 (GPS-module) update check draait apart bij boot
- De update wordt NIET getriggerd door een ROS topic publish (getest met `/start_mcu_updata` en varianten)
- `mcu_message.json` op `/userdata/lfi/` bevat alleen `{"hardware_version":1}`

### Versie-detectie (KRITIEK)

`check_mcu_version_and_updata()` leest de firmware-versie uit de **bestandsnaam**, NIET uit de binaire inhoud.

Het patroon is `v{major}_{minor}_{patch}` in de bestandsnaam. De decimale vergelijkingswaarde is:
```
versie = major × 10000 + minor × 100 + patch
```

Voorbeeld: `novabot_stm32f407_v3_6_1_NewMotor25082301.bin` → versie `30601`

Als de bestandsversie hoger is dan de draaiende MCU-versie, wordt de IAP-update gestart.

**BELANGRIJK**: alleen de bestandsnaam wijzigen is NIET voldoende — de versie-bytes in de binary (offset `0x47638`) moeten ook kloppen, want de MCU rapporteert die waarden na het flashen via serial.

### Update procedure

Om de gepatchte firmware te installeren:

1. Kopieer de gepatchte `.bin` naar `MCU_BIN/` op de maaier
2. De **bestandsnaam** MOET de nieuwe versie bevatten (bijv. `v3_6_1` i.p.v. `v3_6_0`)
3. Herstart de maaier volledig (niet alleen de ROS nodes)
4. `chassis_control_node` detecteert het versieverschil en voert IAP-update uit
5. Controleer succes: log toont `chassis_board_version: 3 6 1`

---

## Error States

| Waarde | Betekenis |
|--------|-----------|
| `error_status=151` | "Please input pin to unlock robot!!!" (PIN-vergrendeling actief) |
| `chassis_incident_.error_no_pin_code` | PIN niet ingevoerd |
| `chassis_incident_.error_no_set_pin_code` | PIN niet geconfigureerd |
| `no_set_pin_code` veld in MQTT status report | Geeft vergrendelstatus aan |

### error_status 151 — Twee-byte error mechanisme

De MCU houdt de PIN-vergrendelingsstatus bij in **twee aparte bytes**:

| Byte | RAM-adres | Functie | Gelezen door |
|------|-----------|---------|--------------|
| `error_flag_byte` | `0x20000368` | Display error state (PIN-scherm) | Touchscreen handler |
| `incident_flag_byte` | `0x200004CE` | Serial incident report (CMD 0x20) | `chassis_control_node` |

`error_flag_set()` op `0x35D58` schrijft `1` naar **BEIDE** bytes.
De normale touchscreen PIN-unlock wist beide via de "PIN code OK!" handler op `0x42228`.

**CMD 0x20 serial report**: De STM32 stuurt elke ~100ms een frame `[02 02 00 01 03 20 XX YY 03 03]` naar de ARM. De byte `XX` en `YY` bevatten incident flags. Als `incident_flag_byte` = 1, bevat het rapport `20 02 A0` wat door `chassis_control_node` vertaald wordt naar `error_status=151`.

#### Versie-geschiedenis

**v3.6.1**: Alleen `screen_switch(0x0C)`, geen error bytes gewist → 151 bleef permanent.

**v3.6.2**: Wist `error_flag_byte` (0x20000368) → display error weg, maar `incident_flag_byte` (0x200004CE) bleef staan → MCU bleef `20 02 A0` rapporteren → `chassis_control_node` bleef `error_status=151` melden.

**v3.6.3**: Wist BEIDE bytes → zowel display als serial report worden schoongemaakt na succesvolle remote verify.

#### chassis_control_node blokkade

**KRITIEK**: `chassis_control_node` (Linux binary) stuurt type=2 PIN commando's NIET door naar de STM32. Het ontvangt het ROS action goal, logt "Received goal request with type 2", maar schrijft NOOIT het serial frame naar `/dev/ttyACM0`. Na 1 seconde timeout retourneert het "Goal fail PinCode config fail".

**Bewijs** (strace analyse):
- `write(2, "Received goal request with type 2 code 3053")` → stderr (logged)
- GEEN `write(4, ...)` met `0x23` PIN command byte → serial frame nooit verstuurd

**Workaround**: Direct serieel via `pin_serial_test.py` of een Python service die `/dev/ttyACM0` opent, het verify frame stuurt, en `chassis_control_node` tijdelijk de serial poort afpakt.

**Server-side fallback** (`sensorData.ts`):
- `markPinUnlocked(sn)` wordt aangeroepen bij ontvangst van `dev_pin_info_respond` met `cfg_value=2`
- Onderdrukt `error_status=151` → `0` zolang override actief is
- **Re-lock detectie**: telt opeenvolgende 151-meldingen. Bij >20 opeenvolgende 151's → override gewist → dashboard toont keypad
- Override wordt ook gewist bij device disconnect

---

## Recovery

- **Originele firmware backup**: `MCU_BIN/novabot_stm32f407_v3_6_0_NewMotor25082301.bin.bak` op de maaier
- **Herstellen**: kopieer de `.bak` terug naar de originele bestandsnaam en herstart de maaier
- **MCU vast in IAP-modus**: display kan leeg zijn, maar de ARM SoC zou nog steeds moeten booten met WiFi

---

## Test Scripts

### `pin_serial_test.py`

Direct serieel communiceren met de STM32 via `/dev/ttyACM0`. Staat in `research/pin_serial_test.py`.

```bash
# Via SSH op de maaier:
python3 /tmp/pin_serial_test.py query              # Query huidige PIN (type=0)
python3 /tmp/pin_serial_test.py set 1234            # Stel PIN in op 1234 (type=1)
python3 /tmp/pin_serial_test.py verify 3053         # Verifieer PIN (type=2, alleen gepatcht)
python3 /tmp/pin_serial_test.py type3 3053           # Test type=3 met PIN
python3 /tmp/pin_serial_test.py raw 4 3053           # Stuur willekeurig type byte
python3 /tmp/pin_serial_test.py scan                 # Test alle types 0-15
python3 /tmp/pin_serial_test.py hex 0202 07ff ...    # Stuur raw hex bytes
```

**WAARSCHUWING**: conflicteert met `chassis_control_node` die ook de serial poort open heeft. Stop eerst de node of gebruik met voorzichtigheid.

### `patch_pin_unlock.py`

Firmware-patcher. Leest de originele `.bin`, past de patch toe, en schrijft de gepatchte `.bin`.

```bash
cd research/firmware/STM32/
python3 patch_pin_unlock.py
```

Het script:
1. Leest de originele firmware en verifieert de CRC
2. Controleert of de trampoline-locatie de verwachte bytes bevat
3. Controleert of het patch-gebied schoon is (nul-bytes)
4. Bouwt de 118-byte Thumb-2 assembly patch
5. Plaatst trampoline + patch-code in de firmware
6. Herberekent de CRC-32
7. Schrijft het resultaat naar `*_pin_unlock.bin`

Optioneel: als `capstone` is geinstalleerd, toont het script een disassembly ter verificatie.

---

## Bestanden in deze map

| Bestand | Beschrijving |
|---------|--------------|
| `novabot_stm32f407_v3_6_0_NewMotor25082301.bin` | Originele stock firmware (v3.6.0) |
| `novabot_stm32f407_v3_6_0_NewMotor25082301_pin_unlock.bin` | Gepatchte firmware met type=2 unlock (v3.6.3) |
| `patch_pin_unlock.py` | Python script dat de patch toepast |
| `readme.md` | Dit bestand |
