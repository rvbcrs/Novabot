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

Send an arbitrary MQTT command to a device. The `command` object is encrypted
(AES-128-CBC, key = `"abcdabcd1234" + SN[-4:]`) when the SN starts with `LFI`
and then published to `Dart/Send_mqtt/<SN>`. Stock firmware v6+ expects this
encryption; for stock v5.x mowers add `"encrypt": false` at the top level of
the request body to disable it.

The five mowing actions below are taken straight from `mowingService.ts` and
match exactly what the OpenNova app and the dashboard send.

#### Start mowing (full coverage on map0)

```bash
curl -X POST http://<server>/api/dashboard/command/<SN> \
  -H 'Content-Type: application/json' \
  -d '{"command":{"start_navigation":{"mapName":"test","cutterhigh":3,"area":1,"cmd_num":12345}}}'
```

| Field | Notes |
|-------|-------|
| `mapName` | Required, literal string `"test"` (firmware ignores the value but rejects when missing). |
| `cutterhigh` | Wire enum, range `0..7`. Formula: `user_cm − 2`. So 5 cm → `3`, 6 cm → `4`. |
| `area` | Decimal positional bitmask: `1` = map0, `10` = map1, `100` = map2; sum for multi-map (`11` = map0+map1, `111` = all three). The firmware mows every selected map in one task, no dock between zones. |
| `cmd_num` | Must be unique per call — the firmware ignores duplicates. Use `$(date +%s)` or `$RANDOM`. |

#### Stop

```bash
curl -X POST http://<server>/api/dashboard/command/<SN> \
  -H 'Content-Type: application/json' \
  -d '{"command":{"stop_navigation":{"cmd_num":12346}}}'
```

The key is `stop_navigation`, **not** `stop_task` or `stop_run`.

#### Pause

```bash
curl -X POST http://<server>/api/dashboard/command/<SN> \
  -H 'Content-Type: application/json' \
  -d '{"command":{"pause_navigation":{"cmd_num":12347}}}'
```

#### Resume

```bash
curl -X POST http://<server>/api/dashboard/command/<SN> \
  -H 'Content-Type: application/json' \
  -d '{"command":{"resume_navigation":{"cmd_num":12348}}}'
```

The keys are `pause_navigation` / `resume_navigation`, **not** `pause_run` /
`resume_run` (those exist as legacy LoRa commands but the navigation stack
uses the `*_navigation` variants).

#### Go home (back to charger)

This is a two-step sequence with a 500 ms gap — the app does the same:

```bash
curl -X POST http://<server>/api/dashboard/command/<SN> \
  -H 'Content-Type: application/json' \
  -d '{"command":{"go_pile":{}}}'

sleep 0.5

curl -X POST http://<server>/api/dashboard/command/<SN> \
  -H 'Content-Type: application/json' \
  -d '{"command":{"go_to_charge":{"cmd_num":12349,"chargerpile":{"latitude":200,"longitude":200}}}}'
```

The `chargerpile:{latitude:200, longitude:200}` is required — those are
sentinel values; the mower computes the actual dock pose from its own
saved map state.

#### Disabling encryption (stock v5.x firmware only)

```bash
curl -X POST http://<server>/api/dashboard/command/<SN> \
  -H 'Content-Type: application/json' \
  -d '{"encrypt":false,"command":{"start_navigation":{"mapName":"test","cutterhigh":3,"area":1,"cmd_num":12345}}}'
```

---

## Schedule Endpoints

### GET `/api/dashboard/schedules/:sn`

Get all dashboard schedules for a mower. The list holds mowing schedules only
(`kind: "mow"`); add `?kind=patrol` to list the night patrol schedules instead.

```json title="Response"
{
  "schedules": [
    {
      "scheduleId": "uuid",
      "kind": "mow",
      "mowerSn": "LFIN2230700XXX",
      "scheduleName": "Morning Mow",
      "startTime": "08:00",
      "endTime": "12:00",
      "intervalMin": 0,
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

Add `"kind": "patrol"` to create a night patrol schedule instead of a mowing
schedule (default `"mow"`). The mower must run custom firmware, otherwise the
answer is 409. A patrol schedule follows its own rules:

- The server runs it by itself. It is never sent to the mower as `timer_task`
  (the firmware would mow), and it is not mirrored into the stock app's plans.
- `"enabled": false` is honored, so a time can be stored with the schedule
  switched off.
- It never gets a rain pause.
- The night guard ("No mowing after dark") does not apply to it, the frost
  guard does.
- It is a window with an interval. `startTime` is the first round, `endTime`
  the end of the window and `intervalMin` the minutes between two rounds (`0`,
  or 15 to 240). With an interval, the server starts a round at `startTime`
  and then every `intervalMin` minutes while the round's start lies before
  `endTime` (an `endTime` at or before `startTime` means the next morning).
  `intervalMin: 0` is once, whatever `endTime` holds: a single round at
  `startTime`; an interval without an `endTime` is a 400. So is an interval
  outside 0 and 15 to 240, or an `endTime` that is not `HH:MM`. PATCH takes
  the same fields (`"endTime": null` clears the end), and every schedule in
  the list carries `intervalMin` (always `0` for a mowing schedule).
- A later round of the night is skipped, and the schedule says why, when the
  previous round is still out, the mower is not charging on the dock, or its
  battery is under 50 %. After a round that failed, was stopped, or did not
  dock, the night stops until the next window.

```json title="Request (night patrol schedule)"
{
  "kind": "patrol",
  "startTime": "23:00",
  "endTime": "06:00",
  "intervalMin": 30,
  "weekdays": [0, 1, 2, 3, 4, 5, 6],
  "enabled": true,
  "timezone": "Europe/Amsterdam"
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

A patrol schedule (`kind: "patrol"`) runs on the server and never goes to the
mower, so for it this endpoint answers 409.

---

## Night Patrol Endpoints

Night patrol is an OpenNova feature: the extended command `patrol`, which needs
custom firmware build 50 or newer. The stock MQTT `start_patrol` / `stop_patrol`
are stubs in `mqtt_node` (they only answer) and have nothing to do with it.
What it does and how it looks in the dashboard: [Night patrol](../user-guide/dashboard.md#night-patrol).

### POST `/api/dashboard/patrol/:sn`

Start a patrol.

```json title="Response (started)"
{ "ok": true, "run": "1760471400000" }
```

A refusal answers 409 with the reason in `error`, in the language of the request:
the mower is offline, runs stock firmware or a custom build older than 50, is
busy with a task, an edge cut or a map operation, has a map frame that is not
validated, has a battery below 50%, or there is no checkpoint to visit.

```json title="Response (refused)"
{ "ok": false, "error": "..." }
```

---

### POST `/api/dashboard/stop-patrol/:sn`

Stop a patrol. Sends `stop_navigation` plus `stop_mow_zone`; the mower stays where
it is and is not sent home.

```json title="Response"
{ "ok": true }
```

While a patrol drives (phases `starting`, `localizing`, `patrolling` and
`returning`), every stop, pause, go-home or start command also ends it, whether it
comes from the dashboard, the OpenNova app, the stock app or the server.

---

### GET `/api/dashboard/patrol/:sn/runs`

The last 30 patrols, newest first, with one entry per checkpoint. `seen` says what
the camera found: `null` means no data (fewer than two detection readings), `[]` means
nothing, otherwise the classes (`"person"`, `"animal"`) whose score reached
`patrol_min_points`.

```json title="Response"
{
  "ok": true,
  "runs": [
    {
      "run": "1760471400000",
      "startedAt": 1760471400000,
      "frames": [
        { "seq": 1, "x": 12.345, "y": -3.21, "person": 0, "animal": 0, "frames": 14, "image": true, "ts": 1760471452000, "seen": [] },
        { "seq": 2, "x": 14.1, "y": -1.5, "person": 57, "animal": 0, "frames": 12, "image": true, "ts": 1760471480000, "seen": ["person"] },
        { "seq": 3, "x": 15.0, "y": 0.2, "person": 0, "animal": 0, "frames": 0, "image": false, "ts": 1760471510000, "seen": null }
      ]
    }
  ]
}
```

`x` and `y` are local map metres. `image` tells whether the checkpoint has a photo.

---

### GET `/api/dashboard/patrol/:sn/runs/:run/:seq.jpg`

The photo of one checkpoint (`image/jpeg`). 404 when the checkpoint has no photo.
The server keeps the last 30 runs per mower under `STORAGE_PATH/patrol/<SN>/<run>/`.

---

### POST `/api/nova-file-server/patrol/uploadFrame`

Called by the mower, once per checkpoint. It is not a dashboard endpoint and it is
not behind the login, so the run token below is what protects it.

Query parameters:

| Field | Description |
|-------|-------------|
| `sn` | Mower serial number |
| `run` | Run id from `POST /api/dashboard/patrol/:sn` |
| `token` | The 32-hex token of that run |
| `seq` | Checkpoint number (1 to 200) |
| `x`, `y` | Mower position, local map metres |
| `frames` | Detection readings counted at the checkpoint |
| `person`, `animal` | Detection score per class |

Body: the raw JPEG (up to 3 MB), or empty when the camera gave nothing. The body is
only read as a photo when the request has `Content-Type: application/octet-stream`;
with any other type the checkpoint is stored without a photo.

The server issues a random 32-hex token for every run it starts and sends it to the
mower in the `patrol` command; the mower repeats it in every upload. The server only
accepts uploads for the run it started, with the right token, within 6 hours of the
start. Anything else answers 403: nothing is stored and no alert is raised.
Malformed parameters, or an `application/octet-stream` body that is not a JPEG,
answer 400.

An alert needs both a score at or above `patrol_min_points` and at least 2 detection
readings (`frames`). It raises the `patrol_detection` notification (see
[Notifications & Push](../guide/notifications.md)), at most once per class per run per
2 minutes. A checkpoint that could not be stored answers 500; the alert is still raised.

---

### Patrol settings and status

The settings are device settings, written with `POST /api/dashboard/sensor-override/:sn`
and read with `GET /api/dashboard/device-settings/:sn`.

| Key | Range | Default | Description |
|-----|-------|---------|-------------|
| `patrol_zones` | JSON array of `mapN` | `[]` | Zones to patrol; empty means the dock's zone |
| `patrol_spacing_m` | 3 to 15 | 6 | Metres between checkpoints along the border |
| `patrol_dwell_s` | 3 to 20 | 6 | Seconds spent looking at each checkpoint |
| `patrol_headlight` | 0 to 100 | 100 | Headlight level during the patrol |
| `patrol_min_points` | 5 to 2000 | 40 | Score at which a person or animal counts as seen |
| `patrol_photo_topic` | `front`, `front_hd`, `tof_gray` | `front` | Camera used for the checkpoint photo |
| `patrol_alert_repeat` | `round`, `night` | `round` | `round`: every round that sees something notifies. `night`: a kind at a checkpoint notifies once in 12 hours |

The mower reports its progress in the device sensors `patrol_phase` (`starting`,
`localizing`, `patrolling`, `returning`, `done`, `error`, `stopped`) and, after an
error, `patrol_error`.

---

## Logs Endpoint

### GET `/api/dashboard/logs`

Get recent MQTT message logs.
