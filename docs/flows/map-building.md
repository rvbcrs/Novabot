# Flow: Map Building

## Manual Mapping (Walk the Boundary)

```mermaid
sequenceDiagram
    actor User
    participant App
    participant Charger
    participant Mower
    participant ROS as Mower ROS 2

    User->>App: Select "Build Map"
    App->>Charger: MQTT: start_scan_map
    Charger->>Mower: LoRa relay
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

    ROS-->>Mower: Polygon closed detected!
    App->>Charger: MQTT: stop_scan_map
    Charger->>Mower: LoRa relay
    Mower->>ROS: /robot_decision/map_stop_record

    rect rgb(255, 248, 240)
        Note over App,ROS: Save Map
        App->>Charger: MQTT: save_map {mapName: "home"}
        Charger->>Mower: LoRa relay
        Mower->>ROS: /robot_decision/save_map

        ROS->>ROS: Write CSV files
        ROS->>ROS: Generate map_info.json
        ROS->>ROS: Validate: no overlap

        alt Overlap with other map
            ROS-->>App: save_map_respond {error_code: 1}
        else Overlap with unicom
            ROS-->>App: save_map_respond {error_code: 2}
        else Crosses multiple maps
            ROS-->>App: save_map_respond {error_code: 3}
        else Success
            ROS-->>App: save_map_respond {result: 0}
        end
    end

    rect rgb(240, 248, 255)
        Note over Mower,App: Post-save
        Mower->>ROS: Detect unicom channels between areas
        Mower->>App: report_state_map_outline (final GPS polygon)
        Mower->>App: HTTP: uploadEquipmentMap (ZIP with CSV files)
    end
```

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
    App->>Mower: MQTT: save_map {mapName}
```

## Map File Structure

```mermaid
graph TB
    subgraph "Mower filesystem: /userdata/lfi/maps/home0/csv_file/"
        MI[map_info.json]
        M0W[map0_work.csv]
        M0O[map0_0_obstacle.csv]
        M0U[map0tocharge_unicom.csv]
        M1W[map1_work.csv]
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
        B2[SCP to /userdata/lfi/maps/home0/csv_file/]
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
