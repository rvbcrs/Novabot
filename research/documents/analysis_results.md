# Novabot App Commands Overview

This document provides a comprehensive overview of all command-related communications (subscribed, published) and their associate payloads extracted from the reverse engineered NovaBot App.

## mqtt_data_handler.dart

### `ota_version_info_respond`
- **Payload Fields**: type, ota_version_info_respond, message, result, value, version

### `report_exception_state`
- **Payload Fields**: report_exception_state, wifi_rssi, rtk, type, ota_version_info_respond, message, result, value, version, v

### `get_map_list_respond`
- **Payload Fields**: type, get_map_list_respond, message, result, value, md5, zip_dir_empty

### `report_state_map_outline`
- **Payload Fields**: report_state_map_outline, status, success, type, get_recharge_pos_respond, message, result, value, position, x, y

### `get_wifi_rssi_respond`
- **Payload Fields**: type, get_wifi_rssi_respond, message, result, value, get_map_plan_path_respond, data

### `get_preview_cover_path_respond`
- **Payload Fields**: type, get_preview_cover_path_respond, message, result, value, data

## logic.dart

### `stop_scan_map`
- **Payload Fields**: stop_scan_map, value, cmd_num

### `save_recharge_pos`
- **Payload Fields**: save_recharge_pos, mapName, map0, cmd_num

### `add_scan_map_respond`
- **Payload Fields**: type, add_scan_map_respond, start_scan_map_respond, message, result

### `reset_map_respond`
- **Payload Fields**: type, reset_map_respond, message, result

### `stop_scan_map_respond`
- **Payload Fields**: type, stop_scan_map_respond, message, result

### `save_map_respond`
- **Payload Fields**: type, save_map_respond, message, result, value

### `auto_recharge_respond`
- **Payload Fields**: type, auto_recharge_respond, message, result

### `save_recharge_pos_respond`
- **Payload Fields**: type, save_recharge_pos_respond, message, result, value, dis, orient_flag, start_erase_map_respond

### `stop_erase_map_respond`
- **Payload Fields**: type, stop_erase_map_respond, message, result

### `get_map_info_respond`
- **Payload Fields**: type, get_map_info_respond, message, result, value, size, name

### `gbf`
- **Payload Fields**: gbf, type, start_assistant_build_map_respond, message, result

### `save_map`
- **Payload Fields**: save_map, mapName, type, cmd_num

### `auto_recharge`
- **Payload Fields**: auto_recharge, cmd_num

### `start_scan_map`
- **Payload Fields**: start_scan_map, model, manual, mapName, map0, type, cmd_num

### `add_scan_map`
- **Payload Fields**: add_scan_map, model, manual, mapName, type, cmd_num

### `add_scan_map`
- **Payload Fields**: add_scan_map, model, manual, mapName, type, cmd_num

### `add_scan_map`
- **Payload Fields**: add_scan_map, model, manual, mapName, type, cmd_num

### `add_scan_map`
- **Payload Fields**: add_scan_map, model, manual, mapName, type, cmd_num

### `stop_erase_map`
- **Payload Fields**: stop_erase_map, cmd_num

### `start_erase_map`
- **Payload Fields**: start_erase_map, cmd_num

### `reset_map`
- **Payload Fields**: reset_map, type, cmd_num

### `boundaries`
- **Payload Fields**: boundaries, reset_map, type, cmd_num

### `obstacle`
- **Payload Fields**: obstacle, reset_map, type, cmd_num

### `boundaries`
- **Payload Fields**: boundaries, reset_map, type, cmd_num

### `start_assistant_build_map`
- **Payload Fields**: start_assistant_build_map, cmd_num, type

### `start_assistant_build_map`
- **Payload Fields**: start_assistant_build_map, cmd_num, type

### `quit_mapping_mode`
- **Payload Fields**: quit_mapping_mode, cmd_num, value

### `go_to_charge`
- **Payload Fields**: go_to_charge, cmd_num, chargerpile, latitude, longitude

### `stop_to_charge`
- **Payload Fields**: stop_to_charge, cmd_num

### `go_to_charge_respond`
- **Payload Fields**: type, go_to_charge_respond, message, result

### `stop_to_charge_respond`
- **Payload Fields**: type, stop_to_charge_respond, message, result

### `go_to_charge`
- **Payload Fields**: go_to_charge, cmd_num

### `set_wifi_info_respond`
- **Payload Fields**: type, set_wifi_info_respond, message, result, set_rtk_info_respond, set_lora_info_respond, set_mqtt_info_respond, set_cfg_info_respond

### `set_wifi_info_respond`
- **Payload Fields**: type, set_wifi_info_respond, message, result, get_signal_info_respond, value, wifi, rtk

### `set_rtk_info_respond`
- **Payload Fields**: type, set_rtk_info_respond, message, result, set_lora_info_respond, value

### `set_mqtt_info_respond`
- **Payload Fields**: type, set_mqtt_info_respond, message, result, set_cfg_info_respond

### `start_run_respond`
- **Payload Fields**: start_run_respond, start_navigation, mapName, test, cutterhigh, area, cmd_num

### `start_navigation_respond`
- **Payload Fields**: start_navigation_respond

### `delete_map`
- **Payload Fields**: delete_map, map_name, map_type, cmd_num

### `delete_map_respond`
- **Payload Fields**: delete_map_respond

### `get_map_list`
- **Payload Fields**: get_map_list, init, get_map_list_respond

### `get_recharge_pos`
- **Payload Fields**: get_recharge_pos, get_recharge_pos_respond

## advanced_settings_page.dart

### `get_para_info`
- **Payload Fields**: get_para_info, get_para_info_respond

### `generate_preview_cover_path`
- **Payload Fields**: generate_preview_cover_path, cmd_num, map_ids, cov_direction

### `generate_preview_cover_path_respond`
- **Payload Fields**: generate_preview_cover_path_respond

### `set_para_info_respond`
- **Payload Fields**: set_para_info_respond

## online_view.dart

### `resume_run_respond`
- **Payload Fields**: resume_run_respond, resume_navigation, cmd_num

### `resume_navigation_respond`
- **Payload Fields**: resume_navigation_respond

### `start_run_respond`
- **Payload Fields**: start_run_respond, start_navigation, mapName, test, area, cutterhigh, cmd_num

### `start_navigation_respond`
- **Payload Fields**: start_navigation_respond

### `pause_run_respond`
- **Payload Fields**: pause_run_respond, pause_navigation, cmd_num

### `pause_navigation_respond`
- **Payload Fields**: pause_navigation_respond

### `go_pile_respond`
- **Payload Fields**: go_pile_respond, go_to_charge, cmd_num, chargerpile, latitude, longitude

### `go_to_charge_respond`
- **Payload Fields**: go_to_charge_respond

### `pause_run_respond`
- **Payload Fields**: pause_run_respond, pause_navigation, cmd_num

### `pause_navigation_respond`
- **Payload Fields**: pause_navigation_respond

### `stop_run_respond`
- **Payload Fields**: stop_run_respond, stop_navigation, cmd_num

### `stop_navigation_respond`
- **Payload Fields**: stop_navigation_respond

### `go_to_charge`
- **Payload Fields**: go_to_charge, cmd_num, chargerpile, latitude, longitude

### `go_to_charge_respond`
- **Payload Fields**: go_to_charge_respond

### `go_pile_respond`
- **Payload Fields**: go_pile_respond

## ota_page.dart

### `ota_upgrade_state`
- **Payload Fields**: ota_upgrade_state, status, fail, type, ota_version_info_respond, message, value, version

### `ota_upgrade_state`
- **Payload Fields**: ota_upgrade_state, status, fail, type, ota_version_info_respond, message, value, version

## view_pin_page.dart

### `dev_pin_info_respond`
- **Payload Fields**: dev_pin_info_respond

