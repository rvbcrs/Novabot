# mqtt_node — Gap analysis (RE-9)

**Sources:** RE-1 through RE-8 + docs/reference/MQTT.md +
docs/reference/MOWER-INTERNALS.md + docs/reference/BLE.md +
docs/reference/OTA.md
**Date:** 2026-04-27.

---

## 1. Executive summary

Stock binary feature surface (per Ghidra + capture + graph):
- ~50 MQTT commands inbound (app → mower, Section A of command catalog)
- ~11 report messages outbound (9 mower → app + 2 mower → server)
- ~23 ROS 2 service clients
- ~2 ROS 2 action clients
- ~23 ROS 2 topic subscriptions (including system topics like `/parameter_events`)
- ~10 ROS 2 topic publishers (including `/rosout`, `/parameter_events`)
- ~8 BLE provisioning commands (via BlueZ D-Bus: get_signal_info, get_wifi_rssi, set_wifi_info, set_mqtt_info, set_lora_info, set_rtk_info, set_para_info, set_cfg_info — source: `docs/reference/BLE.md`)
- 1 OTA flow (ota_upgrade_cmd + ota_upgrade_state + ota_version_info)
- ~5 HTTP periodic loops (net_check_fun ping, map upload, cut-grass record, equipment machine report, connectivity check — source: `mqtt_node-strings.md` API paths section)

Open implementation today: 0% (no code under `mower/mqtt_node/` yet).
Target after this plan: 100% drop-in.

**Tallying notes:**
- 50 Section A commands includes `start_navigation` listed separately from `start_run` (same handler) and `get_lora_info` (server→charger, not app→mower proper) — the 61-entry total from RE-5 header counts ALL catalog entries across sections A+B+C; inbound (app→mower) count is 50. The catalog explicitly states "61 entries" (RE-5 header), but 50 are inbound, 9 are mower→app, and 2 are mower→server.
- ROS2 subscriber count: 23 total per graph snapshot (line 4-26), of which 2 are system topics (`/parameter_events`, `/rosout` omitted from sub list). The 21 application-relevant subscribers are what Phase 2 must wire.
- ROS2 publisher count: 10 total per graph snapshot (lines 28-37), of which `/parameter_events` and `/rosout` are ROS2 system-managed — 8 application publishers needed.
- Graph snapshot source: `research/documents/mqtt_node-graph-snapshot.txt`.
- Command catalog source: `research/documents/mqtt_node-command-catalog.md` (RE-5, cross-referenced, 61 total entries, 30-min idle capture + Ghidra).

---

## 2. Side-by-side counts

| Category | Stock | Open today | Δ |
|---|---|---|---|
| MQTT inbound commands (app→mower) | 50 | 0 | -50 |
| MQTT outbound reports (mower→app) | 9 | 0 | -9 |
| MQTT outbound reports (mower→server) | 2 | 0 | -2 |
| ROS2 service clients | 23 | 0 | -23 |
| ROS2 action clients | 2 | 0 | -2 |
| ROS2 topic subscriptions | 23 | 0 | -23 |
| ROS2 topic publishers | 10 | 0 | -10 |
| BLE provisioning commands | 8 | 0 | -8 |
| OTA flow | 1 | 0 | -1 |
| HTTP periodic loops | 5 | 0 | -5 |

**Sources:** ROS2 counts from `research/documents/mqtt_node-graph-snapshot.txt` (live `ros2 node info /mqtt_node` output, 2026-04-27). MQTT counts from `research/documents/mqtt_node-command-catalog.md` (RE-5). BLE count from `docs/reference/BLE.md` (provisioning commands table). HTTP count from `research/documents/mqtt_node-strings.md` (API paths section).

---

## 3. MQTT command inventory

One row per catalog entry. "Phase 2 task" follows the plan numbering from the open mqtt_node plan doc. Commands where ROS2 endpoint is "stub / no ROS2" are simpler to implement (no async service call needed).

### 3A. App → Mower inbound commands (50 commands)

| Command | MQTT key | ROS2 endpoint | Endpoint type | Notes | Phase 2 task |
|---|---|---|---|---|---|
| `start_run` / `start_navigation` | `start_navigation` | `/robot_decision/start_cov_task` | `decision_msgs/srv/StartCoverageTask` | Primary mowing start; `area`, `cutterhigh`, `cmd_num` fields. Source: `mqtt_node-command-catalog.md:25-61` | P2.6 |
| `stop_run` / `stop_task` | `stop_task` | `/robot_decision/stop_task` | `std_srvs/srv/SetBool` | Source: `mqtt_node-command-catalog.md:64-79` | P2.6 |
| `pause_run` | `pause_run` | `/MidPauseTask` | `novabot_msgs/srv/Common` | Source: `mqtt_node-command-catalog.md:83-103` | P2.6 |
| `resume_run` | `resume_run` | `/ResumeTask` + `/MidResumeTask` | `novabot_msgs/srv/Common` | Two clients; try ResumeTask first. Source: `mqtt_node-command-catalog.md:105-118` | P2.6 |
| `go_to_charge` | `go_to_charge` | `/robot_decision/nav_to_recharge` | `decision_msgs/srv/Charging` | Navigate to dock. Source: `mqtt_node-command-catalog.md:122-143` | P2.7 |
| `go_pile` | `go_pile` | `<unknown>` | `<unknown>` | May share `go_to_charge` handler or be a distinct path. Source: `mqtt_node-command-catalog.md:147-158` | P2.7 |
| `stop_to_charge` | `stop_to_charge` | `/robot_decision/cancel_recharge` | `std_srvs/srv/Trigger` | Source: `mqtt_node-command-catalog.md:161-176` | P2.7 |
| `auto_recharge` | `auto_recharge` | `/robot_decision/auto_recharge` | `std_srvs/srv/Trigger` | Source: `mqtt_node-command-catalog.md:180-193` | P2.7 |
| `start_scan_map` | `start_scan_map` | `/robot_decision/start_mapping` | `decision_msgs/srv/StartMap` | Fields: `model`, `mapName`, `type` (0=work, 1=obstacle). Source: `mqtt_node-command-catalog.md:197-218` | P2.8 |
| `add_scan_map` | `add_scan_map` | `/robot_decision/add_area` | `decision_msgs/srv/StartMap` | type:0=unicom, type:1=obstacle (CONFIRMED). Source: `mqtt_node-command-catalog.md:221-244` | P2.8 |
| `stop_scan_map` | `stop_scan_map` | `/robot_decision/map_stop_record` | `std_srvs/srv/SetBool` | `value:false` for obstacle stop (CONFIRMED). Source: `mqtt_node-command-catalog.md:248-263` | P2.8 |
| `save_map` | `save_map` | `/robot_decision/save_map` | `decision_msgs/srv/SaveMap` | Sent twice: type:0 (sub-map/CSV) then type:1 (total/yaml). CRITICAL. Source: `mqtt_node-command-catalog.md:267-295` | P2.8 |
| `delete_map` | `delete_map` | `/robot_decision/delete_map` | `decision_msgs/srv/DeleteMap` | Fields: `mapName`, `maptype`. Source: `mqtt_node-command-catalog.md:299-324` | P2.8 |
| `get_map_list` | `get_map_list` | No ROS2 — reads CSV files directly | N/A | Reads `/userdata/lfi/maps/home0/csv_file/`. Sent by server at connect. Source: `mqtt_node-command-catalog.md:328-342` | P2.9 |
| `save_recharge_pos` | `save_recharge_pos` | `/robot_decision/save_charging_pose` | `mapping_msgs/srv/SetChargingPose` | Fields: `mapName`. 500ms later triggers `save_map type:1`. Source: `mqtt_node-command-catalog.md:344-359` | P2.8 |
| `get_recharge_pos` | `get_recharge_pos` | `/robot_decision/save_charging_pose` (control_mode=0) | `mapping_msgs/srv/SetChargingPose` | Read mode. Source: `mqtt_node-command-catalog.md:363-377` | P2.9 |
| `quit_mapping_mode` | `quit_mapping_mode` | `/robot_decision/quit_mapping_mode` | `std_srvs/srv/Empty` | Source: `mqtt_node-command-catalog.md:381-396` | P2.8 |
| `start_erase_map` | `start_erase_map` | `/robot_decision/start_erase` | `std_srvs/srv/SetBool` | Fields: `mapName`. Source: `mqtt_node-command-catalog.md:400-413` | P2.8 |
| `stop_erase_map` | `stop_erase_map` | `/robot_decision/start_erase` (SetBool data=false) | `std_srvs/srv/SetBool` | Same client as start_erase, opposite bool. Source: `mqtt_node-command-catalog.md:417-429` | P2.8 |
| `start_assistant_build_map` | `start_assistant_build_map` | `/robot_decision/start_assistant_mapping` | `std_srvs/srv/SetBool` | Fields: `value` bool. Source: `mqtt_node-command-catalog.md:433-446` | P2.8 |
| `generate_preview_cover_path` | `generate_preview_cover_path` | `/robot_decision/generate_preview_cover_path` | `decision_msgs/srv/GenerateCoveragePath` | Fields: `map_ids`, `cov_direction`, `specify_direction`. Source: `mqtt_node-command-catalog.md:450-472` | P2.9 |
| `get_preview_cover_path` | `get_preview_cover_path` | No ROS2 — reads `/userdata/.../preview_planned_path.json` | N/A | CRITICAL: buffer overflow in stock binary for large paths. Source: `mqtt_node-command-catalog.md:476-490` | P2.9 |
| `start_patrol` | `start_patrol` | No ROS2 — stub (JSON-echo only) | N/A | CONFIRMED STUB. Logs and replies `start_patrol_respond`, no action. Source: `mqtt_node-command-catalog.md:493-506` | P2.5 |
| `stop_patrol` | `stop_patrol` | No ROS2 — stub (JSON-echo only) | N/A | Same as start_patrol — stub only. Source: `mqtt_node-command-catalog.md:510-521` | P2.5 |
| `start_move` | `start_move` (integer value) | Topic publish `/cloud_move_cmd` | `novabot_msgs/msg/CloudMoveCmd` (publisher) | MUST be integer 1-4, NOT object. 1=left, 2=right, 3=fwd, 4=back. Source: `mqtt_node-command-catalog.md:523-547` | P2.5 |
| `stop_move` | `stop_move` | Topic publish `/cloud_move_cmd` (zero vel) | `novabot_msgs/msg/CloudMoveCmd` (publisher) | Source: `mqtt_node-command-catalog.md:549-561` | P2.5 |
| `mst` (velocity) | `mst` | Topic publish `/cloud_move_cmd` | `novabot_msgs/msg/CloudMoveCmd` (publisher) | Continuous joystick velocity: `{x_w, y_v, z_g}`. Not as api_ function in decompile. Source: CLAUDE.md + `mqtt_node-command-catalog.md:1219` | P2.5 |
| `ota_upgrade_cmd` | `ota_upgrade_cmd` | `/ota_upgrade_srv` | `platform_msgs/srv/OtaUpgradeSys` | CRITICAL: broker MUST strip `tz` field before forwarding. Schema not in cache (Task RE-10 needed). Source: `mqtt_node-command-catalog.md:563-578` | P2.12 |
| `ota_version_info` | `ota_version_info` | No ROS2 — reads `/userdata/lfi/system_version.txt` | N/A | Sent by server at connect (`onMowerConnected`). Source: `mqtt_node-command-catalog.md:582-596` | P2.12 |
| `get_para_info` | `get_para_info` | No ROS2 — reads globals/config | N/A | Returns obstacle_avoidance_sensitivity, target_height, etc. Source: `mqtt_node-command-catalog.md:599-610` | P2.9 |
| `set_para_info` | `set_para_info` | No ROS2 — writes globals/config | N/A | Sets obstacle_avoidance_sensitivity, target_height, etc. Source: `mqtt_node-command-catalog.md:613-624` | P2.9 |
| `get_cfg_info` | `get_cfg_info` | No ROS2 — reads `/userdata/lfi/json_config.json` | N/A | Source: `mqtt_node-command-catalog.md:627-638` | P2.9 |
| `set_cfg_info` | `set_cfg_info` | No ROS2 — writes json_config.json + timezone file | N/A | `tz` field in BLE provisioning path is SAFE (unlike OTA path). Source: `mqtt_node-command-catalog.md:641-654` | P2.13 |
| `set_lora_info` | `set_lora_info` | Action client `/chassis_lora_set` (async pthread) | `novabot_msgs/action/ChassisLoraSet` | Fields: `addr`, `channel`. Runs async. Source: `mqtt_node-command-catalog.md:657-676` | P2.13 |
| `dev_pin_info` | `dev_pin_info` | Action client `/chassis_pin_code_set` | `novabot_msgs/action/ChassisPinCodeSet` | Fields: `type`, `code`. Source: `mqtt_node-command-catalog.md:680-699` | P2.13 |
| `set_control_mode` | `set_control_mode` | No ROS2 — sets g_sound / g_headlight globals | N/A | Source: `mqtt_node-command-catalog.md:703-714` | P2.9 |
| `get_version_info` | `get_version_info` | No ROS2 — reads version files | N/A | Source: `mqtt_node-command-catalog.md:717-728` | P2.9 |
| `get_dev_info` | `get_dev_info` | No ROS2 — reads internal state | N/A | Source: `mqtt_node-command-catalog.md:731-742` | P2.9 |
| `get_map_plan_path` | `get_map_plan_path` | No ROS2 — reads `/userdata/.../planned_path.json` | N/A | Source: `mqtt_node-command-catalog.md:745-756` | P2.9 |
| `get_map_outline` | `get_map_outline` | No ROS2 — reads CSV files | N/A | Source: `mqtt_node-command-catalog.md:759-770` | P2.9 |
| `start_time_navigation` | `start_time_navigation` | `<unknown — needs Ghidra deep-dive>` | Likely `/robot_decision/start_cov_task` with timer request_type | Scheduled mowing. Source: `mqtt_node-command-catalog.md:773-784` | P2.11 |
| `stop_time_navigation` | `stop_time_navigation` | `<unknown — needs Ghidra deep-dive>` | `<unknown>` | Source: `mqtt_node-command-catalog.md:788-799` | P2.11 |
| `start_navigation` (alias) | `start_navigation` | `/robot_decision/start_cov_task` | `decision_msgs/srv/StartCoverageTask` | Same handler as `start_run`. Also handles `stop_navigation` → `/robot_decision/stop_task`. Source: `mqtt_node-command-catalog.md:802-813` | P2.6 |
| `set_wifi_info` | `set_wifi_info` | No ROS2 — writes json_config.json | N/A | BLE provisioning path only. Fields: `sta.ssid`, `sta.passwd`, `ap.ssid`, `ap.passwd`. Source: `mqtt_node-command-catalog.md:815-826` | P2.13 |
| `set_mqtt_info` | `set_mqtt_info` | No ROS2 — writes json_config.json | N/A | BLE provisioning path only. Fields: `host`, `port`. Source: `mqtt_node-command-catalog.md:830-841` | P2.13 |
| `get_wifi_rssi` | `get_wifi_rssi` | No ROS2 — reads system WiFi interface | N/A | Source: `mqtt_node-command-catalog.md:844-855` | P2.9 |
| `get_current_pose` | `get_current_pose` | No ROS2 — reads cached map_position sub data | N/A | Source: `mqtt_node-command-catalog.md:858-869` | P2.10 |
| `get_vel_odom` | `get_vel_odom` | No ROS2 — reads cached odometry data | N/A | Source: `mqtt_node-command-catalog.md:872-883` | P2.10 |
| `get_log_info` | `get_log_info` | No ROS2 — reads log files | N/A | Source: `mqtt_node-command-catalog.md:886-896` | P2.9 |
| `reset_map` | `reset_map` | `/robot_decision/reset_mapping` | `decision_msgs/srv/StartMap` | Fields: `mapName`. Source: `mqtt_node-command-catalog.md:900-914` | P2.8 |
| `get_lora_info` | `get_lora_info` | N/A (charger ESP32 command — server→charger) | N/A | NOT a mower command. Server polls chargers at 60s interval. Source: `mqtt_node-command-catalog.md:918-929` | P2.11 |

**Deferred / not-yet-captured commands (from Section D):**

| Command | Direction | Decompile/string evidence | Notes | Phase 2 task |
|---|---|---|---|---|
| `mst` (continuous velocity) | app → mower | CLAUDE.md (proven working) | `{x_w, y_v, z_g}` velocity; 200ms repeating. NOT a separate api_ function. | P2.5 |
| `get_map_info` | app → mower | `mqtt_node_decompiled.c:322091` | Map metadata read. `api_get_map_info` confirmed. | P2.9 |
| `start_edge_cut` | app → mower | Custom firmware only | `{mapName, bladeHeight}` in mm. NTCP action. Source: CLAUDE.md edge-cut section. | Custom only |
| `timer_task` | server → mower | `mqtt_node_decompiled.c:310185` | Scheduled task trigger; payload unknown. | P2.11 |
| `auto_connect` | app → mower | `docs/reference/MQTT.md:148` | No decompile function found; payload unknown. | P2.9 |
| `report_state_all_by_ble` | mower → app | `mqtt_node_decompiled.c:306222` | BLE state report; only emitted during BLE session. | P2.13 |

### 3B. Mower → App outbound reports (9 commands)

| Report | MQTT key | Period | ROS2 source | Phase 2 task |
|---|---|---|---|---|
| `report_state_robot` | `report_state_robot` | ~2.3 s | `/robot_decision/robot_status` sub (RobotStatus) + `/robot_decision/map_position` sub (Pose) | P2.10 |
| `report_state_timer_data` | `report_state_timer_data` | ~2.3 s (sync with above) | `/robot_decision/covered_path_json`, `/robot_decision/planned_json`, `/gps_raw`, internal | P2.10 |
| `report_exception_state` | `report_exception_state` | ~2.3 s (sync with above) | `/chassis_incident` sub (ChassisIncident) + BestPos + WiFi RSSI | P2.10 |
| `report_state_map_outline` | `report_state_map_outline` | event-driven (map change) | CSV file read + MQTT publish | P2.9 |
| `report_state_map_path_list` | `report_state_map_path_list` | event-driven | Decompile only; format unknown | P2.9 |
| `report_state_unbind` | `report_state_unbind` | event-driven (on unbind) | Decompile only | P2.9 |
| `up_status_info` | `up_status_info` | ~2.0 s | Charger → app (NOT mower-generated; charger ESP32 emits this) | Charger-side only |
| `get_map_list_respond` | `get_map_list_respond` | Response to `get_map_list` | CSV directory read | P2.9 |
| `ota_upgrade_state` | `ota_upgrade_state` | event-driven during OTA | `/ota/upgrade_status` sub (std_msgs/String); 0-62%=download, 62-68%=unpack, 68-100%=install | P2.12 |

### 3C. Mower → Server reports (2 commands)

| Report | MQTT key | Period | Notes | Phase 2 task |
|---|---|---|---|---|
| `report_state_to_server_work_respond` | `report_state_to_server_work_respond` | ~60 s | System telemetry heartbeat: sv, hv, ov, battery, GPS, disk, memory, wifi_rssi, working_time. Source: `mqtt_node-payload-catalog.md:326-392` (LIVE CAPTURE) | P2.10 |
| `report_state_to_server_exception_respond` | `report_state_to_server_exception_respond` | event-driven | Exception events: robot_error_status, robot_collision, robot_overturn, etc. Source: `mqtt_node-payload-catalog.md:396-433` (LIVE CAPTURE) | P2.10 |

---

## 4. Risk-prioritised backlog

### BLOCKERS — required for first activation (nothing works without these)

1. **AES library** (`mower/mqtt_node/aes.py`) — without it nothing decrypts/encrypts. RE-8 confirms Python impl is ready. — Phase 2 Task 2.1
2. **MQTT client** — without it no messages flow; MQTT broker connection, subscribe `Dart/Send_mqtt/<SN>`, publish on `Dart/Receive_mqtt/<SN>` and `Dart/Receive_server_mqtt/<SN>`. — Phase 2 Task 2.3
3. **Command dispatcher core** — JSON parse, command key routing, cmd_num dedup guard. — Phase 2 Task 2.4
4. **ROS2 bridge minimum** — at least `start_cov_task` + `auto_recharge` + `stop_task` so the mower can start, stop, and dock. — Phase 2 Tasks 2.5–2.7
5. **Sensor aggregator minimum** (`report_state_robot` + `report_state_timer_data` + `report_exception_state`) — app shows blank/error screen without these. — Phase 2 Task 2.10
6. **Server-side heartbeat** (`report_state_to_server_work_respond` at 60s) — required for dashboard to show any mower state. — Phase 2 Task 2.10

### HIGH — deferred activation but block "drop-in" claim

7. **BLE handler** (`start_gatt_server`) — `set_wifi_info`, `set_mqtt_info`, `set_lora_info`, `set_cfg_info` over GATT. BleFramer pure-Python validated against bootstrap framing. Source: RE-6 (`mqtt_node-ble-trace.md`), `docs/reference/BLE.md`, `bootstrap/src/ble.ts`. — Phase 2 Task 2.13 + Phase 4 Task 4.1
8. **OTA client** — `ota_upgrade_cmd` parse + HTTP download + MD5 verify + `ota_upgrade_state` progress reports. CRITICAL: `tz` field must be rejected (broker already strips it server-side, but open implementation must also not write it). Source: RE-7 (`mqtt_node-ota-flow.md`), `docs/reference/OTA.md`. Missing schema: `platform_msgs/srv/OtaUpgradeSys` (Task RE-10). — Phase 2 Task 2.12
9. **HTTP client loops** — `net_check_fun` ping to `/api/nova-network/network/connection` (stock binary polls >3 failures → WiFi reconnect), map upload to `/api/nova-file-server/map/upload`, cut-grass record to `/api/nova-data/cut`. Without net_check_fun the stock cloud thinks mower is offline. — Phase 2 Task 2.11

### MEDIUM — full feature parity

10. **Action client wiring** — `start_move` + `mst` (joystick, `/cloud_move_cmd` publisher), `set_lora_info` (async `/chassis_lora_set`), `dev_pin_info` (/chassis_pin_code_set). — Phase 2 Tasks 2.5, 2.13
11. **Sensor aggregator full coverage** — all `get_*` commands that read cached state: `get_current_pose`, `get_vel_odom`, `get_para_info`, `get_cfg_info`, `get_version_info`, `get_dev_info`. — Phase 2 Task 2.10
12. **Mapping command set** — `start_scan_map`, `add_scan_map`, `stop_scan_map`, `save_map` (both type:0 and type:1), `save_recharge_pos`, `delete_map`, `reset_map`, `quit_mapping_mode`, `start/stop_erase_map`, `start_assistant_build_map`, `generate_preview_cover_path`, `get_preview_cover_path` (fix the buffer overflow from stock), `get_map_list`, `get_map_outline`, `get_map_plan_path`. — Phase 2 Task 2.8 + 2.9
13. **Per-SN AES bypass flag** — v5.x firmware does NOT use AES (source: memory `firmware-aes-versions.md`); the dispatcher must skip encrypt/decrypt for non-LFI* SNs. — Phase 2 Task 2.1
14. **Scheduled mowing** (`start_time_navigation`, `stop_time_navigation`) — ROS2 endpoint unknown; needs targeted Ghidra deep-dive or live capture. — Phase 2 Task 2.11

### LOW — polish and compliance

15. Logging compatible with stock log format (`puts("api_<cmd>\r")` pattern confirmed in decompile).
16. Performance tuning — CPU/memory footprint to match stock 6.3 MB binary.
17. `mst` continuous velocity publish timing — stock binary reads cmd_vel from `CloudMoveCmd`, open impl needs ~200 ms repeat loop identical to app behaviour.
18. `PlanCheckTask` service server (`/PlanCheckTask: get_plan_interfaces/srv/PlanData`) — schema not in cache; needs RE-10 style capture. Source: `mqtt_node-graph-snapshot.txt:39`.
19. `/reset_utm_origin_info` and `/local_costmap/clear_around_local_costmap` internal trigger conditions — unknown; needs Ghidra deep-dive. Source: `mqtt_node-graph-snapshot.txt:52, 50`.

---

## 5. Open questions

1. **BLE D-Bus (`dbus-next`) vs shelling `bluetoothctl`** — decide during Phase 2 BLE handler implementation (Task 2.13). The stock binary embeds full BlueZ D-Bus stack (`org.bluez.*` strings in `mqtt_node-strings.md`); Python `dbus-next` is the closer match but adds a dependency. `bluetoothctl` shell is simpler but brittle.

2. **Multi-mower addressing** — decompile suggests single-tenant per process (SN suffix read once at startup from config). Phase 2 must confirm whether one process instance per mower SN is the correct deployment model.

3. **`start_run` vs `start_navigation` MQTT key naming** — binary handler is `api_start_navigation` processing JSON key `"start_navigation"` (decompile line 347625). `docs/reference/MQTT.md` uses `start_run`. Both aliases must be accepted by Phase 2 dispatcher. Source: `mqtt_node-command-catalog.md:25-39`.

4. **`go_pile` ROS2 endpoint** — confirmed present in strings and docs but no `api_go_pile` decompile function found; may share `nav_to_recharge` handler or call a distinct service. Needs targeted Ghidra search before P2.7 implementation.

5. **`timer_task` outbound payload format** — decompile line 310185 confirms the feature exists but exact JSON payload is unknown. Scheduled task feature requires this to emit correct trigger. Source: `mqtt_node-command-catalog.md:1235`.

6. **`platform_msgs/srv/OtaUpgradeSys` schema** — missing from the ROS2 message cache. Required for Phase 2 Task 2.12 OTA service call. Capture via Task RE-10 (planned). Source: `mqtt_node-command-catalog.md:1255-1259`.

7. **`get_map_info` vs `get_map_outline` vs `get_map_list`** — three overlapping map-read commands; exact response shapes differ and only `get_map_list_respond` has a response shape in the decompile. Phase 2 Task 2.9 must resolve via targeted Ghidra analysis.

---

## 6. Notes from RE-1 through RE-8

### RE-1 (binary analysis — decompile setup)
- Binary: `research/firmware/mower_v6.0.0_backup/mqtt_node`, ~6.3 MB ARM64, NOT stripped.
- Ghidra output: `research/ghidra_output/mqtt_node_decompiled.c` (752,374 lines, 11,659 functions).
- Not stripped means exception symbols, C++ mangled names, and function names all present — unusually good for RE.

### RE-2 (strings analysis)
- 30,101 strings extracted. Key MQTT command names confirmed via `strings -a`. Source: `mqtt_node-strings.md`.
- AES constants confirmed: IV = `abcd1234abcd1234`, key prefix = `abcdabcd1234` + SN[-4:].
- Full HCI/BLE command set present — the binary manages Bluetooth itself (not a separate daemon), using BlueZ D-Bus.
- 6 HTTP API endpoints confirmed in strings: `/api/nova-data/cut`, `/api/nova-data/equipment`, `/api/nova-file-server/map/upload`, `/api/nova-message/machine`, `/api/nova-network/network/connection`, `/api/nova-user/equipment/machine`.

### RE-3 (ROS2 graph snapshot)
- Live `ros2 node info /mqtt_node` on mower LFIN1231000211. Source: `mqtt_node-graph-snapshot.txt`.
- 23 service clients, 2 action clients, 23 topic subscribers, 10 topic publishers confirmed live.
- Notable: 0 action servers — the binary is a pure client on the ROS2 action side.
- `/PlanCheckTask` is the only non-system service SERVER exposed by mqtt_node.

### RE-4 (payload capture — idle only)
- 30-minute capture on charger + mower (idle, mower docked). Source: `mqtt_node-payload-catalog.md`.
- 4285 messages, 11 distinct (topic, command) pairs.
- 3 reports confirmed live with exact payloads: `report_state_robot`, `report_state_timer_data`, `report_exception_state` (all ~2.3s), `report_state_to_server_work_respond` (60s), `report_state_to_server_exception_respond` (1 event), `up_status_info` (charger, 2s), `get_lora_info` / `get_lora_info_respond` (server→charger, 60s).
- **No app→mower commands observed** (idle-only scope). All Section A commands rely on Ghidra for payload shapes.

### RE-5 (command catalog)
- 61-entry cross-referenced catalog. Source: `mqtt_node-command-catalog.md`.
- Every inbound command cites: MQTT JSON shape, ROS2 endpoint, Ghidra decompile line, capture status.
- **Critical stub confirmation**: `start_patrol` and `stop_patrol` are JSON-echo stubs — no ROS2 call. Binary logs and replies, nothing else. Source: decompile lines 321148-321204.
- **save_map type:0/type:1 dual-send confirmed** from CLAUDE.md and decompile line 339763. Type:0 writes CSV; type:1 generates `map.pgm/png/yaml`. Missing type:1 → Error 107 at start_navigation.

### RE-6 (BLE trace — deferred)
- Live `btmon` capture deferred. Implementation leans on `docs/reference/BLE.md`, `bootstrap/src/ble.ts`, and memory `ble-provisioning-protocol.md`. Source: `mqtt_node-ble-trace.md`.
- BleFramer pure-Python parser validated against `le_start`/`le_end` framing used by bootstrap client.
- Refresh path documented for future hardware capture if behaviour diverges.

### RE-7 (OTA flow — deferred)
- Live OTA capture deferred. Implementation leans on `docs/reference/OTA.md`, `CLAUDE.md` OTA section, and Ghidra lines 350945-350998. Source: `mqtt_node-ota-flow.md`.
- Ghidra confirms: `tz` field causes firmware to write `/userdata/ota/novabot_timezone.txt` then change type to `"increment"`. This is why `broker.ts authorizePublish` strips `tz` from app→mower OTA payloads — must never be removed.

### RE-8 (AES validation)
- **Zero decrypt failures across all 4285 captured messages.** Source: `mqtt_node-aes-validation.md`.
- AES-128-CBC, key = `abcdabcd1234` + SN[-4:], IV = `abcd1234abcd1234`, null-byte padding — fully validated.
- Python AES implementation ready for Phase 2 Task 2.1 (`aes.py`).
- v5.x firmware does NOT use AES (source: memory `firmware-aes-versions.md`). The dispatcher must skip for non-LFI* SNs.

---

## 7. Schema gaps (missing for Phase 2)

| Missing schema | Where needed | Resolution path |
|---|---|---|
| `platform_msgs/srv/OtaUpgradeSys` | `ota_upgrade_cmd` → `/ota_upgrade_srv` | Task RE-10 schema capture |
| `get_plan_interfaces/srv/PlanData` | `/PlanCheckTask` service server | Task RE-10 or Ghidra deep-dive |
| `decision_msgs/msg/CovTaskResult` | `/robot_decision/cov_task_result` subscriber | Check `research/ros2_msg_definitions/` — may already be present |
| `sensor_msgs/msg/NavSatFix` | `/gps_raw` subscriber (gps_position in report_state_timer_data) | Standard ROS2 type — no custom schema needed |
| `novabot_msgs/msg/BestPos` | `/bestpos_parsed_data` subscriber (RTK fix status) | Check schema cache |

---

## 8. Implementation order recommendation

Based on the risk prioritisation above, the suggested Phase 2 build sequence is:

```
P2.1  aes.py          — AES encrypt/decrypt (RE-8 validated, zero-risk)
P2.3  mqtt_client.py  — MQTT connect/subscribe/publish + AES integration
P2.4  dispatcher.py   — JSON parse + command routing + cmd_num dedup
P2.10 sensor_agg.py   — report_state_robot + report_state_timer_data +
                         report_exception_state + server heartbeat (RE-4 live payloads)
P2.6  mow_commands.py — start_navigation, stop_task, pause_run, resume_run
P2.7  charge_cmds.py  — go_to_charge, stop_to_charge, auto_recharge
P2.8  map_commands.py — full mapping set (start/add/stop_scan_map, save_map, etc.)
P2.9  info_commands.py — all get_* / set_* / config reads (no ROS2 calls)
P2.5  move_commands.py — start_move, mst, stop_move (/cloud_move_cmd publisher)
P2.11 http_loops.py   — net_check_fun ping, timer_task
P2.12 ota_client.py   — ota_upgrade_cmd + ota_upgrade_state progress
P2.13 ble_handler.py  — GATT server + BLE provisioning commands
```

A reader of this gap analysis can plan Phase 2 implementation order without reopening any other file.

---

## 9. Status as of 2026-04-27

After Phase 0–4 of `docs/superpowers/plans/2026-04-26-open-mqtt-node.md`:

- AES, MQTT client, command dispatcher, ROS2 bridge skeleton + ~16 command handlers, sensor aggregator, HTTP loops, OTA client, BLE frame parser → all implemented + unit-tested on Mac dev (34 tests pass)
- BLE GATT D-Bus server stub (real wiring requires bluez on the mower + RE-6 UUID trace)
- Activation/rollback scripts ready (`deploy.sh`, `start.sh`, `rollback.sh`)
- Runtime parity harness ready (manual; `parity_capture.sh` + `parity_smoke.sh` + acceptance checklist)
- Payload parity test framework + 3 fixtures (idle capture: report_state_robot, report_state_timer_data, report_exception_state)

### Coverage estimate vs stock binary

| Surface | Wired | Stock | % |
|---|---|---|---|
| MQTT inbound commands | 16 | ~50 | 32% |
| MQTT outbound reports | 3 | ~10 | 30% |
| ROS2 service clients | 16 | ~30 | 53% |
| ROS2 action clients | 6 | 6 | 100% |
| BLE handler | framer done | framer + GATT | partial |
| OTA | download + verify + stage | + atomic install | partial |
| HTTP | net_check + http_work | same | 100% |

### Gaps surfaced by parity tests

The Phase 3 parity test framework caught these divergences from stock and forced corrections in `sensor_aggregator.py`:

- `battery_state` was emitted in `build_report_state_robot` — should be in `build_report_state_timer_data` only
- `wifi_rssi`, `rtk_sat` were emitted in `build_report_state_robot` — should be in `build_report_exception_state` only
- Builder name was `build_report_state_exception` (our invention) — renamed to `build_report_exception_state` to match stock topic
- Exception fields used `robot_*` prefix (our invention) — renamed to stock-exact `button_stop`, `chassis_err`, `no_set_pin_code`, `rtk`, `rtk_sat`, `wifi_rssi`

### Remaining gaps not yet surfaced (no fixture pressure yet)

- `report_state_robot` extras we don't emit: `avoiding_obstacle_time`, `cov_estimate_time`, `cov_map_path`, `cov_remaining_area`, `current_map_ids`, `finished_num`, `light`, `map_num`, `perception_level`, `prev_recharge_status`, `prev_task_mode`, `prev_work_status`, `request_map_ids`, `valid_cov_work_time`
- `report_state_timer_data` extras we don't emit: `cover_path` subtree, `if_mower_can_finish`
- `start_edit_or_assistant_map_flag` and `if_scan_unicom_obstacle` hardcoded to `16` in our builder — should track real ROS state, not constants
- BLE provisioning commands not parsed in framer dispatcher (set_wifi_info, set_lora_info, set_mqtt_info, set_cfg_info)
- Domain whitelist removal verified in `mqtt_client.py` — set_mqtt_info `addr` field bypasses any host check (intentional, this is *the* unique feature of the open replacement)

### Resolution path

Remaining work tracked in a follow-up plan once hardware acceptance signs off. The merge gate is the acceptance checklist at `mower/mqtt_node/tests/runtime/acceptance_checklist.md` — runtime parity smoke + user sign-off.
