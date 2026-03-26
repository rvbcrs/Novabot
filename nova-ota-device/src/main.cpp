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
static WiFiClient mqttClient;
static bool mowerConnected = false;
static bool chargerMqttConnected = false;
static String mowerSn = "";
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
    // Initialize display and touch
    display_init();
    display_boot(VERSION);
    touch_init();
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

    // Start WiFi AP
    setupWifiAP();

    // In LCD mode, always use AP-only (no serial config needed)
    userWifiSsid = AP_SSID;
    userWifiPassword = AP_PASSWORD;

    // Start network services immediately to detect already-provisioned devices
    setupDNS();
    setupHTTP();
    setupMQTT();
    servicesStarted = true;

    // Initialize BLE
    NimBLEDevice::init("Nova-OTA");
    NimBLEDevice::setMTU(185);

    // Wait for already-provisioned devices to connect (WiFi + MQTT takes ~20s)
    Serial.println("[SETUP] Waiting up to 30s for already-provisioned devices...");
#ifdef WAVESHARE_LCD
    display_confirm("Starting...", "Checking for connected", "devices...", "Skip");
#endif
    for (int i = 0; i < 300; i++) {
        delay(100);
        dnsServer.processNextRequest();
        httpServer.handleClient();
        handleMQTTClients();
        // Log WiFi clients periodically
        if (i % 50 == 0) {
            int clients = WiFi.softAPgetStationNum();
            Serial.printf("[SETUP] %ds — %d WiFi client(s), mower MQTT: %s\n",
                          i / 10, clients, mowerConnected ? "YES" : "no");
        }
        // Mower connected via MQTT — can exit early
        if (mowerConnected) {
            Serial.printf("[SETUP] Mower %s connected after %ds!\n", mowerSn.c_str(), i / 10);
            break;
        }
#ifdef WAVESHARE_LCD
        // Skip button
        if (touch_available()) {
            int16_t tx, ty;
            if (touch_read(tx, ty) && display_btnHit(tx, ty)) {
                Serial.println("[SETUP] Skip pressed");
                break;
            }
        }
#endif
    }

    if (mowerConnected) {
        // Mower already connected via MQTT — skip BLE!
        Serial.printf("[SETUP] Mower %s already connected! Skipping BLE.\n", mowerSn.c_str());
        setState(STATE_CONFIRM_MQTT);
    } else {
        // No devices yet — start BLE scan
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

    // Touch handling for interactive states
#ifdef WAVESHARE_LCD
    int16_t tx, ty;
    bool touched = false;
    if (touch_available() && touch_read(tx, ty)) {
        touched = true;
        Serial.printf("[TOUCH] x=%d y=%d (state=%d)\n", tx, ty, currentState);
    }
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
                if (chargerDevice) { delete chargerDevice; chargerDevice = nullptr; }
                if (mowerDevice) { delete mowerDevice; mowerDevice = nullptr; }
                Serial.println("[STATE] Starting BLE scan...");
                statusMessage = "Scanning for Novabot devices...";
                startBleScan();
            }

#ifdef WAVESHARE_LCD
            display_scanning();
#endif

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
            if (touched) {
                bool startBtn = false;
                int hitIdx = display_hitTest(tx, ty, scanResultCount, startBtn);

                if (startBtn) {
                    // Start button tapped — begin provisioning
                    if (selectedChargerIdx >= 0 || selectedMowerIdx >= 0) {
                        Serial.println("[TOUCH] Start pressed");

                        // Find the NimBLE devices matching selection
                        // (chargerDevice/mowerDevice already set by scan callbacks)
                        if (selectedChargerIdx >= 0 && chargerDevice) {
                            setState(STATE_PROVISION_CHARGER);
                        } else if (selectedMowerIdx >= 0 && mowerDevice) {
                            setState(STATE_PROVISION_MOWER);
                        } else {
                            statusMessage = "No valid device selected";
                            display_error("Select at least one device");
                        }
                    }
                } else if (hitIdx >= 0) {
                    // Visual row tapped — map to real scanResults index
                    // Display only shows Novabot devices, so map row → array index
                    int realIdx = -1, row = 0;
                    for (int i = 0; i < scanResultCount; i++) {
                        if (!scanResults[i].isCharger && !scanResults[i].isMower) continue;
                        if (row == hitIdx) { realIdx = i; break; }
                        row++;
                    }

                    if (realIdx >= 0) {
                        ScanResult& r = scanResults[realIdx];
                        if (r.isCharger) {
                            selectedChargerIdx = (selectedChargerIdx == realIdx) ? -1 : realIdx;
                            Serial.printf("[TOUCH] Charger %s\n", selectedChargerIdx >= 0 ? "selected" : "deselected");
                        } else if (r.isMower) {
                            selectedMowerIdx = (selectedMowerIdx == realIdx) ? -1 : realIdx;
                            Serial.printf("[TOUCH] Mower %s\n", selectedMowerIdx >= 0 ? "selected" : "deselected");
                        }
                        display_devices(scanResults, scanResultCount, selectedChargerIdx, selectedMowerIdx);
                    }
                }
                delay(200);  // Simple debounce
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
            if (touched && display_btnHit(tx, ty)) {
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
            if (mowerConnected && millis() - mowerConnectTime > 5000) {
                setState(STATE_CONFIRM_MQTT);
            }
            break;

        case STATE_CONFIRM_MQTT:
            if (stateJustEntered) {
                stateJustEntered = false;
                bool hasOta = firmwareFilename.length() > 0;
                String l1 = "Mower connected: " + mowerSn;
                String l2 = hasOta ? ("Firmware: " + firmwareVersion) : "No firmware on SD";
                const char* btn = hasOta ? "Flash OTA" : "Done";
#ifdef WAVESHARE_LCD
                display_confirm("MQTT Connected", l1.c_str(), l2.c_str(), btn);
#endif
                Serial.printf("[STATE] MQTT confirmed — %s\n", hasOta ? "ready for OTA" : "no firmware");
            }
#ifdef WAVESHARE_LCD
            if (touched && display_btnHit(tx, ty)) {
                delay(200);
                if (firmwareFilename.length() > 0) {
                    setState(STATE_OTA_SENT);
                    sendOtaCommand();
                } else {
                    setState(STATE_DONE);
                }
            }
#else
            if (firmwareFilename.length() > 0) {
                setState(STATE_OTA_SENT);
                sendOtaCommand();
            } else {
                setState(STATE_DONE);
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

            // After mower disconnects (rebooting), we're done
            if (!mowerConnected && mowerSn.length() > 0) {
                statusMessage = "Done! Mower installing custom firmware.";
                Serial.println("[OTA] Mower disconnected — installing firmware!");
                setState(STATE_DONE);
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
            // Tap to restart
            if (touched) {
                delay(300);
                Serial.println("[TOUCH] Restarting...");
                setState(STATE_BLE_SCAN);
            }
#endif
            break;

        case STATE_ERROR:
#ifdef WAVESHARE_LCD
            // Error screen already drawn on entry; tap to retry
            if (touched) {
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

void setupWifiAP() {
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASSWORD);
    delay(500);
    Serial.printf("[WiFi] AP started: %s (IP: %s)\n", AP_SSID,
                  WiFi.softAPIP().toString().c_str());
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
        if (mqttClient && mqttClient.connected()) {
            mqttClient.stop(); // Only one client at a time
        }
        mqttClient = mqttTcpServer.available();
        Serial.printf("[MQTT] Client connected from %s\n",
                      mqttClient.remoteIP().toString().c_str());
    }

    // Read data from connected client
    if (mqttClient && mqttClient.connected() && mqttClient.available()) {
        // Parse MQTT CONNECT packet to extract client ID
        uint8_t buf[512];
        int len = mqttClient.read(buf, sizeof(buf));
        if (len > 0 && buf[0] == 0x10) { // CONNECT packet
            // Parse client ID from CONNECT packet
            int idx = 1;
            // Remaining length (variable)
            int remaining = 0;
            int mult = 1;
            while (idx < len) {
                remaining += (buf[idx] & 0x7F) * mult;
                if (!(buf[idx] & 0x80)) { idx++; break; }
                mult *= 128; idx++;
            }
            // Protocol name length (2 bytes) + name + protocol level + flags + keepalive
            if (idx + 2 < len) {
                int protoLen = (buf[idx] << 8) | buf[idx + 1];
                idx += 2 + protoLen + 1 + 1 + 2; // name + level + flags + keepalive
                // Client ID length
                if (idx + 2 < len) {
                    int clientIdLen = (buf[idx] << 8) | buf[idx + 1];
                    idx += 2;
                    if (idx + clientIdLen <= len) {
                        String clientId = String((char*)(buf + idx), clientIdLen);
                        Serial.printf("[MQTT] CONNECT clientId=%s\n", clientId.c_str());

                        // Detect charger (ESP32_...) or mower (LFIN..._6688)
                        if (clientId.startsWith("ESP32_")) {
                            chargerMqttConnected = true;
                            Serial.printf("[MQTT] Charger connected: %s\n", clientId.c_str());
                        }
                        if (clientId.startsWith("LFI")) {
                            int underscore = clientId.indexOf('_');
                            mowerSn = underscore > 0 ? clientId.substring(0, underscore) : clientId;
                            mowerConnected = true;
                            mowerConnectTime = millis();
                            Serial.printf("[MQTT] Mower connected: %s\n", mowerSn.c_str());
                        }
                    }
                }
            }

            // Send CONNACK
            uint8_t connack[] = { 0x20, 0x02, 0x00, 0x00 };
            mqttClient.write(connack, 4);
        } else if (len > 0 && buf[0] == 0x82) {
            // SUBSCRIBE — send SUBACK
            uint8_t packetId1 = buf[2], packetId2 = buf[3];
            uint8_t suback[] = { 0x90, 0x03, packetId1, packetId2, 0x00 };
            mqttClient.write(suback, 5);
        } else if (len > 0 && buf[0] == 0xC0) {
            // PINGREQ — send PINGRESP
            uint8_t pingresp[] = { 0xD0, 0x00 };
            mqttClient.write(pingresp, 2);
        }
    }

    // Detect disconnect
    if (mowerConnected && mqttClient && !mqttClient.connected()) {
        Serial.printf("[MQTT] Mower %s disconnected\n", mowerSn.c_str());
        mowerConnected = false;
    }
}

// ── OTA command ──────────────────────────────────────────────────────────────

void sendOtaCommand() {
    if (!mqttClient || !mqttClient.connected() || mowerSn.length() == 0) return;

    String downloadUrl = "http://192.168.4.1/firmware.deb";

    // EXACT OTA payload — NO tz field, type MUST be "full", cmd MUST be "upgrade"
    String otaJson = "{\"ota_upgrade_cmd\":{\"cmd\":\"upgrade\",\"type\":\"full\",\"content\":\"app\",";
    otaJson += "\"url\":\"" + downloadUrl + "\",";
    otaJson += "\"version\":\"" + firmwareVersion + "\",";
    otaJson += "\"md5\":\"" + firmwareMd5 + "\"}}";

    String topic = "Dart/Send_mqtt/" + mowerSn;

    // AES encrypt — key = "abcdabcd1234" + last 4 chars of SN
    String keyStr = "abcdabcd1234" + mowerSn.substring(mowerSn.length() - 4);
    uint8_t key[16];
    memcpy(key, keyStr.c_str(), 16);

    // Pad to 16-byte boundary with nulls (NOT PKCS7)
    int plainLen = otaJson.length();
    int paddedLen = ((plainLen + 15) / 16) * 16;
    uint8_t* plaintext = (uint8_t*)calloc(paddedLen, 1);
    memcpy(plaintext, otaJson.c_str(), plainLen);

    // AES-128-CBC encrypt
    uint8_t* ciphertext = (uint8_t*)malloc(paddedLen);
    mbedtls_aes_context aes;
    mbedtls_aes_init(&aes);
    mbedtls_aes_setkey_enc(&aes, key, 128);
    uint8_t iv[16];
    memcpy(iv, AES_IV, 16);
    mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_ENCRYPT, paddedLen, iv, plaintext, ciphertext);
    mbedtls_aes_free(&aes);

    // Build MQTT PUBLISH packet
    int topicLen = topic.length();
    int payloadLen = paddedLen;
    int remainingLen = 2 + topicLen + payloadLen;

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

    uint8_t topicHeader[2] = { (uint8_t)(topicLen >> 8), (uint8_t)(topicLen & 0xFF) };

    mqttClient.write(header, headerLen);
    mqttClient.write(topicHeader, 2);
    mqttClient.write((uint8_t*)topic.c_str(), topicLen);
    mqttClient.write(ciphertext, payloadLen);

    free(plaintext);
    free(ciphertext);

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
    const int totalSteps = 5;

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

    // All commands are non-fatal on timeout — charger often doesn't respond
    // but still processes the commands (proven via RPi btmon)
    struct { const char* name; String payload; int step; } cmds[] = {
        {"get_signal_info", "{\"get_signal_info\":0}", 1},
        {"set_wifi_info", "", 2},  // filled below
        {"set_lora_info", "{\"set_lora_info\":{\"addr\":" + String(LORA_ADDR) +
            ",\"channel\":" + String(LORA_CHANNEL) + ",\"hc\":" + String(LORA_HC) +
            ",\"lc\":" + String(LORA_LC) + "}}", 3},
        {"set_mqtt_info", "{\"set_mqtt_info\":{\"addr\":\"" + String(MQTT_HOST) +
            "\",\"port\":" + String(MQTT_PORT) + "}}", 4},
        {"set_cfg_info", "", 5},  // filled below
    };

    // set_wifi_info
    if (isMower) {
        cmds[1].payload = "{\"set_wifi_info\":{\"ap\":{\"ssid\":\"" + userWifiSsid +
                   "\",\"passwd\":\"" + userWifiPassword + "\",\"encrypt\":0}}}";
    } else {
        cmds[1].payload = "{\"set_wifi_info\":{\"sta\":{\"ssid\":\"" + userWifiSsid +
                   "\",\"passwd\":\"" + userWifiPassword + "\",\"encrypt\":0}," +
                   "\"ap\":{\"ssid\":\"CHARGER_PILE\",\"passwd\":\"12345678\",\"encrypt\":0}}}";
    }

    // set_cfg_info — charger: {set_cfg_info:1}, mower: with tz (safe in BLE)
    cmds[4].payload = isMower
        ? "{\"set_cfg_info\":{\"cfg_value\":1,\"tz\":\"Europe/Amsterdam\"}}"
        : "{\"set_cfg_info\":1}";

    bool disconnected = false;
    for (int i = 0; i < 5; i++) {
        if (provisionProgressCb) provisionProgressCb(displayName, cmds[i].step, totalSteps, cmds[i].name);
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

    // Send "ble_start" marker
    writeChr->writeValue((uint8_t*)"ble_start\0", 10, false);
    delay(50);

    // Send JSON in chunks of ~20 bytes
    const uint8_t* data = (const uint8_t*)json.c_str();
    int remaining = json.length();
    int offset = 0;
    while (remaining > 0) {
        int chunkSize = remaining > 20 ? 20 : remaining;
        writeChr->writeValue(data + offset, chunkSize, false);
        offset += chunkSize;
        remaining -= chunkSize;
        delay(30);
    }

    // Send "ble_end" marker
    writeChr->writeValue((uint8_t*)"ble_end\0", 8, false);

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
