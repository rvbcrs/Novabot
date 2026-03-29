#include "wifi_manager.h"
#include "config.h"
#include "nvs_storage.h"
#include <WiFi.h>

// ── Static State ────────────────────────────────────────────────────────────

static volatile WifiState currentState = WIFI_STATE_INIT;
static QueueHandle_t wifiQueue = NULL;
static char apSsid[33] = {0};

// ── Init — WiFi STA+AP dual mode (mode 3) ──────────────────────────────────
// Matches Ghidra FUN_420cbeac: WiFi mode 3 (APSTA), bandwidth 20MHz, protocol 7

void wifiInit(const char* sn) {
    wifiQueue = xQueueCreate(5, sizeof(uint8_t));

    // Build AP SSID from SN (e.g. "LFIC1230700004")
    // Original firmware uses SN as AP name
    snprintf(apSsid, sizeof(apSsid), "%s", sn);

    // Set WiFi mode to STA+AP (mode 3) — matches Ghidra: esp_wifi_set_mode(3)
    WiFi.mode(WIFI_AP_STA);

    // Start AP with default password — matches Ghidra
    WifiApConfig apCfg;
    if (nvsReadWifiAp(apCfg) && strlen(apCfg.ssid) > 0) {
        WiFi.softAP(apCfg.ssid, apCfg.password);
        Serial.printf("[WiFi] AP started: %s\n", apCfg.ssid);
    } else {
        WiFi.softAP(apSsid, WIFI_AP_PASSWORD);
        Serial.printf("[WiFi] AP started: %s (default)\n", apSsid);
    }

    // Set WiFi TX power to max — matches Ghidra: esp_wifi_set_max_tx_power(0x50)
    WiFi.setTxPower(WIFI_POWER_19_5dBm);

    currentState = WIFI_STATE_INIT;
    Serial.println("[WiFi] Initialized STA+AP mode");
}

WifiState wifiGetState() { return currentState; }
bool wifiIsConnected() { return WiFi.status() == WL_CONNECTED; }
QueueHandle_t wifiGetQueue() { return wifiQueue; }

void wifiReconnect() {
    uint8_t cmd = WIFI_CMD_CONNECT;
    if (wifiQueue) xQueueSend(wifiQueue, &cmd, 0);
}

// ── STA Connect — blocking with 55s timeout ─────────────────────────────────
// Matches Ghidra: wifi_connect with 55 iteration timeout

static bool staConnect() {
    WifiConfig wifi;
    if (!nvsReadWifi(wifi) || strlen(wifi.ssid) == 0) {
        Serial.println("[WiFi] No STA credentials in NVS");
        return false;
    }

    Serial.printf("[WiFi] Connecting STA to: %s\n", wifi.ssid);
    currentState = WIFI_STATE_CONNECTING;

    WiFi.begin(wifi.ssid, wifi.password);

    // 55 second timeout (Ghidra: WIFI_CONNECT_TIMEOUT_S)
    for (int i = 0; i < WIFI_CONNECT_TIMEOUT_S; i++) {
        if (WiFi.status() == WL_CONNECTED) {
            Serial.printf("[WiFi] Connected, IP: %s\n", WiFi.localIP().toString().c_str());
            currentState = WIFI_STATE_CONNECTED;
            return true;
        }
        vTaskDelay(pdMS_TO_TICKS(1000));
    }

    Serial.println("[WiFi] STA connection timeout");
    currentState = WIFI_STATE_DISCONNECTED;
    return false;
}

// ── WiFi Task — matches Ghidra wifi_task ────────────────────────────────────
// Processes queue commands: connect, disconnect, timeout

void wifiTask(void* param) {
    // Initial STA connect attempt
    staConnect();

    for (;;) {
        uint8_t cmd;
        if (xQueueReceive(wifiQueue, &cmd, pdMS_TO_TICKS(5000)) == pdTRUE) {
            switch (cmd) {
                case WIFI_CMD_CFG_AP:
                    // Reconfigure AP from NVS
                    {
                        WifiApConfig apCfg;
                        if (nvsReadWifiAp(apCfg) && strlen(apCfg.ssid) > 0) {
                            WiFi.softAP(apCfg.ssid, apCfg.password);
                            Serial.printf("[WiFi] AP reconfigured: %s\n", apCfg.ssid);
                        }
                    }
                    break;

                case WIFI_CMD_CONNECT:
                    // (Re)connect STA
                    staConnect();
                    break;

                case WIFI_CMD_DISCONNECT:
                    WiFi.disconnect();
                    currentState = WIFI_STATE_DISCONNECTED;
                    Serial.println("[WiFi] Disconnected");
                    break;

                default:
                    break;
            }
        }

        // Monitor STA connection health
        if (currentState == WIFI_STATE_CONNECTED && WiFi.status() != WL_CONNECTED) {
            Serial.println("[WiFi] STA connection lost");
            currentState = WIFI_STATE_DISCONNECTED;
            // Auto-reconnect after short delay
            vTaskDelay(pdMS_TO_TICKS(5000));
            staConnect();
        }
    }
}
