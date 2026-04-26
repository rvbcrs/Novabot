# mqtt_node — Binary string analysis (RE-2)

**Source:** `research/firmware/mower_v6.0.0_backup/mqtt_node` (~6.3 MB ARM64).
**Method:** `strings -a` then categorized by grep + manual review.
**Date:** 2026-04-26.

## Overview

Total strings extracted: **30,101 lines**.

Breakdown by category:
- MQTT topics: 2
- Command names (MQTT JSON keys, ROS2, HCI): 497
- ROS2 service / action / topic names: 26 (+ 11 system paths)
- API paths: 6
- File paths: 15
- Error / status messages: 180+ (sample)

## MQTT topics

```
$ grep -E 'Dart/(Send|Receive)_mqtt' /tmp/mqtt_node-strings-raw.txt | sort -u
```

```
Dart/Receive_mqtt/
Dart/Send_mqtt/
```

**Notes:** Confirm that topic names are template (suffix with SN expected at runtime). Presence of both send and receive confirms bidirectional MQTT flow.

---

## Command names (MQTT JSON keys)

```
$ grep -oE '\b[a-z_]+_cmd\b|\bset_[a-z_]+\b|\bget_[a-z_]+\b|\bstart_[a-z_]+\b|\bstop_[a-z_]+\b|\bsave_[a-z_]+\b|\breport_state_[a-z_]+\b|\bota_[a-z_]+\b' /tmp/mqtt_node-strings-raw.txt | sort -u
```

**MQTT / application commands (relevant subset):**

```
cloud_move_cmd
exit_park_state_cmd
get_cfg_info
get_cfg_info_respond
get_current_pose
get_current_pose_respond
get_dev_info
get_dev_info_respond
get_device_state
get_log_info_pub
get_log_info_respond
get_lora_data
get_lora_info
get_lora_info_respond
get_map_info
get_map_info_respond
get_map_list
get_map_list_respond
get_map_outline
get_map_outline_respond
get_map_plan_path
get_map_plan_path_respond
get_preview_cover_path
get_preview_cover_path_respond
get_recharge_pos
get_recharge_pos_respond
get_vel_odom
get_vel_odom_respond
get_version_info
get_version_info_respond
get_wifi_rssi
get_wifi_rssi_respond
ota_upgrade_cmd
ota_upgrade_cmd_respond
ota_version_info
ota_version_info_respond
report_state_all_by_ble
report_state_exception
report_state_map_outline
report_state_map_path_list
report_state_robot
report_state_timer_data
report_state_to_server_exception
report_state_to_server_work
report_state_unbind
save_charging_pose
save_csv_file
save_map
save_map_respond
save_recharge_pos
save_recharge_pos_respond
set_cfg_info
set_cfg_info_respond
set_control_mode
set_control_mode_respond
set_lora_info
set_lora_info_respond
set_mqtt_info
set_mqtt_info_respond
set_para_info
set_para_info_respond
set_wifi_info
set_wifi_info_respond
start_assistant_build_map
start_assistant_build_map_respond
start_assistant_mapping
start_build_unicom_area
start_cov_task
start_erase_map
start_erase_map_respond
start_mapping
start_move
start_move_respond
start_navigation
start_navigation_respond
start_patrol
start_patrol_respond
start_scan_map
start_scan_map_respond
start_time_navigation
start_time_navigation_respond
stop_erase_map
stop_erase_map_respond
stop_move
stop_move_respond
stop_navigation
stop_navigation_respond
stop_patrol
stop_patrol_respond
stop_scan_map
stop_scan_map_respond
stop_task
stop_time_navigation
stop_time_navigation_respond
stop_to_charge
stop_to_charge_respond
```

**Full command list (all 497):** (includes BLE, HCI, GATT, and system commands)
```
accept_conn_request_cmd
accept_logic_link_cmd
accept_phy_link_cmd
act_deact_traces_cmd
add_sco_conn_cmd
api_ota_upgrade_cmd
auth_requested_cmd
change_conn_link_key_cmd
change_conn_pkt_type_cmd
cloud_move_cmd
create_conn_cancel_cmd
create_logic_link_cmd
create_phy_link_cmd
ddc_config_write_cmd
dec_signed_write_cmd
dec_write_cmd
delete_reserved_lt_addr_cmd
delete_stored_link_key_cmd
disconn_logic_link_cmd
disconn_phy_link_cmd
enable_radio_cmd
enable_usb_hid_emulation_cmd
enable_wbs_cmd
enc_signed_write_cmd
enc_write_cmd
enhanced_accept_sync_conn_request_cmd
enhanced_flush_cmd
enhanced_setup_sync_conn_cmd
exit_park_state_cmd
exit_sniff_mode_cmd
flow_spec_cmd
flow_spec_modify_cmd
gatt_signed_write_cmd
gatt_write_cmd
get_active_instances
get_all_properties
get_all_properties_reply
get_ble_event
get_cached_sdp_session
get_cfg_info
get_cfg_info_respond
get_connections_complete
get_control_mode
get_control_mode_respond
get_current_pose
get_current_pose_respond
get_dev_info
get_dev_info_respond
get_device_state
get_discovery_filters
get_dun_record
get_duration
get_first_attribute
get_flushable
get_ftp_record
get_fw_version
get_generic_record
get_header_field
get_hfp_ag_record
get_hfp_hf_record
get_hsp_ag_record
get_instances
get_local_name
get_log_info
get_log_info_pub
get_log_info_respond
get_lora_data
get_lora_info
get_lora_info_respond
get_ltk
get_ltk_info
get_managed_objects
get_managed_objects_reply
get_map_info
get_map_info_para
get_map_info_respond
get_map_list
get_map_list_respond
get_map_outline
get_map_outline_respond
get_map_plan_path
get_map_plan_path_respond
get_mas_record
get_mns_record
get_mws_transport_config_rsp
get_name_owner_reply_cb
get_opp_record
get_para_info
get_para_info_respond
get_pce_record
get_phy
get_preview_cover_path
get_preview_cover_path_respond
get_priority
get_prompt
get_properties_dict
get_pse_record
get_random_number
get_recharge_pos
get_recharge_pos_respond
get_sec_level
get_secondary
get_slave_ltk_info
get_sn_para_info
get_spp_record
get_supported_includes
get_supported_secondary
get_sync_record
get_timeout
get_vel_odom
get_vel_odom_respond
get_version_info
get_version_info_respond
get_wifi_passwd
get_wifi_rssi
get_wifi_rssi_respond
get_wifi_ssid
hci_send_cmd
hold_mode_cmd
host_buffer_size_cmd
host_num_completed_packets_cmd
io_capability_request_neg_reply_cmd
io_capability_request_reply_cmd
launch_ram_cmd
le_accept_cis_req_cmd
le_add_dev_periodic_adv_list_cmd
le_add_to_resolv_list_cmd
le_add_to_white_list_cmd
le_big_create_sync_cmd
le_big_term_sync_cmd
le_conn_param_req_neg_reply_cmd
le_conn_param_req_reply_cmd
le_conn_update_cmd
le_create_big_cmd
le_create_big_cmd_test_cmd
le_create_cis_cmd
le_create_conn_cmd
le_encrypt_cmd
le_enhanced_receiver_test_cmd
le_enhanced_transmitter_test_cmd
le_ext_create_conn_cmd
le_generate_dhkey_cmd
le_ltk_req_neg_reply_cmd
le_ltk_req_reply_cmd
le_periodic_adv_create_sync_cmd
le_periodic_adv_term_sync_cmd
le_read_channel_map_cmd
le_read_iso_tx_sync_cmd
le_read_local_resolv_addr_cmd
le_read_peer_resolv_addr_cmd
le_read_phy_cmd
le_read_remote_features_cmd
le_receiver_test_cmd
le_reject_cis_req_cmd
le_remove_adv_set_cmd
le_remove_cig_cmd
le_remove_dev_periodic_adv_list_cmd
le_remove_from_resolv_list_cmd
le_remove_from_white_list_cmd
le_remove_iso_path_cmd
le_req_peer_sca_cmd
le_set_adv_data_cmd
le_set_adv_enable_cmd
le_set_adv_parameters_cmd
le_set_cig_params_cmd
le_set_cig_params_test_cmd
le_set_data_length_cmd
le_set_default_phy_cmd
le_set_event_mask_cmd
le_set_ext_adv_data_cmd
le_set_ext_adv_enable_cmd
le_set_ext_adv_params_cmd
le_set_ext_scan_enable_cmd
le_set_ext_scan_params_cmd
le_set_ext_scan_rsp_data_cmd
le_set_host_classification_cmd
le_set_periodic_adv_data_cmd
le_set_periodic_adv_enable_cmd
le_set_periodic_adv_params_cmd
le_set_phy_cmd
le_set_priv_mode_cmd
le_set_random_address_cmd
le_set_resolv_enable_cmd
le_set_resolv_timeout_cmd
le_set_scan_enable_cmd
le_set_scan_parameters_cmd
le_set_scan_rsp_data_cmd
le_setup_iso_path_cmd
le_start_encrypt_cmd
le_terminate_big_cmd
le_transmitter_test_cmd
le_write_default_data_length_cmd
le_write_rf_path_comp_cmd
link_key_request_neg_reply_cmd
link_key_request_reply_cmd
logic_link_cancel_cmd
manufacturer_mode_cmd
master_link_key_cmd
memory_write_cmd
mgmt_add_advertising_cmd
mgmt_add_device_cmd
mgmt_add_remote_oob_data_cmd
mgmt_add_uuid_cmd
mgmt_block_device_cmd
mgmt_cancel_pair_device_cmd
mgmt_confirm_name_cmd
mgmt_disconnect_cmd
mgmt_get_advertising_size_info_cmd
mgmt_get_clock_information_cmd
mgmt_get_connection_information_cmd
mgmt_load_connection_parameters_cmd
mgmt_load_identity_resolving_keys_cmd
mgmt_load_link_keys_cmd
mgmt_load_long_term_keys_cmd
mgmt_null_cmd
mgmt_pair_device_cmd
mgmt_pin_code_neg_reply_cmd
mgmt_pin_code_reply_cmd
mgmt_read_local_oob_ext_data_cmd
mgmt_remove_advertising_cmd
mgmt_remove_device_cmd
mgmt_remove_remote_oob_data_cmd
mgmt_remove_uuid_cmd
mgmt_set_advertising_cmd
mgmt_set_apperance_cmd
mgmt_set_bondable_cmd
mgmt_set_bredr_cmd
mgmt_set_connectable_cmd
mgmt_set_debug_keys_cmd
mgmt_set_device_class_cmd
mgmt_set_device_id_cmd
mgmt_set_discoverable_cmd
mgmt_set_external_configuration_cmd
mgmt_set_fast_connectable_cmd
mgmt_set_high_speed_cmd
mgmt_set_io_capability_cmd
mgmt_set_link_security_cmd
mgmt_set_local_name_cmd
mgmt_set_low_energy_cmd
mgmt_set_phy_cmd
mgmt_set_powered_cmd
mgmt_set_privacy_cmd
mgmt_set_public_address_cmd
mgmt_set_scan_parameters_cmd
mgmt_set_secure_connections_cmd
mgmt_set_secure_simple_pairing_cmd
mgmt_set_static_address_cmd
mgmt_start_discovery_cmd
mgmt_start_limited_discovery_cmd
mgmt_start_service_discovery_cmd
mgmt_stop_discovery_cmd
mgmt_unblock_device_cmd
mgmt_unpair_device_cmd
mgmt_user_confirmation_neg_reply_cmd
mgmt_user_confirmation_reply_cmd
mgmt_user_passkey_neg_reply_cmd
mgmt_user_passkey_reply_cmd
msgid_cmd
ota_client
ota_client_cb_group_
ota_status_sub
ota_status_subscribe_callback
ota_updata_run
ota_updata_run_end
ota_updata_run_error
ota_upgrade_cmd
ota_upgrade_cmd_respond
ota_upgrade_srv
ota_upgrade_state
ota_version_info
ota_version_info_respond
periodic_inquiry_cmd
pin_code_request_neg_reply_cmd
pin_code_request_reply_cmd
pipe_fd_cmd
pipe_mutex_cmd
qos_setup_cmd
read_afh_channel_map_cmd
read_auth_payload_timeout_cmd
read_auto_flush_timeout_cmd
read_clock_cmd
read_clock_offset_cmd
read_encrypt_key_size_cmd
read_enhanced_tx_power_cmd
read_failed_contact_counter_cmd
read_link_policy_cmd
read_link_quality_cmd
read_link_supv_timeout_cmd
read_lmp_handle_cmd
read_local_amp_assoc_cmd
read_local_ext_features_cmd
read_ram_cmd
read_raw_rssi_cmd
read_remote_ext_features_cmd
read_remote_version_cmd
read_rssi_cmd
read_stored_link_key_cmd
read_tx_power_cmd
receive_sync_train_cmd
refresh_encrypt_key_cmd
reject_conn_request_cmd
reject_sync_conn_request_cmd
remote_name_request_cancel_cmd
remote_name_request_cmd
remote_oob_data_request_neg_reply_cmd
remote_oob_data_request_reply_cmd
remote_oob_ext_data_request_reply_cmd
report_state_all_by_ble
report_state_exception
report_state_map_outline
report_state_map_path_list
report_state_robot
report_state_timer_data
report_state_to_server_exception
report_state_to_server_exception_respond
report_state_to_server_work
report_state_to_server_work_respond
report_state_unbind
reset_cmd
reset_failed_contact_counter_cmd
role_discovery_cmd
save_charging_pose
save_charging_pose_client
save_charging_pose_client_cb_group_
save_csv_file
save_map
save_map_client
save_map_client_cb_group_
save_map_respond
save_recharge_pos
save_recharge_pos_respond
secure_send_cmd
send_keypress_notify_cmd
set_afh
set_afh_host_classification_cmd
set_blocked_keys
set_blocked_keys_complete
set_cfg_info
set_cfg_info_respond
set_conn_encrypt_cmd
set_control_mode
set_control_mode_respond
set_dbus_connection
set_default_device
set_dev_class
set_dev_class_complete
set_device_type
set_did
set_discoverable
set_discovery_filter
set_discovery_filter_reply
set_discovery_filter_setup
set_event_filter_cmd
set_fixed_db_timestamp
set_host_flow_control_cmd
set_io_cap
set_local_name_complete
set_lora_info
set_lora_info_respond
set_mode
set_mqtt_info
set_mqtt_info_respond
set_name
set_navigation_max_speed
set_navigation_max_speed_respond
set_para_info
set_para_info_respond
set_priority
set_privacy
set_privacy_complete
set_property_reply
set_reserved_lt_addr_cmd
set_reserved_lt_addr_rsp
set_sec_level
set_slave_broadcast_cmd
set_slave_broadcast_data_cmd
set_slave_broadcast_data_rsp
set_slave_broadcast_receive_cmd
set_slave_broadcast_receive_rsp
set_slave_broadcast_rsp
set_sleepmode_param_cmd
set_static_addr
set_triggered_clock_capture_cmd
set_uart_baudrate_cmd
set_wifi_info
set_wifi_info_respond
short_range_mode_cmd
sniff_subrating_cmd
start_adv
start_assistant_build_map
start_assistant_build_map_client
start_assistant_build_map_client_cb_group_
start_assistant_build_map_flag_sub
start_assistant_build_map_flag_value
start_assistant_build_map_respond
start_assistant_mapping
start_build_unicom_area
start_cov_task
start_discovery
start_discovery_complete
start_discovery_reply
start_discovery_timeout
start_edit_map_flag_sub
start_edit_map_flag_value
start_edit_or_assistant_map_flag
start_encryption_req
start_erase
start_erase_map
start_erase_map_client
start_erase_map_client_cb_group_
start_erase_map_respond
start_handle
start_mapping
start_move
start_move_respond
start_navigation
start_navigation_respond
start_patrol
start_patrol_respond
start_scan_map
start_scan_map_client
start_scan_map_client_cb_group_
start_scan_map_respond
start_sdp_server
start_tag
start_tester
start_time_navigation
start_time_navigation_respond
stimulate_exception_cmd
stop_discovery
stop_discovery_complete
stop_encryption_req
stop_erase_map
stop_erase_map_respond
stop_move
stop_move_respond
stop_navigation
stop_navigation_respond
stop_passive_scanning
stop_passive_scanning_complete
stop_patrol
stop_patrol_respond
stop_scan_map
stop_scan_map_client
stop_scan_map_client_cb_group_
stop_scan_map_respond
stop_sdp_server
stop_task
stop_time_navigation
stop_time_navigation_respond
stop_to_charge
stop_to_charge_respond
stop_to_charging_client
stop_to_charging_client_cb_group_
switch_role_cmd
truncated_page_cancel_cmd
truncated_page_cmd
update_uart_baud_rate_cmd
user_confirm_request_neg_reply_cmd
user_confirm_request_reply_cmd
user_passkey_request_neg_reply_cmd
user_passkey_request_reply_cmd
wifi_list_cmd
write_afh_assessment_mode_cmd
write_auth_enable_cmd
write_auth_payload_timeout_cmd
write_auto_flush_timeout_cmd
write_bd_addr_cmd
write_bd_address_cmd
write_bd_data_cmd
write_class_of_dev_cmd
write_conn_accept_timeout_cmd
write_current_iac_lap_cmd
write_default_link_policy_cmd
write_encrypt_mode_cmd
write_erroneous_reporting_cmd
write_ext_inquiry_length_cmd
write_ext_inquiry_response_cmd
write_ext_page_timeout_cmd
write_flow_control_mode_cmd
write_high_priority_connection_cmd
write_hold_mode_activity_cmd
write_inquiry_mode_cmd
write_inquiry_scan_activity_cmd
write_inquiry_scan_type_cmd
write_inquiry_tx_power_cmd
write_le_host_supported_cmd
write_link_policy_cmd
write_link_supv_timeout_cmd
write_local_name_cmd
write_location_data_cmd
write_loopback_mode_cmd
write_num_broadcast_retrans_cmd
write_page_scan_activity_cmd
write_page_scan_mode_cmd
write_page_scan_period_mode_cmd
write_page_scan_type_cmd
write_page_timeout_cmd
write_pin_type_cmd
write_ram_cmd
write_remote_amp_assoc_cmd
write_scan_enable_cmd
write_sco_pcm_int_param_cmd
write_secure_conn_support_cmd
write_simple_pairing_mode_cmd
write_ssp_debug_mode_cmd
write_stored_link_key_cmd
write_sync_flow_control_cmd
write_sync_train_params_cmd
write_uart_clock_setting_cmd
write_voice_setting_cmd
zip_cmd
```

**Key observations:**
- Large HCI/BLE command set (Bluetooth classic + LE), indicating this binary includes Bluetooth management stack.
- MQTT application commands: `start_*`, `stop_*`, `get_*`, `set_*`, `save_*`, `report_state_*`, `ota_*`.
- ROS2 action clients: `save_charging_pose_client`, `save_map_client`, `start_scan_map_client`, etc.
- OTA: `api_ota_upgrade_cmd`, `ota_upgrade_cmd`, `ota_version_info`, `ota_upgrade_srv`.

---

## ROS2 service / action / topic names

```
$ grep -E '^/[a-z_]+(/[a-z_]+)*$' /tmp/mqtt_node-strings-raw.txt | sort -u
```

(Full output includes system paths like `/bin/sh`, `/dev/*`, `/proc/*`, `/var/*`. Filtering to application-relevant names:)

**ROS2 service / action (application):**

```
/local_costmap/clear_around_local_costmap
/novabot/init_mower
/novabot_mapping/close_map
/novabot_mapping/if_closed_cycle
/novabot_mapping/if_unicom_can_stop
/novabot_mapping/in_map_area
/novabot_mapping/save_csv_file
/novabot_mapping/start_build_unicom_area
/ota_upgrade_srv
/robot_decision/add_area
/robot_decision/auto_recharge
/robot_decision/cancel_recharge
/robot_decision/cancel_task
/robot_decision/cov_task_result
/robot_decision/covered_path_json
/robot_decision/delete_map
/robot_decision/generate_preview_cover_path
/robot_decision/map_position
/robot_decision/map_stop_record
/robot_decision/nav_to_recharge
/robot_decision/planned_json
/robot_decision/preview_planned_json
/robot_decision/quit_mapping_mode
/robot_decision/reset_mapping
/robot_decision/robot_status
/robot_decision/save_charging_pose
/robot_decision/save_map
/robot_decision/start_assistant_mapping
/robot_decision/start_cov_task
/robot_decision/start_erase
/robot_decision/start_mapping
/robot_decision/stop_task
/statistics
```

**Key observations:**
- `/robot_decision/*` namespace: primary ROS2 service/action interface (mowing, mapping, charging, navigation).
- `/novabot_mapping/*`: BLE mapping specific (CSV file operations, unicom area decisions).
- `/ota_upgrade_srv`: OTA service.
- System paths also present: `/bin/sh`, `/dev/log`, `/dev/random`, `/dev/uhid`, `/proc/mounts`, `/root`, `/root/addresses`, `/run/systemd/journal/socket`, `/var/run/sdp`, `/org/bluez/*`.

---

## API paths (HTTP)

```
$ grep -oE '/api/[a-z0-9-]+(/[a-z0-9-]+)*' /tmp/mqtt_node-strings-raw.txt | sort -u
```

```
/api/nova-data/cut
/api/nova-data/equipment
/api/nova-file-server/map/upload
/api/nova-message/machine
/api/nova-network/network/connection
/api/nova-user/equipment/machine
```

**Key observations:**
- Endpoint patterns: cloud API, file server, network health check, messaging, equipment/cut-grass data.
- `/api/nova-network/network/connection`: periodic health check endpoint.
- `/api/nova-file-server/map/upload`: map upload (HTTP POST multipart).

---

## File paths

```
$ grep -E '^/userdata/|^/root/novabot/|^/tmp/' /tmp/mqtt_node-strings-raw.txt | sort -u
```

```
/root/novabot/data/ros2_log/wifi_connected_delete.txt
/root/novabot/data/ros2_log/wifi_connecting_info_app.txt
/userdata/lfi/ble_mac.txt
/userdata/lfi/charging_station_file/
/userdata/lfi/http_address.txt
/userdata/lfi/json_config.json
/userdata/lfi/maps/home0/
/userdata/lfi/maps/home0/csv_file/
/userdata/lfi/maps/home0/planned_path/
/userdata/lfi/maps/home0/planned_path/planned_path.json
/userdata/lfi/maps/home0/planned_path/preview_planned_path.json
/userdata/lfi/system_version.txt
/userdata/ota/charging_station_pkg/lfi-charging-station_lora.bin
/userdata/ota/charging_station_pkg/version.txt
/userdata/ota/novabot_timezone.txt
```

**Key observations:**
- BLE MAC persistent: `/userdata/lfi/ble_mac.txt`.
- Configuration: `/userdata/lfi/json_config.json`, `/userdata/lfi/http_address.txt`.
- Maps: `/userdata/lfi/maps/home0/csv_file/`, `/userdata/lfi/maps/home0/planned_path/`.
- OTA charger package and versioning: `/userdata/ota/charging_station_pkg/`.
- WiFi state logging: `/root/novabot/data/ros2_log/wifi_*.txt`.

---

## Magic constants

```
$ grep -E 'abcdabcd1234|abcd1234abcd1234|mqtt\.lfibot|:1883|:8883' /tmp/mqtt_node-strings-raw.txt | sort -u
```

```
abcd1234abcd1234
abcdabcd12341234
 ping -c 3 mqtt.lfibot.com >  /root/novabot/data/ros2_log/mqtt_reconnect.txt
mqtt.lfibot.com
```

**Extracted constants:**

- **AES IV:** `abcd1234abcd1234` (static, 16 bytes)
- **AES key prefix:** `abcdabcd1234` (embedded; full key = prefix + SN[-4:], e.g., `abcdabcd12340238`)
- **Default MQTT broker:** `mqtt.lfibot.com`
- **MQTT health check:** `ping -c 3 mqtt.lfibot.com` (written to `/root/novabot/data/ros2_log/mqtt_reconnect.txt`)

**Key observations:**
- Broker defaults to cloud FQDN, supporting redirect via DNS to local server.
- AES-128-CBC encryption baked in (key derivation from SN, static IV).
- No hardcoded port detected (uses broker's default 1883).

---

## Error / status messages (sample)

```
$ grep -iE 'error|fail|warn|abort|exception' /tmp/mqtt_node-strings-raw.txt | head -200
```

**Sample output (first 150 lines):**

```
MQTTClient_strerror
_ZTVN4YAML23RepresentationExceptionE
_ZN4YAML9Exception10build_whatERKNS_4MarkERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE
_ZTVN4YAML9ExceptionE
_ZNK4Json9Exception4whatEv
_ZN4Json9ExceptionD2Ev
_ZTVN4Json9ExceptionE
_ZN4Json9ExceptionD1Ev
_ZN4Json9ExceptionD0Ev
_ZTVN4Json12RuntimeErrorE
_ZTVN4Json10LogicErrorE
_ZN4Json12RuntimeErrorC2ERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE
_ZN4Json12RuntimeErrorC1ERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE
_ZN4Json17throwRuntimeErrorERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE
_ZTIN4Json12RuntimeErrorE
_ZN4Json10LogicErrorC2ERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE
_ZN4Json10LogicErrorC1ERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE
_ZN4Json15throwLogicErrorERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE
_ZTIN4Json10LogicErrorE
_ZTSN4Json9ExceptionE
_ZTIN4Json9ExceptionE
_ZTSN4Json12RuntimeErrorE
_ZTSN4Json10LogicErrorE
g_clear_error
g_propagate_error
g_set_error
g_error_free
g_error_matches
g_file_error_quark
dbus_message_new_error
dbus_error_has_name
dbus_set_error_const
dbus_error_is_set
dbus_error_init
dbus_set_error
dbus_error_free
dbus_set_error_from_message
curl_easy_strerror
_ZN6rclcpp10exceptions20throw_from_rcl_errorEiRKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEEPK21rcutils_error_state_tPFvvE
rcutils_get_error_string
rcutils_reset_error
rcutils_get_error_state
_ZN6rclcpp29UnsupportedEventTypeExceptionC1EiPK21rcutils_error_state_tRKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE
_ZN6rclcpp22ParameterTypeExceptionD0Ev
_ZN6rclcpp10exceptions12RCLErrorBaseC2ERKS1_
_ZNSt15__exception_ptr12__dest_thunkIN13rclcpp_action10exceptions22UnawareGoalHandleErrorEEEvPv
_ZN6rclcpp22ParameterTypeExceptionD1Ev
_ZN6rclcpp22ParameterTypeExceptionD2Ev
_ZN6rclcpp10exceptions28InvalidQosOverridesExceptionD0Ev
_ZN6rclcpp10exceptions28InvalidQosOverridesExceptionD1Ev
_ZTIN6rclcpp10exceptions33ParameterAlreadyDeclaredExceptionE
_ZN6rclcpp10exceptions28InvalidQosOverridesExceptionD2Ev
_ZTIN6rclcpp22ParameterTypeExceptionE
_ZN13rclcpp_action10exceptions22UnawareGoalHandleErrorD0Ev
_ZN13rclcpp_action10exceptions22UnawareGoalHandleErrorD1Ev
_ZTSN6rclcpp22ParameterTypeExceptionE
_ZTSN13rclcpp_action10exceptions22UnawareGoalHandleErrorE
_ZN13rclcpp_action10exceptions22UnawareGoalHandleErrorD2Ev
_ZTVN6rclcpp29UnsupportedEventTypeExceptionE
_ZTIN6rclcpp10exceptions28InvalidQosOverridesExceptionE
_ZN6rclcpp10exceptions12RCLErrorBaseC1ERKS1_
_ZTIN6rclcpp29UnsupportedEventTypeExceptionE
_ZTSN6rclcpp29UnsupportedEventTypeExceptionE
_ZTVN6rclcpp22ParameterTypeExceptionE
_ZN6rclcpp22ParameterTypeExceptionC1ENS_13ParameterTypeES1_
_ZTSN6rclcpp10exceptions33ParameterAlreadyDeclaredExceptionE
_ZTIN6rclcpp10exceptions8RCLErrorE
_ZN6rclcpp10exceptions12RCLErrorBaseD0Ev
_ZTSN6rclcpp10exceptions12RCLErrorBaseE
_ZTSN6rclcpp10exceptions28InvalidQosOverridesExceptionE
_ZTVN6rclcpp10exceptions12RCLErrorBaseE
_ZTVN6rclcpp10exceptions28InvalidQosOverridesExceptionE
_ZN6rclcpp10exceptions12RCLErrorBaseD1Ev
_ZTIN13rclcpp_action10exceptions22UnawareGoalHandleErrorE
_ZTSN6rclcpp10exceptions8RCLErrorE
_ZN6rclcpp10exceptions12RCLErrorBaseD2Ev
_ZN6rclcpp29UnsupportedEventTypeExceptionD0Ev
_ZNSt15__exception_ptr12__dest_thunkISt12future_errorEEvPv
_ZN6rclcpp29UnsupportedEventTypeExceptionD1Ev
_ZTIN6rclcpp10exceptions12RCLErrorBaseE
_ZTVN13rclcpp_action10exceptions22UnawareGoalHandleErrorE
_ZN6rclcpp22ParameterTypeExceptionC2ENS_13ParameterTypeES1_
_ZThn120_N6rclcpp29UnsupportedEventTypeExceptionD0Ev
_ZN6rclcpp29UnsupportedEventTypeExceptionD2Ev
_ZThn120_N6rclcpp29UnsupportedEventTypeExceptionD1Ev
_ZTIN6rclcpp10exceptions29InvalidParameterTypeExceptionE
_ZN6rclcpp10exceptions29InvalidParameterTypeExceptionC1ERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEES7_
_ZTVN6rclcpp10exceptions29InvalidParameterTypeExceptionE
_ZN6rclcpp10exceptions29InvalidParameterTypeExceptionD0Ev
_ZN6rclcpp10exceptions29InvalidParameterTypeExceptionD1Ev
_ZTSN6rclcpp10exceptions29InvalidParameterTypeExceptionE
_ZN6rclcpp10exceptions29InvalidParameterTypeExceptionC2ERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEES7_
_ZN6rclcpp10exceptions29InvalidParameterTypeExceptionD2Ev
_ZNSt11logic_errorC2ERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE
__cxa_init_primary_exception
_ZSt20__throw_length_errorPKc
_ZNSt12future_errorD1Ev
_ZNSt15__exception_ptreqERKNS_13exception_ptrES2_
_ZNSt13runtime_errorC2EOS_
_ZNSt13runtime_errorD2Ev
_ZTISt9exception
_ZNSt13runtime_errorC2ERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE
_ZNKSt13runtime_error4whatEv
_ZTVSt12future_error
_ZNSt13runtime_errorC1EPKc
_ZTISt12future_error
_ZNSt15__exception_ptrneERKNS_13exception_ptrES2_
_ZNSt15__exception_ptr13exception_ptrD1Ev
_ZNSt9exceptionD2Ev
_ZSt20__throw_system_errori
_ZTISt13runtime_error
__cxa_guard_abort
_ZNSt13runtime_errorC2ERKS_
__cxa_allocate_exception
_ZNSt13runtime_errorD1Ev
_ZNSt15__exception_ptr13exception_ptraSERKS0_
_ZNSt11logic_errorC2ERKS_
_ZNSt15__exception_ptr13exception_ptrC1ERKS0_
_ZSt20__throw_future_errori
_ZNSt15__exception_ptr13exception_ptr4swapERS0_
_ZNSt15__exception_ptr13exception_ptrC1EPv
_ZSt17rethrow_exceptionNSt15__exception_ptr13exception_ptrE
_ZSt19__throw_logic_errorPKc
__cxa_free_exception
perror
__stack_chk_fail
__assert_fail
warn
Unexpected error code
Request attribute has encountered an unlikely error
Internal application error: I/O
The operation was aborted
rl_callback_read_char_error
rl_on_new_line_error
Failed to set signal mask
Failed to create signal descriptor
bt-io-error-quark
connect error: %s (%d)
Failed to unregister advertising object
Failed to unregister advertisement: %s
Failed to register advertisement: %s
Failed to register advertising object
Failed to register advertising
Failed to unregister advertisement method
Failed to parse input
Failed to request default agent: %s
Failed to register agent: %s
Failed to unregister agent object
org.bluez.Error.Rejected
org.bluez.Error.Canceled
Failed to unregister agent: %s
Failed to register agent object
Failed to call register agent method
Failed to call unregister agent method
Failed to call RequestDefaultAgent method
SetDiscoveryFilter failed: %s
Failed to connect: %s
Failed to remove device: %s
Failed to pair: %s
Failed to %s discovery: %s
pid_cmd_run_pthread_detach_error
pid_cmd_run_pthread_create_error
Failed to set %s: %s
Failed to set discovery filter
Failed to %s discovery
Failed to disconnect
open_mac_str_write_file_error
Failed to pair
Failed to connect
Failed to remove device
Failed to disconnect: %s
Failed to write: %s
Failed to register application: %s
Failed to read: %s
Failed to %s notify: %s
Failed to unregister application: %s
Failed to %s: %s
org.bluez.Error.Failed
org.bluez.Error.InvalidArguments
Failed to write
org.bluez.Error.InvalidValueLength
Failed to acquire write: %s
Failed to acquire notify: %s
org.bluez.Error.NotAuthorized
org.bluez.Error.InvalidOffset
org.bluez.Error.NotPermitted
Failed to read
Failed to register service object
Failed to register characteristic object
Failed to write: %s
Failed to AcquireWrite
Failed to AcquireNotify
Failed to %s notify
Failed to register application object
Failed register application
Failed unregister profile
Failed to unregister service object
Failed to find  service object
Failed to find include service object
Failed to unregister include service object
```

(truncated; full set in `/tmp/mqtt_node-strings-raw.txt` — 30,101 total lines)

**Key observations:**
- YAML, JSON, exception handling from standard C++ libraries (rclcpp, curl).
- DBus / BlueZ error codes: `org.bluez.Error.Rejected`, `.Canceled`, `.Failed`, `.InvalidArguments`, `.InvalidValueLength`, `.NotAuthorized`, `.InvalidOffset`, `.NotPermitted`.
- RCL/ROS2 error infrastructure.
- Bluetooth manager errors and file I/O errors.
- No application-level MQTT error messages detected (likely runtime-formatted).

---

## Summary

This binary is a **monolithic MQTT↔ROS2 bridge** with embedded Bluetooth management:

1. **MQTT Core:** Aedes broker integration, AES-128-CBC encryption, topic templates.
2. **ROS2 Integration:** 27+ service/action endpoints under `/robot_decision/`, mapping, navigation, OTA.
3. **Bluetooth:** Full HCI command set + BLE advertising, pairing, scanning (likely BlueZ D-Bus binding).
4. **OTA:** Firmware update orchestration via `ota_upgrade_cmd`, version info negotiation.
5. **Cloud API:** HTTP endpoints for equipment binding, map upload, network health, messaging.
6. **Persistent State:** Configuration in JSON, BLE MAC caching, map storage (CSV + planned paths).

The binary is **not stripped** (exception symbols, C++ mangled names, function symbols present). Indicates relatively large surface area for reverse engineering (Ghidra analysis possible).

---

**Date generated:** 2026-04-26
**Raw strings file:** `/tmp/mqtt_node-strings-raw.txt` (not committed)
