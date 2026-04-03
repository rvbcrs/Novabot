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
 *   - Waveshare ESP32-S3 Touch LCD 2" (ST7789T3 + CST816D)
 *   - SD card (SPI, CS on GPIO38): firmware .deb file on SD root
 *   - Or: plain ESP32-S3/WROOM with LED on GPIO2 + button on GPIO0
 */

#include <Arduino.h>
#include <WiFi.h>
#ifdef JC3248W535
#include <SD_MMC.h>
#else
#include <SD.h>
#include <SPI.h>
#endif
#include <NimBLEDevice.h>
#include <Preferences.h>

#include "display.h"
#include "touch.h"
#include "config.h"
#include "ble.h"
#include "mqtt.h"
#include "network.h"

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

ScanResult scanResults[10];
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

// ── OTA progress ────────────────────────────────────────────────────────────

int otaProgressPercent = 0;
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

// ── Provision progress callback ─────────────────────────────────────────────

ProvisionProgressCb provisionProgressCb = nullptr;

// ── State helper ─────────────────────────────────────────────────────────────

void setState(State newState) {
    currentState = newState;
    stateJustEntered = true;
    stateEnteredAt = millis();
    // Map state to wizard step number for progress indicator
    switch (newState) {
        case WIZ_BOOT:               wizStep = 0; break;
        case WIZ_WIFI_CONFIG:        wizStep = 1; break;
        case WIZ_SCAN_CHARGER:       wizStep = 2; break;
        case WIZ_PROVISION_CHARGER:  wizStep = 3; break;
        case WIZ_SCAN_MOWER:         wizStep = 4; break;
        case WIZ_PROVISION_MOWER:    wizStep = 5; break;
        case WIZ_WAIT_MOWER:         wizStep = 6; break;
        case WIZ_OTA_FLASH:          wizStep = 7; break;
        case WIZ_REPROVISION:        wizStep = 8; break;
        case WIZ_DONE:               wizStep = 8; break;
        default:                     break;
    }
}

// ── Helper: build filtered scan results for display ─────────────────────────
static ScanResult filteredResults[10];
static int filteredCount = 0;

// Filter scan results to only chargers or only mowers, remap selected index
int buildFilteredResults(bool showChargers) {
    filteredCount = 0;
    int newSelectedIdx = -1;
    for (int i = 0; i < scanResultCount && filteredCount < 10; i++) {
        bool match = showChargers ? scanResults[i].isCharger : scanResults[i].isMower;
        if (match) {
            filteredResults[filteredCount] = scanResults[i];
            if (showChargers && i == selectedChargerIdx) newSelectedIdx = filteredCount;
            if (!showChargers && i == selectedMowerIdx) newSelectedIdx = filteredCount;
            filteredCount++;
        }
    }
    return newSelectedIdx;
}

// ── Setup ────────────────────────────────────────────────────────────────────

void setup() {
    Serial.begin(115200);
    delay(1000);
    // Suppress noisy WiFi CCMP errors from charger (corrupt mgmt frames)
    esp_log_level_set("wifi", ESP_LOG_NONE);

#ifndef WAVESHARE_LCD
    pinMode(LED_PIN, OUTPUT);
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    blinkLed(3, 200);
#endif

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

#ifdef JC3248W535
    // Display first — show splash while SD loads (MD5 takes ~12s)
    display_init();
    display_boot(VERSION);

    // SD uses SD_MMC (separate bus from display — no conflict!)
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

    // Find firmware file on SD (MD5 computation takes ~12s for 35MB)
    if (!loadFirmwareInfo()) {
        Serial.println("[SD] No firmware .deb — OTA will be skipped");
        display_boot_status("No firmware on SD card");
        delay(1000);
    } else {
        display_boot_status("Firmware ready!");
    }

#elif defined(WAVESHARE_LCD)
    // Waveshare: display FIRST, then shared SPI for SD
    display_init();
    display_boot(VERSION);
    delay(500);

    // Initialize shared SPI bus for SD — EXACT factory pattern (bsp_spi.cpp)
    static SPIClass bsp_spi(FSPI);
    bsp_spi.begin(39, 40, 38, -1);

    // Mount SD card — LVGL task not running yet, so no SPI conflict
    pinMode(SD_CS_PIN, OUTPUT);
    digitalWrite(SD_CS_PIN, HIGH);
    pinMode(LCD_CS, OUTPUT);
    digitalWrite(LCD_CS, HIGH);
    sdMounted = SD.begin(SD_CS_PIN, bsp_spi);
    if (!sdMounted) {
        Serial.println("[SD] Card mount failed — OTA will be skipped");
    } else {
        Serial.printf("[SD] Card mounted, size: %lluMB\r\n", SD.cardSize() / (1024 * 1024));
    }

    // Find firmware file on SD
    if (!loadFirmwareInfo()) {
        Serial.println("[SD] No firmware .deb — OTA will be skipped");
    }

    // NOW start LVGL task
    display_run();
#endif

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

    // Start wizard: need home WiFi + MQTT before we can provision anything
    if (userWifiSsid.length() > 0 && userMqttAddr.length() > 0) {
        Serial.printf("[SETUP] Home WiFi: %s, MQTT: %s — starting charger scan\r\n",
                      userWifiSsid.c_str(), userMqttAddr.c_str());
        setState(WIZ_SCAN_CHARGER);
    } else {
        Serial.println("[SETUP] No home WiFi/MQTT configured — waiting for WebUI config");
        setState(WIZ_WIFI_CONFIG);
    }
}

// ── Main loop — linear wizard flow ──────────────────────────────────────────

void loop() {
    processDNS();
#ifndef JC3248W535
    httpServer.handleClient();
#endif
    mqttBroker.update();

    unsigned long elapsed = (millis() - stateEnteredAt) / 1000;

    // Auto-detect OTA in progress (mower resuming cached download)
    // Jump to flash screen if we're not already there
    if (otaProgressPercent > 0 && otaStatus.length() > 0 &&
        currentState != WIZ_OTA_FLASH && currentState != WIZ_OTA_CONFIRM &&
        currentState != WIZ_REPROVISION && currentState != WIZ_DONE) {
        webLogAdd("OTA in progress detected (%d%%) — switching to flash screen", otaProgressPercent);
        setState(WIZ_OTA_FLASH);
    }

    switch (currentState) {

    case WIZ_BOOT:
        // Should not stay here -- setup() transitions to WIZ_WIFI_CONFIG or WIZ_SCAN_CHARGER
        break;

    case WIZ_WIFI_CONFIG: {
        // Sub-steps: 0=show SSID keyboard, 1=show password keyboard, 2=show MQTT keyboard
        static int wifiConfigStep = 0;

        if (stateJustEntered) {
            stateJustEntered = false;
            wifiConfigStep = 0;
            statusMessage = "Enter home WiFi SSID";
            webLogAdd("WiFi config: enter SSID");
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            ui_wifiPasswordReady = false;
            display_textEntry("WiFi Network", "Step 1 of 3", "Enter SSID (network name)", "Next");
#endif
        }

        // Also accept config via WebUI at any time
        if (userWifiSsid.length() > 0 && userMqttAddr.length() > 0) {
            Serial.printf("[SETUP] Config via WebUI: WiFi=%s MQTT=%s\r\n",
                          userWifiSsid.c_str(), userMqttAddr.c_str());
            webLogAdd("Config OK: WiFi=%s MQTT=%s", userWifiSsid.c_str(), userMqttAddr.c_str());
            setState(WIZ_SCAN_CHARGER);
            break;
        }

#if defined(WAVESHARE_LCD) || defined(JC3248W535)
        if (wifiConfigStep == 0 && ui_wifiPasswordReady) {
            // SSID entered via keyboard — stored in ui_wifiPassword by callback
            strncpy(ui_wifiSsid, ui_wifiPassword, sizeof(ui_wifiSsid) - 1);
            userWifiSsid = String(ui_wifiPassword);
            Serial.printf("[LCD] WiFi SSID: %s\r\n", userWifiSsid.c_str());
            wifiConfigStep = 1;
            ui_wifiPasswordReady = false;
            char sub[64];
            snprintf(sub, sizeof(sub), "Network: %s  (Step 2 of 3)", userWifiSsid.c_str());
            display_textEntry("WiFi Password", sub, "Enter password", "Next");
        }
        else if (wifiConfigStep == 1 && ui_wifiPasswordReady) {
            // Password entered
            userWifiPassword = String(ui_wifiPassword);
            Serial.printf("[LCD] WiFi password set (%d chars)\r\n", userWifiPassword.length());
            wifiConfigStep = 2;
            display_mqttAddr();  // Now ask for MQTT server IP
        }
        else if (wifiConfigStep == 2 && ui_mqttAddrReady) {
            // MQTT address entered
            userMqttAddr = String(ui_mqttAddr);
            Serial.printf("[LCD] MQTT addr: %s\r\n", userMqttAddr.c_str());

            // Save to NVS
            prefs.putString("wifi_ssid", userWifiSsid);
            prefs.putString("wifi_pass", userWifiPassword);
            prefs.putString("mqtt_addr", userMqttAddr);
            webLogAdd("Config saved: WiFi=%s MQTT=%s", userWifiSsid.c_str(), userMqttAddr.c_str());
            setState(WIZ_SCAN_CHARGER);
        }
#endif
        break;
    }

    case WIZ_SCAN_CHARGER: {
        // Step 2: BLE scan for charger — OPTIONAL, user can skip anytime
        if (stateJustEntered) {
            stateJustEntered = false;
            scanRetryCount = 0;
            ui_btnPressed = false;
            webLogAdd("BLE: Scanning for charger (optional)...");
            statusMessage = "Scanning for charger...";
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            display_confirm("Scanning for Charger",
                "Looking for CHARGER_PILE via BLE...",
                "Charger provisioning is optional.",
                "Skip");
#endif
            scanResultCount = 0;
            selectedChargerIdx = -1;
            chargerDevice = nullptr;
            startBleScan();
        }
        // Skip anytime during scan
        if (ui_btnPressed) {
            ui_btnPressed = false;
            webLogAdd("Charger scan skipped by user");
            setState(WIZ_CHARGER_CONNECTED);
            break;
        }
        if (!bleScanning) {
            int chargerCount = 0;
            for (int i = 0; i < scanResultCount; i++) {
                if (scanResults[i].isCharger) chargerCount++;
            }
            if (chargerCount > 0) {
                webLogAdd("BLE: Found %d charger(s)", chargerCount);
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
                int selIdx = buildFilteredResults(true);
                display_devices(filteredResults, filteredCount, selIdx, -1);
#endif
                setState(WIZ_SELECT_CHARGER);
            } else {
                scanRetryCount++;
                if (scanRetryCount >= 3) {
                    webLogAdd("BLE: No charger after 3 scans — skipping");
                    setState(WIZ_CHARGER_CONNECTED);
                } else {
                    webLogAdd("BLE: No charger found (%d/3), retrying...", scanRetryCount);
                    delay(2000);
                    stateJustEntered = true;
                }
            }
        }
        break;
    }

    case WIZ_SELECT_CHARGER: {
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
        if (stateJustEntered) {
            stateJustEntered = false;
            ui_btnPressed = false;
            ui_startPressed = false;
            ui_rescanPressed = false;
        }
        if (ui_rescanPressed) {
            ui_rescanPressed = false;
            webLogAdd("BLE: Rescanning for charger...");
            setState(WIZ_SCAN_CHARGER);
        }
        else if (ui_btnPressed) {
            ui_btnPressed = false;
            ui_startPressed = false;
            webLogAdd("Charger skipped — continuing to mower");
            setState(WIZ_CHARGER_CONNECTED);
        }
        else if (ui_startPressed) {
            ui_startPressed = false;
            if (selectedChargerIdx >= 0 && chargerDevice != nullptr) {
                webLogAdd("BLE: Selected charger: %s", scanResults[selectedChargerIdx].name.c_str());
                setState(WIZ_PROVISION_CHARGER);
            }
        }
#endif
        break;
    }

    case WIZ_PROVISION_CHARGER: {
        if (stateJustEntered) {
            stateJustEntered = false;
            webLogAdd("BLE: Provisioning charger...");
            statusMessage = "Provisioning charger...";
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            provisionProgressCb = display_provision;
#endif
            reprovisioning = false;
            if (provisionDevice(chargerDevice, "charger")) {
                provisionProgressCb = nullptr;
                bool chargerToHome = userWifiSsid.length() > 0 && userMqttAddr.length() > 0;
                if (chargerToHome) {
                    webLogAdd("BLE: Charger → home WiFi (%s) + MQTT %s", userWifiSsid.c_str(), userMqttAddr.c_str());
                } else {
                    webLogAdd("BLE: Charger → our AP");
                }
                chargerWifiDetected = true;
                // After charger → check mower status
                setState(WIZ_CHARGER_CONNECTED);
            } else {
                webLogAdd("BLE: Charger provisioning failed!");
                provisionProgressCb = nullptr;
                statusMessage = "Charger provisioning failed";
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
                display_error("Charger provisioning failed.\nMove closer and retry.");
#endif
                setState(WIZ_ERROR);
            }
        }
        break;
    }

    case WIZ_WAIT_CHARGER:
        // Legacy — charger goes to home WiFi now, no need to wait
        setState(WIZ_CHARGER_CONNECTED);
        break;

    case WIZ_CHARGER_CONNECTED: {
        // Step 3: Mower connection check — wait up to 10s for mower to appear
        if (stateJustEntered) {
            stateJustEntered = false;
            webLogAdd("Checking mower connection...");
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            display_deviceStatus(0, "", 0, "", false);
#endif
        }

        int mwStatus = mowerConnected ? 2 : (mowerWifiDetected ? 1 : 0);

#if defined(WAVESHARE_LCD) || defined(JC3248W535)
        // Update display once per second
        static unsigned long lastChkRefresh = 0;
        if (millis() - lastChkRefresh > 1000) {
            lastChkRefresh = millis();
            display_deviceStatus(0, "", mwStatus, mowerSn.c_str(), mwStatus == 2);
        }
#endif

        if (mwStatus == 2) {
            webLogAdd("Mower on MQTT!");
            if (mowerFwFilename.length() > 0) {
                setState(WIZ_OTA_CONFIRM);
            } else {
                setState(WIZ_DONE);
            }
        } else if (mwStatus == 1 && elapsed > 3) {
            // On WiFi but no MQTT after 3s — go to wait screen
            webLogAdd("Mower on WiFi — waiting for MQTT...");
            setState(WIZ_WAIT_MOWER);
        } else if (elapsed > 60) {
            // Nothing after 60s — go to BLE scan
            webLogAdd("No mower detected after 60s — starting BLE scan");
            setState(WIZ_SCAN_MOWER);
        }
        break;
    }

    case WIZ_SCAN_MOWER: {
        if (stateJustEntered) {
            stateJustEntered = false;
            webLogAdd("BLE: Scanning for mower...");
            statusMessage = "Scanning for mower...";
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            display_scanning();
#endif
            scanResultCount = 0;
            selectedMowerIdx = -1;
            mowerDevice = nullptr;
            startBleScan();
        }
        if (!bleScanning) {
            int mowerCount = 0;
            for (int i = 0; i < scanResultCount; i++) {
                if (scanResults[i].isMower) mowerCount++;
            }
            if (mowerCount == 0) {
                scanRetryCount++;
                if (scanRetryCount >= 3) {
                    // After 3 retries, offer skip option
                    webLogAdd("BLE: No mower after %d scans — tap to skip or wait for retry", scanRetryCount);
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
                    display_confirm("Mower Not Found",
                        "No mower found after 3 scans.",
                        "Is the mower powered on?",
                        "Skip Mower");
#endif
                    setState(WIZ_SELECT_MOWER);  // reuse select state for skip
                } else {
                    webLogAdd("BLE: No mower found, retrying in 3s... (%d/3)", scanRetryCount);
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
                    display_error("No mower found\nMake sure mower is powered on\nand not connected to WiFi\n\nRetrying...");
#endif
                    delay(3000);
                    stateJustEntered = true;  // retry
                }
            } else {
                webLogAdd("BLE: Found %d mower(s)", mowerCount);
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
                int selIdx = buildFilteredResults(false);  // mowers only
                display_devices(filteredResults, filteredCount, -1, selIdx);
#endif
                setState(WIZ_SELECT_MOWER);
            }
        }
        break;
    }

    case WIZ_SELECT_MOWER: {
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
        if (stateJustEntered) {
            stateJustEntered = false;
            ui_btnPressed = false;
            ui_startPressed = false;
            ui_rescanPressed = false;
        }
        if (ui_rescanPressed) {
            ui_rescanPressed = false;
            webLogAdd("BLE: Rescanning for mower...");
            setState(WIZ_SCAN_MOWER);
        }
        else if (ui_btnPressed) {
            ui_btnPressed = false;
            webLogAdd("Skipping mower — continuing without mower");
            scanRetryCount = 0;
            setState(WIZ_DONE);
        }
        else if (ui_startPressed) {
            ui_startPressed = false;
            if (selectedMowerIdx >= 0 && mowerDevice != nullptr) {
                webLogAdd("BLE: Selected mower: %s", scanResults[selectedMowerIdx].name.c_str());
                scanRetryCount = 0;
                setState(WIZ_PROVISION_MOWER);
            }
        }
#endif
        break;
    }

    case WIZ_PROVISION_MOWER: {
        if (stateJustEntered) {
            stateJustEntered = false;
            // Stop WiFi during mower BLE to avoid interference
            Serial.println("[NET] Stopping WiFi for mower BLE provisioning...");
            WiFi.enableAP(false);

            webLogAdd("BLE: Provisioning mower...");
            statusMessage = "Provisioning mower...";
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            provisionProgressCb = display_provision;
#endif
            reprovisioning = false;  // Use AP credentials
            if (provisionDevice(mowerDevice, "mower")) {
                webLogAdd("BLE: Mower provisioned!");
                provisionProgressCb = nullptr;
                // Restart WiFi AP (was stopped during BLE) then wait for mower MQTT
                setupWifiAP();
                while (WiFi.softAPIP() == IPAddress(0, 0, 0, 0)) { delay(100); }
                setState(WIZ_WAIT_MOWER);
            } else {
                webLogAdd("BLE: Mower provisioning failed!");
                provisionProgressCb = nullptr;
                statusMessage = "Mower provisioning failed";
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
                display_error("Mower provisioning failed.\nMove closer and retry.");
#endif
                setState(WIZ_ERROR);
            }
        }
        break;
    }

    case WIZ_WAIT_MOWER: {
        if (stateJustEntered) {
            stateJustEntered = false;
            // Only restart AP if it was stopped (during mower BLE provisioning)
            if (WiFi.softAPIP() == IPAddress(0, 0, 0, 0)) {
                Serial.printf("[NET] (Re)starting WiFi AP...\r\n");
                webLogAdd("Restarting WiFi AP...");
                setupWifiAP();
                while (WiFi.softAPIP() == IPAddress(0, 0, 0, 0)) { delay(100); }
                webLogAdd("AP ready at %s", WiFi.softAPIP().toString().c_str());
            }
            webLogAdd("Waiting for mower MQTT...");
            statusMessage = "Waiting for mower MQTT...";
        }
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
        {
            static unsigned long lastWaitRefresh = 0;
            if (millis() - lastWaitRefresh > 1000) {
                lastWaitRefresh = millis();
                int chStatus = chargerMqttConnected ? 2 : (chargerWifiDetected ? 1 : 0);
                int mwStatus = mowerConnected ? 2 : (mowerWifiDetected ? 1 : 0);
                display_deviceStatus(chStatus, chargerSn.c_str(), mwStatus, mowerSn.c_str(), false);
            }
        }
#endif
        if (mowerConnected) {
            webLogAdd("MQTT: Mower connected!");
            // Check if we have firmware to flash
            if (mowerFwFilename.length() > 0) {
                setState(WIZ_OTA_CONFIRM);
            } else {
                webLogAdd("No mower firmware on SD — skipping OTA");
                setState(WIZ_DONE);
            }
        }
        if (elapsed > 120) {
            webLogAdd("MQTT: Mower timeout");
            statusMessage = "Mower did not connect via MQTT";
            setState(WIZ_ERROR);
        }
        break;
    }

    case WIZ_OTA_CONFIRM: {
        if (stateJustEntered) {
            stateJustEntered = false;
            // Reset OTA flags so MQTT message filter doesn't block charging detection
            mowerOtaTriedPlain = false;
            mowerOtaTriedAes = false;
            webLogAdd("Firmware available: %s (charging: %s)", mowerFwFilename.c_str(), mowerCharging ? "yes" : "no");
            statusMessage = "Flash firmware?";
        }
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
        {
            // Refresh display to show live charging status
            static unsigned long lastOtaRefresh = 0;
            static bool lastChargingState = false;
            if (stateJustEntered || millis() - lastOtaRefresh > 1000 || mowerCharging != lastChargingState) {
                lastOtaRefresh = millis();
                lastChargingState = mowerCharging;
                String line1 = String("Flash ") + mowerFwVersion + " to " + mowerSn;
                String line2 = mowerCharging
                    ? "Mower is on charger — ready!"
                    : "WARNING: Place mower on charger first!";
                display_confirm("Flash Firmware?", line1.c_str(), line2.c_str(),
                    mowerCharging ? "Flash" : "");
            }
        }
        if (ui_btnPressed && mowerCharging) {
            ui_btnPressed = false;
            setState(WIZ_OTA_FLASH);
        } else if (ui_btnPressed && !mowerCharging) {
            ui_btnPressed = false;
            webLogAdd("OTA: Mower not on charger — waiting...");
        }
#endif
        break;
    }

    case WIZ_OTA_FLASH: {
        static bool otaSent = false;
        if (stateJustEntered) {
            stateJustEntered = false;
            otaSent = false;
            otaProgressPercent = 0;
            otaStatus = "";
            statusMessage = "Waiting for mower MQTT...";
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            display_ota("Waiting for mower MQTT...");
#endif
        }
        // Wait for mower to be connected before sending OTA
        if (!otaSent && mowerConnected) {
            webLogAdd("OTA: Sending firmware to mower...");
            statusMessage = "Sending OTA command...";
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            display_ota("Sending OTA command...");
#endif
            sendMowerOta();  // tries plain first, then AES
            otaSent = true;
        }
        // Display OTA progress from MQTT ota_upgrade_state messages
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
        display_firmware_flash("Mower",
            otaStatus.length() > 0 ? otaStatus.c_str() : "Downloading...",
            otaProgressPercent);
#endif

        // AES retry: if plain OTA got "fail" or no response after 30s, try encrypted (v6.x)
        if (mowerOtaTriedPlain && !mowerOtaTriedAes &&
            mowerOtaSentAt > 0 && millis() - mowerOtaSentAt > 30000 &&
            otaProgressPercent == 0 && mowerConnected) {
            webLogAdd("OTA: No progress after 30s, retrying with AES...");
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            display_firmware_flash("Mower", "Retrying (encrypted)...", 0);
#endif
            mowerOtaTriedAes = true;
            sendMowerOtaWithAes(true);
        }

        // Timeout: both PLAIN and AES tried, 30s after AES, still no progress → FAILED
        if (mowerOtaTriedPlain && mowerOtaTriedAes &&
            mowerOtaSentAt > 0 && millis() - mowerOtaSentAt > 30000 &&
            otaProgressPercent == 0) {
            webLogAdd("OTA: No response — cleaning cache + rebooting mower...");
            mowerOtaTriedPlain = false;
            mowerOtaTriedAes = false;
            sendOtaCleanup();  // clean cache + reboot mower
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            display_error("OTA Failed!\n\nCleaning cache + rebooting mower.\nWait for reconnect, then retry.\n\nTap to retry.");
#endif
            setState(WIZ_ERROR);
            break;
        }

        // Check for completion
        if (otaStatus == "success" || otaProgressPercent >= 100) {
            webLogAdd("OTA: Firmware installed! Mower rebooting...");
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            display_firmware_flash("Mower", "Installed! Rebooting...", 100);
#endif
            delay(5000);
            if (userWifiSsid.length() > 0) {
                setState(WIZ_REPROVISION);
            } else {
                setState(WIZ_DONE);
            }
        }

        // After device disconnects (rebooting with new firmware), also proceed
        if (!mowerConnected && mowerSn.length() > 0 && elapsed > 10) {
            webLogAdd("OTA: Mower disconnected — firmware likely installed");
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            display_firmware_flash("Mower", "Rebooting...", 100);
#endif
            delay(3000);
            if (userWifiSsid.length() > 0) {
                setState(WIZ_REPROVISION);
            } else {
                setState(WIZ_DONE);
            }
        }

        // Timeout after 30 minutes
        if (elapsed > 1800) {
            statusMessage = "OTA timeout — mower did not complete firmware install";
            setState(WIZ_ERROR);
        }
        break;
    }

    case WIZ_REPROVISION: {
        // Step 8: Re-provision mower to home WiFi (charger already on home WiFi from step 2)
        if (stateJustEntered) {
            stateJustEntered = false;
            reprovisioning = true;
            webLogAdd("Re-provisioning mower to home WiFi: %s", userWifiSsid.c_str());
            statusMessage = "Mower → home WiFi...";

#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            display_reprovision("Mower -> home WiFi", 1, 1);
#endif
            bool mowerOk = false;

            if (mowerConnected && mowerSn.length() > 0) {
                // Use extended_commands.py (custom firmware) to bypass mqtt_node whitelist.
                // Stock mqtt_node only accepts *.lfibot.com for set_mqtt_info — but
                // extended_commands.py writes directly to json_config.json.
                String extTopic = "novabot/extended/" + mowerSn;
                webLogAdd("REPROVISION: via extended_commands");

                // 1. Set MQTT address (bypasses whitelist)
                String mqttCmd = "{\"set_mqtt_config\":{\"addr\":\"" + userMqttAddr +
                    "\",\"port\":1883}}";
                mqttBroker.publish(std::string(extTopic.c_str()), std::string(mqttCmd.c_str()));
                Serial.printf("[REPROV] MQTT config → %s\r\n", userMqttAddr.c_str());
                delay(1000);  // Wait for json_config.json write + mqtt_node restart

                // 2. Set WiFi (also via extended_commands for reliability)
                String wifiCmd = "{\"set_wifi_config\":{\"ssid\":\"" + userWifiSsid +
                    "\",\"password\":\"" + userWifiPassword + "\"}}";
                mqttBroker.publish(std::string(extTopic.c_str()), std::string(wifiCmd.c_str()));
                Serial.printf("[REPROV] WiFi config → %s\r\n", userWifiSsid.c_str());

                mowerOk = true;
            } else if (mowerDevice) {
                webLogAdd("REPROVISION: Mower via BLE");
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
                provisionProgressCb = display_provision;
#endif
                mowerOk = provisionDevice(mowerDevice, "mower");
                provisionProgressCb = nullptr;
            } else {
                webLogAdd("REPROVISION: Mower not available — skipping");
                mowerOk = true;
            }

            reprovisioning = false;

            if (mowerOk) {
                webLogAdd("Mower re-provisioned to home WiFi!");
                setState(WIZ_DONE);
            } else {
                statusMessage = "Re-provisioning failed";
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
                display_error("Mower re-provisioning failed.\nTap to retry.");
#endif
                setState(WIZ_ERROR);
            }
        }
        break;
    }

    case WIZ_DONE: {
        if (stateJustEntered) {
            stateJustEntered = false;
            webLogAdd("Done! All devices provisioned.");
            statusMessage = "Done!";
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            display_done();
#else
            setLed(true);
#endif
            Serial.println("[STATE] Wizard complete!");
        }
        // Tap to restart
        if (ui_btnPressed) {
            ui_btnPressed = false;
            ESP.restart();
        }
        break;
    }

    case WIZ_ERROR: {
        if (stateJustEntered) {
            stateJustEntered = false;
            webLogAdd("Error: %s", statusMessage.c_str());
#if defined(WAVESHARE_LCD) || defined(JC3248W535)
            display_error(statusMessage.c_str());
#else
            blinkLed(3, 100);
            delay(300);
            blinkLed(3, 300);
            delay(300);
            blinkLed(3, 100);
#endif
        }
        if (ui_btnPressed) {
            ui_btnPressed = false;
            // Retry from the beginning
            setState(WIZ_SCAN_CHARGER);
        }
        break;
    }

    } // end switch

    // Small delay to prevent tight looping
    delay(50);
}

// ── LED helpers (non-LCD builds only) ────────────────────────────────────────

#ifndef WAVESHARE_LCD
void setLed(bool on) {
    digitalWrite(LED_PIN, on ? HIGH : LOW);
}

void blinkLed(int times, int delayMs) {
    for (int i = 0; i < times; i++) {
        setLed(true);
        delay(delayMs);
        setLed(false);
        delay(delayMs);
    }
}
#endif
