# Novabot Chassis Serial Protocol — Volledige Specificatie

**Datum**: 20 maart 2026
**Bron**: `chassis_control_node` binary (4.7MB, ARM64, not stripped) + STM32 firmware analyse
**Methode**: Symbol + disassembly analyse (nm, objdump, strings) — geen logic analyzer nodig

---

## 1. Overzicht

De `chassis_control_node` (ROS2 Galactic, C++) is de brug tussen het X3 SoC (Horizon Robotics) en de STM32F407 motor controller. Communicatie gaat via USB-serial (`/dev/ttyACM*`).

### Klasse-architectuur

| Klasse | Rol |
|--------|-----|
| `CChassisSerial` | Low-level serial I/O (open, read, write, scan `/dev/ttyACM*`) |
| `CChassisControl` | Hoofd ROS2 node, eigenaar van CChassisSerial |
| `CChassisPublisher` | Leest MCU data → publiceert naar ROS2 topics |
| `CChassisSubscriber` | Ontvangt ROS2 topics → stuurt commando's naar MCU |
| `CChassisAction` | ROS2 action servers (LoRa config, PIN code) |
| `CChassisManager` | Lifecycle management |
| `CChassisMcuUpdata` | MCU firmware update via IAP protocol |
| `CChassisDataSave` | Persistent storage (JSON configs, SN) |
| `ImuHandle` | IMU sensor fusion (ICM-20602 + BMM150 Madgwick filter) |

### Bronbestanden (uit debug symbolen)

```
/root/novabot/src/chassis_control/src/
├── chassis_control.cpp      — Main node entry
├── chassis_subcriber.cpp    — Topic subscribers (X3→STM32)
├── chassis_publisher.cpp    — Topic publishers (STM32→X3)
├── chassis_action.cpp       — Action servers
├── chassis_manager.cpp      — Lifecycle
├── chassis_data_save.cpp    — Data persistence
└── imu_handle.cpp           — IMU sensor fusion
```

### Data flow

```
ROS2 Topics/Services
        │
        ▼
CChassisSubscriber ──→ vcp_cmd_SendtoMCU() ──→ WriteBuffer() ──→ USART1 TX ──→ STM32
CChassisPublisher  ←── chassis_cmd_deal()  ←── read_chassis()  ←── USART1 RX ←── STM32
        │
        ▼
ROS2 Topics (publish)
```

---

## 2. Frame Formaat

Identiek in beide richtingen:

```
+------+------+--------+--------+-------------+------+------+
| 0x02 | 0x02 | Cmd Hi | Cmd Lo | Payload Len | ...  | ...  |
+------+------+--------+--------+-------------+------+------+
  [0]    [1]    [2]      [3]      [4]           [5..N+4] [N+5][N+6]
                                                payload   0x03 0x03
```

| Veld | Offset | Grootte | Beschrijving |
|------|--------|---------|-------------|
| Header | 0-1 | 2 bytes | Altijd `0x02 0x02` |
| Command ID | 2-3 | 2 bytes | Big-endian 16-bit |
| Payload Length | 4 | 1 byte | Lengte payload data (0-255) |
| Payload | 5 t/m 5+N-1 | N bytes | Commando-specifieke data |
| Footer | 5+N t/m 6+N | 2 bytes | Altijd `0x03 0x03` |

**Totale frame grootte** = 7 + payload_length bytes

### Frame constructie (C pseudocode)

```c
void vcp_cmd_SendtoMCU(uint16_t cmd_id, uint8_t* payload, uint16_t payload_len) {
    uint8_t frame[0x440];
    frame[0] = 0x02;  frame[1] = 0x02;                    // header
    frame[2] = (cmd_id >> 8) & 0xFF;                       // cmd high byte
    frame[3] = cmd_id & 0xFF;                              // cmd low byte
    frame[4] = (uint8_t)payload_len;                       // payload length
    memcpy(&frame[5], payload, payload_len);               // payload
    frame[5 + payload_len] = 0x03;                         // footer
    frame[6 + payload_len] = 0x03;                         // footer
    serial->WriteBuffer(frame, payload_len + 7);
}
```

### Frame parsing (state machine)

`CChassisPublisher::read_chassis()` op `0x115a40`:
- Byte-voor-byte state machine: wacht op 0x02, 0x02, leest cmd_id, length, payload, valideert 0x03, 0x03
- Geparsede frames gaan via IPC message queue (`0x00001234`) naar `read_analysis_thread()`
- `chassis_cmd_deal()` dispatcht op basis van cmd_id en sub-commando

---

## 3. CRC-8 Checksum

### Algoritme

| Parameter | Waarde |
|-----------|--------|
| **Polynoom** | 0x07 (CRC-8/ITU-T standaard) |
| **Init waarde** | 0x00 |
| **Methode** | Lookup tabel (256 entries) |

### Lookup tabellen in binary

| Naam | Adres | Gebruikt door |
|------|-------|---------------|
| `crc8Table` | `0x1f7170` | `CChassisPublisher::calcCRC()` — inkomende data |
| `crc8Table` | `0x1ffec0` | Duplicate |
| `crc8Table_mcu` | `0x2107f0` | `CChassisMcuUpdata::calcCRC()` — firmware updates |

### CRC functie

```c
uint8_t calcCRC(uint8_t* data, uint32_t len, const uint32_t* table) {
    uint8_t crc = 0;
    for (uint32_t i = 0; i < len; i++) {
        crc = (uint8_t)table[data[i] ^ crc];
    }
    return crc;
}
```

### CRC-8 tabel (polynoom 0x07)

```
0x00 0x07 0x0E 0x09 0x1C 0x1B 0x12 0x15 0x38 0x3F 0x36 0x31 0x24 0x23 0x2A 0x2D
0x70 0x77 0x7E 0x79 0x6C 0x6B 0x62 0x65 0x48 0x4F 0x46 0x41 0x54 0x53 0x5A 0x5D
0xE0 0xE7 0xEE 0xE9 0xFC 0xFB 0xF2 0xF5 0xD8 0xDF 0xD6 0xD1 0xC4 0xC3 0xCA 0xCD
0x90 0x97 0x9E 0x99 0x8C 0x8B 0x82 0x85 0xA8 0xAF 0xA6 0xA1 0xB4 0xB3 0xBA 0xBD
0xC7 0xC0 0xC9 0xCE 0xDB 0xDC 0xD5 0xD2 0xFF 0xF8 0xF1 0xF6 0xE3 0xE4 0xED 0xEA
0xB7 0xB0 0xB9 0xBE 0xAB 0xAC 0xA5 0xA2 0x8F 0x88 0x81 0x86 0x93 0x94 0x9D 0x9A
0x27 0x20 0x29 0x2E 0x3B 0x3C 0x35 0x32 0x1F 0x18 0x11 0x16 0x03 0x04 0x0D 0x0A
0x57 0x50 0x59 0x5E 0x4B 0x4C 0x45 0x42 0x6F 0x68 0x61 0x66 0x73 0x74 0x7D 0x7A
0x89 0x8E 0x87 0x80 0x95 0x92 0x9B 0x9C 0xB1 0xB6 0xBF 0xB8 0xAD 0xAA 0xA3 0xA4
0xF9 0xFE 0xF7 0xF0 0xE5 0xE2 0xEB 0xEC 0xC1 0xC6 0xCF 0xC8 0xDD 0xDA 0xD3 0xD4
0x69 0x6E 0x67 0x60 0x75 0x72 0x7B 0x7C 0x51 0x56 0x5F 0x58 0x4D 0x4A 0x43 0x44
0x19 0x1E 0x17 0x10 0x05 0x02 0x0B 0x0C 0x21 0x26 0x2F 0x28 0x3D 0x3A 0x33 0x34
0x4E 0x49 0x40 0x47 0x52 0x55 0x5C 0x5B 0x76 0x71 0x78 0x7F 0x6A 0x6D 0x64 0x63
0x3E 0x39 0x30 0x37 0x22 0x25 0x2C 0x2B 0x06 0x01 0x08 0x0F 0x1A 0x1D 0x14 0x13
0xAE 0xA9 0xA0 0xA7 0xB2 0xB5 0xBC 0xBB 0x96 0x91 0x98 0x9F 0x8A 0x8D 0x84 0x83
0xDE 0xD9 0xD0 0xD7 0xC2 0xC5 0xCC 0xCB 0xE6 0xE1 0xE8 0xEF 0xFA 0xFD 0xF4 0xF3
```

### Plaatsing in payload

CRC-8 wordt berekend over payload bytes en is de **laatste byte van de payload**:
- Bytes 0..N-2: data
- Byte N-1: CRC-8 van bytes 0..N-2

---

## 4. Command IDs

### X3 → STM32 (versturen)

| Cmd ID | Richting | Beschrijving |
|--------|----------|-------------|
| `0x07FF` | X3 → STM32 | **Universeel commando** — sub-commando in payload[0] |

### STM32 → X3 (ontvangen)

| Cmd ID | Richting | Beschrijving |
|--------|----------|-------------|
| `0x0001` | STM32 → X3 | Data rapport — sub-commando in payload[0] |
| `0x0002` | STM32 → X3 | Data rapport — sub-commando in payload[0] |

### Dispatch logica

`chassis_cmd_deal()` op `0x11c7b0`:
1. Leest `cmd_id = (buf[2] << 8) | buf[3]`
2. Als cmd_id == 1 of 2: dispatcht op `buf[5]` (= payload[0] = sub-commando)
3. Andere cmd_ids: gelogd als "unknown command"

---

## 5. Sub-Commando Tabel: STM32 → X3 (Ontvangen)

Jump table op `0x1ffc50` (243 entries). Sub-commando = payload[0].

| Sub-Cmd | Dec | Handler | Beschrijving | ROS2 Topic |
|---------|-----|---------|-------------|------------|
| `0x01` | 1 | `chassis_cmd_deal_version` | Firmware versie rapport | `chassis_version` |
| `0x03` | 3 | `chassis_cmd_deal_wheel_speed` | Wielsnelheid + odometrie | `odom`, `odom_raw`, `/tf` |
| `0x05` | 5 | `chassis_cmd_deal_gngga` | GPS GNGGA NMEA data | *(GPS)* |
| `0x06` | 6 | `chassis_cmd_deal_X3_TimeSync` | Tijdsynchronisatie MCU↔X3 | *(intern)* |
| `0x08` | 8 | *(inline)* | Multi-sensor data blok | *(IMU composite)* |
| `0x09` | 9 | `chassis_cmd_deal_imu40608` | IMU ICM-40608 data | `imu_data` |
| `0x0A` | 10 | `chassis_cmd_deal_motor_current` | Motorstroom (links/rechts/mes) | `motor_current` |
| `0x0B` | 11 | `chassis_cmd_deal_charge_cur_vol` | Laadstroom/spanning | `charge_data` |
| `0x0C` | 12 | `chassis_cmd_deal_hall_status` | Hall sensor status (4x botsing) | `hall_status` |
| `0x0F` | 15 | `chassis_cmd_deal_mcu_log` | MCU debug log berichten | *(log)* |
| `0x17` | 23 | `chassis_cmd_deal_battery_message` | Accu status (SoC, spanning, stroom, temp) | `battery_message` |
| `0x18` | 24 | `chassis_cmd_deal_chassis_incident` | Error/warning/event flags | `chassis_incident` |
| `0x20` | 32 | *(inline)* | Hardware self-check resultaat | `chassis_cs_hardware_selfcheck` |
| `0x3D` | 61 | `chassis_cmd_deal_satelliteMATCHEDPOSA` | RTK MATCHEDPOSA | *(GPS)* |
| `0x3F` | 63 | `chassis_cmd_deal_satellitePsrdopa` | RTK PSRDOPA DOP | *(GPS)* |
| `0x40` | 64 | `chassis_cmd_deal_satelliteBestPos` | RTK BESTPOS positie | `BestPos` |
| `0x41` | 65 | `chassis_cmd_deal_satelliteBestVel` | RTK BESTVEL snelheid | `BestVel` |
| `0x42` | 66 | `chassis_cmd_deal_imu20602` | IMU ICM-20602 (6-axis) | `imu_data` |
| `0x43` | 67 | `chassis_cmd_deal_bmm150` | BMM150 magnetometer (3-axis) | `imu_data` |
| `0x45` | 69 | *(inline)* | Status byte (offset 0xECA) | *(intern)* |
| `0x58` | 88 | *(inline)* | LoRa/connectiviteit status | *(intern)* |
| `0x70` | 112 | *(inline)* | Boolean flag rapport | *(publish)* |
| `0x80` | 128 | *(inline JSON parse)* | JSON-formatted MCU data | *(intern)* |
| `0xF2` | 242 | *(inline)* | Single-byte publish | *(publish)* |
| `0xF3` | 243 | *(inline)* | Groot data blok transfer | *(intern)* |

### Gedetailleerde Payload Formaten (STM32 → X3)

#### Sub-cmd 0x01: Versie Rapport
```
Payload: [board_v1] [board_v2] [board_v3] [ctrl_v1] [ctrl_v2] [ctrl_v3] [CRC]
Log: "chassis_board_version: %d %d %d, chassis_control_version: %d %d %d"
```

#### Sub-cmd 0x03: Wielsnelheid
```
Payload: [encoder data + timestamp]
→ Berekent odometrie (differential drive)
→ Publiceert odom_raw, odom, odom_3d, /tf (odom→base_link)
Wielafstand: 0.40342 m, wieldiameter: 0.22356 m
```

#### Sub-cmd 0x0A: Motorstroom
```
Payload: [left_current] [right_current] [blade_current] [CRC]
→ novabot_msgs/ChassisMotorCurrent
```

#### Sub-cmd 0x0B: Laaddata
```
Payload: [charge_vol_v] [charge_cur_ma] [battery_vol_v] [adapter_vol_v] [CRC]
Log: "charge_data: charge_vol_v = %f, charge_cur_ma = %f, battery_vol_v = %f, adapter_vol_v = %f"
```

#### Sub-cmd 0x0C: Hall Sensor Status
```
Payload: [left_front] [left_behind] [right_behind] [right_front] [CRC]
→ novabot_msgs/ChassisHallStatus (4 collision sensors)
```

#### Sub-cmd 0x17: Accu Bericht
```
Payload bevat (uit strings):
- battery_rsoc_percent      — SoC percentage
- battery_voltage_mv        — spanning in mV
- battery_current_ma        — stroom in mA
- battery_soc_mah           — SoC in mAh
- battery_nominal_capacity_mah
- battery_cycle             — laadcycli
- battery_equiponderant_state_low/high  — celbalans
- battery_fet_control_status
- battery_ntc1_temp_c / ntc2_temp_c    — temperatuur
```

#### Sub-cmd 0x18: Chassis Incident Flags
```
Bitfield met 48+ incident types over 4 niveaus:

Events:   event_start_mowing, event_start_recharging
Warnings: collision_stop, upraise_stop, tile_stop, motor stall/overcurrent (L/R/blade),
          charge_stop, rtk_lost_location_stop, lora_rtk_data_overtime, usb_overtime
Errors:   collision_stop, upraise_stop, tile_stop, turn_over, motor stall/overcurrent,
          imu, lora, rtk, charge_stop, wheel_static_over_current_timeout_stop,
          no_pin_code, usb_busy_error, usb_not_ok_error, no_set_pin_code, lift_motor_error
Class B:  cpu_registers_fail, stack_overflow_fail, clock_fail, memory_crc_fail,
          ram_fail, external_communication_fail, adc_fail
```

---

## 6. Sub-Commando Tabel: X3 → STM32 (Versturen)

Allemaal verstuurd met frame cmd_id = `0x07FF`. Sub-commando = payload[0].

| Sub-Cmd | Dec | ROS2 Trigger | Payload Len | Beschrijving |
|---------|-----|-------------|-------------|-------------|
| `0x02` | 2 | `cmd_vel` (Twist) | 8 | **Motor snelheid commando** |
| `0x02` | 2 | `cloud_move_cmd` | 8 | Cloud-gestuurde motor snelheid |
| `0x02` | 2 | `protect_back_vel` | 8 | Beschermende achterwaarts beweging |
| `0x0D` | 13 | `/chassis_node/led_level` | 8 | LED helderheid control |
| `0x12` | 18 | `blade_speed_set` (Int16) | 8 | Maaisnelheid instellen |
| `0x14` | 20 | `blade_up_set` (String) | 8 | Maaihoogte omhoog |
| `0x15` | 21 | `blade_down_set` (String) | 8 | Maaihoogte omlaag |
| `0x19` | 25 | `rtk_location_lost_cb` | 8 | RTK positie verloren |
| `0x22` | 34 | `release_charge_lock` (UInt8) | 8 | Charger lock openen |
| `0x23` | 35 | `blade_height_set` (UInt8) | 8 | Maaihoogte instellen |
| `0x44` | 68 | `blade_height_set` (alt) | 8 | Maaihoogte (alternatief) |
| `0x46` | 70 | `release_charge_lock` (alt) | 8 | Charger lock control |
| `0x50` | 80 | `robot_status` (RobotStatus) | 9-10 | Robot status naar MCU |
| `0x55` | 85 | `rtk_location_lost_cb` | 8 | Uitgebreide RTK status |
| `0x5E` | 94 | `rtk_location_lost_cb` | 8 | RTK recovery status |
| `0x71` | 113 | `unbind_finish_cb` | 8 | Unbind afgerond notificatie |
| `0xF1` | 241 | `sub_led_set_cb` | 8 | LED modus (speciaal) |

### Velocity Commando Payload (Sub-cmd 0x02) — KRITIEK

```
Byte 0: 0x02              — sub-commando: motor snelheid
Byte 1-2: linker wiel     — int16, big-endian, in mm/s
Byte 3-4: rechter wiel    — int16, big-endian, in mm/s
Byte 5-6: 0x00 0x00       — gereserveerd
Byte 7: CRC-8             — CRC van bytes 0-6
```

### Snelheidsberekening (uit `nav_callback`)

```c
// ROS2 Twist → wielsnelheden
double track = wheel_separation;  // 0.40342 m (uit URDF)
double left  = twist.linear.x - track * twist.angular.z * 0.5;
double right = twist.linear.x + track * twist.angular.z * 0.5;
int16_t left_speed  = (int16_t)(left * 1000.0);   // m/s → mm/s
int16_t right_speed = (int16_t)(right * 1000.0);   // m/s → mm/s
```

### Robot Status Payload (Sub-cmd 0x50)

```
Byte 0: 0x50              — sub-commando: robot status
Byte 1: robot mode        — uit RobotStatus msg
Byte 2-4: extra status bytes
Byte 5: RobotStatus[0xB]
Byte 6: RobotStatus[0xCE]
Byte 7: extra status byte
Byte 8: CRC-8             — CRC van bytes 0-7
```

---

## 7. Volledige ROS2 Interface Mapping

### Subscribed Topics (X3 → STM32)

| Topic | Message Type | Callback | MCU Sub-cmd |
|-------|-------------|----------|-------------|
| `cmd_vel` | `geometry_msgs/Twist` | `nav_callback` | `0x02` |
| `cloud_move_cmd` | `novabot_msgs/CloudMoveCmd` | `cloud_move_callback` | `0x02, 0x0D` |
| `blade_speed_set` | `std_msgs/Int16` | `sub_setBladeSpeed_cb` | `0x12` |
| `blade_up_set` | `std_msgs/String` | `sub_setBladeUp_cb` | `0x14` |
| `blade_down_set` | `std_msgs/String` | `sub_setBladeDown_cb` | `0x15` |
| `blade_height_set` | `std_msgs/UInt8` | `set_blade_height_cb` | `0x23, 0x44` |
| `release_charge_lock` | `std_msgs/UInt8` | `release_charge_lock_cb` | `0x22, 0x46` |
| `/chassis_node/led_level` | `std_msgs/UInt8` | `sub_led_set_cb` | `0x0D, 0xF1` |
| `/chassis_node/buzzer_control` | `std_msgs/UInt64` | `buzzer_control_cb` | `0x50` |
| `/chassis_node/led_buzzer_switch_set` | `std_msgs/UInt8` | `led_buzzer_switch_cb` | *(intern)* |
| `/robot_decision/robot_status` | `decision_msgs/RobotStatus` | `robot_status_cb` | `0x50` |
| `/robot_decision/map_position` | `geometry_msgs/Pose` | `sub_map_positon_cb` | `0x50` |
| `/x3/safe/mode` | `std_msgs/UInt8` | `safe_mode_cb` | `0x50` |
| `auto_manual_mode` | `std_msgs/UInt8` | `auto_manual_mode_cb` | `0x50` |
| `protect_back_vel` | `geometry_msgs/Twist` | `protect_back_callback` | `0x02, 0x12, 0x19, 0x55` |
| `gps_raw` | `sensor_msgs/NavSatFix` | `gps_raw_cb` | *(passthrough)* |
| `MotorDriverReset` | `std_msgs/String` | `sub_MotorDriverReset_cb` | *(reset)* |
| `chassis/test` | `std_msgs/UInt8` | `chassis_test_cb` | *(test mode)* |

### Published Topics (STM32 → X3)

| Topic | Message Type | Bron Sub-cmd |
|-------|-------------|-------------|
| `odom` / `odom_raw` / `odom_3d` | `nav_msgs/Odometry` | `0x03` |
| `/tf` | `tf2_msgs/TFMessage` | `0x03` (odom→base_link) |
| `imu_data` | `sensor_msgs/Imu` | `0x08, 0x09, 0x42, 0x43` |
| `motor_current` | `novabot_msgs/ChassisMotorCurrent` | `0x0A` |
| `charge_data` | `novabot_msgs/ChassisChargeData` | `0x0B` |
| `hall_status` | `novabot_msgs/ChassisHallStatus` | `0x0C` |
| `battery_message` | `novabot_msgs/ChassisBatteryMessage` | `0x17` |
| `chassis_incident` | `novabot_msgs/ChassisIncident` | `0x18` |
| `chassis_version` | `novabot_msgs/ChassisVersion` | `0x01` |
| `chassis_cs_hardware_selfcheck` | `novabot_msgs/ChassisHardwareSelfCheck` | `0x20` |
| `BestPos` | `novabot_msgs/BestPos` | `0x40` |
| `BestVel` | `novabot_msgs/BestVel` | `0x41` |
| `blade_speed_get` | *(blade speed)* | *(status)* |
| `blade_height` | *(blade height)* | *(status)* |
| `battery_level` | *(battery %)* | `0x17` |
| `collision_range` | `sensor_msgs/Range` | `0x0C` |
| `chassis_data` | `novabot_msgs/ChassisData` | *(composite)* |

### Services (chassis_control als CLIENT)

| Service | Type | Beschrijving |
|---------|------|-------------|
| `/robot_decision/start_cov_task` | `decision_msgs/StartCoverageTask` | Start maaien |
| `/robot_decision/stop_task` | `std_srvs/Trigger` | Stop huidige taak |
| `/robot_decision/cancel_task` | `std_srvs/Trigger` | Annuleer taak |
| `/robot_decision/nav_to_recharge` | `decision_msgs/Charging` | Terug naar charger |
| `/chassis_node/init_ok` | `std_srvs/SetBool` | Init compleet melden |

### Services (chassis_control als SERVER)

| Service | Type | Beschrijving |
|---------|------|-------------|
| `/chassis_node/led_level` | *(UInt8)* | LED helderheid |
| `/chassis_node/led_buzzer_switch_get` | *(get)* | LED/buzzer status opvragen |
| `/chassis_node/buzzer_control` | *(UInt64)* | Buzzer aansturen |

### Action Servers

| Action | Type | Beschrijving |
|--------|------|-------------|
| `chassis_lora_set` | `novabot_msgs/ChassisLoraSet` | LoRa configureren |
| `chassis_pin_code_set` | `novabot_msgs/ChassisPinCodeSet` | PIN code instellen |

### Action Client

| Action | Type | Beschrijving |
|--------|------|-------------|
| `/auto_charging` | `automatic_recharge_msgs/AutoCharging` | Auto-opladen |

---

## 8. Robot Fysieke Parameters (uit URDF)

### Differential Drive Kinematica

| Parameter | Waarde | Eenheid |
|-----------|--------|---------|
| **Wielafstand** (track width) | **0.40342** | m |
| **Wieldiameter** | **0.22356** | m |
| **Wielradius** | 0.11178 | m |
| Robot massa (body) | 8.936 | kg |
| Wiel massa (per stuk) | 0.215 | kg |
| Totaal massa | 9.366 | kg |

### Sensor Posities (t.o.v. base_link = wielassen)

| Sensor | X (vooruit) | Y (links) | Z (omhoog) | Rotatie |
|--------|------------|-----------|------------|---------|
| GPS antenne (nieuw) | +0.186 | 0 | +0.15 | — |
| GPS antenne (oud) | +0.325 | 0 | +0.14 | — |
| IMU (nieuw) | -0.082 | 0 | +0.07 | yaw=90deg, roll=-0.5deg |
| IMU (oud) | -0.027 | 0 | +0.07 | yaw=90deg, roll=-0.5deg |
| TOF camera | +0.395 | +0.01 | +0.12 | 84.8deg roll, 180deg pitch |
| Botsing L/R | +0.276 | +/-0.133 | +0.075 | — |
| Mes motor | +0.160 | 0 | 0 | — |
| Omni camera | +0.300 | 0 | +0.20 | — |
| Lidar | 0 | 0 | +0.30 | — |

### URDF Variant Selectie

Op basis van `mcu_message.json` (hardware_version) en SN:
- Nieuw GPS + nieuw IMU → `novabot_description_new_gps_imu_loc.urdf`
- Nieuw GPS + oud IMU → `novabot_description_new_gps_loc.urdf`
- Oud GPS → `novabot_description_old_gps_loc.urdf`

---

## 9. MCU Firmware Update Protocol (IAP)

`CChassisMcuUpdata` implementeert In-Application Programming:

### Update Stappen

1. `iap_GotoIap()` — Schakel MCU naar bootloader modus
2. `iap_isIAP()` — Verifieer MCU in IAP modus
3. `iap_checkVersion()` — Lees huidige versie
4. `iap_SendFileSize()` — Stuur firmware grootte
5. **Loop**: `iap_SendBlkInfo()` + `iap_SendBlkData()` — Stuur data blokken
6. `iap_SendCrcData()` — Stuur CRC-32 voor validatie
7. `iap_GotoApp()` — Boot nieuwe firmware
8. `iap_isApp()` — Verifieer MCU boot

Firmware bestanden: `/share/chassis_control/MCU_BIN/`
CRC-32 tabel: `Crc32Table` op `0x288680` (alleen voor IAP)

---

## 10. Incident Types (48+ types)

### IEC 60730 Class B Safety Tests

| Test | Beschrijving |
|------|-------------|
| `cpu_registers_fail` | CPU register checkerboard (R0-R12) |
| `stack_overflow_fail` | Stack overflow detectie (4 regio's) |
| `clock_fail` | Klok cross-meting (LSI/HSE) |
| `memory_crc_fail` | Flash CRC-32 verificatie |
| `ram_fail` | RAM March C- test |
| `external_communication_fail` | Seriële communicatie fout |
| `adc_fail` | ADC VREFINT controle |

### Motor/Sensor Bescherming

| Type | Beschrijving |
|------|-------------|
| `left/right_motor_stall_stop` | Wielmotor geblokkeerd |
| `left/right_motor_overcur_stop` | Wielmotor overcurrent |
| `blade_motor_stall_stop` | Mesmotor geblokkeerd |
| `blade_motor_overcur_stop` | Mesmotor overcurrent |
| `lift_motor_error` | Liftmotor fout |
| `wheel_static_over_current_timeout_stop` | Statische overcurrent timeout |
| `collision_stop` | Botsing gedetecteerd |
| `upraise_stop` | Ophef gedetecteerd |
| `tile_stop` / `turn_over` | Kantelen/omslaan |
| `imu` | IMU fout |

### Connectiviteit

| Type | Beschrijving |
|------|-------------|
| `lora` | LoRa communicatie fout |
| `rtk` / `rtk_lost_location_stop` | RTK GPS verloren |
| `lora_rtk_data_overtime` | LoRa RTK data te oud |
| `usb_busy_error` / `usb_not_ok_error` | USB serieel fout |
| `usb_overtime` | USB communicatie timeout |
| `charge_stop` | Laadfout |

---

## 11. Configuratie Parameters

| Parameter | Type | Default | Beschrijving |
|-----------|------|---------|-------------|
| `imu_zero_bias_sample_time` | float | 18.0 | IMU kalibratie tijd bij boot (seconden) |
| `enable_map_as_odom` | bool | false | Odom frame als map frame gebruiken |
| `enable_odom_broadcast` | bool | true | Odom→base_link TF publiceren |
| `enable_thread_priority` | bool | true | Real-time thread scheduling |
| `max_diff_age` | float | 30.0 | Max. leeftijd RTK correcties (seconden) |
| `imu_baselink_roll` | float | -0.0081 | IMU mounting compensatie (radialen) |
| `protect_forward_vel` | float | *(?)* | Beschermingsmodus vooruit snelheid |
| `protect_keep_time` | float | *(?)* | Beschermingsmodus duur |

---

## 12. Protocol Quick Reference

### Frame versturen naar STM32

```
[02 02] [07 FF] [LL] [SS DD DD DD DD DD DD CC] [03 03]

02 02   = header
07 FF   = command ID (altijd 0x07FF voor X3→STM32)
LL      = payload length (inclusief sub-cmd en CRC)
SS      = sub-commando byte (zie sectie 6)
DD...   = data
CC      = CRC-8 (polynoom 0x07, init 0x00) van payload bytes
03 03   = footer
```

### Frame ontvangen van STM32

```
[02 02] [00 01] [LL] [SS DD DD ... CC] [03 03]
   of:
[02 02] [00 02] [LL] [SS DD DD ... CC] [03 03]

00 01/02 = command ID (0x0001 of 0x0002)
SS       = sub-commando byte (zie sectie 5)
```

### Voorbeeld: Snelheidscommando

Links = 500 mm/s, rechts = 300 mm/s:

```
Sub-cmd: 0x02
Payload: 02  01F4  012C  0000  [CRC]
         ^   ^^^^  ^^^^  ^^^^
         |   |     |     gereserveerd
         |   |     rechter wiel (300 mm/s, big-endian)
         |   linker wiel (500 mm/s, big-endian)
         sub-commando

Volledige frame: 02 02 07 FF 08 02 01 F4 01 2C 00 00 [CRC] 03 03
```

### Voorbeeld: LED helderheid

Helderheid = 100:

```
Sub-cmd: 0x0D
Payload: 0D  [brightness] [00 00 00 00 00] [CRC]

Volledige frame: 02 02 07 FF 08 0D 64 00 00 00 00 00 [CRC] 03 03
```

---

## Bronbestanden

- `/tmp/chassis_control/chassis_control_node` — Originele binary (4.7MB, ARM64)
- `/tmp/chassis_control/serial_protocol_analysis.md` — Gedetailleerde disassembly analyse
- `/tmp/chassis_control/strings_analysis.md` — Gecategoriseerde strings (1250 regels)
- `/tmp/chassis_control/config_analysis.md` — Launch + URDF analyse
- `/tmp/chassis_control/all_symbols.txt` — Volledige symbool tabel (8766 entries)
- `research/STM32_firmware_feasibility_analysis.md` — STM32 firmware haalbaarheidsanalyse
