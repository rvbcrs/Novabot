# Field-Name Audit — Open Decision vs Live Mower Interfaces

**Date:** 2026-04-26  
**Branch audited:** `feat/open-decision-finish`  
**Files audited:** `mower/robot_decision.py`, `mower/service_handlers.py`, `mower/decision_assistant.py`, `mower/state_machine.py`  
**Ground truth source:** SSH read of live mower `192.168.0.100` — `/focal-xj3-arm64/root/novabot/install/` and `/root/novabot/install/`  

---

## Summary

| Category  | Count |
|-----------|-------|
| CRITICAL  | 5     |
| IMPORTANT | 4     |
| MINOR     | 9     |
| VERIFIED  | 87    |

---

## CRITICAL — Fabricated fields, crash at runtime

### C1 — `Mapping.srv`: `req.main_id` does not exist

**Files:** `service_handlers.py:250`, `robot_decision.py:996`, `robot_decision.py:1006`

**Code:**
```python
req = MappingSrv.Request()
req.resolution = resolution
req.type = map_type
req.main_id = 0          # ← FABRICATED
```

**Live interface (`mapping_msgs/srvs/Mapping.srv`):**
```
float32 resolution
int64 type
---
bool result
string message
```

`main_id` does not exist on this service. rclpy will raise `AttributeError` at the assignment line, causing `_generate_map()` to crash and all save_map calls to fail.

**Fix:** Remove `req.main_id = 0` from all three sites.

---

### C2 — `SetChargingPose.srv`: `result.map_to_charging_dis` does not exist

**Files:** `service_handlers.py:236`, `service_handlers.py:872`

**Code:**
```python
dist = float(getattr(result, 'map_to_charging_dis', 0.0))
...
response.map_to_charging_dis = float(dist)
```

**Live interface (`mapping_msgs/srvs/SetChargingPose.srv` response):**
```
geometry_msgs/Pose charging_pose
bool result
string message
```

There is no `map_to_charging_dis` field in the response. The `getattr(..., 0.0)` fallback on the READ side silently returns 0.0 and does not crash — but the `response.map_to_charging_dis = float(dist)` on the WRITE side (line 872 of service_handlers.py, the `/robot_decision/save_charging_pose` handler) will crash because `SetChargingPoseSrv.Response` also has no such field.

Additionally, the `_on_charger_pose_read` callback (robot_decision.py:974) does `pose = result.charging_pose` and then `self._charger_pose_x = pose.position.x` — the field `charging_pose` IS confirmed present, so that part is correct.

**Fix:**
- Line 236: `dist = 0.0  # SetChargingPose response has no map_to_charging_dis`
- Line 872: Remove `response.map_to_charging_dis = float(dist)` (the field doesn't exist on the response type used as the server response either — but the server response here is `SetChargingPoseSrv.Response` from mapping_msgs, which equally lacks this field).

---

### C3 — `CovTaskResult.msg`: `cov_ratio`, `cov_area`, `cov_work_time` do not exist

**File:** `robot_decision.py:1469–1471`

**Code:**
```python
cov_result = CovTaskResult()
cov_result.cov_ratio = result.covered_ratio    # ← FABRICATED
cov_result.cov_area = result.total_covered_area # ← FABRICATED
cov_result.cov_work_time = elapsed              # ← FABRICATED
```

**Live interface (`decision_msgs/msg/CovTaskResult.msg`):**
```
builtin_interfaces/Time start_time
builtin_interfaces/Time end_time
uint8 map_num
uint8 finished_num
uint8 work_status
uint8 error_status
uint32 map_ids
float32 area
uint8 target_height
uint8 request_type
```

Fields `cov_ratio`, `cov_area`, `cov_work_time` are completely absent. rclpy raises `AttributeError` on publish, crashing the `_on_coverage_result` callback. The actual coverage result is never published to mqtt_node.

**Fix:** Map to the fields that DO exist:
```python
cov_result.work_status = int(result.result_status)
cov_result.area = result.total_covered_area
cov_result.target_height = self.target_height
cov_result.map_ids = int(self.request_map_ids or 0)
```

---

### C4 — `DeleteMap.srv`: `request.map_file_name` does not exist

**File:** `service_handlers.py:828`, `service_handlers.py:841`

**Code:**
```python
self.log.info(
    f'DeleteMap: maptype={request.maptype}, '
    f'mapname={request.mapname}, parent={request.map_file_name}')  # ← FABRICATED
...
req.map_file_name = request.map_file_name or 'home0'              # ← FABRICATED
```

**Live interface (`decision_msgs/srv/DeleteMap.srv` request):**
```
uint8 maptype
string mapname
---
uint8 result
string description
```

`map_file_name` does not exist on `DeleteMap.Request`. Accessing it raises `AttributeError` in the log line (before even reaching the MappingControl call), crashing the entire `_handle_delete_map` handler.

**Fix:** Remove `request.map_file_name` references; use `'home0'` hardcoded or a stored `n.current_map_name`:
```python
parent_name = n.current_map_name or 'home0'
```

---

### C5 — `Recording.srv`: field type mismatch — code sends `int`, live srv is `int64` (OK) but the `_stop_recording()` call semantics are broken by using `type=0` as a placeholder

**ACTUALLY NOT CRITICAL** — `int64` in ROS2 accepts Python int. This was a false positive. Resolved to MINOR (see M-2).

Updated C5 → **`StartCoverageTask.srv`: `map_ids` field type mismatch (IMPORTANT, see I2)**.

---

## IMPORTANT — Type mismatches / semantic errors

### I1 — `StartCoverageTask.srv`: `map_ids` is `uint32` scalar, code treats as indexable array

**File:** `service_handlers.py:576–578`

**Code:**
```python
n.request_map_ids = (
    int(request.map_ids[0]) if request.map_ids else 0
)
```

**Live interface (`decision_msgs/srv/StartCoverageTask.srv`):**
```
uint32 map_ids
```

`map_ids` is a single `uint32` scalar, NOT an array. Indexing `request.map_ids[0]` will raise `TypeError` ("'int' object is not subscriptable"). The `if request.map_ids` guard evaluates to `False` if map_ids==0, correctly falling to the `else 0` path — but any non-zero map_ids value (normal mowing call) crashes.

**Fix:** `n.request_map_ids = int(request.map_ids)`

---

### I2 — `StartCoverageTask.srv`: `blade_heights` is `uint8[]` array — code indexes `[0]`

**File:** `service_handlers.py:580–581`

**Code:**
```python
blade_height = (request.blade_heights[0]
                if request.blade_heights else 40)
```

**Live interface:**
```
uint8[]  blade_heights
```

`blade_heights` IS correctly typed as an array (`uint8[]`). The indexing is correct. However see also the `polygon_area` field next.

**Verdict: VERIFIED — correct.**

---

### I2 — `StartCoverageTask.srv`: `polygon_area` field is `geometry_msgs/Point[]`, code does `list(request.polygon_area)`

**File:** `service_handlers.py:629–631`

**Code:**
```python
polygon_area = (
    list(request.polygon_area)
    if cov_mode == 1 and getattr(request, 'polygon_area', None)
    else None)
```

**Live interface:**
```
geometry_msgs/Point[]  polygon_area
```

The field exists and is correctly typed. `list()` on a ROS array produces a Python list of `geometry_msgs.msg.Point` objects. This is semantically correct but the downstream code (`start_coverage`) discards `polygon_area` with a warning because NavigateThroughCoveragePaths.action has no such field. No crash, but the feature doesn't work. **Categorised MINOR** (documented intent, see comments in code).

---

### I3 — `RobotStatus.msg`: `cpu_usage` is `uint8` but code assigns a float

**File:** `robot_decision.py:2800–2802`

**Code:**
```python
msg.cpu_usage = float(f.read().split()[0]) * 100.0
```

**Live interface (`decision_msgs/msg/RobotStatus.msg`):**
```
uint8 cpu_usage
```

`uint8` truncates float. Value like 3.5 (load avg) × 100 = 350, which overflows uint8 (max 255). rclpy silently clamps or wraps. No crash, but cpu_usage will report wrong values for any load > 2.55.

**Fix:** `msg.cpu_usage = min(255, int(float(f.read().split()[0]) * 100.0))`

---

### I4 — `NavigateToPose.action`: `goal.controller_id` / `goal.goal_checker_id` do not exist on live action

**File:** `robot_decision.py:1953–1955`

**Code:**
```python
goal = NavigateToPoseAction.Goal()
goal.pose = pose_stamped
goal.behavior_tree = ''
goal.controller_id = ''      # ← check
goal.goal_checker_id = ''    # ← check
```

**Live interface (`nav2_msgs/action/NavigateToPose.action` goal):**
```
geometry_msgs/PoseStamped pose
string behavior_tree
string controller_id
string goal_checker_id
```

Both `controller_id` and `goal_checker_id` ARE present in the live action definition. **VERIFIED — no mismatch.**

---

### I5 — `SetChargingPose.srv` request: `control_mode` is `int64` but code passes Python int — OK

Python `int` is compatible with `int64`. No issue. **VERIFIED.**

---

## MINOR

### M1 — `Mapping.srv` `type` field: `int64` in srv but code uses Python `int` — OK

Python `int` is compatible with ROS `int64`. No issue.

---

### M2 — `Recording.srv` stop call: `type=0` is used as a placeholder, but stop is a separate service `/novabot_mapping/recording_stop` — functionally correct

The `_stop_recording()` sends a Recording.Request to `cli_recording_stop` with `type=0`. The `Recording.srv` `type` field on the stop service is simply not used by the server (it's a stop command), so this placeholder is harmless. Documented as minor.

---

### M3 — `BoundaryFollow.action` goal: code sets fields correctly but `enable_coverage` is used with inverted intended meaning

**File:** `robot_decision.py:1180`

```python
goal.enable_coverage = False
```

The field exists (`bool enable_coverage # whether enable cutting`). Setting it to `False` for autonomous mapping mode is correct (no cutting during mapping). **VERIFIED.**

---

### M4 — `AutoCharging.action`: `result.code` vs actual field name

**File:** `robot_decision.py:2292`

**Code:** `if result.code == 100:`

**Live interface (`automatic_recharge_msgs/actions/AutoCharging.action` result):**
```
uint8 code
bool charge_status
string message
```

`code` EXISTS. **VERIFIED.** But constant `SUCCESS=100` is NOT defined in the action — code hardcodes `100` which matches the live constant. OK.

---

### M5 — Open-only parameters declared on `robot_decision` node

The following parameters are declared by our Python node but will NEVER appear in `ros2 param list /robot_decision` when the closed binary runs (not that it matters for our use, but noted):

- `gazebo_debug_mode` — open-only
- `enable_rtk_init_check` — open-only
- `check_process` — open-only
- `escape_plan_switch` — open-only
- `collect_image` — open-only
- `do_camera_switch` — open-only
- `enable_led_feedback_check` — open-only

---

### M6 — `nav2_single_node_navigator/robot_maybe_stuck` — topic vs service ambiguity

**File:** `robot_decision.py:353-355`

Code creates a **service client** `cli_maybe_stuck` of type `SetBool` to `/nav2_single_node_navigator/robot_maybe_stuck`.

Live `ros2 service list` output DOES NOT include `/nav2_single_node_navigator/robot_maybe_stuck` as a service. The live `ros2 topic list` shows `/nav2_single_node_navigator/robot_maybe_stuck` as a **topic**. The service client `wait_for_service` will always return False and the call will silently be skipped (due to the `wait_for_service` guard in `_call_service`). This means `report_maybe_stuck()` is a no-op at runtime.

**Fix:** Change to a publisher: `self.maybe_stuck_pub = self.create_publisher(Bool, '/nav2_single_node_navigator/robot_maybe_stuck', RELIABLE_QOS)` and publish `Bool(data=stuck)`.

---

### M7 — `GenerateCoveragePath.srv`: `request.map_ids` and `request.cov_direction` accessed but these DO exist

**File:** `service_handlers.py:778–779`

**Code:**
```python
self.log.info(
    f'GenerateCoveragePath: map_ids={request.map_ids}, '
    f'direction={request.cov_direction}')
```

**Live interface (`decision_msgs/srv/GenerateCoveragePath.srv`):**
```
uint32 map_ids
bool specify_direction
uint8 cov_direction
---
bool result
```

`map_ids` and `cov_direction` are present. **VERIFIED.** `specify_direction` is also present but not used — minor omission, no crash.

---

### M8 — `CombinationStatus.msg`: `msg.status` accessed; `message` field also exists but never read

**File:** `robot_decision.py:2543`

`msg.status` is confirmed present. The `message` string field is unused. **VERIFIED** (status field), minor unused field.

---

### M9 — `ChassisIncident.msg`: `error_lift_motor_error` field accessed but not present in live msg

**File:** `robot_decision.py:2529`

**Code:**
```python
elif msg.error_lift_motor_error:
    self.error_status = ErrorStatus.LIFT_MOTOR_ERROR
```

**Live interface (`novabot_msgs/msg/ChassisIncident.msg`)** — the full error section lists these bool fields ending at:
```
bool error_no_set_pin_code
```

There is NO `error_lift_motor_error` field in the live ChassisIncident.msg. Accessing a non-existent attribute on a ROS message raises `AttributeError`, which would crash `_process_incident_errors` and therefore `_on_incident` for any ChassisIncident message.

**Fix:** Remove or guard: `if hasattr(msg, 'error_lift_motor_error') and msg.error_lift_motor_error:`

---

## VERIFIED — Confirmed correct against live interfaces

### decision_msgs

| Type | Field | Status |
|------|-------|--------|
| `Charging.srv` Request | `name`, `pose_x`, `pose_y`, `pose_theta`, `mode` | ✅ |
| `Charging.srv` Response | `result` (uint8), `description` (string) | ✅ |
| `DeleteMap.srv` Request | `maptype` (uint8), `mapname` (string) | ✅ |
| `DeleteMap.srv` Response | `result` (uint8), `description` (string) | ✅ |
| `SaveMap.srv` Request | `mapname`, `resolution`, `type` (int64) | ✅ |
| `SaveMap.srv` Response | `data`, `result` (uint8), `error_code` (uint8) | ✅ |
| `StartMap.srv` Request | `model`, `mapname`, `type` (uint8) | ✅ |
| `StartMap.srv` Response | `data`, `result` (uint8) | ✅ |
| `StartCoverageTask.srv` Request | `cov_mode`, `map_names[]`, `polygon_area[]`, `blade_heights[]`, `specify_direction`, `cov_direction`, `light`, `specify_perception_level`, `perception_level` | ✅ |
| `StartCoverageTask.srv` Response | `result` (bool) | ✅ |
| `GenerateCoveragePath.srv` Request | `map_ids` (uint32), `specify_direction` (bool), `cov_direction` (uint8) | ✅ |
| `GenerateCoveragePath.srv` Response | `result` (bool) | ✅ |
| `LoadUtmOriginInfo.srv` Request | `utm_info_path` | ✅ |
| `LoadUtmOriginInfo.srv` Response | `msg`, `result` (bool) | ✅ |
| `SaveUtmOriginInfo.srv` Request | `utm_info_path` | ✅ |
| `SaveUtmOriginInfo.srv` Response | `msg`, `result` (bool) | ✅ |
| `SlipEscaping.action` Goal | `max_escape_time` (float32) | ✅ |
| `SlipEscaping.action` Result | `result` (uint8), constants `SUCCESS=0`, `FAILED=1` | ✅ |
| `LocRecoverMoving.action` Goal | `max_time` (float32), `recover_type` (uint8) | ✅ |
| `LocRecoverMoving.action` Result | `result` (uint8), constants `SUCCESS=0`, `FAILED=1` | ✅ |
| `RobotStatus.msg` | `stamp`, `task_mode`, `work_status`, `recharge_status`, `error_status`, `prev_task_mode`, `prev_work_status`, `prev_recharge_status`, `merged_work_status`, `msg`, `error_msg`, `request_map_ids` (uint32), `current_map_ids` (uint32), `cov_ratio`, `cov_area`, `cov_remaining_area`, `cov_estimate_time`, `cov_work_time`, `valid_cov_work_time`, `avoiding_obstacle_time`, `pause_time`, `cov_map_path`, `target_height` (uint8), `light`, `perception_level`, `battery_power`, `cpu_temperature`, `memory_remaining`, `disk_remaining`, `loc_quality`, `working_time`, `x`, `y`, `theta`, `start_time`, `end_time` | ✅ |

### mapping_msgs

| Type | Field | Status |
|------|-------|--------|
| `Mapping.srv` Request | `resolution` (float32), `type` (int64) | ✅ |
| `Mapping.srv` Response | `result` (bool), `message` (string) | ✅ |
| `Recording.srv` Request | `type` (int64) | ✅ |
| `Recording.srv` Response | `result` (bool), `message` (string) | ✅ |
| `MappingControl.srv` Request | `map_file_name`, `child_map_file_name`, `obstacle_file_name`, `unicom_area_file_name`, `type` (int64) | ✅ |
| `MappingControl.srv` Response | `result` (bool), `message` (string) | ✅ |
| `GenerateEmptyMap.srv` Request | `map_path`, `resolution`, `width`, `height` | ✅ |
| `GenerateEmptyMap.srv` Response | `result` (bool) | ✅ |
| `SetChargingPose.srv` Request | `control_mode` (int64), `map_file_name`, `child_map_file_name` | ✅ |
| `SetChargingPose.srv` Response | `charging_pose` (geometry_msgs/Pose), `result` (bool), `message` | ✅ |
| `Polygon.msg` | `type` (int64), `polygon` (geometry_msgs/Polygon) | ✅ |

### coverage_planner

| Type | Field | Status |
|------|-------|--------|
| `CoveragePathsByFile.srv` Request | `map_yaml_file` (string), `start_pose` (geometry_msgs/Pose) | ✅ |
| `CoveragePathsByFile.srv` Response | `coverage_paths` (nav_msgs/Path[]), `result` (uint8), constants `RESULT_SUCCESS=0`, `RESULT_FAILURE=255` | ✅ |
| `NavigateThroughCoveragePaths.action` Goal | `map_yaml`, `coverage_type`, `reset_coverage_map`, `return_to_start`, `disable_recover`, `enable_tf_action_abort_as_stop`, `include_edge`, `mixed_edge`, `setting_blade_height`, `blade_height`, `grass_height`, `auto_repeat_num`, `target_repeat_times`, `debug_mode`, `adaptive_mode`, `cov_direction_change`, `test_long_length`, `test_short_length` | ✅ |
| `NavigateThroughCoveragePaths.action` Result | `result_status` (uint8), `msg`, `total_covered_area`, `task_planned_area`, `task_covered_area`, `covered_ratio`, `obstacle_avoid_count`, `navigation_time`, `total_missed_area`, `recovered_missed_area` | ✅ |
| `NavigateThroughCoveragePaths.action` Feedback | `work_status` (uint8), `total_covered_area`, `task_planned_area`, `task_covered_area`, `covered_ratio`, `estimate_remaining_time`, `obstacle_avoid_count`, `navigation_time`, `finished_times` | ✅ |
| `BoundaryFollow.action` Goal | `follow_mode`, `enable_coverage`, `more_close_to_boundary`, `close_loop_stop`, `start_follow_wait`, `debug_mode`, `inflation_radius`, `blade_height` | ✅ |
| `BoundaryFollow.action` Result | `status` (uint8), `msg`, constants `LOOP_CLOSED=0`, `CANCELLED=2` | ✅ |

### automatic_recharge_msgs

| Type | Field | Status |
|------|-------|--------|
| `AutoCharging.action` Goal | `charge_pose`, `overwrite`, `non_charging_pose_mode`, `enable_no_visual_recharge`, `max_retry`, `disable_charge_check`, `keep_alive`, `rotate_searching` | ✅ |
| `AutoCharging.action` Result | `code` (uint8), `charge_status` (bool), `message`, constants `SUCCESS=100` | ✅ |
| `AutoCharging.action` Feedback | `charging_phase` (string), `in_align_mode` (bool) | ✅ |

### nav2_msgs

| Type | Field | Status |
|------|-------|--------|
| `LoadMap.srv` Request | `map_url` (string) | ✅ |
| `LoadMap.srv` Response | `result` (uint8), constants `RESULT_SUCCESS=0`, `RESULT_UNDEFINED_FAILURE=255` | ✅ |
| `ClearCostmapAroundRobot.srv` Request | `reset_distance` (float32) | ✅ |
| `SemanticMode.srv` Request | `semantic_mode` (uint8), constants `LAWN_COVER=0`, `FREE_MOVE=1`, `BOUNDARY_FOLLOW=2`, `IGNORE_SEMANTIC=3` | ✅ |
| `NavigateToPose.action` Goal | `pose`, `behavior_tree`, `controller_id`, `goal_checker_id` | ✅ |
| `NavigateToPose.action` Feedback | `distance_remaining` (float32) | ✅ |
| `NavigateToPose.action` Result | `status` (uint8) | ✅ |

### novabot_msgs

| Type | Field | Status |
|------|-------|--------|
| `ChassisBatteryMessage.msg` | `battery_rsoc_percent`, `battery_voltage_mv`, `battery_current_ma` | ✅ |
| `ChassisIncident.msg` | `error_set_flag`, `warning_set_flag`, `error_charge_stop`, `error_push_button_stop`, `error_collision_stop`, `error_upraise_stop`, `error_tile_stop`, `error_turn_over`, `error_left_motor_stall_stop`, `error_right_motor_stall_stop`, `error_blade_motor_stall_stop`, `error_left_motor_overcur_stop`, `error_right_motor_overcur_stop`, `error_blade_motor_overcur_stop`, `error_imu`, `error_lora`, `error_rtk`, `error_wheel_static_over_current_timeout_stop`, `error_no_pin_code`, `error_usb_busy_error`, `error_usb_not_ok_error`, `error_no_set_pin_code` | ✅ |
| `ChassisMotorCurrent.msg` | `left_motor_current_ma`, `right_motor_current_ma`, `cut_motor_current_ma` | ✅ |
| `CloudMoveCmd.msg` | `stamp`, `linear_x`, `angular_wheel` | ✅ |

### localization_msgs

| Type | Field | Status |
|------|-------|--------|
| `CombinationStatus.msg` | `status` (uint8), constants matching `LocStatus` enum | ✅ |
| `LoadUtmOriginInfo.srv` | `utm_info_path`, response `msg`, `result` | ✅ |
| `SaveUtmOriginInfo.srv` | `utm_info_path`, response `msg`, `result` | ✅ |

### nav2_pro_msgs

| Type | Field | Status |
|------|-------|--------|
| `FreeMoveAround.srv` Request | `pose` (PoseStamped), `using_input_pose` (bool), `local_costmap` (bool), `global_costmap` (bool), `radius` (float32) | ✅ |
| `FreeMoveAround.srv` Response | `result` (bool) | ✅ |

### general_msgs

| Type | Field | Status |
|------|-------|--------|
| `SetUint8.srv` Request | `value` (uint8) | ✅ |
| `SetUint8.srv` Response | `success` (bool), `message` (string) | ✅ |
| `SaveFile.srv` Request | `filename` (string) | ✅ |
| `SaveFile.srv` Response | `success` (bool), `message` (string) | ✅ |

---

## Endpoint Name Verification (against live `ros2 service list` / `action list` / `topic list`)

### Services — VERIFIED present on live mower

| Service name | Code uses it as |
|---|---|
| `/robot_decision/start_mapping` | server ✅ |
| `/robot_decision/add_area` | server ✅ |
| `/robot_decision/reset_mapping` | server ✅ |
| `/robot_decision/start_assistant_mapping` | server ✅ |
| `/robot_decision/start_erase` | server ✅ |
| `/robot_decision/stop_task` | server ✅ |
| `/robot_decision/map_stop_record` | server ✅ |
| `/robot_decision/reset_data` | server ✅ |
| `/robot_decision/auto_recharge` | server ✅ |
| `/robot_decision/cancel_task` | server ✅ |
| `/robot_decision/cancel_recharge` | server ✅ |
| `/robot_decision/quit_mapping_mode` | server ✅ |
| `/robot_decision/start_cov_task` | server ✅ |
| `/robot_decision/save_map` | server ✅ |
| `/robot_decision/nav_to_recharge` | server ✅ |
| `/robot_decision/generate_preview_cover_path` | server ✅ |
| `/robot_decision/delete_map` | server ✅ |
| `/robot_decision/save_charging_pose` | server ✅ |
| `/novabot_mapping/mapping_data` | client (`mapping` service, exposed as `/novabot_mapping/mapping`) — **NAME MISMATCH** see below |
| `/novabot_mapping/recording_edge` | client ✅ |
| `/novabot_mapping/recording_stop` | client ✅ |
| `/novabot_mapping/set_charging_pose` | client ✅ |
| `/novabot_mapping/generate_empty_map` | client ✅ |
| `/novabot_mapping/mapping_control` | client ✅ |
| `/novabot_mapping/control_erase_map_mode` | client ✅ |
| `/map_server/load_map` | client ✅ |
| `/decision_assistant/load_map` | client ✅ |
| `/perception/do_perception` | client ✅ |
| `/coverage_planner_server/coverage_by_file` | client ✅ |
| `/coverage_planner_server/cover_task_stop` | client ✅ |
| `/local_costmap/clear_around_local_costmap` | client ✅ |
| `/global_costmap/clear_around_global_costmap` | client ✅ |
| `/nav2_single_node_navigator/free_move_around` | client ✅ |
| `/camera/panoramic/start_camera` | client ✅ |
| `/camera/preposition/start_camera` | client ✅ |
| `/camera/preposition/save_camera` | client ✅ |
| `/camera/tof/start_camera` | client ✅ |
| `/perception/save_pcd_img` | client ✅ |
| `/perception/set_infer_model` | client ✅ |
| `/perception/set_seg_level` | client ✅ |
| `/local_costmap/set_semantic_mode` | client ✅ |
| `/local_costmap/set_detection_mode` | client ✅ |
| `/chassis_node/led_level` | client ✅ |
| `/novabot/init_mower` | client (as topic, actually `/novabot/init_mower` appears in topic list) — see M-note below |
| `/enable_aruco_localization` | client ✅ |
| `/local_costmap/local_costmap_rclcpp_node/set_parameters` | client ✅ |
| `/auto_recharge_server/set_parameters` | client ✅ |
| `load_utm_origin_info` | client ✅ |
| `save_utm_origin_info` | client ✅ |

### IMPORTANT: `/novabot_mapping/mapping_data` name vs live service

**File:** `robot_decision.py:293–295`

```python
self.cli_mapping_data = self.create_client(
    MappingSrv, '/novabot_mapping/mapping_data', ...)
```

**Live `ros2 service list`:** `/novabot_mapping/mapping` (not `mapping_data`). Also `/novabot_mapping/mapping_data` is listed as a **topic** (from topic list: `/novabot_mapping/mapping_data`).

This means the service client targets a non-existent service name. The correct service name is `/novabot_mapping/mapping` (type `mapping_msgs/Mapping`).

This is an additional **CRITICAL** finding:

### C6 — `/novabot_mapping/mapping_data` is a TOPIC, not a service — correct service name is `/novabot_mapping/mapping`

**Files:** `robot_decision.py:293`, `service_handlers.py` (uses `n.cli_mapping_data`)

`wait_for_service` will always time out and return False. All `_generate_map()` calls will fail silently (the service handler falls through to the `result is None` path), meaning no map is ever generated during or after mapping sessions.

**Fix:** Change service name from `/novabot_mapping/mapping_data` to `/novabot_mapping/mapping`.

---

### Actions — VERIFIED present

| Action name | Status |
|---|---|
| `/navigate_through_coverage_paths` | ✅ |
| `/boundary_follow` | ✅ |
| `/navigate_to_pose` | ✅ |
| `/auto_charging` | ✅ |
| `/decision_assistant/slipping_escape` | ✅ |
| `/decision_assistant/loc_recover_moving` | ✅ |

### Topics — VERIFIED present

| Topic | Status |
|---|---|
| `/robot_decision/robot_status` | ✅ |
| `/robot_decision/cov_task_result` | ✅ |
| `/robot_decision/covered_path_json` | ✅ |
| `/robot_decision/planned_json` | ✅ |
| `/robot_decision/preview_planned_json` | ✅ |
| `/robot_decision/map_position` | ✅ |
| `cmd_vel` | ✅ |
| `cloud_move_cmd` | ✅ |
| `release_charge_lock` | ✅ |
| `blade_height_set` | ✅ |
| `blade_speed_set` | ✅ |
| `led_set` | ✅ |
| `battery_message` | ✅ |
| `chassis_incident` | ✅ |
| `motor_current` | ✅ |
| `/robot_combination_localization/combination_status` | ✅ |
| `odom_raw` | ✅ |
| `mapping_polygon` | ✅ (implied by `/novabot_mapping/mapping_data` topic) |
| `/decision_assistant/robot_out_working_zone` | ✅ |
| `/coverage_planner_server/covered_path_json` | ✅ |
| `/chassis_node/init_ok` | ✅ |
| `/chassis_node/led_level` | ✅ |
| `/camera/preposition/hardware_exception` | ✅ |
| `/system/shared_memory_error` | ✅ |
| `/camera/tof/point_cloud` | ✅ |
| `/camera/preposition/total_gain` | ✅ |
| `/chassis_node/led_buzzer_switch_set` | ✅ |
| `/local_costmap/prohibited_points` | ✅ |
| `/perception/points_labeled` | ✅ |
| `/decision_assistant/escape_pose` | ✅ |
| `/decision_assistant/move_abnormal` | ✅ |
| `collision_range` | ✅ |

---

## Summary Table

| ID | Severity | File | Line | Issue | Fix |
|----|----------|------|------|-------|-----|
| C1 | CRITICAL | service_handlers.py | 250 | `Mapping.srv` has no `main_id` field | Remove `req.main_id = 0` |
| C1b | CRITICAL | robot_decision.py | 996, 1006 | Same `req.main_id = 0` | Remove both |
| C2 | CRITICAL | service_handlers.py | 872 | `SetChargingPose.Response` has no `map_to_charging_dis` | Remove response field assignment |
| C3 | CRITICAL | robot_decision.py | 1469–1471 | `CovTaskResult` has no `cov_ratio`, `cov_area`, `cov_work_time` | Map to `area`, `work_status`, `target_height` |
| C4 | CRITICAL | service_handlers.py | 828, 841 | `DeleteMap.Request` has no `map_file_name` | Use `n.current_map_name or 'home0'` |
| C6 | CRITICAL | robot_decision.py | 293 | `/novabot_mapping/mapping_data` is a topic, not a service | Change to `/novabot_mapping/mapping` |
| M9 | CRITICAL | robot_decision.py | 2529 | `ChassisIncident` has no `error_lift_motor_error` field | Guard with `hasattr` or remove |
| I1 | IMPORTANT | service_handlers.py | 577 | `map_ids` is scalar `uint32`, not indexable array | `int(request.map_ids)` |
| I3 | IMPORTANT | robot_decision.py | 2800 | `cpu_usage` is `uint8`, code assigns float×100 | `min(255, int(...))` |
| M6 | MINOR | robot_decision.py | 353 | `/nav2_single_node_navigator/robot_maybe_stuck` is a topic, not a service | Change to publisher |
| M5 | MINOR | robot_decision.py | 533–606 | Several open-only params never appear in live binary | Documented, intentional |

---

*Audit performed 2026-04-26. Raw interface dump saved locally (not committed). Ground truth: SSH live read of mower 192.168.0.100.*
