#include "mqtt.h"
#include "config.h"
#include "mbedtls/aes.h"

// ── NovaMQTTBroker instance ─────────────────────────────────────────────────

NovaMQTTBroker mqttBroker;

// ── NovaMQTTBroker event handler ────────────────────────────────────────────

bool NovaMQTTBroker::onEvent(sMQTTEvent *event) {
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
                // Extract charger SN from topic: Dart/Send_mqtt/LFIC1231000319
                if (chargerTopic.startsWith("Dart/Send_mqtt/")) {
                    chargerSn = chargerTopic.substring(15);
                }
                Serial.printf("[MQTT] Saved Charger Topic: %s (SN: %s)\r\n", chargerTopic.c_str(), chargerSn.c_str());
                webLogAdd("MQTT: Charger subscribed: %s", chargerTopic.c_str());
            }
            return true;
        }
        case Public_sMQTTEventType: {
            sMQTTPublicClientEvent *e = (sMQTTPublicClientEvent *)event;
            std::string topic = e->Topic();
            std::string payload = e->Payload();

            // Parse OTA progress from mower: {"ota_upgrade_state":{"percentage":42,"status":"upgrade"}}
            if (payload.find("ota_upgrade_state") != std::string::npos) {
                // Extract percentage
                size_t pctPos = payload.find("\"percentage\":");
                if (pctPos != std::string::npos) {
                    int pct = atoi(payload.c_str() + pctPos + 14);
                    otaProgressPercent = pct;
                }
                // Extract status
                size_t statusPos = payload.find("\"status\":\"");
                if (statusPos != std::string::npos) {
                    size_t start = statusPos + 10;
                    size_t end = payload.find('"', start);
                    if (end != std::string::npos) {
                        String status = String(payload.substr(start, end - start).c_str());
                        otaStatus = status;
                        Serial.printf("[OTA] Progress: %d%% status=%s\r\n", otaProgressPercent, status.c_str());

                        if (status == "fail" || status == "error") {
                            // Immediate AES retry if plain failed
                            if (mowerOtaTriedPlain && !mowerOtaTriedAes && mowerConnected) {
                                Serial.println("[OTA] FAIL detected — retrying with AES...");
                                mowerOtaTriedAes = true;
                                sendMowerOtaWithAes(true);
                            }
                        }
                    }
                }
            }

            return true;
        }
        default:
            return true;
    }
}

// ── MQTT broker setup ────────────────────────────────────────────────────────

void setupMQTT() {
    mqttBroker.init(MQTT_PORT);
    Serial.printf("[MQTT] sMQTTBroker listening on port %d\r\n", MQTT_PORT);
    webLogAdd("MQTT broker (sMQTTBroker) on port %d", MQTT_PORT);
}

// ── Send MQTT message with optional AES encryption ──────────────────────────

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

// ── OTA commands ─────────────────────────────────────────────────────────────

void sendMowerOtaWithAes(bool useAes) {
    if (!mowerConnected || mowerSn.length() == 0 || mowerFwFilename.length() == 0) return;

    String downloadUrl = "http://10.0.0.1/firmware.deb";

    // EXACT OTA payload -- NO tz field, type MUST be "full", cmd MUST be "upgrade"
    String otaJson = "{\"ota_upgrade_cmd\":{\"cmd\":\"upgrade\",\"type\":\"full\",\"content\":\"app\",";
    otaJson += "\"url\":\"" + downloadUrl + "\",";
    otaJson += "\"version\":\"" + mowerFwVersion + "\",";
    otaJson += "\"md5\":\"" + mowerFwMd5 + "\"}}";

    String topic = "Dart/Send_mqtt/" + mowerSn;

    sendMqttMessage(topic, otaJson, useAes, mowerSn);
    mowerOtaSentAt = millis();

    Serial.printf("[OTA] Mower OTA sent to %s (%s): %s (%d bytes)\r\n",
                  mowerSn.c_str(), useAes ? "AES" : "PLAIN",
                  mowerFwVersion.c_str(), mowerFwSize);
    statusMessage = useAes ? "OTA sent (encrypted)..." : "OTA sent (plain)...";
}

void sendMowerOta() {
    // Try plain first (v5.x), if no response after 30s try AES (v6.x)
    mowerOtaTriedPlain = true;
    mowerOtaTriedAes = false;
    Serial.println("[OTA] Trying PLAIN first (v5.x stock firmware)...");
    sendMowerOtaWithAes(false);
}

void sendChargerOta() {
    if (!chargerMqttConnected || chargerSn.length() == 0 || chargerFwFilename.length() == 0) return;

    String downloadUrl = "http://10.0.0.1/charger.bin";

    // Charger OTA: simpler format (no cmd/type/content fields)
    String otaJson = "{\"ota_upgrade_cmd\":{";
    otaJson += "\"url\":\"" + downloadUrl + "\",";
    otaJson += "\"version\":\"" + chargerFwVersion + "\",";
    otaJson += "\"md5\":\"" + chargerFwMd5 + "\"}}";

    String topic = "Dart/Send_mqtt/" + chargerSn;

    // Charger always uses AES encryption
    sendMqttMessage(topic, otaJson, true, chargerSn);

    Serial.printf("[OTA] Charger OTA sent to %s: %s (%d bytes)\r\n",
                  chargerSn.c_str(), chargerFwVersion.c_str(), chargerFwSize);
    statusMessage = "OTA sent! Charger downloading firmware...";
}

void sendOtaCommand() {
    // Send to whichever device has firmware available
    if (mowerConnected && mowerFwFilename.length() > 0) sendMowerOta();
    if (chargerMqttConnected && chargerFwFilename.length() > 0) sendChargerOta();
}
