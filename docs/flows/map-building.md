# Flow: Map Building

## Manual Mapping (Walk the Boundary)

!!! info "BLE-direct, not via charger MQTT"
    Mapping commands flow App <-> Mower over BLE (GATT). The charger is NOT in the loop for mapping. The mower may also report status over MQTT in parallel, but the mapping control plane is BLE.

```mermaid
sequenceDiagram
    actor User
    participant App
    participant Mower as Mower (BLE)
    participant ROS as Mower ROS 2

    User->>App: Select "Build Map"
    App->>Mower: BLE: start_scan_map {type: 0, mapName: "map0"}
    Note over App,Mower: First work area uses start_scan_map.<br/>Subsequent areas use add_scan_map (also type: 0, integer not null).
    Mower->>ROS: /robot_decision/start_mapping

    rect rgb(240, 255, 240)
        Note over User,ROS: User walks boundary (stay within 2m of mower)
        loop Walking perimeter
            Mower->>ROS: Record GPS + local coordinates
            ROS->>ROS: /novabot_mapping/map_position (real-time)
            Mower->>App: report_state_map_outline (partial boundary)

            Note over ROS: /novabot_mapping/if_closed_cycle<br/>monitors if polygon is closing
        end
    end

    ROS-->>Mower: Polygon closed detected
    App->>Mower: BLE: stop_scan_map {value: false}
    Mower->>ROS: /robot_decision/map_stop_record
    Mower-->>App: stop_scan_map_respond

    rect rgb(255, 248, 240)
        Note over App,ROS: Save Map - fires TWICE per session
        App->>Mower: BLE: save_map {mapName: "map0", type: 0}
        Note over App,Mower: type:0 = "sub map", writes csv_file/ + x3_csv_file/
        Mower->>ROS: /robot_decision/save_map
        Mower-->>App: save_map_respond (sub)

        App->>Mower: BLE: save_recharge_pos {...}
        Mower-->>App: save_recharge_pos_respond

        Note over App: Wait 500ms (Future.delayed in Flutter)
        App->>Mower: BLE: save_map {mapName: "map0", type: 1}
        Note over App,Mower: type:1 = "total map", generates home0/map.pgm/png/yaml.<br/>Without this, start_navigation returns Error 107.
        Mower->>ROS: /robot_decision/save_map
        Mower-->>App: save_map_respond (total)

        alt Overlap with other map
            Mower-->>App: save_map_respond {error_code: 1}
        else Overlap with unicom
            Mower-->>App: save_map_respond {error_code: 2}
        else Crosses multiple maps
            Mower-->>App: save_map_respond {error_code: 3}
        else Success
            Mower-->>App: save_map_respond {result: 0}
        end
    end

    rect rgb(240, 248, 255)
        Note over Mower,App: Post-save
        Mower->>ROS: Detect unicom channels between areas
        Mower->>App: report_state_map_outline (final GPS polygon)
        Mower->>App: HTTP: uploadEquipmentMap (ZIP with CSV files)
    end
```

### Obstacle Flow

Obstacles use a separate BLE flow within the same mapping session:

- `add_scan_map` with `type: 1` (NOT type:2) and `mapName` set to the literal string `"map"` (NOT the active map name).
- Firmware derives the parent work map from the active context and auto-indexes obstacle CSVs: `map0_0_obstacle.csv`, `map0_1_obstacle.csv`, and so on.
- Stop with `stop_scan_map {value: false}`.
- Save sequence mirrors work maps: `save_map type:0` (sub) -> 3s delay -> `save_map type:1` (total).
- See `CLAUDE.md` "BLE Mapping - OBSTACLE flow" for the full live capture.

### Channel Flow (map to map)

A channel between two work areas is recorded by driving from one into the other:

- `start_assistant_build_map {type: 0}` (manual session on the existing maps), then `add_scan_map {mapName: <start zone>, type: 2}`. `type: 4` is edit mode, not a channel.
- Stop with `stop_scan_map {value: true}`, then a single `save_map type:1` (no sub-map save).
- The firmware names the file `map{A}tomap{B}_{N}_unicom.csv` from the zones the path crosses.
- Zones that touch or overlap are already connected and need no channel. The firmware keeps only the channel points outside every work area in `csv_file`, so a channel between touching zones comes out empty.
- `add_scan_map_respond` answers `result: 1` for any `/robot_decision/add_area` failure. A channel between zones that touched failed this way in the field; across a 0.95 m gap it recorded fine. The app warns before recording a channel between zones less than about 1 m apart.

## Automatic Mapping

```mermaid
sequenceDiagram
    participant App
    participant Mower

    App->>Mower: MQTT: start_assistant_build_map
    Mower->>Mower: ROS: start_assistant_mapping
    Note over Mower: Mower autonomously maps the area<br/>using GPS + camera + AI

    loop Autonomous exploration
        Mower->>App: report_state_map_outline (growing boundary)
    end

    Mower->>Mower: Boundary complete
    App->>Mower: BLE: save_map {mapName, type: 0}  (sub map)
    Note over App,Mower: 500ms later, fire save_map again with type: 1 (total map).<br/>Without the type:1 fire, home0/map.yaml is not created and<br/>start_navigation returns Error 107.
    App->>Mower: BLE: save_map {mapName, type: 1}  (total map)
```

## Map File Structure

```mermaid
graph TB
    subgraph "Mower filesystem: /userdata/lfi/maps/home0/"
        subgraph "csv_file/  AND  x3_csv_file/  (always loose CSVs in BOTH, never zip)"
            MI[map_info.json]
            M0W[map0_work.csv]
            M0O[map0_0_obstacle.csv]
            M0U[map0tocharge_unicom.csv]
            M1W[map1_work.csv]
        end
        MY[map.yaml / map.pgm / map.png  (created only by save_map type:1)]
    end

    subgraph "map_info.json"
        CP[charging_pose:<br/>orientation: 1.326<br/>x: -0.048, y: -0.180]
        S0[map0_work.csv: map_size: 149.28]
        S1[map1_work.csv: map_size: 26.62]
    end

    MI --> CP
    MI --> S0
    MI --> S1
```

## Map Types

| Type | File Pattern | Description | Limits |
|------|-------------|-------------|--------|
| Work area | `map{N}_work.csv` | Lawn to be mowed | Max 3 |
| Obstacle | `map{N}_{M}_obstacle.csv` | Areas to avoid | Min 1m from boundary |
| Channel | `map{N}to{target}_unicom.csv` | Narrow passages | Min 1m wide, max 10m straight |

## Three Map Sync Options

```mermaid
graph TB
    subgraph "Option 1: SPECIFIED_AREA (no physical mapping needed)"
        A1[Dashboard: Draw polygon on satellite photo]
        A2[start_run with polygon_area + cov_mode=1]
        A3[Mower mows within GPS polygon]
        A1 --> A2 --> A3
    end

    subgraph "Option 2: Direct CSV Upload (requires SSH)"
        B1[Dashboard: Export ZIP via mapConverter.ts]
        B2[SCP loose CSVs to BOTH csv_file/ AND x3_csv_file/<br/>under /userdata/lfi/maps/home0/]
        B3[Maps persisted on mower]
        B1 --> B2 --> B3
    end

    subgraph "Option 3: Physical Mapping"
        C1[Walk boundary with mower]
        C2[save_map via MQTT]
        C3[Mower writes CSV + uploads ZIP to server]
        C1 --> C2 --> C3
    end

    style A1 fill:#9f9,stroke:#333
    style B1 fill:#ff9,stroke:#333
    style C1 fill:#f99,stroke:#333
```
