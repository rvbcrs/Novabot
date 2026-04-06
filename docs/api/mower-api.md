# Mower → Server API

These endpoints are called by the **mower firmware** (`mqtt_node` via libcurl).
The mower reads the server URL from `/userdata/lfi/http_address.txt`.

!!! warning "No authentication"
    The mower does NOT send JWT tokens. These endpoints must work without auth.

---

## uploadEquipmentMap

### POST `/api/nova-file-server/map/uploadEquipmentMap`

Mower uploads its map ZIP after a mapping session completes.

**Content-Type**: `multipart/form-data` (via `curl_formadd`)

| Field | Type | Description |
|-------|------|-------------|
| `local_file` | binary | ZIP file containing CSV maps |
| `local_file_name` | string | Filename of the ZIP |
| `zipMd5` | string | MD5 checksum of the ZIP |
| `sn` | string | Mower serial number |
| `jsonBody` | string | Extra metadata (JSON) |

**Trigger**: After `save_map` MQTT command completes, the mower generates a ZIP from `/userdata/lfi/maps/home0/csv_file/` and uploads it.

```mermaid
sequenceDiagram
    participant App
    participant Server
    participant Mower

    App->>Server: MQTT: save_map
    Server->>Mower: MQTT forward
    Mower->>Mower: Build ZIP from CSV files
    Mower->>Server: POST uploadEquipmentMap (multipart)
    Server->>Server: Parse ZIP, store maps in DB
    Server-->>Mower: {"success":true,"code":200}
```

---

## uploadEquipmentTrack

### POST `/api/nova-file-server/map/uploadEquipmentTrack`

Mower uploads the planned mowing path.

**Content-Type**: `multipart/form-data`

| Field | Type | Description |
|-------|------|-------------|
| `local_file` | binary | Path data file |
| `local_file_name` | string | Filename |
| `sn` | string | Mower serial number |

**Source**: `/userdata/lfi/maps/home0/planned_path/`

---

## queryPlanFromMachine

### POST `/api/nova-data/cutGrassPlan/queryPlanFromMachine`

Mower fetches mowing schedules from the server.

```json title="Request"
{
  "sn": "LFIN2230700XXX"
}
```

```json title="Response → value"
[
  {
    "planId": "uuid",
    "equipmentId": "uuid",
    "startTime": "08:00",
    "endTime": "12:00",
    "weekday": [1, 3, 5]
  }
]
```

---

## saveCutGrassRecord

### POST `/api/nova-data/equipmentState/saveCutGrassRecord`

Mower saves mowing session results.

```json title="Request"
{
  "sn": "LFIN2230700XXX",
  "dateTime": "2026-02-26T10:00:00Z",
  "workTime": 3600,
  "workArea": 150.5,
  "cutGrassHeight": 5,
  "mapNames": ["map0"],
  "startWay": "app",
  "workStatus": "completed",
  "scheduleId": "uuid",
  "week": 3
}
```

---

## saveCutGrassMessage

### POST `/api/novabot-message/machineMessage/saveCutGrassMessage`

Mower saves a notification message (e.g., "mowing complete", "error occurred").

```json title="Request"
{
  "sn": "LFIN2230700XXX"
}
```

---

## machineReset

### POST `/api/nova-user/equipment/machineReset`

Device unbind/factory reset request.

```json title="Request"
{
  "sn": "LFIN2230700XXX"
}
```

---

## connection

### POST `/api/nova-network/network/connection`

Connectivity check (called periodically by mower).

```json title="Response"
{
  "success": true,
  "code": 200,
  "message": "request success",
  "value": 1
}
```

---

## Log Upload

### POST `/x3/log/upload`

Mower uploads debug/system logs.

**Content-Type**: Raw binary (up to 50MB)

```json title="Response"
{
  "code": 200,
  "msg": "ok"
}
```

---

## Implementation Status

| Endpoint | Status | Notes |
|----------|--------|-------|
| `uploadEquipmentMap` | ✅ Implemented | Accepts multipart, parses ZIP |
| `uploadEquipmentTrack` | ✅ Implemented | Stores path data |
| `queryPlanFromMachine` | ✅ Implemented | Returns schedules |
| `saveCutGrassRecord` | ✅ Implemented | Stores work records |
| `saveCutGrassMessage` | ✅ Implemented | Stores messages |
| `machineReset` | ✅ Implemented | Unbinds device |
| `connection` | ✅ Implemented | Returns success |
| `/x3/log/upload` | ✅ Implemented | Accepts raw binary |
