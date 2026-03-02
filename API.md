<\!-- Referentiebestand — gebruik @API.md.md om dit te laden in een sessie -->
## Alle API endpoints (app → server)

Alle endpoints op `https://app.lfibot.com` → lokaal `http://Mac-IP:3000`

| Service           | Endpoint                                              | Geïmplementeerd |
|-------------------|-------------------------------------------------------|-----------------|
| nova-user         | POST appUser/login                                    | ✅              |
| nova-user         | POST appUser/regist                                   | ✅              |
| nova-user         | POST appUser/loginOut                                 | ✅              |
| nova-user         | GET  appUser/appUserInfo?email=                       | ✅              |
| nova-user         | POST appUser/appUserInfoUpdate                        | ✅              |
| nova-user         | POST appUser/appUserPwdUpdate                         | ✅              |
| nova-user         | POST appUser/deleteAccount                            | ✅              |
| nova-user         | POST appUser/updateAppUserMachineToken                | ✅              |
| nova-user         | POST equipment/bindingEquipment                       | ✅              |
| nova-user         | POST equipment/getEquipmentBySN                       | ✅              |
| nova-user         | POST equipment/userEquipmentList                      | ✅              |
| nova-user         | POST equipment/unboundEquipment                       | ✅              |
| nova-user         | POST equipment/updateEquipmentNickName                | ✅              |
| nova-user         | POST equipment/updateEquipmentVersion                 | ✅              |
| nova-user         | GET  otaUpgrade/checkOtaNewVersion?version=           | ✅              |
| nova-user         | POST validate/sendAppRegistEmailCode                  | ✅              |
| nova-user         | POST validate/sendAppResetPwdEmailCode                | ✅              |
| nova-user         | POST validate/validAppRegistEmailCode                 | ✅              |
| nova-user         | POST validate/verifyAndResetAppPwd                    | ✅              |
| nova-data         | GET  appManage/queryCutGrassPlan                      | ✅              |
| nova-data         | POST appManage/saveCutGrassPlan                       | ✅              |
| nova-data         | POST appManage/updateCutGrassPlan                     | ✅              |
| nova-data         | POST appManage/deleteCutGrassPlan                     | ✅              |
| nova-data         | POST appManage/queryNewVersion                        | ✅              |
| nova-data         | GET  cutGrassPlan/queryRecentCutGrassPlan             | ✅              |
| nova-file-server  | GET  map/queryEquipmentMap?sn=                        | ✅              |
| nova-file-server  | POST map/fragmentUploadEquipmentMap                   | ✅              |
| nova-file-server  | POST map/updateEquipmentMapAlias                      | ✅              |
| nova-file-server  | POST log/uploadAppOperateLog                          | ✅              |
| novabot-message   | GET  message/queryRobotMsgPageByUserId                | ✅              |
| novabot-message   | POST message/queryMsgMenuByUserId                     | ✅              |
| novabot-message   | POST message/updateMsgByUserId                        | ✅              |
| novabot-message   | POST message/deleteMsgByUserId                        | ✅              |
| novabot-message   | GET  message/queryCutGrassRecordPageByUserId          | ✅              |
| nova-network      | POST network/connection                                | ✅              |

### Admin endpoints (lokaal, geen auth)
- `GET  /api/admin/devices` — alle bekende apparaten uit device_registry
- `POST /api/admin/devices/:sn/mac` — handmatig MAC registreren `{macAddress: "AA:BB:..."}`

### Dashboard endpoints (lokaal, geen auth)
- `GET    /api/dashboard/devices` — alle apparaten met sensor snapshots
- `GET    /api/dashboard/sensors` — sensor definities
- `GET    /api/dashboard/maps/:sn` — kaarten voor een apparaat
- `PATCH  /api/dashboard/maps/:sn/:mapId` — kaart updaten (mapName, mapArea)
- `POST   /api/dashboard/maps/:sn` — nieuwe kaart aanmaken
- `DELETE /api/dashboard/maps/:sn/:mapId` — kaart verwijderen
- `POST   /api/dashboard/maps/:sn/export-zip` — kaarten exporteren als Novabot ZIP
- `POST   /api/dashboard/maps/convert` — GPS ↔ lokale coördinaten conversie
- `GET    /api/dashboard/trail/:sn` — GPS trail ophalen
- `DELETE /api/dashboard/trail/:sn` — GPS trail wissen
- `GET    /api/dashboard/calibration/:sn` — kaart calibratie ophalen
- `PUT    /api/dashboard/calibration/:sn` — kaart calibratie opslaan
- `POST   /api/dashboard/command/:sn` — MQTT commando naar apparaat sturen
- `GET    /api/dashboard/schedules/:sn` — maaischema's ophalen
- `POST   /api/dashboard/schedules/:sn` — maaischema aanmaken + MQTT push
- `PATCH  /api/dashboard/schedules/:sn/:scheduleId` — maaischema updaten
- `DELETE /api/dashboard/schedules/:sn/:scheduleId` — maaischema verwijderen
- `POST   /api/dashboard/schedules/:sn/:scheduleId/send` — schema naar maaier pushen via MQTT

---

## Database tabellen

| Tabel            | Doel                                                        |
|------------------|-------------------------------------------------------------|
| users            | Gebruikersaccounts (email, bcrypt password, machine_token)  |
| email_codes      | Tijdelijke verificatiecodes voor registratie/wachtwoord reset|
| equipment        | Gekoppelde apparaten (mower_sn PK, charger_sn, mac_address) |
| device_registry  | Automatisch geleerd via MQTT CONNECT (sn, mac, last_seen)   |
| maps             | Kaartmetadata (binaire data op disk in storage/maps/)       |
| map_uploads      | Tracking van gefragmenteerde kaartuploads                   |
| cut_grass_plans  | Maaischema's per apparaat                                   |
| robot_messages   | Berichten van apparaat naar gebruiker                       |
| work_records     | Maaiopnames/werkhistorie                                    |
| equipment_lora_cache | Cached LoRa parameters (behouden na unbind voor re-bind) |
| ota_versions     | OTA firmware versies                                        |
| map_calibration  | Handmatige kaart offset/rotatie/schaal per maaier           |
| dashboard_schedules | Dashboard maaischema's (CRUD, MQTT push naar maaier)     |

---

## Bekende MAC-adres extractie patronen (broker.ts)

```typescript
const MAC_SEP_RE  = /([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}/;   // AA:BB:CC:DD:EE:FF
const MAC_FLAT_RE = /(?<![0-9A-Fa-f])([0-9A-Fa-f]{12})(?![0-9A-Fa-f])/; // AABBCCDDEEFF
const SN_RE       = /LFI[A-Z][0-9]+/;                              // LFIC... of LFIN...
const ESP32_RE    = /ESP32_([0-9A-Fa-f]{6})$/i;                    // ESP32_1bA408
```

---
