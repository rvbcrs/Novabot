#include "ble_provisioning.h"
#include "config.h"
#include "nvs_storage.h"
#include "mqtt_handler.h"
#include "lora_commands.h"
#include "gps_parser.h"
#include <WiFi.h>
#include <nvs_flash.h>
#include <nvs.h>
#include <esp_mac.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <ArduinoJson.h>

// ── Static State ────────────────────────────────────────────────────────────

static BLEServer* pServer = NULL;
static BLECharacteristic* pCmdChar = NULL;
static bool bleActive = false;
static bool configCommitted = false;
static char deviceSN[32] = {0};

// Frame reassembly buffer
static String rxBuffer;
static bool inFrame = false;

// ── Forward declarations ────────────────────────────────────────────────────

static void sendBleResponse(const char* json);
static void sendResponse(const char* json, bool viaBle);

// ── BLE Callbacks ───────────────────────────────────────────────────────────

class ServerCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer* server) override {
        Serial.println("[BLE] Client connected");
    }
    void onDisconnect(BLEServer* server) override {
        Serial.println("[BLE] Client disconnected");
        if (bleActive) {
            server->getAdvertising()->start();
        }
    }
};

class CmdCharCallbacks : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic* pChar) override {
        String value = pChar->getValue();
        if (value.length() == 0) return;

        if (value == "ble_start") {
            rxBuffer = "";
            inFrame = true;
            return;
        }

        if (value == "ble_end") {
            if (inFrame && rxBuffer.length() > 0) {
                dispatchSharedCommand(rxBuffer.c_str(), true);
            }
            inFrame = false;
            rxBuffer = "";
            return;
        }

        if (inFrame) {
            rxBuffer += value;
        } else {
            dispatchSharedCommand(value.c_str(), true);
        }
    }
};

// ── Init / Stop ─────────────────────────────────────────────────────────────

void bleInit(const char* sn) {
    strncpy(deviceSN, sn, sizeof(deviceSN) - 1);

    BLEDevice::init(BLE_DEVICE_NAME);
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks());

    BLEService* pService = pServer->createService(BLE_SERVICE_UUID);

    // Command characteristic (Write Without Response + Notify)
    pCmdChar = pService->createCharacteristic(
        BLE_CHAR_CMD_UUID,
        BLECharacteristic::PROPERTY_WRITE_NR | BLECharacteristic::PROPERTY_NOTIFY
    );
    pCmdChar->addDescriptor(new BLE2902());
    pCmdChar->setCallbacks(new CmdCharCallbacks());

    pService->start();

    // Configure advertising with manufacturer data
    BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(BLE_SERVICE_UUID);
    pAdvertising->setScanResponse(true);

    // Manufacturer data: [0x66, 0x55, <BLE MAC 6 bytes>, 0x45, 0x53, 0x50]
    BLEAdvertisementData advData;
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_BT);
    uint8_t mfgData[11] = {0x66, 0x55, mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], 0x45, 0x53, 0x50};
    advData.setManufacturerData(String((char*)mfgData, sizeof(mfgData)));
    advData.setName(BLE_DEVICE_NAME);
    pAdvertising->setAdvertisementData(advData);

    pAdvertising->start();
    bleActive = true;
    configCommitted = false;

    Serial.println("[BLE] Provisioning service started");
}

void bleStop() {
    if (!bleActive) return;
    BLEDevice::getAdvertising()->stop();
    BLEDevice::deinit(true);
    bleActive = false;
    Serial.println("[BLE] Stopped");
}

bool bleIsActive() { return bleActive; }
bool bleWasConfigCommitted() { return configCommitted; }
void bleClearConfigCommitted() { configCommitted = false; }

// ── Send Response via BLE (chunked) ─────────────────────────────────────────

static void sendBleResponse(const char* json) {
    if (!pCmdChar) return;

    size_t len = strlen(json);

    pCmdChar->setValue("ble_start");
    pCmdChar->notify();
    delay(BLE_CHUNK_DELAY_MS);

    for (size_t offset = 0; offset < len; offset += BLE_CHUNK_SIZE) {
        size_t chunkLen = len - offset;
        if (chunkLen > BLE_CHUNK_SIZE) chunkLen = BLE_CHUNK_SIZE;

        pCmdChar->setValue((uint8_t*)(json + offset), chunkLen);
        pCmdChar->notify();
        delay(BLE_CHUNK_DELAY_MS);
    }

    pCmdChar->setValue("ble_end");
    pCmdChar->notify();
}

// ── Send Response via BLE or MQTT ───────────────────────────────────────────

static void sendResponse(const char* json, bool viaBle) {
    if (viaBle) {
        sendBleResponse(json);
    } else {
        mqttPublishEncrypted(json);
    }
}

// ── Shared Command Dispatcher — matches Ghidra FUN_4200d9a2 ────────────────
// Handles 9 provisioning/config commands used by both BLE and MQTT.
// Response format: {"type":"xxx_respond","message":{"result":<r>,"value":<v>}}

int dispatchSharedCommand(const char* json, bool viaBle) {
    Serial.printf("[CMD] Shared: %.80s\n", json);

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, json);
    if (err) {
        Serial.printf("[CMD] JSON parse error: %s\n", err.c_str());
        return -1;
    }

    JsonDocument resp;
    JsonObject msg;
    char buf[512];
    JsonVariant v;

    // ── get_wifi_info ────────────────────────────────────────────────────
    // Response: value: {"wifi": <signal>, "rtk": <satellites>}
    if ((v = doc["get_wifi_info"])) {
        Serial.println("[CMD] get_wifi_info");

        int wifiSignal = WiFi.RSSI();
        // Map RSSI: -30 dBm = 0, -90 dBm = 60
        wifiSignal = (wifiSignal > -30) ? 0 : (wifiSignal < -90) ? 60 : (int)(-30 - wifiSignal);
        int satellites = gpsGetData().satellites;

        resp["type"] = "get_wifi_info_respond";
        msg = resp["message"].to<JsonObject>();
        msg["result"] = 0;
        JsonObject val = msg["value"].to<JsonObject>();
        val["wifi"] = wifiSignal;
        val["rtk"] = satellites;
        goto send_response;
    }

    // ── set_wifi_info ────────────────────────────────────────────────────
    // Parses sta: {ssid, passwd, encrypt} and ap: {ssid, passwd, encrypt}
    // After storing, triggers WiFi connect with 55 second timeout.
    if ((v = doc["set_wifi_info"])) {
        Serial.println("[CMD] set_wifi_info");

        JsonObject wifiObj = v.as<JsonObject>();

        // STA WiFi (connect to home router)
        if (wifiObj["sta"].is<JsonObject>()) {
            JsonObject sta = wifiObj["sta"];
            const char* ssid = sta["ssid"] | "";
            const char* passwd = sta["passwd"] | "";

            if (strlen(ssid) > 1) {
                Serial.printf("[CMD] WiFi STA: %s\n", ssid);
                WifiConfig cfg;
                memset(&cfg, 0, sizeof(cfg));
                strncpy(cfg.ssid, ssid, sizeof(cfg.ssid) - 1);
                strncpy(cfg.password, passwd, sizeof(cfg.password) - 1);
                nvsWriteWifi(cfg);
            }

            // AP WiFi (charger's own access point)
            if (wifiObj["ap"].is<JsonObject>()) {
                JsonObject ap = wifiObj["ap"];
                const char* apSsid = ap["ssid"] | "";
                const char* apPasswd = ap["passwd"] | "";

                if (strlen(apSsid) > 7) {
                    Serial.printf("[CMD] WiFi AP: %s\n", apSsid);
                    WifiApConfig apCfg;
                    memset(&apCfg, 0, sizeof(apCfg));
                    strncpy(apCfg.ssid, apSsid, sizeof(apCfg.ssid) - 1);
                    strncpy(apCfg.password, apPasswd, sizeof(apCfg.password) - 1);
                    nvsWriteWifiAp(apCfg);

                    // Trigger WiFi reconnect (Ghidra: queue cmd 0x00, wait 55s)
                    // In Arduino context, WiFi reconnect happens after restart
                }
            }
        }

        resp["type"] = "set_wifi_info_respond";
        msg = resp["message"].to<JsonObject>();
        msg["result"] = 0;
        msg["value"] = (const char*)NULL;
        goto send_response;
    }

    // ── get_signal_info ──────────────────────────────────────────────────
    // Measures WiFi RSSI + satellite count. Waits up to 60s in original.
    // Response: value: {"wifi": <signal>, "rtk": <satellites>}
    if ((v = doc["get_signal_info"])) {
        Serial.println("[CMD] get_signal_info");

        int wifiSignal = WiFi.RSSI();
        wifiSignal = (wifiSignal > -30) ? 0 : (wifiSignal < -90) ? 60 : (int)(-30 - wifiSignal);
        GpsData gps = gpsGetData();

        resp["type"] = "get_signal_info_respond";
        msg = resp["message"].to<JsonObject>();
        msg["result"] = 0;
        JsonObject val = msg["value"].to<JsonObject>();
        val["wifi"] = wifiSignal;
        val["rtk"] = (int)gps.satellites;
        goto send_response;
    }

    // ── set_rtk_info ─────────────────────────────────────────────────────
    // Triggers RTK configuration, waits up to 30 seconds
    if ((v = doc["set_rtk_info"])) {
        Serial.println("[CMD] set_rtk_info");

        // Queue RTK config command to LoRa task
        // Ghidra: queue cmd 0x02, poll FUN_42009b4c(0x66) up to 30s
        LoraQueueCmd cmd = {};
        cmd.queueId = LORA_Q_CONFIG;
        QueueHandle_t loraQ = mqttGetLoraQueue();
        if (loraQ) {
            xQueueSend(loraQ, &cmd, pdMS_TO_TICKS(1000));
        }

        // Wait for RTK config completion (simplified: just wait a bit)
        int result = 0;
        for (int i = 0; i < 30; i++) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            // TODO: Check RTK config state from LoRa task
            break; // Simplified for now
        }

        resp["type"] = "set_rtk_info_respond";
        msg = resp["message"].to<JsonObject>();
        msg["result"] = result;
        msg["value"] = (const char*)NULL;
        goto send_response;
    }

    // ── set_lora_info ────────────────────────────────────────────────────
    // Parses addr, channel, hc, lc. Triggers channel scan (60s timeout).
    // Response value = assigned channel number.
    if ((v = doc["set_lora_info"])) {
        Serial.println("[CMD] set_lora_info");

        JsonObject obj = v.as<JsonObject>();
        uint16_t addr = obj["addr"] | 0;
        uint8_t channel = obj["channel"] | 0;
        uint8_t hc = obj["hc"] | 20;
        uint8_t lc = obj["lc"] | 14;

        Serial.printf("[CMD] LoRa: addr=%d, ch=%d, hc=%d, lc=%d\n", addr, channel, hc, lc);

        // Store to global config (DAT_42000828)
        LoraConfig lora;
        lora.addrHi = (addr >> 8) & 0xFF;
        lora.addrLo = addr & 0xFF;
        lora.channel = channel;

        LoraHcLc hclc;
        hclc.hc = hc;
        hclc.lc = lc;

        // Trigger channel scan via LoRa task queue (Ghidra: queue cmd 0x01)
        LoraQueueCmd cmd = {};
        cmd.queueId = LORA_Q_SCAN_CHANNEL;
        QueueHandle_t loraQ = mqttGetLoraQueue();
        if (loraQ) {
            xQueueSend(loraQ, &cmd, pdMS_TO_TICKS(1000));
        }

        // Poll for scan completion (up to 60 seconds, Ghidra: iVar4 < 0x3c)
        int result = 0;
        for (int i = 0; i < 60; i++) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            // Check scan state: 0=done_ok, 1=done_ok, timeout=fail
            // Ghidra: FUN_4200b22c() returns scan state
            // Simplified: just save immediately for now
            if (i == 0) {
                result = 0;
                break;
            }
        }

        // Save to NVS after scan (Ghidra: FUN_4200e028 + FUN_4200e100)
        nvsWriteLora(lora);
        nvsWriteLoraHcLc(hclc);

        // Respond with assigned channel
        uint8_t assignedChannel = lora.channel;

        resp["type"] = "set_lora_info_respond";
        msg = resp["message"].to<JsonObject>();
        msg["result"] = result;
        msg["value"] = (int)assignedChannel;
        goto send_response;
    }

    // ── set_mqtt_info ────────────────────────────────────────────────────
    // Parses addr + port, stores to NVS
    if ((v = doc["set_mqtt_info"])) {
        Serial.println("[CMD] set_mqtt_info");

        JsonObject obj = v.as<JsonObject>();
        const char* addr = obj["addr"] | "";
        uint16_t port = obj["port"] | MQTT_DEFAULT_PORT;

        if (strlen(addr) > 0) {
            Serial.printf("[CMD] MQTT: %s:%d\n", addr, port);
            MqttConfig cfg;
            memset(&cfg, 0, sizeof(cfg));
            strncpy(cfg.host, addr, sizeof(cfg.host) - 1);
            cfg.port = port;
            nvsWriteMqtt(cfg);
        }

        resp["type"] = "set_mqtt_info_respond";
        msg = resp["message"].to<JsonObject>();
        msg["result"] = 0;
        msg["value"] = (const char*)NULL;
        goto send_response;
    }

    // ── get_cfg_info ─────────────────────────────────────────────────────
    // Returns NVS cfg_flag value
    if ((v = doc["get_cfg_info"])) {
        Serial.println("[CMD] get_cfg_info");

        uint8_t flag = 0;
        int ret = nvsReadCfgFlag(flag) ? 0 : -1;

        int value = 0;
        if (ret == 0 && flag == 1) {
            value = 1;
        }

        resp["type"] = "get_cfg_info_respond";
        msg = resp["message"].to<JsonObject>();
        msg["result"] = 0;
        msg["value"] = value;
        goto send_response;
    }

    // ── set_cfg_info ─────────────────────────────────────────────────────
    // value=0: clear NVS storage (Ghidra: FUN_4200dd50)
    // value=1: save cfg_flag=1, set commit flag → LoRa CONFIG → restart
    if ((v = doc["set_cfg_info"])) {
        int cfgVal = 0;
        if (v.is<int>()) {
            cfgVal = v.as<int>();
        } else if (v.is<JsonObject>()) {
            cfgVal = v["cfg_value"] | 0;
        }

        Serial.printf("[CMD] set_cfg_info: %d\n", cfgVal);

        if (cfgVal == 0) {
            // Clear NVS storage (Ghidra: FUN_4200dd50)
            // Erase all stored config
            nvs_handle_t handle;
            if (nvs_open(NVS_NS_STORAGE, NVS_READWRITE, &handle) == ESP_OK) {
                nvs_erase_all(handle);
                nvs_commit(handle);
                nvs_close(handle);
            }
            Serial.println("[CMD] NVS storage cleared");
        }
        else if (cfgVal == 1) {
            // Save cfg_flag=1, set commit flag
            nvsWriteCfgFlag(1);
            configCommitted = true;
            Serial.println("[CMD] Config committed");
        }

        resp["type"] = "set_cfg_info_respond";
        msg = resp["message"].to<JsonObject>();
        msg["result"] = 0;
        msg["value"] = (const char*)NULL;

        serializeJson(resp, buf, sizeof(buf));
        sendResponse(buf, viaBle);

        // After sending response: if committed, trigger LoRa CONFIG + restart
        // Matches Ghidra: check DAT_420010f4 == 0x01 → FUN_42060d58() → delay(1000) → restart
        if (cfgVal == 1) {
            // Send WiFi/MQTT/LoRa config to mower via LoRa
            // (LoRa CONFIG transmission happens in main.cpp restart sequence)
            delay(1000);
            ESP.restart();
        }
        return 0;
    }

    // ── get_dev_info ─────────────────────────────────────────────────────
    // Returns system info: sn, system version, firmware version
    if ((v = doc["get_dev_info"])) {
        Serial.println("[CMD] get_dev_info");

        resp["type"] = "get_dev_info_respond";
        msg = resp["message"].to<JsonObject>();
        msg["result"] = 0;
        JsonObject val = msg["value"].to<JsonObject>();
        val["sn"] = deviceSN;
        val["system"] = "v0.0.1";
        val["version"] = FIRMWARE_VERSION;
        goto send_response;
    }

    Serial.printf("[CMD] Unknown shared command: %.40s\n", json);
    return -1;

send_response:
    serializeJson(resp, buf, sizeof(buf));
    sendResponse(buf, viaBle);
    return 0;
}
