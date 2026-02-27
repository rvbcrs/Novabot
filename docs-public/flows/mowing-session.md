# Flow: Mowing Session

Complete flow from starting a mow to completion.

## Start Mowing (App-Initiated)

```mermaid
sequenceDiagram
    participant App
    participant Broker as MQTT Broker
    participant Charger
    participant Mower
    participant ROS as Mower ROS 2

    App->>Broker: MQTT: {"start_run": {mapName, cutGrassHeight, workArea, startWay: "app"}}
    Broker->>Charger: Forward on Dart/Send_mqtt/LFIC...

    rect rgb(255, 248, 240)
        Note over Charger,Mower: LoRa Relay
        Charger->>Charger: Parse JSON → build LoRa packet
        Charger->>Mower: LoRa [0x35, 0x01, mapName, area, height]
        Note over Charger: Wait max 3s for ACK
        Mower-->>Charger: LoRa ACK
    end

    Charger->>Broker: MQTT: {"type": "start_run_respond", "message": {"result": 0}}
    Broker->>App: Forward response

    rect rgb(240, 255, 240)
        Note over Mower,ROS: ROS 2 Execution
        Mower->>ROS: Service call: /robot_decision/start_cov_task
        ROS->>ROS: coverage_planner generates path
        ROS->>ROS: nav2 follows path
        ROS->>ROS: perception_node detects obstacles
    end

    loop Every ~5 seconds
        rect rgb(240, 248, 255)
            Note over Mower,App: Status Updates (Direct MQTT)
            Mower->>Broker: AES-encrypted report_state_robot
            Broker->>Broker: Decrypt AES-128-CBC
            Broker->>App: {battery_power, work_status, x, y, z, mowing_progress, covering_area}
        end

        rect rgb(255, 240, 255)
            Note over Charger,App: Charger Status (includes mower position via LoRa)
            Charger->>Mower: LoRa heartbeat [0x34, 0x01]
            Mower-->>Charger: LoRa status [0x34, 0x02, ...19 bytes]
            Charger->>Broker: up_status_info {mower_x, mower_y, mower_z, mower_status}
        end
    end
```

## Stop Mowing

```mermaid
sequenceDiagram
    participant App
    participant Charger
    participant Mower
    participant Server

    App->>Charger: MQTT: stop_run
    Charger->>Mower: LoRa [0x35, 0x07]
    Mower->>Mower: ROS: stop_task
    Mower-->>Charger: LoRa ACK
    Charger-->>App: stop_run_respond

    alt User requests: go to charger
        App->>Charger: MQTT: go_to_charge
        Charger->>Mower: LoRa: go_pile [0x35, 0x0B]
        Mower->>Mower: nav_to_recharge
        Mower->>Mower: ArUco QR detection at charger
        Mower->>App: report_state_robot {battery_state: "CHARGING"}
    end

    Mower->>Server: HTTP POST saveCutGrassRecord {workTime, workArea, ...}
    Mower->>Server: HTTP POST uploadEquipmentTrack (mowing path)
```

## Scheduled Mowing

```mermaid
sequenceDiagram
    participant Dashboard
    participant Server
    participant Charger
    participant Mower

    Dashboard->>Server: POST /api/dashboard/schedules/:sn
    Server->>Server: Save schedule to DB

    Server->>Charger: MQTT: timer_task {task_id, start_time, end_time, map_id, ...}
    Server->>Charger: MQTT: set_para_info {cuttingHeight, pathDirection}
    Charger->>Mower: LoRa relay (both commands)

    Note over Mower: At scheduled time...
    Mower->>Mower: Auto-start coverage task
    Mower->>Charger: LoRa: status updates
    Charger->>Server: MQTT: up_status_info {mower working}
```

## Low Battery Return

```mermaid
graph TB
    A[Mowing in progress] --> B{Battery < threshold?}
    B -->|No| A
    B -->|Yes| C[auto_recharge triggered]
    C --> D[nav_to_recharge]
    D --> E[Navigate to charger]
    E --> F[ArUco QR detection]
    F --> G[Dock and charge]
    G --> H{Battery full?}
    H -->|No| G
    H -->|Yes| I{Mowing complete?}
    I -->|Yes| J[Done]
    I -->|No| K[Resume mowing]
    K --> A
```
