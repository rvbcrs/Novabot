# Mapping Commands

Commands for building, editing, and managing mower maps.

## Map Building

### start_scan_map

Start manual boundary scanning. User walks the mower around the perimeter.

**ROS service**: `/robot_decision/start_mapping`

```json title="Command"
{
  "start_scan_map": {}
}
```

```json title="Response"
{
  "type": "start_scan_map_respond",
  "message": { "result": 0, "value": null }
}
```

---

### stop_scan_map

Stop boundary scanning.

**ROS service**: `/robot_decision/map_stop_record`

```json title="Command"
{
  "stop_scan_map": {}
}
```

---

### add_scan_map

Add a scan data point during mapping.

```json title="Command"
{
  "add_scan_map": {}
}
```

---

### start_assistant_build_map

Start automatic map building. The mower autonomously maps the area.

**ROS service**: `/robot_decision/start_assistant_mapping`

```json title="Command"
{
  "start_assistant_build_map": {}
}
```

---

### quit_mapping_mode

Exit mapping mode entirely.

**ROS service**: `/robot_decision/quit_mapping_mode`

```json title="Command"
{
  "quit_mapping_mode": {}
}
```

```json title="Response"
{
  "type": "quit_mapping_mode_respond",
  "message": { "result": 0, "value": null }
}
```

!!! note "Response confirmed"
    Firmware analysis confirms `quit_mapping_mode_respond` exists in the mower's `mqtt_node`.

---

### get_mapping_path2d

Get the 2D mapping path during an active mapping session.

!!! info "New — discovered in mower firmware"
    Useful for visualizing the boundary being recorded in real-time.

```json title="Command"
{
  "get_mapping_path2d": {}
}
```

```json title="Response"
{
  "type": "get_mapping_path2d_respond",
  "message": { "result": 0, "value": null }
}
```

---

## Map Erasure

### start_erase_map

Start erasing part of a map area.

**ROS service**: `/robot_decision/start_erase`

```json title="Command"
{
  "start_erase_map": {}
}
```

---

### stop_erase_map

Stop map erasing.

```json title="Command"
{
  "stop_erase_map": {}
}
```

---

## Map Storage

### save_map

Finalize and save the currently built map.

!!! warning "Does NOT accept coordinates"
    `save_map` only finalizes the mower's internal mapping session. It does NOT accept external coordinate data. The mower generates CSV files from its own recorded path.

**ROS service**: `/robot_decision/save_map` → `SaveMap.srv`

```json title="Command"
{
  "save_map": {
    "mapName": "home"
  }
}
```

```json title="Response"
{
  "type": "save_map_respond",
  "message": { "result": 0, "value": null }
}
```

**SaveMap.srv definition:**

```
string mapname       # Map name
float32 resolution   # Grid resolution (meters, typically 0.02-0.05)
int64 type           # Map type: 0=work, 1=obstacle, 2=unicom
---
string data
uint8 result
uint8 error_code     # 1=OVERLAPING_OTHER_MAP
                     # 2=OVERLAPING_OTHER_UNICOM
                     # 3=CROSS_MULTI_MAPS
```

---

### delete_map

Delete a map.

**ROS service**: `/robot_decision/delete_map` → `DeleteMap.srv`

```json title="Command"
{
  "delete_map": {
    "map_name": "map0",
    "map_type": 0
  }
}
```

| map_type | Description |
|----------|-------------|
| 0 | Work area |
| 1 | Obstacle area |
| 2 | Unicom (channel) |

---

### reset_map

Reset the current mapping session.

**ROS service**: `/robot_decision/reset_mapping`

```json title="Command"
{
  "reset_map": {}
}
```

---

### rename_map

Rename an existing map.

!!! info "New — discovered in mower firmware"

```json title="Command"
{
  "rename_map": {
    "map_name": "map0",
    "new_name": "front_lawn"
  }
}
```

```json title="Response"
{
  "type": "rename_map_respond",
  "message": { "result": 0, "value": null }
}
```

---

## Map Queries

### get_map_info

Get detailed information about a specific map.

```json title="Command"
{
  "get_map_info": {
    "map_id": 0
  }
}
```

```json title="Response"
{
  "type": "get_map_info_respond",
  "message": { "result": 0, "value": null }
}
```

---

### get_map_list

Get a list of all maps on the mower.

```json title="Command"
{
  "get_map_list": {}
}
```

```json title="Response"
{
  "type": "get_map_list_respond",
  "message": {
    "result": 0,
    "value": {
      "map_ids": [0, 1],
      "map_names": ["map0_work", "map1_work"]
    }
  }
}
```

---

### get_map_outline

Request map boundary coordinates. Response comes as a status report.

```json title="Command"
{
  "get_map_outline": {
    "map_id": 0
  }
}
```

The mower responds with `report_state_map_outline` containing GPS polygon coordinates.

---

### get_map_plan_path

Get the planned mowing path for a map.

```json title="Command"
{
  "get_map_plan_path": {
    "map_id": 0
  }
}
```

---

### get_preview_cover_path / generate_preview_cover_path

Get or generate a coverage path preview.

**ROS service**: `/robot_decision/generate_preview_cover_path` → `GenerateCoveragePath.srv`

```json title="Command"
{
  "generate_preview_cover_path": {
    "map_ids": 0,
    "cov_direction": 90
  }
}
```

```
# GenerateCoveragePath.srv
uint32 map_ids
bool specify_direction
uint8 cov_direction     # 0-180°
---
bool result
```

---

### request_map_ids

Request available map IDs from the mower.

```json title="Command"
{
  "request_map_ids": {}
}
```

---

## Area Definition

### area_set

Define a working area via GPS bounding box. This sends GPS coordinates to the mower.

```json title="Command"
{
  "area_set": {
    "latitude1": 52.1409,
    "longitude1": 6.2310,
    "latitude2": 52.1412,
    "longitude2": 6.2315,
    "map_name": "map0"
  }
}
```

**ROS service**: `/robot_decision/add_area`

---

### update_virtual_wall

Update obstacle barriers for a map.

```json title="Command"
{
  "update_virtual_wall": {
    "virtual_wall": [],
    "map_name": "map0"
  }
}
```

---

## Map Building Flow

```mermaid
sequenceDiagram
    participant App
    participant Mower
    participant Server

    Note over App,Mower: Manual Mapping
    App->>Mower: MQTT: start_scan_map
    Mower->>Mower: ROS: start_mapping

    loop User walks boundary
        Mower->>App: report_state_map_outline (partial)
        Note over Mower: /novabot_mapping/if_closed_cycle<br/>detects polygon closure
    end

    App->>Mower: MQTT: stop_scan_map
    App->>Mower: MQTT: save_map {mapName: "home"}
    Mower->>Mower: Write CSV files to<br/>/userdata/lfi/maps/home0/csv_file/
    Mower->>Mower: Validate: no overlap

    alt Overlap detected
        Mower-->>App: save_map_respond {error_code: 1}
    else Success
        Mower-->>App: save_map_respond {result: 0}
        Mower->>Mower: Detect unicom channels<br/>between work areas
        Mower->>Server: HTTP: uploadEquipmentMap (ZIP)
        Mower->>App: report_state_map_outline (final GPS polygon)
    end
```

---

## Map File Format

Maps are stored on the mower at `/userdata/lfi/maps/home0/csv_file/`:

```
csv_file/
├── map_info.json              # Charging pose + area sizes
├── map0_work.csv              # Work area 0 (x,y meters)
├── map0_0_obstacle.csv        # Obstacle 0 in work area 0
├── map0tocharge_unicom.csv    # Channel from area 0 to charger
├── map1_work.csv              # Work area 1
└── map_0_unicom.csv           # Channel type 2
```

CSV format: comma-separated local x,y coordinates (meters, relative to charger):

```csv
-0.0306977,-0.918932
-0.0388416,-0.868202
-9.62,-8.29
```

See [Architecture → Overview](../architecture/overview.md) for coordinate system details.
