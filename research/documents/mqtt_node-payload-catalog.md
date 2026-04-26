# mqtt_node — MQTT payload catalog (RE-4)

**Source capture:** `/tmp/mqtt_node_captures/2026-04-27-idle.jsonl`
(1801 s / 30 min, broker 127.0.0.1:1883, mower LFIN1231000211, chargers LFIC1230700004 + LFIC1231000319).
**Helper:** `tools/mqtt_node_capture.py`.
**Date:** 2026-04-27.
**Total lines captured:** 4285.
**Distinct (topic, command) pairs:** 11.

> WARNING: **Capture scope: IDLE-ONLY**. Mower was sitting on charger, not
> driven during the window. Mowing / mapping / dock-cycle / OTA / error
> scenarios are NOT represented. Future capture sessions can extend this
> catalog when those scenarios are exercised.

> Each command appears once. The first observed payload is the canonical
> example. Variable fields (timestamps, per-session ids, GPS coords,
> counters) are kept verbatim — the catalog documents what the stock binary
> emits, not a synthetic schema.

---

## Commands observed (Dart/Send_mqtt/<SN> — server/app → charger)

### `get_lora_info`

- **Topic:** `Dart/Send_mqtt/LFIC1230700004` (and `Dart/Send_mqtt/LFIC1231000319`)
- **Period:** ~60 s (server polls both chargers once per minute)
- **Count in 30-min window:** 30 per charger (60 total)
- **Direction:** server → charger
- **Decrypted JSON:**
  ```json
  {
    "get_lora_info": null
  }
  ```
- **Notes:** Minimal poll command. Body is always `null`. The charger responds on `Dart/Receive_mqtt/<charger_SN>` with `get_lora_info_respond` (see below). This is the only outbound command observed during idle; the mower generates no inbound commands during idle (no user-initiated actions).

---

## Commands observed (Dart/Send_mqtt/<SN> — app → mower)

> During an idle capture there are **NO** app-to-mower commands. The mower is on
> the charger and the app is not actively issuing commands. Note this
> explicitly so readers understand this section will only be populated by
> future driven-session captures.

*(None observed in this idle capture.)*

---

## Reports observed (Dart/Receive_mqtt/<SN> — mower → app)

### `report_state_robot`

- **Topic:** `Dart/Receive_mqtt/LFIN1231000211`
- **Period:** ~2.3 s
- **Count in 30-min window:** 783
- **Direction:** mower → app (and broker)
- **Decrypted JSON (first observed):**
  ```json
  {
    "report_state_robot": {
      "avoiding_obstacle_time": 0,
      "battery_power": 99,
      "cov_area": 1.2712500095367432,
      "cov_estimate_time": 6.939000606536865,
      "cov_map_path": "",
      "cov_ratio": 0.09902821481227875,
      "cov_remaining_area": 11.565000534057617,
      "cov_work_time": 0,
      "cpu_temperature": 46,
      "cpu_usage": 48,
      "current_map_ids": 1,
      "error_msg": "Error_code: 0 Robot work fine",
      "error_status": 0,
      "finished_num": 0,
      "light": 0,
      "loc_quality": 80,
      "map_num": 1,
      "msg": "Mode:MAPPING Work:FINISHED Prev work:REQUEST_START Recharge: FINISHED",
      "perception_level": 0,
      "prev_recharge_status": 193,
      "prev_task_mode": 1,
      "prev_work_status": 50,
      "recharge_status": 9,
      "request_map_ids": 1,
      "target_height": 1,
      "task_mode": 2,
      "theta": 1.6450220346450806,
      "valid_cov_work_time": 0,
      "work_status": 9,
      "x": -0.9449852705001831,
      "y": -0.9449852705001831
    }
  }
  ```
- **Key fields:**
  | Field | Type | Notes |
  |---|---|---|
  | `battery_power` | int | 0–100 % |
  | `work_status` | int | 9 = CHARGING_RECHARGE (on dock) |
  | `recharge_status` | int | 9 = FINISHED |
  | `task_mode` | int | 2 = MAPPING (last active mode) |
  | `error_status` | int | 0 = no error; 8 = LoRa disconnect (see exception report) |
  | `error_msg` | string | Human-readable error |
  | `map_num` | int | Active task count (NOT available-map count — see `map-num-meaning.md`) |
  | `current_map_ids` | int | Active map id |
  | `target_height` | int | `cutterhigh` wire value (0..7); display = `target_height + 2` cm |
  | `loc_quality` | int | 0–100; 80 = good GPS fix |
  | `theta` | float | Heading in radians |
  | `x`, `y` | float | Position in local map frame (meters) |
  | `cpu_temperature` | int | Celsius |
  | `cpu_usage` | int | Percent |
  | `cov_area` | float | Covered area m² |
  | `cov_remaining_area` | float | Remaining area m² |
  | `prev_recharge_status` | int | Previous dock status |
  | `prev_work_status` | int | Previous work status before idle |
  | `prev_task_mode` | int | Previous task mode before idle |
  | `light` | int | 0 = LED off |
  | `perception_level` | int | 0 = no obstacle detection active |
  | `finished_num` | int | Completed task count this session |

---

### `report_state_timer_data`

- **Topic:** `Dart/Receive_mqtt/LFIN1231000211`
- **Period:** ~2.3 s (in sync with `report_state_robot`)
- **Count in 30-min window:** 782
- **Direction:** mower → app (and broker)
- **Decrypted JSON (first observed):**
  ```json
  {
    "report_state_timer_data": {
      "battery_capacity": 99,
      "battery_state": "CHARGING",
      "cover_path": {
        "covered": {
          "covering_area": {
            "area_id": "0",
            "points": "0"
          },
          "finished_area": "",
          "missed": "-0.55 -1.53;0.46 -2.35;"
        },
        "finished_maps": "1",
        "map_id": "1"
      },
      "if_closed_cycle": 0,
      "if_mower_can_finish": false,
      "if_scan_unicom_obstacle": 16,
      "localization": {
        "gps_position": {
          "altitude": 10.2586,
          "latitude": 52.14088850272,
          "longitude": 6.23103584366,
          "state": "ENABLE"
        },
        "localization_state": "RUNNING",
        "map_position": {
          "orientation": 1.645022005916297,
          "x": -0.9472338984198632,
          "y": 0.2601609644737307
        }
      },
      "plan_path": 0,
      "preview_cover_path": 0,
      "start_edit_or_assistant_map_flag": 16,
      "timer_task": 0
    }
  }
  ```
- **Key fields:**
  | Field | Type | Notes |
  |---|---|---|
  | `battery_capacity` | int | 0–100 % (mirrors `battery_power` in `report_state_robot`) |
  | `battery_state` | string | `"CHARGING"` / `"DISCHARGING"` / `"FULL"` |
  | `localization.gps_position.latitude` | float | WGS84 degrees |
  | `localization.gps_position.longitude` | float | WGS84 degrees |
  | `localization.gps_position.altitude` | float | Meters |
  | `localization.gps_position.state` | string | `"ENABLE"` = RTK active |
  | `localization.localization_state` | string | `"RUNNING"` = localized |
  | `localization.map_position.x` | float | Local map x (meters) |
  | `localization.map_position.y` | float | Local map y (meters) |
  | `localization.map_position.orientation` | float | Radians |
  | `cover_path.map_id` | string | Active map id (as string) |
  | `cover_path.finished_maps` | string | Completed map passes |
  | `cover_path.covered.missed` | string | Semicolon-separated x,y pairs of missed points |
  | `if_scan_unicom_obstacle` | int | Bitmask; 16 = unicom+obstacle scan available |
  | `timer_task` | int | 0 = no scheduled task active |
  | `plan_path` | int | 0 = no active path plan |
  | `preview_cover_path` | int | 0 = no preview active |
  | `if_mower_can_finish` | bool | Whether mower can finish remaining area on current charge |
  | `if_closed_cycle` | int | Whether mow cycle is closed-loop (1) or not (0) |
  | `start_edit_or_assistant_map_flag` | int | 16 = mapping/edit mode available |

---

### `report_exception_state`

- **Topic:** `Dart/Receive_mqtt/LFIN1231000211`
- **Period:** ~2.3 s (in sync with above two)
- **Count in 30-min window:** 782
- **Direction:** mower → app (and broker)
- **Decrypted JSON (first observed):**
  ```json
  {
    "report_exception_state": {
      "button_stop": false,
      "chassis_err": 0,
      "no_set_pin_code": false,
      "rtk": true,
      "rtk_sat": 31,
      "wifi_rssi": 54
    }
  }
  ```
- **Key fields:**
  | Field | Type | Notes |
  |---|---|---|
  | `button_stop` | bool | Physical stop button pressed |
  | `chassis_err` | int | 0 = no chassis error; bitmask |
  | `no_set_pin_code` | bool | `true` if PIN not set (enables BLE provisioning) |
  | `rtk` | bool | `true` = RTK GPS fix active |
  | `rtk_sat` | int | RTK satellite count; 31 = strong fix |
  | `wifi_rssi` | int | WiFi signal strength (dBm unsigned, 0-100 scale in firmware) |

---

## Reports observed (Dart/Receive_mqtt/<SN> — charger → app)

### `up_status_info`

- **Topic:** `Dart/Receive_mqtt/LFIC1230700004` (and `Dart/Receive_mqtt/LFIC1231000319`)
- **Period:** ~2.0 s per charger
- **Count in 30-min window:** 894 (LFIC1230700004), 893 (LFIC1231000319)
- **Direction:** charger → app (and broker)
- **Decrypted JSON — LFIC1230700004 (mower NOT docked on this charger):**
  ```json
  {
    "up_status_info": {
      "charger_status": 469762305,
      "mower_status": 0,
      "mower_info": 0,
      "mower_x": 0,
      "mower_y": 0,
      "mower_z": 0,
      "mower_info1": 0,
      "mower_error": 17734
    }
  }
  ```
- **Decrypted JSON — LFIC1231000319 (mower IS docked here):**
  ```json
  {
    "up_status_info": {
      "charger_status": 469762305,
      "mower_status": 592130,
      "mower_info": 16802560,
      "mower_x": 6160385,
      "mower_y": 1638400,
      "mower_z": 4194560,
      "mower_info1": 2305,
      "mower_error": 0
    }
  }
  ```
- **Key fields:**
  | Field | Type | Notes |
  |---|---|---|
  | `charger_status` | int | Bitfield — 469762305 = `0x1C001101` (charger healthy + GPS active). See `docs/reference/MQTT.md` charger_status bitfield for decode |
  | `mower_status` | int | 0 = no mower docked; non-zero = LoRa telemetry from docked mower |
  | `mower_info` | int | Extended mower state via LoRa |
  | `mower_x`, `mower_y`, `mower_z` | int | Mower position packed into int32 via LoRa (cm precision) |
  | `mower_info1` | int | Secondary mower info bitmask |
  | `mower_error` | int | Mower error code via LoRa; 17734 = no docked mower (invalid/stale) |

---

### `get_lora_info_respond`

- **Topic:** `Dart/Receive_mqtt/LFIC1230700004` (and `Dart/Receive_mqtt/LFIC1231000319`)
- **Period:** ~60 s (response to `get_lora_info` poll from server)
- **Count in 30-min window:** 30 per charger (60 total)
- **Direction:** charger → app/server (response to server poll)
- **Decrypted JSON — LFIC1230700004:**
  ```json
  {
    "type": "get_lora_info_respond",
    "message": {
      "result": 0,
      "value": {
        "channel": 14,
        "addr": 719,
        "rssi": 150
      }
    }
  }
  ```
- **Decrypted JSON — LFIC1231000319:**
  ```json
  {
    "type": "get_lora_info_respond",
    "message": {
      "result": 0,
      "value": {
        "channel": 17,
        "addr": 718,
        "rssi": 157
      }
    }
  }
  ```
- **Key fields:**
  | Field | Type | Notes |
  |---|---|---|
  | `type` | string | Envelope discriminator; `"get_lora_info_respond"` |
  | `message.result` | int | 0 = success |
  | `message.value.channel` | int | LoRa channel number (mower must match) |
  | `message.value.addr` | int | LoRa device address |
  | `message.value.rssi` | int | LoRa signal strength |
- **Notes:** LFIC1230700004 reports channel=14, addr=719. LFIC1231000319 reports channel=17, addr=718. Both chargers are in use on this broker. The mower is paired with LFIC1231000319 (it is docked there per `up_status_info` evidence). Per CLAUDE.md: mower LoRa addr+channel MUST match its paired charger exactly; mismatch causes Error 8 + Error 132.

---

## Reports observed (Dart/Receive_server_mqtt/<SN> — mower → server-only)

### `report_state_to_server_work_respond`

- **Topic:** `Dart/Receive_server_mqtt/LFIN1231000211`
- **Period:** ~60 s
- **Count in 30-min window:** 30
- **Direction:** mower → server (NOT forwarded to app — server-only topic)
- **Decrypted JSON (first observed):**
  ```json
  {
    "message": {
      "result": 0,
      "value": {
        "battery_power": 99,
        "cpu_temperature": 46,
        "cpu_usage": 44,
        "disk_remaining": 7910,
        "error_status": 0,
        "gps_altitude": 10.247,
        "gps_latitude": 52.14088848442,
        "gps_longitude": 6.2310358287,
        "gps_sat_num": 33,
        "gps_status": 1,
        "hv": "v0.0.1",
        "loc_quality": 80,
        "memory_remaining": 2357,
        "ov": "V0.3.2",
        "recharge_status": 9,
        "sv": "v6.0.2-custom-24",
        "task_mode": 2,
        "timer_task": 0,
        "wifi_rssi": 54,
        "work_status": 9,
        "working_time": 1591
      }
    },
    "type": "report_state_to_server_work_respond"
  }
  ```
- **Key fields:**
  | Field | Type | Notes |
  |---|---|---|
  | `type` | string | Envelope discriminator: `"report_state_to_server_work_respond"` |
  | `message.result` | int | 0 = success |
  | `message.value.sv` | string | Software version: `"v6.0.2-custom-24"` |
  | `message.value.hv` | string | Hardware version: `"v0.0.1"` |
  | `message.value.ov` | string | OS version: `"V0.3.2"` |
  | `message.value.battery_power` | int | 0–100 % |
  | `message.value.cpu_temperature` | int | Celsius |
  | `message.value.cpu_usage` | int | Percent |
  | `message.value.disk_remaining` | int | MB |
  | `message.value.memory_remaining` | int | MB |
  | `message.value.gps_latitude` | float | WGS84 |
  | `message.value.gps_longitude` | float | WGS84 |
  | `message.value.gps_altitude` | float | Meters |
  | `message.value.gps_sat_num` | int | Visible satellite count |
  | `message.value.gps_status` | int | 1 = RTK fix |
  | `message.value.loc_quality` | int | 0–100 |
  | `message.value.work_status` | int | 9 = CHARGING_RECHARGE |
  | `message.value.recharge_status` | int | 9 = FINISHED |
  | `message.value.task_mode` | int | 2 = last mode was MAPPING |
  | `message.value.error_status` | int | 0 = no error |
  | `message.value.timer_task` | int | 0 = no scheduled task |
  | `message.value.wifi_rssi` | int | WiFi RSSI |
  | `message.value.working_time` | int | Cumulative working time (seconds? minutes?) |
- **Notes:** Server subscribes to `Dart/Receive_server_mqtt/+` exclusively for this heartbeat. This allows the server to update its own state (dashboards, DB) without touching the mower-to-app channel. The server MUST NOT modify or re-publish messages from this topic (per CLAUDE.md `feedback_no_mqtt_intercept.md`).

---

### `report_state_to_server_exception_respond`

- **Topic:** `Dart/Receive_server_mqtt/LFIN1231000211`
- **Period:** event-driven (only emitted when exception state changes)
- **Count in 30-min window:** 1 (LoRa disconnect event at 22:38:21 UTC)
- **Direction:** mower → server (server-only topic)
- **Decrypted JSON:**
  ```json
  {
    "message": {
      "result": 0,
      "value": {
        "robot_button_stop": false,
        "robot_collision": false,
        "robot_error_msg": "Error_code: 8 Lora disconnect for some time,may causing localization not good!!!",
        "robot_error_status": 8,
        "robot_overturn": false,
        "robot_tilt": false,
        "robot_upraise": false,
        "robot_wheel_stall": 0
      }
    },
    "type": "report_state_to_server_exception_respond"
  }
  ```
- **Key fields:**
  | Field | Type | Notes |
  |---|---|---|
  | `type` | string | `"report_state_to_server_exception_respond"` |
  | `message.value.robot_error_status` | int | Error code: 8 = LoRa disconnect |
  | `message.value.robot_error_msg` | string | Human-readable error |
  | `message.value.robot_button_stop` | bool | Physical stop pressed |
  | `message.value.robot_collision` | bool | Collision detected |
  | `message.value.robot_overturn` | bool | Mower overturned |
  | `message.value.robot_tilt` | bool | Tilt alarm |
  | `message.value.robot_upraise` | bool | Lifted |
  | `message.value.robot_wheel_stall` | int | 0 = no wheel stall |
- **Notes:** This exception is event-driven — only one was observed during the 30-minute idle window, triggered by a transient LoRa disconnect (error 8). The mower recovered on its own. Unlike `report_state_robot.error_status`, this server-only report provides the full exception context including boolean flags.

---

## Coverage gaps (need future targeted captures)

The following command categories were **not observed** in this idle capture. A future targeted session should exercise each to complete the catalog.

### High priority (mowing session)

- `start_run` / `stop_to_charge` — basic mowing start/stop
- `start_patrol` — single-zone mowing (if used by app)
- `pause_task` / `resume_task` — mid-mow pause/resume
- `go_to_charge` — manual dock command
- `set_cut_height` or `cutterhigh` field in start commands
- `report_work_start_respond` / `report_work_stop_respond` — mow session acks

### Mapping session

- `start_scan_map` / `stop_scan_map` / `stop_scan_map_respond`
- `add_scan_map` (unicom type:0, obstacle type:1)
- `save_map` (type:0 sub-map, type:1 total map)
- `save_recharge_pos` / `save_recharge_pos_respond`
- `get_map_list` / `map_list_respond`
- `delete_map`

### OTA update

- `ota_upgrade_cmd` — sent by server/app to trigger update
- `ota_upgrade_state` — progress reports from mower
- `ota_version_info` — null payload sent at connect

### Navigation / edge-cut

- `start_edge_cut` — edge-cut command (custom firmware only)
- `navigate_to_point` / `stop_navigate`
- Edge-cut progress / completion reports

### Error / recovery scenarios

- `error_status` non-zero reports during active mowing
- Obstacle detection events (`report_exception_state.chassis_err` non-zero)
- Manual emergency stop (`button_stop: true`)
- LoRa re-link recovery sequence

### Charger commands (app → charger)

- `set_lora_info` — LoRa configuration
- `restart` — charger reboot
- Any provisioning commands

### BLE provisioning (MQTT-side only)

- `set_wifi_info`, `set_lora_info`, `set_mqtt_info`, `set_cfg_info` responses
- These appear on MQTT only as `Dart/Receive_mqtt/<SN>` responses to BLE-initiated commands

---

## Capture methodology notes

- AES-128-CBC decryption applied to all messages (key = `abcdabcd1234` + SN[-4:], IV = `abcd1234abcd1234`, null-byte stripped). All payloads in this capture decrypted successfully — zero decrypt errors.
- The capture tool subscribes to `Dart/Send_mqtt/+`, `Dart/Receive_mqtt/+`, and `Dart/Receive_server_mqtt/+`. It does NOT capture raw TCP or broker-internal events.
- Two chargers are connected to the same broker: LFIC1230700004 (reserve, mower not docked) and LFIC1231000319 (active, mower docked). This accounts for the duplicate `up_status_info` and `get_lora_info` streams.
- The `report_state_robot`, `report_state_timer_data`, and `report_exception_state` triplet are always emitted together at 2.3 s intervals. They represent the mower's real-time telemetry heartbeat.
- The `report_state_to_server_work_respond` at 60 s is the server-only heartbeat used for dashboard updates and DB writes.
