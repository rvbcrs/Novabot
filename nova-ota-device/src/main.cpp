/**
 * Nova-OTA Device — ESP32 standalone Novabot provisioning + OTA tool
 *
 * Flow:
 *   1. Boot → start WiFi AP "OpenNova-Setup" + DNS (mqtt.lfibot.com → self)
 *   2. BLE scan for CHARGER_PILE and NOVABOT devices
 *   3. BLE provision charger: set_wifi → set_lora → set_mqtt (mqtt.lfibot.com) → set_cfg
 *   4. BLE provision mower:   set_wifi → set_lora → set_mqtt (mqtt.lfibot.com) → set_cfg
 *   5. Devices connect to our WiFi AP → resolve mqtt.lfibot.com → us
 *   6. MQTT broker accepts connection from mower
 *   7. Send OTA command with firmware URL (http://192.168.4.1/firmware.deb)
 *   8. Mower downloads firmware from our HTTP server (SD card)
 *   9. Mower installs, reboots with custom firmware
 *  10. LED solid green = done
 *
 * Hardware:
 *   - ESP32-S3 or ESP32-WROOM
 *   - SD card module (SPI): firmware .deb file on SD root
 *   - LED on GPIO2 (built-in) for status
 *   - Optional: button on GPIO0 to restart provisioning
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

// ── Configuration ────────────────────────────────────────────────────────────

// WiFi AP settings — mower will connect to this
static const char* AP_SSID     = "OpenNova-Setup";
static const char* AP_PASSWORD = "12345678";    // WPA2, 8 chars minimum

// The mower ONLY accepts this hostname for MQTT
static const char* MQTT_HOST   = "mqtt.lfibot.com";
static const int   MQTT_PORT   = 1883;

// BLE provisioning — WiFi credentials to send to devices
// These will be set via serial console or hardcoded for testing
static String userWifiSsid     = "";
static String userWifiPassword = "";

// LoRa defaults (same as official app)
static const int LORA_ADDR    = 718;
static const int LORA_CHANNEL = 15;
static const int LORA_HC      = 20;
static const int LORA_LC      = 14;

// Hardware pins
static const int LED_PIN      = 2;      // Built-in LED
static const int SD_CS_PIN    = 5;      // SD card chip select
static const int BUTTON_PIN   = 0;      // Boot button

// AES encryption for MQTT messages
static const uint8_t AES_IV[] = "abcd1234abcd1234";

// ── State machine ────────────────────────────────────────────────────────────

enum State {
    STATE_INIT,
    STATE_WAIT_CONFIG,          // Waiting for WiFi SSID/password via serial
    STATE_BLE_SCAN,             // Scanning for BLE devices
    STATE_PROVISION_CHARGER,    // BLE provisioning charger
    STATE_PROVISION_MOWER,      // BLE provisioning mower
    STATE_WAIT_MQTT,            // Waiting for mower to connect via MQTT
    STATE_OTA_SENT,             // OTA command sent, waiting for download
    STATE_DONE,                 // All done!
    STATE_ERROR,
};

static State currentState = STATE_INIT;
static String statusMessage = "Initializing...";

// ── Globals ──────────────────────────────────────────────────────────────────

DNSServer dnsServer;
WebServer httpServer(80);

// MQTT broker state
static WiFiServer mqttTcpServer(MQTT_PORT);
static WiFiClient mqttClient;
static bool mowerConnected = false;
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
void setLed(bool on);
void blinkLed(int times, int delayMs);

// ── BLE Scan callback ────────────────────────────────────────────────────────

class ScanCallbacks : public NimBLEScanCallbacks {
    void onResult(const NimBLEAdvertisedDevice* advertisedDevice) override {
        String name = advertisedDevice->getName().c_str();
        if (name == "CHARGER_PILE" && chargerDevice == nullptr) {
            Serial.printf("[BLE] Found charger: %s RSSI=%d\n",
                         advertisedDevice->getAddress().toString().c_str(),
                         advertisedDevice->getRSSI());
            chargerDevice = new NimBLEAdvertisedDevice(*advertisedDevice);
        }
        if ((name == "NOVABOT" || name == "Novabot" || name == "novabot") && mowerDevice == nullptr) {
            Serial.printf("[BLE] Found mower: %s RSSI=%d\n",
                         advertisedDevice->getAddress().toString().c_str(),
                         advertisedDevice->getRSSI());
            mowerDevice = new NimBLEAdvertisedDevice(*advertisedDevice);
        }
    }
    void onScanEnd(const NimBLEScanResults& results, int reason) override {
        bleScanning = false;
        Serial.printf("[BLE] Scan complete, found %d device(s)\n", results.getCount());
    }
};

// ── Setup ────────────────────────────────────────────────────────────────────

void setup() {
    Serial.begin(115200);
    delay(1000);

    pinMode(LED_PIN, OUTPUT);
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    blinkLed(3, 200);

    Serial.println();
    Serial.println("╔══════════════════════════════════════╗");
    Serial.println("║   Nova-OTA — Novabot Flash Tool      ║");
    Serial.println("╚══════════════════════════════════════╝");

    // Initialize SD card
    if (!SD.begin(SD_CS_PIN)) {
        Serial.println("[SD] Card mount failed! Insert SD card with firmware.");
        statusMessage = "No SD card — insert card with firmware.deb";
        currentState = STATE_ERROR;
        return;
    }
    Serial.printf("[SD] Card mounted, size: %lluMB\n", SD.cardSize() / (1024 * 1024));

    // Find firmware file on SD
    if (!loadFirmwareInfo()) {
        statusMessage = "No firmware found on SD card";
        currentState = STATE_ERROR;
        return;
    }

    // Start WiFi AP
    setupWifiAP();

    // Start DNS (captive portal: mqtt.lfibot.com → our IP)
    setupDNS();

    // Start HTTP server (serves firmware + status page)
    setupHTTP();

    // Start MQTT TCP listener
    setupMQTT();

    // Initialize BLE
    NimBLEDevice::init("Nova-OTA");
    NimBLEDevice::setMTU(185);

    // Wait for user config via serial or start with defaults
    currentState = STATE_WAIT_CONFIG;
    statusMessage = "Send WiFi credentials via serial: SSID,password";
    Serial.println("[SETUP] Send WiFi credentials via serial: WIFI:ssid,password");
    Serial.println("[SETUP] Or press BOOT button to use AP-only mode");
}

// ── Main loop ────────────────────────────────────────────────────────────────

void loop() {
    dnsServer.processNextRequest();
    httpServer.handleClient();
    handleMQTTClients();

    // Read serial for WiFi config
    if (Serial.available()) {
        String line = Serial.readStringUntil('\n');
        line.trim();
        if (line.startsWith("WIFI:")) {
            int comma = line.indexOf(',', 5);
            if (comma > 5) {
                userWifiSsid = line.substring(5, comma);
                userWifiPassword = line.substring(comma + 1);
                Serial.printf("[CONFIG] WiFi: %s / %s\n", userWifiSsid.c_str(), "***");
                currentState = STATE_BLE_SCAN;
            }
        }
    }

    // Button press → start scan with AP-only mode
    if (digitalRead(BUTTON_PIN) == LOW && currentState == STATE_WAIT_CONFIG) {
        delay(50); // debounce
        if (digitalRead(BUTTON_PIN) == LOW) {
            Serial.println("[CONFIG] AP-only mode — devices will use OpenNova-Setup WiFi");
            userWifiSsid = AP_SSID;
            userWifiPassword = AP_PASSWORD;
            currentState = STATE_BLE_SCAN;
            while (digitalRead(BUTTON_PIN) == LOW) delay(10);
        }
    }

    // State machine
    switch (currentState) {
        case STATE_BLE_SCAN:
            if (!bleScanning) {
                Serial.println("[STATE] Starting BLE scan...");
                statusMessage = "Scanning for Novabot devices...";
                startBleScan();
            }
            // Check if both found
            if (chargerDevice && mowerDevice) {
                NimBLEScan* scan = NimBLEDevice::getScan();
                scan->stop();
                bleScanning = false;
                currentState = STATE_PROVISION_CHARGER;
            }
            // Or just mower (charger already provisioned)
            if (!bleScanning && mowerDevice && !chargerDevice) {
                Serial.println("[BLE] Only mower found, skipping charger provisioning");
                currentState = STATE_PROVISION_MOWER;
            }
            break;

        case STATE_PROVISION_CHARGER:
            Serial.println("[STATE] Provisioning charger...");
            statusMessage = "Provisioning charging station...";
            setLed(true);
            if (provisionDevice(chargerDevice, "charger")) {
                Serial.println("[PROVISION] Charger OK!");
                currentState = STATE_PROVISION_MOWER;
            } else {
                Serial.println("[PROVISION] Charger FAILED");
                statusMessage = "Charger provisioning failed — retry?";
                currentState = STATE_ERROR;
            }
            setLed(false);
            break;

        case STATE_PROVISION_MOWER:
            if (!mowerDevice) {
                Serial.println("[STATE] No mower found, re-scanning...");
                currentState = STATE_BLE_SCAN;
                break;
            }
            Serial.println("[STATE] Provisioning mower...");
            statusMessage = "Provisioning mower...";
            setLed(true);
            if (provisionDevice(mowerDevice, "mower")) {
                Serial.println("[PROVISION] Mower OK! Waiting for MQTT connection...");
                currentState = STATE_WAIT_MQTT;
                statusMessage = "Waiting for mower to connect via MQTT...";
            } else {
                Serial.println("[PROVISION] Mower FAILED");
                statusMessage = "Mower provisioning failed — retry?";
                currentState = STATE_ERROR;
            }
            setLed(false);
            break;

        case STATE_WAIT_MQTT:
            // Blink LED while waiting
            setLed((millis() / 500) % 2);
            if (mowerConnected && millis() - mowerConnectTime > 5000) {
                // Mower connected for 5 seconds, send OTA
                currentState = STATE_OTA_SENT;
                sendOtaCommand();
            }
            break;

        case STATE_OTA_SENT:
            // Blink fast while OTA in progress
            setLed((millis() / 200) % 2);
            statusMessage = "OTA firmware sent — mower is downloading...";
            // After mower disconnects (rebooting), we're done
            if (!mowerConnected && mowerSn.length() > 0) {
                currentState = STATE_DONE;
                statusMessage = "Done! Mower is installing custom firmware.";
                Serial.println("[OTA] Mower disconnected — installing firmware!");
            }
            break;

        case STATE_DONE:
            setLed(true); // Solid LED
            break;

        case STATE_ERROR:
            // Blink SOS pattern
            blinkLed(3, 100);
            delay(300);
            blinkLed(3, 300);
            delay(300);
            blinkLed(3, 100);
            delay(1000);
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
            // Skip fixed header + remaining length + protocol name + flags + keepalive
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

                        // Extract SN from clientId (e.g., "LFIN1231000211_6688")
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
    String otaJson = "{\"ota_upgrade_cmd\":{\"cmd\":\"upgrade\",\"type\":\"full\",\"content\":\"app\",";
    otaJson += "\"url\":\"" + downloadUrl + "\",";
    otaJson += "\"version\":\"" + firmwareVersion + "\",";
    otaJson += "\"md5\":\"" + firmwareMd5 + "\"}}";

    String topic = "Dart/Send_mqtt/" + mowerSn;

    // AES encrypt
    // Key = "abcdabcd1234" + last 4 chars of SN
    String keyStr = "abcdabcd1234" + mowerSn.substring(mowerSn.length() - 4);
    uint8_t key[16];
    memcpy(key, keyStr.c_str(), 16);

    // Pad to 16-byte boundary with nulls
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
    // Encode remaining length
    int rl = remainingLen;
    do {
        uint8_t b = rl % 128;
        rl /= 128;
        if (rl > 0) b |= 0x80;
        header[headerLen++] = b;
    } while (rl > 0);

    // Topic length
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

    Serial.printf("[BLE] Connecting to %s (%s)...\n", device->getName().c_str(),
                  device->getAddress().toString().c_str());

    NimBLEClient* client = NimBLEDevice::createClient();
    if (!client->connect(device)) {
        Serial.println("[BLE] Connection failed!");
        return false;
    }
    Serial.println("[BLE] Connected!");

    // Discover GATT service
    // Charger: service 0x1234, char 0x2222
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

    bool ok = true;
    String resp;

    // Step 1: get_signal_info
    bleSendCommand(client, writeChr, notifChr, "{\"get_signal_info\":0}", "get_signal_info", resp);

    // Step 2: set_wifi_info
    String wifiJson;
    if (isMower) {
        wifiJson = "{\"set_wifi_info\":{\"ap\":{\"ssid\":\"" + userWifiSsid +
                   "\",\"passwd\":\"" + userWifiPassword + "\",\"encrypt\":0}}}";
    } else {
        wifiJson = "{\"set_wifi_info\":{\"sta\":{\"ssid\":\"" + userWifiSsid +
                   "\",\"passwd\":\"" + userWifiPassword + "\",\"encrypt\":0}," +
                   "\"ap\":{\"ssid\":\"CHARGER_PILE\",\"passwd\":\"12345678\",\"encrypt\":0}}}";
    }
    if (!bleSendCommand(client, writeChr, notifChr, wifiJson, "set_wifi_info", resp)) {
        Serial.println("[BLE] set_wifi_info failed!");
        ok = false;
    }

    // Step 3: set_lora_info
    String loraJson = "{\"set_lora_info\":{\"addr\":" + String(LORA_ADDR) +
                      ",\"channel\":" + String(LORA_CHANNEL) +
                      ",\"hc\":" + String(LORA_HC) +
                      ",\"lc\":" + String(LORA_LC) + "}}";
    bleSendCommand(client, writeChr, notifChr, loraJson, "set_lora_info", resp);

    // Step 4: set_mqtt_info (MUST be mqtt.lfibot.com — firmware validates this)
    String mqttJson = "{\"set_mqtt_info\":{\"addr\":\"" + String(MQTT_HOST) +
                      "\",\"port\":" + String(MQTT_PORT) + "}}";
    bleSendCommand(client, writeChr, notifChr, mqttJson, "set_mqtt_info", resp);

    // Step 5: set_cfg_info (commit)
    String cfgJson;
    if (isMower) {
        cfgJson = "{\"set_cfg_info\":{\"cfg_value\":1,\"tz\":\"Europe/Amsterdam\"}}";
    } else {
        cfgJson = "{\"set_cfg_info\":1}";
    }
    bleSendCommand(client, writeChr, notifChr, cfgJson, "set_cfg_info", resp);

    client->disconnect();
    Serial.printf("[BLE] %s provisioning %s!\n", deviceType, ok ? "complete" : "FAILED");
    return ok;
}

bool bleSendCommand(NimBLEClient* client, NimBLERemoteCharacteristic* writeChr,
                    NimBLERemoteCharacteristic* notifyChr, const String& json,
                    const char* cmdName, String& response) {
    Serial.printf("[BLE] → %s: %s\n", cmdName, json.c_str());

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

    // Wait for response
    unsigned long start = millis();
    while (millis() - start < 10000) {
        delay(50);
        // Check if we got a complete response (contains _respond)
        if (response.indexOf("_respond") >= 0) {
            // Extract just the JSON part (between ble_start and ble_end)
            int jsonStart = response.indexOf('{');
            int jsonEnd = response.lastIndexOf('}');
            if (jsonStart >= 0 && jsonEnd > jsonStart) {
                response = response.substring(jsonStart, jsonEnd + 1);
            }
            Serial.printf("[BLE] ← %s: %s\n", cmdName, response.c_str());

            // Check result
            int resultIdx = response.indexOf("\"result\":");
            if (resultIdx >= 0) {
                int resultVal = response.charAt(resultIdx + 9) - '0';
                return resultVal == 0;
            }
            return true;
        }
    }

    Serial.printf("[BLE] ← %s: TIMEOUT\n", cmdName);
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

            // Extract version
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

// ── LED helpers ──────────────────────────────────────────────────────────────

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
