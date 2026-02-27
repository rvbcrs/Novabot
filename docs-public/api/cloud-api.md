# Cloud API (App → Server)

All endpoints below are called by the **Novabot Flutter app**.
Original base URL: `https://app.lfibot.com` → local `http://<server-ip>:3000`

All authenticated endpoints require a JWT `Authorization` header.
See [Authentication](authentication.md) for details.

---

## nova-user: AppUser

### POST `/api/nova-user/appUser/login`

Login with email and password.

**Auth**: None

```json title="Request"
{
  "email": "user@example.com",
  "password": "AES-encrypted-password"
}
```


!!! lock "Private section"
    This section contains sensitive security details (encryption keys, credentials,
    vulnerability specifics) and is only available in the private wiki.


```json title="Response → value"
{
  "appUserId": "uuid-string",
  "email": "user@example.com",
  "phone": null,
  "firstName": null,
  "lastName": null,
  "accessToken": "jwt-token",
  "newUserFlag": 0,
  "country": null,
  "city": null,
  "address": null,
  "coordinates": null
}
```

---

### POST `/api/nova-user/appUser/regist`

Register a new user account.

**Auth**: None

```json title="Request"
{
  "email": "user@example.com",
  "password": "AES-encrypted-password",
  "username": "optional-name"
}
```

```json title="Response → value"
{
  "appUserId": "uuid-string",
  "email": "user@example.com",
  "token": "jwt-token"
}
```

---

### POST `/api/nova-user/appUser/loginOut`

Logout current session.

**Auth**: JWT

```json title="Request"
{}
```

---

### GET `/api/nova-user/appUser/appUserInfo`

Get current user profile.

**Auth**: JWT

| Query Param | Type | Description |
|-------------|------|-------------|
| `email` | string | Optional email filter |

```json title="Response → value"
{
  "appUserId": "uuid",
  "email": "user@example.com",
  "username": "name",
  "machineToken": "FCM-push-token"
}
```

---

### POST `/api/nova-user/appUser/appUserInfoUpdate`

Update user profile.

**Auth**: JWT

```json title="Request"
{
  "username": "new-name"
}
```

---

### POST `/api/nova-user/appUser/appUserPwdUpdate`

Change password.

**Auth**: JWT

```json title="Request"
{
  "oldPassword": "AES-encrypted",
  "newPassword": "AES-encrypted"
}
```

---

### POST `/api/nova-user/appUser/deleteAccount`

Delete user account permanently.

**Auth**: JWT

---

### POST `/api/nova-user/appUser/updateAppUserMachineToken`

Update FCM push notification token.

**Auth**: JWT

```json title="Request"
{
  "machineToken": "firebase-cloud-messaging-token"
}
```

!!! note "machineToken is NOT for MQTT"
    This is a Firebase Cloud Messaging token for push notifications, not related to MQTT authentication.

---

## nova-user: Validate

### POST `/api/nova-user/validate/sendAppRegistEmailCode`

Send registration verification email.

**Auth**: None

```json title="Request"
{
  "email": "user@example.com"
}
```

---

### POST `/api/nova-user/validate/validAppRegistEmailCode`

Validate registration email code.

**Auth**: None

```json title="Request"
{
  "email": "user@example.com",
  "code": "123456"
}
```

---

### POST `/api/nova-user/validate/sendAppResetPwdEmailCode`

Send password reset email.

**Auth**: None

```json title="Request"
{
  "email": "user@example.com"
}
```

---

### POST `/api/nova-user/validate/verifyAndResetAppPwd`

Verify code and reset password.

**Auth**: None

```json title="Request"
{
  "email": "user@example.com",
  "code": "123456",
  "newPassword": "AES-encrypted"
}
```

---

## nova-user: Equipment

### POST `/api/nova-user/equipment/userEquipmentList`

List all bound equipment for user.

**Auth**: JWT

```json title="Request"
{
  "appUserId": "uuid",
  "pageSize": 100,
  "pageNo": 1
}
```

```json title="Response → value"
{
  "pageNo": 1,
  "pageSize": 100,
  "totalSize": 2,
  "totalPage": 1,
  "pageList": [
    {
      "equipmentId": 755,
      "email": "",
      "deviceType": "charger",
      "sn": "LFIC1230700XXX",
      "equipmentCode": "LFIC1230700XXX",
      "equipmentName": "LFIC1230700XXX",
      "equipmentType": "LFIC1",
      "userId": 0,
      "sysVersion": "v0.3.6",
      "period": "2029-02-22 00:00:00",
      "status": 1,
      "online": true,
      "activationTime": "2026-02-21 18:32:12",
      "macAddress": "48:27:E2:1B:A4:0A",
      "chargerAddress": 718,
      "chargerChannel": 16,
      "account": "<mqtt-username>",
      "password": "<mqtt-password>",
      "videoTutorial": null,
      "model": null,
      "wifiName": null,
      "wifiPassword": null
    }
  ]
}
```

!!! warning "App parses specific field names"
    The app's `EquipmentEntity.fromJson` expects exactly these fields:
    `chargerSn`, `chargerVersion`, `equipmentId`, `equipmentNickName`, `equipmentTypeH`,
    `macAddress`, `mowerVersion`, `online`, `status`, `chargerAddress`, `chargerChannel`, `userId`

---

### POST `/api/nova-user/equipment/getEquipmentBySN`

Get equipment details by serial number.

**Auth**: JWT

```json title="Request"
{
  "sn": "LFIC1230700XXX",
  "deviceType": "charger"
}
```

```json title="Response → value (charger)"
{
  "equipmentId": 755,
  "email": "",
  "deviceType": "charger",
  "sn": "LFIC1230700XXX",
  "equipmentCode": "LFIC1230700XXX",
  "equipmentName": "LFIC1230700XXX",
  "equipmentType": "LFIC1",
  "userId": 0,
  "sysVersion": "v0.3.6",
  "period": "2029-02-22 00:00:00",
  "status": 1,
  "activationTime": "2026-02-21 18:32:12",
  "importTime": "2023-08-23 18:22:48",
  "batteryState": null,
  "macAddress": "48:27:E2:1B:A4:0A",
  "chargerAddress": 718,
  "chargerChannel": 16,
  "account": "<mqtt-username>",
  "password": "<mqtt-password>"
}
```

```json title="Response → value (mower)"
{
  "equipmentId": 756,
  "deviceType": "mower",
  "sn": "LFIN2230700XXX",
  "macAddress": "50:41:1C:39:BD:C1",
  "chargerAddress": null,
  "chargerChannel": null,
  "account": null,
  "password": null
}
```

!!! info "MAC address = BLE MAC"
    The cloud returns the **BLE MAC** (not WiFi STA MAC). The app matches this against BLE manufacturer data during scanning.

---

### POST `/api/nova-user/equipment/bindingEquipment`

Bind equipment to user account.

**Auth**: JWT

```json title="Request"
{
  "mowerSn": "LFIN2230700XXX",
  "chargerSn": "LFIC1230700XXX",
  "equipmentTypeH": "Novabot",
  "userCustomDeviceName": "My Mower",
  "chargerChannel": 15
}
```

```json title="Response → value"
null
```

!!! note
    `chargerChannel` comes from the `set_lora_info_respond` value during BLE provisioning.

---

### POST `/api/nova-user/equipment/unboundEquipment`

Unbind equipment from user.

**Auth**: JWT

```json title="Request"
{
  "sn": "LFIN2230700XXX",
  "equipmentId": "equipment-uuid"
}
```

---

### POST `/api/nova-user/equipment/updateEquipmentNickName`

Rename equipment.

**Auth**: JWT

```json title="Request"
{
  "equipmentId": "uuid",
  "equipmentNickName": "Garden Mower"
}
```

---

### POST `/api/nova-user/equipment/updateEquipmentVersion`

Update firmware version record.

**Auth**: JWT

```json title="Request"
{
  "equipmentId": "uuid",
  "mowerVersion": "v5.7.1",
  "chargerVersion": "v0.3.6"
}
```

---

## nova-user: OTA Upgrade

### GET `/api/nova-user/otaUpgrade/checkOtaNewVersion`

Check for new firmware version. Returns the latest available firmware for the given equipment type.

**Auth**: JWT

| Query Param | Type | Example | Description |
|-------------|------|---------|-------------|
| `version` | string | `v0.0.0` | Current firmware version (use `v0.0.0` to always get latest) |
| `upgradeType` | string | `serviceUpgrade` | Upgrade type |
| `equipmentType` | string | `LFIN2` | First 5 chars of SN |
| `sn` | string | `LFIN2230700238` | Device serial number (optional, ignored by cloud) |

```json title="Response → value (update available)"
{
  "version": "v5.7.1",
  "upgradeType": "serviceUpgrade",
  "md5": "<md5-checksum>",
  "downloadUrl": "https://<oss-host>/novabot-file/<firmware-file>.deb",
  "upgradeFlag": 0,
  "environment": "trial",
  "dependenceSystemVersionList": null
}
```

```json title="Response → value (no update)"
null
```

!!! warning "Cloud ignores SN parameter"
    The cloud OTA API returns the **same firmware version for ALL serial numbers** of a given equipment type. The `sn` parameter is ignored — there is no per-device versioning via this endpoint. Firmware v6.0.3 (seen pushed to select users) was likely delivered via direct MQTT `ota_upgrade_cmd`, not through this API.

**Known firmware versions per equipment type:**

| Equipment Type | Version | Description |
|---------------|---------|-------------|
| `LFIN2` | v5.7.1 | Mower (Debian/ROS 2, 35MB) |
| `LFIN1` | v5.7.1 | Mower (older model) |
| `LFIC1` | v0.3.6 | Charger (ESP32-S3, 1.4MB) |
| `LFIC2` | v0.3.6 | Charger (variant) |
| `LFIN3`, `LFIC3`, `LFI01`, `N1000`, `N2000` | v0.3.6 | Various equipment types |

---

## nova-data: Cut Grass Plans

### GET `/api/nova-data/appManage/queryCutGrassPlan`

Get all mowing schedules for equipment.

**Auth**: JWT

| Query Param | Type | Description |
|-------------|------|-------------|
| `equipmentId` | string | Equipment UUID |

```json title="Response → value"
[
  {
    "planId": "uuid",
    "equipmentId": "uuid",
    "startTime": "08:00",
    "endTime": "12:00",
    "weekday": [1, 3, 5],
    "repeat": true,
    "repeatCount": 0,
    "repeatType": "weekly",
    "workTime": 240,
    "workArea": ["map0"],
    "workDay": ["Mon", "Wed", "Fri"]
  }
]
```

---

### POST `/api/nova-data/appManage/saveCutGrassPlan`

Create a new mowing schedule.

**Auth**: JWT

```json title="Request"
{
  "equipmentId": "uuid",
  "startTime": "08:00",
  "endTime": "12:00",
  "weekday": [1, 3, 5],
  "repeat": true,
  "repeatCount": 0,
  "repeatType": "weekly",
  "workTime": 240,
  "workArea": ["map0"],
  "workDay": ["Mon", "Wed", "Fri"]
}
```

---

### POST `/api/nova-data/appManage/updateCutGrassPlan`

Update an existing schedule.

**Auth**: JWT

```json title="Request"
{
  "planId": "uuid",
  "startTime": "09:00",
  "endTime": "13:00"
}
```

---

### POST `/api/nova-data/appManage/deleteCutGrassPlan`

Delete a schedule.

**Auth**: JWT

```json title="Request"
{
  "planId": "uuid"
}
```

---

### POST `/api/nova-data/appManage/queryNewVersion`

Check for new app version.

**Auth**: None

```json title="Response → value"
{
  "version": "2.3.9",
  "hasNewVersion": false
}
```

---

### GET `/api/nova-data/cutGrassPlan/queryRecentCutGrassPlan`

Get most recent schedule.

**Auth**: JWT

| Query Param | Type | Description |
|-------------|------|-------------|
| `equipmentId` | string | Equipment UUID |

---

## nova-file-server: Maps

### GET `/api/nova-file-server/map/queryEquipmentMap`

Get all maps for equipment.

**Auth**: JWT

| Query Param | Type | Description |
|-------------|------|-------------|
| `sn` | string | Serial number |

```json title="Response → value"
[
  {
    "mapId": "uuid",
    "mowerSn": "LFIN2230700XXX",
    "mapName": "Garden",
    "mapArea": [[52.141, 6.231], [52.142, 6.232]],
    "mapMaxMin": null,
    "fileSize": 1024,
    "createdAt": "2026-02-21T18:32:12Z",
    "updatedAt": "2026-02-21T18:32:12Z"
  }
]
```

---

### POST `/api/nova-file-server/map/fragmentUploadEquipmentMap`

Upload map data in chunks (from app).

**Auth**: JWT

**Content-Type**: `multipart/form-data`

| Field | Type | Description |
|-------|------|-------------|
| `sn` | string | Serial number |
| `uploadId` | string | Upload session ID |
| `fileSize` | number | Total file size |
| `chunkIndex` | number | Current chunk index |
| `chunksTotal` | number | Total number of chunks |
| `mapName` | string | Map name |
| `mapArea` | string | JSON polygon coordinates |
| `mapMaxMin` | string | Bounding box |
| `file` | binary | Chunk data |

```json title="Response → value"
{
  "mapId": "uuid",
  "uploadId": "upload-id",
  "complete": true,
  "chunksReceived": 5,
  "chunksTotal": 5
}
```

---

### POST `/api/nova-file-server/map/updateEquipmentMapAlias`

Rename a map.

**Auth**: JWT

```json title="Request"
{
  "mapId": "uuid",
  "mapName": "New Name"
}
```

---

## nova-file-server: Logs

### POST `/api/nova-file-server/log/uploadAppOperateLog`

Upload app operation logs.

**Auth**: JWT

**Content-Type**: `multipart/form-data`

| Field | Type | Description |
|-------|------|-------------|
| `file` | binary | Log file |

---

## novabot-message

### GET `/api/novabot-message/message/queryRobotMsgPageByUserId`

Get robot messages with pagination.

**Auth**: JWT

| Query Param | Type | Description |
|-------------|------|-------------|
| `page` | number | Page number |
| `limit` | number | Items per page |

```json title="Response → value"
{
  "total": 10,
  "page": 1,
  "limit": 20,
  "list": [
    {
      "messageId": "uuid",
      "type": "error",
      "content": "Blade motor stalled",
      "createdAt": "2026-02-21T18:32:12Z",
      "read": false
    }
  ]
}
```

---

### POST `/api/novabot-message/message/queryMsgMenuByUserId`

Get unread message counts.

**Auth**: JWT

```json title="Response → value"
{
  "robotMsgUnreadCount": 3,
  "workRecordUnreadCount": 1
}
```

---

### POST `/api/novabot-message/message/updateMsgByUserId`

Mark messages as read.

**Auth**: JWT

```json title="Request"
{
  "messageIds": ["uuid1", "uuid2"]
}
```

---

### POST `/api/novabot-message/message/deleteMsgByUserId`

Delete messages.

**Auth**: JWT

```json title="Request"
{
  "messageIds": ["uuid1", "uuid2"]
}
```

---

### GET `/api/novabot-message/message/queryCutGrassRecordPageByUserId`

Get mowing work records with pagination.

**Auth**: JWT

| Query Param | Type | Description |
|-------------|------|-------------|
| `page` | number | Page number |
| `limit` | number | Items per page |

---

## nova-network

### POST `/api/nova-network/network/connection`

Connectivity check. Called by both the **app** (~5 second interval) and **mower firmware**.

**Auth**: None

```json title="Response"
{
  "success": true,
  "code": 200,
  "message": "request success",
  "value": 1
}
```
