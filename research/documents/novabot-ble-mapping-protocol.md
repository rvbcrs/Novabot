# Novabot BLE Mapping Protocol — Verified Reference

Source: Flutter app v2.4.0 blutter decompilation (`research/blutter_output_v2.4.0/`) + live BLE traffic from mower mqtt_node log (`/root/novabot/data/ros2_log/mqtt_node_20260417_210016_2823.log`)
Date: 2026-04-17 (updated same day with live-session corrections)

---

## 1. Transport Split

Mapping and mowing use DIFFERENT transports. This is not a choice — it is hardcoded in the app.

| Layer | Transport | Mechanism |
|-------|-----------|-----------|
| Mapping commands | **BLE** | `BleTools.writeData` with `ble_start` / 20-byte chunks / `ble_end` framing |
| Mowing commands | **MQTT** | `Mqtt::sendJson` (AES-128-CBC encrypted for LFI* devices) |

Evidence:
- `pages/build_map/build_map_page/logic.dart` → `_writeDataToDevice` → `BleTools.writeData` for all map commands
- `pages/home_page/view/mower_status/online_view.dart:2356` → `Mqtt::sendJson` for `start_navigation`

All mapping commands therefore require an active BLE connection to the mower. The mower must be in BLE advertisement mode (it is, during the mapping flow).

---

## 2. BLE Frame Format

Every mapping command is wrapped in the standard Novabot BLE framing (same framing as provisioning):

```
ble_start
<chunk 1, max 20 bytes>
<chunk 2, max 20 bytes>
...
ble_end
```

The JSON payload is split across chunks with no delimiter between them. Recipient reassembles by waiting for `ble_end`.

---

## 3. Mapping State Machine

All methods are in `pages/build_map/build_map_page/logic.dart` (class `BuildMapPageLogic`).

| Method | Approx. line | Command sent | Trigger |
|--------|-------------|--------------|---------|
| `clickStart` | L12873 | `start_scan_map` OR `add_scan_map` | User taps "Start" |
| `clickDone` | L4544 | `stop_scan_map` | User taps "Done" (finalize) |
| `_writeSaveMap` | L11958 | `save_map` | Auto-called after `stop_scan_map_respond` |
| `clickStop` | L13575 | `stop_erase_map` | User taps "Cancel" (abort without saving) |
| `clickRetract` | L13697 | `start_erase_map` | User taps "Undo" (via modal confirm) |
| `onAotuMappingClick` | L14566 | `start_assistant_build_map { type: 2 }` | Autonomous mapping start |
| `clickPauseAuto` | L14438 | `start_assistant_build_map { type: 0 }` | Autonomous mapping pause |
| `_saveChargePosition` | ~L7200 | `save_recharge_pos` | User positions mower on charger after map0 |
| `onJoystick` | L15295 | `quit_mapping_mode { value: 1 }` | Manual joystick override during auto mapping |

---

## 4. Exact BLE Payloads

All payloads include a sequential `cmd_num` counter (incremented by caller).

### `start_scan_map` — First work map only (map0)

Sent when `clickStart` branch A fires (no existing maps).

**CORRECTION 2026-04-17**: Earlier analysis read `type: null` from the Dart assembly (Smi-typed slot in `BuildMapPageLogic::clickStart` L12873 via `rZR` register). The live mower log proves the wire value is integer `0`, not JSON null. The Dart VM serializes an unset Smi as `0` in JSON.

```json
{
  "start_scan_map": {
    "model": "manual",
    "mapName": "map0",
    "type": 0,
    "cmd_num": 1
  }
}
```

Live log evidence (`mqtt_node_20260417_210016_2823.log`, 21:45:20):
```
cmd_msgrcv_pipe_read {"start_scan_map":{"model":"manual","mapName":"map0","type":0,"cmd_num":1222137035}}
```

### `add_scan_map` — All subsequent regions

Sent when `clickStart` branches B–E fire. The `type` value encodes WHAT is being scanned:

| Branch | `BuildMapType` enum value | `type` field | Meaning |
|--------|--------------------------|-------------|---------|
| B | (default / additional work area) | `0` (integer) | Additional work map (map1, map2, …) |
| C | `BuildMapType@a4b921` | `2` | Obstacle polygon within a work map |
| D | `BuildMapType@a4b901` ("unicom") | `4` | Map-to-map passage channel |
| E | `BuildMapType@a4b8e1` | `8` | Map-to-charger passage channel |

**CORRECTION 2026-04-17**: Branch B was previously listed as `null`. Correct value is integer `0`.

Payload structure is identical across all branches:

```json
{
  "add_scan_map": {
    "model": "manual",
    "mapName": "<from _getMapName()>",
    "type": <0|2|4|8>,
    "cmd_num": 2
  }
}
```

`_getMapName()` returns `"map0"`, `"map1"`, `"map2"` etc. based on the current map index.

### `stop_scan_map` — Finalize scan (clickDone)

```json
{
  "stop_scan_map": {
    "value": <boolean>,
    "cmd_num": 3
  }
}
```

`value` is `true` when the current `BuildMapType` is `@a4b901` (unicom channel), `false` for all other types.

Timeout: 20 seconds for `stop_scan_map_respond`.

### `save_map` — Persist to mower storage

**CRITICAL**: `save_map` is sent TWICE per mapping session. The two sends have different `type` values and cause different firmware behaviour. Confusing them causes Error 107.

#### First `save_map` (type:0, "sub map") — auto after stop_scan_map_respond

Called automatically by `_writeSaveMap` after `stop_scan_map_respond`. Saves only the CSV trail files.

```json
{
  "save_map": {
    "mapName": "map0",
    "type": 0,
    "cmd_num": 4
  }
}
```

Mower firmware response: `"Saving sub map!!!"` — writes `csv_file/map0_work.csv` + `x3_csv_file/map0_work.csv`.

#### Second `save_map` (type:1, "total map") — 500ms after save_recharge_pos_respond

Called 500ms after receiving `save_recharge_pos_respond`, via `Future.delayed(Duration(microseconds:500000))` at logic.dart addr 0x906744–0x906748 → `_writeSaveMap()` at 0x9075a8. The param passed to `_writeSaveMap` flips bit 4, causing `(param & 0x10) ? 0 : 1` → `type: 1`.

```json
{
  "save_map": {
    "mapName": "map0",
    "type": 1,
    "cmd_num": 6
  }
}
```

Mower firmware response: `"Saving total map!!!"` — regenerates the occupancy grid:
- `/userdata/lfi/maps/home0/map.pgm` (grayscale occupancy grid, ~12 KB, ~100×110 px @ 0.05 m/px)
- `/userdata/lfi/maps/home0/map.png` (preview)
- `/userdata/lfi/maps/home0/map.yaml` (Nav2 map metadata: origin, resolution, image path)

Also generates `csv_file/map0tocharge_unicom.csv` and triggers ZIP upload #2.

Live log evidence (`mqtt_node_20260417_210016_2823.log`):
```
21:46:07  cmd_msgrcv_pipe_read {"save_map":{"mapName":"map0","type":0,"cmd_num":1222137037}}
           → "Saving sub map!!!"
21:48:27  cmd_msgrcv_pipe_read {"save_map":{"mapName":"map0","type":1,"cmd_num":1222137040}}
           → "Saving total map!!!"
```

**Why type:1 is mandatory**: `/map_server/load_map` (called when `start_navigation` fires) opens `map.yaml` — NOT `map0.yaml`. Without the type:1 save, `map.yaml` does not exist → Error 107 "Load map failed".

Summary table:

| save_map call | type | Firmware label | Files written | Required for |
|--------------|------|----------------|---------------|-------------|
| After stop_scan_map_respond | `0` | "Saving sub map!!!" | csv_file + x3_csv_file | ZIP upload #1 |
| 500ms after save_recharge_pos_respond | `1` | "Saving total map!!!" | map.pgm/png/yaml + charge unicom CSV | Navigation (Error 107 without it) |

Timeout for each: 12 seconds on `save_map_respond`.

### `stop_erase_map` — Cancel / discard scan (clickStop)

```json
{
  "stop_erase_map": {
    "cmd_num": 5
  }
}
```

This discards the current scan without saving. Do NOT confuse with `stop_scan_map` (which finalizes).

### `start_erase_map` — Undo last scan segment (clickRetract)

```json
{
  "start_erase_map": {
    "cmd_num": 6
  }
}
```

Only reachable via a modal confirm dialog in the app.

### `start_assistant_build_map` — Autonomous mapping control

```json
{
  "start_assistant_build_map": {
    "type": <2|0>,
    "cmd_num": 7
  }
}
```

- `type: 2` = start autonomous mapping (`onAotuMappingClick`, L14566)
- `type: 0` = pause autonomous mapping (`clickPauseAuto`, L14438)

### `save_recharge_pos` — Store dock position

```json
{
  "save_recharge_pos": {
    "mapName": "<active map name>",
    "map0": "",
    "cmd_num": 8
  }
}
```

Called after the user manually drives the mower onto the charger and confirms. Required once for map0; skipped for subsequent maps (map1, map2) because the dock position was already recorded.

### `quit_mapping_mode` — Exit auto mapping for manual control

```json
{
  "quit_mapping_mode": {
    "value": 1,
    "cmd_num": 9
  }
}
```

Triggered when the user activates the joystick during autonomous mapping (`onJoystick`, L15295).

---

## 5. Verified Full BLE Sequence (Working Session 2026-04-17)

The following is the complete, verified command sequence from the working Novabot-app session captured in `mqtt_node_20260417_210016_2823.log`. Use this as the reference implementation.

```
User taps "Start"
  → BLE: start_scan_map { model:"manual", mapName:"map0", type:0, cmd_num:N }
  ← start_scan_map_respond

User drives perimeter, taps "Done"
  → BLE: stop_scan_map { value:false, cmd_num:N+1 }
  ← stop_scan_map_respond
  → (auto, ~2s processing) BLE: save_map { mapName:"map0", type:0, cmd_num:N+2 }   ← SUB MAP
  ← save_map_respond { result:0, value:0 }
  → Mower uploads ZIP #1 via HTTP (csv_file/map0_work.csv only)

User drives mower onto charger, taps confirm
  → BLE: save_recharge_pos { mapName:"map0", cmd_num:N+3 }
  ← save_recharge_pos_respond { result:0, value:{ dis:0.47, orient_flag:true } }
  → (500ms delay via Future.delayed @ logic.dart:0x906744)
  → BLE: save_map { mapName:"map0", type:1, cmd_num:N+4 }                           ← TOTAL MAP
  ← save_map_respond { result:0, value:0 }
  → Mower generates map.pgm / map.png / map.yaml
  → Mower generates map0tocharge_unicom.csv
  → Mower uploads ZIP #2 via HTTP (with charge unicom + regenerated files)
```

Note: `stop_scan_map` uses `value:false` for work maps. `value:true` only for unicom type (`BuildMapType@a4b901`).

---

## 6. Files on Mower Flash After Successful Mapping

```
/userdata/lfi/maps/
├── empty_map.yaml          (optional — firmware checks but works without)
├── empty_map.png
└── home0/
    ├── csv_file/
    │   ├── map0_work.csv                  (full trail, ~300–400 points)
    │   ├── map0tocharge_unicom.csv        (dock trajectory, ~10–20 points)
    │   └── map_info.json                  (charging_pose + map_size)
    ├── x3_csv_file/
    │   ├── map0_work.csv                  (downsampled, ~50 points)
    │   └── map0tocharge_unicom.csv
    ├── map0.pgm + map0.png + map0.yaml    (per-map occupancy grid)
    ├── map.pgm + map.png + map.yaml       ← GENERATED BY type:1 save_map (Nav2 uses these)
    ├── planned_path/
    │   ├── planned_path.json
    │   └── current_planned_path.json
    └── LFIN<SN>.zip                       (uploaded bundle)
```

**Critical**: `/map_server/load_map` opens `home0/map.yaml` (not `home0/map0.yaml`) when navigation starts. This file is only created by the type:1 `save_map`. Absence → Error 107.

---

## 7. Mower Firmware CSV Naming Convention

The app sends only short `mapName` values. The mower firmware generates the canonical ZIP-internal CSV filenames from the mapName, the scan type, and its own internal counters. **Corrected 2026-04-19 from a live Novabot-app capture** — the previous table was based on decompile guesses and had obstacle wrong.

| Scan kind | mapName sent | type | Generated CSV filename |
|-----------|-------------|------|-----------------------|
| Work map 0 | `"map0"` | `0` | `map0_work.csv` |
| Work map 1 | `"map1"` | `0` | `map1_work.csv` |
| **Obstacle** | **`"map"`** (literal) | **`1`** | `map0_0_obstacle.csv`, `map0_1_obstacle.csv` ... (auto-indexed, parent from active context) |
| Unicom (map↔map) | `"map1"` (source map) | `2` | `map0tomap1_0_unicom.csv` (from/to derived from trajectory) |
| Charge unicom | *(implicit via `save_recharge_pos`)* | — | `mapXtocharge_unicom.csv` |

Key: **obstacle uses the literal string `"map"` for mapName — NOT the parent work map name**. The firmware keeps the active work-map context from the previous `start_scan_map`/`add_scan_map` and auto-indexes the obstacle.

The `fromXtoY` portion on unicoms is determined by the mower tracking its start/end positions during the scan.

### 7.1. Obstacle Flow — Verified Live Capture (2026-04-19)

Captured on LFIN1231000211 via `/root/novabot/data/ros2_log/mqtt_node_*.log` while using the official Novabot app to add one obstacle:

```
# 1. Enter obstacle scan mode (work map already exists)
cmd_msgrcv_pipe_read {"add_scan_map":{"model":"manual","mapName":"map","type":1,"cmd_num":536457258}}
→ strJson_send {"message":{"result":0,"value":{"map_position":{"x":...,"y":...}}},"type":"add_scan_map_respond"}

# 2. User drives around the obstacle via joystick (mst commands)

# 3. Stop scanning
cmd_msgrcv_pipe_read {"stop_scan_map":{"value":false,"cmd_num":536457259}}
→ strJson_send {"message":{"result":0,"value":null},"type":"stop_scan_map_respond"}

# 4. Save — sub phase (firmware writes the obstacle CSV here)
cmd_msgrcv_pipe_read {"save_map":{"mapName":"map","type":0,"cmd_num":536457260}}
→ generate_map_file_name = map0_0_obstacle.csv
→ strJson_send {"message":{"result":0,"value":0},"type":"save_map_respond"}

# 5. Save — total phase (firmware updates map.pgm/png/yaml)
cmd_msgrcv_pipe_read {"save_map":{"mapName":"map","type":1,"cmd_num":536457261}}
→ strJson_send {"message":{"result":0,"value":0},"type":"save_map_respond"}

# 6. Trigger ZIP upload
cmd_msgrcv_pipe_read {"get_map_outline":{...}}
→ strJson_send {"message":{"result":0,"value":null},"type":"get_map_outline_respond"}
→ strJson_send {"message":{"result":0,"value":{"md5":"...","name":"LFIN1231000211.zip","zip_dir_empty":0}},"type":"get_map_list_respond"}
```

### 7.2. OpenNova Fix Applied 2026-04-19

OpenNova's obstacle flow was sending the wrong `type` and `mapName`. Fixed in `app/src/screens/MappingScreen.tsx`:

| Field | OpenNova before | OpenNova after (matches Novabot) |
|-------|----------------|----------------------------------|
| `buildTypeToScanType('obstacle')` | `2` | **`1`** |
| `add_scan_map.mapName` for obstacle | `activeMapName` (e.g. `"map0"`) | literal **`"map"`** |
| `save_map.mapName` for obstacle | `activeMapName` | literal **`"map"`** |
| `stop_scan_map.value` | `false` | ✅ `false` (unchanged — was already correct) |
| `save_map` sub+total sequence | ✅ both `type:0` then `type:1` | ✅ (unchanged) |

---

## 8. Dock Position Flow (map0 only)

After the first `save_map_respond` (type:0) for map0, the app prompts the user to drive the mower onto the charger and tap confirm. This sends `save_recharge_pos`.

For map1, map2, etc. the app skips this step entirely — the charging pose was already registered with map0 and stored on the mower.

OpenNova implementation: `app/src/screens/MappingScreen.tsx:617-625` matches this logic.

---

## 9. Payload Corrections Applied 2026-04-17

Previous incorrect payloads in OpenNova `app/src/screens/MappingScreen.tsx` that were fixed this session:

| Command | Was wrong | Fixed to |
|---------|-----------|---------|
| `start_scan_map` | Had extra `manual: true`, `map0: ''` fields; `type: null` | `model: "manual"`, `mapName: "map0"`, `type: 0` |
| `add_scan_map` work mode | Missing `model: "manual"`; `type: null` | Added model; `type: 0` (integer) |
| `buildTypeToScanType(t)` return | `number \| null` | `number` (never null) |
| Done flow | Sent `stop_erase_map` (cancel!) | `stop_scan_map { value, cmd_num }` → `save_map { type:0 }` |
| Post-save_recharge_pos | No second save_map | 500ms delay then `save_map { type:1 }` |
| `save_recharge_pos_respond` timeout | 15000ms | 20000ms (from Flutter pp+0x8ffa2c `mov x16, #0x14`) |

Also added: after type:1 save_map, send `get_map_outline { map_name: "all" }` to trigger ZIP re-upload from mower to server.

Fixed at: `MappingScreen.tsx:553-561` (start_scan_map), `MappingScreen.tsx:591-603` (add_scan_map + stop flow), and the `save_recharge_pos_respond` handler.
