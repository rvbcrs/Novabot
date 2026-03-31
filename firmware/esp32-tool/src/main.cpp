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
#include <SD.h>
#include <SPI.h>
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

const int LORA_ADDR    = 718;
const int LORA_CHANNEL = 15;
const int LORA_HC      = 20;
const int LORA_LC      = 14;

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

#ifdef WAVESHARE_LCD
    // Initialize display (includes LVGL + touch + FreeRTOS task)
    display_init();
    display_boot(VERSION);
    delay(1500);  // Show boot screen briefly
#endif

    // Initialize SD card -- shares SPI bus with LCD (SCK=39, MISO=40, MOSI=38)
    // CRITICAL: deactivate LCD CS before SD access to avoid SPI bus conflict
    pinMode(LCD_CS, OUTPUT);
    digitalWrite(LCD_CS, HIGH);  // LCD deselected
    SPI.begin(39, 40, 38, SD_CS_PIN);
    sdMounted = SD.begin(SD_CS_PIN, SPI, 20000000);  // 20 MHz -- LCD CS disabled so no bus conflict
    if (!sdMounted) {
        Serial.println("[SD] Card mount failed — OTA will be skipped");
    } else {
        Serial.printf("[SD] Card mounted, size: %lluMB\r\n", SD.cardSize() / (1024 * 1024));
    }

    // Find firmware file on SD (optional -- OTA skipped if not found)
    if (!loadFirmwareInfo()) {
        Serial.println("[SD] No firmware .deb — OTA will be skipped");
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

    // Start wizard -- go straight to charger scan
    setState(WIZ_SCAN_CHARGER);
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
        // Check if charger found during scan
        if (!bleScanning) {
            if (chargerDevice != nullptr) {
                webLogAdd("BLE: Charger found! %s", chargerDevice->getName().c_str());
                setState(WIZ_PROVISION_CHARGER);
            } else {
                // No charger found -- retry scan
                webLogAdd("BLE: No charger found, retrying in 3s...");
#ifdef WAVESHARE_LCD
                display_error("No charger found\nMake sure charger is powered on\n\nRetrying...");
#endif
                delay(3000);
                stateJustEntered = true;  // retry
            }
        }
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
                setState(WIZ_WAIT_CHARGER);
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
            setState(WIZ_SCAN_MOWER);
        }
        if (elapsed > 60) {
            webLogAdd("MQTT: Charger timeout — continuing to mower");
            setState(WIZ_SCAN_MOWER);  // Continue anyway
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
            if (mowerDevice != nullptr) {
                webLogAdd("BLE: Mower found! %s", mowerDevice->getName().c_str());
                setState(WIZ_PROVISION_MOWER);
            } else {
                webLogAdd("BLE: No mower found, retrying in 3s...");
#ifdef WAVESHARE_LCD
                display_error("No mower found\nMake sure mower is powered on\nand not connected to WiFi\n\nRetrying...");
#endif
                delay(3000);
                stateJustEntered = true;  // retry
            }
        }
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
                setState(WIZ_WAIT_MOWER);
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
                setState(WIZ_OTA_FLASH);
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

    case WIZ_OTA_FLASH: {
        if (stateJustEntered) {
            stateJustEntered = false;
            otaProgressPercent = 0;
            otaStatus = "";
            webLogAdd("OTA: Sending firmware to mower...");
            statusMessage = "Sending OTA command...";
#ifdef WAVESHARE_LCD
            display_ota("Sending OTA command...");
#endif
            sendMowerOta();  // tries plain first, then AES
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
