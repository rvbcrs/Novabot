#pragma once
#include <Arduino.h>
#include "lora_commands.h"

// Initialize MQTT client (call after WiFi connected)
void mqttInit(const char* sn, const char* host, uint16_t port);

// Process MQTT client loop (non-blocking, call from mqtt_config_task)
void mqttLoop();

// Check connection state
bool mqttIsConnected();

// Connect to broker
void mqttConnect();

// Publish raw JSON (unencrypted) on charger's publish topic
bool mqttPublishRaw(const char* json);

// Publish AES-encrypted JSON on charger's publish topic
bool mqttPublishEncrypted(const char* json);

// Build and publish up_status_info (matches Ghidra FUN_4200f00c)
void mqttPublishStatus();

// MQTT command dispatcher — handles 9 MQTT-only commands
// Called from mqtt_config_task when mqttCmdQueue receives 0x00
// Matches Ghidra FUN_4200e8c4
int mqttDispatchCommand();

// Get FreeRTOS queues
QueueHandle_t mqttGetLoraQueue();    // MQTT→LoRa relay commands
QueueHandle_t mqttGetOtaQueue();     // OTA trigger
QueueHandle_t mqttGetMqttCmdQueue(); // MQTT callback → mqtt_config_task

// mqtt_config_task — FreeRTOS task (matches Ghidra FUN_4200f158)
void mqttConfigTask(void* param);
