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

const int LORA_ADDR            = 718;
const int LORA_CHANNEL_CHARGER = 16;
const int LORA_CHANNEL_MOWER   = 15;
const int LORA_HC              = 20;
const int LORA_LC              = 14;

const uint8_t AES_IV[] = "abcd1234abcd1234";
const char* VERSION = "v1.0.0-lcd";

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
        case WIZ_SCAN_CHARGER:       wizStep = 1; break;
        case WIZ_PROVISION_CHARGER:  wizStep = 2; break;
        case WIZ_WAIT_CHARGER:       wizStep = 3; break;
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
    if (savedSsid.length() > 0) {
        userWifiSsid = savedSsid;
        userWifiPassword = savedPass;
        strncpy(ui_wifiSsid, savedSsid.c_str(), sizeof(ui_wifiSsid) - 1);
        strncpy(ui_wifiPassword, savedPass.c_str(), sizeof(ui_wifiPassword) - 1);
        Serial.printf("[NVS] Loaded home WiFi: %s\r\n", savedSsid.c_str());
    } else {
        Serial.println("[NVS] No saved WiFi credentials");
    }

#ifdef JC3248W535
    // JC3248W535: SD uses SD_MMC (separate bus from display — no conflict!)
    SD_MMC.setPins(SD_MMC_CLK, SD_MMC_CMD, SD_MMC_D0);
    sdMounted = SD_MMC.begin("/sdcard", true);  // 1-bit mode
    if (!sdMounted) {
        Serial.println("[SD] SD_MMC mount failed — OTA will be skipped");
    } else {
        Serial.printf("[SD] SD_MMC mounted, size: %lluMB\r\n", SD_MMC.cardSize() / (1024 * 1024));
    }

    // Find firmware file on SD
    if (!loadFirmwareInfo()) {
        Serial.println("[SD] No firmware .deb — OTA will be skipped");
    }

    // Initialize display + LVGL (BSP handles everything including LVGL task)
    display_init();
    display_boot(VERSION);
    delay(500);

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

    // Go straight to device status screen — it handles everything
    setState(WIZ_CHARGER_CONNECTED);
}

// ── Main loop — linear wizard flow ──────────────────────────────────────────

void loop() {
    processDNS();
    httpServer.handleClient();
    mqttBroker.update();

    unsigned long elapsed = (millis() - stateEnteredAt) / 1000;

    switch (currentState) {

    case WIZ_BOOT:
        // Should not stay here -- setup() transitions to WIZ_SCAN_CHARGER
        break;

    case WIZ_SCAN_CHARGER: {
        if (stateJustEntered) {
            stateJustEntered = false;
            scanRetryCount = 0;
            webLogAdd("BLE: Scanning for charger...");
            statusMessage = "Scanning for charger...";
#ifdef WAVESHARE_LCD
            display_scanning();
#endif
            scanResultCount = 0;
            selectedChargerIdx = -1;
            chargerDevice = nullptr;
            startBleScan();
        }
        if (!bleScanning) {
            // Count chargers found
            int chargerCount = 0;
            for (int i = 0; i < scanResultCount; i++) {
                if (scanResults[i].isCharger) chargerCount++;
            }
            if (chargerCount == 0) {
                webLogAdd("BLE: No charger found, retrying in 3s...");
#ifdef WAVESHARE_LCD
                display_error("No charger found\nMake sure charger is powered on\n\nRetrying...");
#endif
                delay(3000);
                stateJustEntered = true;  // retry
            } else {
                webLogAdd("BLE: Found %d charger(s)", chargerCount);
#ifdef WAVESHARE_LCD
                int selIdx = buildFilteredResults(true);  // chargers only
                display_devices(filteredResults, filteredCount, selIdx, -1);
#endif
                setState(WIZ_SELECT_CHARGER);
            }
        }
        break;
    }

    case WIZ_SELECT_CHARGER: {
#ifdef WAVESHARE_LCD
        // Accept both ui_startPressed (device list) and ui_btnPressed (confirm dialog)
        if (ui_startPressed || ui_btnPressed) {
            ui_startPressed = false;
            ui_btnPressed = false;
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
#ifdef WAVESHARE_LCD
            provisionProgressCb = display_provision;
#endif
            reprovisioning = false;  // Use AP credentials
            if (provisionDevice(chargerDevice, "charger")) {
                webLogAdd("BLE: Charger provisioned!");
                provisionProgressCb = nullptr;
                setState(WIZ_CHARGER_CONNECTED);
            } else {
                webLogAdd("BLE: Charger provisioning failed!");
                provisionProgressCb = nullptr;
                statusMessage = "Charger provisioning failed";
#ifdef WAVESHARE_LCD
                display_error("Charger provisioning failed.\nMove closer and retry.");
#endif
                setState(WIZ_ERROR);
            }
        }
        break;
    }

    case WIZ_WAIT_CHARGER: {
        if (stateJustEntered) {
            stateJustEntered = false;
            webLogAdd("MQTT: Waiting for charger to connect...");
            statusMessage = "Waiting for charger MQTT...";
        }
#ifdef WAVESHARE_LCD
        display_mqttWait(chargerMqttConnected, false);
#endif
        if (chargerMqttConnected) {
            webLogAdd("MQTT: Charger connected!");
            setState(WIZ_CHARGER_CONNECTED);
        }
        if (elapsed > 60) {
            webLogAdd("MQTT: Charger timeout — continuing to mower");
            setState(WIZ_CHARGER_CONNECTED);  // Show status even if timeout
        }
        break;
    }

    case WIZ_CHARGER_CONNECTED: {
        // Compute status: 0=not seen, 1=WiFi, 2=MQTT
        int chStatus = chargerMqttConnected ? 2 : (chargerWifiDetected ? 1 : 0);
        int mwStatus = mowerConnected ? 2 : (mowerWifiDetected ? 1 : 0);
        bool canContinue = chStatus >= 1 || mwStatus >= 1;

#ifdef WAVESHARE_LCD
        // Refresh display periodically (live updating icons)
        static unsigned long lastRefresh = 0;
        if (millis() - lastRefresh > 500) {
            lastRefresh = millis();
            display_deviceStatus(chStatus, chargerSn.c_str(),
                                mwStatus, mowerSn.c_str(),
                                canContinue);
        }
#endif
        if (stateJustEntered) {
            stateJustEntered = false;
        }

        // After 30s with no charger at all, go to BLE scan
        if (chStatus == 0 && elapsed > 30) {
            webLogAdd("No charger detected — starting BLE scan...");
            setState(WIZ_SCAN_CHARGER);
            break;
        }

        if (ui_btnPressed && canContinue) {
            ui_btnPressed = false;
            scanRetryCount = 0;
            if (mowerConnected) {
                // Mower on MQTT — skip to OTA or done
                if (mowerFwFilename.length() > 0) {
                    setState(WIZ_OTA_CONFIRM);
                } else {
                    setState(WIZ_DONE);
                }
            } else if (mowerWifiDetected) {
                webLogAdd("Mower on WiFi — waiting for MQTT...");
                setState(WIZ_WAIT_MOWER);
            } else {
                setState(WIZ_SCAN_MOWER);
            }
        }
        break;
    }

    case WIZ_SCAN_MOWER: {
        if (stateJustEntered) {
            stateJustEntered = false;
            webLogAdd("BLE: Scanning for mower...");
            statusMessage = "Scanning for mower...";
#ifdef WAVESHARE_LCD
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
#ifdef WAVESHARE_LCD
                    display_confirm("Mower Not Found",
                        "No mower found after 3 scans.",
                        "Is the mower powered on?",
                        "Skip Mower");
#endif
                    setState(WIZ_SELECT_MOWER);  // reuse select state for skip
                } else {
                    webLogAdd("BLE: No mower found, retrying in 3s... (%d/3)", scanRetryCount);
#ifdef WAVESHARE_LCD
                    display_error("No mower found\nMake sure mower is powered on\nand not connected to WiFi\n\nRetrying...");
#endif
                    delay(3000);
                    stateJustEntered = true;  // retry
                }
            } else {
                webLogAdd("BLE: Found %d mower(s)", mowerCount);
#ifdef WAVESHARE_LCD
                int selIdx = buildFilteredResults(false);  // mowers only
                display_devices(filteredResults, filteredCount, -1, selIdx);
#endif
                setState(WIZ_SELECT_MOWER);
            }
        }
        break;
    }

    case WIZ_SELECT_MOWER: {
#ifdef WAVESHARE_LCD
        if (ui_startPressed || ui_btnPressed) {
            ui_startPressed = false;
            ui_btnPressed = false;
            if (selectedMowerIdx >= 0 && mowerDevice != nullptr) {
                webLogAdd("BLE: Selected mower: %s", scanResults[selectedMowerIdx].name.c_str());
                scanRetryCount = 0;
                setState(WIZ_PROVISION_MOWER);
            } else {
                // Skip mower — no mower selected (from "Skip Mower" confirm dialog)
                webLogAdd("Skipping mower — continuing without mower");
                scanRetryCount = 0;
                setState(WIZ_DONE);
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
#ifdef WAVESHARE_LCD
            provisionProgressCb = display_provision;
#endif
            reprovisioning = false;  // Use AP credentials
            if (provisionDevice(mowerDevice, "mower")) {
                webLogAdd("BLE: Mower provisioned!");
                provisionProgressCb = nullptr;
                // Restart WiFi AP (was stopped during BLE) then go to device status
                setupWifiAP();
                while (WiFi.softAPIP() == IPAddress(0, 0, 0, 0)) { delay(100); }
                setState(WIZ_CHARGER_CONNECTED);
            } else {
                webLogAdd("BLE: Mower provisioning failed!");
                provisionProgressCb = nullptr;
                statusMessage = "Mower provisioning failed";
#ifdef WAVESHARE_LCD
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
            // Restart WiFi AP (was stopped during mower BLE provisioning)
            Serial.printf("[NET] (Re)starting WiFi AP...\r\n");
            webLogAdd("Restarting WiFi AP...");
            setupWifiAP();
            while (WiFi.softAPIP() == IPAddress(0, 0, 0, 0)) { delay(100); }
            webLogAdd("AP ready at %s — waiting for mower MQTT...", WiFi.softAPIP().toString().c_str());
            statusMessage = "Waiting for mower MQTT...";
        }
#ifdef WAVESHARE_LCD
        display_mqttWait(chargerMqttConnected, mowerConnected);
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
            webLogAdd("Firmware available: %s (charging: %s)", mowerFwFilename.c_str(), mowerCharging ? "yes" : "no");
            statusMessage = "Flash firmware?";
            String line1 = String("Flash ") + mowerFwVersion + " to " + mowerSn;
            String line2 = mowerCharging
                ? "Mower is on charger — ready!"
                : "Ensure mower is on charger!";
#ifdef WAVESHARE_LCD
            display_confirm("Flash Firmware?", line1.c_str(), line2.c_str(), "Flash");
#endif
        }
#ifdef WAVESHARE_LCD
        if (ui_btnPressed) {
            ui_btnPressed = false;
            if (!mowerCharging) {
                webLogAdd("OTA: Warning — mower may not be charging. Flashing anyway.");
            }
            setState(WIZ_OTA_FLASH);
        }
#endif
        // No timeout — wait until user acts or places mower on charger
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
#ifdef WAVESHARE_LCD
            display_ota("Waiting for mower MQTT...");
#endif
        }
        // Wait for mower to be connected before sending OTA
        if (!otaSent && mowerConnected) {
            webLogAdd("OTA: Sending firmware to mower...");
            statusMessage = "Sending OTA command...";
#ifdef WAVESHARE_LCD
            display_ota("Sending OTA command...");
#endif
            sendMowerOta();  // tries plain first, then AES
            otaSent = true;
        }
        // Display OTA progress from MQTT ota_upgrade_state messages
#ifdef WAVESHARE_LCD
        display_firmware_flash("Mower",
            otaStatus.length() > 0 ? otaStatus.c_str() : "Downloading...",
            otaProgressPercent);
#endif

        // AES retry: if plain OTA got "fail" or no response after 30s, try encrypted (v6.x)
        if (mowerOtaTriedPlain && !mowerOtaTriedAes &&
            mowerOtaSentAt > 0 && millis() - mowerOtaSentAt > 30000 &&
            otaProgressPercent == 0 && mowerConnected) {
            webLogAdd("OTA: No progress after 30s, retrying with AES...");
#ifdef WAVESHARE_LCD
            display_firmware_flash("Mower", "Retrying (encrypted)...", 0);
#endif
            mowerOtaTriedAes = true;
            sendMowerOtaWithAes(true);
        }

        // Check for completion
        if (otaStatus == "success" || otaProgressPercent >= 100) {
            webLogAdd("OTA: Firmware installed! Mower rebooting...");
#ifdef WAVESHARE_LCD
            display_firmware_flash("Mower", "Installed! Rebooting...", 100);
#endif
            delay(5000);  // Wait for mower to reboot
            // After OTA, custom firmware handles server discovery via mDNS/DNS
            // No need to re-provision to home WiFi
            setState(WIZ_DONE);
        }

        // After device disconnects (rebooting with new firmware), also proceed
        if (!mowerConnected && mowerSn.length() > 0 && elapsed > 10) {
            webLogAdd("OTA: Mower disconnected — firmware likely installed");
#ifdef WAVESHARE_LCD
            display_firmware_flash("Mower", "Rebooting...", 100);
#endif
            delay(3000);
            setState(WIZ_DONE);
        }

        // Timeout after 30 minutes
        if (elapsed > 1800) {
            statusMessage = "OTA timeout — mower did not complete firmware install";
            setState(WIZ_ERROR);
        }
        break;
    }

    case WIZ_REPROVISION: {
        if (stateJustEntered) {
            stateJustEntered = false;
            reprovisioning = true;  // Use home WiFi credentials in provisionDevice
            webLogAdd("Re-provisioning to home WiFi: %s", userWifiSsid.c_str());
            statusMessage = "Re-provisioning to home WiFi...";

#ifdef WAVESHARE_LCD
            display_reprovision("Connecting to devices...", 0, 2);
#endif
            bool chargerOk = false;
            bool mowerOk = false;

            // Re-provision charger to home WiFi
            if (chargerMqttConnected && chargerTopic.length() > 0) {
                // Fast path: send via MQTT
                webLogAdd("REPROVISION: Charger via MQTT");
#ifdef WAVESHARE_LCD
                display_reprovision("Charger -> home WiFi (MQTT)", 1, 2);
#endif
                String cPayload = "{\"set_wifi_info\":{\"sta\":{\"ssid\":\"" + userWifiSsid +
                    "\",\"passwd\":\"" + userWifiPassword +
                    "\",\"encrypt\":0},\"ap\":{\"ssid\":\"CHARGER_PILE\",\"passwd\":\"12345678\",\"encrypt\":0}}}";
                sendMqttMessage(chargerTopic, cPayload, false, "");
                chargerOk = true;
            } else if (chargerDevice) {
                webLogAdd("REPROVISION: Charger via BLE");
#ifdef WAVESHARE_LCD
                provisionProgressCb = display_provision;
                display_reprovision("Charger -> home WiFi (BLE)", 1, 2);
#endif
                chargerOk = provisionDevice(chargerDevice, "charger");
                provisionProgressCb = nullptr;
            } else {
                webLogAdd("REPROVISION: No charger found — skipping");
                chargerOk = true;
            }

            // Re-provision mower to home WiFi
            if (mowerConnected && mowerSn.length() > 0) {
                // Fast path: send via MQTT
                webLogAdd("REPROVISION: Mower via MQTT");
#ifdef WAVESHARE_LCD
                display_reprovision("Mower -> home WiFi (MQTT)", 2, 2);
#endif
                String mPayload = "{\"set_wifi_info\":{\"ap\":{\"ssid\":\"" + userWifiSsid +
                    "\",\"passwd\":\"" + userWifiPassword + "\",\"encrypt\":0}}}";
                sendMqttMessage("Dart/Send_mqtt/" + mowerSn, mPayload, true, mowerSn);
                mowerOk = true;
            } else if (mowerDevice) {
                webLogAdd("REPROVISION: Mower via BLE");
#ifdef WAVESHARE_LCD
                provisionProgressCb = display_provision;
                display_reprovision("Mower -> home WiFi (BLE)", 2, 2);
#endif
                mowerOk = provisionDevice(mowerDevice, "mower");
                provisionProgressCb = nullptr;
            } else {
                webLogAdd("REPROVISION: No mower found — skipping");
                mowerOk = true;
            }

            reprovisioning = false;

            if (chargerOk && mowerOk) {
                webLogAdd("REPROVISION: All devices re-provisioned!");
                setState(WIZ_DONE);
            } else {
                statusMessage = "Re-provisioning failed";
#ifdef WAVESHARE_LCD
                String msg = "";
                if (!chargerOk) msg += "Charger: FAILED\n";
                if (!mowerOk) msg += "Mower: FAILED\n";
                msg += "Tap to retry";
                display_error(msg.c_str());
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
#ifdef WAVESHARE_LCD
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
#ifdef WAVESHARE_LCD
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
