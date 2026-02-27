# Dashboard API (Local)

Local-only endpoints for the React web dashboard. No authentication required.

---

## Admin Endpoints

### GET `/api/admin/devices`

List all known devices from the device registry.

```json title="Response"
[
  {
    "sn": "LFIC1230700XXX",
    "macAddress": "48:27:E2:1B:A4:0A",
    "lastSeen": "2026-02-26T10:00:00Z",
    "deviceType": "charger"
  }
]
```

---

### POST `/api/admin/devices/:sn/mac`

Manually register a MAC address for a device.

```json title="Request"
{
  "macAddress": "48:27:E2:1B:A4:0A"
}
```

```json title="Response"
{
  "sn": "LFIC1230700XXX",
  "macAddress": "48:27:E2:1B:A4:0A",
  "status": "ok"
}
```

---

## Device Endpoints

### GET `/api/dashboard/devices`

List all devices with their current sensor snapshots.

```json title="Response"
{
  "devices": [
    {
      "sn": "LFIC1230700XXX",
      "macAddress": "48:27:E2:1B:A4:0A",
      "lastSeen": "2026-02-26T10:00:00Z",
      "online": true,
      "deviceType": "charger",
      "nickname": "Base Station",
      "sensors": {
        "charger_status": 285212929,
        "mower_x": 0,
        "mower_y": 0,
        "mower_z": 0,
        "battery_capacity": 100
      }
    }
  ]
}
```

---

### GET `/api/dashboard/devices/:sn`

Get a single device with sensor data.

---

### GET `/api/dashboard/sensors`

Get sensor definitions and translations.

---

## Map Endpoints

### GET `/api/dashboard/maps/:sn`

Get all maps for a device.

```json title="Response"
{
  "maps": [
    {
      "mapId": "uuid",
      "mapName": "Front Garden",
      "mapType": "work",
      "mapArea": [
        [52.1409, 6.2310],
        [52.1412, 6.2310],
        [52.1412, 6.2315],
        [52.1409, 6.2315]
      ],
      "createdAt": "2026-02-21T18:32:12Z"
    }
  ]
}
```

---

### POST `/api/dashboard/maps/:sn`

Create a new map (polygon).

```json title="Request"
{
  "mapName": "Back Garden",
  "mapType": "work",
  "mapArea": [
    [52.1409, 6.2310],
    [52.1412, 6.2310],
    [52.1412, 6.2315],
    [52.1409, 6.2315]
  ]
}
```

Map types: `work` (working area), `obstacle`, `channel` (unicom)

---

### PATCH `/api/dashboard/maps/:sn/:mapId`

Update map name or polygon area.

```json title="Request"
{
  "mapName": "Updated Name",
  "mapArea": [[52.14, 6.23], [52.15, 6.24]]
}
```

---

### DELETE `/api/dashboard/maps/:sn/:mapId`

Delete a map.

---

### POST `/api/dashboard/maps/:sn/request`

Request map list from mower via MQTT (`get_map_list`).

---

### POST `/api/dashboard/maps/:sn/request-outline`

Request map outline from mower via MQTT (`get_map_outline`).

```json title="Request"
{
  "mapId": "map0"
}
```

---

### POST `/api/dashboard/maps/:sn/export-zip`

Export maps as Novabot firmware-format ZIP.

```json title="Request"
{
  "chargingStation": {
    "lat": 52.1409,
    "lng": 6.2310
  },
  "chargingOrientation": 1.326
}
```

```json title="Response"
{
  "ok": true,
  "zipPath": "/path/to/export.zip",
  "downloadUrl": "/api/dashboard/maps/LFIN2230700XXX/download-zip"
}
```

---

### GET `/api/dashboard/maps/:sn/download-zip`

Download the exported ZIP file.

**Response**: Binary ZIP file download

---

### POST `/api/dashboard/maps/:sn/import-zip`

Import a Novabot-format ZIP into the database.

```json title="Request"
{
  "zipPath": "/path/to/import.zip",
  "chargingStation": {
    "lat": 52.1409,
    "lng": 6.2310
  }
}
```

---

### POST `/api/dashboard/maps/convert`

Convert coordinates between GPS and local (meters).

```json title="Request"
{
  "direction": "gps-to-local",
  "origin": { "lat": 52.1409, "lng": 6.2310 },
  "points": [[52.1412, 6.2315]]
}
```

---

## Trail Endpoints

### GET `/api/dashboard/trail/:sn`

Get GPS trail points for a device.

```json title="Response"
{
  "trail": [
    {
      "lat": 52.1409,
      "lng": 6.2310,
      "timestamp": "2026-02-26T10:00:00Z"
    }
  ]
}
```

---

### DELETE `/api/dashboard/trail/:sn`

Clear all trail data for a device.

---

## Calibration Endpoints

### GET `/api/dashboard/calibration/:sn`

Get map calibration settings.

```json title="Response"
{
  "calibration": {
    "offsetLat": 0.0001,
    "offsetLng": -0.0002,
    "rotation": 5.0,
    "scale": 1.02
  }
}
```

---

### PUT `/api/dashboard/calibration/:sn`

Save map calibration settings.

```json title="Request"
{
  "offsetLat": 0.0001,
  "offsetLng": -0.0002,
  "rotation": 5.0,
  "scale": 1.02
}
```

Calibration parameters:

| Field | Range | Description |
|-------|-------|-------------|
| `offsetLat` | any float | Latitude nudge |
| `offsetLng` | any float | Longitude nudge |
| `rotation` | -180° to +180° | Map rotation |
| `scale` | 0.5x to 2.0x | Map scale factor |

---

## Command Endpoint

### POST `/api/dashboard/command/:sn`

Send an arbitrary MQTT command to a device.

```json title="Request"
{
  "command": {
    "start_run": {
      "mapName": "map0",
      "cutGrassHeight": 5
    }
  }
}
```

The `command` object is published directly to `Dart/Send_mqtt/<SN>`.

---

## Schedule Endpoints

### GET `/api/dashboard/schedules/:sn`

Get all dashboard schedules for a mower.

```json title="Response"
{
  "schedules": [
    {
      "scheduleId": "uuid",
      "mowerSn": "LFIN2230700XXX",
      "scheduleName": "Morning Mow",
      "startTime": "08:00",
      "endTime": "12:00",
      "weekdays": [1, 3, 5],
      "enabled": true,
      "mapId": "map0",
      "mapName": "Front Garden",
      "cuttingHeight": 5,
      "pathDirection": 90,
      "workMode": 0,
      "taskMode": 0,
      "createdAt": "2026-02-21T18:32:12Z",
      "updatedAt": "2026-02-21T18:32:12Z"
    }
  ]
}
```

---

### POST `/api/dashboard/schedules/:sn`

Create a new schedule. Also pushes `timer_task` + `set_para_info` via MQTT.

```json title="Request"
{
  "scheduleName": "Morning Mow",
  "startTime": "08:00",
  "endTime": "12:00",
  "weekdays": [1, 3, 5],
  "mapId": "map0",
  "mapName": "Front Garden",
  "cuttingHeight": 5,
  "pathDirection": 90,
  "workMode": 0,
  "taskMode": 0
}
```

---

### PATCH `/api/dashboard/schedules/:sn/:scheduleId`

Update a schedule.

---

### DELETE `/api/dashboard/schedules/:sn/:scheduleId`

Delete a schedule.

---

### POST `/api/dashboard/schedules/:sn/:scheduleId/send`

Push a schedule to the mower via MQTT (`timer_task` + `set_para_info`).

---

## Logs Endpoint

### GET `/api/dashboard/logs`

Get recent MQTT message logs.
