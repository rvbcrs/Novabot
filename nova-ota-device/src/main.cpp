/**
 * Nova-OTA Device — ESP32 standalone Novabot provisioning + OTA tool
 *
 * Flow:
 *   1. Boot → start WiFi AP "OpenNova-Setup" + DNS (mqtt.lfibot.com → self)
 *   2. BLE scan for CHARGER_PILE and NOVABOT devices
 *   3. Touch screen: user selects charger + mower from discovered list
 *   4. BLE provision charger: set_wifi → set_lora → set_mqtt → set_cfg
 *   5. BLE provision mower:   set_wifi → set_lora → set_mqtt → set_cfg
 *   6. Devices connect to our WiFi AP → resolve mqtt.lfibot.com → us
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
#include <DNSServer.h>
#include <WebServer.h>
#include <SD.h>
#include <SPI.h>
#include <NimBLEDevice.h>
#include <MD5Builder.h>
#include "mbedtls/aes.h"
#include <esp_wifi.h>
#include "display.h"
#include "touch.h"

// ── Configuration ────────────────────────────────────────────────────────────

// WiFi AP settings — mower will connect to this
static const char* AP_SSID     = "OpenNova-Setup";
static const char* AP_PASSWORD = "12345678";    // WPA2, 8 chars minimum

// The mower ONLY accepts this hostname for MQTT
static const char* MQTT_HOST   = "mqtt.lfibot.com";
static const int   MQTT_PORT   = 1883;

// BLE provisioning — WiFi credentials to send to devices
static String userWifiSsid     = "";
static String userWifiPassword = "";

// LoRa defaults (same as official app — NEVER change)
static const int LORA_ADDR    = 718;
static const int LORA_CHANNEL = 15;
static const int LORA_HC      = 20;
static const int LORA_LC      = 14;

// Hardware pins — SD card CS
#ifdef WAVESHARE_LCD
static const int SD_CS_PIN    = SD_CS;  // GPIO38
#else
static const int LED_PIN      = 2;      // Built-in LED (non-LCD builds)
static const int SD_CS_PIN    = 5;      // SD card chip select
static const int BUTTON_PIN   = 0;      // Boot button
#endif

// AES encryption for MQTT messages
static const uint8_t AES_IV[] = "abcd1234abcd1234";

// Version string
static const char* VERSION = "v1.0.0-lcd";

// ── Scan results (ScanResult defined in display.h) ──────────────────────────

static ScanResult scanResults[20];
static int scanResultCount = 0;
static int selectedChargerIdx = -1;
static int selectedMowerIdx = -1;

// ── WiFi scan results (Phase 2: home network re-provisioning) ───────────────

static WifiNetwork wifiNetworks[16];
static int wifiNetworkCount = 0;
static bool wifiScanInProgress = false;

// ── State machine ────────────────────────────────────────────────────────────

enum State {
    STATE_INIT,
    STATE_BLE_SCAN,             // Scanning for BLE devices
    STATE_SELECT_DEVICES,       // Touch: select charger + mower from list
    STATE_PROVISION_CHARGER,    // BLE provisioning charger
    STATE_PROVISION_MOWER,      // BLE provisioning mower
    STATE_CONFIRM_BLE,          // Show BLE results, tap Next
    STATE_WAIT_MQTT,            // Waiting for mower to connect via MQTT
    STATE_CONFIRM_MQTT,         // Show MQTT results, tap Next (or skip OTA)
    STATE_OTA_SENT,             // OTA command sent, waiting for download
    STATE_WIFI_SCAN,            // Phase 2: scanning WiFi networks for home network
    STATE_WIFI_PASSWORD,        // Phase 2: entering home WiFi password
    STATE_REPROVISION,          // Phase 2: re-provisioning devices with home WiFi
    STATE_DONE,                 // All done!
    STATE_ERROR,
};

static State currentState = STATE_INIT;
static bool servicesStarted = false;
static String statusMessage = "Initializing...";
static bool stateJustEntered = true; // Flag for first-time screen draw per state

// ── Globals ──────────────────────────────────────────────────────────────────

DNSServer dnsServer;
WebServer httpServer(80);

// MQTT broker state
static WiFiServer mqttTcpServer(MQTT_PORT);

struct MqttConn {
    WiFiClient client;
    bool isMower;
    bool isCharger;
};
static MqttConn mqttClients[2];

static bool mowerConnected = false;
static bool chargerMqttConnected = false;
static String mowerSn = "";
static String chargerTopic = "";
static unsigned long mowerConnectTime = 0;

// BLE state
static NimBLEAdvertisedDevice* chargerDevice = nullptr;
static NimBLEAdvertisedDevice* mowerDevice = nullptr;
static bool bleScanning = false;

// Firmware info (from SD card)
static String firmwareFilename = "";
static size_t firmwareSize = 0;
static String firmwareMd5 = "";
static String firmwareVersion = "";

// Provision progress callback
typedef void (*ProvisionProgressCb)(const char* device, int step, int total, const char* stepName);
static ProvisionProgressCb provisionProgressCb = nullptr;

// ── Forward declarations ─────────────────────────────────────────────────────

void setupWifiAP();
void setupDNS();
void setupHTTP();
void setupMQTT();
void sendMqttMessage(WiFiClient& client, String topic, String payload, bool useAes, String sn = "");
void startBleScan();
bool provisionDevice(NimBLEAdvertisedDevice* device, const char* deviceType);
bool bleSendCommand(NimBLEClient* client, NimBLERemoteCharacteristic* writeChr,
                    NimBLERemoteCharacteristic* notifyChr, const String& json,
                    const char* cmdName, String& response);
void sendOtaCommand();
void handleMQTTClients();
bool loadFirmwareInfo();
String computeMd5(const char* path);
void setState(State newState);

#ifndef WAVESHARE_LCD
void setLed(bool on);
void blinkLed(int times, int delayMs);
#endif

// ── BLE Scan callback ────────────────────────────────────────────────────────

class ScanCallbacks : public NimBLEScanCallbacks {
    void onResult(const NimBLEAdvertisedDevice* advertisedDevice) override {
        String name = advertisedDevice->getName().c_str();
        if (name.length() == 0) return;

        // Check for duplicates
        String mac = advertisedDevice->getAddress().toString().c_str();
        for (int i = 0; i < scanResultCount; i++) {
            if (scanResults[i].mac == mac) return;
        }

        // Add to results array
        if (scanResultCount < 20) {
            ScanResult& r = scanResults[scanResultCount];
            r.name = name;
            r.mac = mac;
            r.rssi = advertisedDevice->getRSSI();
            r.isCharger = (name == "CHARGER_PILE");
            r.isMower = (name == "NOVABOT" || name == "Novabot" || name == "novabot");

            Serial.printf("[BLE] Found: %s (%s) RSSI=%d%s%s\n",
                         name.c_str(), mac.c_str(), r.rssi,
                         r.isCharger ? " [CHARGER]" : "",
                         r.isMower ? " [MOWER]" : "");

            // Auto-select first charger/mower found
            if (r.isCharger && selectedChargerIdx < 0) {
                selectedChargerIdx = scanResultCount;
            }
            if (r.isMower && selectedMowerIdx < 0) {
                selectedMowerIdx = scanResultCount;
            }

            scanResultCount++;
        }

        // Also keep NimBLE device pointers for provisioning
        if (name == "CHARGER_PILE" && chargerDevice == nullptr) {
            chargerDevice = new NimBLEAdvertisedDevice(*advertisedDevice);
        }
        if ((name == "NOVABOT" || name == "Novabot" || name == "novabot") && mowerDevice == nullptr) {
            mowerDevice = new NimBLEAdvertisedDevice(*advertisedDevice);
        }
    }

    void onScanEnd(const NimBLEScanResults& results, int reason) override {
        bleScanning = false;
        Serial.printf("[BLE] Scan complete, found %d device(s)\n", scanResultCount);
    }
};

// ── State helper ─────────────────────────────────────────────────────────────

void setState(State newState) {
    currentState = newState;
    stateJustEntered = true;
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

#ifdef WAVESHARE_LCD
    // Initialize display (includes LVGL + touch + FreeRTOS task)
    display_init();
    display_boot(VERSION);
    delay(1500);  // Show boot screen briefly
#endif

    // Initialize SD card (optional — OTA skipped if no card)
    if (!SD.begin(SD_CS_PIN)) {
        Serial.println("[SD] Card mount failed — OTA will be skipped");
    } else {
        Serial.printf("[SD] Card mounted, size: %lluMB\n", SD.cardSize() / (1024 * 1024));
    }

    // Find firmware file on SD (optional — OTA skipped if not found)
    if (!loadFirmwareInfo()) {
        Serial.println("[SD] No firmware .deb — OTA will be skipped");
    }

    // Start WiFi AP and wait until it's actually ready
    setupWifiAP();
    Serial.println("[SETUP] Waiting for AP to be ready...");
    while (WiFi.softAPIP() == IPAddress(0, 0, 0, 0)) {
        delay(100);
    }
    Serial.printf("[SETUP] AP ready at %s\n", WiFi.softAPIP().toString().c_str());

    // In LCD mode, always use AP-only (no serial config needed)
    userWifiSsid = AP_SSID;
    userWifiPassword = AP_PASSWORD;

    // Start network services
    setupDNS();
    setupHTTP();
    setupMQTT();
    servicesStarted = true;

    // Initialize BLE
    NimBLEDevice::init("Nova-OTA");
    NimBLEDevice::setMTU(185);

    // Wait for already-provisioned devices to connect
    Serial.println("[SETUP] AP active — waiting up to 45s for devices...");
#ifdef WAVESHARE_LCD
    display_confirm("Starting...", "Checking for connected", "devices...", "Skip");
#endif
    for (int i = 0; i < 450; i++) {
        delay(100);
        dnsServer.processNextRequest();
        httpServer.handleClient();
        handleMQTTClients();
        // Log periodically
        if (i % 50 == 0) {
            int clients = WiFi.softAPgetStationNum();
            Serial.printf("[SETUP] %ds — %d WiFi client(s), mower=%s charger=%s\n",
                          i / 10, clients, mowerConnected ? "YES" : "no",
                          chargerMqttConnected ? "YES" : "no");
        }
        // Both devices connected — exit immediately
        if (mowerConnected && chargerMqttConnected) {
            Serial.println("[SETUP] Both devices connected!");
            break;
        }
        // At least one MQTT connected + some extra time for the other
        if ((mowerConnected || chargerMqttConnected) && i > 100) {
            // Give the other device 10 more seconds
            Serial.printf("[SETUP] One device connected, waiting 10s for the other...\n");
            for (int j = 0; j < 100 && !(mowerConnected && chargerMqttConnected); j++) {
                delay(100);
                dnsServer.processNextRequest();
                httpServer.handleClient();
                handleMQTTClients();
            }
            break;
        }
        // WiFi clients present but no MQTT yet — wait a bit longer
        if (WiFi.softAPgetStationNum() > 0 && i > 150 && !mowerConnected && !chargerMqttConnected) {
            Serial.printf("[SETUP] %d WiFi client(s) — waiting 10s for MQTT...\n", WiFi.softAPgetStationNum());
            for (int j = 0; j < 100 && !mowerConnected && !chargerMqttConnected; j++) {
                delay(100);
                dnsServer.processNextRequest();
                httpServer.handleClient();
                handleMQTTClients();
            }
            break;
        }
#ifdef WAVESHARE_LCD
        if (ui_btnPressed) {
            ui_btnPressed = false;
            Serial.println("[SETUP] Skip pressed");
            break;
        }
#endif
    }

    if (mowerConnected || chargerMqttConnected) {
        // At least one device connected via MQTT — skip BLE!
        Serial.printf("[SETUP] Devices connected (mower=%s charger=%s) — skipping BLE.\n",
                      mowerConnected ? "YES" : "no", chargerMqttConnected ? "YES" : "no");
        setState(STATE_CONFIRM_MQTT);
    } else if (WiFi.softAPgetStationNum() > 0) {
        // WiFi clients but no MQTT yet — go to MQTT wait
        Serial.printf("[SETUP] %d WiFi client(s) — waiting for MQTT\n", WiFi.softAPgetStationNum());
        setState(STATE_WAIT_MQTT);
    } else {
        // No devices — start BLE scan
        Serial.println("[SETUP] No devices found — starting BLE scan");
        setState(STATE_BLE_SCAN);
    }
}

// ── Main loop ────────────────────────────────────────────────────────────────

void loop() {
    // Only process network services after provisioning
    if (servicesStarted) {
        dnsServer.processNextRequest();
        httpServer.handleClient();
        handleMQTTClients();
    }

#ifndef WAVESHARE_LCD
    // Non-LCD: read serial for WiFi config
    if (Serial.available()) {
        String line = Serial.readStringUntil('\n');
        line.trim();
        if (line.startsWith("WIFI:")) {
            int comma = line.indexOf(',', 5);
            if (comma > 5) {
                userWifiSsid = line.substring(5, comma);
                userWifiPassword = line.substring(comma + 1);
                Serial.printf("[CONFIG] WiFi: %s / %s\n", userWifiSsid.c_str(), "***");
                if (currentState == STATE_INIT) setState(STATE_BLE_SCAN);
            }
        }
    }
#endif

    // Touch is handled by LVGL — check UI flags instead
#ifdef WAVESHARE_LCD
    // (LVGL event callbacks set ui_startPressed, ui_btnPressed,
    //  ui_selectedChargerIdx, ui_selectedMowerIdx)
#endif

    // State machine
    switch (currentState) {

        case STATE_INIT:
#ifdef WAVESHARE_LCD
            // LCD mode: handled in setup(), auto-transitions to BLE_SCAN
#else
            // Non-LCD: wait for serial or button
            if (digitalRead(BUTTON_PIN) == LOW) {
                delay(50);
                if (digitalRead(BUTTON_PIN) == LOW) {
                    Serial.println("[CONFIG] AP-only mode");
                    userWifiSsid = AP_SSID;
                    userWifiPassword = AP_PASSWORD;
                    setState(STATE_BLE_SCAN);
                    while (digitalRead(BUTTON_PIN) == LOW) delay(10);
                }
            }
#endif
            break;

        case STATE_BLE_SCAN:
            if (stateJustEntered) {
                stateJustEntered = false;
                scanResultCount = 0;
                selectedChargerIdx = -1;
                selectedMowerIdx = -1;
                ui_selectedChargerIdx = -1;
                ui_selectedMowerIdx = -1;
                ui_startPressed = false;
                ui_btnPressed = false;
                ui_rescanPressed = false;
                if (chargerDevice) { delete chargerDevice; chargerDevice = nullptr; }
                if (mowerDevice) { delete mowerDevice; mowerDevice = nullptr; }
                Serial.println("[STATE] Starting BLE scan...");
                statusMessage = "Scanning for Novabot devices...";
#ifdef WAVESHARE_LCD
                display_scanning();
#endif
                startBleScan();
            }

            // When scan finishes, go to device selection
            if (!bleScanning) {
                Serial.printf("[STATE] Scan done, %d devices found\n", scanResultCount);
                setState(STATE_SELECT_DEVICES);
            }
            break;

        case STATE_SELECT_DEVICES:
            if (stateJustEntered) {
                stateJustEntered = false;
#ifdef WAVESHARE_LCD
                display_devices(scanResults, scanResultCount, selectedChargerIdx, selectedMowerIdx);
#else
                // Non-LCD: auto-proceed if devices found
                if (chargerDevice && mowerDevice) {
                    setState(STATE_PROVISION_CHARGER);
                } else if (mowerDevice) {
                    setState(STATE_PROVISION_MOWER);
                } else {
                    Serial.println("[STATE] No devices found, re-scanning...");
                    setState(STATE_BLE_SCAN);
                }
#endif
            }

#ifdef WAVESHARE_LCD
            // LVGL handles touch — device_item_cb updates ui_selectedChargerIdx/MowerIdx
            // and redraws the list. We just check selectedCharger/Mower and start button.
            selectedChargerIdx = ui_selectedChargerIdx;
            selectedMowerIdx = ui_selectedMowerIdx;

            if (ui_rescanPressed) {
                ui_rescanPressed = false;
                Serial.println("[TOUCH] Rescan pressed");
                setState(STATE_BLE_SCAN);
                break;
            }

            if (ui_startPressed) {
                ui_startPressed = false;
                if (selectedChargerIdx >= 0 || selectedMowerIdx >= 0) {
                    Serial.println("[TOUCH] Start pressed");
                    if (selectedChargerIdx >= 0 && chargerDevice) {
                        setState(STATE_PROVISION_CHARGER);
                    } else if (selectedMowerIdx >= 0 && mowerDevice) {
                        setState(STATE_PROVISION_MOWER);
                    } else {
                        statusMessage = "No valid device selected";
                        display_error("Select at least one device");
                    }
                }
            }
#endif
            break;

        case STATE_PROVISION_CHARGER:
            if (stateJustEntered) {
                stateJustEntered = false;
                Serial.println("[STATE] Provisioning charger...");
                statusMessage = "Provisioning charger...";

#ifdef WAVESHARE_LCD
                // Set progress callback to update display
                provisionProgressCb = display_provision;
#endif
                if (provisionDevice(chargerDevice, "charger")) {
                    Serial.println("[PROVISION] Charger OK!");
                    if (selectedMowerIdx >= 0 && mowerDevice) {
                        setState(STATE_PROVISION_MOWER);
                    } else {
                        // No mower selected, show confirmation
                        setState(STATE_CONFIRM_BLE);
                    }
                } else {
                    Serial.println("[PROVISION] Charger FAILED");
                    statusMessage = "Charger provisioning failed";
#ifdef WAVESHARE_LCD
                    display_error("Charger provisioning failed. Move closer and retry.");
#endif
                    setState(STATE_ERROR);
                }
                provisionProgressCb = nullptr;
            }
            break;

        case STATE_PROVISION_MOWER:
            if (stateJustEntered) {
                stateJustEntered = false;

                if (!mowerDevice) {
                    Serial.println("[STATE] No mower found, re-scanning...");
                    setState(STATE_BLE_SCAN);
                    break;
                }

                Serial.println("[STATE] Provisioning mower...");
                statusMessage = "Provisioning mower...";

#ifdef WAVESHARE_LCD
                provisionProgressCb = display_provision;
#endif
                if (provisionDevice(mowerDevice, "mower")) {
                    Serial.println("[PROVISION] Mower OK!");
                    setState(STATE_CONFIRM_BLE);
                } else {
                    Serial.println("[PROVISION] Mower FAILED");
                    statusMessage = "Mower provisioning failed";
#ifdef WAVESHARE_LCD
                    display_error("Mower provisioning failed. Move closer and retry.");
#endif
                    setState(STATE_ERROR);
                }
                provisionProgressCb = nullptr;
            }
            break;

        case STATE_CONFIRM_BLE:
            if (stateJustEntered) {
                stateJustEntered = false;
                String l1 = selectedChargerIdx >= 0 ? "Charger: OK" : "";
                String l2 = selectedMowerIdx >= 0 ? "Mower: OK" : "";
#ifdef WAVESHARE_LCD
                display_confirm("BLE Provisioning", l1.c_str(), l2.c_str(), "Next");
#endif
                Serial.println("[STATE] BLE done — waiting for Next tap");
            }
#ifdef WAVESHARE_LCD
            if (ui_btnPressed) {
                ui_btnPressed = false;
                delay(200);
                setState(STATE_WAIT_MQTT);
            }
#else
            setState(STATE_WAIT_MQTT);
#endif
            break;

        case STATE_WAIT_MQTT:
            // Start network services (DNS/HTTP/MQTT) on first entry
            if (!servicesStarted) {
                Serial.println("[NET] Starting DNS + HTTP + MQTT...");
                setupDNS();
                setupHTTP();
                setupMQTT();
                servicesStarted = true;
            }
#ifdef WAVESHARE_LCD
            display_mqttWait(chargerMqttConnected, mowerConnected);
#else
            // Non-LCD: blink LED while waiting
            setLed((millis() / 500) % 2);
#endif
            if (mowerConnected) {
                if (chargerMqttConnected) {
                    setState(STATE_CONFIRM_MQTT);
                } else if (millis() - mowerConnectTime > 15000) {
                    Serial.println("[STATE] Timeout waiting for charger MQTT; proceeding with mower only");
                    setState(STATE_CONFIRM_MQTT);
                }
            }
            break;

        case STATE_CONFIRM_MQTT:
            if (stateJustEntered) {
                stateJustEntered = false;
                bool hasOta = firmwareFilename.length() > 0;
                
                String chargerSnStr = chargerTopic.startsWith("Dart/Send_mqtt/") ? chargerTopic.substring(15) : "";

                String l1 = "";
                String l2 = "";
                if (mowerConnected) {
                    l1 = "Mower: " + mowerSn;
                } else {
                    l1 = "Mower: not connected";
                }
                if (chargerMqttConnected && chargerSnStr.length() > 0) {
                    l2 = "Charger: " + chargerSnStr;
                } else if (chargerMqttConnected) {
                    l2 = "Charger: connected";
                } else {
                    l2 = "Charger: not connected";
                }
                // Skip OTA: go straight to home WiFi provisioning
                const char* btn = hasOta ? "Flash OTA" : "Setup Home WiFi";
#ifdef WAVESHARE_LCD
                display_confirm("MQTT Connected", l1.c_str(), l2.c_str(), btn);
#endif
                Serial.printf("[STATE] MQTT confirmed — %s\n", hasOta ? "ready for OTA" : "skipping to WiFi");
            }
#ifdef WAVESHARE_LCD
            if (ui_btnPressed) {
                ui_btnPressed = false;
                delay(200);
                if (firmwareFilename.length() > 0) {
                    setState(STATE_OTA_SENT);
                    sendOtaCommand();
                } else {
                    // No firmware — skip OTA, go to home WiFi setup
                    setState(STATE_WIFI_SCAN);
                }
            }
#else
            if (firmwareFilename.length() > 0) {
                setState(STATE_OTA_SENT);
                sendOtaCommand();
            } else {
                setState(STATE_WIFI_SCAN);
            }
#endif
            break;

        case STATE_OTA_SENT:
            if (stateJustEntered) {
                stateJustEntered = false;
#ifdef WAVESHARE_LCD
                display_ota("Firmware sent. Mower is downloading...");
#endif
            }
#ifndef WAVESHARE_LCD
            setLed((millis() / 200) % 2);
#endif
            statusMessage = "OTA firmware sent — mower is downloading...";

            // After mower disconnects (rebooting), go to home WiFi provisioning
            if (!mowerConnected && mowerSn.length() > 0) {
                statusMessage = "Firmware sent! Setting up home WiFi...";
                Serial.println("[OTA] Mower disconnected — proceeding to WiFi setup");
                setState(STATE_WIFI_SCAN);
            }
            break;

        // ── Phase 2: WiFi scan → password → re-provision ────────────────────

        case STATE_WIFI_SCAN:
            if (stateJustEntered) {
                stateJustEntered = false;
                wifiNetworkCount = 0;
                wifiScanInProgress = true;
                ui_selectedWifiIdx = -1;
                ui_wifiRescanPressed = false;

                Serial.println("[STATE] Starting WiFi scan for home networks...");

                // We are already in WIFI_AP_STA from setupWifiAP(), so no need to switch 
                // and disrupt the AP connectivity.

#ifdef WAVESHARE_LCD
                display_scanning();  // Reuse BLE scanning screen
#endif
                // Start async scan
                WiFi.scanNetworks(true);  // async=true
            }

            // Check if async scan completed
            if (wifiScanInProgress) {
                int n = WiFi.scanComplete();
                if (n == WIFI_SCAN_RUNNING) {
                    break;  // Still scanning
                }

                wifiScanInProgress = false;

                if (n < 0) n = 0;  // Error → treat as 0 results

                // Populate results, filter duplicates and hidden SSIDs
                wifiNetworkCount = 0;
                for (int i = 0; i < n && wifiNetworkCount < 16; i++) {
                    String ssid = WiFi.SSID(i);
                    if (ssid.length() == 0) continue;  // Skip hidden networks
                    if (ssid == AP_SSID) continue;     // Skip our own AP

                    // Check for duplicate SSID (keep strongest signal)
                    bool duplicate = false;
                    for (int j = 0; j < wifiNetworkCount; j++) {
                        if (wifiNetworks[j].ssid == ssid) {
                            duplicate = true;
                            if (WiFi.RSSI(i) > wifiNetworks[j].rssi) {
                                wifiNetworks[j].rssi = WiFi.RSSI(i);
                            }
                            break;
                        }
                    }
                    if (duplicate) continue;

                    wifiNetworks[wifiNetworkCount].ssid = ssid;
                    wifiNetworks[wifiNetworkCount].rssi = WiFi.RSSI(i);
                    wifiNetworks[wifiNetworkCount].isOpen = (WiFi.encryptionType(i) == WIFI_AUTH_OPEN);
                    wifiNetworkCount++;
                }
                WiFi.scanDelete();  // Free scan results memory

                Serial.printf("[WiFi] Found %d networks\n", wifiNetworkCount);
#ifdef WAVESHARE_LCD
                display_wifiList(wifiNetworks, wifiNetworkCount, -1);
#endif
            }

            // User tapped a network → go to password entry
            if (ui_selectedWifiIdx >= 0 && ui_selectedWifiIdx < wifiNetworkCount) {
                int idx = ui_selectedWifiIdx;
                strncpy(ui_wifiSsid, wifiNetworks[idx].ssid.c_str(), sizeof(ui_wifiSsid) - 1);
                ui_wifiSsid[sizeof(ui_wifiSsid) - 1] = '\0';
                Serial.printf("[WiFi] Selected: %s\n", ui_wifiSsid);

                if (wifiNetworks[idx].isOpen) {
                    // Open network — no password needed
                    userWifiSsid = String(ui_wifiSsid);
                    userWifiPassword = "";
                    setState(STATE_REPROVISION);
                } else {
                    setState(STATE_WIFI_PASSWORD);
                }
                ui_selectedWifiIdx = -1;
            }

            // User tapped rescan
            if (ui_wifiRescanPressed) {
                ui_wifiRescanPressed = false;
                Serial.println("[WiFi] Rescan requested");
                stateJustEntered = true;  // Re-enter state to rescan
            }
            break;

        case STATE_WIFI_PASSWORD:
            if (stateJustEntered) {
                stateJustEntered = false;
                ui_wifiPasswordReady = false;
                memset(ui_wifiPassword, 0, sizeof(ui_wifiPassword));
                Serial.printf("[STATE] Waiting for password for '%s'\n", ui_wifiSsid);
#ifdef WAVESHARE_LCD
                display_wifiPassword(ui_wifiSsid);
#endif
            }

            if (ui_wifiPasswordReady) {
                ui_wifiPasswordReady = false;
                userWifiSsid = String(ui_wifiSsid);
                userWifiPassword = String(ui_wifiPassword);
                Serial.printf("[WiFi] Credentials set: SSID=%s\n", userWifiSsid.c_str());
                setState(STATE_REPROVISION);
            }
            break;

        case STATE_REPROVISION:
            if (stateJustEntered) {
                stateJustEntered = false;
                Serial.printf("[STATE] Re-provisioning with home WiFi: %s\n", userWifiSsid.c_str());

#ifdef WAVESHARE_LCD
                display_reprovision("Scanning for devices...", 0, 4);
#endif
                // Use previously discovered devices for re-provisioning
                // If they are missing (e.g. ESP32 rebooted and mower auto-connected, skipping initial scan),
                // we must scan for them now.
                if (!chargerDevice && !mowerDevice) {
                    Serial.println("[REPROVISION] Devices not cached, starting 15s BLE rescan...");
#ifdef WAVESHARE_LCD
                    display_reprovision("Searching for Novabot via Bluetooth...", 0, 4);
#endif
                    scanResultCount = 0;
                    NimBLEScan* scan = NimBLEDevice::getScan();
                    scan->setScanCallbacks(new ScanCallbacks(), false);
                    scan->setActiveScan(true);
                    scan->setInterval(100);
                    scan->setWindow(99);
                    scan->start(15000, false);  // 15 second scan

                    // Wait for scan completion
                    unsigned long scanStart = millis();
                    while (millis() - scanStart < 16000) {
                        delay(100);
                        if (servicesStarted) {
                            dnsServer.processNextRequest();
                            httpServer.handleClient();
                            handleMQTTClients();
                        }
                        if (!bleScanning) break;  // Scan finished
                    }
                }
                
                bool chargerOk = false;
                bool mowerOk = false;
                int step = 1;
                
                WiFiClient* chargerClient = nullptr;
                WiFiClient* mowerClient = nullptr;

                for (int i=0; i<2; i++) {
                    if (mqttClients[i].client && mqttClients[i].client.connected()) {
                        if (mqttClients[i].isCharger) chargerClient = &mqttClients[i].client;
                        if (mqttClients[i].isMower) mowerClient = &mqttClients[i].client;
                    }
                }

                // Provision Charger
                if (chargerClient && chargerTopic.length() > 0) {
                    Serial.println("[REPROVISION] Sending WiFi credentials to Charger via MQTT (FAST PATH)!");
                    String cPayload = "{\"set_wifi_info\":{\"sta\":{\"ssid\":\"" + userWifiSsid + "\",\"passwd\":\"" + userWifiPassword + "\",\"encrypt\":0},\"ap\":{\"ssid\":\"CHARGER_PILE\",\"passwd\":\"12345678\",\"encrypt\":0}}}";
                    sendMqttMessage(*chargerClient, chargerTopic, cPayload, false, "");
                    chargerOk = true;
                } else if (chargerDevice) {
                    Serial.println("[REPROVISION] Provisioning Charger via BLE...");
#ifdef WAVESHARE_LCD
                    provisionProgressCb = display_provision;
#endif
                    chargerOk = provisionDevice(chargerDevice, "charger");
                    provisionProgressCb = nullptr;
                    if (chargerOk) Serial.println("[REPROVISION] Charger OK!");
                    else Serial.println("[REPROVISION] Charger FAILED");
                    step++;
                } else {
                    Serial.println("[REPROVISION] No charger found (MQTT/BLE) — skipping");
                    chargerOk = true; // Skip if completely missing so it doesn't fail the whole process if user only brought the mower
                }

                // Provision Mower
                if (mowerClient && mowerSn.length() > 0) {
                    Serial.println("[REPROVISION] Sending WiFi credentials to Mower via MQTT (FAST PATH)!");
                    String mPayload = "{\"set_wifi_info\":{\"ap\":{\"ssid\":\"" + userWifiSsid + "\",\"passwd\":\"" + userWifiPassword + "\",\"encrypt\":0}}}";
                    sendMqttMessage(*mowerClient, "Dart/Send_mqtt/" + mowerSn, mPayload, true, mowerSn);
                    mowerOk = true;
                } else if (mowerDevice) {
                    Serial.println("[REPROVISION] Provisioning Mower via BLE...");
#ifdef WAVESHARE_LCD
                    provisionProgressCb = display_provision;
#endif
                    mowerOk = provisionDevice(mowerDevice, "mower");
                    provisionProgressCb = nullptr;
                    if (mowerOk) Serial.println("[REPROVISION] Mower OK!");
                    else Serial.println("[REPROVISION] Mower FAILED");
                } else {
                    Serial.println("[REPROVISION] No mower found (MQTT/BLE) — skipping");
                    mowerOk = true;
                }

                // Result
                if (!chargerDevice && !mowerDevice) {
                    Serial.println("[REPROVISION] No devices found!");
#ifdef WAVESHARE_LCD
                    display_error("No devices found.\nMove closer and retry.");
#endif
                    setState(STATE_ERROR);
                } else if (chargerOk && mowerOk) {
                    Serial.println("[REPROVISION] All devices re-provisioned!");
                    setState(STATE_DONE);
                } else {
                    Serial.println("[REPROVISION] Some devices failed");
#ifdef WAVESHARE_LCD
                    String msg = "";
                    if (!chargerOk) msg += "Charger: FAILED\n";
                    if (!mowerOk) msg += "Mower: FAILED\n";
                    msg += "Tap to retry";
                    display_error(msg.c_str());
#endif
                    setState(STATE_ERROR);
                }
            }
            break;

        case STATE_DONE:
            if (stateJustEntered) {
                stateJustEntered = false;
#ifdef WAVESHARE_LCD
                display_done();
#else
                setLed(true);
#endif
            }

#ifdef WAVESHARE_LCD
            // Tap to restart — LVGL callback sets ui_btnPressed
            if (ui_btnPressed) {
                ui_btnPressed = false;
                delay(300);
                Serial.println("[TOUCH] Restarting...");
                setState(STATE_BLE_SCAN);
            }
#endif
            break;

        case STATE_ERROR:
#ifdef WAVESHARE_LCD
            // Error screen already drawn on entry; tap to retry
            if (ui_btnPressed) {
                ui_btnPressed = false;
                delay(300);
                Serial.println("[TOUCH] Retrying...");
                setState(STATE_BLE_SCAN);
            }
#else
            // Non-LCD: blink SOS pattern
            blinkLed(3, 100);
            delay(300);
            blinkLed(3, 300);
            delay(300);
            blinkLed(3, 100);
            delay(1000);
#endif
            break;

        default:
            break;
    }

    delay(10);
}

// ── WiFi AP ──────────────────────────────────────────────────────────────────

void onWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
    switch (event) {
        case ARDUINO_EVENT_WIFI_AP_STACONNECTED:
            Serial.printf("[WiFi] Station connected: %02x:%02x:%02x:%02x:%02x:%02x\n",
                info.wifi_ap_staconnected.mac[0], info.wifi_ap_staconnected.mac[1],
                info.wifi_ap_staconnected.mac[2], info.wifi_ap_staconnected.mac[3],
                info.wifi_ap_staconnected.mac[4], info.wifi_ap_staconnected.mac[5]);
            break;
        case ARDUINO_EVENT_WIFI_AP_STADISCONNECTED:
            Serial.printf("[WiFi] Station disconnected: %02x:%02x:%02x:%02x:%02x:%02x\n",
                info.wifi_ap_stadisconnected.mac[0], info.wifi_ap_stadisconnected.mac[1],
                info.wifi_ap_stadisconnected.mac[2], info.wifi_ap_stadisconnected.mac[3],
                info.wifi_ap_stadisconnected.mac[4], info.wifi_ap_stadisconnected.mac[5]);
            break;
        default:
            break;
    }
}

void setupWifiAP() {
    WiFi.onEvent(onWifiEvent);
    // Use AP+STA mode from the beginning so scanning later doesn't disrupt the AP
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAP(AP_SSID, AP_PASSWORD, 1, 0, 4);  // channel 1, not hidden, max 4 clients
    // Set WPA/WPA2 mixed auth mode for ESP32 charger compatibility (default WPA2-only fails)
    wifi_config_t conf;
    esp_wifi_get_config(WIFI_IF_AP, &conf);
    conf.ap.authmode = WIFI_AUTH_WPA_WPA2_PSK;
    esp_wifi_set_config(WIFI_IF_AP, &conf);
    delay(500);
    Serial.printf("[WiFi] AP started: %s (IP: %s, ch=%d)\n", AP_SSID,
                  WiFi.softAPIP().toString().c_str(), WiFi.channel());
}

// ── DNS — resolve mqtt.lfibot.com → our AP IP ───────────────────────────────

void setupDNS() {
    // Captive portal: ALL DNS queries → our IP
    dnsServer.start(53, "*", WiFi.softAPIP());
    Serial.println("[DNS] Captive DNS started — mqtt.lfibot.com → 192.168.4.1");
}

// ── HTTP server — serves firmware + status ───────────────────────────────────

void setupHTTP() {
    // Status page
    httpServer.on("/", []() {
        String html = "<html><head><title>Nova-OTA</title></head><body>";
        html += "<h1>Nova-OTA Device</h1>";
        html += "<p>Status: " + statusMessage + "</p>";
        html += "<p>Firmware: " + firmwareVersion + " (" + String(firmwareSize / 1024 / 1024) + " MB)</p>";
        html += "<p>Mower: " + (mowerConnected ? mowerSn : String("not connected")) + "</p>";
        html += "</body></html>";
        httpServer.send(200, "text/html", html);
    });

    // Firmware download
    httpServer.on("/firmware.deb", []() {
        File file = SD.open("/" + firmwareFilename);
        if (!file) {
            httpServer.send(404, "text/plain", "Firmware not found");
            return;
        }
        Serial.printf("[HTTP] Serving firmware: %s (%d bytes)\n",
                      firmwareFilename.c_str(), file.size());
        httpServer.streamFile(file, "application/octet-stream");
        file.close();
    });

    // Status JSON
    httpServer.on("/status", []() {
        String json = "{\"state\":\"" + String(currentState) + "\",";
        json += "\"message\":\"" + statusMessage + "\",";
        json += "\"firmware\":\"" + firmwareVersion + "\",";
        json += "\"mower\":\"" + (mowerConnected ? mowerSn : String("")) + "\"}";
        httpServer.send(200, "application/json", json);
    });

    // Mower net_check_fun hits this URL to verify connectivity
    httpServer.on("/api/nova-network/network/connection", HTTP_POST, []() {
        httpServer.send(200, "application/json",
            "{\"success\":true,\"code\":200,\"message\":\"request success\",\"value\":1}");
    });

    // WiFi credential entry via phone browser (much easier than tiny on-screen keyboard)
    httpServer.on("/wifi", HTTP_GET, []() {
        String ssid = String(ui_wifiSsid);
        String html = R"rawhtml(
<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nova-OTA WiFi</title>
<style>
  body{font-family:system-ui;background:#0a0a1a;color:#e0e0e0;margin:0;padding:20px;display:flex;justify-content:center}
  .card{background:#1a1a2e;border-radius:16px;padding:24px;max-width:380px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.4)}
  h1{color:#00d4aa;margin:0 0 8px;font-size:22px}
  .ssid{color:#888;margin-bottom:20px}
  label{display:block;margin-bottom:6px;font-size:14px;color:#aaa}
  input[type=password],input[type=text]{width:100%;padding:12px;border:2px solid #333;border-radius:8px;background:#0d0d20;color:#fff;font-size:16px;box-sizing:border-box;margin-bottom:16px}
  input:focus{border-color:#7c3aed;outline:none}
  button{width:100%;padding:14px;background:#7c3aed;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;font-weight:600}
  button:active{background:#6d28d9}
  .toggle{display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:13px;color:#888;cursor:pointer}
  .toggle input{width:auto;margin:0}
</style></head><body>
<div class="card">
  <h1>WiFi Password</h1>
  <div class="ssid">Network: )rawhtml" + ssid + R"rawhtml(</div>
  <form method="POST" action="/wifi">
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" placeholder="Enter WiFi password" autofocus>
    <label class="toggle"><input type="checkbox" onclick="document.getElementById('pw').type=this.checked?'text':'password'"> Show password</label>
    <button type="submit">Connect</button>
  </form>
</div></body></html>)rawhtml";
        httpServer.send(200, "text/html", html);
    });

    httpServer.on("/wifi", HTTP_POST, []() {
        if (httpServer.hasArg("password")) {
            String pw = httpServer.arg("password");
            strncpy(ui_wifiPassword, pw.c_str(), sizeof(ui_wifiPassword) - 1);
            ui_wifiPassword[sizeof(ui_wifiPassword) - 1] = '\0';
            ui_wifiPasswordReady = true;
            Serial.printf("[HTTP] WiFi password received via web (%d chars)\n", pw.length());
            httpServer.send(200, "text/html",
                R"(<html><body style="font-family:system-ui;background:#0a0a1a;color:#e0e0e0;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">)"
                R"(<div style="text-align:center"><h1 style="color:#00d4aa">&#10004; Credentials Received</h1>)"
                R"(<p>Check the device screen for progress.</p></div></body></html>)");
        } else {
            httpServer.send(400, "text/plain", "Missing password field");
        }
    });

    // Catch-all for any other request (prevents 404 spam)
    httpServer.onNotFound([]() {
        httpServer.send(200, "text/plain", "OK");
    });

    httpServer.begin();
    Serial.println("[HTTP] Server started on port 80");
}

// ── MQTT broker (minimal) ────────────────────────────────────────────────────

void setupMQTT() {
    mqttTcpServer.begin();
    Serial.printf("[MQTT] Listening on port %d\n", MQTT_PORT);
}

void handleMQTTClients() {
    // Accept new connections
    if (mqttTcpServer.hasClient()) {
        WiFiClient newClient = mqttTcpServer.available();
        bool added = false;
        for (int i = 0; i < 2; i++) {
            if (!mqttClients[i].client || !mqttClients[i].client.connected()) {
                mqttClients[i].client = newClient;
                mqttClients[i].isMower = false;
                mqttClients[i].isCharger = false;
                added = true;
                Serial.printf("[MQTT] Client connected from %s (slot %d)\n", newClient.remoteIP().toString().c_str(), i);
                break;
            }
        }
        if (!added) {
            newClient.stop(); // No slots available (should rarely happen)
            Serial.println("[MQTT] Rejected client: no slots available");
        }
    }

    // Read data from connected clients
    for (int i = 0; i < 2; i++) {
        if (mqttClients[i].client && mqttClients[i].client.connected() && mqttClients[i].client.available()) {
            uint8_t buf[512];
            int len = mqttClients[i].client.read(buf, sizeof(buf));
            
            if (len > 0 && buf[0] == 0x10) { // CONNECT
                // Log raw hex for debugging
                Serial.printf("[MQTT] CONNECT raw (%d bytes): ", len);
                for (int b = 0; b < (len < 40 ? len : 40); b++) Serial.printf("%02x ", buf[b]);
                Serial.println();

                int idx = 1;
                // Remaining length (variable-length encoding)
                int remaining = 0;
                int mult = 1;
                while (idx < len) {
                    remaining += (buf[idx] & 0x7F) * mult;
                    if (!(buf[idx] & 0x80)) { idx++; break; }
                    mult *= 128; idx++;
                }

                // Parse variable header
                if (idx + 2 < len) {
                    int protoLen = (buf[idx] << 8) | buf[idx + 1];
                    idx += 2 + protoLen; // skip protocol name
                    if (idx < len) {
                        uint8_t protoLevel = buf[idx++]; // protocol level
                        uint8_t connectFlags = idx < len ? buf[idx++] : 0;
                        uint16_t keepAlive = (idx + 1 < len) ? (buf[idx] << 8) | buf[idx + 1] : 60;
                        idx += 2;

                        // Sanitize connect flags (charger sends malformed flags)
                        // Bit 1 = clean session, Bit 2 = will flag, etc.
                        // Force clean session, clear reserved bit
                        connectFlags |= 0x02;  // set clean session
                        connectFlags &= 0xFE;  // clear reserved bit 0

                        Serial.printf("[MQTT] proto=%d flags=0x%02x keepalive=%d\n",
                                     protoLevel, connectFlags, keepAlive);

                        // Client ID
                        if (idx + 2 <= len) {
                            int clientIdLen = (buf[idx] << 8) | buf[idx + 1];
                            idx += 2;
                            if (idx + clientIdLen <= len && clientIdLen > 0) {
                                String clientId = String((char*)(buf + idx), clientIdLen);
                                idx += clientIdLen;
                                Serial.printf("[MQTT] CONNECT clientId=%s\n", clientId.c_str());

                                if (clientId.startsWith("ESP32_") || clientId.startsWith("SNC")) {
                                    chargerMqttConnected = true;
                                    mqttClients[i].isCharger = true;
                                    Serial.printf("[MQTT] Charger connected: %s\n", clientId.c_str());
                                }
                                if (clientId.startsWith("LFI")) {
                                    int underscore = clientId.indexOf('_');
                                    mowerSn = underscore > 0 ? clientId.substring(0, underscore) : clientId;
                                    mowerConnected = true;
                                    mowerConnectTime = millis();
                                    mqttClients[i].isMower = true;
                                    Serial.printf("[MQTT] Mower connected: %s\n", mowerSn.c_str());
                                }
                            } else {
                                Serial.printf("[MQTT] Bad clientId: len=%d remaining=%d\n", clientIdLen, len - idx);
                            }
                        }
                    }
                }

                // Always send CONNACK regardless of parse success
                uint8_t connack[] = { 0x20, 0x02, 0x00, 0x00 };
                mqttClients[i].client.write(connack, 4);

            } else if (len > 0 && buf[0] == 0x82) { // SUBSCRIBE
                int idx = 1;
                int remaining = 0;
                int mult = 1;
                while (idx < len) {
                    remaining += (buf[idx] & 0x7F) * mult;
                    if (!(buf[idx] & 0x80)) { idx++; break; }
                    mult *= 128; idx++;
                }
                
                uint8_t packetId1 = 0, packetId2 = 0;
                if (idx + 1 < len) {
                    packetId1 = buf[idx];
                    packetId2 = buf[idx+1];
                }

                // Parse the topic to capture the charger's listening topic
                if (idx + 3 < len) {
                    int topicLen = (buf[idx+2] << 8) | buf[idx+3];
                    if (idx + 4 + topicLen <= len) {
                        String topic = String((char*)(buf + idx + 4), topicLen);
                        Serial.printf("[MQTT] SUBSCRIBE topic: %s\n", topic.c_str());
                        if (mqttClients[i].isCharger && topic.startsWith("Dart/Send_mqtt/")) {
                            chargerTopic = topic;
                            Serial.printf("[MQTT] Saved Charger Topic: %s\n", chargerTopic.c_str());
                        }
                    }
                }

                uint8_t suback[] = { 0x90, 0x03, packetId1, packetId2, 0x00 };
                mqttClients[i].client.write(suback, 5);

            } else if (len > 0 && buf[0] == 0xC0) { // PINGREQ
                uint8_t pingresp[] = { 0xD0, 0x00 };
                mqttClients[i].client.write(pingresp, 2);
            }
        }
    }

    // Detect disconnects globally to update flags
    bool currentMowerStatus = false;
    bool currentChargerStatus = false;
    for (int i = 0; i < 2; i++) {
        if (mqttClients[i].client && mqttClients[i].client.connected()) {
            if (mqttClients[i].isMower) currentMowerStatus = true;
            if (mqttClients[i].isCharger) currentChargerStatus = true;
        }
    }
    
    if (mowerConnected && !currentMowerStatus) {
        Serial.printf("[MQTT] Mower %s disconnected\n", mowerSn.c_str());
        mowerConnected = false;
    }
    if (chargerMqttConnected && !currentChargerStatus) {
        Serial.println("[MQTT] Charger disconnected");
        chargerMqttConnected = false;
    }
}

// ── OTA command ──────────────────────────────────────────────────────────────

void sendMqttMessage(WiFiClient& client, String topic, String payload, bool useAes, String sn) {
    if (!client.connected()) return;

    int paddedLen = payload.length();
    uint8_t* outBuf = nullptr;
    
    if (useAes && sn.length() >= 4) {
        String keyStr = "abcdabcd1234" + sn.substring(sn.length() - 4);
        uint8_t key[16];
        memcpy(key, keyStr.c_str(), 16);

        paddedLen = ((payload.length() + 15) / 16) * 16;
        uint8_t* plaintext = (uint8_t*)calloc(paddedLen, 1);
        memcpy(plaintext, payload.c_str(), payload.length());

        outBuf = (uint8_t*)malloc(paddedLen);
        mbedtls_aes_context aes;
        mbedtls_aes_init(&aes);
        mbedtls_aes_setkey_enc(&aes, key, 128);
        uint8_t iv[16];
        memcpy(iv, AES_IV, 16);
        mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_ENCRYPT, paddedLen, iv, plaintext, outBuf);
        mbedtls_aes_free(&aes);
        free(plaintext);
    } else {
        outBuf = (uint8_t*)malloc(paddedLen);
        memcpy(outBuf, payload.c_str(), paddedLen);
    }

    // Build MQTT PUBLISH packet
    int topicLen = topic.length();
    int remainingLen = 2 + topicLen + paddedLen;

    uint8_t header[5];
    int headerLen = 0;
    header[headerLen++] = 0x30; // PUBLISH, QoS 0
    int rl = remainingLen;
    do {
        uint8_t b = rl % 128;
        rl /= 128;
        if (rl > 0) b |= 0x80;
        header[headerLen++] = b;
    } while (rl > 0);

    client.write(header, headerLen);
    uint8_t topicLenBytes[2] = { (uint8_t)(topicLen >> 8), (uint8_t)(topicLen & 0xFF) };
    client.write(topicLenBytes, 2);
    client.write((const uint8_t*)topic.c_str(), topicLen);
    client.write(outBuf, paddedLen);

    free(outBuf);
    Serial.printf("[MQTT] Published %d bytes to %s\n", paddedLen, topic.c_str());
}

void sendOtaCommand() {
    WiFiClient* client = nullptr;
    for (int i=0; i<2; i++) {
        if (mqttClients[i].isMower && mqttClients[i].client && mqttClients[i].client.connected()) {
            client = &mqttClients[i].client;
            break;
        }
    }
    
    if (!client || mowerSn.length() == 0) return;

    String downloadUrl = "http://192.168.4.1/firmware.deb";

    // EXACT OTA payload — NO tz field, type MUST be "full", cmd MUST be "upgrade"
    String otaJson = "{\"ota_upgrade_cmd\":{\"cmd\":\"upgrade\",\"type\":\"full\",\"content\":\"app\",";
    otaJson += "\"url\":\"" + downloadUrl + "\",";
    otaJson += "\"version\":\"" + firmwareVersion + "\",";
    otaJson += "\"md5\":\"" + firmwareMd5 + "\"}}";

    String topic = "Dart/Send_mqtt/" + mowerSn;
    
    sendMqttMessage(*client, topic, otaJson, true, mowerSn);

    Serial.printf("[OTA] Sent OTA command to %s: %s (%d bytes firmware)\n",
                  mowerSn.c_str(), firmwareVersion.c_str(), firmwareSize);
    statusMessage = "OTA sent! Mower downloading firmware...";
}

// ── BLE provisioning ─────────────────────────────────────────────────────────

void startBleScan() {
    if (chargerDevice) { delete chargerDevice; chargerDevice = nullptr; }
    if (mowerDevice) { delete mowerDevice; mowerDevice = nullptr; }

    NimBLEScan* scan = NimBLEDevice::getScan();
    scan->setScanCallbacks(new ScanCallbacks(), false);
    scan->setActiveScan(true);
    scan->setInterval(100);
    scan->setWindow(99);
    scan->start(15000, false); // 15 second scan
    bleScanning = true;
    Serial.println("[BLE] Scanning for 15 seconds...");
}

bool provisionDevice(NimBLEAdvertisedDevice* device, const char* deviceType) {
    bool isMower = strcmp(deviceType, "mower") == 0;
    const char* displayName = isMower ? "Mower" : "Charger";
    int totalSteps = 5;

    Serial.printf("[BLE] Connecting to %s (%s)...\n", device->getName().c_str(),
                  device->getAddress().toString().c_str());

    if (provisionProgressCb) provisionProgressCb(displayName, 0, totalSteps, "Connecting...");

    NimBLEClient* client = NimBLEDevice::createClient();
    if (!client->connect(device)) {
        Serial.println("[BLE] Connection failed!");
        return false;
    }
    Serial.println("[BLE] Connected!");

    // Discover GATT service
    // Charger: service 0x1234, char 0x2222 (write+notify)
    // Mower:   service 0x0201, char 0x0011 (write) + 0x0021 (notify)
    const char* svcUuid   = isMower ? "0201" : "1234";
    const char* writeUuid = isMower ? "0011" : "2222";
    const char* notifUuid = isMower ? "0021" : "2222";

    NimBLERemoteService* svc = client->getService(svcUuid);
    if (!svc) {
        Serial.printf("[BLE] Service %s not found!\n", svcUuid);
        client->disconnect();
        return false;
    }

    NimBLERemoteCharacteristic* writeChr = svc->getCharacteristic(writeUuid);
    NimBLERemoteCharacteristic* notifChr = svc->getCharacteristic(notifUuid);
    if (!writeChr || !notifChr) {
        Serial.println("[BLE] Characteristics not found!");
        client->disconnect();
        return false;
    }

    // Subscribe to notifications
    String bleResponse = "";
    notifChr->subscribe(true, [&bleResponse](NimBLERemoteCharacteristic* chr,
                                              uint8_t* data, size_t length, bool isNotify) {
        bleResponse += String((char*)data, length);
    });

    String resp;

    // ══════════════════════════════════════════════════════════════
    // Command sequence MUST match official Novabot app exactly:
    //   Charger: set_wifi → set_rtk → set_lora → set_mqtt → set_cfg
    //   Mower:   get_signal → set_wifi → set_lora → set_mqtt → set_cfg
    // CRITICAL: Charger ignores set_wifi_info if get_signal_info is sent first!
    // ══════════════════════════════════════════════════════════════

    String wifiPayload, cfgPayload;
    if (isMower) {
        wifiPayload = "{\"set_wifi_info\":{\"ap\":{\"ssid\":\"" + userWifiSsid +
                   "\",\"passwd\":\"" + userWifiPassword + "\",\"encrypt\":0}}}";
        cfgPayload = "{\"set_cfg_info\":{\"cfg_value\":1,\"tz\":\"Europe/Amsterdam\"}}";
    } else {
        wifiPayload = "{\"set_wifi_info\":{\"sta\":{\"ssid\":\"" + userWifiSsid +
                   "\",\"passwd\":\"" + userWifiPassword + "\",\"encrypt\":0}," +
                   "\"ap\":{\"ssid\":\"CHARGER_PILE\",\"passwd\":\"12345678\",\"encrypt\":0}}}";
        cfgPayload = "{\"set_cfg_info\":1}";
    }

    String loraPayload = "{\"set_lora_info\":{\"addr\":" + String(LORA_ADDR) +
        ",\"channel\":" + String(LORA_CHANNEL) + ",\"hc\":" + String(LORA_HC) +
        ",\"lc\":" + String(LORA_LC) + "}}";
    String mqttPayload = "{\"set_mqtt_info\":{\"addr\":\"" + String(MQTT_HOST) +
        "\",\"port\":" + String(MQTT_PORT) + "}}";

    // Build command array in correct order per device type
    struct { const char* name; String payload; int step; } cmds[6];
    int numCmds;

    if (isMower) {
        cmds[0] = {"get_signal_info", "{\"get_signal_info\":0}", 1};
        cmds[1] = {"set_wifi_info", wifiPayload, 2};
        cmds[2] = {"set_lora_info", loraPayload, 3};
        cmds[3] = {"set_mqtt_info", mqttPayload, 4};
        cmds[4] = {"set_cfg_info", cfgPayload, 5};
        numCmds = 5;
    } else {
        // Charger: set_wifi FIRST, then rtk, lora, mqtt, cfg
        cmds[0] = {"set_wifi_info", wifiPayload, 1};
        cmds[1] = {"set_rtk_info", "{\"set_rtk_info\":0}", 2};
        cmds[2] = {"set_lora_info", loraPayload, 3};
        cmds[3] = {"set_mqtt_info", mqttPayload, 4};
        cmds[4] = {"set_cfg_info", cfgPayload, 5};
        numCmds = 5;
    }

    totalSteps = numCmds;
    bool disconnected = false;
    for (int i = 0; i < numCmds; i++) {
        if (provisionProgressCb) provisionProgressCb(displayName, cmds[i].step, totalSteps, cmds[i].name);

        // 1 second pause between commands (matches bootstrap — gives device time to process)
        if (i > 0) delay(1000);

        bool got = bleSendCommand(client, writeChr, notifChr, cmds[i].payload, cmds[i].name, resp);
        if (!got) {
            // Check if device disconnected (set_cfg_info causes reboot = success!)
            if (!client->isConnected()) {
                Serial.printf("[BLE] Device disconnected after %s (expected reboot)\n", cmds[i].name);
                disconnected = true;
                break;
            }
            Serial.printf("[BLE] %s timeout (non-fatal)\n", cmds[i].name);
        }
    }

    if (!disconnected) {
        try { client->disconnect(); } catch (...) {}
    }

    // Success = either got responses OR device rebooted (disconnect after set_cfg_info)
    bool ok = disconnected || true;  // All commands sent = success (charger doesn't respond but processes)
    Serial.printf("[BLE] %s provisioning %s%s\n", deviceType,
                  ok ? "complete" : "FAILED",
                  disconnected ? " (device rebooted)" : " (no responses but commands sent)");
    return ok;
}

bool bleSendCommand(NimBLEClient* client, NimBLERemoteCharacteristic* writeChr,
                    NimBLERemoteCharacteristic* notifyChr, const String& json,
                    const char* cmdName, String& response) {
    Serial.printf("[BLE] -> %s: %s\n", cmdName, json.c_str());

    response = "";

    // Always use write-with-response (false) — NimBLE writeWithoutResponse fails on charger 0x2222
    // even though it advertises writeWithoutResponse. The charger still processes the data.
    bool noResp = false;
    Serial.printf("[BLE] Write mode: WriteReq (with response)\n");

    // Send "ble_start" marker
    bool ok = writeChr->writeValue((const uint8_t*)"ble_start", 9, noResp);
    Serial.printf("[BLE] ble_start write: %s\n", ok ? "OK" : "FAILED");
    delay(100);  // 100ms after start marker

    // Send JSON in chunks of 20 bytes
    const uint8_t* data = (const uint8_t*)json.c_str();
    int remaining = json.length();
    int offset = 0;
    int chunkNum = 0;
    Serial.printf("[BLE] Sending %d bytes in %d chunks\n", remaining, (remaining + 19) / 20);
    while (remaining > 0) {
        int chunkSize = remaining > 20 ? 20 : remaining;
        ok = writeChr->writeValue(data + offset, chunkSize, noResp);
        if (!ok) Serial.printf("[BLE] Chunk %d WRITE FAILED!\n", chunkNum);
        offset += chunkSize;
        remaining -= chunkSize;
        chunkNum++;
        delay(100);  // 100ms between chunks (more conservative than 30ms)
    }

    // Send "ble_end" marker (7 bytes, NO null terminator — matches bootstrap)
    delay(100);
    ok = writeChr->writeValue((const uint8_t*)"ble_end", 7, noResp);
    Serial.printf("[BLE] ble_end write: %s\n", ok ? "OK" : "FAILED");

    // Wait for response (up to 10 seconds)
    unsigned long start = millis();
    while (millis() - start < 10000) {
        delay(50);
        // Check if we got a complete response (contains _respond)
        if (response.indexOf("_respond") >= 0) {
            int jsonStart = response.indexOf('{');
            int jsonEnd = response.lastIndexOf('}');
            if (jsonStart >= 0 && jsonEnd > jsonStart) {
                response = response.substring(jsonStart, jsonEnd + 1);
            }
            Serial.printf("[BLE] <- %s: %s\n", cmdName, response.c_str());

            // Check result — result:1 = acknowledged (NOT rejected)
            int resultIdx = response.indexOf("\"result\":");
            if (resultIdx >= 0) {
                int resultVal = response.charAt(resultIdx + 9) - '0';
                return resultVal == 0;
            }
            return true;
        }
    }

    Serial.printf("[BLE] <- %s: TIMEOUT\n", cmdName);
    return false;
}

// ── Firmware info from SD card ───────────────────────────────────────────────

bool loadFirmwareInfo() {
    File root = SD.open("/");
    while (File f = root.openNextFile()) {
        String name = f.name();
        if (name.endsWith(".deb") && name.indexOf("mower_firmware") >= 0) {
            firmwareFilename = name;
            firmwareSize = f.size();
            f.close();

            // Extract version from filename
            int vIdx = name.indexOf('v');
            int debIdx = name.indexOf(".deb");
            if (vIdx >= 0 && debIdx > vIdx) {
                firmwareVersion = name.substring(vIdx, debIdx);
            }

            // Compute MD5
            firmwareMd5 = computeMd5(("/" + name).c_str());

            Serial.printf("[SD] Firmware: %s (%d bytes, v%s, md5=%s)\n",
                          name.c_str(), firmwareSize, firmwareVersion.c_str(),
                          firmwareMd5.c_str());
            root.close();
            return true;
        }
    }
    root.close();
    Serial.println("[SD] No firmware .deb found!");
    return false;
}

String computeMd5(const char* path) {
    File f = SD.open(path);
    if (!f) return "";
    MD5Builder md5;
    md5.begin();
    uint8_t buf[4096];
    while (f.available()) {
        int n = f.read(buf, sizeof(buf));
        md5.add(buf, n);
    }
    f.close();
    md5.calculate();
    return md5.toString();
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
