# Novabot App Commands Overview

Dit is een compleet overzicht van alle commands en berichten die de NovaBot app verstuurt (Published) en ontvangt (Subscribed), inclusief de payload-velden die daarbij horen. Deze data is geëxtraheerd uit de reverse engineered blutter ASM code in de `/flutter_novabot` directory.

## 📤 Verzonden Commands (Published)
Deze commands worden door de app naar de robot of server gestuurd (meestal inclusief een `cmd_num` en/of `type` field).

### `start_scan_map`
**Payload parameters:** `model`, `manual`, `mapName`, `map0`, `type`, `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "start_scan_map",
  "start_scan_map": {
    "model": "voorbeeld_model",
    "manual": true,
    "mapName": "voorbeeld_mapName",
    "map0": "voorbeeld_map0"
  }
}
```
---

### `stop_scan_map`
**Payload parameters:** `value`, `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "stop_scan_map",
  "stop_scan_map": {
    "value": 1
  }
}
```
---

### `add_scan_map`
**Payload parameters:** `model`, `manual`, `mapName`, `type`, `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "add_scan_map",
  "add_scan_map": {
    "model": "voorbeeld_model",
    "manual": true,
    "mapName": "voorbeeld_mapName"
  }
}
```
---

### `save_map`
**Payload parameters:** `mapName`, `type`, `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "save_map",
  "save_map": {
    "mapName": "voorbeeld_mapName"
  }
}
```
---

### `reset_map`
**Payload parameters:** `type`, `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "reset_map"
}
```
---

### `delete_map`
**Payload parameters:** `map_name`, `map_type`, `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "delete_map",
  "delete_map": {
    "map_name": "voorbeeld_map_name",
    "map_type": "voorbeeld_map_type"
  }
}
```
---

### `start_erase_map`
**Payload parameters:** `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "start_erase_map"
}
```
---

### `stop_erase_map`
**Payload parameters:** `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "stop_erase_map"
}
```
---

### `auto_recharge`
**Payload parameters:** `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "auto_recharge"
}
```
---

### `save_recharge_pos`
**Payload parameters:** `mapName`, `map0`, `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "save_recharge_pos",
  "save_recharge_pos": {
    "mapName": "voorbeeld_mapName",
    "map0": "voorbeeld_map0"
  }
}
```
---

### `go_to_charge`
**Payload parameters:** `cmd_num`, `chargerpile`, `latitude`, `longitude`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "go_to_charge",
  "go_to_charge": {
    "chargerpile": "voorbeeld_chargerpile",
    "latitude": 0.0,
    "longitude": 0.0
  }
}
```
---

### `stop_to_charge`
**Payload parameters:** `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "stop_to_charge"
}
```
---

### `start_navigation`
**Payload parameters:** (Gecombineerd met `start_run_respond`) `mapName`, `test`, `cutterhigh`, `area`, `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "start_navigation",
  "start_navigation": {
    "start_run_respond)": "voorbeeld_start_run_respond)",
    "mapName": "voorbeeld_mapName",
    "test": true,
    "cutterhigh": 1,
    "area": 1
  }
}
```
---

### `pause_navigation`
**Payload parameters:** `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "pause_navigation"
}
```
---

### `resume_navigation`
**Payload parameters:** `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "resume_navigation"
}
```
---

### `stop_navigation`
**Payload parameters:** `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "stop_navigation"
}
```
---

### `start_assistant_build_map`
**Payload parameters:** `cmd_num`, `type`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "start_assistant_build_map"
}
```
---

### `quit_mapping_mode`
**Payload parameters:** `cmd_num`, `value`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "quit_mapping_mode",
  "quit_mapping_mode": {
    "value": 1
  }
}
```
---

### `boundaries`
**Payload parameters:** `reset_map`, `type`, `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "boundaries",
  "boundaries": {
    "reset_map": true
  }
}
```
---

### `obstacle`
**Payload parameters:** `reset_map`, `type`, `cmd_num`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "obstacle",
  "obstacle": {
    "reset_map": true
  }
}
```
---

### `generate_preview_cover_path`
**Payload parameters:** `cmd_num`, `map_ids`, `cov_direction`
**Voorbeeld Payload:**
```json
{
  "cmd_num": 1234,
  "type": "generate_preview_cover_path",
  "generate_preview_cover_path": {
    "map_ids": 1,
    "cov_direction": 1
  }
}
```
---

### `get_map_list`
**Payload parameters:** `init`
**Voorbeeld Payload:**
```json
{
  "get_map_list": {
    "init": true
  }
}
```
---

### `get_recharge_pos`
**Payload parameters:** (Geen verdere paramaters direct zichtbaar in cluster)
**Voorbeeld Payload:**
```json
{
  "type": "get_recharge_pos"
}
```
---

### `get_para_info`
**Payload parameters:** (Vraagt instellingen/parameters op)
**Voorbeeld Payload:**
```json
{
  "type": "get_para_info"
}
```
---



## 📥 Ontvangen Commands / Status Updates (Subscribed)
Deze commands komen als respons of status-update terug vanuit de NovaBot of cloud. Deze eindigen vrijwel altijd op `_respond` of bevatten state/status.

### `add_scan_map_respond`
**Payload parameters:** `type`, `start_scan_map_respond`, `message`, `result`
**Voorbeeld Payload:**
```json
{
  "type": "add_scan_map_respond",
  "result": true,
  "message": "success"
}
```
---

### `stop_scan_map_respond`
**Payload parameters:** `type`, `message`, `result`
**Voorbeeld Payload:**
```json
{
  "type": "stop_scan_map_respond",
  "result": true,
  "message": "success"
}
```
---

### `save_map_respond`
**Payload parameters:** `type`, `message`, `result`, `value`
**Voorbeeld Payload:**
```json
{
  "type": "save_map_respond",
  "result": true,
  "message": "success",
  "value": 123
}
```
---

### `reset_map_respond`
**Payload parameters:** `type`, `message`, `result`
**Voorbeeld Payload:**
```json
{
  "type": "reset_map_respond",
  "result": true,
  "message": "success"
}
```
---

### `delete_map_respond`
**Payload parameters:** `type` (Behoort tot de map operations array)
**Voorbeeld Payload:**
```json
{
  "type": "delete_map_respond"
}
```
---

### `start_erase_map_respond`
**Payload parameters:** `type`, `message`, `result`
**Voorbeeld Payload:**
```json
{
  "type": "start_erase_map_respond",
  "result": true,
  "message": "success"
}
```
---

### `stop_erase_map_respond`
**Payload parameters:** `type`, `message`, `result`
**Voorbeeld Payload:**
```json
{
  "type": "stop_erase_map_respond",
  "result": true,
  "message": "success"
}
```
---

### `auto_recharge_respond`
**Payload parameters:** `type`, `message`, `result`
**Voorbeeld Payload:**
```json
{
  "type": "auto_recharge_respond",
  "result": true,
  "message": "success"
}
```
---

### `save_recharge_pos_respond`
**Payload parameters:** `type`, `message`, `result`, `value`, `dis`, `orient_flag`
**Voorbeeld Payload:**
```json
{
  "type": "save_recharge_pos_respond",
  "result": true,
  "message": "success",
  "value": 123,
  "dis": "waarde_dis",
  "orient_flag": "waarde_orient_flag"
}
```
---

### `go_to_charge_respond`
**Payload parameters:** `type`, `message`, `result`
**Voorbeeld Payload:**
```json
{
  "type": "go_to_charge_respond",
  "result": true,
  "message": "success"
}
```
---

### `stop_to_charge_respond`
**Payload parameters:** `type`, `message`, `result`
**Voorbeeld Payload:**
```json
{
  "type": "stop_to_charge_respond",
  "result": true,
  "message": "success"
}
```
---

### `get_map_info_respond`
**Payload parameters:** `type`, `message`, `result`, `value`, `size`, `name`
**Voorbeeld Payload:**
```json
{
  "type": "get_map_info_respond",
  "result": true,
  "message": "success",
  "value": 123,
  "size": 123,
  "name": "waarde_name"
}
```
---

### `get_map_list_respond`
**Payload parameters:** `type`, `message`, `result`, `value`, `md5`, `zip_dir_empty`
**Voorbeeld Payload:**
```json
{
  "type": "get_map_list_respond",
  "result": true,
  "message": "success",
  "value": 123,
  "md5": 123,
  "zip_dir_empty": false
}
```
---

### `start_assistant_build_map_respond`
**Payload parameters:** `message`, `result`, `type`
**Voorbeeld Payload:**
```json
{
  "type": "start_assistant_build_map_respond",
  "result": true,
  "message": "success"
}
```
---

### `get_recharge_pos_respond`
**Payload parameters:** (Bevat vaak ook locatie data net als map_outline hieronder)
**Voorbeeld Payload:**
```json
{
  "type": "get_recharge_pos_respond"
}
```
---

### `start_navigation_respond`
**Payload parameters:** (Bevestiging start verplaatsen/maaien)
**Voorbeeld Payload:**
```json
{
  "type": "start_navigation_respond"
}
```
---

### `pause_navigation_respond`
**Payload parameters:** (Bevestiging pauzeren)
**Voorbeeld Payload:**
```json
{
  "type": "pause_navigation_respond"
}
```
---

### `resume_navigation_respond`
**Payload parameters:** (Bevestiging hervatten navigatie)
**Voorbeeld Payload:**
```json
{
  "type": "resume_navigation_respond"
}
```
---

### `stop_navigation_respond`
**Payload parameters:** (Bevestiging stop navigatie)
**Voorbeeld Payload:**
```json
{
  "type": "stop_navigation_respond"
}
```
---

### `go_pile_respond`
**Payload parameters:** Geassocieerd met terugkeer naar lader (`go_to_charge`)
**Voorbeeld Payload:**
```json
{
  "type": "go_pile_respond",
  "(go_to_charge)": "waarde_(go_to_charge)"
}
```
---

### `set_wifi_info_respond`
**Payload parameters:** `type`, `message`, `result`, `value`, `wifi`, `rtk`
**Voorbeeld Payload:**
```json
{
  "type": "set_wifi_info_respond",
  "result": true,
  "message": "success",
  "value": 123,
  "wifi": "waarde_wifi",
  "rtk": "waarde_rtk"
}
```
---

### `set_rtk_info_respond`
**Payload parameters:** `type`, `message`, `result`, `value`
**Voorbeeld Payload:**
```json
{
  "type": "set_rtk_info_respond",
  "result": true,
  "message": "success",
  "value": 123
}
```
---

### `set_mqtt_info_respond`
**Payload parameters:** `type`, `message`, `result`
**Voorbeeld Payload:**
```json
{
  "type": "set_mqtt_info_respond",
  "result": true,
  "message": "success"
}
```
---

### `set_lora_info_respond`
**Payload parameters:** `type`, `message`, `result`
**Voorbeeld Payload:**
```json
{
  "type": "set_lora_info_respond",
  "result": true,
  "message": "success"
}
```
---

### `set_cfg_info_respond`
**Payload parameters:** `type`, `message`, `result`
**Voorbeeld Payload:**
```json
{
  "type": "set_cfg_info_respond",
  "result": true,
  "message": "success"
}
```
---

### `get_signal_info_respond`
**Payload parameters:** `wifi`, `rtk`, `value`
**Voorbeeld Payload:**
```json
{
  "type": "get_signal_info_respond",
  "wifi": "waarde_wifi",
  "rtk": "waarde_rtk",
  "value": 123
}
```
---

### `get_wifi_rssi_respond`
**Payload parameters:** `type`, `message`, `result`, `value`, `data`
**Voorbeeld Payload:**
```json
{
  "type": "get_wifi_rssi_respond",
  "result": true,
  "message": "success",
  "value": 123,
  "data": {
    "path": []
  }
}
```
---

### `generate_preview_cover_path_respond`
**Payload parameters:** (Data preview cover path return format)
**Voorbeeld Payload:**
```json
{
  "type": "generate_preview_cover_path_respond"
}
```
---

### `get_preview_cover_path_respond`
**Payload parameters:** `type`, `message`, `result`, `value`, `data`
**Voorbeeld Payload:**
```json
{
  "type": "get_preview_cover_path_respond",
  "result": true,
  "message": "success",
  "value": 123,
  "data": {
    "path": []
  }
}
```
---

### `get_map_plan_path_respond`
**Payload parameters:** `data`
**Voorbeeld Payload:**
```json
{
  "type": "get_map_plan_path_respond",
  "data": {
    "path": []
  }
}
```
---

### `get_para_info_respond`
**Payload parameters:** (Bevat instellings parameters)
**Voorbeeld Payload:**
```json
{
  "type": "get_para_info_respond"
}
```
---

### `set_para_info_respond`
**Payload parameters:** (Bevestiging parameter settings bewaard)
**Voorbeeld Payload:**
```json
{
  "type": "set_para_info_respond"
}
```
---

### `dev_pin_info_respond`
**Payload parameters:** (Device PIN info/validatie format)
**Voorbeeld Payload:**
```json
{
  "type": "dev_pin_info_respond"
}
```
---

### `ota_version_info_respond`
**Payload parameters:** `type`, `message`, `result`, `value`, `version`
**Voorbeeld Payload:**
```json
{
  "type": "ota_version_info_respond",
  "result": true,
  "message": "success",
  "value": 123,
  "version": "1.0.0"
}
```
---


### Continue Apparaat State (Telemetry)
### `report_state_map_outline`
**Payload parameters:** `status`, `success`, `type`, `message`, `result`, `value`, `position`, `x`, `y`
**Voorbeeld Payload:**
```json
{
  "type": "report_state_map_outline",
  "result": true,
  "message": "success",
  "status": "waarde_status",
  "success": true,
  "value": 123,
  "position": 123,
  "x": 123,
  "y": 123
}
```
---

### `report_exception_state`
**Payload parameters:** `wifi_rssi`, `rtk`, `type`, `message`, `result`, `value`, `version`, `v`
**Voorbeeld Payload:**
```json
{
  "type": "report_exception_state",
  "result": true,
  "message": "success",
  "wifi_rssi": 123,
  "rtk": "waarde_rtk",
  "value": 123,
  "version": "1.0.0",
  "v": 123
}
```
---

### `ota_upgrade_state`
**Payload parameters:** `status`, `fail`, `type`, `message`, `value`, `version`
**Voorbeeld Payload:**
```json
{
  "type": "ota_upgrade_state",
  "message": "success",
  "status": "waarde_status",
  "fail": false,
  "value": 123,
  "version": "1.0.0"
}
```
---

