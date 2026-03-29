#pragma once
#include <Arduino.h>

// Start BLE GATT provisioning service
void bleInit(const char* sn);

// Stop BLE and free resources
void bleStop();

// Check if BLE provisioning is active
bool bleIsActive();

// Check if set_cfg_info commit was received (triggers restart)
bool bleWasConfigCommitted();

// Reset the commit flag
void bleClearConfigCommitted();

// Shared command dispatcher — handles 9 provisioning commands
// Called from BLE write callback (viaBle=true) and potentially from MQTT (viaBle=false)
// Matches Ghidra FUN_4200d9a2
// Commands: get_wifi_info, set_wifi_info, get_signal_info, set_rtk_info,
//           set_lora_info, set_mqtt_info, get_cfg_info, set_cfg_info, get_dev_info
int dispatchSharedCommand(const char* json, bool viaBle);
