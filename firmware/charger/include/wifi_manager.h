#pragma once
#include <Arduino.h>

// WiFi state machine states
enum WifiState {
    WIFI_STATE_INIT,
    WIFI_STATE_CONNECTING,
    WIFI_STATE_CONNECTED,
    WIFI_STATE_DISCONNECTED,
    WIFI_STATE_AP_ONLY
};

// Initialize WiFi in STA+AP dual mode (mode 3) — matches Ghidra FUN_420cbeac
// Sets up AP with SN-based SSID, then attempts STA connection.
void wifiInit(const char* sn);

// Get current WiFi state
WifiState wifiGetState();

// Check if STA is connected
bool wifiIsConnected();

// Trigger STA reconnect (non-blocking, queue-based)
void wifiReconnect();

// Get WiFi FreeRTOS queue for command dispatch
QueueHandle_t wifiGetQueue();

// WiFi manager task — runs as FreeRTOS task
// Handles connect/disconnect/timeout with 55s timeout (Ghidra: WIFI_CONNECT_TIMEOUT_S)
void wifiTask(void* param);
