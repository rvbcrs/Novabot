# Novabot Application Flows & Command Sequences

> Uitgebreide analyse van de decompiled Flutter source code (v2.4.0). Alle commands, payloads, response events, API endpoints, status velden en joystick/manual control flows.

---

## Inhoudsopgave

1. [Build Map Flow](#1-build-map-flow)
2. [Navigatie & Maaien Flow](#2-navigatie--maaien-flow)
3. [Terugkeer & Opladen Flow](#3-terugkeer--opladen-flow)
4. [Handmatige Besturing (Joystick/D-Pad)](#4-handmatige-besturing-joystickd-pad)
5. [Geavanceerde Instellingen Flow](#5-geavanceerde-instellingen-flow)
6. [Map Beheer Flow](#6-map-beheer-flow)
7. [Cover Path Preview Flow](#7-cover-path-preview-flow)
8. [OTA & Firmware Updates Flow](#8-ota--firmware-updates-flow)
9. [Schedule (Planning) Flow](#9-schedule-planning-flow)
10. [Inkomende Status Berichten (Robot → App)](#10-inkomende-status-berichten-robot--app)
11. [BLE Communicatie Events](#11-ble-communicatie-events)
12. [Cloud API Endpoints](#12-cloud-api-endpoints)
13. [Foutmeldingen Reference](#13-foutmeldingen-reference)
14. [Legacy/Alternatieve Commands](#14-legacyalternatieve-commands)

---

## 1. Build Map Flow

Het creëren van een map volgt een strikt stappenplan. De functies bevinden zich in `build_map_page/logic.dart`.

### Stap 1: Mapping Mode Starten
| | |
|---|---|
| **UI Functie** | `onAotuMappingClick()` / `clickPauseAuto()` |
| **Command** | `start_assistant_build_map` |
| **Response** | `start_assistant_build_map_respond` |

```json
{
  "cmd_num": 1001,
  "type": "start_assistant_build_map"
}
```

### Stap 2: Scannen Starten
| | |
|---|---|
| **UI Functie** | `clickStart()` |
| **Command (eerste keer)** | `start_scan_map` |
| **Command (volgende secties)** | `add_scan_map` |
| **Response** | `start_scan_map_respond` / `add_scan_map_respond` |

```json
{
  "cmd_num": 1002,
  "type": "start_scan_map",
  "start_scan_map": {
    "model": "border",       // "border" of "obstacle"
    "manual": true,          // true = handmatig, false = auto
    "mapName": "MyLawnMap",
    "map0": "..."            // bestaande map data (bij toevoegen)
  }
}
```

### Stap 3: Correcties (Erase / Reset)
| Actie | Functie | Command | Response |
|---|---|---|---|
| Erase starten | `clickRetract()` | `start_erase_map` | `start_erase_map_respond` |
| Erase stoppen | `clickStop()` | `stop_erase_map` | `stop_erase_map_respond` |
| Reset huidig type | `clickReset()` | `reset_map` | `reset_map_respond` |

```json
{
  "cmd_num": 1003,
  "type": "reset_map",
  "reset_map": {
    "boundaries": true       // of "obstacle": true
  }
}
```

**Let op:** `clickReset()` verwerkt ook een `channel` parameter en maakt onderscheid tussen "boundaries" en "obstacle" reset.

### Stap 4: Scannen Afronden
| | |
|---|---|
| **UI Functie** | `clickDone()` |
| **Command** | `stop_scan_map` |
| **Response** | `stop_scan_map_respond` |

```json
{
  "cmd_num": 1004,
  "type": "stop_scan_map",
  "stop_scan_map": {
    "value": 1
  }
}
```

### Stap 5: Oplader Positie Vastleggen
| | |
|---|---|
| **UI Functie** | `_saveChargePosition()` |
| **Command** | `save_recharge_pos` |
| **Response** | `save_recharge_pos_respond` |

```json
{
  "cmd_num": 1005,
  "type": "save_recharge_pos",
  "save_recharge_pos": {
    "mapName": "MyLawnMap",
    "map0": "..."
  }
}
```

### Stap 6: Map Definitief Opslaan
| | |
|---|---|
| **UI Functie** | `_writeSaveMap()` |
| **Command** | `save_map` |
| **Response** | `save_map_respond` |

```json
{
  "cmd_num": 1006,
  "type": "save_map",
  "save_map": {
    "mapName": "MyLawnMap",
    "type": 1
  }
}
```

### Stap 7: Auto Recharge Bevestigen
| | |
|---|---|
| **UI Functie** | `clickConfirm()` |
| **Command** | `auto_recharge` |
| **Response** | `auto_recharge_respond` |

```json
{
  "cmd_num": 1007,
  "type": "auto_recharge"
}
```

### Stap 8: Map Uploaden naar Cloud
| | |
|---|---|
| **UI Functie** | `uploadMapToServce()` |
| **Command** | `get_map_outline` |

```json
{
  "cmd_num": 1008,
  "type": "get_map_outline"
}
```

### Stap 9: Mapping Mode Afsluiten
| | |
|---|---|
| **UI Functie** | `onJoystick()` (in build_map context) |
| **Command** | `quit_mapping_mode` |

```json
{
  "cmd_num": 1009,
  "type": "quit_mapping_mode",
  "quit_mapping_mode": {
    "value": 1
  }
}
```

---

## 2. Navigatie & Maaien Flow

Functies uit `lawn_page/logic.dart` en `online_view.dart`.

### Maaien Starten
| | |
|---|---|
| **UI Functie** | `startMowing()` (lawn_page) / `_clickStart()` (online_view) |
| **Command** | `start_navigation` (nieuw model) of `start_run` (oud model) |
| **Response** | `start_navigation_respond` / `start_run_respond` |

```json
{
  "cmd_num": 2001,
  "type": "start_navigation",
  "start_navigation": {
    "mapName": "MyLawnMap",
    "test": false,
    "cutterhigh": 3,
    "area": 1
  }
}
```

### Maaien Pauzeren
| | |
|---|---|
| **UI Functie** | `_clickPause()` / `_pauseAndBack()` (online_view) |
| **Command** | `pause_navigation` of `pause_run` |
| **Response** | `pause_navigation_respond` / `pause_run_respond` |

```json
{
  "cmd_num": 2002,
  "type": "pause_navigation"
}
```

### Maaien Hervatten
| | |
|---|---|
| **UI Functie** | `_clickContinue()` (online_view) |
| **Command** | `resume_navigation` of `resume_run` |
| **Response** | `resume_navigation_respond` / `resume_run_respond` |

```json
{
  "cmd_num": 2003,
  "type": "resume_navigation"
}
```

### Maaien Stoppen
| | |
|---|---|
| **UI Functie** | `_endAndBack()` (online_view) |
| **Command** | `stop_navigation` of `stop_run` |
| **Response** | `stop_navigation_respond` / `stop_run_respond` |

```json
{
  "cmd_num": 2004,
  "type": "stop_navigation"
}
```

> **Belangrijk:** De app stuurt altijd BEIDE het oude (`start_run`) en het nieuwe (`start_navigation`) command in `startMowing()`. De online_view kiest op basis van het robotmodel welk paar wordt verstuurd (oud vs. nieuw protocol). `_endAndBack()` stuurt na het stoppen ook `go_to_charge` / `go_pile` om de robot terug te sturen.

---

## 3. Terugkeer & Opladen Flow

Functies uit `manul_controller_page/logic.dart`, `online_view.dart` en `home_page/logic.dart`.

### Terug naar Oplader
| | |
|---|---|
| **UI Functie** | `clickConfirm()` (manul_controller) / `gotoCharging()` (online_view) / `_showRetryAutoRechargeTipsDialog()` (home_page) |
| **Command** | `go_to_charge` of `go_pile` (oud protocol) |
| **Response** | `go_to_charge_respond` / `go_pile_respond` |

```json
{
  "cmd_num": 3001,
  "type": "go_to_charge",
  "go_to_charge": {
    "chargerpile": "charger_sn_123",
    "latitude": 52.370216,
    "longitude": 4.895168
  }
}
```

### Laad-terugkeer Stoppen
| | |
|---|---|
| **UI Functie** | `clickStop()` (manul_controller) |
| **Command** | `stop_to_charge` |
| **Response** | `stop_to_charge_respond` |

```json
{
  "cmd_num": 3002,
  "type": "stop_to_charge"
}
```

---

## 4. Handmatige Besturing (Joystick/D-Pad)

Functies uit zowel `manul_controller_page/logic.dart` als `build_map_page/logic.dart`. Beide pagina's hebben identieke joystick-logica.

### D-Pad Knoppen (Hold/Release)
| | |
|---|---|
| **Vasthouden** | `onHolding()` → `start_move` |
| **Loslaten** | `cancelHolding()` → `stop_move` |

```json
{
  "type": "start_move",
  "start_move": {
    "<richting_index>": "<snelheidswaarde>"
  }
}
```

> Wordt verstuurd via **BLE** (`writeDataForMove()`), niet via MQTT!

### Joystick (Analoog)
| | |
|---|---|
| **Bewegen** | `onJoystick()` → `mst` |
| **Stoppen** | `cancelJoystick()` → `stop_move` |

```json
{
  "type": "mst",
  "mst": [<v_snelheid>, <w_rotatie>, 8, ...]
}
```

> `mst` is een compact array formaat met lineaire snelheid (v) en hoeksnelheid (w). Wordt ook via BLE verstuurd.

---

## 5. Geavanceerde Instellingen Flow

Functies uit `advanced_settings_page.dart`.

### Instellingen Ophalen
| | |
|---|---|
| **UI Functie** | `initState()` |
| **Command** | `get_para_info` |
| **Response** | `get_para_info_respond` |

```json
{
  "cmd_num": 5001,
  "type": "get_para_info"
}
```

De response bevat key-value paren met de huidige waarden. De app leest de volgende velden uit het `message` → `result` → `value` pad:

| Veldnaam | Beschrijving |
|---|---|
| `sound` | Geluid aan/uit |
| `headlight` | Koplampen aan/uit |
| `path_direction` | Maaipad richting |
| `obstacle_avoidance_sensitivity` | Gevoeligheid obstakeldetectie |
| `manual_controller_v` | Handmatige besturing lineaire snelheid |
| `manual_controller_w` | Handmatige besturing hoeksnelheid |

### Instellingen Opslaan
| | |
|---|---|
| **UI Functie** | `_confirm()` |
| **Command** | `set_para_info` |
| **Response** | `set_para_info_respond` |

```json
{
  "cmd_num": 5002,
  "type": "set_para_info",
  "set_para_info": {
    "sound": 1,
    "headlight": 0,
    "path_direction": 1,
    "obstacle_avoidance_sensitivity": 2,
    "manual_controller_v": 500,
    "manual_controller_w": 300
  }
}
```

---

## 6. Map Beheer Flow

Functies uit `lawn_page/logic.dart`.

### Map Lijst Ophalen
| | |
|---|---|
| **UI Functie** | `_showRetryDialog()` |
| **Command** | `get_map_list` |
| **Response** | `get_map_list_respond` |

```json
{
  "cmd_num": 6001,
  "type": "get_map_list"
}
```

### Map Verwijderen
| | |
|---|---|
| **UI Functie** | `_sendDeleteMqtt()` |
| **Command** | `delete_map` |
| **Response** | `delete_map_respond` |

```json
{
  "cmd_num": 6002,
  "type": "delete_map",
  "delete_map": {
    "map_name": "MyLawnMap"
  }
}
```

### Map Outline Ophalen
| | |
|---|---|
| **UI Functie** | `_uploadMaps()` / `getOffsetListFromFile()` |
| **Command** | `get_map_outline` |

```json
{
  "cmd_num": 6003,
  "type": "get_map_outline"
}
```

### Oplader Locatie Ophalen
| | |
|---|---|
| **UI Functie** | `_getChargerLocation()` |
| **Command** | `get_recharge_pos` |
| **Response** | `get_recharge_pos_respond` |

```json
{
  "cmd_num": 6004,
  "type": "get_recharge_pos"
}
```

---

## 7. Cover Path Preview Flow

Functies uit `advanced_settings_page.dart` en inkomend in `mqtt_data_handler.dart`.

### Preview Genereren
| | |
|---|---|
| **UI Functie** | `_preview()` |
| **Command** | `generate_preview_cover_path` |
| **Response** | `generate_preview_cover_path_respond` |

```json
{
  "cmd_num": 7001,
  "type": "generate_preview_cover_path",
  "generate_preview_cover_path": {
    "map_ids": [1, 2, 3],
    "cov_direction": 0
  }
}
```

### Plan Path Ophalen (Inkomend via MQTT)
| | |
|---|---|
| **Ontvangst** | `_handlerMowerMsg()` |
| **Event** | `get_map_plan_path` / `get_map_plan_path_respond` |
| **Gerelateerd** | `get_preview_cover_path` / `get_preview_cover_path_respond` |

---

## 8. OTA & Firmware Updates Flow

Functies uit `mqtt_data_handler.dart`.

### OTA Versie Check
| | |
|---|---|
| **Functie** | `_startTimer()` (periodiek) |
| **Command** | `ota_version_info` |
| **Response** | `ota_version_info_respond` |

```json
{
  "cmd_num": 8001,
  "type": "ota_version_info"
}
```

### WiFi Signaalsterkte Ophalen
| | |
|---|---|
| **Response** | `get_wifi_rssi_respond` |

Bevat het veld `wifi_rssi` met de actuele signaalsterkte.

---

## 9. Schedule (Planning) Flow

De schedule functionaliteit gebruikt **Cloud API endpoints** (niet MQTT). Functies uit `schedule/logic.dart`.

### Planningen Ophalen
```
GET /api/nova-data/appManage/queryCutGrassPlan
    params: { sn: "<device_sn>" }
```

### Planning Maken
```
POST /api/nova-data/appManage/saveCutGrassPlan
    body: { sn, weeks: [...], params: {...} }
```

### Planning Wijzigen
```
POST /api/nova-data/appManage/updateCutGrassPlan
    body: { id, sn, weeks: [...], params: {...} }
```

### Planning Verwijderen
```
POST /api/nova-data/appManage/deleteCutGrassPlan
    body: { id: "<schedule_id>", deleteType: "single" | "all" }
```

**Noot:** Wanneer de robot uiteindelijk de schedule moet uitvoeren, stuurt de home_page logic een `schedule` command naar de mower met de bijbehorende `week` en `timezone` data.

---

## 10. Inkomende Status Berichten (Robot → App)

De `_handlerMowerMsg()` functie in `mqtt_data_handler.dart` parseert alle binnenkomende MQTT berichten. De volgende top-level message types worden verwerkt:

### `up_status_info`
Periodiek statusbericht van de mower. Bevat sub-objecten:

| Sub-object | Velden |
|---|---|
| `mower_error` | `error_msg`, `error_status`, `chassis_err` |
| `mower_status` | `work_status`, `recharge_status`, `localization` |
| `mower_info` | `version`, `sn` |

### `report_state_battery`
| Veld | Beschrijving |
|---|---|
| `battery_capacity` | Accu percentage (0-100) |

### `report_state_robot`
| Veld | Beschrijving |
|---|---|
| `work_status` | Huidige werkstatus code |
| `request_map_ids` | Robot vraagt map IDs op |

### `report_state_work`
| Veld | Beschrijving |
|---|---|
| `work_mode` | Werk modus (bijv. maaien, terugkeren) |
| `work_state` | Status binnen de huidige modus |
| `work_scene` | Scène/context |
| `task_mode` | Taak modus |
| `target_height` | Doelhoogte maaiblad |
| `mowing_progress` | Maai voortgang |
| `cov_area` | Gedekt oppervlak |
| `cov_ratio` | Dekkingspercentage |
| `cov_remaining_area` | Resterend oppervlak |
| `covering_area` | Huidig dekkingsgebied |
| `finished_area` | Afgeronde gebieden |
| `finished_maps` | Voltooide maps |

### `report_state_timer_data`
Timer/schedule gerelateerde status data van de mower.

### `report_state_map_outline`
Map contourdata van de robot (punten, positie).

### `report_exception_state`
| Veld | Beschrijving |
|---|---|
| `no_set_pin_code` | Geen PIN code ingesteld |
| (overig) | Diverse fout/exception states |

### `map_position`
Realtime positie tijdens het mappen:
| Veld | Beschrijving |
|---|---|
| `x`, `y` | Robot positie coordinaten |
| `dis` | Afstand |
| `orient_flag` | Oriëntatie/richting vlag |
| `gbf` | GPS-gebaseerde vlag |

### `mowing_progress` (inline)
| Veld | Beschrijving |
|---|---|
| `mower_x`, `mower_y`, `mower_z` | 3D positie |
| `orientation` | Richting |
| `cover_path` / `plan_path` | Paden data |
| `covered` | Gedekt pad data |
| `rtk` | RTK nauwkeurigheid data |

---

## 11. BLE Communicatie Events

Uit `ble_tools.dart` en de `_listenBleData()` functies.

| Event | Beschrijving |
|---|---|
| `ble_start` | BLE verbinding gestart |
| `ble_end` | BLE verbinding beëindigd |
| `le_start` | Low Energy transfer gestart |
| `le_end` | Low Energy transfer beëindigd |

> BLE wordt primair gebruikt voor joystick/movement controls (`start_move`, `stop_move`, `mst`) en voor map position data tijdens het mappen.

---

## 12. Cloud API Endpoints

Alle geïdentificeerde REST API endpoints:

### Gebruikersbeheer (`/api/nova-user/`)
| Endpoint | Beschrijving |
|---|---|
| `appUser/login` | Inloggen |
| `appUser/regist` | Registreren |
| `appUser/loginOut` | Uitloggen |
| `appUser/deleteAccount` | Account verwijderen |
| `appUser/appUserInfo?email=` | Gebruikersinfo ophalen |
| `appUser/appUserInfoUpdate` | Profiel bijwerken |
| `appUser/appUserPwdUpdate` | Wachtwoord wijzigen |
| `appUser/updateAppUserMachineToken` | Machine token bijwerken |

### Apparaatbeheer (`/api/nova-user/equipment/`)
| Endpoint | Beschrijving |
|---|---|
| `bindingEquipment` | Apparaat koppelen |
| `unboundEquipment` | Apparaat ontkoppelen |
| `getEquipmentBySN` | Apparaat ophalen op serienummer |
| `userEquipmentList` | Lijst van gebruikersapparaten |
| `updateEquipmentNickName` | Apparaatnaam wijzigen |
| `updateEquipmentVersion` | Versie bijwerken |

### Validatie (`/api/nova-user/validate/`)
| Endpoint | Beschrijving |
|---|---|
| `sendAppRegistEmailCode` | Registratie e-mail code versturen |
| `sendAppResetPwdEmailCode` | Wachtwordreset code versturen |
| `validAppRegistEmailCode` | Registratie code valideren |
| `verifyAndResetAppPwd` | Wachtwoord resetten |

### Planning & Data (`/api/nova-data/`)
| Endpoint | Beschrijving |
|---|---|
| `appManage/queryCutGrassPlan` | Maaiplanningen ophalen |
| `appManage/saveCutGrassPlan` | Maai-planning opslaan |
| `appManage/updateCutGrassPlan` | Planning bijwerken |
| `appManage/deleteCutGrassPlan` | Planning verwijderen |
| `appManage/queryNewVersion` | Nieuwe app-versie check |
| `cutGrassPlan/queryRecentCutGrassPlan` | Recente planningen ophalen |

### Bestanden & Maps (`/api/nova-file-server/`)
| Endpoint | Beschrijving |
|---|---|
| `map/fragmentUploadEquipmentMap` | Map fragmenten uploaden |
| `map/queryEquipmentMap?sn=` | Map ophalen per serienummer |
| `map/updateEquipmentMapAlias` | Map alias bijwerken |
| `log/uploadAppOperateLog` | App operatie logs uploaden |

### OTA Updates (`/api/nova-user/otaUpgrade/`)
| Endpoint | Beschrijving |
|---|---|
| `checkOtaNewVersion?version=` | OTA firmware update check |

### Berichten (`/api/novabot-message/message/`)
| Endpoint | Beschrijving |
|---|---|
| `queryRobotMsgPageByUserId` | Robot berichten ophalen |
| `queryCutGrassRecordPageByUserId` | Maaigeschiedenis ophalen |
| `queryMsgMenuByUserId` | Berichtenmenu ophalen |
| `updateMsgByUserId` | Berichten updaten (gelezen markeren) |
| `deleteMsgByUserId` | Berichten verwijderen |

---

## 13. Foutmeldingen Reference

Alle geïdentificeerde error strings uit `mower_error_text.dart`:

| Code | Foutmelding |
|---|---|
| 1 | GPS signal is weak and cannot be initialized |
| 2 | Positioning JSON file failed to load |
| 3 | Positioning JSON file failed to save |
| 4 | Perception module error |
| 5 | QR code positioning error |
| 6 | Map loading error |
| 7 | Cover module action error |
| 8 | Cover module internal error |
| 9 | Cover module failed to pause |
| 10 | Return-to-charge action error |
| 11 | Failed to obtain charging location |
| 12 | QR code signal cannot be found |
| 13 | Charging signal cannot be found |
| 14 | Return-to-charge action error (duplicate) |
| 15 | Return-to-charge status error |
| 16 | Lawnmower unable to leave charging station |
| 17 | Request data error |
| 18 | Low battery, cannot start working |
| 19 | Internal service error in mapping module |
| 20 | Mapping service request unreasonable |
| 21 | Software not initialized |
| 22 | Wheels are slipping |
| 23 | Lawnmower is outside the map |
| 24 | Unable to plan mowing paths |
| 25 | Return to charge failed |

---

## 14. Legacy/Alternatieve Commands

De app ondersteunt twee protocol-generaties. Het oude (`*_run`, `go_pile`) en het nieuwe (`*_navigation`, `go_to_charge`):

| Nieuw Protocol | Oud Protocol | Beschrijving |
|---|---|---|
| `start_navigation` | `start_run` | Maaien starten |
| `pause_navigation` | `pause_run` | Maaien pauzeren |
| `resume_navigation` | `resume_run` | Maaien hervatten |
| `stop_navigation` | `stop_run` | Maaien stoppen |
| `go_to_charge` | `go_pile` | Terugkeer naar oplader |

> De `online_view.dart` bevat logica om op basis van het robot-model te bepalen welk protocol (oud of nieuw) verstuurd wordt. Beide protocols verwachten dezelfde payload structuur.

---

## Samenvatting: Alle Commands (Alfabetisch)

| Command | Richting | Kanaal | Sectie |
|---|---|---|---|
| `add_scan_map` | App → Mower | MQTT | Build Map |
| `auto_recharge` | App → Mower | MQTT | Build Map |
| `delete_map` | App → Mower | MQTT | Map Beheer |
| `generate_preview_cover_path` | App → Mower | MQTT | Cover Path |
| `get_map_list` | App → Mower | MQTT | Map Beheer |
| `get_map_outline` | App → Mower | MQTT | Map Beheer |
| `get_map_plan_path` | App → Mower | MQTT | Cover Path |
| `get_para_info` | App → Mower | MQTT | Instellingen |
| `get_preview_cover_path` | App → Mower | MQTT | Cover Path |
| `get_recharge_pos` | App → Mower | MQTT | Map Beheer |
| `get_wifi_rssi` | App → Mower | MQTT | Status |
| `go_pile` | App → Mower | MQTT | Opladen (oud) |
| `go_to_charge` | App → Mower | MQTT | Opladen |
| `mst` | App → Mower | **BLE** | Joystick |
| `ota_version_info` | App → Mower | MQTT | OTA |
| `pause_navigation` | App → Mower | MQTT | Navigatie |
| `pause_run` | App → Mower | MQTT | Navigatie (oud) |
| `quit_mapping_mode` | App → Mower | MQTT | Build Map |
| `request_map_ids` | Mower → App | MQTT | Status |
| `reset_map` | App → Mower | MQTT | Build Map |
| `resume_navigation` | App → Mower | MQTT | Navigatie |
| `resume_run` | App → Mower | MQTT | Navigatie (oud) |
| `save_map` | App → Mower | MQTT | Build Map |
| `save_recharge_pos` | App → Mower | MQTT | Build Map |
| `schedule` | App → Mower | MQTT | Planning |
| `set_para_info` | App → Mower | MQTT | Instellingen |
| `start_assistant_build_map` | App → Mower | MQTT | Build Map |
| `start_erase_map` | App → Mower | MQTT | Build Map |
| `start_move` | App → Mower | **BLE** | Besturing |
| `start_navigation` | App → Mower | MQTT | Navigatie |
| `start_run` | App → Mower | MQTT | Navigatie (oud) |
| `start_scan_map` | App → Mower | MQTT | Build Map |
| `stop_erase_map` | App → Mower | MQTT | Build Map |
| `stop_move` | App → Mower | **BLE** | Besturing |
| `stop_navigation` | App → Mower | MQTT | Navigatie |
| `stop_run` | App → Mower | MQTT | Navigatie (oud) |
| `stop_scan_map` | App → Mower | MQTT | Build Map |
| `stop_to_charge` | App → Mower | MQTT | Opladen |

### Inkomende Events (Mower → App via MQTT)
| Event | Beschrijving |
|---|---|
| `map_position` | Realtime positie updates (build map) |
| `mowing_progress` | Maai voortgang updates |
| `report_exception_state` | Fout/exception status |
| `report_state_battery` | Accu status |
| `report_state_map_outline` | Map contour data |
| `report_state_robot` | Algemene robot status |
| `report_state_timer_data` | Timer/schedule data |
| `report_state_work` | Werk status |
| `up_status_info` | Periodiek statusbericht |

### Response Events (Bevestigingen)
Elk command heeft een corresponderende `*_respond` event (bijv. `start_navigation_respond`, `save_map_respond`, etc.).
