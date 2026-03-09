# Hardware Specifications

Specifications extracted from official LFI/Novabot documentation.

## Operational Parameters

| Parameter | Value |
|-----------|-------|
| Maximum slope | 24 degrees (45%) |
| Optimal slope | < 20 degrees |
| Working temperature | 4–40°C |
| Storage temperature | > -30°C |
| WiFi frequency | 2.4 GHz only (no 5 GHz) |
| Communication (mower ↔ station) | LoRa |
| Positioning | RTK-GPS via GNSS antenna |
| Maximum map size | 1.5 acres (~6,000 m²) |
| Maximum number of maps | 3 (connected via channels) |
| Minimum channel length | 0.5 meters |
| Blade replacement interval | Every 1.5–2 months |
| Minimum schedule duration | 30 minutes |
| OTA update duration | 20–30 minutes |

## Obstacle Detection System

| Component | Purpose |
|-----------|---------|
| 2× ToF cameras (left side) | Distance and obstacle height detection |
| 1× Camera (right side) | Obstacle image capture and object identification |

### Obstacle Sensitivity Levels

| Level | Sensors Used | Description |
|-------|-------------|-------------|
| **Low** | Collision only | ToF and Camera are NOT used. Physical collision triggers detection. |
| **Medium** | ToF + Camera | Detection mode — identifies obstacles before collision |
| **High** | ToF + Camera | Segmentation mode — advanced object recognition |

!!! warning "Low sensitivity"
    In Low mode, humans, animals, and unmapped obstacles will cause physical collisions for detection. Use Medium or High for safety.

## Thermal Management

| Parameter | Value |
|-----------|-------|
| CPU temperature threshold | 96°C (v5.6.x firmware and later) |
| Camera auto-shutdown | At excessive temperatures (latest firmware) |

## WiFi Signal Quality

| RSSI Value | Quality |
|------------|---------|
| > -80 dBm | Good coverage |
| < -80 dBm | Weak — move closer to router |

## Charging Station Placement Requirements

| Requirement | Value |
|-------------|-------|
| Antenna clearance | 120° free of obstacles from top |
| Obstacle angle | Must be below 30° from horizontal |
| Vegetation clearance | ≥ 20 cm from bushes/walls to antenna top |
| Station clearance | ≥ 2 meters from obstacles and sprinklers |
| Security radius | 3.5 meters (optional) |
| Ground angle | ≤ 10° from vertical |
| Power supply height | ≥ 30 cm from ground |
| Remap threshold | > 5 meters relocation |

## Front Wheel Spare Parts

| Part | Specification |
|------|---------------|
| Front wheel bushing | OD 16.7mm × ID 8mm × T 33.5mm |
| Bearing clip spring | 8.0mm × 0.3mm (M8), spring steel |
| Front wheel bearing | Model S608 2RS — OD 22mm × ID 8mm × T 7mm |
