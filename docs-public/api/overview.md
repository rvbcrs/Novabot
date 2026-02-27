# HTTP API Overview

The Novabot ecosystem has **three categories** of HTTP API endpoints:

## 1. Cloud API (App → Server)

These endpoints are called by the **Flutter app** and are the original cloud API replicated locally.
Base URL: `https://app.lfibot.com` → local `http://<server-ip>:3000`

| Service | Path Prefix | Auth | Endpoints |
|---------|------------|------|-----------|
| [nova-user](cloud-api.md#nova-user-appuser) | `/api/nova-user/appUser/` | JWT | 8 |
| [nova-user validate](cloud-api.md#nova-user-validate) | `/api/nova-user/validate/` | None | 4 |
| [nova-user equipment](cloud-api.md#nova-user-equipment) | `/api/nova-user/equipment/` | JWT | 6 |
| [nova-user OTA](cloud-api.md#nova-user-ota-upgrade) | `/api/nova-user/otaUpgrade/` | JWT | 1 |
| [nova-data plans](cloud-api.md#nova-data-cut-grass-plans) | `/api/nova-data/appManage/` | JWT | 4 |
| [nova-data plans](cloud-api.md#nova-data-cut-grass-plans) | `/api/nova-data/cutGrassPlan/` | JWT | 1 |
| [nova-file-server maps](cloud-api.md#nova-file-server-maps) | `/api/nova-file-server/map/` | JWT | 3 |
| [nova-file-server logs](cloud-api.md#nova-file-server-logs) | `/api/nova-file-server/log/` | JWT | 1 |
| [novabot-message](cloud-api.md#novabot-message) | `/api/novabot-message/message/` | JWT | 5 |
| [nova-network](cloud-api.md#nova-network) | `/api/nova-network/network/` | None | 1 |

## 2. Dashboard API (Local)

These endpoints serve the **React web dashboard** and are not part of the original cloud API.

| Path Prefix | Auth | Endpoints |
|------------|------|-----------|
| [`/api/dashboard/`](dashboard-api.md) | None | 24 |
| [`/api/admin/`](dashboard-api.md#admin-endpoints) | None | 2 |

## 3. Mower → Server API

These endpoints are called by the **mower firmware** (`mqtt_node` via libcurl).

| Path | Auth | Purpose |
|------|------|---------|
| [`/api/nova-file-server/map/uploadEquipmentMap`](mower-api.md#uploadequipmentmap) | None | Map ZIP upload after mapping |
| [`/api/nova-file-server/map/uploadEquipmentTrack`](mower-api.md#uploadequipmenttrack) | None | Mowing path upload |
| [`/api/nova-data/cutGrassPlan/queryPlanFromMachine`](mower-api.md#queryplanfrommachine) | None | Fetch schedules |
| [`/api/nova-data/equipmentState/saveCutGrassRecord`](mower-api.md#savecutgrassrecord) | None | Save mowing results |
| [`/api/novabot-message/machineMessage/saveCutGrassMessage`](mower-api.md#savecutgrassmessage) | None | Save notification |
| [`/api/nova-user/equipment/machineReset`](mower-api.md#machinereset) | None | Device unbind/reset |
| [`/api/nova-network/network/connection`](mower-api.md#connection) | None | Connectivity check |
| [`/x3/log/upload`](mower-api.md#log-upload) | None | Mower log upload (50MB limit) |

## Response Format

All cloud API endpoints use a standard wrapper:

```json
{
  "success": true,
  "code": 200,
  "message": "request success",
  "value": { /* endpoint-specific data */ }
}
```

Dashboard API endpoints use:

```json
{
  "ok": true,
  "data": { /* or specific field names */ }
}
```

## Authentication

See [Authentication](authentication.md) for details on JWT tokens and cloud API signatures.
