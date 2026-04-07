# robot_decision — Reverse Engineering Analysis

Binary: `/root/novabot/install/compound_decision/lib/compound_decision/robot_decision`
Source files (from embedded paths):
- `/root/novabot/src/decision/compound_decision/src/main.cpp`
- `/root/novabot/src/decision/compound_decision/src/robot_decision.cpp`
- `/root/novabot/src/decision/compound_decision/src/decision_assistant.cpp`

Platform: ROS 2 Galactic, ARM64 (aarch64), NOT stripped (~17920 strings)

---

## 1. State Machine — All States

### Task Modes (task_mode in RobotStatus.msg)
| Value | Name | Description |
|-------|------|-------------|
| 0 | `FREE` | Idle, ready for commands |
| 1 | `COVER` | Coverage/mowing task active |
| 2 | `RECHARING` | Recharging in progress (typo in original) |
| 3 | `MAPPING` | Mapping session active |
| 4 | `CHARGING` | On charger, fully charged or charging |
| 5 | `STOP` | Stopped |

### Internal State Machine States
| State | Context |
|-------|---------|
| `SYSTEM_CHECK_INIT` | Boot: checking system processes |
| `SENSOR_INIT` | Boot: waiting for chassis_node/init_ok |
| `LOCALIZATION_INIT` | Boot: initializing localization |
| `LOCALIZATION_UTM_INIT` | Boot: loading UTM origin from pos.json |
| `INIT_SUCCESS` | Boot complete |
| `QUIT_PILE_INIT` | Undocking: backing away from charger |
| `ALIGN_PILE` | Docking: aligning with charging pile |
| `MAPPING` | Mapping mode active |
| `MAPPING_EDIT_MODE` | Map editing (add obstacle/unicom) |
| `MAPPING_STOP_RECORD` | Stopping map recording |
| `MANUAL_MAPPING_WORKING_ZONE` | Manual mapping - drawing work zone boundary |
| `MANUAL_MAPPING_OBSTACLE` | Manual mapping - drawing obstacle |
| `MANUAL_MAPPING_UNICOM` | Manual mapping - drawing inter-map passage |
| `MANUAL_MAPPING_UNICOM_TO_STATION` | Manual mapping - passage to charging station |
| `ASSISTANT_MAPPING_MAPPING_WORKING_ZONE` | Autonomous mapping - work zone |
| `ASSISTANT_MAPPING_MAPPING_OBSTACLE` | Autonomous mapping - obstacle detection |
| `AUTO_ERASE_MAPPING` | Auto-erasing mapping path |
| `AUTO_ERASE_MAPPING_FAILED` | Auto-erase failed |
| `AUTO_ERASE_MAPPING_SUCCESS` | Auto-erase succeeded |
| `BOUNDARY_COVERING` | Mowing along boundary/edges |
| `COVERING_MISSING` | Covering missed areas |
| `MOVING` | Robot moving |
| `PATROLLING` | Patrol mode |
| `SEARCHING_VISUAL` | Searching for visual markers (ArUco?) |
| `SETTING_CHARGING_STATION` | Setting/saving charger position |
| `RETURN_TO_PILE` | Returning to charger |
| `REQUEST_START` | Requesting task start |
| `LOC_ERROR_HANDLE` | Handling localization error |
| `LORA_ERROR_HANDLE` | Handling LoRa disconnect |
| `SLIPPING_HANDLE` | Handling wheel slip |
| `ROBOT_OUT_OF_MAP_HANDLE` | Robot outside mapped area |
| `RECOVER_ERROR_STOP` | Stopped due to unrecoverable error |
| `LOWER_POWER_STOP` | Stopped due to low battery |
| `TIME_LIMIT_STOP` | Stopped due to time limit |
| `USER_STOP` | Stopped by user |
| `USER_RECHARGE_STOP` | User requested recharge |
| `WARN_REPEATED_START` | Warning: repeated start attempt |
| `FINISHED_ONCE` | Single coverage pass finished |
| `FAILED_ONCE` | Single coverage pass failed |
| `CANCELLED` | Task cancelled |
| `ERROR_LOAD_MAP` | Error loading map |
| `DELETE_CHILD_MAP` | Deleting sub-map |
| `DELETE_OBSTACLE` | Deleting obstacle map |
| `DELETE_UINICOM` | Deleting unicom passage |

---

## 2. ROS2 Interface — Complete Map

### Services EXPOSED by robot_decision (Servers)
These are the services that mqtt_node and other nodes call INTO robot_decision:

| Service | Type | Description |
|---------|------|-------------|
| `/robot_decision/start_assistant_mapping` | `decision_msgs/StartMap` | Start autonomous mapping (type=1) |
| `/robot_decision/map_stop_record` | Unknown | Stop map recording |
| `/robot_decision/quit_mapping_mode` | Unknown | Exit mapping mode |
| `/robot_decision/reset_mapping` | Unknown | Reset mapping state |
| (StartCoverageTask server) | `decision_msgs/StartCoverageTask` | Start mowing task |
| (SaveMap server) | `decision_msgs/SaveMap` | Save current map |
| (GenerateCoveragePath server) | `decision_msgs/GenerateCoveragePath` | Generate preview coverage path |
| (Charging server) | `decision_msgs/Charging` | Start charging/recharge task |
| (LoadMap server) | `nav2_msgs/LoadMap` | Load a map file |
| (SetChargingPose server) | `mapping_msgs/SetChargingPose` | Save charger position |

### Services CALLED by robot_decision (Clients)
| Service | Type | Description |
|---------|------|-------------|
| `/chassis_node/init_ok` | `std_srvs/Empty` | Check chassis initialized |
| `/chassis_node/led_buzzer_switch_set` | `general_msgs/SetUint8` | Control LED/buzzer |
| `/chassis_node/led_level` | Unknown | Set LED brightness |
| `/novabot/init_mower` | Unknown | Initialize mower subsystems |
| `/novabot_mapping/mapping_data` | `mapping_msgs/Mapping` | Get mapping data |
| `/novabot_mapping/set_charging_pose` | `mapping_msgs/SetChargingPose` | Save charger pose to map |
| `novabot_mapping/control_erase_map_mode` | `mapping_msgs/MappingControl` | Control map erase mode |
| `/map_server/load_map` | `nav2_msgs/LoadMap` | Load nav2 map |
| `/decision_assistant/load_map` | Unknown | Load map in assistant |
| `/coverage_planner_server/coverage_by_file` | `coverage_planner/CoveragePathsByFile` | Generate coverage from files |
| `/coverage_planner_server/cover_task_stop` | Unknown | Stop coverage task |
| `/coverage_planner_server/covered_path_json` | Unknown | Get covered path JSON |
| `/nav2_single_node_navigator/free_move_around` | `nav2_pro_msgs/FreeMoveAround` | Free movement without map |
| `/nav2_single_node_navigator/robot_maybe_stuck` | Unknown | Report stuck status |
| `/camera/panoramic/start_camera` | Unknown | Start panoramic camera |
| `/camera/preposition/start_camera` | Unknown | Start preposition camera |
| `/camera/preposition/save_camera` | `general_msgs/SaveFile` | Save camera image |
| `/camera/preposition/hardware_exception` | Unknown | Camera hardware error |
| `/camera/preposition/total_gain` | Unknown | Camera gain |
| `/camera/tof/start_camera` | Unknown | Start ToF camera |
| `/perception/do_perception` | `std_srvs/SetBool` | Enable/disable perception |
| `/perception/save_pcd_img` | Unknown | Save point cloud + image |
| `/perception/set_infer_model` | Unknown | Set AI inference model |
| `/perception/set_seg_level` | Unknown | Set segmentation level |
| `/local_costmap/clear_around_local_costmap` | `nav2_msgs/ClearCostmapAroundRobot` | Clear local costmap |
| `/local_costmap/set_semantic_mode` | `nav2_msgs/SemanticMode` | Set semantic mode |
| `/local_costmap/set_detection_mode` | Unknown | Set detection mode |
| `/local_costmap/prohibited_points` | Unknown | Set prohibited points |
| `/global_costmap/clear_around_global_costmap` | `nav2_msgs/ClearCostmapAroundRobot` | Clear global costmap |
| (LoadUtmOriginInfo client) | `localization_msgs/LoadUtmOriginInfo` | Load UTM origin |
| (SaveUtmOriginInfo client) | `localization_msgs/SaveUtmOriginInfo` | Save UTM origin |
| (GenerateEmptyMap client) | `mapping_msgs/GenerateEmptyMap` | Generate empty map |
| (Recording client) | `mapping_msgs/Recording` | Start/stop map recording |

### Topics SUBSCRIBED by robot_decision
| Topic | Type | Description |
|-------|------|-------------|
| (odom) | `nav_msgs/Odometry` | Robot odometry (subscribed by BOTH RobotDecision AND DecisionAssistant) |
| (cloud_move_cmd) | `novabot_msgs/CloudMoveCmd` | Cloud/MQTT move commands (joystick) |
| (chassis_incident) | `novabot_msgs/ChassisIncident` | Chassis error events |
| (battery) | `novabot_msgs/ChassisBatteryMessage` | Battery status |
| (motor_current) | `novabot_msgs/ChassisMotorCurrent` | Motor current (slip detection) |
| (polygon) | `mapping_msgs/Polygon` | Mapping polygon data |
| (twist) | `geometry_msgs/Twist` | Velocity commands |
| (occupancy_grid) | `nav_msgs/OccupancyGrid` | Map grid |
| (point_cloud) | `sensor_msgs/PointCloud2` | ToF point cloud |
| (bool topics) | `std_msgs/Bool` | Various boolean flags |
| (uint8 topics) | `std_msgs/UInt8` | Various uint8 status |
| (uint32 topics) | `std_msgs/UInt32` | Various uint32 status |
| (string topics) | `std_msgs/String` | Various string status |

### Topics PUBLISHED by robot_decision
| Topic | Type | Description |
|-------|------|-------------|
| (robot_status) | `decision_msgs/RobotStatus` | Main status message (continuous) |
| (cov_task_result) | `decision_msgs/CovTaskResult` | Coverage task results |
| `/blade_height_set` | Unknown | Set blade height |
| `/led_set` | Unknown | Set LED state |
| `/collision_range` | Unknown | Collision detection range |
| `/decision_assistant/escape_pose` | Unknown | Escape pose for assistant |
| `/decision_assistant/robot_out_working_zone` | Unknown | Robot left working zone |
| `/decision_assistant/move_abnormal` | Unknown | Abnormal movement detected |
| `/system/shared_memory_error` | Unknown | Shared memory error |

### Action CLIENTS (robot_decision calls these)
| Action | Type | Description |
|--------|------|-------------|
| `/navigate_to_pose` | `nav2_msgs/NavigateToPose` | Navigate to specific pose |
| (follow_path) | `nav2_msgs/FollowPath` | Follow a planned path |
| (boundary_follow) | `coverage_planner/BoundaryFollow` | Follow boundary edge |
| (navigate_coverage) | `coverage_planner/NavigateThroughCoveragePaths` | Execute coverage mowing |
| (auto_charging) | `automatic_recharge_msgs/AutoCharging` | Autonomous docking |

### Action SERVERS (robot_decision provides these)
| Action | Type | Description |
|--------|------|-------------|
| (slip_escaping) | `decision_msgs/SlipEscaping` | Handle wheel slipping |
| (loc_recover) | `decision_msgs/LocRecoverMoving` | Recover from localization loss |

---

## 3. Key Flows — Reconstructed from Strings

### Boot Sequence
```
SYSTEM_CHECK_INIT
  ├── Check processes: nav2_single_node_navigator, robot_decision,
  │   coverage_planner_server, robot_combination_localization,
  │   chassis_control_node, novabot_mapping
  ├── Wait for /chassis_node/init_ok
  └── Call /novabot/init_mower
SENSOR_INIT
  └── Check cameras (check_camera_clean), sensors
LOCALIZATION_UTM_INIT
  └── Load UTM origin from /userdata/pos.json via LoadUtmOriginInfo
LOCALIZATION_INIT
  ├── "Localization is not stable, need more move to confirm"
  ├── "Localization initialization failed, please place the robot to an open area"
  └── enable_rtk_init_check: True (config)
INIT_SUCCESS
  └── Ready for commands
```

### Undocking (QUIT_PILE) Flow
```
QUIT_PILE_INIT
  ├── quit_pile_distance: 1.0 (config) — drives 1m backward from charger
  ├── Uses /nav2_single_node_navigator/free_move_around service
  │   (FreeMoveAround = drive without map constraints)
  └── After undock complete → ready for mapping/mowing
```

**KEY INSIGHT**: The undock uses `free_move_around` — this is a navigation service that allows movement WITHOUT a loaded map. This is how the mower can leave the dock even without localization.

### Manual Mapping Flow (start_scan_map via MQTT)
```
mqtt_node receives: { start_scan_map: { mapName: "name" } }
  ↓
mqtt_node calls: /robot_decision/StartMap service
  with: type=0, mapname="name"
  ↓
robot_decision:
  1. "Receiving start mapping request!!!"
  2. "Now start mapping work area"
  3. State → MANUAL_MAPPING_WORKING_ZONE
  4. Calls /novabot_mapping/mapping_data (start recording GPS points)
  5. "Start recording" — mapping_msgs/Recording
  ↓
User drives with joystick (CloudMoveCmd → robot movement)
  ↓
mqtt_node receives: { save_map: { mapName: "name" } }
  ↓
robot_decision SaveMap service:
  1. "Save map request: <type> <name>"
  2. "Save charging pose Ok, map_to_charging_dis: %.2f"
  3. Calls /novabot_mapping/set_charging_pose
  4. Saves sub maps and total map
  5. State → MAPPING_STOP_RECORD
```

### Autonomous Mapping Flow (start_assistant_build_map via MQTT)
```
mqtt_node receives: { start_assistant_build_map: { mapName: "name" } }
  ↓
mqtt_node calls: /robot_decision/start_assistant_mapping
  with: type=1, mapname="name"
  ↓
robot_decision:
  1. State → ASSISTANT_MAPPING_MAPPING_WORKING_ZONE
  2. Robot autonomously drives boundary using navigation
  3. After boundary complete → State can transition to
     ASSISTANT_MAPPING_MAPPING_OBSTACLE
  ↓
(Robot autonomously detects and records obstacles)
```

### Mowing (start_run via MQTT → StartCoverageTask)
```
mqtt_node receives: { start_run: { workArea: [...], ... } }
  ↓
robot_decision StartCoverageTask service:
  Parameters:
    cov_mode: 0=NORMAL, 1=SPECIFIED_AREA, 2=BOUNDARY_COV
    request_type: 11=app normal, 12=scheduled, 21=MCU, 22=MCU scheduled
    map_ids: which map to mow
    polygon_area: polygon for SPECIFIED_AREA mode
    blade_heights: 0-7 (actual height = (level+2)*10 mm)
    specify_direction: bool
    cov_direction: 0-180 degrees
    perception_level: 0=off, 1=detect, 2=segment, 3=segment high
    enable_loc_weak_mapping: allow mapping with weak localization
    enable_loc_weak_working: allow mowing with weak localization
  ↓
  Flow:
  1. "Forcing to reload map for start new task!!!!"
  2. Load map via /map_server/load_map
  3. Generate coverage path via /coverage_planner_server/coverage_by_file
  4. Execute via NavigateThroughCoveragePaths action
  5. During mowing: RobotStatus updates with cov_ratio, cov_area, etc.
  ↓
  Completion/Stop:
  - "Coverage action is stopped!!!, start new task!!!"
  - work_status: 9=complete, 2=cancelled, 1=failed
```

### Recharge Flow
```
Trigger: low_battery_power: 20 (config) or user command
  ↓
  1. RETURN_TO_PILE state
  2. NavigateToPose action → navigate to saved charger pose
  3. ALIGN_PILE state → align with charging pile
  4. AutoCharging action → dock onto charger
  5. CHARGING state
  ↓
  Messages:
  - "Already in recharging status, No need to recharge!!!"
  - "Receiving recharge task command for coverage task!!!"
  - "Cannot cancel recharge when recharge task is executing!!!"
  - "Get result from recharge action %hhd!!!"
  - "Deal with recharge finished event"
```

### Error Handling
```
Localization errors:
  - "Can not get transform between base link and map!!!"
  - "Localization quality is very bad!!!"
  - "Localization is not stable, need more move to confirm"
  - "Lora disconnect for some time, may causing localization not good!!!"
  - LOC_ERROR_HANDLE state → LocRecoverMoving action
    - recover_type: 0=loc bad recover, 1=robot out of map

Hardware errors:
  - "Blade motor is stalled, please check motor or try again after input pin"
  - "Blade motor over current, please check motor or try again after input pin"
  - "Moving motor is stalled, please check motor or try again after input pin"
  - "Moving motor over current, please check motor or try again after input pin"
  - "Chassis serial error, please reboot machine (make sure robot not in charging when rebooting)!!!"
  - "Charging station position error, if you did not move the station, please retry"
  - "Hardware error, cannot start task!!!"

Navigation errors:
  - "Action nav to pose is not ready or no map get!!!"
  - "Map service is not ready!!!"
  - "Loading map failed, please check map file exists!!!!"
  - "Boundary Follow failed!!! %hhd"
  - ROBOT_OUT_OF_MAP_HANDLE state

Slip detection:
  - "Detected slipping angular:%.2f linear: %.2f left cur: %.2f right: cur:%.2f"
  - slipping_motor_current: 10 (config)
  - straight_slipping_dis_diff: 0.07
  - rotate_slipping_yaw_diff: 0.11
  - SlipEscaping action → escape_angular_vel: 1.5, escape_linear_vel: 0.5

Developer message:
  - "Fuck, status machine error!!!!" (actual string in binary)
```

---

## 4. Configuration Parameters (from robot_decision.yaml)

```yaml
robot_decision:
  ros__parameters:
    coverage_times: 1              # Number of coverage passes
    gazebo_debug_mode: False       # Simulation mode
    low_battery_power: 20          # Battery % to trigger recharge
    full_battery_power: 96         # Battery % considered full
    enable_loc_recover: True       # Auto-recover from localization loss
    enable_slipping_recover: True  # Auto-recover from slipping
    load_map_path: "/userdata/lfi/maps/home0"
    empty_map_path: "/userdata/lfi/maps/"
    save_utm_path: "/userdata/pos.json"
    enable_loc_unstable_handle: false  # Handle localization drift
    quit_pile_distance: 1.0        # Undock backup distance (meters)
    follow_path_id: "FollowPathPurePursuitReverseFollow"  # Path follower
    loc_mapping_confidence: 69     # Min confidence for mapping
    loc_cover_confidence: 40       # Min confidence for mowing (lower!)
    loc_recover_confidence: 89     # Min confidence for recovery
    default_perception_level: 1    # 0=detection, 1=segmentation
    min_perception_level: 0        # Minimum allowed perception level
    detect_out_of_boundary: True   # Detect leaving mapped area
    slipping_motor_current: 10     # Motor current threshold for slip
    image_darkness_thresh: 60.0    # Camera darkness threshold
    image_darkness_thresh_lower: 5.0
    enable_save_image: True        # Save camera images
    max_save_image_count: 80       # Max saved images
    enable_led_light: True         # LED during operation
    check_camera_clean: True       # Check camera cleanliness
    enable_rtk_init_check: True    # Check RTK/GPS at boot
    enable_low_power_mode: True    # Low power sleep mode
    enable_led_feedback_check: False  # LED response verification
    check_process: [               # Processes to verify at boot
      "/nav2_single_node_navigator",
      "/robot_decision",
      "/coverage_planner_server",
      "/robot_combination_localization",
      "/chassis_control_node",
      "novabot_mapping"
    ]
    planned_path_file: /userdata/lfi/maps/home0/planned_path
    covering_path_file: /userdata/lfi/maps/home0/covered_path
    boundary_offset: 0.35         # Offset from boundary (meters)
    save_tof_rgb: True            # Save ToF + RGB together
    cpu_temp_thresh: 93.9         # CPU temp shutdown threshold
    enable_out_of_map_recover: True  # Recovery when outside map

decision_assistant:
  ros__parameters:
    escape_angular_vel: 1.5       # Escape rotation speed (rad/s)
    escape_linear_vel: 0.5        # Escape linear speed (m/s)
    straight_slipping_dis_diff: 0.07  # Slip distance threshold
    rotate_slipping_yaw_diff: 0.11    # Slip rotation threshold
    cannot_move_angular_diff: 0.5     # Stuck rotation threshold
    cannot_move_linear_diff: 0.15     # Stuck distance threshold
```

---

## 5. File Paths Used

| Path | Purpose |
|------|---------|
| `/userdata/lfi/maps/home0/` | Main map directory |
| `/userdata/lfi/maps/home0/covered_path/` | Covered path data |
| `/userdata/lfi/maps/home0/planned_path/` | Planned path data |
| `/userdata/lfi/maps/` | Empty map directory |
| `/userdata/lfi/maps_path_list/pathlist/` | Path list directory |
| `/userdata/pos.json` | UTM origin position |
| `/map.yaml` | Main map YAML |
| `/map0.yaml` | First sub-map YAML |
| `/covered_path.json` | Covered path JSON |
| `/planned_path.json` | Planned path JSON |
| `/preview_planned_path.json` | Preview path JSON |

---

## 6. Key Insights for Our Dashboard

### Undocking Problem
The undocking (QUIT_PILE_INIT) uses `free_move_around` from `nav2_single_node_navigator` — this is a ROS service, NOT an MQTT command. The MQTT `start_move` command goes to `CloudMoveCmd` topic which is subscribed by robot_decision, but there may be a check preventing movement while on the charger.

**Potential solution**: The BLE joystick likely bypasses robot_decision and talks directly to chassis_control_node. Our MQTT joystick goes through mqtt_node → robot_decision → chassis, which may have charger safety checks.

### Mapping Flow
For our dashboard mapping:
1. Send `start_scan_map` (MQTT) → calls `StartMap` with `type=0` (manual)
2. Drive with joystick (needs to work off-charger first)
3. Send `save_map` (MQTT) → calls `SaveMap` service
4. Mower saves map + charger pose + UTM origin

### Coverage/Mowing
- `start_run` → `StartCoverageTask` with `cov_mode=1` (SPECIFIED_AREA) + `polygon_area`
- `cov_direction`: 0-180 degrees for mowing stripe direction
- `blade_heights`: array of levels 0-7 (height = (level+2)*10 mm, so 20-90mm)
- `perception_level`: 0=off, 1=detect, 2=segment, 3=segment-high

### Localization Requirements
- `loc_mapping_confidence: 69` — needs decent GPS for mapping
- `loc_cover_confidence: 40` — lower requirement for mowing (can work with weaker signal)
- `enable_rtk_init_check: True` — checks GPS/RTK at boot
- Movement needed for heading calibration (not a software command)

### The CloudMoveCmd Message
robot_decision subscribes to `novabot_msgs/CloudMoveCmd` — this is how MQTT joystick commands arrive. The `start_move` MQTT command likely publishes to this topic. We should investigate what this message type contains vs the BLE joystick commands to understand why MQTT joystick doesn't work on charger.

---

## 7. All Custom Message Packages

| Package | Messages/Services |
|---------|-------------------|
| `decision_msgs` | StartMap, StartCoverageTask, SaveMap, Charging, GenerateCoveragePath, Common, DeleteMap, Unicom, LoadUtmOriginInfo, SaveUtmOriginInfo, RobotStatus, CovTaskInfo, CovTaskResult, LocRecoverMoving, SlipEscaping |
| `novabot_msgs` | CloudMoveCmd, ChassisIncident, ChassisBatteryMessage, ChassisMotorCurrent |
| `mapping_msgs` | Polygon, Mapping, MappingControl, SetChargingPose, GenerateEmptyMap, Recording |
| `coverage_planner` | CoveragePathsByFile, BoundaryFollow (action), NavigateThroughCoveragePaths (action) |
| `automatic_recharge_msgs` | AutoCharging (action) |
| `nav2_pro_msgs` | FreeMoveAround |
| `localization_msgs` | LoadUtmOriginInfo, SaveUtmOriginInfo |
| `general_msgs` | SaveFile, SetUint8 |

---

## 8. Process Architecture

```
                    ┌──────────────────────┐
                    │     mqtt_node        │
                    │  (MQTT ↔ ROS bridge) │
                    └──────┬───────────────┘
                           │ ROS services/topics
                           ▼
┌──────────────────────────────────────────────────┐
│              robot_decision                       │
│  ┌─────────────────────┐  ┌───────────────────┐  │
│  │   RobotDecision     │  │ DecisionAssistant │  │
│  │  (main state machine│  │  (slip escape,    │  │
│  │   mapping, mowing,  │  │   localization    │  │
│  │   charging)         │  │   recovery)       │  │
│  └──────────┬──────────┘  └───────┬───────────┘  │
│             │                     │               │
└─────────────┼─────────────────────┼───────────────┘
              │ ROS services/actions│
              ▼                     ▼
  ┌──────────────────┐  ┌──────────────────────┐
  │ coverage_planner │  │ novabot_mapping      │
  │ (path planning)  │  │ (map recording/save) │
  └──────────────────┘  └──────────────────────┘
  ┌──────────────────┐  ┌──────────────────────┐
  │ nav2_navigator   │  │ robot_combination_   │
  │ (navigation)     │  │ localization         │
  └──────────────────┘  └──────────────────────┘
  ┌──────────────────┐  ┌──────────────────────┐
  │ chassis_control  │  │ perception_node      │
  │ (motors/sensors) │  │ (camera/AI)          │
  └──────────────────┘  └──────────────────────┘
```
