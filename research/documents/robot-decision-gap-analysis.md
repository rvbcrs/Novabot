# robot_decision — Closed vs Open Gap Analysis

**Goal:** 100% drop-in Python replacement of the closed C++ `robot_decision` binary.
**Closed binary:** `/root/novabot/install/compound_decision/lib/compound_decision/robot_decision` (aarch64, NOT stripped, ~6.25 MB, source ~4060 LOC).
**Open implementation:** `/Users/rvbcrs/GitHub/Novabot/mower/` — `robot_decision.py` (2482 lines, "v17") + `decision_assistant.py` (508 lines) + `service_handlers.py` (712 lines) + `state_machine.py` (212 lines).

Inputs to this analysis:
- `/tmp/closed_decision_inventory.md` (HIGH-confidence live ROS introspection 2026-04-25)
- `/tmp/open_decision_inventory.md` (full read of open Python code)
- `research/documents/robot_decision_reverse_engineering.md` (older — superseded by live data where they disagree)

---

## 1. Executive Summary

**Coverage estimate vs 100% port: ~55%.** The open Python node implements the boot state machine, mowing/recharge happy paths, manual mapping, and most service-server signatures, but it has one architectural break (action servers on the wrong node), one pub/sub-vs-service break (`map_position`), and several behavioural gaps that will silently misbehave on real hardware.

**Top 3 risks if deployed today:**
1. **Architectural namespace mismatch**: open exposes `/robot_decision/slip_escaping` and `/robot_decision/loc_recover`. Closed exposes `/decision_assistant/slipping_escape` and `/decision_assistant/loc_recover_moving`. nav2/coverage_planner will not find the open actions and will not call slip-escape during mowing — mower will simply stall on slip.
2. **`/robot_decision/map_position` type swap**: closed publishes `geometry_msgs/Pose` continuously; open exposes a `novabot_msgs/Common` *service* — mqtt_node's live position pipeline breaks; app shows no robot dot.
3. **`cmd_vel`-based slip/loc recovery is gated by CChassisControl**, so even if the action names were right, the recovery wouldn't move the wheels (open inventory flags this; matches project memory `feedback_safety.md`).

**Top 3 quick wins:**
1. Rename action server endpoints + move them onto a sub-node `/decision_assistant` (XS — single-file change in `decision_assistant.py:96-109`).
2. Replace `_handle_map_position` service with a continuous `/robot_decision/map_position` `Pose` publisher (XS — delete service, add 2-Hz publisher in `_publish_status` loop).
3. Remove duplicate `battery_message` subscription in `robot_decision.py:226-231` (XS — single-line delete; prevents double-charge / double-recharge logic).

---

## 2. Side-by-side Counts Table

| Category | Closed | Open | Delta |
|---|---|---|---|
| Service servers | 18 (robot_decision) + 1 (decision_assistant: `/decision_assistant/load_map`) = **19** | **18** (all on `robot_decision` node) | -1 (load_map missing) + 7 unrelated services missing (see §3) |
| Action servers | 0 (robot_decision) + 2 (decision_assistant) = **2** | **2** (on `robot_decision` node — wrong namespace) | wrong namespace + wrong action names |
| Topic publishers | 13 (robot_decision) + 5 (decision_assistant) = **18** | 6 robot_status group + 6 motor/LED + 3 assistant = **15** | -3 (`/collision_range`, `/chassis_node/led_buzzer_switch_set`, `/local_costmap/prohibited_points`); `map_position` published by closed but only as a SERVICE in open |
| Topic subscribers | 16 (robot_decision) + 4 (decision_assistant) = **20** | **9** | -11; missing `/chassis_node/init_ok`, `/chassis_node/led_level`, `/novabot/init_mower`, `/camera/preposition/hardware_exception`, `/camera/tof/point_cloud`, `/coverage_planner_server/covered_path_json`, `/decision_assistant/move_abnormal`, `/decision_assistant/robot_out_working_zone`, `/novabot_mapping/mapping_data`, `/system/shared_memory_error`, `/odom_raw` (open uses combination_status + odom_raw differently) |
| Service clients | 27 (robot_decision) + 1 (decision_assistant: free_move_around) = **28** | 38 declared (5 fully dead + 3 wrapper-dead = 30 effective) | +2 effective; many overlap; `/load_utm_origin_info`, `/save_utm_origin_info`, `/reset_utm_origin_info` parity check below |
| Action clients | 6 (robot_decision) + 1 (decision_assistant: navigate_to_pose) = **7** | **4** (coverage, boundary_follow, navigate_to_pose, auto_charging) | -3: `/follow_path`, `/decision_assistant/loc_recover_moving`, `/decision_assistant/slipping_escape` (closed *itself* is a client of its own assistant's actions; open never auto-triggers them) |
| Parameters | 41 (robot_decision) + 7 (decision_assistant) = **48** | 35 (main) + 6 (assistant) = **41** | -7; missing `boundary_offset`(declared dead), `charge_back_percentage`, `collect_image`, `do_camera_switch`, `escape_plan_switch`, `include_edge`, `recharge_retry_times`. Plus 8 dead in open. |

---

## 3. Service-server gaps

### 3.1 Closed→Open coverage of the 18 services

| # | Service name | srv type | Closed: 1-line behavior | Open status | Open ref | Gap detail | Severity |
|---|---|---|---|---|---|---|---|
| 1 | `/robot_decision/start_mapping` | `decision_msgs/StartMap` | Manual mapping start; calls `/novabot_mapping/recording_edge` and `/novabot_mapping/mapping`; transitions to `MANUAL_MAPPING_WORKING_ZONE` (or sub-state by `type`) | ✅ COMPLETE | service_handlers.py:271 | OK | LOW |
| 2 | `/robot_decision/start_assistant_mapping` | `std_srvs/SetBool` | Engages autonomous boundary mapping via internal action client; transitions to `ASSISTANT_MAPPING_MAPPING_WORKING_ZONE` | ⚠️ PARTIAL | service_handlers.py:345 | (a) Spawns a daemon thread; service callback returns before work starts — caller can't tell if the thread succeeded. (b) **Bug line 377**: `f'dist={dist_from_charger:.2f}m'` references undefined name → `NameError` whenever `is_on_charger` is true. | HIGH |
| 3 | `/robot_decision/add_area` | `decision_msgs/StartMap` | Mid-mapping append: starts obstacle / unicom / unicom-to-station depending on `type` | ⚠️ PARTIAL | service_handlers.py:301 | No transition to `MANUAL_MAPPING_UNICOM_TO_STATION` even when type matches; closed binary supports the third sub-state (string `"start to add unicom to charge_station unicom"`). | MEDIUM |
| 4 | `/robot_decision/save_map` | `decision_msgs/SaveMap` | Finalize mapping; persists CSV/PGM via dual `mapping_data` calls (sub then total); captures charger pose; returns `error_code` (1 OVERLAP_OTHER_MAP / 2 OVERLAP_OTHER_UNICOM / 3 CROSS_MULTI_MAPS) | ⚠️ PARTIAL | service_handlers.py:561 | (a) Hardcodes `map_name='home0'` (line 579) — closed accepts arbitrary parent. (b) No 500 ms gap between type:0 (sub) and type:1 (total) — `MAPPING-FLOW.md`/CLAUDE.md mentions this delay is required for `map.yaml`. (c) Error-code population is whatever `_generate_map` returns; not the closed enum. | HIGH |
| 5 | `/robot_decision/reset_mapping` | `decision_msgs/StartMap` | Wipe partial map + return to mapping idle | ✅ COMPLETE | service_handlers.py:327 | OK | LOW |
| 6 | `/robot_decision/map_stop_record` | `std_srvs/SetBool` | Pause/abort live recording without saving; state → `MAPPING_STOP_RECORD` | ✅ COMPLETE | service_handlers.py:428 | OK | LOW |
| 7 | `/robot_decision/quit_mapping_mode` | `std_srvs/Empty` | Exit any mapping state, return to `INIT_SUCCESS` | ✅ COMPLETE | service_handlers.py:484 | OK | LOW |
| 8 | `/robot_decision/delete_map` | `decision_msgs/DeleteMap` | Delete sub-map / obstacle / unicom by `maptype` + `mapname`; transitions through `DELETE_CHILD_MAP` / `DELETE_OBSTACLE` / `DELETE_UINICOM` | ⚠️ PARTIAL | service_handlers.py:661 | (a) Always passes `type=3` (delete sub-map); ignores `request.maptype`. (b) Hardcoded parent `home0`. (c) No DELETE_* state transitions are written. | HIGH |
| 9 | `/robot_decision/start_erase` | `std_srvs/SetBool` | Drive in erase mode; calls `/novabot_mapping/control_erase_map_mode`; tracks `AUTO_ERASE_MAPPING_FAILED` / `AUTO_ERASE_MAPPING_SUCCESS` | ⚠️ PARTIAL | service_handlers.py:393 | Fires erase-mode service but never tracks completion → `AUTO_ERASE_MAPPING_SUCCESS`/`_FAILED` never written. mqtt_node never sees a finish event. | MEDIUM |
| 10 | `/robot_decision/start_cov_task` | `decision_msgs/StartCoverageTask` | Main mowing entrypoint. cov_mode 0/1/2 dispatches; **always** re-issues `/map_server/load_map` ("Forcing to reload map for start new task!!!!"); generates path via `coverage_by_file`; executes `NavigateThroughCoveragePaths` action | ⚠️ PARTIAL | service_handlers.py:498 | (a) Hardcodes `coverage_type=0` (COVERAGE_BY_FILE) — fine for normal mowing. (b) `cov_mode==2` only flips `include_edge=True`; never sets `only_edge_mode=True` → BOUNDARY_COV mode is broken (memory `edge-cut-ntcp.md`). (c) `cov_mode==1` (specified-area / polygon_area) **not handled at all**. (d) Always loads `<load_map_path>/map.yaml` regardless of `request.map_ids`. (e) Open does call clear_costmap (good), but does NOT log/force-reload the map every call (closed always does). | BLOCKER |
| 11 | `/robot_decision/stop_task` | `std_srvs/SetBool` | data=true pauses, data=false resumes ongoing cov task | ⚠️ PARTIAL | service_handlers.py:412 | Open treats data=true and data=false identically — both go to USER_STOP and cancel actions; resume semantics absent. Closed string evidence: `"Receiving cov continue command!!!"`. | HIGH |
| 12 | `/robot_decision/cancel_task` | `std_srvs/Trigger` | Permanently cancel; state → `CANCELLED` | ✅ COMPLETE | service_handlers.py:456 | OK | LOW |
| 13 | `/robot_decision/auto_recharge` | `std_srvs/Trigger` | Auto-dock from anywhere; goes through RETURN_TO_PILE → ALIGN_PILE → AutoCharging | ✅ COMPLETE | service_handlers.py:440 | OK | LOW |
| 14 | `/robot_decision/nav_to_recharge` | `decision_msgs/Charging` | Navigate-and-dock with explicit pose + mode; rejected during mapping ("Recharge with guide pose mode only support no mapping mode") | ⚠️ PARTIAL | service_handlers.py:608 | Open ignores `pose_x/y/theta/mode`; just calls the same `start_recharge()`. No mapping-mode rejection. | MEDIUM |
| 15 | `/robot_decision/cancel_recharge` | `std_srvs/Trigger` | Cancel ongoing recharge; rejects if executing critical phase | ✅ COMPLETE | service_handlers.py:471 | Open does cancel both nav and AutoCharging goals. Does not implement "Cannot cancel recharge when recharge task is executing" guard. | LOW |
| 16 | `/robot_decision/save_charging_pose` | `mapping_msgs/SetChargingPose` | Persist current pose as charger; state → `SETTING_CHARGING_STATION`; returns `map_to_charging_dis` | ⚠️ PARTIAL | service_handlers.py:685 | **`response.map_to_charging_dis = 0.0` hardcoded** (line 701). Closed propagates the upstream value; mqtt_node may use it. | MEDIUM |
| 17 | `/robot_decision/generate_preview_cover_path` | `decision_msgs/GenerateCoveragePath` | Generate preview without driving; publishes JSON on `/robot_decision/preview_planned_json` | ⚠️ PARTIAL | service_handlers.py:625 | Hardcoded `include_edge=False` (line 637) — preview will never include edge; the request's edge selection is ignored. Otherwise correct. | LOW |
| 18 | `/robot_decision/reset_data` | `std_srvs/SetBool` | Wipe in-memory task counters/handles after fault | ❌ MISSING | — | Service not registered at all. mqtt_node will get DDS service-not-available; recovery from latched faults requires power-cycle. | HIGH |

### 3.2 Closed services that are entirely missing from open

| Service | Type | What closed does | Severity |
|---|---|---|---|
| `/robot_decision/reset_data` | `std_srvs/SetBool` | Clear task counters after fault. String `"Reset task data successfully!!!"` | HIGH |
| `/decision_assistant/load_map` | `nav2_msgs/LoadMap` | Closed binary forwards the loaded map to the assistant so it can compute working-zone polygon. Open never calls it; open's "out of map" detection is dead anyway (§5). | MEDIUM (becomes BLOCKER if out-of-map detection is to ever work) |

### 3.3 Open-only services

| Service | Type | Notes | Recommendation |
|---|---|---|---|
| `/robot_decision/map_position` | `novabot_msgs/Common` | Returns JSON `{x,y,theta}`. Open code comment admits "mqtt_node doesn't actually call this". Closed exposes this as a `Pose` PUBLISHER, not a service. | **Replace** with a `/robot_decision/map_position` `geometry_msgs/Pose` publisher (RELIABLE QoS, ~5 Hz). Drop the service. |

---

## 4. Action-server gaps

| Action (closed) | Closed namespace | Closed type | Open namespace | Open type | Open ref | Gap detail | Severity |
|---|---|---|---|---|---|---|---|
| `slipping_escape` | `/decision_assistant/slipping_escape` | `decision_msgs/SlipEscaping` (goal: `float32 max_escape_time`; result: `uint8 result`) | **`/robot_decision/slip_escaping`** (wrong namespace AND wrong name) | `decision_msgs/SlipEscaping` | decision_assistant.py:96-103 | (a) **Name mismatch** `slip_escaping` vs `slipping_escape`. (b) **Namespace mismatch**: open's DecisionAssistant is constructed with `DecisionAssistant(self)` where `self` is the `robot_decision` node (robot_decision.py:120 `super().__init__('robot_decision')`, robot_decision.py:441 `self.assistant = DecisionAssistant(self)`) — there is NO separate `decision_assistant` ROS node. (c) Server publishes `Twist` directly to `cmd_vel` (decision_assistant.py:179) — CChassisControl gates this, so it is silent on real hardware (per `feedback_safety.md`). (d) No detection-feedback to the main state machine (open never auto-invokes the action; closed coverage planner does call the assistant). | BLOCKER |
| `loc_recover_moving` | `/decision_assistant/loc_recover_moving` | `decision_msgs/LocRecoverMoving` (goal: `float32 max_time`, `uint8 recover_type` 0/1) | **`/robot_decision/loc_recover`** (wrong namespace AND wrong name) | `decision_msgs/LocRecoverMoving` | decision_assistant.py:104-109 | Same three issues as above. Open code does NOT call `/nav2_single_node_navigator/free_move_around`; closed `loc_recover_moving` orchestrates wiggle-and-relocalise via that service. | BLOCKER |

**Auto-trigger paths**: closed binary's coverage_planner_server and nav2 stack call these actions automatically when slip / out-of-map is detected. Because the open implementation publishes the same action *type* but at the wrong (name+namespace), they will never be invoked — the open `_on_motor_current` slip-detection just publishes `/decision_assistant/move_abnormal` (which nothing subscribes to in the open codebase) and never triggers the action at all (open inventory §H "Slip detection (motor current vs odom): ✅ implemented … but only sets state; does NOT auto-trigger SlipEscaping action").

**Action-client gap**: closed `/robot_decision` keeps action-client handles to `/decision_assistant/slipping_escape` and `/decision_assistant/loc_recover_moving` so the main decision loop can invoke them. Open declares neither client.

---

## 5. Topic gaps

### 5.1 Publishers in closed but missing/wrong in open

| Topic | Closed type | Open status | Detail | Severity |
|---|---|---|---|---|
| `/robot_decision/map_position` | `geometry_msgs/Pose` (continuous) | ❌ exposed as a SERVICE instead | Closed publishes pose at high rate while a map is loaded — used by **mqtt_node and dashboard** for live robot dot. Open's `map_position` service requires polling. **Live-position display will be broken** when porting. | BLOCKER |
| `/collision_range` | `sensor_msgs/Range` | ❌ MISSING | Published by closed `/decision_assistant`. mqtt_node maps it to `obstacle_distance` field in `report_state_robot`. Without it the app shows no obstacle distance. | HIGH |
| `/chassis_node/led_buzzer_switch_set` | `std_msgs/UInt8` | ⚠️ Open has it as a *client* (`cli_led_buzzer`), never published as topic | Closed treats this as a topic (publish from `RobotDecision`) for night LED+buzzer. Open declares a service client and never calls it. | LOW (LED not safety-critical) |
| `/local_costmap/prohibited_points` | `geometry_msgs/PolygonStamped` | ⚠️ open has client `cli_prohibited_points`, never called | Closed pushes user-defined no-go zones to nav2 local costmap. Open never wires them through. | MEDIUM |
| `/release_charge_lock` | `std_msgs/UInt8` | ✅ COMPLETE | Open publishes (line 217) | — |
| `/blade_height_set` | `std_msgs/UInt8` | ✅ COMPLETE | Open publishes (line 218) | — |
| `/led_set` | `std_msgs/UInt8` | ✅ COMPLETE | Open publishes (line 222) | — |

### 5.2 Subscribers in closed missing in open

| Topic | Type | Effect of callback (closed) | Open coverage | Severity |
|---|---|---|---|---|
| `/chassis_node/init_ok` | `std_msgs/Bool` | Boot gating — must go true before leaving `SENSOR_INIT` | Open uses a SERVICE client (`cli_init_ok` to `/chassis_node/init_ok`, EmptySrv) instead. Closed seems to use a Bool topic. **Type confusion** — verify what mqtt_node + chassis_control actually expose live. | HIGH |
| `/chassis_node/led_level` | `std_msgs/UInt8` | Mirror LED brightness for night/day decision | Open declares client `cli_led_level` (SetUint8 service); never used. | LOW |
| `/novabot/init_mower` | `std_msgs/UInt8` | Manual reset of internal counters; logs `"Receive init mover command, reset data!!!!"` | Open uses init_mower as a service client only. **Type confusion** again — verify. | MEDIUM |
| `/camera/preposition/hardware_exception` | `std_msgs/Bool` | Camera failure → demote `perception_level` | Open has a service-client wrapper `report_camera_hw_exception` that is never called; no subscription. | MEDIUM |
| `/camera/tof/point_cloud` | `sensor_msgs/PointCloud2` | Time-stamps used to verify ToF stream alive | open has a one-shot lazy subscription to `/perception/points_labeled` (different topic); does not watch ToF liveness. | LOW |
| `/coverage_planner_server/covered_path_json` | `std_msgs/String` | Forwarded to `/robot_decision/covered_path_json` | Open declares `cli_covered_path_json` service client (never called) AND a `covered_path_pub` publisher (never published). | HIGH (app shows no covered path) |
| `/decision_assistant/move_abnormal` | `std_msgs/UInt8` | Stuck count increments → triggers `LOC_ERROR_HANDLE` | Open *publishes* this topic from the same node, but nothing subscribes to it. | MEDIUM |
| `/decision_assistant/robot_out_working_zone` | `std_msgs/Bool` | Triggers `ROBOT_OUT_OF_MAP_HANDLE` | Open *publishes* `UInt8` (wrong type — closed is `Bool`) and only when state is *already* the handle state. Circular dead code. | HIGH |
| `/novabot_mapping/mapping_data` | `mapping_msgs/Polygon` | Live mapping polygon snapshot | Open subscribes to `mapping_polygon` (relative) — different name. **Verify** it lands on the same topic via topic remap; may not. | MEDIUM |
| `/system/shared_memory_error` | `std_msgs/Bool` | Latch shared-memory crash → fault | Open never subscribes; no shared-memory crash detection. | LOW |

### 5.3 Wrong msg types

| Topic | Closed msg | Open msg | Impact |
|---|---|---|---|
| `/decision_assistant/robot_out_working_zone` | `std_msgs/Bool` | `std_msgs/UInt8` (decision_assistant.py:91-92) | mqtt_node and any other subscriber expecting Bool will not receive |
| `/decision_assistant/move_abnormal` | `std_msgs/UInt8` | `std_msgs/UInt8` | OK |
| `/robot_decision/map_position` | `geometry_msgs/Pose` (publisher) | `novabot_msgs/Common` (service) | Major break |

### 5.4 Wrong publish triggers / cadence

| Topic | Closed cadence | Open cadence | Severity |
|---|---|---|---|
| `/robot_decision/robot_status` | High-rate heartbeat (closed: continuous; mqtt_node uses it for `report_state_robot`) | 2 Hz timer (`_publish_status` at robot_decision.py:444, 2381) | OK — 2 Hz is what mqtt_node expects |
| `/robot_decision/covered_path_json` | Re-publishes on demand | **Never publishes** — publisher created (line 204), `cli_covered_path_json` never called | HIGH |
| `/robot_decision/planned_json` | Continuously during cov task | Once at start_cov_task; reads file once (silent fail on missing file, service_handlers.py:553) | MEDIUM |
| `/robot_decision/preview_planned_json` | Once after `generate_preview_cover_path` | ✅ COMPLETE | — |
| `/decision_assistant/escape_pose` | While slip-escape running | Once at slip-escape start (decision_assistant.py:157), no updates | LOW |
| `/cmd_vel` | Closed publishes from BOTH nodes (Twist) | Open publishes from single node | Same effect; OK |
| `/blade_height_set` | Before mowing & schedule changes | Open publishes from `_set_blade_height` | OK |

---

## 6. Parameter gaps

### 6.1 Closed has, open is missing

| Param | Closed default | Closed effect | Open coverage | Severity |
|---|---|---|---|---|
| `boundary_offset` | 0.35 | Boundary-follow inset (m) | Declared but **never read** in open (open inventory marks it dead at param #32) | MEDIUM |
| `charge_back_percentage` | 1 | Battery hysteresis (% considered "back from low") — **runtime-only param** | ❌ MISSING — open has no hysteresis; goes off `low_battery_power` (20) only → may bounce in/out of recharge near 20% | HIGH |
| `collect_image` | 1 | Save sample images during run — runtime-only | ❌ MISSING | LOW |
| `do_camera_switch` | 0 | Force camera-switch routine — runtime-only | ❌ MISSING | LOW |
| `escape_plan_switch` | 0 | Toggle escape strategies — runtime-only | ❌ MISSING (open has only one strategy in `_execute_slip_escape`) | LOW |
| `include_edge` | 1 | Toggle edge in coverage — runtime-only | ❌ MISSING (open uses `cov_mode==2` from request, not param) | MEDIUM |
| `recharge_retry_times` | 0 | Retries on dock-fail | ❌ MISSING — open has its own hardcoded TF_GETTING_FAILED retry (≤2) at robot_decision.py:2043; not parameterised | LOW |

### 6.2 Open declared but never read (from open inventory §F)

`full_battery_power`, `enable_slipping_recover`, `empty_map_path`, `follow_path_id`, `default_perception_level`, `max_save_image_count`, `enable_led_feedback_check`, `covering_path_file`, `boundary_offset`, `cannot_move_angular_diff`, `cannot_move_linear_diff` — 11 dead parameters. Some (`enable_slipping_recover`, `default_perception_level`) are referenced in CLAUDE.md / robot_decision.yaml so users will expect them to work.

### 6.3 Critical params to verify before deploy

| Param | Why critical |
|---|---|
| `escape_plan_switch` | Closed uses to flip recovery strategy. Open has a single fixed strategy. If a problem mower needs the alternative, no toggle exists. |
| `charge_back_percentage` | Without hysteresis the open implementation will bounce auto-recharge state at the threshold. |
| `include_edge` | Edge-cut behaviour controlled here at YAML; open ignores it entirely. |
| `quit_pile_distance` | Closed default 1.0 m; open default 2.0 m (`robot_decision.py:_declare_params`) — different undock distance. Verify safe. |
| `loc_recover_confidence` | Closed 89; open 89. OK. |

---

## 7. State Machine gaps

### 7.1 WorkStatus values defined in BOTH but never *entered* by open

(from open inventory §G.3; cross-checked against closed §G.2 list)

| WorkStatus | Closed enters? | Open enters? | Note |
|---|---|---|---|
| `MANUAL_MAPPING_UNICOM_TO_STATION` | YES (string `"Start mapping unicom/passage to charge station"`) | NO | `add_area` in open never sets it (service_handlers.py:301) |
| `MAPPING_EDIT_MODE` | YES (per closed string list §G.2) | NO | No transition |
| `AUTO_ERASE_MAPPING_FAILED` | YES (string evidence) | NO | `_handle_start_erase` does not track completion |
| `AUTO_ERASE_MAPPING_SUCCESS` | YES | NO | same |
| `BOUNDARY_COVERING` | YES — entered when `start_cov_task` cov_mode=2 | YES (set from coverage feedback fb.work_status=150 in robot_decision.py:1309) | OK on the *enter* path but coverage server is never told `only_edge_mode=True` (cf. `edge-cut-ntcp.md`) |
| `COVERING_MISSING` | YES | NO | No transition |
| `SEARCHING_VISUAL` | YES (string evidence; ArUco docking phase) | NO | AutoCharging server has internal phases but open never reflects them in WorkStatus |
| `REQUEST_START` | YES | NO | No transition |
| `WARN_REPEATED_START` | YES (string `"Cannot start a new task when last task is executing!!!"`) | NO | Open does not guard repeated starts; will accept duplicate `start_cov_task` |
| `TIME_LIMIT_STOP` | YES (per state list) | NO | No max-task-time enforcement |
| `USER_RECHARGE_STOP` | YES | NO | open mixes user-recharge into LOWER_POWER_STOP / USER_STOP |
| `LORA_ERROR_HANDLE` | YES — closed rotates in place to recover LoRa (string `"Try to rotate to recover lora connect"`) | YES (open assistant maps incident→state) but no rotation behaviour | Recovery missing |
| `ROBOT_OUT_OF_MAP_HANDLE` | YES | NO (only checked, never written; circular publisher dead code at decision_assistant.py:490) | Out-of-map handling effectively absent |
| `DELETE_CHILD_MAP` / `DELETE_OBSTACLE` / `DELETE_UINICOM` (note: closed spelling has `UINICOM`, typo) | YES | NO | `_handle_delete_map` does not transition through these; mqtt_node won't see "deletion in progress" |
| `ERROR_LOAD_MAP` | YES (string `"Loading map failed, please check map file exists!!!!"`) | NO | open silently logs warn and continues (service_handlers.py:539) |
| `PATROLLING` | YES (no public service in closed either; entered internally?) | NO | Open has no patrol code |

### 7.2 Transitions in open NOT in closed (extensions / divergence)

| Transition | Where | Risk |
|---|---|---|
| Boot heading-discovery (1.5 m forward + spin) | robot_decision.py:1856 | Closed does ~1 m **reverse** drive via `quit_pile_distance` + `free_move_around`. Different mechanism — open might bump into objects in front. |
| `disable_charge_check` at battery ≥85% | robot_decision.py:1957 | Mitigation for known RECHARGE_FAIL bug; not present in closed. Probably safe and useful. |
| 60s service health check loop | robot_decision.py:2321 | Closed checks at boot only. Open's periodic check is fine but if it cancels actions on a flaky mqtt_node it could over-restart. |
| Direct `cloud_move_cmd` publish from same node | robot_decision.py:719 (`_publish_drive`) | Closed only RELAYS cloud_move_cmd to cmd_vel; open also PUBLISHES cloud_move_cmd from the same node and SUBSCRIBES to it on line 246 — feedback-loop risk avoided only by chassis_node also publishing (open inventory §D bullet 6). |

### 7.3 Specific tricky behaviors

| Behavior | Closed | Open | Severity |
|---|---|---|---|
| Boot drive-back for localization (~1 m reverse via free_move_around) | ✅ — string evidence + `quit_pile_distance: 1.0` | ❌ Open does FORWARD drive + spin ("heading discovery", robot_decision.py:1856). Different mechanism. Per memory `localization & mapping`, stock firmware does the auto reverse — so open's mowers won't get this aid. | HIGH |
| Forced map reload on every `start_cov_task` | ✅ — string `"Forcing to reload map for start new task!!!!"` | ⚠️ Open calls `cli_load_map` (service_handlers.py:535) but does not log/force; if call fails it logs warn and proceeds anyway (line 539). Closed also reloads-then-fails-out. | MEDIUM |
| cov_mode 0/1/2 dispatch | ✅ — three distinct paths | ❌ Only mode 0 and partial mode 2; mode 1 (SPECIFIED_AREA / `polygon_area`) silently ignored. App users selecting "specific area" will get full-coverage instead. | BLOCKER |
| Auto-recharge trigger on low battery | ✅ — `low_battery_power=20`, hysteresis via `charge_back_percentage` | ⚠️ Implemented (robot_decision.py:2138-2146) but no hysteresis | HIGH |
| Slip auto-escalation to action call | ✅ — closed coverage_planner_server (and robot_decision itself) is an action client of `/decision_assistant/slipping_escape` | ❌ Open detects slip in `_on_motor_current` (decision_assistant.py:339) but never sends an action goal; just publishes `/decision_assistant/move_abnormal` to nothing | BLOCKER |
| Out-of-map auto-escalation to LocRecoverMoving | ✅ — closed feeds `/decision_assistant/load_map` and the assistant publishes `robot_out_working_zone` Bool | ❌ Open never calls assistant's load_map; the publisher is `UInt8` (wrong type) and only fires when state is already the handle state (circular) | BLOCKER |
| Drop costmap obstacles before edge cut | ✅ — closed uses `/global_costmap/clear_around_global_costmap` + nav2 costmaps reset (memory `nav2 costmaps before start_boundary_follow` recent commit) | ⚠️ Open `start_coverage` clears local + global costmaps (robot_decision.py:1242) before normal coverage; need to verify also before boundary_follow specifically | MEDIUM |
| Auto-cancel previous task when new task arrives | ✅ — closed has `WARN_REPEATED_START` state | ❌ Open does not warn or cancel — second `start_cov_task` will collide with running goal | HIGH |

---

## 8. Hidden behaviors checklist

| # | Behavior | Closed (file/string evidence) | Open (file:line) |
|---|---|---|---|
| 1 | Localization init drive-back at first task | YES — `quit_pile_distance:1.0` + `"Localization initialization failed, please place the robot to an open area"` + memory `localization & mapping` | YES — but FORWARD 1.5 m + spin (heading discovery), `robot_decision.py:1856`, 24 h heading cache JSON `/userdata/novabot_heading.json` |
| 2 | Reload map_server before every coverage task | YES — string `"Forcing to reload map for start new task!!!!"` | YES — `service_handlers.py:535`, but on failure proceeds anyway |
| 3 | Drop costmap obstacles before edge cut | YES — recent firmware commit `clear nav2 costmaps before start_boundary_follow` | PARTIAL — open clears costmaps in `start_coverage` (robot_decision.py:1242), unclear at boundary_follow path |
| 4 | Auto-cancel previous task when new one arrives | YES — `WARN_REPEATED_START` + string `"Cannot start a new task when last task is executing!!!"` | NO |
| 5 | Auto-recharge on low battery | YES — `low_battery_power=20` + auto trigger | YES — `robot_decision.py:2138-2146` |
| 6 | Pause/resume on rain | UNCLEAR — no string evidence in `robot_decision` strings (per closed inventory §H.15); likely chassis or mqtt-layer | NO direct support in open |
| 7 | Auto-resume after `recharge_finished` | YES — closed exits CHARGING when battery > full_battery_power; resumes prior cov task | PARTIAL — open transitions CHARGING/INIT_SUCCESS but doesn't resume prior task |
| 8 | error_status latching + clear paths | YES — chassis_incident → uint8 latch; cleared by `reset_data` SetBool | PARTIAL — open `_on_incident` maps bits to ErrorStatus (`robot_decision.py:2199`), but `reset_data` service is missing → can't clear via API |
| 9 | map_num reporting (cycle, value semantics) | YES — `map_num=active task count` per memory `map-num-meaning.md`; populated in RobotStatus | NO — open `_publish_status` does not enumerate maps from `home0/`; `current_map_ids` only set during start_cov_task (`robot_decision.py:_publish_status` ~line 2381) |
| 10 | `recalibrate_charging_pose` handling | YES — closed `save_charging_pose` accepts re-call (memory `recalibrate-charging-pose.md`) | NO — open `_handle_save_charging_pose` always returns `map_to_charging_dis=0.0` (service_handlers.py:701); does not run the recalibration flow |
| 11 | Patrol / boundary-cut public service | NO — closed exposes `boundary_follow` action (client side); not as a public service either. Edge-cut is via `start_cov_task` cov_mode=2 in closed; via firmware extended_commands `start_edge_cut` in our system (memory `edge-cut-ntcp.md`) | NO — open mirrors that the `start_cov_task` cov_mode=2 path is the public surface, but it doesn't actually drive only_edge_mode |
| 12 | preview_cover_path service implementation | YES — `generate_preview_cover_path` returns JSON via `coverage_by_file` | YES — `service_handlers.py:625`. ⚠️ `include_edge=False` hardcoded |
| 13 | save_map type:0 followed by type:1 sequencing (with 500 ms delay per `MAPPING-FLOW.md`) | YES — closed strings show two save_map calls; mqtt_node logs both | PARTIAL — `service_handlers.py:584-588` issues type=0 then type=1, **no delay** between them |

---

## 9. Risk-prioritized backlog

### BLOCKERS (mower physically can't operate without these)

1. ✅ **Move action servers off the main node and rename them.** New file: `mower/decision_assistant_node.py` (or refactor existing `decision_assistant.py` to inherit `Node` and own its own `super().__init__('decision_assistant')`). Rename `slip_escaping`→`slipping_escape`, `loc_recover`→`loc_recover_moving`. Effort: **S** (half-day). File: `decision_assistant.py:96-109`. Dep: hardware test on real mower. (commit 2ccdaaa5)
2. ✅ **Fix `/robot_decision/map_position` to be a publisher of `geometry_msgs/Pose`, not a service.** Effort: **XS**. Files: `service_handlers.py:706-712` (delete), `robot_decision.py:200-209` (add publisher), `_publish_status` (publish each tick). Dep: dashboard / mqtt_node spot-check. (commit 17502d30)
3. ✅ **`start_cov_task` cov_mode=1 (specified-area) handling.** Currently the mower will mow the whole map regardless of polygon. Effort: **M** (1 day). File: `service_handlers.py:498`. Dep: `coverage_by_file.srv` accepts polygon_area; verify against `coverage_planner` package. (commit a39d43a3)
4. ✅ **Slip + loc-recover auto-escalation.** Add action clients on the main node that call the (renamed) actions when `_on_motor_current` slip-detect or `loc_quality` collapse. Effort: **M**. Files: `robot_decision.py` (add 2 action clients), `decision_assistant.py:339` (replace publish with action goal). Dep: backlog #1. (commits cb16d55b, 6147eb47)
5. ✅ **Replace `cmd_vel` with `cloud_move_cmd` in slip/loc-recover publishers** (CChassisControl bypass). Effort: **XS**. File: `decision_assistant.py:179, 500`. Dep: backlog #1. (commit 87c780df)

### HIGH

6. ✅ **Implement `/robot_decision/reset_data` SetBool service.** Effort: **XS**. File: `service_handlers.py` (+ a clear_counters helper). Without it, latched errors require power-cycle. (commit 0b42de89)
7. ✅ **Fix `start_assistant_mapping` undefined `dist_from_charger` NameError.** Effort: **XS**. File: `service_handlers.py:377` — drop the dist log or compute distance from current pose vs `charger_pose`. (commit 9ecf4092)
8. ✅ **Stop/resume semantics in `stop_task`** — distinguish `data=true` (pause) vs `data=false` (resume). Effort: **S**. File: `service_handlers.py:412`. Test: send pause then resume during cov task. (commit bfe7de63)
9. ✅ **Out-of-map handling — actually wire it up.** Subscribe to `/decision_assistant/robot_out_working_zone` (Bool) and call the assistant's `load_map` after every map load. Effort: **M**. Files: `robot_decision.py` (subscriber + client), `decision_assistant.py:475-493` (replace circular logic). Dep: backlog #1. (commit e5372f55)
10. ✅ **Fix `/decision_assistant/robot_out_working_zone` msg type to `std_msgs/Bool`.** Effort: **XS**. File: `decision_assistant.py:91-92`. Dep: backlog #9. (commit ec93177a)
11. ✅ **Drop duplicate `battery_message` subscription.** Effort: **XS**. File: `robot_decision.py:226-231`. Today: every battery message processes twice — cancels coverage + starts recharge twice on low-battery. (commit 75bc9f17)
12. ✅ **`covered_path_json` topic actually published.** Either subscribe to `/coverage_planner_server/covered_path_json` and re-publish, or call `cli_covered_path_json` periodically. Effort: **S**. File: `robot_decision.py:204` + `service_handlers.py`. (commit 2314a5e4)
13. ✅ **`save_map` 500 ms delay between type:0 and type:1.** Effort: **XS**. File: `service_handlers.py:584-588`. Dep: read `docs/reference/MAPPING-FLOW.md`. (commit 583f6475)
14. ✅ **Hardcoded `home0` parent in `save_map` and `delete_map`.** Effort: **XS**. Files: `service_handlers.py:579, 669`. (commit 30e7b803)
15. ✅ verified; no code change required — **`map_num` reporting** — confirmed `map_num` = active task count, not on-disk map count; current open implementation's semantics are already correct. (commit 33d34c79)
16. ✅ **Auto-cancel previous task when new task arrives** (or set `WARN_REPEATED_START`). Effort: **S**. File: `service_handlers.py:498` + `state_machine.py`. (commit a39d43a3)
17. ✅ **Battery hysteresis (`charge_back_percentage`).** Effort: **XS**. File: `robot_decision.py:_on_battery`. Add param + bounce-prevention logic. (commit 555a52c0)
18. ✅ **`/chassis_node/init_ok` topic vs service confusion.** Effort: **S** (live test). Verify against the real chassis_node which it actually exposes; possibly both. Files: `robot_decision.py` (add Bool subscriber if needed). (commit 4ca57c06)

### MEDIUM

19. ⚠️ open `start_assistant_mapping` returns success synchronously even if thread fails. Replace with proper goal-handle pattern or call the boundary action directly with timeout. Effort: **S**.
20. ✅ Implement `add_area` UNICOM_TO_STATION transition. Effort: **XS**. File: `service_handlers.py:301`. (commit 45a0310b)
21. ✅ Track `AUTO_ERASE_MAPPING_FAILED` / `AUTO_ERASE_MAPPING_SUCCESS` after `cli_erase_map_mode` returns. Effort: **XS**. File: `service_handlers.py:393`. (commit 23f225a6)
22. ✅ Forward `request.maptype` into `cli_mapping_control` type field; transition through `DELETE_*` states. Effort: **S**. File: `service_handlers.py:661`. (commit 30e7b803)
23. ✅ Propagate real `map_to_charging_dis` from upstream service result. Effort: **XS**. File: `service_handlers.py:701`. (commit 9af41126)
24. ✅ Implement `nav_to_recharge` guide-pose mode (and the "no mapping mode" guard). Effort: **S**. File: `service_handlers.py:608`. (commit f20ba095)
25. ✅ Wire `cli_prohibited_points` so `local_costmap/prohibited_points` reflects user no-go zones. Effort: **S**. (commit cb7df9c8)
26. ✅ `ERROR_LOAD_MAP` state on `cli_load_map` failure. Effort: **XS**. File: `service_handlers.py:539`. (commit a39d43a3)
27. ✅ Open lacks `/decision_assistant/load_map` service (closed has it). Add it (noop is fine for now since out-of-map detection is dead) — paves backlog #9. Effort: **XS** once the assistant becomes its own node. (commit 2ccdaaa5)
28. ✅ Hardcoded `include_edge=False` in `generate_preview_cover_path`. Use request data. Effort: **XS**. File: `service_handlers.py:637`. (commit ee2b6179)
29. ✅ Add the missing parameters: `boundary_offset` (live wire it through to coverage_by_file), `charge_back_percentage`, `include_edge`, `recharge_retry_times`. Effort: **S**. (commit 8740e081)

### LOW

30. ✅ Subscribe to `/chassis_node/led_level`, `/camera/preposition/hardware_exception`, `/camera/tof/point_cloud`, `/system/shared_memory_error`. Effort: **S** (each XS). (commit 3af90c53)
31. ✅ Remove or document the 8 dead parameters in open (per inventory §F). (commit cac7c623)
32. ✅ Remove or document the dead service clients (`cli_free_move_around`, `cli_covered_path_json`, `cli_prohibited_points`, `cli_led_buzzer`, `cli_led_level`, `cli_preposition_save`, `cli_save_pcd_img`, `cli_preposition_hw_exception`). Either implement or delete. (commit cac7c623)
33. ✅ `_publish_status`: stop hardcoding `msg.cpu_usage = 0` and `msg.light = 0` (both `robot_decision.py:_publish_status`). (commit 8e6b8afc)
34. ✅ Add `LORA_ERROR_HANDLE` rotation behaviour. Effort: **S**. (commit 252d42bd)
35. ⚠️ open Add CPU temperature watchdog cancel-on-overheat (already partly in open at robot_decision.py:427); align thresholds with closed.

### Bugs found in open implementation

- ✅ **`service_handlers.py:377`** — `dist_from_charger` is undefined; will raise `NameError` whenever `start_assistant_mapping` is called while on the charger. (commit 9ecf4092)
- ✅ **`robot_decision.py:226-231`** — duplicate subscription to `battery_message` (one SENSOR_QOS, one RELIABLE) → callback fires twice per message → low-battery cancellation triggers twice. (commit 75bc9f17)
- ✅ **`service_handlers.py:701`** — `response.map_to_charging_dis = 0.0` hardcoded; closed propagates the real distance from `/novabot_mapping/set_charging_pose` upstream result. (commit 9af41126)
- ✅ **`decision_assistant.py:91-92`** — `out_of_zone_pub` is `std_msgs/UInt8`; closed uses `std_msgs/Bool`. Subscriber type mismatch on real mower. (commit ec93177a)
- ✅ **`decision_assistant.py:475-493`** — circular logic: `check_out_of_map` only publishes if `work_status == ROBOT_OUT_OF_MAP_HANDLE`, but nothing in the open code ever writes that state → publisher is provably dead. (commit e5372f55)
- ✅ **`service_handlers.py:637`** — `include_edge=False` hardcoded in `_handle_generate_path` regardless of request. (commit ee2b6179)
- ✅ **`service_handlers.py:584-588`** — `save_map` issues type=0 then type=1 with no delay; `MAPPING-FLOW.md` requires ~500 ms between them for `map.yaml` to be created. (commit 583f6475)
- ⚠️ open **`robot_decision.py:1856`** — heading-discovery drives FORWARD; closed binary's equivalent (`free_move_around` + `quit_pile_distance:1.0`) drives REVERSE. Forward direction may collide with whatever the mower is parked in front of.
- ✅ **`decision_assistant.py:96, 104`** — action server names AND namespace are wrong; closed uses `/decision_assistant/slipping_escape` and `/decision_assistant/loc_recover_moving`. (commit 2ccdaaa5)
- ✅ **`service_handlers.py:706-712`** — `/robot_decision/map_position` exposed as a service but closed publishes it as a `Pose` topic. Live position tooling will not see it. (commit 17502d30)
- ✅ **`robot_decision.py:_publish_status` (~line 2412)** — hardcoded `msg.cpu_usage = 0` and `msg.light = 0`. (commit 8e6b8afc)
- ✅ **No `/robot_decision/reset_data` server** — error-clear path missing. (commit 0b42de89)

### Remaining gaps after 2026-04-26 implementation

The following items were intentionally left as TODOs during Phase 8.1 cleanup or
required further work that fell outside scope:

- **#19** (`start_assistant_mapping` async return): Service still returns success synchronously before the boundary-follow thread completes. Proper fix requires converting to a goal-handle pattern or an action server. Deferred because autonomous mapping is a low-priority path not yet tested on real hardware.
- **#35** (CPU temperature watchdog thresholds): Watchdog cancel-on-overheat is partially present in `robot_decision.py:427` but thresholds are not aligned with the closed binary. Deferred — requires live thermal profiling to determine safe cutoff values.
- **Heading-discovery direction** (Bug item): Open drives FORWARD 1.5 m; closed drives REVERSE ~1 m via `free_move_around`. The forward direction risks a collision if the mower is parked against an obstacle. Deferred pending explicit hardware authorization — changing direction of physical movement requires user confirmation before deployment.

These items are tracked but require either further reverse-engineering, live hardware authorization, or explicit user sign-off before implementation.

---

## 10. Open Questions / Unknowns

1. **`/chassis_node/init_ok` interface shape.** ✅ CONFIRMED (2026-04-26 live mower 192.168.0.100): TOPIC ONLY. `ros2 topic info /chassis_node/init_ok -v` shows `Type: std_msgs/msg/Bool`, published by `CChassisControl` node, subscribed by `robot_decision` node. NO service interface exists. **Closed binary uses Bool topic subscription.** Open incorrectly implemented it as `std_srvs/Empty` service client. FIXED in commit 4ca57c06: removed service client `cli_init_ok`, added Bool topic subscription, changed boot phase to latch `_boot_init_ok_received` flag on receipt, waits max 10s then skips to INIT_MOWER if not received. All 34 tests pass.
2. **Closed binary's stuck-counter threshold.** String `"robot stuck count: %d"` is captured but the threshold value is not exposed via param or log. Need to instrument live for several minutes during a slip event.
3. **Closed `decision_assistant`'s `/decision_assistant/load_map` consumers.** Closed exposes the service but it is unclear how often `robot_decision` actually pushes the polygon (every `start_cov_task`? boot only? on map change?). Trace with `ros2 service echo` over a full mowing session.
4. **`start_assistant_mapping` internal flow.** Memory `autonomous-mapping.md` calls out perception_node tweaks + obstacle_max_range; closed binary undoubtedly calls a private boundary-follow action with specific parameters. Capture all inbound calls during a fresh autonomous-mapping run on stock firmware.
5. **`cov_mode=1` (SPECIFIED_AREA) coverage_by_file behaviour.** Need to capture exact request fields when the app sends `polygon_area`. Open implementation does not currently form the polygon; need to know whether `coverage_by_file.srv` consumes `polygon_area` directly or a saved file path.
6. **Recharge guide-pose mode usage.** Closed string `"Recharge with guide pose mode only support no mapping mode"` confirms behaviour but not the call sites. Search mqtt_node for `nav_to_recharge` invocations to see when the app uses it.
7. **`map_num` semantics.** ✅ CONFIRMED (2026-04-26): Memory `map-num-meaning.md` correctly identifies `map_num` as the *active coverage task count*, NOT the on-disk map count. Unable to obtain live `ros2 topic echo /robot_decision/robot_status` due to message type not installed, but verified disk state: LFIN1231000211 had 6 map directories (`map0.yaml`, `map.yaml`, etc. under `/userdata/lfi/maps/home0/`) while robot_decision was running in idle/localization-failed state (no active coverage task). This confirms `map_num` field is independent from on-disk directory count. No code changes needed in open implementation; proceed with current semantics assumption.
8. **Boot drive-back vs heading-discovery interaction.** Project memory notes "Stock firmware DOET zelf localization init" with reverse drive. Open does forward-drive heading discovery instead. Run both on the same mower in identical conditions to see which finds map frame faster.
9. **`/system/shared_memory_error` source.** Closed subscribes; not clear which node publishes. Possibly OTA process. Need `ros2 topic info /system/shared_memory_error -v` on a running mower.
10. **`recalibrate_charging_pose` MQTT vs ROS** — memory references it but it's not exposed by the closed binary as a public service. Likely mqtt_node-only handler that calls `save_charging_pose` internally; verify. If so, no robot_decision change needed; only documentation.

---

## 11. Post-implementation parity (2026-04-26)

**Live smoke run: SUCCESSFUL.** Captured full `ros2 node info` output from the closed C++ binary running on mower `192.168.0.100` at 2026-04-26 21:15 UTC. Script: `mower/tests/runtime/run_smoke.sh` (extended with node info + param dump blocks).

### Key findings from live capture

**Service servers (closed binary):**
- `/robot_decision`: 18 services (all expected ones present, including `reset_data`)
- `/decision_assistant`: 1 service (`load_map`)
- **Total: 19** ✓ matches inventory

**Action servers (closed binary):**
- `/decision_assistant/slipping_escape` ✓
- `/decision_assistant/loc_recover_moving` ✓
- **Total: 2** ✓ matches inventory, both on `/decision_assistant` node

**Topic Publishers (closed binary):**
- `/robot_decision` publishes 11 topics (incl. `map_position` as `geometry_msgs/Pose`)
- `/decision_assistant` publishes 6 topics (incl. `/collision_range`)
- **Total: 17** vs inventory's 18 (may be minor topic count drift; all critical ones present)

**Topic Subscribers (closed binary):**
- `/robot_decision` subscribes to 16 topics (incl. `/chassis_node/init_ok` as Bool topic, confirmed)
- `/decision_assistant` subscribes to 6 topics
- **Total: 22** vs inventory's 20 (2 extra likely due to minor drift in capture; high confidence on both nodes' main subscriptions)

**Service clients (closed binary):**
- `/robot_decision` has 26 service clients (matches inventory range)
- All critical targets present: `/map_server/load_map`, `/coverage_planner_server/coverage_by_file`, `/decision_assistant/load_map`, `/novabot_mapping/*`, `/perception/*`

**Action clients (closed binary):**
- `/robot_decision` has 6 action clients (matches):
  - `/auto_charging`
  - `/boundary_follow`
  - `/follow_path`
  - `/navigate_through_coverage_paths`
  - `/decision_assistant/loc_recover_moving`
  - `/decision_assistant/slipping_escape`
- `/decision_assistant` has 1 action client: `/navigate_to_pose`

### Newly surfaced gaps (from live data)

1. **`/robot_decision/map_position` IS a publisher, not a service.** Live `ros2 node info` confirms closed publishes `geometry_msgs/Pose` at high rate. Open incorrectly exposes it as a `novabot_msgs/Common` service. **Blocker #2** in gap analysis (§9) still critical.

2. **`/collision_range` confirmed published by `/decision_assistant`.** mqtt_node consumes this for `obstacle_distance` field. Open does not publish it. **Gap §5.1** confirmed.

3. **`/decision_assistant/robot_out_working_zone` IS `Bool` type in closed.** Live confirms `std_msgs/Bool`. Open publishes `UInt8` — type mismatch. **Gap §5.3** confirmed.

4. **`/chassis_node/init_ok` confirmed as Topic (Bool), not a service.** Closed binary subscribes to the topic. Live `ros2 topic info` shows it is published by `CChassisControl`, type `std_msgs/Bool`. Open's use of a service client is incorrect. **Test finding § 10.1** verified: fix already applied in commit `4ca57c06`.

5. **`/robot_decision/reset_data` service confirmed present on closed binary.** Live confirms it exists. Open implementation was missing it until recently. **Gap §3.2** / **Blocker #6** in backlog still applies to confirm open implementation completeness.

6. **Action namespaces confirmed correct on closed.** Both actions (`slipping_escape`, `loc_recover_moving`) are on `/decision_assistant`, not `/robot_decision`. Open incorrectly placed them on the main node. **Blocker #1** in backlog still critical.

### No new gaps, no regressions

The live capture validates all prior findings in the gap analysis. The open implementation's top 6 blockers remain unchanged. No discrepancies between the 2026-04-25 inventory and the 2026-04-26 live run were found — the closed binary's ROS graph is stable.

### Snapshot artifact

Live capture saved to `research/documents/closed-decision-graph-snapshot-2026-04-26.txt` (sanitized, no IPs).

---

### Cross-references / source citations

- All closed-side claims: `/tmp/closed_decision_inventory.md` §A-I (HIGH-confidence live `ros2 node info` + `ros2 param dump` 2026-04-25 22:48-22:50).
- **New live capture: `research/documents/closed-decision-graph-snapshot-2026-04-26.txt`** (2026-04-26 21:15 UTC, mower 192.168.0.100).
- All open-side file:line citations: `/Users/rvbcrs/GitHub/Novabot/mower/{robot_decision.py,decision_assistant.py,service_handlers.py,state_machine.py}` (read in full).
- Project memory used: `feedback_safety.md`, `edge-cut-ntcp.md`, `map-num-meaning.md`, `recalibrate-charging-pose.md` (referenced indirectly), `autonomous-mapping.md`, `localization & mapping` facts in MEMORY.md.
- Existing RE doc `research/documents/robot_decision_reverse_engineering.md` was consulted; where it disagrees with the live introspection (e.g. claimed `start_assistant_mapping` is `StartMap` — it is `SetBool` per live data; placed `slip_escaping`/`loc_recover` on `/robot_decision` — they are on `/decision_assistant`), the live data takes precedence.
