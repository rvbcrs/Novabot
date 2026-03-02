# Autonomous Mapping (`start_assistant_build_map`)

## Overview

The Novabot mower contains an undocumented autonomous mapping feature that is NOT exposed in the official Novabot app (as of v2.4.0). This feature allows the mower to autonomously walk and detect lawn boundaries using AI vision and GPS/RTK — without requiring BLE joystick control.

This was discovered through firmware reverse engineering of `mqtt_node` (novabot_mqtt.cpp) and analysis of the ROS 2 architecture.

## MQTT Command

```json
{"start_assistant_build_map": {}}
```

- Handler: `api_start_assistant_build_map` (novabot_mqtt.cpp:3754)
- Response: `start_assistant_build_map_respond`
- ROS Service: `/robot_decision/start_assistant_mapping` (StartMapping.srv with `task_type: 1`)
- task_type 0 = manual boundary walk (BLE joystick), task_type 1 = autonomous assistant

## How It Works

### Sensor Fusion

The mower uses multiple sensor systems simultaneously:

#### 1. AI Vision (Primary Boundary Detection)

**Camera Hardware:**
- Front RGB camera: Sony IMX307, 1920x1080 @25fps, MIPI CSI-2
- Panoramic camera: wide-angle overview
- PMD Royale ToF depth camera (IRS2875C): 3D point cloud data

**AI Models (running on Horizon X3 BPU accelerator):**
- **Detection model** (`novabot_detv2_11_960_512.bin`, 8.1MB): YOLO-variant
  - 9 object classes: person, animal, obstacle, rock, debris, etc.
- **Segmentation model** (`bisenetv2-seg_2023-11-27_512-960_vanilla.bin`, 3.6MB): BiSeNet-v2
  - 14 scene types including "lawn" (primary target), grass boundaries, bushes, roads, obstacles

**Processing Pipeline:**
1. Resize camera input to 960x512
2. Run detection + segmentation models on BPU
3. Fuse predictions using KDtree noise filtering
4. Apply morphological closing and height filter (0-50cm range)
5. Publish labeled points to `/perception/points_labeled`
6. Nav2 costmap receives points as obstacle layer

#### 2. GPS/RTK (Position Tracking)

- Standard GPS: latitude/longitude from GNGGA sentences
- RTK satellites: centimeter-level precision (typically 29-34 satellites)
- GPS to UTM to local coordinate conversion
- Position tracked relative to charging station origin

#### 3. ArUco Marker Localization

- QR-code pattern on charging station
- Used for fine-grained localization near the station
- Part of `robot_combination_localization` module

#### 4. Wheel Odometry

- Encoder feedback from drive wheels
- Fused with GPS and vision for continuous position estimation

### Navigation Stack

The autonomous mapping uses the standard Nav2 stack:
- Path planner: `nav2_navfn_planner` / `nav2_smac_planner`
- Controller: Pure Pursuit path following
- Costmap: receives obstacle data from perception node
- Obstacle height filter: 0.35-0.50m threshold

### Perception Modes

The perception node supports three modes:
- Mode 1: Segmentation only
- Mode 2: Detection only
- Mode 3: Detection + Segmentation fusion (used during mapping)

## Expected Workflow

1. Send `start_assistant_build_map: {}` via MQTT
2. Mower transitions to mapping mode, drives off charging station
3. Perception node activates obstacle detection + segmentation
4. AI camera detects lawn boundaries (grass vs. non-grass transitions)
5. Nav2 plans path following detected boundaries
6. GPS/RTK records boundary coordinates as the mower drives
7. Mower completes a full circuit of the lawn
8. Send `save_map` via MQTT to finalize the map
9. Send `save_recharge_pos` to store charging station position
10. Send `auto_recharge` to return mower to station

## Related MQTT Commands

| Command | Purpose |
|---------|---------|
| `start_assistant_build_map: {}` | Start autonomous mapping |
| `start_scan_map: {}` | Start manual mapping (BLE joystick mode) |
| `add_scan_map: {}` | Add scan point during manual mapping |
| `stop_scan_map: {}` | Stop mapping session |
| `save_map: {}` | Finalize and save the map |
| `save_recharge_pos: {}` | Save charging station position |
| `quit_mapping_mode: {}` | Exit mapping mode without saving |
| `start_erase_map: {}` | Start erasing/editing existing map |
| `stop_erase_map: {}` | Stop erasing mode |

## Monitoring During Mapping

Key sensor fields to watch in `report_state_timer_data`:

```json
{
  "localization": {
    "localization_state": "INITIALIZED",  // Must change from NOT_INITIALIZED
    "gps_position": {
      "latitude": 52.xxx,
      "longitude": 6.xxx,
      "altitude": 9.xxx,
      "state": "ENABLE"                   // Must be ENABLE for mapping
    },
    "map_position": {
      "x": 0.5,                           // Local meters from charger
      "y": 1.2,
      "orientation": 45.0
    }
  },
  "start_edit_or_assistant_map_flag": 1    // Should become 1 during mapping
}
```

Key fields in `report_state_robot`:
```json
{
  "perception_level": 3,      // AI detection confidence (0=off, higher=active)
  "loc_quality": 95,          // Localization quality percentage
  "work_status": 1,           // Should change from 0 (WAIT) to active
  "msg": "Mode:MAPPING ..."   // Should indicate MAPPING mode
}
```

## Requirements

- **GPS/RTK signal**: Will not work indoors or under dense tree canopy
- **Adequate lighting**: AI vision models need visible camera feed
- **Clean camera lens**: Dirty lens detection triggers warnings (entropy + ML check)
- **Battery**: Sufficient charge to complete the mapping walk
- **Open area**: Mower needs space to drive and detect boundaries

## Known Limitations

- Not exposed in the official Novabot app (v2.3.8/v2.4.0)
- No live camera feed available (AI inference only, no video streaming built-in)
- GPS state may show "DISABLE" initially — localization needs to initialize
- `localization_state: "NOT_INITIALIZED"` may prevent mapping from starting
- Quality depends on AI model accuracy for boundary detection

## Firmware Locations

| Component | Path |
|-----------|------|
| AI detection model | `perception_node/share/perception_node/perception_conf/novabot_detv2_11_960_512.bin` |
| AI segmentation model | `perception_node/share/perception_node/perception_conf/bisenetv2-seg_2023-11-27_512-960_vanilla.bin` |
| Perception config | `perception_node/share/perception_node/perception_conf/` |
| MQTT bridge | `novabot_api/lib/novabot_api/mqtt_node` |
| Nav2 stack | `nav2_*/` (multiple packages) |
| Localization | `robot_combination_localization` package |

## Discovery Notes

- Found via `strings mqtt_node | grep api_` — listed all MQTT command handlers
- `api_start_assistant_build_map` at novabot_mqtt.cpp:3754
- `start_assistant_build_map_respond` confirms bidirectional communication
- `start_edit_or_assistant_map_flag` in timer data confirms mapping state tracking
- `CloudMoveCmd` ROS message type used for cloud-initiated movement
- `cloud_move_pub` / `cloud_move_deblock_pub` are ROS publishers for cloud commands
