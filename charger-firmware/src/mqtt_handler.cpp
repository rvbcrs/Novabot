#include "mqtt_handler.h"
#include "config.h"
#include "aes_crypto.h"
#include "nvs_storage.h"
#include "ota_handler.h"
#include "gps_parser.h"
#include "lora_commands.h"
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ── Static state ─────────────────────────────────────────────────────────────

static WiFiClient wifiClient;
static PubSubClient mqtt(wifiClient);

static char serialNumber[32] = {0};
static char pubTopic[64] = {0};
static char subTopic[64] = {0};
static char clientId[32] = {0};

static QueueHandle_t loraQueue = NULL;
static QueueHandle_t otaQueue = NULL;
static QueueHandle_t mqttCmdQueue = NULL;

// Global receive buffer — MQTT callback stores decrypted JSON here,
// mqtt_config_task reads from here. Matches Ghidra DAT_420012cc/DAT_420012d0.
static char mqttRxBuffer[1024] = {0};
static size_t mqttRxLen = 0;

// MQTT connected flag — matches Ghidra DAT_4200129c
static volatile bool mqttConnectedFlag = false;

// Status publish gate — matches Ghidra PTR_DAT_42001408
static volatile uint8_t statusPublishEnabled = 1;

// ── Build MQTT client ID from BLE MAC ───────────────────────────────────────
// Client ID = "ESP32_" + last 3 bytes of BLE MAC in hex
// BLE MAC = WiFi STA MAC + 2 (ESP32 convention)

static void buildClientId() {
    uint8_t mac[6];
    WiFi.macAddress(mac);

    // STA MAC + 2 = BLE MAC (add with carry)
    uint8_t bleMac[6];
    memcpy(bleMac, mac, 6);
    uint32_t sum = bleMac[5] + 2;
    bleMac[5] = sum & 0xFF;
    if (sum > 0xFF) {
        sum = bleMac[4] + 1;
        bleMac[4] = sum & 0xFF;
    }

    snprintf(clientId, sizeof(clientId), "ESP32_%02x%02x%02x",
             bleMac[3], bleMac[4], bleMac[5]);
}

// ── MQTT Callback — runs in PubSubClient context ────────────────────────────
// Decrypts message, stores in global buffer, signals mqtt_config_task

static void onMqttMessage(char* topic, byte* payload, unsigned int length) {
    if (length == 0) return;

    // Try AES decryption first (v0.4.0 encrypted messages)
    uint8_t decrypted[1024];
    size_t decLen = aesDecrypt(serialNumber, payload, length, decrypted, sizeof(decrypted));

    if (decLen > 0 && decrypted[0] == '{') {
        decrypted[decLen] = '\0';
        memcpy(mqttRxBuffer, decrypted, decLen + 1);
        mqttRxLen = decLen;
    }
    // Fallback: plain JSON (v0.3.6 or unencrypted)
    else if (payload[0] == '{') {
        size_t copyLen = length < sizeof(mqttRxBuffer) - 1 ? length : sizeof(mqttRxBuffer) - 1;
        memcpy(mqttRxBuffer, payload, copyLen);
        mqttRxBuffer[copyLen] = '\0';
        mqttRxLen = copyLen;
    }
    else {
        return;
    }

    // Signal mqtt_config_task: cmd=0x00 → handle MQTT command
    uint8_t cmd = 0x00;
    xQueueSend(mqttCmdQueue, &cmd, 0);
}

// ── Init ────────────────────────────────────────────────────────────────────

void mqttInit(const char* sn, const char* host, uint16_t port) {
    strncpy(serialNumber, sn, sizeof(serialNumber) - 1);
    snprintf(pubTopic, sizeof(pubTopic), MQTT_TOPIC_PUB_FMT, sn);
    snprintf(subTopic, sizeof(subTopic), MQTT_TOPIC_SUB_FMT, sn);
    buildClientId();

    mqtt.setServer(host, port);
    mqtt.setCallback(onMqttMessage);
    mqtt.setBufferSize(1024);

    loraQueue = xQueueCreate(10, sizeof(LoraQueueCmd));
    otaQueue = xQueueCreate(1, sizeof(OtaRequest));
    mqttCmdQueue = xQueueCreate(5, sizeof(uint8_t));

    Serial.printf("[MQTT] Configured: %s:%d, clientId=%s\n", host, port, clientId);
    Serial.printf("[MQTT] Pub: %s, Sub: %s\n", pubTopic, subTopic);
}

void mqttLoop() {
    mqtt.loop();
}

bool mqttIsConnected() {
    return mqtt.connected();
}

void mqttConnect() {
    if (mqtt.connected()) return;

    Serial.printf("[MQTT] Connecting as %s...\n", clientId);

    if (mqtt.connect(clientId)) {
        Serial.println("[MQTT] Connected");
        mqtt.subscribe(subTopic, MQTT_QOS_SUB);
        mqttConnectedFlag = true;
    } else {
        Serial.printf("[MQTT] Failed, rc=%d\n", mqtt.state());
    }
}

QueueHandle_t mqttGetLoraQueue() { return loraQueue; }
QueueHandle_t mqttGetOtaQueue() { return otaQueue; }
QueueHandle_t mqttGetMqttCmdQueue() { return mqttCmdQueue; }

// ── Publish ─────────────────────────────────────────────────────────────────

bool mqttPublishRaw(const char* json) {
    if (!mqtt.connected()) return false;
    return mqtt.publish(pubTopic, json);
}

bool mqttPublishEncrypted(const char* json) {
    if (!mqtt.connected()) return false;

    size_t jsonLen = strlen(json);
    uint8_t encrypted[1024];
    size_t encLen = aesEncrypt(serialNumber, (const uint8_t*)json, jsonLen,
                               encrypted, sizeof(encrypted));
    if (encLen == 0) {
        Serial.println("[MQTT] Encrypt failed");
        return false;
    }

    return mqtt.publish(pubTopic, encrypted, encLen);
}

// ── Helper: build response JSON ─────────────────────────────────────────────
// Builds: {"type":"xxx_respond","message":{"result":<r>,"value":<v>}}
// Caller passes value as a JsonVariant or uses the overloads.

static void publishResponse(const char* respondType, int result, JsonVariant value) {
    JsonDocument doc;
    doc["type"] = respondType;
    JsonObject msg = doc["message"].to<JsonObject>();
    msg["result"] = result;
    msg["value"] = value;

    char buf[512];
    serializeJson(doc, buf, sizeof(buf));
    mqttPublishEncrypted(buf);
}

static void publishResponseNull(const char* respondType, int result) {
    JsonDocument doc;
    doc["type"] = respondType;
    JsonObject msg = doc["message"].to<JsonObject>();
    msg["result"] = result;
    msg["value"] = (const char*)NULL;

    char buf[256];
    serializeJson(doc, buf, sizeof(buf));
    mqttPublishEncrypted(buf);
}

static void publishResponseInt(const char* respondType, int result, int value) {
    JsonDocument doc;
    doc["type"] = respondType;
    JsonObject msg = doc["message"].to<JsonObject>();
    msg["result"] = result;
    msg["value"] = value;

    char buf[256];
    serializeJson(doc, buf, sizeof(buf));
    mqttPublishEncrypted(buf);
}

// ── Relay command helper ────────────────────────────────────────────────────
// Sends LoraQueueCmd to LoRa task, then polls loraAckResult for up to 3 seconds.
// Matches Ghidra pattern: clear → queue → poll(3×1s) → check 1/0x101
// Returns 0 on success, 1 on error/timeout.

static int relayAndWait(uint8_t queueId, uint8_t mapName = 0,
                         uint16_t area = 0, uint8_t cutterhigh = 0) {
    loraAckResult = 0;

    LoraQueueCmd cmd = {};
    cmd.queueId = queueId;
    cmd.mapName = mapName;
    cmd.area = area;
    cmd.cutterhigh = cutterhigh;

    xQueueSend(loraQueue, &cmd, pdMS_TO_TICKS(1000));

    for (int i = 0; i < 3; i++) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (loraAckResult == 1) return 0;        // Success
        if (loraAckResult == 0x101) return 1;     // Error
    }
    return 1; // Timeout
}

// ── MQTT Command Dispatch — matches Ghidra FUN_4200e8c4 ────────────────────
// Handles 9 MQTT-only commands from global mqttRxBuffer.

int mqttDispatchCommand() {
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, mqttRxBuffer, mqttRxLen);
    if (err) {
        Serial.printf("[MQTT] JSON parse error: %s\n", err.c_str());
        return -1;
    }

    // ── get_lora_info ────────────────────────────────────────────────────
    // Response: {"type":"get_lora_info_respond","message":{"result":0,"value":{"channel":<ch>,"addr":<addr>,"rssi":<rssi>}}}
    JsonVariant v;
    if ((v = doc["get_lora_info"])) {
        Serial.println("[MQTT] get_lora_info");

        LoraConfig lora;
        nvsReadLora(lora);
        uint16_t addr = ((uint16_t)lora.addrHi << 8) | lora.addrLo;

        JsonDocument resp;
        resp["type"] = "get_lora_info_respond";
        JsonObject msg = resp["message"].to<JsonObject>();
        msg["result"] = 0;
        JsonObject val = msg["value"].to<JsonObject>();
        val["channel"] = (int)lora.channel;
        val["addr"] = (int)addr;
        val["rssi"] = (int)loraRssiValue;

        char buf[256];
        serializeJson(resp, buf, sizeof(buf));
        mqttPublishEncrypted(buf);
        return 0;
    }

    // ── ota_version_info ────────────────────────────────────────────────
    // Response: {"type":"ota_version_info_respond","message":{"result":0,"value":{"system":"v0.0.1","version":"<stored>"}}}
    if ((v = doc["ota_version_info"])) {
        Serial.println("[MQTT] ota_version_info");

        JsonDocument resp;
        resp["type"] = "ota_version_info_respond";
        JsonObject msg = resp["message"].to<JsonObject>();
        msg["result"] = 0;
        JsonObject val = msg["value"].to<JsonObject>();
        val["system"] = "v0.0.1";
        val["version"] = FIRMWARE_VERSION;

        char buf[256];
        serializeJson(resp, buf, sizeof(buf));
        mqttPublishEncrypted(buf);
        return 0;
    }

    // ── ota_upgrade_cmd ─────────────────────────────────────────────────
    // Parses URL, md5, version. Compares version to current.
    // Response: {"type":"ota_upgrade_cmd_respond","message":{"result":0,"value":0}}
    if ((v = doc["ota_upgrade_cmd"])) {
        JsonObject obj = v.as<JsonObject>();
        const char* url = obj["url"] | "";
        const char* md5Str = obj["md5"] | "";
        const char* version = obj["version"] | "";

        Serial.printf("[MQTT] ota_upgrade_cmd: url=%s, ver=%s\n", url, version);

        // Compare version strings (Ghidra: strncmp with length 6)
        int cmp = strncmp(version, FIRMWARE_VERSION, 6);
        int result = 0;
        int value = 0;

        if (cmp == 0) {
            // Same version — reject
            result = 0;
            value = 1;
        } else if (cmp < 0) {
            // Downgrade — reject with value -2
            result = 0;
            value = -2;
        } else {
            // Newer version — accept, queue OTA
            result = 0;
            value = 0;

            OtaRequest req;
            memset(&req, 0, sizeof(req));
            strncpy(req.url, url, sizeof(req.url) - 1);
            strncpy(req.version, version, sizeof(req.version) - 1);
            strncpy(req.md5, md5Str, sizeof(req.md5) - 1);
            xQueueSend(otaQueue, &req, pdMS_TO_TICKS(1000));
        }

        publishResponseInt("ota_upgrade_cmd_respond", result, value);
        return 0;
    }

    // ── start_run ───────────────────────────────────────────────────────
    // Params: mapName (uint8), area (uint16), cutterhigh (uint8)
    // Response: {"type":"start_run_respond","message":{"result":0,"value":null}}
    if ((v = doc["start_run"])) {
        JsonObject obj = v.as<JsonObject>();
        uint8_t mapName = obj["mapName"] | 0;
        uint16_t area = obj["area"] | 0;
        uint8_t cutterhigh = obj["cutterhigh"] | 0;

        Serial.printf("[MQTT] start_run: map=%d, area=%d, ch=%d\n", mapName, area, cutterhigh);

        int r = relayAndWait(LORA_Q_START_RUN, mapName, area, cutterhigh);
        publishResponseNull("start_run_respond", r);
        return 0;
    }

    // ── pause_run ───────────────────────────────────────────────────────
    if ((v = doc["pause_run"])) {
        Serial.println("[MQTT] pause_run");
        int r = relayAndWait(LORA_Q_PAUSE_RUN);
        publishResponseNull("pause_run_respond", r);
        return 0;
    }

    // ── resume_run ──────────────────────────────────────────────────────
    if ((v = doc["resume_run"])) {
        Serial.println("[MQTT] resume_run");
        int r = relayAndWait(LORA_Q_RESUME_RUN);
        publishResponseNull("resume_run_respond", r);
        return 0;
    }

    // ── stop_run ────────────────────────────────────────────────────────
    if ((v = doc["stop_run"])) {
        Serial.println("[MQTT] stop_run");
        int r = relayAndWait(LORA_Q_STOP_RUN);
        publishResponseNull("stop_run_respond", r);
        return 0;
    }

    // ── stop_time_run ───────────────────────────────────────────────────
    if ((v = doc["stop_time_run"])) {
        Serial.println("[MQTT] stop_time_run");
        int r = relayAndWait(LORA_Q_STOP_TIME_RUN);
        publishResponseNull("stop_time_run_respond", r);
        return 0;
    }

    // ── go_pile ─────────────────────────────────────────────────────────
    if ((v = doc["go_pile"])) {
        Serial.println("[MQTT] go_pile");
        int r = relayAndWait(LORA_Q_GO_PILE);
        publishResponseNull("go_pile_respond", r);
        return 0;
    }

    Serial.printf("[MQTT] Unknown cmd: %.80s\n", mqttRxBuffer);
    return -1;
}

// ── up_status_info Publisher — matches Ghidra FUN_4200f00c ──────────────────
// Builds charger_status bitfield and publishes with mower status data.

void mqttPublishStatus() {
    GpsData gps = gpsGetData();

    // ── Build charger_status bitfield ────────────────────────────────────
    // Bit 0: GPS valid
    // Bit 8: RTK fixed
    // Middle bits: LoRa RSSI (if 1 <= rssi <= 145)
    // Bits 24-31: satellite count
    uint32_t chargerStatus = 0;

    if (gps.valid) {
        chargerStatus |= 0x01;
    }
    if (gps.rtkFixed) {
        chargerStatus |= 0x100;
    }

    int rssi = loraRssiValue;
    if (rssi >= 1 && rssi <= 0x91) {  // 1 to 145 (Ghidra: rssi - 1 < 0x91)
        chargerStatus |= (rssi & 0x7F) << 1;
    }

    chargerStatus |= ((uint32_t)gps.satellites & 0xFF) << 24;

    // ── Build JSON ───────────────────────────────────────────────────────
    JsonDocument doc;
    JsonObject info = doc["up_status_info"].to<JsonObject>();

    info["charger_status"] = chargerStatus;
    info["mower_status"] = mowerStatus.dataValid ? mowerStatus.mowerStatus : 0;
    info["mower_info"] = mowerStatus.dataValid ? mowerStatus.mowerInfo : 0;
    info["mower_x"] = mowerStatus.dataValid ? mowerStatus.mowerX : 0;
    info["mower_y"] = mowerStatus.dataValid ? mowerStatus.mowerY : 0;
    info["mower_z"] = mowerStatus.dataValid ? mowerStatus.mowerZ : 0;
    info["mower_info1"] = mowerStatus.dataValid ? mowerStatus.mowerInfo1 : 0;

    // mower_error: only report if miss counter >= 2 (Ghidra: DAT_42000c6c < 2 → report 0)
    if (mowerStatus.mowerError < 2) {
        info["mower_error"] = 0;
    } else {
        info["mower_error"] = mowerStatus.mowerError;
    }

    char buf[512];
    serializeJson(doc, buf, sizeof(buf));
    mqttPublishEncrypted(buf);
}

// ── mqtt_config_task — matches Ghidra FUN_4200f158 ──────────────────────────
// Waits for WiFi, connects MQTT, then loops:
//   - Receive commands from mqttCmdQueue (500ms timeout)
//   - If cmd=0x00: dispatch MQTT command
//   - If cmd=0x01: reset status publish counter
//   - Publish up_status_info every ~2s (4 loops × 500ms)

void mqttConfigTask(void* param) {
    // Wait for WiFi to be connected
    while (WiFi.status() != WL_CONNECTED) {
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    vTaskDelay(pdMS_TO_TICKS(500));

    // Connect to MQTT broker
    mqttConnect();

    uint8_t statusCounter = 0;

    for (;;) {
        // Reconnect if needed
        if (!mqttIsConnected()) {
            mqttConnect();
            if (!mqttIsConnected()) {
                vTaskDelay(pdMS_TO_TICKS(5000));
                continue;
            }
        }

        mqttLoop();

        // Check for incoming commands (500ms timeout, matches Ghidra)
        uint8_t cmd;
        if (xQueueReceive(mqttCmdQueue, &cmd, pdMS_TO_TICKS(500)) == pdTRUE) {
            if (cmd == 0x00) {
                // Handle MQTT command from receive buffer
                Serial.println("[MQTT] mqtt_config_task: CMD_HANDLER");
                mqttDispatchCommand();
            }
            else if (cmd == 0x01) {
                // Reset status publish counter
                Serial.println("[MQTT] mqtt_config_task: RESET_COUNTER");
                statusPublishEnabled = 0;
            }
        }

        // Publish status every ~2 seconds (4 × 500ms)
        // Matches Ghidra: counter > 3 with 500ms queue timeout
        if (mqttConnectedFlag && statusPublishEnabled) {
            statusCounter++;
            if (statusCounter > 3) {
                statusCounter = 0;
                mqttPublishStatus();
            }
        }
    }
}
