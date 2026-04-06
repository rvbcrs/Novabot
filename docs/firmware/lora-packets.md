# LoRa Packet Structures

Detailed binary packet formats for each LoRa command category.

## REPORT (0x34) — Heartbeat & Status

### Charger → Mower: Poll (0x34, 0x01)

```
[02 02 00 03 03 34 01 35 03 03]
 ├─ start ─┤ │len│ cmd│chk│ end │
            addr  payload
```

### Mower → Charger: Status Report (0x34, 0x02, data...)

19-byte payload with mower telemetry:

```
[02 02 00 01 14 34 02 SS SS SS SS II II II II XX XX XX YY YY YY ZZ ZZ ZZ I1 I1 CC 03 03]
                      ├─ cmd ─┤  ├─ status ─┤ ├─ info ──┤ ├─ x ──┤ ├─ y ──┤ ├─ z ──┤ ├i1┤
```

| Offset | Size | Encoding | Global Variable | MQTT Field |
|--------|------|----------|----------------|------------|
| 7-10 | 4 bytes | uint32 LE | `DAT_42000c54` | `mower_status` |
| 11-14 | 4 bytes | uint32 LE | `DAT_42000c58` | `mower_info` |
| 15-17 | 3 bytes | uint24 LE | `DAT_42000c5c` | `mower_x` |
| 18-20 | 3 bytes | uint24 LE | `DAT_42000c60` | `mower_y` |
| 21-23 | 3 bytes | uint24 LE | `DAT_42000c64` | `mower_z` |
| 24-25 | 2 bytes | uint16 LE | `DAT_42000c68` | `mower_info1` |

---

## ORDER (0x35) — Mowing Commands

### start_run (0x35, 0x01)

```
[0x35, 0x01, mapName, area, cutterHeight]
```

5-byte payload: command (0x35), sub-command (0x01), map name byte, area byte, cutter height byte.

### pause_run (0x35, 0x03)

```
[0x35, 0x03]
```

### resume_run (0x35, 0x05)

```
[0x35, 0x05]
```

### stop_run (0x35, 0x07)

```
[0x35, 0x07]
```

### stop_time_run (0x35, 0x09)

```
[0x35, 0x09]
```

### go_pile (0x35, 0x0B)

```
[0x35, 0x0B]
```

---

## RTK_RELAY (0x31) — GPS NMEA Relay

The charger receives GNGGA NMEA sentences from its UM960 RTK module and relays them to the mower via LoRa.

```
[0x31, NMEA_data_bytes...]
```

Example NMEA: `$GNGGA,120000.00,5208.45,N,00613.86,E,1,17,0.8,8.82,M,46.3,M,,*xx`

The mower uses this for centimeter-accurate RTK GPS positioning.

---

## GPS (0x33) — Position Data

```
[0x33, lat(8B), lon(8B)]
```

16 bytes of GPS position: latitude (8 bytes, double) + longitude (8 bytes, double).

---

## CONFIG (0x32) — Configuration

Configuration commands sent to the mower via LoRa.

---

## CHARGER (0x30) — Hardware Control

Charger-specific hardware commands:

- Hall sensor acknowledgment
- IRQ acknowledgment

---

## SCAN_CHANNEL (0x36) — Channel Scanning

Used during LoRa channel optimization. The charger scans all channels from `lc` to `hc`, measures RSSI on each, and selects the best channel.

---

## Checksum Calculation

The XOR checksum is calculated over all payload bytes (excluding start/end markers and length byte):

```python
checksum = 0
for byte in payload:
    checksum ^= byte
```
