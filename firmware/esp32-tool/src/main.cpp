/**
 * Nova-OTA Device — ESP32 standalone Novabot provisioning + OTA tool
 *
 * Flow:
 *   1. Boot -> start WiFi AP "OpenNova-Setup" + DNS (mqtt.lfibot.com -> self)
 *   2. BLE scan for CHARGER_PILE and NOVABOT devices
 *   3. Touch screen: user selects charger + mower from discovered list
 *   4. BLE provision charger: set_wifi -> set_lora -> set_mqtt -> set_cfg
 *   5. BLE provision mower:   set_wifi -> set_lora -> set_mqtt -> set_cfg
 *   6. Devices connect to our WiFi AP -> resolve mqtt.lfibot.com -> us
 *   7. MQTT broker accepts connection from mower
 *   8. Send OTA command with firmware URL (http://192.168.4.1/firmware.deb)
 *   9. Mower downloads firmware from our HTTP server (SD card)
 *  10. Mower installs, reboots with custom firmware
 *  11. Screen shows "Done!" — tap to restart
 *
 * Hardware:
 *   - JC3248W535EN (AXS15231B QSPI + I2C touch, 8MB PSRAM)
 *   - SD card (SD_MMC, 1-bit mode): firmware .deb file on SD root
 */

#include <Arduino.h>
#include <WiFi.h>
#ifdef SD_MMC_D0
#include <SD_MMC.h>
#endif
#include <NimBLEDevice.h>
#include <Preferences.h>

#include "display.h"
#include "config.h"
#include "mqtt.h"
#include "network.h"
#include "wizard.h"
#include <ArduinoOTA.h>

// ── Preferences (NVS) — owned by main.cpp ──────────────────────────────────

Preferences prefs;

// ── Configuration constant definitions ──────────────────────────────────────

const char* AP_SSID     = "OpenNova-Setup";
const char* AP_PASSWORD = "12345678";
const char* MQTT_HOST   = "mqtt.lfibot.com";
const int   MQTT_PORT   = 1883;

String userWifiSsid     = "";
String userWifiPassword = "";
String userMqttAddr     = "";

const int LORA_ADDR            = 718;
const int LORA_CHANNEL_CHARGER = 16;
const int LORA_CHANNEL_MOWER   = 15;
const int LORA_HC              = 20;
const int LORA_LC              = 14;

const uint8_t AES_IV[] = "abcd1234abcd1234";
const char* VERSION = "v1.0.0 (" __DATE__ " " __TIME__ ")";

// ── Web console log ring buffer ─────────────────────────────────────────────

char webLog[WEB_LOG_SIZE][WEB_LOG_LINE];
int webLogHead = 0;
int webLogCount = 0;

void webLogAdd(const char* fmt, ...) {
    char tmp[WEB_LOG_LINE];
    va_list args;
    va_start(args, fmt);
    vsnprintf(tmp, sizeof(tmp), fmt, args);
    va_end(args);
    unsigned long sec = millis() / 1000;
    snprintf(webLog[webLogHead], WEB_LOG_LINE, "[%lum%02lus] %s", sec / 60, sec % 60, tmp);
    Serial.println(webLog[webLogHead]);
    webLogHead = (webLogHead + 1) % WEB_LOG_SIZE;
    if (webLogCount < WEB_LOG_SIZE) webLogCount++;
}

// ── Scan results ────────────────────────────────────────────────────────────

ScanResult scanResults[20];
int scanResultCount = 0;
int selectedChargerIdx = -1;
int selectedMowerIdx = -1;
static int scanRetryCount = 0;

// ── WiFi scan results ───────────────────────────────────────────────────────

WifiNetwork wifiNetworks[16];
int wifiNetworkCount = 0;
bool wifiScanInProgress = false;

// ── State machine globals ───────────────────────────────────────────────────

State currentState = WIZ_BOOT;
bool sdMounted = false;
String statusMessage = "Initializing...";
bool stateJustEntered = true;
unsigned long stateEnteredAt = 0;
int wizStep = 0;
const int WIZ_TOTAL_STEPS = 8;
bool reprovisioning = false;

// ── MQTT broker state ───────────────────────────────────────────────────────

bool mowerConnected = false;
bool chargerMqttConnected = false;
bool mowerCharging = false;
String mowerSn = "";
String chargerSn = "";
String chargerTopic = "";
unsigned long mowerConnectTime = 0;
String mowerFirmwareVersion = "";

// ── OTA progress ────────────────────────────────────────────────────────────

int otaProgressPercent = 0;
int httpDownloadPercent = 0;
String otaStatus = "";

// ── OTA retry state ─────────────────────────────────────────────────────────

bool mowerOtaTriedPlain;
bool mowerOtaTriedAes;
unsigned long mowerOtaSentAt;

// ── BLE state ───────────────────────────────────────────────────────────────

NimBLEAdvertisedDevice* chargerDevice = nullptr;
NimBLEAdvertisedDevice* mowerDevice = nullptr;
bool bleScanning = false;
bool chargerWifiDetected = false;
bool mowerWifiDetected = false;

// ── Firmware info (from SD card) ────────────────────────────────────────────

String mowerFwFilename = "";
size_t mowerFwSize = 0;
String mowerFwMd5 = "";
String mowerFwVersion = "";
String chargerFwFilename = "";
size_t chargerFwSize = 0;
String chargerFwMd5 = "";
String chargerFwVersion = "";
// Legacy aliases for compatibility
String& firmwareFilename = mowerFwFilename;
size_t& firmwareSize = mowerFwSize;
String& firmwareMd5 = mowerFwMd5;
String& firmwareVersion = mowerFwVersion;

// ── Firmware proxy URL (stream from remote server when no SD) ───────────────
String firmwareProxyUrl = "";

// ── Provision progress callback ─────────────────────────────────────────────

ProvisionProgressCb provisionProgressCb = nullptr;

// ── Setup ────────────────────────────────────────────────────────────────────

void setup() {
    Serial.begin(115200);
    delay(1000);
    // Suppress noisy WiFi CCMP errors from charger (corrupt mgmt frames)
    esp_log_level_set("wifi", ESP_LOG_NONE);

    Serial.println();
    Serial.println("======================================");
    Serial.println("  Nova-OTA — Novabot Flash Tool");
    Serial.println("  Waveshare ESP32-S3 Touch LCD 2\"");
    Serial.println("======================================");

    // Load saved WiFi credentials from NVS (home WiFi for re-provisioning later)
    prefs.begin("nova-ota", false);
    String savedSsid = prefs.getString("wifi_ssid", "");
    String savedPass = prefs.getString("wifi_pass", "");
    String savedMqtt = prefs.getString("mqtt_addr", "");
    if (savedSsid.length() > 0 && savedMqtt.length() > 0) {
        userWifiSsid = savedSsid;
        userWifiPassword = savedPass;
        userMqttAddr = savedMqtt;
        strncpy(ui_wifiSsid, savedSsid.c_str(), sizeof(ui_wifiSsid) - 1);
        strncpy(ui_wifiPassword, savedPass.c_str(), sizeof(ui_wifiPassword) - 1);
        Serial.printf("[NVS] Loaded: WiFi=%s MQTT=%s\r\n", savedSsid.c_str(), savedMqtt.c_str());
    } else {
        Serial.println("[NVS] Incomplete config — need WiFi + MQTT setup");
    }
    String savedFwUrl = prefs.getString("fw_url", "");
    if (savedFwUrl.length() > 0) {
        firmwareProxyUrl = savedFwUrl;
        Serial.printf("[NVS] Firmware proxy URL: %s\r\n", savedFwUrl.c_str());
    }

    // Display first — show splash while SD loads (MD5 takes ~12s)
    display_init();
    display_boot(VERSION);

    // SD uses SD_MMC (separate bus from display — no conflict!)
#ifdef SD_MMC_D0
    display_boot_status("Mounting SD card...");
    SD_MMC.setPins(SD_MMC_CLK, SD_MMC_CMD, SD_MMC_D0);
    sdMounted = SD_MMC.begin("/sdcard", true);  // 1-bit mode
    if (!sdMounted) {
        Serial.println("[SD] SD_MMC mount failed — OTA will be skipped");
        display_boot_status("No SD card found");
        delay(1000);
    } else {
        Serial.printf("[SD] SD_MMC mounted, size: %lluMB\r\n", SD_MMC.cardSize() / (1024 * 1024));
        display_boot_status("Reading firmware from SD...");
    }
#else
    Serial.println("[SD] No SD card support on this board — use firmware proxy URL");
    sdMounted = false;
#endif

    // Find firmware file on SD (MD5 computed lazily when Flash is pressed)
    if (!loadFirmwareInfo()) {
        Serial.println("[SD] No firmware .deb — OTA will be skipped");
        display_boot_status("No firmware on SD card");
        delay(1000);
    } else {
        display_boot_status("Firmware ready!");
    }

    // Start WiFi AP
    setupWifiAP();
    Serial.println("[SETUP] Waiting for AP to be ready...");
    while (WiFi.softAPIP() == IPAddress(0, 0, 0, 0)) { delay(100); }
    Serial.printf("[SETUP] AP ready at %s\r\n", WiFi.softAPIP().toString().c_str());
    webLogAdd("AP '%s' ready at %s", AP_SSID, WiFi.softAPIP().toString().c_str());

    // Start network services
    setupDNS();
    setupHTTP();
    setupMQTT();

    // Initialize BLE
    NimBLEDevice::init("Nova-OTA");
    NimBLEDevice::setMTU(185);

    // Connect STA to home WiFi (if configured) — AP stays active
    connectHomeWifi();

    // ArduinoOTA for development (pio run -e ota -t upload)
    ArduinoOTA.setHostname("nova-ota");
    ArduinoOTA.onStart([]() { Serial.println("[OTA] Start"); });
    ArduinoOTA.onEnd([]()   { Serial.println("[OTA] Done!"); });
    ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
        Serial.printf("[OTA] %u%%\r", progress / (total / 100));
    });
    ArduinoOTA.onError([](ota_error_t error) {
        Serial.printf("[OTA] Error[%u]\r\n", error);
    });
    ArduinoOTA.begin();
    Serial.println("[OTA] ArduinoOTA ready (nova-ota.local)");

    // Start wizard: need home WiFi + MQTT before we can provision anything
    if (userWifiSsid.length() > 0 && userMqttAddr.length() > 0) {
        Serial.printf("[SETUP] Home WiFi: %s, MQTT: %s — checking mower\r\n",
                      userWifiSsid.c_str(), userMqttAddr.c_str());
        setState(WIZ_MOWER_CHECK);  // Skip charger, go to mower check
    } else {
        Serial.println("[SETUP] No home WiFi/MQTT configured — waiting for WebUI config");
        setState(WIZ_WIFI_CONFIG);
    }
}

// ── Main loop — linear wizard flow ──────────────────────────────────────────

void loop() {
    processDNS();
    ArduinoOTA.handle();
    processEspOta();  // Flash ESP32 from PSRAM buffer if upload complete
    mqttBroker.update();
    yield();  // Give LVGL task time to run (animations, touch processing)

    // Query firmware version after mower connects (can't publish from onEvent)
    // Retry every 10s until we get a response (ext_cmd may not be connected yet)
    static unsigned long lastFwQuery = 0;
    if (mowerConnected && mowerSn.length() > 0 && mowerFirmwareVersion.length() == 0) {
        if (millis() - lastFwQuery > 10000) {
            lastFwQuery = millis();
            String extTopic = "novabot/extended/" + mowerSn;
            mqttBroker.publish(std::string(extTopic.c_str()), std::string("{\"get_system_info\":{}}"));
            Serial.printf("[MQTT] Sent get_system_info to %s\r\n", extTopic.c_str());
        }
    }

    processWizardState();

    // Small delay to prevent tight looping
    delay(50);
}
