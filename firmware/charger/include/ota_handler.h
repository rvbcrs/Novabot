#pragma once
#include <Arduino.h>

// OTA update request (placed in FreeRTOS queue by MQTT handler)
struct OtaRequest {
    char url[256];
    char version[32];
    char md5[33];
};

// OTA task function (runs as FreeRTOS task, blocks on queue)
void otaTask(void* param);
