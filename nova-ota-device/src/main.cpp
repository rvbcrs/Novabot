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
// Custom DNS instead of Arduino DNSServer (which doesn't work reliably on ESP32-S3)
#include <WiFiUdp.h>
#include <WebServer.h>
#include <SD.h>
#include <SPI.h>
#include <NimBLEDevice.h>
#include <MD5Builder.h>
#include "mbedtls/aes.h"
#include <esp_wifi.h>
#include <sMQTTBroker.h>
#include "display.h"
#include "touch.h"

// ── Configuration ────────────────────────────────────────────────────────────

// WiFi AP settings — mower will connect to this
static const char* AP_SSID     = "OpenNova-Setup";
static const char* AP_PASSWORD = "12345678";    // WPA2, 8 chars minimum

// The mower ONLY accepts this hostname for MQTT
static const char* MQTT_HOST   = "mqtt.lfibot.com";  // DNS resolves to 192.168.4.1 via our custom DNS
static const int   MQTT_PORT   = 1883;  // sMQTTBroker listens on 1883

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

// ── Web console log ring buffer (implementation after Arduino.h) ────────────
#define WEB_LOG_SIZE 50
#define WEB_LOG_LINE 120
static char webLog[WEB_LOG_SIZE][WEB_LOG_LINE];
static int webLogHead = 0;
static int webLogCount = 0;

// Forward declaration — can't use millis()/Serial before Arduino.h is included (it is at line 23)
void webLogAdd(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
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
static unsigned long stateEnteredAt = 0;

// ── Globals ──────────────────────────────────────────────────────────────────

WiFiUDP dnsUdp;
WebServer httpServer(80);

// MQTT broker state — sMQTTBroker on port 1883
static bool mowerConnected = false;
static bool chargerMqttConnected = false;
static String mowerSn = "";
static String chargerTopic = "";
static unsigned long mowerConnectTime = 0;

// ── sMQTTBroker subclass ─────────────────────────────────────────────────────

class NovaMQTTBroker : public sMQTTBroker {
public:
    bool onEvent(sMQTTEvent *event) override {
        switch (event->Type()) {
            case NewClient_sMQTTEventType: {
                sMQTTNewClientEvent *e = (sMQTTNewClientEvent *)event;
                std::string cid = e->Client()->getClientId();
                Serial.printf("[MQTT] CONNECT clientId=%s\r\n", cid.c_str());

                if (cid.rfind("ESP32_", 0) == 0 || cid.rfind("SNC", 0) == 0) {
                    chargerMqttConnected = true;
                    Serial.printf("[MQTT] Charger connected: %s\r\n", cid.c_str());
                    webLogAdd("MQTT: Charger %s connected!", cid.c_str());
                }
                if (cid.rfind("LFI", 0) == 0) {
                    String clientIdStr = cid.c_str();
                    int underscore = clientIdStr.indexOf('_');
                    mowerSn = underscore > 0 ? clientIdStr.substring(0, underscore) : clientIdStr;
                    mowerConnected = true;
                    mowerConnectTime = millis();
                    Serial.printf("[MQTT] Mower connected: %s\r\n", mowerSn.c_str());
                    webLogAdd("MQTT: Mower %s connected!", mowerSn.c_str());
                }
                return true;
            }
            case RemoveClient_sMQTTEventType: {
                sMQTTRemoveClientEvent *e = (sMQTTRemoveClientEvent *)event;
                std::string cid = e->Client()->getClientId();
                Serial.printf("[MQTT] Client disconnected: %s\r\n", cid.c_str());

                if (cid.rfind("ESP32_", 0) == 0 || cid.rfind("SNC", 0) == 0) {
                    chargerMqttConnected = false;
                    Serial.println("[MQTT] Charger disconnected");
                    webLogAdd("MQTT: Charger disconnected");
                }
                if (cid.rfind("LFI", 0) == 0) {
                    mowerConnected = false;
                    Serial.printf("[MQTT] Mower %s disconnected\r\n", mowerSn.c_str());
                    webLogAdd("MQTT: Mower %s disconnected", mowerSn.c_str());
                }
                return true;
            }
            case Subscribe_sMQTTEventType: {
                sMQTTSubUnSubClientEvent *e = (sMQTTSubUnSubClientEvent *)event;
                std::string cid = e->Client()->getClientId();
                std::string topic = e->Topic();
                Serial.printf("[MQTT] SUBSCRIBE clientId=%s topic=%s\r\n", cid.c_str(), topic.c_str());

                // Capture charger's listening topic
                if ((cid.rfind("ESP32_", 0) == 0 || cid.rfind("SNC", 0) == 0) &&
                    topic.rfind("Dart/Send_mqtt/", 0) == 0) {
                    chargerTopic = topic.c_str();
                    Serial.printf("[MQTT] Saved Charger Topic: %s\r\n", chargerTopic.c_str());
                    webLogAdd("MQTT: Charger subscribed: %s", chargerTopic.c_str());
                }
                return true;
            }
            case Public_sMQTTEventType: {
                // Just let sMQTTBroker handle routing
                return true;
            }
            default:
                return true;
        }
    }
};

static NovaMQTTBroker mqttBroker;

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
void processDNS();
void setupHTTP();
void setupMQTT();
void sendMqttMessage(String topic, String payload, bool useAes, String sn = "");
void startBleScan();
bool provisionDevice(NimBLEAdvertisedDevice* device, const char* deviceType);
bool bleSendCommand(NimBLEClient* client, NimBLERemoteCharacteristic* writeChr,
                    NimBLERemoteCharacteristic* notifyChr, const String& json,
                    const char* cmdName, String& response);
void sendOtaCommand();
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
        // Normalize MAC: uppercase with colons (e.g. "48:27:E2:2E:EF:D6")
        String rawMac = advertisedDevice->getAddress().toString().c_str();
        rawMac.toUpperCase();
        String mac = rawMac;
        if (rawMac.length() == 12 && rawMac.indexOf(':') == -1) {
            mac = rawMac.substring(0,2) + ":" + rawMac.substring(2,4) + ":" +
                  rawMac.substring(4,6) + ":" + rawMac.substring(6,8) + ":" +
                  rawMac.substring(8,10) + ":" + rawMac.substring(10,12);
        }
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

            Serial.printf("[BLE] Found: %s (%s) RSSI=%d%s%s\r\n",
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
        Serial.printf("[BLE] Scan complete, found %d device(s)\r\n", scanResultCount);
        webLogAdd("BLE: Scan done, %d device(s)", scanResultCount);
    }
};

// ── State helper ─────────────────────────────────────────────────────────────

void setState(State newState) {
    currentState = newState;
    stateJustEntered = true;
    stateEnteredAt = millis();
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
        Serial.printf("[SD] Card mounted, size: %lluMB\r\n", SD.cardSize() / (1024 * 1024));
    }

    // Find firmware file on SD (optional — OTA skipped if not found)
    if (!loadFirmwareInfo()) {
        Serial.println("[SD] No firmware .deb — OTA will be skipped");
    }

    // In LCD mode, always use AP-only (no serial config needed)
    userWifiSsid = AP_SSID;
    userWifiPassword = AP_PASSWORD;

    // Start WiFi AP for initial device check
    setupWifiAP();
    Serial.println("[SETUP] Waiting for AP to be ready...");
    while (WiFi.softAPIP() == IPAddress(0, 0, 0, 0)) { delay(100); }
    Serial.printf("[SETUP] AP ready at %s\r\n", WiFi.softAPIP().toString().c_str());
    webLogAdd("AP '%s' ready at %s", AP_SSID, WiFi.softAPIP().toString().c_str());

    // Start network services
    setupDNS();
    setupHTTP();
    setupMQTT();
    servicesStarted = true;

    // Initialize BLE
    NimBLEDevice::init("Nova-OTA");
    NimBLEDevice::setMTU(185);

    // Wait for already-provisioned devices to connect via MQTT
    Serial.println("[SETUP] AP active — waiting up to 45s for MQTT devices...");
#ifdef WAVESHARE_LCD
    display_confirm("Starting...", "Checking for connected", "devices...", "Skip");
#endif
    for (int i = 0; i < 450; i++) {
        delay(100);
        processDNS();
        httpServer.handleClient();
        mqttBroker.update();
        // Log periodically
        if (i % 50 == 0) {
            int clients = WiFi.softAPgetStationNum();
            Serial.printf("[SETUP] %ds — %d WiFi client(s), mower=%s charger=%s\r\n",
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
            Serial.printf("[SETUP] One device connected, waiting 10s for the other...\r\n");
            for (int j = 0; j < 100 && !(mowerConnected && chargerMqttConnected); j++) {
                delay(100);
                processDNS();
                httpServer.handleClient();
                mqttBroker.update();
            }
            break;
        }
        // WiFi clients present but no MQTT yet — wait a bit longer
        if (WiFi.softAPgetStationNum() > 0 && i > 150 && !mowerConnected && !chargerMqttConnected) {
            Serial.printf("[SETUP] %d WiFi client(s) — waiting 10s for MQTT...\r\n", WiFi.softAPgetStationNum());
            for (int j = 0; j < 100 && !mowerConnected && !chargerMqttConnected; j++) {
                delay(100);
                processDNS();
                httpServer.handleClient();
                mqttBroker.update();
            }
            break;
        }
#ifdef WAVESHARE_LCD
        if (ui_btnPressed) {
            ui_btnPressed = false;
            Serial.println("[SETUP] Skip pressed — going to BLE scan");
            setState(STATE_BLE_SCAN);
            goto setup_done;
        }
#endif
    }

    if (mowerConnected || chargerMqttConnected) {
        // At least one device connected via MQTT — skip BLE!
        Serial.printf("[SETUP] Devices connected (mower=%s charger=%s) — skipping BLE.\r\n",
                      mowerConnected ? "YES" : "no", chargerMqttConnected ? "YES" : "no");
        setState(STATE_CONFIRM_MQTT);
    } else {
        // No MQTT devices — start BLE scan (ignore WiFi-only clients like phones)
        Serial.println("[SETUP] No MQTT devices — starting BLE scan");
        setState(STATE_BLE_SCAN);
    }
    setup_done:;
}

// ── Main loop ────────────────────────────────────────────────────────────────

void loop() {
    // Only process network services after provisioning
    if (servicesStarted) {
        processDNS();
        httpServer.handleClient();
        mqttBroker.update();
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
                Serial.printf("[CONFIG] WiFi: %s / %s\r\n", userWifiSsid.c_str(), "***");
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
                Serial.printf("[STATE] Scan done, %d devices found\r\n", scanResultCount);
                setState(STATE_SELECT_DEVICES);
            }
            break;

        case STATE_SELECT_DEVICES:
            if (stateJustEntered) {
                stateJustEntered = false;
                // Auto-select first charger and first mower found
                for (int i = 0; i < scanResultCount; i++) {
                    if (scanResults[i].isCharger && selectedChargerIdx < 0) {
                        selectedChargerIdx = i;
                        ui_selectedChargerIdx = i;
                    }
                    if (scanResults[i].isMower && selectedMowerIdx < 0) {
                        selectedMowerIdx = i;
                        ui_selectedMowerIdx = i;
                    }
                }
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
                // WiFi stays ON during BLE — disabling breaks NimBLE responses
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
                // Stop WiFi during BLE to avoid interference
                if (servicesStarted) {
                    Serial.println("[NET] Stopping WiFi for BLE provisioning...");
                    WiFi.enableAP(false);  // Stop AP radio but keep objects intact
                }

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
            if (stateJustEntered) {
                stateJustEntered = false;
                // Restart WiFi AP after BLE provisioning (was stopped to avoid interference)
                Serial.printf("[NET] (Re)starting WiFi AP...\r\n");
                webLogAdd("Restarting WiFi AP...");
                setupWifiAP();
                while (WiFi.softAPIP() == IPAddress(0, 0, 0, 0)) { delay(100); }
                Serial.printf("[SETUP] AP ready at %s\r\n", WiFi.softAPIP().toString().c_str());
                webLogAdd("AP '%s' ready at %s", AP_SSID, WiFi.softAPIP().toString().c_str());
                if (!servicesStarted) {
                    setupDNS();
                    setupHTTP();
                    setupMQTT();
                    servicesStarted = true;
                }
                // Self-test: log current state on entry
                Serial.printf("[STATE] WAIT_MQTT entered — clients=%d mower=%s charger=%s\r\n",
                              WiFi.softAPgetStationNum(),
                              mowerConnected ? "YES" : "no",
                              chargerMqttConnected ? "YES" : "no");
                webLogAdd("Waiting for MQTT connections...");
            }
#ifdef WAVESHARE_LCD
            display_mqttWait(chargerMqttConnected, mowerConnected);
            if (ui_btnPressed) {
                ui_btnPressed = false;
                Serial.printf("[STATE] Next/Skip pressed in WAIT_MQTT\r\n");
                webLogAdd("Next pressed — proceeding");
                setState(STATE_CONFIRM_MQTT);
                break;
            }
#else
            setLed((millis() / 500) % 2);
#endif
            // Proceed when EITHER mower OR charger connects via MQTT
            if (mowerConnected || chargerMqttConnected) {
                // Give the other device a few seconds to also connect
                if (mowerConnected && chargerMqttConnected) {
                    setState(STATE_CONFIRM_MQTT);
                } else if (millis() - stateEnteredAt > 15000) {
                    // One connected, waited 15s for the other — proceed
                    Serial.printf("[STATE] Proceeding with mower=%s charger=%s\r\n",
                                  mowerConnected ? "YES" : "no",
                                  chargerMqttConnected ? "YES" : "no");
                    setState(STATE_CONFIRM_MQTT);
                }
            }

            // 60s total timeout
            if (millis() - stateEnteredAt > 120000 && !mowerConnected && !chargerMqttConnected) {
                Serial.printf("[STATE] WAIT_MQTT timeout (60s) — no MQTT connections\r\n");
                webLogAdd("MQTT wait timeout — no devices connected");
                setState(STATE_ERROR);
            }

#ifdef WAVESHARE_LCD
            // Skip button
            if (ui_btnPressed) {
                ui_btnPressed = false;
                Serial.printf("[TOUCH] Skip MQTT wait\r\n");
                setState(STATE_CONFIRM_MQTT);
            }
#endif
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
                Serial.printf("[STATE] MQTT confirmed — %s\r\n", hasOta ? "ready for OTA" : "skipping to WiFi");
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

                Serial.printf("[WiFi] Found %d networks\r\n", wifiNetworkCount);
#ifdef WAVESHARE_LCD
                display_wifiList(wifiNetworks, wifiNetworkCount, -1);
#endif
            }

            // User tapped a network → go to password entry
            if (ui_selectedWifiIdx >= 0 && ui_selectedWifiIdx < wifiNetworkCount) {
                int idx = ui_selectedWifiIdx;
                strncpy(ui_wifiSsid, wifiNetworks[idx].ssid.c_str(), sizeof(ui_wifiSsid) - 1);
                ui_wifiSsid[sizeof(ui_wifiSsid) - 1] = '\0';
                Serial.printf("[WiFi] Selected: %s\r\n", ui_wifiSsid);

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
                Serial.printf("[STATE] Waiting for password for '%s'\r\n", ui_wifiSsid);
#ifdef WAVESHARE_LCD
                display_wifiPassword(ui_wifiSsid);
#endif
            }

            if (ui_wifiPasswordReady) {
                ui_wifiPasswordReady = false;
                userWifiSsid = String(ui_wifiSsid);
                userWifiPassword = String(ui_wifiPassword);
                Serial.printf("[WiFi] Credentials set: SSID=%s\r\n", userWifiSsid.c_str());
                setState(STATE_REPROVISION);
            }
            break;

        case STATE_REPROVISION:
            if (stateJustEntered) {
                stateJustEntered = false;
                Serial.printf("[STATE] Re-provisioning with home WiFi: %s\r\n", userWifiSsid.c_str());

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
                            processDNS();
                            httpServer.handleClient();
                            mqttBroker.update();
                        }
                        if (!bleScanning) break;  // Scan finished
                    }
                }
                
                bool chargerOk = false;
                bool mowerOk = false;
                int step = 1;

                // Provision Charger
                if (chargerMqttConnected && chargerTopic.length() > 0) {
                    Serial.println("[REPROVISION] Sending WiFi credentials to Charger via MQTT (FAST PATH)!");
                    String cPayload = "{\"set_wifi_info\":{\"sta\":{\"ssid\":\"" + userWifiSsid + "\",\"passwd\":\"" + userWifiPassword + "\",\"encrypt\":0},\"ap\":{\"ssid\":\"CHARGER_PILE\",\"passwd\":\"12345678\",\"encrypt\":0}}}";
                    sendMqttMessage(chargerTopic, cPayload, false, "");
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
                if (mowerConnected && mowerSn.length() > 0) {
                    Serial.println("[REPROVISION] Sending WiFi credentials to Mower via MQTT (FAST PATH)!");
                    String mPayload = "{\"set_wifi_info\":{\"ap\":{\"ssid\":\"" + userWifiSsid + "\",\"passwd\":\"" + userWifiPassword + "\",\"encrypt\":0}}}";
                    sendMqttMessage("Dart/Send_mqtt/" + mowerSn, mPayload, true, mowerSn);
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
                    if (!chargerOk) msg += "Charger: FAILED\r\n";
                    if (!mowerOk) msg += "Mower: FAILED\r\n";
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
            {
                char staMac[18];
                snprintf(staMac, sizeof(staMac), "%02X:%02X:%02X:%02X:%02X:%02X",
                    info.wifi_ap_staconnected.mac[0], info.wifi_ap_staconnected.mac[1],
                    info.wifi_ap_staconnected.mac[2], info.wifi_ap_staconnected.mac[3],
                    info.wifi_ap_staconnected.mac[4], info.wifi_ap_staconnected.mac[5]);
                const char* who = "unknown";
                for (int si = 0; si < scanResultCount; si++) {
                    if (scanResults[si].isCharger || scanResults[si].isMower) {
                        String bleMac = scanResults[si].mac;
                        bleMac.toUpperCase();
                        // Mower: WiFi MAC = BLE MAC
                        if (String(staMac).equalsIgnoreCase(bleMac)) {
                            who = scanResults[si].isMower ? "MOWER" : "CHARGER";
                        }
                        // Charger: WiFi STA MAC = BLE MAC - 2
                        if (scanResults[si].isCharger && bleMac.length() >= 17) {
                            int lastByte = strtol(bleMac.substring(15).c_str(), NULL, 16) - 2;
                            char expected[18];
                            snprintf(expected, sizeof(expected), "%s%02X",
                                bleMac.substring(0, 15).c_str(), lastByte & 0xFF);
                            if (String(staMac).equalsIgnoreCase(String(expected))) {
                                who = "CHARGER";
                            }
                        }
                    }
                }
                Serial.printf("[WiFi] Station connected: %s (%s)\r\n", staMac, who);
                webLogAdd("WiFi: %s connected (%s)", who, staMac);
                // Check DHCP IP after a short delay (log in next loop iteration)
                // For immediate check: query the sta list
                wifi_sta_list_t sl;
                esp_wifi_ap_get_sta_list(&sl);
                esp_netif_t* apN = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
                if (apN) {
                    esp_netif_sta_list_t ipl;
                    if (esp_netif_get_sta_list(&sl, &ipl) == ESP_OK) {
                        for (int s = 0; s < ipl.num; s++) {
                            Serial.printf("[WiFi]   STA %02X:%02X:%02X:%02X:%02X:%02X → " IPSTR "\r\n",
                                ipl.sta[s].mac[0], ipl.sta[s].mac[1], ipl.sta[s].mac[2],
                                ipl.sta[s].mac[3], ipl.sta[s].mac[4], ipl.sta[s].mac[5],
                                IP2STR(&ipl.sta[s].ip));
                        }
                    }
                }
            }
            break;
        case ARDUINO_EVENT_WIFI_AP_STADISCONNECTED:
            Serial.printf("[WiFi] Station disconnected: %02x:%02x:%02x:%02x:%02x:%02x\r\n",
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
    // Configure DHCP BEFORE starting AP — charger connects instantly and needs DHCP ready
    esp_netif_t* apNetif = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    if (apNetif) {
        // DHCP server is auto-started by softAP, stop it first to configure
        esp_netif_dhcps_stop(apNetif);
        // Enable DNS offer so ESP32 clients get our IP as DNS server
        dhcps_offer_t offer = OFFER_DNS;
        esp_netif_dhcps_option(apNetif, ESP_NETIF_OP_SET, ESP_NETIF_DOMAIN_NAME_SERVER, &offer, sizeof(offer));
        Serial.printf("[WiFi] DHCP pre-configured with DNS offer\r\n");
        // DON'T restart DHCP yet — softAP() will start it
    }

    // Use 10.0.0.x subnet — NOT 192.168.4.x which conflicts with charger's own AP!
    // The charger runs AP+STA mode with its AP on 192.168.4.1 → subnet clash breaks DHCP.
    WiFi.softAPConfig(IPAddress(10,0,0,1), IPAddress(10,0,0,1), IPAddress(255,255,255,0));
    WiFi.softAP(AP_SSID, AP_PASSWORD, 1, 0, 4);  // channel 1, not hidden, max 4 clients

    // Set WPA/WPA2 mixed auth mode for ESP32 charger compatibility
    wifi_config_t conf;
    esp_wifi_get_config(WIFI_IF_AP, &conf);
    conf.ap.authmode = WIFI_AUTH_WPA_WPA2_PSK;
    esp_wifi_set_config(WIFI_IF_AP, &conf);

    // Now start DHCP server (after AP is active)
    if (apNetif) {
        esp_err_t err = esp_netif_dhcps_start(apNetif);
        Serial.printf("[WiFi] DHCP server started (err=%d)\r\n", err);
    }

    delay(500);
    Serial.printf("[WiFi] AP started: %s (IP: %s, ch=%d)\r\n", AP_SSID,
                  WiFi.softAPIP().toString().c_str(), WiFi.channel());
}

// ── DNS — resolve mqtt.lfibot.com → our AP IP ───────────────────────────────

// ── Custom DNS server — responds to ALL queries with our AP IP ───────────────
// Replaces Arduino DNSServer which doesn't work reliably on ESP32-S3

static IPAddress dnsResponseIP;

void setupDNS() {
    dnsResponseIP = WiFi.softAPIP();
    dnsUdp.begin(53);
    Serial.printf("[DNS] Custom DNS started on port 53 — all queries → %s\r\n", dnsResponseIP.toString().c_str());
    webLogAdd("DNS: all queries → %s", dnsResponseIP.toString().c_str());
}

void processDNS() {
    int packetSize = dnsUdp.parsePacket();
    if (packetSize < 12) return;  // Too small for DNS header

    uint8_t buf[512];
    int len = dnsUdp.read(buf, sizeof(buf));
    if (len < 12) return;

    // Extract query name for logging
    char queryName[128] = {0};
    int qpos = 12;  // DNS header is 12 bytes
    int npos = 0;
    while (qpos < len && buf[qpos] != 0 && npos < 126) {
        int labelLen = buf[qpos++];
        if (npos > 0) queryName[npos++] = '.';
        for (int j = 0; j < labelLen && qpos < len && npos < 126; j++) {
            queryName[npos++] = buf[qpos++];
        }
    }
    queryName[npos] = 0;
    qpos++;  // skip null terminator
    qpos += 4;  // skip QTYPE (2) + QCLASS (2)

    Serial.printf("[DNS] Query: %s from %s\r\n", queryName, dnsUdp.remoteIP().toString().c_str());

    // Build response: copy header, set response flags, append answer
    uint8_t resp[512];
    memcpy(resp, buf, len);  // Copy entire query

    // Set response flags: QR=1, AA=1, RD=1, RA=1
    resp[2] = 0x85;  // QR=1, Opcode=0, AA=1, TC=0, RD=1
    resp[3] = 0x80;  // RA=1, Z=0, RCODE=0 (no error)

    // Set answer count = 1
    resp[6] = 0x00;
    resp[7] = 0x01;

    // Append answer: name pointer + type A + class IN + TTL + data length + IP
    int rpos = len;  // Start after the query
    // Name pointer to offset 12 (the query name)
    resp[rpos++] = 0xC0;
    resp[rpos++] = 0x0C;
    // Type A (1)
    resp[rpos++] = 0x00;
    resp[rpos++] = 0x01;
    // Class IN (1)
    resp[rpos++] = 0x00;
    resp[rpos++] = 0x01;
    // TTL (60 seconds)
    resp[rpos++] = 0x00;
    resp[rpos++] = 0x00;
    resp[rpos++] = 0x00;
    resp[rpos++] = 0x3C;
    // Data length (4 bytes for IPv4)
    resp[rpos++] = 0x00;
    resp[rpos++] = 0x04;
    // IP address
    resp[rpos++] = dnsResponseIP[0];
    resp[rpos++] = dnsResponseIP[1];
    resp[rpos++] = dnsResponseIP[2];
    resp[rpos++] = dnsResponseIP[3];

    dnsUdp.beginPacket(dnsUdp.remoteIP(), dnsUdp.remotePort());
    dnsUdp.write(resp, rpos);
    dnsUdp.endPacket();
}

// ── HTTP server — serves firmware + status ───────────────────────────────────

void setupHTTP() {
    // ── Main status/config page ──────────────────────────────────────────────
    httpServer.on("/", []() {
        String html = R"rawhtml(<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nova-OTA</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#1a1a2e;color:#e0e0e0;padding:16px;min-height:100vh}
  .container{max-width:480px;margin:0 auto}
  h1{color:#00d4aa;font-size:24px;margin-bottom:4px}
  .version{color:#666;font-size:12px;margin-bottom:20px}
  .card{background:#16213e;border-radius:12px;padding:16px;margin-bottom:16px;border:1px solid #0f3460}
  .card h2{font-size:16px;color:#7c3aed;margin-bottom:12px;text-transform:uppercase;letter-spacing:1px}
  .row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06)}
  .row:last-child{border-bottom:none}
  .label{color:#888;font-size:14px}
  .value{font-size:14px;font-weight:600}
  .on{color:#00d4aa}
  .off{color:#ef4444}
  .sn{color:#a78bfa;font-family:monospace;font-size:13px}
  label{display:block;color:#888;font-size:13px;margin-bottom:4px;margin-top:12px}
  label:first-child{margin-top:0}
  input[type=text],input[type=password]{width:100%;padding:10px 12px;background:#0d0d20;border:2px solid #333;border-radius:8px;color:#fff;font-size:15px}
  input:focus{border-color:#7c3aed;outline:none}
  .btn{display:block;width:100%;padding:12px;margin-top:16px;background:#7c3aed;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;text-align:center}
  .btn:active{background:#6d28d9}
  .btn:disabled{background:#444;cursor:not-allowed}
  .msg{text-align:center;padding:8px;border-radius:8px;margin-top:12px;font-size:14px;display:none}
  .msg.ok{display:block;background:rgba(0,212,170,.15);color:#00d4aa}
  .msg.err{display:block;background:rgba(239,68,68,.15);color:#ef4444}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
  .dot.on{background:#00d4aa}
  .dot.off{background:#ef4444}
  .toggle{display:flex;align-items:center;gap:6px;font-size:12px;color:#666;margin-top:6px;cursor:pointer}
  .toggle input{width:auto;margin:0}
</style>
</head><body>
<div class="container">
  <h1>Nova-OTA Device</h1>
  <div class="version">)rawhtml" + String(VERSION) + R"rawhtml(</div>

  <!-- Status section (auto-refreshed) -->
  <div class="card">
    <h2>Status</h2>
    <div class="row"><span class="label">WiFi AP</span><span class="value" id="ap">--</span></div>
    <div class="row"><span class="label">Connected clients</span><span class="value" id="clients">--</span></div>
    <div id="clientList" style="margin:4px 0 8px 0;font-size:12px;color:#aaa"></div>
    <div class="row"><span class="label">State</span><span class="value" id="state">--</span></div>
    <div class="row"><span class="label">Status</span><span class="value" id="msg">--</span></div>
  </div>

  <!-- Console log -->
  <div class="card">
    <h2>Console</h2>
    <div id="console" style="background:#0a0a1a;border-radius:6px;padding:8px;font-family:monospace;font-size:11px;color:#aaa;max-height:200px;overflow-y:auto;white-space:pre-wrap"></div>
  </div>

  <div class="card">
    <h2>Charger</h2>
    <div class="row"><span class="label">WiFi</span><span class="value" id="chWifi">--</span></div>
    <div class="row"><span class="label">MQTT</span><span class="value" id="chMqtt">--</span></div>
    <div class="row"><span class="label">Serial</span><span class="value sn" id="chSn">--</span></div>
  </div>

  <div class="card">
    <h2>Mower</h2>
    <div class="row"><span class="label">WiFi</span><span class="value" id="mwWifi">--</span></div>
    <div class="row"><span class="label">MQTT</span><span class="value" id="mwMqtt">--</span></div>
    <div class="row"><span class="label">Serial</span><span class="value sn" id="mwSn">--</span></div>
  </div>

  <div class="card">
    <h2>Firmware</h2>
    <div class="row"><span class="label">File</span><span class="value" id="fwFile">--</span></div>
    <div class="row"><span class="label">Version</span><span class="value" id="fwVer">--</span></div>
    <div class="row"><span class="label">BLE devices found</span><span class="value" id="bleCnt">--</span></div>
  </div>

  <!-- WiFi config section -->
  <div class="card">
    <h2>Home WiFi Config</h2>
    <form id="wifiForm" onsubmit="return saveWifi(event)">
      <label for="ssid">SSID</label>
      <input type="text" id="ssid" name="ssid" placeholder="Home network name" autocomplete="off">
      <label for="pass">Password</label>
      <input type="password" id="pass" name="password" placeholder="WiFi password">
      <label class="toggle"><input type="checkbox" onclick="document.getElementById('pass').type=this.checked?'text':'password'"> Show password</label>
      <button class="btn" type="submit">Save &amp; Re-provision</button>
    </form>
    <div class="msg" id="wifiMsg"></div>
  </div>
</div>

<script>
function dot(on){return '<span class="dot '+(on?'on':'off')+'"></span>'+(on?'Yes':'No')}
function upd(){
  fetch('/api/status').then(r=>r.json()).then(d=>{
    document.getElementById('ap').textContent=d.apSsid;
    document.getElementById('clients').textContent=d.apClients;
    var cl=document.getElementById('clientList');
    if(d.clients&&d.clients.length){cl.innerHTML=d.clients.map(c=>'<div>'+c.name+' <span style="color:#666">'+c.mac+'</span></div>').join('')}else{cl.innerHTML=''}
    document.getElementById('state').textContent=d.stateName;
    document.getElementById('msg').textContent=d.message;
    var con=document.getElementById('console');
    if(d.log&&d.log.length){con.textContent=d.log.join('\n');con.scrollTop=con.scrollHeight}
    document.getElementById('chWifi').innerHTML=dot(d.chargerWifi);
    document.getElementById('chMqtt').innerHTML=dot(d.chargerMqtt);
    document.getElementById('chSn').textContent=d.chargerSn||'--';
    document.getElementById('mwWifi').innerHTML=dot(d.mowerWifi);
    document.getElementById('mwMqtt').innerHTML=dot(d.mowerMqtt);
    document.getElementById('mwSn').textContent=d.mowerSn||'--';
    document.getElementById('fwFile').textContent=d.firmwareFile||'none';
    document.getElementById('fwVer').textContent=d.firmwareVersion||'--';
    document.getElementById('bleCnt').textContent=d.bleDevices;
    if(d.userSsid){document.getElementById('ssid').placeholder=d.userSsid+' (current)'}
  }).catch(()=>{})
}
upd();setInterval(upd,3000);

function saveWifi(e){
  e.preventDefault();
  var s=document.getElementById('ssid').value;
  var p=document.getElementById('pass').value;
  var m=document.getElementById('wifiMsg');
  if(!s){m.className='msg err';m.textContent='SSID is required';return false}
  fetch('/api/wifi-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ssid:s,password:p})})
  .then(r=>r.json()).then(d=>{
    if(d.success){m.className='msg ok';m.textContent='Saved! Devices will be re-provisioned.'}
    else{m.className='msg err';m.textContent=d.error||'Failed'}
  }).catch(()=>{m.className='msg err';m.textContent='Connection error'});
  return false;
}
</script>
</body></html>)rawhtml";
        httpServer.send(200, "text/html", html);
    });

    // ── JSON status API ──────────────────────────────────────────────────────
    httpServer.on("/api/status", HTTP_GET, []() {
        // Determine charger SN from topic
        String chargerSnStr = "";
        if (chargerTopic.startsWith("Dart/Send_mqtt/")) {
            chargerSnStr = chargerTopic.substring(15);
        }

        // Charger WiFi: we know it's connected if we got an MQTT connection from it
        bool chargerWifi = chargerMqttConnected;
        // Mower WiFi: at least one STA connected and mower MQTT is up
        bool mowerWifi = mowerConnected;

        // State name for display
        const char* stateNames[] = {
            "Init", "BLE Scan", "Select Devices", "Provision Charger",
            "Provision Mower", "Confirm BLE", "Wait MQTT", "Confirm MQTT",
            "OTA Sent", "WiFi Scan", "WiFi Password", "Re-provision",
            "Done", "Error"
        };
        const char* stateName = (currentState >= 0 && currentState <= STATE_ERROR)
            ? stateNames[currentState] : "Unknown";

        // WiFi client list with MAC + IP
        wifi_sta_list_t staList;
        esp_wifi_ap_get_sta_list(&staList);
        String clientsJson = "[";
        for (int i = 0; i < staList.num; i++) {
            if (i > 0) clientsJson += ",";
            char mac[18];
            snprintf(mac, sizeof(mac), "%02X:%02X:%02X:%02X:%02X:%02X",
                staList.sta[i].mac[0], staList.sta[i].mac[1], staList.sta[i].mac[2],
                staList.sta[i].mac[3], staList.sta[i].mac[4], staList.sta[i].mac[5]);
            // Identify device by MAC
            const char* who = "unknown";
            String macStr = String(mac);

            // 1. Check against BLE scan results (if available)
            for (int s = 0; s < scanResultCount; s++) {
                if (scanResults[s].isCharger) {
                    String bleMac = scanResults[s].mac;
                    bleMac.toUpperCase();
                    if (bleMac.length() >= 17) {
                        int lastByte = strtol(bleMac.substring(15).c_str(), NULL, 16) - 2;
                        char expected[18];
                        snprintf(expected, sizeof(expected), "%s%02X",
                            bleMac.substring(0, 15).c_str(), lastByte & 0xFF);
                        if (macStr.equalsIgnoreCase(String(expected))) who = "Charger";
                    }
                }
                if (scanResults[s].isMower && macStr.equalsIgnoreCase(scanResults[s].mac)) {
                    who = "Mower";
                }
            }

            // 2. Heuristic: Espressif OUI (48:27:E2, 30:C6:F7, etc.) = likely charger
            if (strcmp(who, "unknown") == 0) {
                if (macStr.startsWith("48:27:E2") || macStr.startsWith("30:C6:F7") ||
                    macStr.startsWith("EC:DA:3B") || macStr.startsWith("24:0A:C4")) {
                    who = "Charger (likely)";
                }
                // Mower: Horizon Robotics OUI 70:4A:0E
                else if (macStr.startsWith("70:4A:0E")) {
                    who = "Mower (likely)";
                }
            }

            clientsJson += "{\"mac\":\"" + macStr + "\",\"name\":\"" + String(who) + "\"}";
        }
        clientsJson += "]";

        // Log ring buffer
        String logJson = "[";
        for (int i = 0; i < webLogCount; i++) {
            int idx = (webLogHead - webLogCount + i + WEB_LOG_SIZE) % WEB_LOG_SIZE;
            if (i > 0) logJson += ",";
            // Escape quotes in log lines
            String line = webLog[idx];
            line.replace("\"", "'");
            logJson += "\"" + line + "\"";
        }
        logJson += "]";

        String json = "{";
        json += "\"apSsid\":\"" + String(AP_SSID) + "\",";
        json += "\"apClients\":" + String(WiFi.softAPgetStationNum()) + ",";
        json += "\"clients\":" + clientsJson + ",";
        json += "\"state\":" + String(currentState) + ",";
        json += "\"stateName\":\"" + String(stateName) + "\",";
        json += "\"message\":\"" + statusMessage + "\",";
        json += "\"chargerWifi\":" + String(chargerWifi ? "true" : "false") + ",";
        json += "\"chargerMqtt\":" + String(chargerMqttConnected ? "true" : "false") + ",";
        json += "\"chargerSn\":\"" + chargerSnStr + "\",";
        json += "\"mowerWifi\":" + String(mowerWifi ? "true" : "false") + ",";
        json += "\"mowerMqtt\":" + String(mowerConnected ? "true" : "false") + ",";
        json += "\"mowerSn\":\"" + mowerSn + "\",";
        json += "\"firmwareFile\":\"" + firmwareFilename + "\",";
        json += "\"firmwareVersion\":\"" + firmwareVersion + "\",";
        json += "\"firmwareSize\":" + String(firmwareSize) + ",";
        json += "\"bleDevices\":" + String(scanResultCount) + ",";
        json += "\"userSsid\":\"" + userWifiSsid + "\",";
        json += "\"log\":" + logJson;
        json += "}";
        httpServer.send(200, "application/json", json);
    });

    // ── WiFi config API ──────────────────────────────────────────────────────
    httpServer.on("/api/wifi-config", HTTP_POST, []() {
        String body = httpServer.arg("plain");
        // Simple JSON parsing (no ArduinoJson dependency)
        String ssid = "";
        String password = "";

        int ssidIdx = body.indexOf("\"ssid\"");
        if (ssidIdx >= 0) {
            int colonIdx = body.indexOf(':', ssidIdx);
            int startQuote = body.indexOf('"', colonIdx + 1);
            int endQuote = body.indexOf('"', startQuote + 1);
            if (startQuote >= 0 && endQuote > startQuote) {
                ssid = body.substring(startQuote + 1, endQuote);
            }
        }

        int passIdx = body.indexOf("\"password\"");
        if (passIdx >= 0) {
            int colonIdx = body.indexOf(':', passIdx);
            int startQuote = body.indexOf('"', colonIdx + 1);
            int endQuote = body.indexOf('"', startQuote + 1);
            if (startQuote >= 0 && endQuote > startQuote) {
                password = body.substring(startQuote + 1, endQuote);
            }
        }

        if (ssid.length() == 0) {
            httpServer.send(400, "application/json", "{\"success\":false,\"error\":\"SSID is required\"}");
            return;
        }

        userWifiSsid = ssid;
        userWifiPassword = password;
        // Also update the ui_ buffers so the display/Phase 2 flow picks them up
        strncpy(ui_wifiSsid, ssid.c_str(), sizeof(ui_wifiSsid) - 1);
        ui_wifiSsid[sizeof(ui_wifiSsid) - 1] = '\0';
        strncpy(ui_wifiPassword, password.c_str(), sizeof(ui_wifiPassword) - 1);
        ui_wifiPassword[sizeof(ui_wifiPassword) - 1] = '\0';

        Serial.printf("[HTTP] WiFi config saved: SSID='%s' (%d char password)\r\n",
                      ssid.c_str(), password.length());
        httpServer.send(200, "application/json", "{\"success\":true}");
    });

    // Firmware download
    httpServer.on("/firmware.deb", []() {
        File file = SD.open("/" + firmwareFilename);
        if (!file) {
            httpServer.send(404, "text/plain", "Firmware not found");
            return;
        }
        Serial.printf("[HTTP] Serving firmware: %s (%d bytes)\r\n",
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
            Serial.printf("[HTTP] WiFi password received via web (%d chars)\r\n", pw.length());
            httpServer.send(200, "text/html",
                R"(<html><body style="font-family:system-ui;background:#0a0a1a;color:#e0e0e0;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">)"
                R"(<div style="text-align:center"><h1 style="color:#00d4aa">&#10004; Credentials Received</h1>)"
                R"(<p>Check the device screen for progress.</p></div></body></html>)");
        } else {
            httpServer.send(400, "text/plain", "Missing password field");
        }
    });

    // Captive portal detection + catch-all redirect to dashboard
    httpServer.onNotFound([]() {
        String uri = httpServer.uri();
        String host = httpServer.hostHeader();
        // Log ALL unhandled requests — helps debug charger connectivity checks
        Serial.printf("[HTTP] 404: %s (Host: %s, from %s)\r\n",
            uri.c_str(), host.c_str(), httpServer.client().remoteIP().toString().c_str());
        webLogAdd("HTTP: %s %s from %s", uri.c_str(), host.c_str(),
            httpServer.client().remoteIP().toString().c_str());

        // Apple captive portal check
        if (uri.indexOf("hotspot-detect") >= 0 || uri.indexOf("captive") >= 0) {
            httpServer.send(200, "text/html", "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>");
            return;
        }
        // Android captive portal check
        if (uri.indexOf("generate_204") >= 0) {
            httpServer.send(204);
            return;
        }
        // Everything else → send 200 OK (charger may need HTTP success to start MQTT)
        httpServer.send(200, "text/plain", "OK");
    });

    httpServer.begin();
    Serial.println("[HTTP] Server started on port 80");
}

// ── MQTT broker (minimal) ────────────────────────────────────────────────────

void setupMQTT() {
    mqttBroker.init(MQTT_PORT);
    Serial.printf("[MQTT] sMQTTBroker listening on port %d\r\n", MQTT_PORT);
    webLogAdd("MQTT broker (sMQTTBroker) on port %d", MQTT_PORT);
}

// ── OTA command ──────────────────────────────────────────────────────────────

void sendMqttMessage(String topic, String payload, bool useAes, String sn) {
    std::string payloadStr;

    if (useAes && sn.length() >= 4) {
        String keyStr = "abcdabcd1234" + sn.substring(sn.length() - 4);
        uint8_t key[16];
        memcpy(key, keyStr.c_str(), 16);

        int paddedLen = ((payload.length() + 15) / 16) * 16;
        uint8_t* plaintext = (uint8_t*)calloc(paddedLen, 1);
        memcpy(plaintext, payload.c_str(), payload.length());

        uint8_t* outBuf = (uint8_t*)malloc(paddedLen);
        mbedtls_aes_context aes;
        mbedtls_aes_init(&aes);
        mbedtls_aes_setkey_enc(&aes, key, 128);
        uint8_t iv[16];
        memcpy(iv, AES_IV, 16);
        mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_ENCRYPT, paddedLen, iv, plaintext, outBuf);
        mbedtls_aes_free(&aes);
        free(plaintext);

        payloadStr = std::string((char*)outBuf, paddedLen);
        free(outBuf);
    } else {
        payloadStr = std::string(payload.c_str(), payload.length());
    }

    mqttBroker.publish(std::string(topic.c_str()), payloadStr);
    Serial.printf("[MQTT] Published %d bytes to %s\r\n", (int)payloadStr.length(), topic.c_str());
}

void sendOtaCommand() {
    if (!mowerConnected || mowerSn.length() == 0) return;

    String downloadUrl = "http://10.0.0.1/firmware.deb";

    // EXACT OTA payload — NO tz field, type MUST be "full", cmd MUST be "upgrade"
    String otaJson = "{\"ota_upgrade_cmd\":{\"cmd\":\"upgrade\",\"type\":\"full\",\"content\":\"app\",";
    otaJson += "\"url\":\"" + downloadUrl + "\",";
    otaJson += "\"version\":\"" + firmwareVersion + "\",";
    otaJson += "\"md5\":\"" + firmwareMd5 + "\"}}";

    String topic = "Dart/Send_mqtt/" + mowerSn;

    sendMqttMessage(topic, otaJson, true, mowerSn);

    Serial.printf("[OTA] Sent OTA command to %s: %s (%d bytes firmware)\r\n",
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

    webLogAdd("BLE: Connecting to %s...", device->getName().c_str());
    Serial.printf("[BLE] Connecting to %s (%s)...\r\n", device->getName().c_str(),
                  device->getAddress().toString().c_str());

    if (provisionProgressCb) provisionProgressCb(displayName, 0, totalSteps, "Connecting...");

    NimBLEClient* client = NimBLEDevice::createClient();
    bool connected = false;
    for (int attempt = 1; attempt <= 3; attempt++) {
        Serial.printf("[BLE] Connect attempt %d/3...\r\n", attempt);
        if (client->connect(device)) {
            connected = true;
            break;
        }
        Serial.printf("[BLE] Attempt %d failed\r\n", attempt);
        if (attempt < 3) {
            webLogAdd("BLE: Connect failed, retrying in 2s...");
            delay(2000);
        }
    }
    if (!connected) {
        Serial.println("[BLE] Connection failed after 3 attempts!");
        webLogAdd("BLE: Connection failed (3 attempts)");
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
        Serial.printf("[BLE] Service %s not found!\r\n", svcUuid);
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
    // Charger: direct IP (charger doesn't use DHCP DNS!) + port 1883
    // Mower: hostname mqtt.lfibot.com (uses our custom DNS) + port 1883
    String mqttAddr = isMower ? String(MQTT_HOST) : "10.0.0.1";
    int mqttPort = 1883;
    String mqttPayload = "{\"set_mqtt_info\":{\"addr\":\"" + mqttAddr +
        "\",\"port\":" + String(mqttPort) + "}}";

    // Build command array in correct order per device type
    struct { const char* name; String payload; int step; } cmds[8];
    int numCmds;

    if (isMower) {
        cmds[0] = {"get_signal_info", "{\"get_signal_info\":0}", 1};
        cmds[1] = {"set_wifi_info", wifiPayload, 2};
        cmds[2] = {"set_lora_info", loraPayload, 3};
        cmds[3] = {"set_mqtt_info", mqttPayload, 4};
        cmds[4] = {"set_cfg_info", cfgPayload, 5};
        numCmds = 5;
    } else {
        // Charger: set_wifi FIRST, then rtk, lora, mqtt, get_wifi (verify), cfg
        cmds[0] = {"set_wifi_info", wifiPayload, 1};
        cmds[1] = {"set_rtk_info", "{\"set_rtk_info\":0}", 2};
        cmds[2] = {"set_lora_info", loraPayload, 3};
        cmds[3] = {"set_mqtt_info", mqttPayload, 4};
        cmds[4] = {"get_wifi_info", "{\"get_wifi_info\":0}", 5};
        cmds[5] = {"set_cfg_info", cfgPayload, 6};
        numCmds = 6;
    }

    totalSteps = numCmds;
    bool disconnected = false;
    bool wifiConfirmed = false;
    for (int i = 0; i < numCmds; i++) {
        // Friendly names for the UI (no technical BLE command names)
        const char* friendlyName = cmds[i].name;
        if (strcmp(cmds[i].name, "set_wifi_info") == 0)    friendlyName = "Setting WiFi...";
        else if (strcmp(cmds[i].name, "set_rtk_info") == 0)     friendlyName = "Setting GPS...";
        else if (strcmp(cmds[i].name, "set_lora_info") == 0)    friendlyName = "Setting LoRa...";
        else if (strcmp(cmds[i].name, "set_mqtt_info") == 0)    friendlyName = "Setting server...";
        else if (strcmp(cmds[i].name, "set_cfg_info") == 0)     friendlyName = "Saving settings...";
        else if (strcmp(cmds[i].name, "get_signal_info") == 0)  friendlyName = "Reading signal...";
        else if (strcmp(cmds[i].name, "get_wifi_info") == 0)   friendlyName = "Verifying WiFi...";
        if (provisionProgressCb) provisionProgressCb(displayName, cmds[i].step, totalSteps, friendlyName);

        // 1 second pause between commands (matches bootstrap — gives device time to process)
        if (i > 0) delay(1000);

        bool got = bleSendCommand(client, writeChr, notifChr, cmds[i].payload, cmds[i].name, bleResponse);
        if (got) {
            Serial.printf("[BLE] Response data: %s\r\n", bleResponse.c_str());
            webLogAdd("BLE: %s OK", friendlyName);
            // Check for set_wifi_info success specifically
            if (strcmp(cmds[i].name, "set_wifi_info") == 0) wifiConfirmed = true;
        } else {
            // Check if device disconnected (set_cfg_info causes reboot = success!)
            if (!client->isConnected()) {
                Serial.printf("[BLE] Device disconnected after %s (expected reboot)\r\n", cmds[i].name);
                webLogAdd("BLE: Device rebooted after %s (success!)", friendlyName);
                disconnected = true;
                break;
            }
            Serial.printf("[BLE] %s timeout (non-fatal)\r\n", cmds[i].name);
            webLogAdd("BLE: %s — no response (sent OK)", friendlyName);
        }
    }

    if (!disconnected) {
        try { client->disconnect(); } catch (...) {}
    }

    // Success criteria:
    // - set_wifi_info got result:0 response, OR
    // - device rebooted (disconnect after set_cfg_info)
    bool ok = wifiConfirmed || disconnected;
    const char* reason = "";
    if (wifiConfirmed && disconnected) reason = " (WiFi confirmed + device rebooted)";
    else if (wifiConfirmed) reason = " (WiFi confirmed)";
    else if (disconnected) reason = " (device rebooted, WiFi unconfirmed)";
    else reason = " (no WiFi confirmation!)";

    Serial.printf("[BLE] %s provisioning %s%s\r\n", deviceType, ok ? "OK" : "FAILED", reason);
    webLogAdd("BLE: %s provisioning %s%s", displayName, ok ? "OK" : "FAILED", reason);
    return ok;
}

bool bleSendCommand(NimBLEClient* client, NimBLERemoteCharacteristic* writeChr,
                    NimBLERemoteCharacteristic* notifyChr, const String& json,
                    const char* cmdName, String& response) {
    webLogAdd("BLE: → %s", cmdName);
    Serial.printf("[BLE] -> %s: %s\r\n", cmdName, json.c_str());

    response = "";

    // WriteReq (noResp=false) works fine — the earlier "FAILED" messages were caused by subnet clash,
    // not the write type. WriteReq is preferred for data persistence confirmation.
    bool noResp = false;
    Serial.printf("[BLE] Write mode: WriteReq (with response)\r\n");

    // Send "ble_start" marker
    bool ok = writeChr->writeValue((const uint8_t*)"ble_start", 9, noResp);
    Serial.printf("[BLE] ble_start write: %s\r\n", ok ? "OK" : "FAILED");
    delay(100);  // 100ms after start marker

    // Send JSON in chunks of 20 bytes
    const uint8_t* data = (const uint8_t*)json.c_str();
    int remaining = json.length();
    int offset = 0;
    int chunkNum = 0;
    Serial.printf("[BLE] Sending %d bytes in %d chunks\r\n", remaining, (remaining + 19) / 20);
    while (remaining > 0) {
        int chunkSize = remaining > 20 ? 20 : remaining;
        ok = writeChr->writeValue(data + offset, chunkSize, noResp);
        if (!ok) Serial.printf("[BLE] Chunk %d WRITE FAILED!\r\n", chunkNum);
        offset += chunkSize;
        remaining -= chunkSize;
        chunkNum++;
        delay(100);  // 100ms between chunks (more conservative than 30ms)
    }

    // Send "ble_end" marker (7 bytes, NO null terminator — matches bootstrap)
    delay(100);
    ok = writeChr->writeValue((const uint8_t*)"ble_end", 7, noResp);
    Serial.printf("[BLE] ble_end write: %s\r\n", ok ? "OK" : "FAILED");

    // Wait for response (up to 10 seconds)
    String expectedType = String(cmdName) + "_respond";
    unsigned long start = millis();
    while (millis() - start < 10000) {
        delay(50);
        // Check if we got a complete response (contains _respond)
        if (response.indexOf("_respond") >= 0) {
            // Check if this is the response we're waiting for
            if (response.indexOf(expectedType) >= 0) {
                int jsonStart = response.indexOf('{');
                int jsonEnd = response.lastIndexOf('}');
                if (jsonStart >= 0 && jsonEnd > jsonStart) {
                    response = response.substring(jsonStart, jsonEnd + 1);
                }
                Serial.printf("[BLE] <- %s: %s\r\n", cmdName, response.c_str());
                webLogAdd("BLE: <- %s response OK", cmdName);

                // Check result — result:1 = acknowledged (NOT rejected)
                int resultIdx = response.indexOf("\"result\":");
                if (resultIdx >= 0) {
                    int resultVal = response.charAt(resultIdx + 9) - '0';
                    return resultVal == 0;
                }
                return true;
            } else {
                // Stale response from a previous command — drain it
                Serial.printf("[BLE] Draining stale: %s (waiting for %s)\r\n",
                              response.c_str(), expectedType.c_str());
                response = "";
            }
        }
    }

    Serial.printf("[BLE] <- %s: TIMEOUT\r\n", cmdName);
    webLogAdd("BLE: ← %s timeout", cmdName);
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

            Serial.printf("[SD] Firmware: %s (%d bytes, v%s, md5=%s)\r\n",
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
