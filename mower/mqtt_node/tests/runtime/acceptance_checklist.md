# Hardware acceptance — open mqtt_node

Walk through each step with the user. Get explicit confirmation before
moving to the next. Stop on any failure.

## Pre-flight
- [ ] User confirms the mower is in a safe state (parked, blade off,
      battery > 50%)
- [ ] User confirms there is room to move ~1 m around the mower
- [ ] BASELINE captured via tests/runtime/parity_capture.sh

## Activation
- [ ] `bash /userdata/open_mqtt_node/start.sh` → process running
- [ ] `ros2 node info /mqtt_node` shows node up with same service+
      action+topic counts as baseline (allow ±1 for racing
      lifecycle nodes)
- [ ] App still receives report_state_robot updates (battery, msg, etc.)
- [ ] App still receives report_state_timer_data updates

## MQTT command exercises (one at a time, USER confirms each)
- [ ] start_run → mower begins mowing the active map
- [ ] stop_to_charge → mower returns to charger
- [ ] save_recharge_pos → charging pose saved
- [ ] start_scan_map → mapping mode entered
- [ ] add_scan_map → obstacle/unicom added during mapping
- [ ] save_map → map saved
- [ ] delete_map → map removed
- [ ] reset_data → counters cleared

## OTA exercise (only if a test firmware is staged)
- [ ] User stages a known-good firmware image on the dashboard
- [ ] User triggers OTA from dashboard
- [ ] Progress reports flow at 0..62..68..100
- [ ] Mower reboots and comes back on the new version

## BLE provisioning exercise
- [ ] BLE advertises with same UUIDs as stock
- [ ] App can discover the mower via BLE
- [ ] App can complete provisioning (set_wifi_info → set_lora_info →
      set_mqtt_info → set_cfg_info)

## Rollback drill
- [ ] `bash /userdata/open_mqtt_node/rollback.sh` → stock binary back
- [ ] App resumes normal operation

## Sign-off
- [ ] User signs off on activation OR identifies blockers for
      a follow-up plan
