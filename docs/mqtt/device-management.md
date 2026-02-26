# Device Management Commands

## Parameters

### get_para_info

Get advanced device settings.

```json title="Command"
{
  "get_para_info": {}
}
```

```json title="Response"
{
  "type": "get_para_info_respond",
  "message": {
    "result": 0,
    "value": {
      "obstacle_avoidance_sensitivity": 3,
      "target_height": 50,
      "defaultCuttingHeight": 5,
      "path_direction": 90,
      "cutGrassHeight": 5
    }
  }
}
```

| Parameter | Description |
|-----------|-------------|
| `obstacle_avoidance_sensitivity` | Obstacle detection sensitivity (1-5) |
| `target_height` | Target mowing height (mm) |
| `defaultCuttingHeight` | Default blade height level (0-7) |
| `path_direction` | Mowing path direction (0-180°) |
| `cutGrassHeight` | Current cutting height setting |

---

### set_para_info

Set advanced device settings.

```json title="Command"
{
  "set_para_info": {
    "obstacle_avoidance_sensitivity": 3,
    "defaultCuttingHeight": 5,
    "path_direction": 90
  }
}
```

```json title="Response"
{
  "type": "set_para_info_respond",
  "message": { "result": 0, "value": null }
}
```

---

## PIN Code

### dev_pin_info

Query or set the device PIN code.

```json title="Command (query)"
{
  "dev_pin_info": {
    "action": "query"
  }
}
```

```json title="Command (set)"
{
  "dev_pin_info": {
    "action": "set",
    "pin_code": "1234"
  }
}
```

```json title="Response"
{
  "type": "dev_pin_info_respond",
  "message": {
    "result": 0,
    "value": {
      "pin_code": "1234"
    }
  }
}
```

### no_set_pin_code

Flag indicating no PIN code has been set.

---

## OTA Firmware Update

### ota_version_info

Query current firmware versions.

```json title="Command"
{
  "ota_version_info": {}
}
```

```json title="Response"
{
  "type": "ota_version_info_respond",
  "message": {
    "result": 0,
    "value": {
      "mower_version": "v5.7.1",
      "charger_version": "v0.3.6",
      "mcu_version": "v3.5.8"
    }
  }
}
```

!!! info "Handled locally by charger"
    `ota_version_info` is handled locally by the charger firmware — it does NOT relay via LoRa.

---

### ota_upgrade_cmd

Start an OTA firmware upgrade.

```json title="Command"
{
  "ota_upgrade_cmd": {
    "url": "https://novabot-oss.oss-accelerate.aliyuncs.com/novabot-file/...",
    "version": "v0.3.7"
  }
}
```

The device publishes `ota_upgrade_state` updates during the upgrade process.

---

### ota_upgrade_state

Unsolicited progress updates during OTA upgrade.

```json title="Status (device → app)"
{
  "type": "ota_upgrade_state",
  "message": {
    "progress": 45,
    "state": "downloading"
  }
}
```

---

## Robot Diagnostics

!!! info "New — discovered in mower firmware"
    These commands are handled directly by the mower's `mqtt_node` (not relayed via charger LoRa).

### get_current_pose

Query the mower's current position directly.

```json title="Command"
{
  "get_current_pose": {}
}
```

```json title="Response"
{
  "type": "get_current_pose_respond",
  "message": {
    "result": 0,
    "value": {
      "x": 1.234,
      "y": -5.678,
      "theta": 1.57
    }
  }
}
```

---

### get_vel_odom

Query velocity and odometry data.

```json title="Command"
{
  "get_vel_odom": {}
}
```

```json title="Response"
{
  "type": "get_vel_odom_respond",
  "message": { "result": 0, "value": null }
}
```

---

### get_log_info

Query device log information.

```json title="Command"
{
  "get_log_info": {}
}
```

```json title="Response"
{
  "type": "get_log_info_respond",
  "message": { "result": 0, "value": null }
}
```

---

### get_version_info

Get firmware version information.

```json title="Command"
{
  "get_version_info": {}
}
```

```json title="Response"
{
  "type": "get_version_info_respond",
  "message": { "result": 0, "value": null }
}
```

---

### get_dev_info

Get device information.

```json title="Command"
{
  "get_dev_info": {}
}
```

```json title="Response"
{
  "type": "get_dev_info_respond",
  "message": { "result": 0, "value": null }
}
```

---

### gbf

Unknown diagnostic command (short name suggests debug/factory command).

```json title="Command"
{
  "gbf": {}
}
```

```json title="Response"
{
  "type": "gbf_respond",
  "message": { "result": 0, "value": null }
}
```

---

### mst

Unknown diagnostic command (short name suggests debug/factory command).

```json title="Command"
{
  "mst": {}
}
```

```json title="Response"
{
  "type": "mst_respond",
  "message": { "result": 0, "value": null }
}
```

---

## Control Mode

### set_control_mode

Switch between control modes (e.g., manual vs autonomous).

```json title="Command"
{
  "set_control_mode": {
    "mode": 0
  }
}
```

```json title="Response"
{
  "type": "set_control_mode_respond",
  "message": { "result": 0, "value": null }
}
```

---

### get_control_mode

Get the current control mode.

```json title="Command"
{
  "get_control_mode": {}
}
```

```json title="Response"
{
  "type": "get_control_mode_respond",
  "message": {
    "result": 0,
    "value": {
      "mode": 0
    }
  }
}
```

---

## System Commands

### reset_factory

Trigger a factory reset on the mower. The mower subscribes to this command.

```json title="Command"
{
  "reset_factory": {}
}
```

!!! warning "Destructive"
    This resets the mower to factory defaults. No explicit response is sent.

---

### reset_utm_origin_info

Reset the UTM GPS origin reference point used by the localization module.

```json title="Command"
{
  "reset_utm_origin_info": {}
}
```

**ROS service**: Uses `SaveUtmOriginInfo.srv` / `LoadUtmOriginInfo.srv` internally.

---

### wifi_ble_active

Activate/reactivate the WiFi and BLE radios.

```json title="Command"
{
  "wifi_ble_active": {}
}
```

---

## WiFi

### get_wifi_rssi

Get WiFi signal strength.

```json title="Command"
{
  "get_wifi_rssi": {}
}
```

```json title="Response"
{
  "type": "get_wifi_rssi_respond",
  "message": {
    "result": 0,
    "value": {
      "rssi": -55
    }
  }
}
```

---

## Timer / Scheduling

### timer_task

Push a timer/scheduled task to the mower.

```json title="Command"
{
  "timer_task": {
    "task_id": "uuid",
    "start_time": "08:00",
    "end_time": "12:00",
    "map_id": 0,
    "map_name": "map0",
    "repeat_type": "weekly",
    "is_timer": true,
    "work_mode": 0,
    "task_mode": 0,
    "cov_direction": 90,
    "path_direction": 90
  }
}
```

!!! info "No explicit response"
    The mower acknowledges timer updates via `report_state_timer_data` which includes the current timer task list.

---

### timer_task_active

Activate a scheduled timer task.

```json title="Command"
{
  "timer_task_active": {
    "task_id": "uuid"
  }
}
```

---

### timer_task_stop

Stop a scheduled timer task.

```json title="Command"
{
  "timer_task_stop": {
    "task_id": "uuid"
  }
}
```

---

## Connection

### auto_connect

Auto-connect command.

```json title="Command"
{
  "auto_connect": {}
}
```

---

### connection_state

Connection state change (unsolicited from device).

```json title="Status (device → app)"
{
  "type": "connection_state",
  "message": {
    "state": "connected"
  }
}
```

---

## LoRa Configuration

### get_lora_info

Get LoRa module configuration. Handled locally by charger (no LoRa relay).

```json title="Command"
{
  "get_lora_info": {}
}
```

```json title="Response"
{
  "type": "get_lora_info_respond",
  "message": {
    "result": 0,
    "value": {
      "addr": 718,
      "channel": 16,
      "hc": 20,
      "lc": 14
    }
  }
}
```

---

## Complete Command Summary

### Parameters & PIN

| Command | Response | Handled by |
|---------|----------|------------|
| `get_para_info` | `get_para_info_respond` | Mower (direct MQTT) |
| `set_para_info` | `set_para_info_respond` | Mower (direct MQTT) |
| `dev_pin_info` | `dev_pin_info_respond` | Mower (direct MQTT) |
| `no_set_pin_code` | — (flag) | Mower |

### OTA Firmware

| Command | Response | Handled by |
|---------|----------|------------|
| `ota_version_info` | `ota_version_info_respond` | **Charger** (local, no LoRa) |
| `ota_upgrade_cmd` | `ota_upgrade_cmd_respond` | **Charger** (local, no LoRa) |

### Timer / Scheduling

| Command | Response | Handled by |
|---------|----------|------------|
| `timer_task` | via `report_state_timer_data` | Mower |
| `timer_task_active` | — | Mower |
| `timer_task_stop` | — | Mower |

### Diagnostics (mower only)

| Command | Response | Description |
|---------|----------|-------------|
| `get_current_pose` | `get_current_pose_respond` | Current position (x, y, theta) |
| `get_vel_odom` | `get_vel_odom_respond` | Velocity/odometry |
| `get_log_info` | `get_log_info_respond` | Device logs |
| `get_version_info` | `get_version_info_respond` | Firmware versions |
| `get_dev_info` | `get_dev_info_respond` | Device info |
| `get_wifi_rssi` | `get_wifi_rssi_respond` | WiFi signal strength |
| `gbf` | `gbf_respond` | Unknown (debug/factory) |
| `mst` | `mst_respond` | Unknown (debug/factory) |

### Control Mode (mower only)

| Command | Response | Description |
|---------|----------|-------------|
| `set_control_mode` | `set_control_mode_respond` | Switch control mode |
| `get_control_mode` | `get_control_mode_respond` | Query control mode |

### System (mower only)

| Command | Response | Description |
|---------|----------|-------------|
| `reset_factory` | — | Factory reset |
| `reset_utm_origin_info` | — | Reset GPS origin |
| `wifi_ble_active` | — | Reactivate radios |

### Connection & LoRa

| Command | Response | Handled by |
|---------|----------|------------|
| `auto_connect` | — | — |
| `get_lora_info` | `get_lora_info_respond` | **Charger** (local, no LoRa) |
