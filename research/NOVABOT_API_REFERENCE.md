# Novabot Complete API & Protocol Reference

> **Generated**: February 2026
> **Sources**: Server code, mower firmware (mqtt_node v5.7.1), charger firmware (Ghidra decompilation v0.3.6/v0.4.0), Flutter app (blutter v2.3.8/v2.4.0), cloud API captures
> **Total**: 69 HTTP endpoints, 64+ MQTT commands, 9 BLE commands, 11 unsolicited reports

---

## Table of Contents

1. [HTTP API Endpoints](#1-http-api-endpoints)
   - [1.1 Cloud API — App ↔ Server](#11-cloud-api--app--server)
   - [1.2 Firmware API — Mower → Server](#12-firmware-api--mower--server)
   - [1.3 Dashboard API — Browser ↔ Server](#13-dashboard-api--browser--server)
   - [1.4 Admin API](#14-admin-api)
2. [MQTT Protocol](#2-mqtt-protocol)
   - [2.1 Topics & Encryption](#21-topics--encryption)
   - [2.2 Mowing Commands](#22-mowing-commands)
   - [2.3 Navigation Commands](#23-navigation-commands)
   - [2.4 Manual Control](#24-manual-control)
   - [2.5 Charging & Docking](#25-charging--docking)
   - [2.6 Mapping Commands](#26-mapping-commands)
   - [2.7 Map Management](#27-map-management)
   - [2.8 Device Parameters](#28-device-parameters)
   - [2.9 PIN Code](#29-pin-code)
   - [2.10 OTA Firmware](#210-ota-firmware)
   - [2.11 Timer & Scheduling](#211-timer--scheduling)
   - [2.12 Diagnostics & Info](#212-diagnostics--info)
   - [2.13 Patrol Mode](#213-patrol-mode)
   - [2.14 Area Definition](#214-area-definition)
   - [2.15 Server-Directed Reports](#215-server-directed-reports)
   - [2.16 Other Commands](#216-other-commands)
3. [MQTT Status Reports (Unsolicited)](#3-mqtt-status-reports-unsolicited)
   - [3.1 Charger: up_status_info](#31-charger-up_status_info)
   - [3.2 Mower: report_state_robot](#32-mower-report_state_robot)
   - [3.3 Mower: report_exception_state](#33-mower-report_exception_state)
   - [3.4 Mower: report_state_timer_data](#34-mower-report_state_timer_data)
   - [3.5 Mower: report_state_map_outline](#35-mower-report_state_map_outline)
   - [3.6 Other Reports](#36-other-reports)
4. [BLE Provisioning Protocol](#4-ble-provisioning-protocol)
   - [4.1 Charger BLE Commands](#41-charger-ble-commands)
   - [4.2 Mower BLE Commands](#42-mower-ble-commands)
5. [LoRa Protocol (Charger ↔ Mower)](#5-lora-protocol-charger--mower)
6. [Socket.io Events (Dashboard)](#6-socketio-events-dashboard)
7. [Home Assistant MQTT Bridge](#7-home-assistant-mqtt-bridge)
8. [Cloud API Authentication](#8-cloud-api-authentication)
9. [Command Routing Summary](#9-command-routing-summary)

---

## 1. HTTP API Endpoints

### Response Wrapper Format

All cloud API endpoints use this wrapper:
```json
{
  "success": true,
  "code": 200,
  "message": "request success",
  "value": <response_data>
}
```

Dashboard endpoints use: `{ "ok": true, ... }` or `{ "error": "..." }`

---

### 1.1 Cloud API — App ↔ Server

Base URL: `https://app.lfibot.com` → local `http://<server>:3000`

#### User Management

| # | Method | Endpoint | Auth | Request | Response (`value`) |
|---|--------|----------|------|---------|-------------------|
| 1 | POST | `/api/nova-user/appUser/login` | — | `{ email, password }` ¹ | `{ appUserId, email, phone, firstName, lastName, accessToken, newUserFlag, country, city, address, coordinates }` |
| 2 | POST | `/api/nova-user/appUser/regist` | — | `{ email, password, username? }` | `{ appUserId, email, token }` |
| 3 | POST | `/api/nova-user/appUser/loginOut` | JWT | — | `{}` |
| 4 | GET | `/api/nova-user/appUser/appUserInfo?email=` | JWT | query: `email` | `{ appUserId, email, username, machineToken }` |
| 5 | POST | `/api/nova-user/appUser/appUserInfoUpdate` | JWT | `{ username? }` | `{}` |
| 6 | POST | `/api/nova-user/appUser/appUserPwdUpdate` | JWT | `{ oldPassword, newPassword }` | `{}` |
| 7 | POST | `/api/nova-user/appUser/deleteAccount` | JWT | — | `{}` |
| 8 | POST | `/api/nova-user/appUser/updateAppUserMachineToken` | JWT | `{ machineToken }` | `{}` |

¹ Password is AES-128-CBC encrypted: key/IV = `1234123412ABCDEF`, base64 output

#### Email Verification

| # | Method | Endpoint | Auth | Request | Response (`value`) |
|---|--------|----------|------|---------|-------------------|
| 9 | POST | `/api/nova-user/validate/sendAppRegistEmailCode` | — | `{ email }` | `{}` |
| 10 | POST | `/api/nova-user/validate/validAppRegistEmailCode` | — | `{ email, code }` | `{}` |
| 11 | POST | `/api/nova-user/validate/sendAppResetPwdEmailCode` | — | `{ email }` | `{}` |
| 12 | POST | `/api/nova-user/validate/verifyAndResetAppPwd` | — | `{ email, code, newPassword }` | `{}` |

#### Equipment Management

| # | Method | Endpoint | Auth | Request | Response (`value`) |
|---|--------|----------|------|---------|-------------------|
| 13 | POST | `/api/nova-user/equipment/getEquipmentBySN` | JWT | `{ sn, deviceType? }` | See [getEquipmentBySN response](#getequipmentbysn-response) |
| 14 | POST | `/api/nova-user/equipment/bindingEquipment` | JWT | `{ mowerSn?, chargerSn?, equipmentTypeH?, userCustomDeviceName?, chargerChannel? }` | `null` |
| 15 | POST | `/api/nova-user/equipment/userEquipmentList` | JWT | `{ appUserId?, pageSize?, pageNo? }` | See [userEquipmentList response](#userequipmentlist-response) |
| 16 | POST | `/api/nova-user/equipment/unboundEquipment` | JWT | `{ sn?, equipmentId? }` | `{}` |
| 17 | POST | `/api/nova-user/equipment/updateEquipmentNickName` | JWT | `{ equipmentId, equipmentNickName }` | `{}` |
| 18 | POST | `/api/nova-user/equipment/updateEquipmentVersion` | JWT | `{ equipmentId, mowerVersion?, chargerVersion? }` | `{}` |

##### getEquipmentBySN Response

```json
{
  "equipmentId": 755,
  "email": "",
  "deviceType": "charger",           // "charger" for LFIC*, "mower" for LFIN*
  "sn": "LFIC1230700004",
  "equipmentCode": "LFIC1230700004",
  "equipmentName": "LFIC1230700004",
  "equipmentType": "LFIC1",          // first 5 chars of SN
  "userId": 0,
  "sysVersion": "v0.3.6",
  "period": "2029-02-22 00:00:00",
  "status": 1,
  "activationTime": "2026-02-21 18:32:12",
  "importTime": "2023-08-23 18:22:48",
  "batteryState": null,
  "macAddress": "48:27:E2:1B:A4:0A", // BLE MAC (not WiFi STA!)
  "chargerAddress": 718,              // integer (charger only)
  "chargerChannel": 16,               // integer (charger only)
  "account": "li9hep19",              // MQTT credentials (charger only)
  "password": "jzd4wac6",             // MQTT credentials (charger only)
  "wifiName": "ABERSONPLEIN-IoT",     // plaintext! (cloud only)
  "wifiPassword": "ramonvanbruggen"   // plaintext! (cloud only)
}
```

For mower: `chargerAddress`, `chargerChannel`, `account`, `password` are all `null`.

##### userEquipmentList Response

```json
{
  "pageNo": 1,
  "pageSize": 10,
  "totalSize": 2,
  "totalPage": 1,
  "pageList": [
    {
      "chargerSn": "LFIC1230700004",
      "chargerVersion": "v0.3.6",
      "equipmentId": "uuid",
      "equipmentNickName": "Novabot",
      "equipmentTypeH": "Novabot",
      "macAddress": "48:27:E2:1B:A4:0A",
      "mowerVersion": "v0.3.25",
      "online": true,
      "status": 1,
      "chargerAddress": 718,
      "chargerChannel": 16,
      "userId": "uuid",
      "videoTutorial": null,
      "model": null,
      "wifiName": null
    }
  ]
}
```

#### OTA & Version

| # | Method | Endpoint | Auth | Request | Response (`value`) |
|---|--------|----------|------|---------|-------------------|
| 19 | GET | `/api/nova-user/otaUpgrade/checkOtaNewVersion?version=&upgradeType=&equipmentType=` | JWT | query params | `{ hasNewVersion, newVersion?, downloadUrl?, releaseNotes? }` |
| 20 | POST | `/api/nova-data/appManage/queryNewVersion` | — | — | `{ version: "2.3.9", hasNewVersion: false }` |

#### Mowing Schedules

| # | Method | Endpoint | Auth | Request | Response (`value`) |
|---|--------|----------|------|---------|-------------------|
| 21 | GET | `/api/nova-data/appManage/queryCutGrassPlan?equipmentId=` | JWT | query | `[{ planId, equipmentId, startTime, endTime, weekday[], repeat, repeatCount, repeatType, workTime, workArea[], workDay[] }]` |
| 22 | GET | `/api/nova-data/cutGrassPlan/queryRecentCutGrassPlan?equipmentId=` | JWT | query | Plan object or `null` |
| 23 | POST | `/api/nova-data/cutGrassPlan/queryRecentCutGrassPlan` | JWT | `{ sn? }` | Plan object or `null` |
| 24 | POST | `/api/nova-data/appManage/saveCutGrassPlan` | JWT | `{ equipmentId, startTime?, endTime?, weekday[], repeat?, repeatCount?, repeatType?, workTime?, workArea[], workDay[] }` | `{ planId }` |
| 25 | POST | `/api/nova-data/appManage/updateCutGrassPlan` | JWT | `{ planId, startTime?, endTime?, weekday[]?, ... }` | `{}` |
| 26 | POST | `/api/nova-data/appManage/deleteCutGrassPlan` | JWT | `{ planId }` | `{}` |

#### Maps

| # | Method | Endpoint | Auth | Request | Response (`value`) |
|---|--------|----------|------|---------|-------------------|
| 27 | GET | `/api/nova-file-server/map/queryEquipmentMap?sn=` | JWT | query: `sn` | Zie detail hieronder |
| 28 | POST | `/api/nova-file-server/map/fragmentUploadEquipmentMap` | JWT | multipart: `sn, uploadId, chunkIndex, chunksTotal, mapName?, mapArea?, file` | `{ mapId, uploadId, complete?, chunksReceived? }` |
| 29 | POST | `/api/nova-file-server/map/updateEquipmentMapAlias` | JWT | `{ mapId, mapName }` | `{}` |

**Endpoint #27 — `queryEquipmentMap` response detail (maart 2026)**

App v2.4.0 verwacht `data` als `Map<String, dynamic>` (doet `data as Map<String, dynamic>` typecheck).
Een base64 string of array crasht de app → "No map!" error.

```json
{
  "data": {
    "work": [
      {
        "fileName": "map0_work.csv",
        "alias": "Work area 1",
        "type": "work",
        "url": null,
        "fileHash": "md5_van_map_id",
        "mapArea": "[{\"lat\":52.14,\"lng\":6.23}, ...]",
        "obstacle": [
          { "fileName": "map0_0_obstacle.csv", "alias": "obstacle_0", "type": "obstacle", ... }
        ]
      }
    ],
    "unicom": [
      { "fileName": "map0tocharge_unicom.csv", "alias": "Channel 1", "type": "unicom", ... }
    ]
  },
  "md5": "hash_van_latest_zip_of_null",
  "machineExtendedField": {
    "chargingPose": { "x": "6.231", "y": "52.140", "orientation": "0" }
  }
}
```

- `MapEntityItem` velden: `fileName`, `alias`, `type`, `url`, `fileHash`, `mapArea`, `obstacle[]`
- `chargingPose` velden zijn **strings** (app doet `double._parse()` erop)
- `data: null` als er geen kaarten zijn → app toont "No map!"
- `machineExtendedField: null` als er geen charger GPS positie bekend is

#### Messages

| # | Method | Endpoint | Auth | Request | Response (`value`) |
|---|--------|----------|------|---------|-------------------|
| 30 | GET | `/api/novabot-message/message/queryRobotMsgPageByUserId?page=&limit=` | JWT | query | `{ total, page, limit, list[] }` |
| 31 | POST | `/api/novabot-message/message/queryMsgMenuByUserId` | JWT | — | `{ robotMsgUnreadCount, workRecordUnreadCount }` |
| 32 | POST | `/api/novabot-message/message/updateMsgByUserId` | JWT | `{ messageIds[] }` | `{}` |
| 33 | POST | `/api/novabot-message/message/deleteMsgByUserId` | JWT | `{ messageIds[] }` | `{}` |
| 34 | GET | `/api/novabot-message/message/queryCutGrassRecordPageByUserId?page=&limit=` | JWT | query | `{ total, page, limit, list[] }` |

#### Logs & Network

| # | Method | Endpoint | Auth | Request | Response (`value`) |
|---|--------|----------|------|---------|-------------------|
| 35 | POST | `/api/nova-file-server/log/uploadAppOperateLog` | JWT | multipart: `file` | `{}` |
| 36 | POST | `/api/nova-network/network/connection` | — | — | `1` |

---

### 1.2 Firmware API — Mower → Server

These endpoints are called by the mower firmware (`mqtt_node` via libcurl). **No JWT auth** — the mower identifies itself by SN field.

| # | Method | Endpoint | Auth | Request | Response | Trigger |
|---|--------|----------|------|---------|----------|---------|
| 37 | POST | `/api/nova-file-server/map/uploadEquipmentMap` | — | multipart: `sn, zipMd5, local_file_name, jsonBody, local_file` | `null` | After `save_map` |
| 38 | POST | `/api/nova-file-server/map/uploadEquipmentTrack` | — | multipart: `sn, local_file_name, local_file` | `null` | After mowing session |
| 39 | POST | `/api/nova-data/cutGrassPlan/queryPlanFromMachine` | — | `{ sn }` | `[{ planId, ... }]` | On mower boot |
| 40 | POST | `/api/nova-data/equipmentState/saveCutGrassRecord` | — | `{ sn, dateTime, workTime, workArea, cutGrassHeight, mapNames[], startWay, workStatus, scheduleId, week }` | `null` | After mowing |
| 41 | POST | `/api/novabot-message/machineMessage/saveCutGrassMessage` | — | `{ sn, ... }` | `null` | Event notification |
| 42 | POST | `/api/nova-user/equipment/machineReset` | — | `{ sn }` | `null` | Factory reset |
| 43 | POST | `/x3/log/upload` | — | raw binary (50MB limit) | `{ code: 200, msg: "ok" }` | Log upload |

---

### 1.3 Dashboard API — Browser ↔ Server

Local only, no authentication. Base path: `/api/dashboard/`

#### Devices & Sensors

| # | Method | Endpoint | Request | Response |
|---|--------|----------|---------|----------|
| 44 | GET | `/api/dashboard/devices` | — | `{ devices: [{ sn, macAddress, lastSeen, online, deviceType, nickname, sensors }] }` |
| 45 | GET | `/api/dashboard/devices/:sn` | — | `{ sn, online, deviceType, sensors }` |
| 46 | GET | `/api/dashboard/sensors` | — | `{ sensors }` — sensor definitions |
| 47 | GET | `/api/dashboard/logs` | — | `{ logs[] }` — recent MQTT logs |

#### Maps

| # | Method | Endpoint | Request | Response |
|---|--------|----------|---------|----------|
| 48 | GET | `/api/dashboard/maps/:sn` | — | `{ maps: [{ mapId, mapName, mapType, mapArea[], mapMaxMin, createdAt }] }` |
| 49 | POST | `/api/dashboard/maps/:sn` | `{ mapName?, mapArea[], mapType? }` | `{ ok: true, map }` |
| 50 | PATCH | `/api/dashboard/maps/:sn/:mapId` | `{ mapName?, mapArea[]? }` | `{ ok: true }` |
| 51 | DELETE | `/api/dashboard/maps/:sn/:mapId` | — | `{ ok: true }` |
| 52 | POST | `/api/dashboard/maps/:sn/request` | — | `{ ok: true }` — triggers `get_map_list` MQTT |
| 53 | POST | `/api/dashboard/maps/:sn/request-outline` | `{ mapId }` | `{ ok: true }` — triggers `get_map_outline` MQTT |
| 54 | POST | `/api/dashboard/maps/:sn/export-zip` | `{ chargingStation: { lat, lng }, chargingOrientation? }` | `{ ok: true, zipPath, downloadUrl }` |
| 55 | GET | `/api/dashboard/maps/:sn/download-zip` | — | ZIP file binary |
| 56 | POST | `/api/dashboard/maps/:sn/import-zip` | `{ zipPath, chargingStation: { lat, lng } }` | `{ ok: true, imported, totalAreas, chargingPose }` |
| 57 | POST | `/api/dashboard/maps/convert` | `{ direction: "gps-to-local"\|"local-to-gps", origin, points[] }` | `{ points[] }` |

#### Trail & Calibration

| # | Method | Endpoint | Request | Response |
|---|--------|----------|---------|----------|
| 58 | GET | `/api/dashboard/trail/:sn` | — | `{ trail: [{ lat, lng, ts }] }` |
| 59 | DELETE | `/api/dashboard/trail/:sn` | — | `{ ok: true }` |
| 60 | GET | `/api/dashboard/calibration/:sn` | — | `{ calibration: { offsetLat, offsetLng, rotation, scale } }` |
| 61 | PUT | `/api/dashboard/calibration/:sn` | `{ offsetLat?, offsetLng?, rotation?, scale? }` | `{ ok: true }` |

#### Commands & Schedules

| # | Method | Endpoint | Request | Response |
|---|--------|----------|---------|----------|
| 62 | POST | `/api/dashboard/command/:sn` | `{ command: { <cmd>: { ...args } } }` | `{ ok: true, command }` |
| 63 | GET | `/api/dashboard/schedules/:sn` | — | `{ schedules[] }` |
| 64 | POST | `/api/dashboard/schedules/:sn` | `{ scheduleName?, startTime, endTime?, weekdays[], mapId?, mapName?, cuttingHeight?, pathDirection?, workMode?, taskMode? }` | `{ ok: true, schedule }` |
| 65 | PATCH | `/api/dashboard/schedules/:sn/:scheduleId` | `{ scheduleName?, startTime?, endTime?, weekdays[]?, enabled?, ... }` | `{ ok: true, schedule }` |
| 66 | DELETE | `/api/dashboard/schedules/:sn/:scheduleId` | — | `{ ok: true }` |
| 67 | POST | `/api/dashboard/schedules/:sn/:scheduleId/send` | — | `{ ok: true }` — sends `timer_task` + `set_para_info` via MQTT |

---

### 1.4 Admin API

| # | Method | Endpoint | Auth | Request | Response |
|---|--------|----------|------|---------|----------|
| 68 | GET | `/api/admin/devices` | — | — | `[{ sn, macAddress, mqttClientId, mqttUsername, lastSeen }]` |
| 69 | POST | `/api/admin/devices/:sn/mac` | — | `{ macAddress }` | `{ sn, macAddress, status: "ok" }` |

---

## 2. MQTT Protocol

### 2.1 Topics & Encryption

| Direction | Topic Pattern | Example |
|-----------|---------------|---------|
| App/Server → Device | `Dart/Send_mqtt/<SN>` | `Dart/Send_mqtt/LFIN2230700238` |
| Device → App/Server | `Dart/Receive_mqtt/<SN>` | `Dart/Receive_mqtt/LFIC1230700004` |
| Mower → Server only | `Dart/Receive_server_mqtt/<SN>` | `Dart/Receive_server_mqtt/LFIN2230700238` |

**Encryption:**

| Device | Encryption | Key | IV |
|--------|-----------|-----|-----|
| Charger (LFIC*) | **None** — plain JSON | — | — |
| Mower (LFIN*) | **AES-128-CBC** | `"abcdabcd1234" + SN[-4:]` | `"abcd1234abcd1234"` |

Example: Mower `LFIN2230700238` → key = `abcdabcd12340238` (16 bytes UTF-8)

**MQTT Connection:**

| Property | Charger | Mower | App |
|----------|---------|-------|-----|
| Client ID | `ESP32_<MAC_suffix>` | `<SN>_6688` | UUID |
| Username | `<SN>` | `<SN>` | — |
| Password | — | — | — |
| Subscribe | `Dart/Send_mqtt/<SN>` QoS 1 | `Dart/Send_mqtt/<SN>` QoS 1 | `Dart/Receive_mqtt/<SN>` |
| Publish | `Dart/Receive_mqtt/<SN>` QoS 0 | `Dart/Receive_mqtt/<SN>` | `Dart/Send_mqtt/<SN>` |

**All commands use JSON format:**
```json
{ "command_name": { ...fields } }
```

**All responses use format:**
```json
{ "type": "command_name_respond", "message": { "result": 0, "value": <data> } }
```

---

### 2.2 Mowing Commands

| Command | Response | Handler | LoRa Relay | Fields |
|---------|----------|---------|------------|--------|
| `start_run` | `start_run_respond` | Mower + Charger | `0x35 0x01` | See below |
| `pause_run` | `pause_run_respond` | Mower + Charger | `0x35 0x03` | `{}` |
| `resume_run` | `resume_run_respond` | Mower + Charger | `0x35 0x05` | `{}` |
| `stop_run` | `stop_run_respond` | Mower + Charger | `0x35 0x07` | `{}` |
| `stop_time_run` | `stop_time_run_respond` | Charger only | `0x35 0x09` | `{}` |

#### `start_run` Fields

**Via charger (LoRa relay):**
```json
{
  "start_run": {
    "mapName": 0,          // integer: map index
    "area": 100,           // uint16: area in m²
    "cutterhigh": 4        // uint8: cutting height level (0-7)
  }
}
```

**Via mower directly (MQTT):**
```json
{
  "start_run": {
    "mapNames": ["home"],           // string[]: map names to mow
    "cutGrassHeight": 40,           // int: cutting height (mm)
    "startWay": 0,                  // int: start mode (0=normal, 1=specified area)
    "workArea": null,               // polygon area (for SPECIFIED_AREA mode)
    "schedule": false,              // bool: is scheduled task
    "scheduleId": ""                // string: schedule identifier
  }
}
```

**Via mower ROS service (`StartCoverageTask.srv`):**
```
uint8 cov_mode              # 0=NORMAL, 1=SPECIFIED_AREA, 2=BOUNDARY_COV
uint8 request_type          # 11=app, 12=schedule, 21=MCU, 22=MCU schedule
uint32 map_ids
string[] map_names
geometry_msgs/Point[] polygon_area    # GPS points (for cov_mode=1)
uint8[] blade_heights               # 0-7 (height = (level+2)*10 mm)
bool specify_direction
uint8 cov_direction                  # 0-180°
uint8 light                          # LED brightness
bool specify_perception_level
uint8 perception_level               # 0=off, 1=det, 2=seg, 3=sensitive
uint8 blade_info_level               # 0-4
bool night_light
bool enable_loc_weak_mapping
bool enable_loc_weak_working
```

---

### 2.3 Navigation Commands

| Command | Response | Handler | Fields |
|---------|----------|---------|--------|
| `start_navigation` | `start_navigation_respond` | Mower | `{ target_x?, target_y?, target_theta? }` |
| `stop_navigation` | `stop_navigation_respond` | Mower | `{}` |
| `pause_navigation` | `pause_navigation_respond` | Mower | `{}` |
| `resume_navigation` | `resume_navigation_respond` | Mower | `{}` |
| `navigate_to_position` | `navigate_to_position_respond` | Mower | `{ x, y, theta }` |
| `set_navigation_max_speed` | `set_navigation_max_speed_respond` | Mower | `{ speed }` |

---

### 2.4 Manual Control

| Command | Response | Handler | Fields |
|---------|----------|---------|--------|
| `start_move` | *(none)* | Mower | `{ x, y, speed }` — continuous joystick data |
| `stop_move` | *(none)* | Mower | `{}` |

---

### 2.5 Charging & Docking

| Command | Response | Handler | LoRa Relay | Fields |
|---------|----------|---------|------------|--------|
| `go_to_charge` | `go_to_charge_respond` | Mower | — | `{}` |
| `go_pile` | `go_pile_respond` | Charger | `0x35 0x0B` | `{}` |
| `stop_to_charge` | `stop_to_charge_respond` | Mower | — | `{}` |
| `auto_recharge` | `auto_recharge_respond` | Mower | — | `{}` |
| `get_recharge_pos` | `get_recharge_pos_respond` | Mower | — | `{}` |
| `save_recharge_pos` | `save_recharge_pos_respond` | Mower | — | `{ lat?, lng?, orientation? }` |
| `auto_charge_threshold` | `auto_charge_threshold_respond` | Mower | — | `{ threshold }` — battery % to trigger auto-charge |

> **Note:** `go_pile` goes through the charger LoRa bridge. `go_to_charge` goes directly to the mower via MQTT.

---

### 2.6 Mapping Commands

| Command | Response | Handler | Fields |
|---------|----------|---------|--------|
| `start_scan_map` | `start_scan_map_respond` | Mower | `{}` |
| `stop_scan_map` | `stop_scan_map_respond` | Mower | `{}` |
| `add_scan_map` | `add_scan_map_respond` | Mower | `{ x?, y? }` |
| `start_erase_map` | `start_erase_map_respond` | Mower | `{}` |
| `stop_erase_map` | `stop_erase_map_respond` | Mower | `{}` |
| `start_assistant_build_map` | `start_assistant_build_map_respond` | Mower | `{}` |
| `quit_mapping_mode` | *(none)* | Mower | `{}` |

**ROS service:** `/robot_decision/start_mapping` → `StartMapping.srv`
```
uint8 task_type     # 0=manual boundary, 1=assistant auto
string mapname
---
bool result
```

---

### 2.7 Map Management

| Command | Response | Handler | Fields |
|---------|----------|---------|--------|
| `get_map_list` | `get_map_list_respond` | Mower | `{}` |
| `get_map_outline` | `report_state_map_outline` | Mower | `{ map_id }` |
| `get_map_plan_path` | `get_map_plan_path_respond` | Mower | `{ map_id }` |
| `get_preview_cover_path` | `get_preview_cover_path_respond` | Mower | `{ map_id, cov_direction? }` |
| `generate_preview_cover_path` | `generate_preview_cover_path_respond` | Mower | `{ map_ids, cov_direction? }` |
| `request_map_ids` | *(unsolicited)* | Mower | `{}` |
| `save_map` | `save_map_respond` | Mower | `{ mapName }` |
| `delete_map` | `delete_map_respond` | Mower | `{ map_name, map_type? }` |
| `reset_map` | `reset_map_respond` | Mower | `{ map_name? }` |
| `rename_map` | `rename_map_respond` | Mower | `{ old_name, new_name }` |
| `get_map_info` | `get_map_info_respond` | Mower | `{}` |
| `get_mapping_path2d` | `get_mapping_path2d_respond` | Mower | `{}` |

**ROS services:**

| ROS Service | MQTT Trigger |
|-------------|-------------|
| `/robot_decision/save_map` | `save_map` |
| `/robot_decision/delete_map` | `delete_map` |
| `/robot_decision/reset_mapping` | `reset_map` |
| `/robot_decision/generate_preview_cover_path` | `generate_preview_cover_path` |
| `/robot_decision/quit_mapping_mode` | `quit_mapping_mode` |

**`SaveMap.srv`:**
```
string mapname
float32 resolution       # grid resolution (0.02-0.05m)
int64 type               # 0=work, 1=obstacle, 2=unicom
---
string data
uint8 result
uint8 error_code         # 1=OVERLAPING_OTHER_MAP, 2=OVERLAPING_OTHER_UNICOM, 3=CROSS_MULTI_MAPS
```

---

### 2.8 Device Parameters

| Command | Response | Handler | Fields |
|---------|----------|---------|--------|
| `get_para_info` | `get_para_info_respond` | Mower | `{}` |
| `set_para_info` | `set_para_info_respond` | Mower | See below |

```json
{
  "set_para_info": {
    "obstacle_avoidance_sensitivity": 5,  // 1-10
    "target_height": 40,                  // mm
    "defaultCuttingHeight": 40,           // mm
    "path_direction": 90,                 // 0-180°
    "cutGrassHeight": 40                  // mm
  }
}
```

---

### 2.9 PIN Code

| Command | Response | Handler | Fields |
|---------|----------|---------|--------|
| `dev_pin_info` | `dev_pin_info_respond` | Mower | `{ pin_code?, action? }` |
| `no_set_pin_code` | *(flag)* | Mower | `{}` |

---

### 2.10 OTA Firmware

| Command | Response | Handler | Fields |
|---------|----------|---------|--------|
| `ota_version_info` | `ota_version_info_respond` | Both | `{}` |
| `ota_upgrade_cmd` | `ota_upgrade_cmd_respond` | Both | `{ url?, md5?, version? }` |

**Charger `ota_version_info_respond`:**
```json
{
  "type": "ota_version_info_respond",
  "message": {
    "result": 0,
    "value": {
      "system": "v0.0.1",
      "version": "v0.3.6"
    }
  }
}
```

**Charger `ota_upgrade_cmd_respond`:**
```json
{
  "type": "ota_upgrade_cmd_respond",
  "message": {
    "result": 0,        // 0=started, 1=not needed
    "value": 0          // 0=started, 1=same version, 2=older version
  }
}
```

---

### 2.11 Timer & Scheduling

| Command | Response | Handler | Fields |
|---------|----------|---------|--------|
| `timer_task` | *(none)* | Mower | See below |

```json
{
  "timer_task": {
    "task_id": "schedule_123",
    "start_time": "08:00",
    "end_time": "17:00",
    "map_id": "home_map",
    "map_name": "Garden",
    "repeat_type": "WEEKLY",
    "is_timer": true,
    "work_mode": 0,
    "task_mode": 0,
    "cov_direction": 0,
    "path_direction": 90
  }
}
```

---

### 2.12 Diagnostics & Info (Mower only)

These commands were discovered in the mower firmware `mqtt_node` binary:

| Command | Response | Fields | Description |
|---------|----------|--------|-------------|
| `get_dev_info` | `get_dev_info_respond` | `{}` | Device hardware/software info |
| `get_log_info` | `get_log_info_respond` | `{}` | Diagnostic log information |
| `get_cfg_info` | `get_cfg_info_respond` | `{}` | Configuration state |
| `get_version_info` | `get_version_info_respond` | `{}` | Detailed version information |
| `get_control_mode` | `get_control_mode_respond` | `{}` | Current control mode |
| `set_control_mode` | `set_control_mode_respond` | `{ mode }` | Set control mode |
| `get_vel_odom` | `get_vel_odom_respond` | `{}` | Velocity/odometry data |
| `get_current_pose` | `get_current_pose_respond` | `{}` | Current position and heading |
| `get_lora_info` | `get_lora_info_respond` | `{}` | LoRa configuration |

---

### 2.13 Patrol Mode (Mower only)

| Command | Response | Fields | Description |
|---------|----------|--------|-------------|
| `start_patrol` | `start_patrol_respond` | `{ map_name? }` | Start boundary patrol (follows map outline) |
| `stop_patrol` | `stop_patrol_respond` | `{}` | Stop boundary patrol |

**ROS action:** `BoundaryFollow` — robot follows the boundary of the specified map area.

---

### 2.14 Area Definition (Mower only)

| Command | Response | Fields | Description |
|---------|----------|--------|-------------|
| `area_set` | `area_set_respond` | See below | Define area via GPS bounding box |
| `update_virtual_wall` | `update_virtual_wall_respond` | See below | Update obstacle barriers |

```json
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

```json
{
  "update_virtual_wall": {
    "virtual_wall": [...],
    "map_name": "map0"
  }
}
```

**ROS service:** `/robot_decision/add_area`

---

### 2.15 Server-Directed Reports (Mower only)

The mower firmware has a **separate MQTT topic** for server-only reports:

**Topic:** `Dart/Receive_server_mqtt/<SN>`

| Report | Description |
|--------|-------------|
| `report_state_to_server_work` | Work progress report (sent to server, not app) |
| `report_state_to_server_exception` | Exception report (sent to server, not app) |

These reports are published to a different topic than the regular `Dart/Receive_mqtt/<SN>`, making them invisible to the mobile app.

---

### 2.16 Other Commands

| Command | Response | Handler | Fields | Description |
|---------|----------|---------|--------|-------------|
| `auto_connect` | *(none)* | Mower | `{}` | Auto-connect command |
| `gbf` | `gbf_respond` | Mower | `{}` | Unknown (dedicated firmware function) |
| `mst` | `mst_respond` | Mower | `{}` | Unknown (dedicated firmware function) |
| `report_state_all_by_ble` | — | Mower | — | Full state dump for BLE file transfer |

---

## 3. MQTT Status Reports (Unsolicited)

These are pushed periodically by devices without a specific request.

### 3.1 Charger: `up_status_info`

**Topic:** `Dart/Receive_mqtt/LFIC*`
**Frequency:** Every ~2 seconds
**Encryption:** None (plain JSON)

```json
{
  "up_status_info": {
    "charger_status": 0,         // uint32 bitfield — see below
    "mower_status": 0,           // uint32: mower operational status (via LoRa)
    "mower_info": 0,             // uint32: mower info field 1 (via LoRa)
    "mower_x": 0,                // uint24: mower local X position (via LoRa)
    "mower_y": 0,                // uint24: mower local Y position (via LoRa)
    "mower_z": 0,                // uint24: mower heading (via LoRa)
    "mower_info1": 0,            // uint16: mower info field 2 (via LoRa)
    "mower_error": 0             // uint: LoRa heartbeat failure counter (0 if <2)
  }
}
```

**`charger_status` bitfield:**

| Bits | Mask | Description |
|------|------|-------------|
| Bit 0 | `0x00000001` | GPS valid (< 5 consecutive GNGGA parse failures) |
| Bit 8 | `0x00000100` | RTK quality OK |
| Middle | varies | LoRa RSSI in valid range (1-145) |
| Bits 24-31 | `0xFF000000` | **GPS satellite count** (shifted << 24) |

**Example values:**
- `0x00000000` = No GPS, no RTK, no LoRa
- `0x0E000101` = 14 sats, GPS + RTK OK
- `0x11000101` = 17 sats, GPS + RTK OK

---

### 3.2 Mower: `report_state_robot`

**Topic:** `Dart/Receive_mqtt/LFIN*`
**Frequency:** Every ~5 seconds
**Encryption:** AES-128-CBC
**Encrypted size:** ~800 bytes

```json
{
  "report_state_robot": {
    "battery_power": 100,             // 0-100%
    "battery_state": "CHARGING",      // CHARGING, NOT_CHARGING, DISCHARGING, FULL
    "work_status": 0,                 // work status code
    "work_mode": 0,                   // work mode
    "prev_state": 0,                  // previous state
    "task_mode": 0,                   // task mode
    "recharge_status": 0,             // charging status
    "error_code": 0,                  // error code (0=none)
    "error_msg": "",                  // error message text
    "error_status": 132,              // error status
    "x": 0, "y": 0, "z": 0,          // local coordinates
    "loc_quality": 100,               // localization quality %
    "current_map_id": "",             // active map ID
    "mowing_progress": 0,             // mowing progress %
    "covering_area": 0,               // coverage area (m²)
    "finished_area": 0,               // finished area (m²)
    "cov_direction": 0,               // mowing direction (0-180°)
    "path_direction": 0,              // path direction (0-180°)
    "cpu_temperature": 35,            // CPU temp (°C)
    "mow_blade_work_time": 72720,     // blade runtime (seconds)
    "working_hours": 0,               // total working hours
    "mow_speed": 0.0,                 // mowing speed (m/s)
    "sw_version": "v0.3.25",          // firmware version
    "ota_state": 0,                   // OTA update status
    "charger_status": 0               // charger connection status
  }
}
```

---

### 3.3 Mower: `report_exception_state`

**Encryption:** AES-128-CBC
**Encrypted size:** ~144 bytes

```json
{
  "report_exception_state": {
    "button_stop": false,      // emergency stop pressed
    "chassis_err": 0,          // chassis error code
    "pin_code": "",            // PIN code status
    "rtk_sat": 29,             // RTK satellite count
    "wifi_rssi": 55            // WiFi signal (dBm, inverted)
  }
}
```

---

### 3.4 Mower: `report_state_timer_data`

**Encryption:** AES-128-CBC
**Encrypted size:** 480-496 bytes (variable due to padding)

```json
{
  "report_state_timer_data": {
    "battery_capacity": 100,
    "battery_state": "CHARGING",
    "latitude": 52.1409,
    "longitude": 6.2310,
    "orient_flag": 0,
    "localization_state": "NOT_INITIALIZED",
    "timer_task": [
      {
        "task_id": "id",
        "start_time": "08:00",
        "end_time": "17:00",
        "map_id": "map0",
        "map_name": "Garden",
        "repeat_type": "WEEKLY",
        "is_timer": true,
        "work_mode": 0,
        "task_mode": 0,
        "cov_direction": 90,
        "path_direction": 90
      }
    ]
  }
}
```

---

### 3.5 Mower: `report_state_map_outline`

**Triggered by:** `get_map_outline` command
**Encryption:** AES-128-CBC

```json
{
  "report_state_map_outline": {
    "map_id": "home_map_0",
    "map_name": "Garden",
    "map_type": "work",
    "map_position": [
      { "lat": 52.1409, "lng": 6.2310 },
      { "lat": 52.1410, "lng": 6.2315 },
      { "lat": 52.1412, "lng": 6.2312 }
    ]
  }
}
```

---

### 3.6 Other Reports

| Report | Source | Description |
|--------|--------|-------------|
| `report_state_battery` | Mower | Battery status |
| `report_state_work` | Mower | Work/mowing status |
| `ota_upgrade_state` | Both | OTA progress: `{ status, percentage }` |
| `connection_state` | Both | Connection status change |
| `report_state_to_server_work` | Mower (server topic) | Server-only work report |
| `report_state_to_server_exception` | Mower (server topic) | Server-only exception report |

---

## 4. BLE Provisioning Protocol

### Transport

- **Service UUID:** `0x1234`
- **Write characteristic:** `0x2222` (Write Without Response + Notify)
- **Read characteristic:** `0x3333` (Read + Write Without Response)
- **Chunking:** Payloads split into ~20-27 byte chunks, wrapped in `ble_start`/`ble_end` markers
- **Format:** JSON objects as root (not wrapped in `{"cmd":"..."}`)

### 4.1 Charger BLE Commands

Device name: `CHARGER_PILE` (app matches case-insensitive: `chargerpile`)

| # | Command | Response | Fields |
|---|---------|----------|--------|
| 1 | `get_signal_info` | `get_signal_info_respond` | `0` → `{ wifi: <rssi>, rtk: <sats> }` |
| 2 | `get_wifi_info` | `get_wifi_info_respond` | `0` → `{ wifi: <rssi>, rtk: <sats> }` |
| 3 | `set_wifi_info` | `set_wifi_info_respond` | See below |
| 4 | `set_mqtt_info` | `set_mqtt_info_respond` | `{ addr: "mqtt.lfibot.com", port: 1883 }` |
| 5 | `set_lora_info` | `set_lora_info_respond` | `{ addr: 718, channel: 16, hc: 20, lc: 14 }` → `{ value: <assigned_channel> }` |
| 6 | `set_rtk_info` | `set_rtk_info_respond` | `0` |
| 7 | `get_cfg_info` | `get_cfg_info_respond` | `0` → `{ value: 0\|1 }` |
| 8 | `set_cfg_info` | `set_cfg_info_respond` | `0` (reset) or `1` (commit + reboot) |
| 9 | `get_dev_info` | `get_dev_info_respond` | `0` → `{ sn, fw_version, hw_version }` |

**`set_wifi_info` (charger):**
```json
{
  "set_wifi_info": {
    "sta": { "ssid": "<home_network>", "passwd": "<password>", "encrypt": 0 },
    "ap":  { "ssid": "<SN>",           "passwd": "12345678",   "encrypt": 0 }
  }
}
```

**Validation:** STA SSID min 2 chars, passwords min 8 chars, AP SSID min 8 chars.

**Provisioning sequence (charger):**
1. `get_signal_info` → check WiFi + GPS
2. `set_wifi_info` → configure STA + AP
3. `set_mqtt_info` → set MQTT broker
4. `set_lora_info` → configure LoRa (response: assigned channel)
5. `set_rtk_info` → configure RTK GPS
6. `set_cfg_info` with value `1` → commit + reboot

---

### 4.2 Mower BLE Commands

Device name: `Novabot` (app matches case-insensitive: `novabot`)

**Key differences from charger:**
- `set_wifi_info` contains **only `ap`** (no `sta`) — mower connects via charger AP
- **No `set_rtk_info`** in mower flow
- `set_cfg_info` includes `tz` (timezone)
- `set_lora_info_respond` returns `value: null` (not a channel number)

**`set_wifi_info` (mower):**
```json
{
  "set_wifi_info": {
    "ap": { "ssid": "<home_network>", "passwd": "<password>", "encrypt": 0 }
  }
}
```

**`set_cfg_info` (mower):**
```json
{
  "set_cfg_info": { "cfg_value": 1, "tz": "Europe/Amsterdam" }
}
```

**Provisioning sequence (mower):**
1. `set_wifi_info` → configure WiFi (AP only)
2. `set_lora_info` → configure LoRa
3. `set_mqtt_info` → set MQTT broker
4. `set_cfg_info` → commit + reboot (with timezone)

---

## 5. LoRa Protocol (Charger ↔ Mower)

### Hardware

- **Module:** EBYTE E32/E22 series (Broadcom BCM-based)
- **UART1:** TX=GPIO17, RX=GPIO18
- **Mode pins:** M0=GPIO12, M1=GPIO46
- **Data mode:** M0=0, M1=0 (transparent)
- **Config mode:** M0=1, M1=1

### Packet Format

```
[0x02][0x02][addr_hi][addr_lo][len+1][payload...][XOR checksum][0x03][0x03]
```

| Direction | Address bytes |
|-----------|--------------|
| Charger → Mower | `0x00 0x03` |
| Mower → Charger | `0x00 0x01` |

### Command Categories

| First Byte | Category | Description |
|------------|----------|-------------|
| `0x30` | CHARGER | Hall sensor, IRQ acknowledgement |
| `0x31` | RTK_RELAY | GNGGA NMEA data relay to mower |
| `0x32` | CONFIG | Configuration commands |
| `0x33` | GPS | GPS position (lat/lon/alt, 16 bytes) |
| `0x34` | REPORT | Heartbeat poll + mower status data |
| `0x35` | ORDER | Mow commands (start/pause/stop/go_pile) |
| `0x36` | SCAN_CHANNEL | LoRa channel scan |

### MQTT → LoRa Command Mapping

| MQTT Command | Queue Byte | LoRa Payload | Bytes |
|-------------|------------|-------------|-------|
| `start_run` | `0x20` | `[0x35, 0x01, map, area_hi, area_lo, height]` | 6 |
| `pause_run` | `0x21` | `[0x35, 0x03]` | 2 |
| `resume_run` | `0x22` | `[0x35, 0x05]` | 2 |
| `stop_run` | `0x23` | `[0x35, 0x07]` | 2 |
| `stop_time_run` | `0x24` | `[0x35, 0x09]` | 2 |
| `go_pile` | `0x25` | `[0x35, 0x0B]` | 2 |

### Mower Status via LoRa

Heartbeat poll: `[0x34, 0x01]` every ~1.5s
Mower response: `[0x34, 0x02, ...19 bytes data...]`

| LoRa Offset | Size | MQTT Field | Description |
|------------|------|-----------|-------------|
| [7-10] | 4B (uint32 LE) | `mower_status` | Operational status |
| [11-14] | 4B (uint32 LE) | `mower_info` | Info field 1 |
| [15-17] | 3B (uint24 LE) | `mower_x` | X position |
| [18-20] | 3B (uint24 LE) | `mower_y` | Y position |
| [21-23] | 3B (uint24 LE) | `mower_z` | Heading |
| [24-25] | 2B (uint16 LE) | `mower_info1` | Info field 2 |

---

## 6. Socket.io Events (Dashboard)

### Server → Browser

| Event | Payload | When |
|-------|---------|------|
| `state:snapshot` | `{ devices: [...] }` | On connect — full state |
| `mqtt:log:history` | `[MqttLogEntry, ...]` | On connect — last 500 logs |
| `device:update` | `{ sn, fields, timestamp }` | On sensor change |
| `device:online` | `{ sn, timestamp }` | Device connected |
| `device:offline` | `{ sn, timestamp }` | Device disconnected |
| `mqtt:log` | `MqttLogEntry` | Real-time MQTT log |

### MqttLogEntry

```typescript
{
  ts: number;                    // timestamp (ms)
  type: 'connect' | 'disconnect' | 'subscribe' | 'publish' | 'error';
  clientId: string;
  clientType: 'APP' | 'DEV' | '?';
  sn: string | null;
  direction: '→DEV' | '←DEV' | '';
  topic: string;
  payload: string;               // max 2000 chars
  encrypted: boolean;
}
```

---

## 7. Home Assistant MQTT Bridge

### Environment Variables

```bash
HA_MQTT_HOST=192.168.1.100
HA_MQTT_PORT=1883
HA_MQTT_USER=homeassistant
HA_MQTT_PASS=password
HA_DISCOVERY_PREFIX=homeassistant    # default
HA_THROTTLE_MS=2000                  # min time between publishes
```

### Topics Published to HA

| Topic | QoS | Retain | Content |
|-------|-----|--------|---------|
| `homeassistant/sensor/novabot_<SN>_<field>/config` | 1 | true | Auto-discovery config |
| `novabot/<SN>/<field>` | 0 | true | Sensor state value |
| `novabot/<SN>/raw/<command>` | 0 | true | Full JSON payload |
| `novabot/<SN>/availability` | 0 | true | `"online"` / `"offline"` |
| `novabot/bridge/status` | 1 | true | Bridge status |

### Tracked Sensors

| MQTT Field | HA Name | Component | Unit | Device Class |
|------------|---------|-----------|------|-------------|
| `charger_status` | Charger Status | sensor | — | — |
| `mower_status` | Mower Status | sensor | — | — |
| `battery_capacity` | Battery | sensor | % | battery |
| `battery_power` | Battery | sensor | % | battery |
| `battery_state` | Battery State | sensor | — | — |
| `cpu_temperature` | CPU Temperature | sensor | °C | temperature |
| `wifi_rssi` | WiFi Signal | sensor | dBm | signal_strength |
| `rtk_sat` | RTK Satellites | sensor | — | — |
| `loc_quality` | Location Quality | sensor | % | — |
| `mow_blade_work_time` | Blade Work Time | sensor | s | duration |
| `working_hours` | Working Hours | sensor | h | duration |
| `latitude` | Latitude | sensor | — | — |
| `longitude` | Longitude | sensor | — | — |
| `x`, `y`, `z` | Position X/Y/Z | sensor | — | — |
| `button_stop` | Emergency Stop | binary_sensor | — | safety |
| `localization_state` | Localization | sensor | — | — |

---

## 8. Cloud API Authentication

### Login

```
POST /api/nova-user/appUser/login
Body: { email: "...", password: "<AES_encrypted_base64>" }
Response: { ..., accessToken: "<UUID>" }
```

Password encryption: AES-128-CBC, key/IV = `1234123412ABCDEF`, output = base64

### Request Signing (all authenticated requests)

| Header | Value | Description |
|--------|-------|-------------|
| `Authorization` | `<accessToken>` | UUID from login |
| `echostr` | `p` + 12 random hex | Random nonce |
| `nonce` | `1453b963a29b5441b839b18939aaf0817944300b` | **Static:** SHA1("qtzUser") |
| `timestamp` | `String(Date.now())` | Milliseconds |
| `signature` | SHA256(echostr + nonce + timestamp + token) | Request signature |
| `source` | `app` | Fixed |
| `userlanguage` | `en` | Language |

```javascript
const nonce = crypto.createHash('sha1').update('qtzUser', 'utf8').digest('hex');
const sig = crypto.createHash('sha256')
  .update(echostr + nonce + timestamp + token, 'utf8')
  .digest('hex');
```

---

## 9. Command Routing Summary

### Where commands are processed

```
                   ┌─────────────────────────────────────────┐
                   │              MQTT Broker                 │
                   │         (Aedes, port 1883)               │
                   └────┬──────────────┬──────────────┬──────┘
                        │              │              │
            ┌───────────▼───┐  ┌───────▼───────┐  ┌──▼──────────┐
            │   Charger     │  │    Mower       │  │  Flutter     │
            │  ESP32-S3     │  │  Horizon X3    │  │    App       │
            │  (v0.3.6)     │  │  (v5.7.1)      │  │ (v2.3.8+)   │
            └───────┬───────┘  └───────┬────────┘  └─────────────┘
                    │                  │
             ┌──────▼──────┐    ┌──────▼──────┐
             │  9 MQTT     │    │  55+ MQTT    │
             │  commands   │    │  commands    │
             │  handled    │    │  handled     │
             └──────┬──────┘    └──────────────┘
                    │
             ┌──────▼──────┐
             │  LoRa relay │
             │  6 commands │
             │  to mower   │
             └─────────────┘
```

### Commands by handler

| Handler | Command Count | Commands |
|---------|--------------|----------|
| **Charger only** (BLE) | 9 | `get_signal_info`, `get_wifi_info`, `set_wifi_info`, `set_mqtt_info`, `set_lora_info`, `set_rtk_info`, `get_cfg_info`, `set_cfg_info`, `get_dev_info` |
| **Charger only** (MQTT, local) | 3 | `get_lora_info`, `ota_version_info`, `ota_upgrade_cmd` |
| **Charger** (MQTT→LoRa relay) | 6 | `start_run`, `pause_run`, `resume_run`, `stop_run`, `stop_time_run`, `go_pile` |
| **Mower** (MQTT, direct) | 55+ | All navigation, mapping, management, diagnostics, patrol, area_set, parameters, PIN, timer, etc. |

### Commands available via both paths

| Command | Charger Path (LoRa) | Mower Path (MQTT) |
|---------|--------------------|--------------------|
| `start_run` | Limited fields (mapName, area, cutterhigh) | Full fields (mapNames[], workArea, schedule, etc.) |
| `pause_run` | `{}` | `{}` |
| `resume_run` | `{}` | `{}` |
| `stop_run` | `{}` | `{}` |
| `go_pile` / `go_to_charge` | `go_pile` via LoRa | `go_to_charge` via MQTT |

### ROS 2 Service Mapping (Mower)

| ROS Service | MQTT Command | Service Definition |
|-------------|-------------|-------------------|
| `/robot_decision/start_cov_task` | `start_run` | `StartCoverageTask.srv` |
| `/robot_decision/stop_task` | `stop_run` | — |
| `/robot_decision/start_mapping` | `start_scan_map` | `StartMapping.srv` |
| `/robot_decision/map_stop_record` | `stop_scan_map` | — |
| `/robot_decision/save_map` | `save_map` | `SaveMap.srv` |
| `/robot_decision/delete_map` | `delete_map` | `DeleteMap.srv` |
| `/robot_decision/reset_mapping` | `reset_map` | — |
| `/robot_decision/start_assistant_mapping` | `start_assistant_build_map` | — |
| `/robot_decision/add_area` | `area_set` | — |
| `/robot_decision/save_charging_pose` | `save_recharge_pos` | — |
| `/robot_decision/nav_to_recharge` | `go_to_charge` | — |
| `/robot_decision/cancel_recharge` | `stop_to_charge` | — |
| `/robot_decision/auto_recharge` | `auto_recharge` | — |
| `/robot_decision/generate_preview_cover_path` | `generate_preview_cover_path` | `GenerateCoveragePath.srv` |
| `/robot_decision/quit_mapping_mode` | `quit_mapping_mode` | — |
| `/robot_decision/start_erase` | `start_erase_map` | — |
| `/robot_decision/start_boundary_follow` | `start_patrol` | `BoundaryFollow` (action) |

---

## Appendix A: Complete MQTT Command List (Alphabetical)

| # | Command | Response | Source | Charger | Mower |
|---|---------|----------|--------|---------|-------|
| 1 | `add_scan_map` | `add_scan_map_respond` | App | — | ✅ |
| 2 | `area_set` | `area_set_respond` | App | — | ✅ |
| 3 | `auto_charge_threshold` | `auto_charge_threshold_respond` | App | — | ✅ |
| 4 | `auto_connect` | — | App | — | ✅ |
| 5 | `auto_recharge` | `auto_recharge_respond` | App | — | ✅ |
| 6 | `delete_map` | `delete_map_respond` | App | — | ✅ |
| 7 | `dev_pin_info` | `dev_pin_info_respond` | App | — | ✅ |
| 8 | `gbf` | `gbf_respond` | FW | — | ✅ |
| 9 | `generate_preview_cover_path` | `generate_preview_cover_path_respond` | App | — | ✅ |
| 10 | `get_cfg_info` | `get_cfg_info_respond` | App | BLE | ✅ |
| 11 | `get_control_mode` | `get_control_mode_respond` | App | — | ✅ |
| 12 | `get_current_pose` | `get_current_pose_respond` | App | — | ✅ |
| 13 | `get_dev_info` | `get_dev_info_respond` | App | BLE | ✅ |
| 14 | `get_log_info` | `get_log_info_respond` | App | — | ✅ |
| 15 | `get_lora_info` | `get_lora_info_respond` | App | MQTT | ✅ |
| 16 | `get_map_info` | `get_map_info_respond` | App | — | ✅ |
| 17 | `get_map_list` | `get_map_list_respond` | App | — | ✅ |
| 18 | `get_map_outline` | `report_state_map_outline` | App | — | ✅ |
| 19 | `get_map_plan_path` | `get_map_plan_path_respond` | App | — | ✅ |
| 20 | `get_mapping_path2d` | `get_mapping_path2d_respond` | App | — | ✅ |
| 21 | `get_para_info` | `get_para_info_respond` | App | — | ✅ |
| 22 | `get_preview_cover_path` | `get_preview_cover_path_respond` | App | — | ✅ |
| 23 | `get_recharge_pos` | `get_recharge_pos_respond` | App | — | ✅ |
| 24 | `get_vel_odom` | `get_vel_odom_respond` | App | — | ✅ |
| 25 | `get_version_info` | `get_version_info_respond` | App | — | ✅ |
| 26 | `go_pile` | `go_pile_respond` | App | LoRa | — |
| 27 | `go_to_charge` | `go_to_charge_respond` | App | — | ✅ |
| 28 | `mst` | `mst_respond` | FW | — | ✅ |
| 29 | `navigate_to_position` | `navigate_to_position_respond` | App | — | ✅ |
| 30 | `no_set_pin_code` | — | App | — | ✅ |
| 31 | `ota_upgrade_cmd` | `ota_upgrade_cmd_respond` | App | MQTT | ✅ |
| 32 | `ota_version_info` | `ota_version_info_respond` | App | MQTT | ✅ |
| 33 | `pause_navigation` | `pause_navigation_respond` | App | — | ✅ |
| 34 | `pause_run` | `pause_run_respond` | App | LoRa | ✅ |
| 35 | `quit_mapping_mode` | — | App | — | ✅ |
| 36 | `rename_map` | `rename_map_respond` | App | — | ✅ |
| 37 | `request_map_ids` | — | App | — | ✅ |
| 38 | `reset_map` | `reset_map_respond` | App | — | ✅ |
| 39 | `resume_navigation` | `resume_navigation_respond` | App | — | ✅ |
| 40 | `resume_run` | `resume_run_respond` | App | LoRa | ✅ |
| 41 | `save_map` | `save_map_respond` | App | — | ✅ |
| 42 | `save_recharge_pos` | `save_recharge_pos_respond` | App | — | ✅ |
| 43 | `set_control_mode` | `set_control_mode_respond` | App | — | ✅ |
| 44 | `set_navigation_max_speed` | `set_navigation_max_speed_respond` | App | — | ✅ |
| 45 | `set_para_info` | `set_para_info_respond` | App | — | ✅ |
| 46 | `start_assistant_build_map` | `start_assistant_build_map_respond` | App | — | ✅ |
| 47 | `start_erase_map` | `start_erase_map_respond` | App | — | ✅ |
| 48 | `start_move` | — | App | — | ✅ |
| 49 | `start_navigation` | `start_navigation_respond` | App | — | ✅ |
| 50 | `start_patrol` | `start_patrol_respond` | App | — | ✅ |
| 51 | `start_run` | `start_run_respond` | App | LoRa | ✅ |
| 52 | `start_scan_map` | `start_scan_map_respond` | App | — | ✅ |
| 53 | `stop_erase_map` | `stop_erase_map_respond` | App | — | ✅ |
| 54 | `stop_move` | — | App | — | ✅ |
| 55 | `stop_navigation` | `stop_navigation_respond` | App | — | ✅ |
| 56 | `stop_patrol` | `stop_patrol_respond` | App | — | ✅ |
| 57 | `stop_run` | `stop_run_respond` | App | LoRa | ✅ |
| 58 | `stop_scan_map` | `stop_scan_map_respond` | App | — | ✅ |
| 59 | `stop_time_run` | `stop_time_run_respond` | Charger | LoRa | — |
| 60 | `stop_to_charge` | `stop_to_charge_respond` | App | — | ✅ |
| 61 | `timer_task` | — | App | — | ✅ |
| 62 | `update_virtual_wall` | `update_virtual_wall_respond` | App | — | ✅ |

## Appendix B: External URLs

| URL | Purpose |
|-----|---------|
| `https://app.lfibot.com` | Cloud API server |
| `mqtt.lfibot.com:1883` | Production MQTT broker |
| `mqtt-dev.lfibot.com` | Development MQTT broker |
| `47.253.145.99` | Cloud server IP (app.lfibot.com) |
| `47.253.57.111` | Fallback MQTT IP (charger firmware) |
| `https://novabot-oss.oss-us-east-1.aliyuncs.com/novabot-file/` | OTA firmware CDN |
| `https://novabot-oss.oss-accelerate.aliyuncs.com/novabot-file/` | OTA firmware CDN (accelerated) |
| `https://novabot-oss.oss-us-east-1.aliyuncs.com/novabot-document/` | PDF manuals |
| `https://lfibot.zendesk.com/hc/en-gb` | Support/helpdesk |
| `https://novabot.com/` | Public website |

## Appendix C: Database Schema

| Table | Purpose |
|-------|---------|
| `users` | User accounts (email, bcrypt password, machine_token) |
| `email_codes` | Temporary verification codes |
| `equipment` | Bound devices (mower_sn PK, charger_sn, mac_address) |
| `device_registry` | Auto-learned via MQTT CONNECT (sn, mac, last_seen) |
| `maps` | Map metadata (polygons in JSON, storage/maps/ for files) |
| `map_uploads` | Fragmented upload tracking |
| `cut_grass_plans` | Mowing schedules per device |
| `robot_messages` | Device → user messages |
| `work_records` | Mowing session history |
| `equipment_lora_cache` | Cached LoRa params (survives unbind) |
| `ota_versions` | OTA firmware versions |
| `map_calibration` | Manual map offset/rotation/scale per mower |
| `dashboard_schedules` | Dashboard schedules (CRUD + MQTT push) |
