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
                // Query firmware version via extended_commands.py
                String extTopic = "novabot/extended/" + mowerSn;
                mqttBroker.publish(std::string(extTopic.c_str()), std::string("{\"get_system_info\":{}}"));
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

            // Decrypt mower messages (AES-128-CBC, v6.x firmware)
            // Topic: Dart/Receive_mqtt/LFIN... — these are encrypted
            if (topic.find("Dart/Receive_mqtt/LFIN") != std::string::npos && mowerSn.length() >= 4 &&
                payload.size() > 0 && payload.size() % 16 == 0 && payload[0] != '{') {
                String keyStr = "abcdabcd1234" + mowerSn.substring(mowerSn.length() - 4);
                uint8_t key[16];
                memcpy(key, keyStr.c_str(), 16);
                uint8_t iv[16];
                memcpy(iv, AES_IV, 16);

                uint8_t* decBuf = (uint8_t*)malloc(payload.size() + 1);
                if (decBuf) {
                    mbedtls_aes_context aes;
                    mbedtls_aes_init(&aes);
                    mbedtls_aes_setkey_dec(&aes, key, 128);
                    mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_DECRYPT, payload.size(), iv,
                        (const uint8_t*)payload.data(), decBuf);
                    mbedtls_aes_free(&aes);
                    // Strip null padding
                    size_t decLen = payload.size();
                    while (decLen > 0 && decBuf[decLen - 1] == 0) decLen--;
                    decBuf[decLen] = 0;
                    payload = std::string((char*)decBuf, decLen);
                    free(decBuf);
                }
            }

            // Parse firmware version from extended_commands response
            // Topic: novabot/extended_response/<SN> → {"get_system_info_respond":{..."firmware_version":"v6.0.2-custom-20"...}}
            if (topic.find("extended_response") != std::string::npos &&
                payload.find("firmware_version") != std::string::npos) {
                size_t fvPos = payload.find("\"firmware_version\":\"");
                if (fvPos != std::string::npos) {
                    size_t start = fvPos + 20;
                    size_t end = payload.find('"', start);
                    if (end != std::string::npos) {
                        mowerFirmwareVersion = String(payload.substr(start, end - start).c_str());
                        Serial.printf("[MQTT] Mower firmware: %s\r\n", mowerFirmwareVersion.c_str());
                    }
                }
            }

            // During OTA flash: only process ota_upgrade_state, skip everything else.
            // Mower sends report_state_robot / report_state_timer_data every few seconds —
            // the Serial.printf + string parsing overwhelms the ESP32 during firmware download.
            bool otaActive = mowerOtaTriedPlain || mowerOtaTriedAes;
            if (otaActive && payload.find("ota_upgrade_state") == std::string::npos) {
                return true;
            }

            // Log decrypted mower messages (skip frequent report_exception_state)
            if (topic.find("Dart/Receive_mqtt/LFIN") != std::string::npos && payload.size() > 0 && payload[0] == '{') {
                if (payload.find("report_exception_state") == std::string::npos) {
                    Serial.printf("[MOWER] (%dB) %s\r\n", (int)payload.size(), payload.c_str());
                }
            }

            // Parse charging state from multiple sources:
            // 1. report_state_timer_data: {"battery_state":"CHARGING"} or {"battery_state":"FULL"}
            // 2. report_state_robot: {"recharge_status":9} (9 = FINISHED = on charger)
            if (payload.find("battery_state") != std::string::npos) {
                bool wasCharging = mowerCharging;
                mowerCharging = payload.find("\"battery_state\":\"CHARGING\"") != std::string::npos
                             || payload.find("\"battery_state\":\"FULL\"") != std::string::npos;
                if (mowerCharging != wasCharging) {
                    Serial.printf("[MQTT] Mower charging state: %s\r\n", mowerCharging ? "ON CHARGER" : "NOT CHARGING");
                }
            }
            // Also check report_state_robot for recharge_status and Recharge: FINISHED
            if (!mowerCharging && payload.find("report_state_robot") != std::string::npos) {
                bool wasCharging = mowerCharging;
                mowerCharging = payload.find("\"recharge_status\":9") != std::string::npos
                             || payload.find("Recharge: FINISHED") != std::string::npos
                             || payload.find("Recharge: CHARGING") != std::string::npos;
                // Fallback: battery_power >= 95 likely means on charger
                if (!mowerCharging) {
                    size_t bpPos = payload.find("\"battery_power\":");
                    if (bpPos != std::string::npos) {
                        int bp = atoi(payload.c_str() + bpPos + 16);
                        if (bp >= 95) mowerCharging = true;
                    }
                }
                if (mowerCharging != wasCharging) {
                    Serial.printf("[MQTT] Mower on charger (from report_state_robot)\r\n");
                }
            }

            // Parse OTA progress from mower: {"ota_upgrade_state":{"percentage":42,"status":"upgrade"}}
            if (payload.find("ota_upgrade_state") != std::string::npos) {
                // Extract percentage
                size_t pctPos = payload.find("\"percentage\":");
                if (pctPos != std::string::npos) {
                    double rawPct = atof(payload.c_str() + pctPos + 14);
                    // percentage is 0.0-1.0 (fraction), convert to 0-100
                    int pct = (rawPct <= 1.0) ? (int)(rawPct * 100) : (int)rawPct;
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

                        if (status == "success" || otaProgressPercent >= 100) {
                            Serial.println("[OTA] COMPLETE!");
                            mowerOtaTriedPlain = false;
                            mowerOtaTriedAes = false;
                        }
                        else if (status == "fail" || status == "error") {
                            // Only retry with AES if PLAIN never made any progress
                            // If we reached >0%, PLAIN worked — the fail is install-side, not encryption
                            static int maxProgressSeen = 0;
                            if (otaProgressPercent > maxProgressSeen) maxProgressSeen = otaProgressPercent;
                            if (mowerOtaTriedPlain && !mowerOtaTriedAes && maxProgressSeen == 0 && mowerConnected) {
                                Serial.println("[OTA] FAIL with 0% progress — retrying with AES...");
                                mowerOtaTriedAes = true;
                                sendMowerOtaWithAes(true);
                            } else {
                                Serial.printf("[OTA] FAIL at install stage (max progress was %d%%)\r\n", maxProgressSeen);
                                maxProgressSeen = 0;
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

        // Null-byte padding to 16-byte boundary (NOT PKCS#7!)
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

    // Direct IP — curl on mower can reach the ESP32 AP gateway directly
    String downloadUrl = "http://10.0.0.1/firmware.deb";

    // EXACT OTA payload -- NO tz field, type MUST be "full", cmd MUST be "upgrade"
    String otaJson = "{\"ota_upgrade_cmd\":{\"cmd\":\"upgrade\",\"type\":\"full\",\"content\":\"app\",";
    otaJson += "\"url\":\"" + downloadUrl + "\",";
    // Always append timestamp to version to ensure ota_client sees it as "newer"
    String otaVersion = mowerFwVersion + "-" + String(millis() / 1000);
    otaJson += "\"version\":\"" + otaVersion + "\",";
    otaJson += "\"md5\":\"" + mowerFwMd5 + "\"}}";

    String topic = "Dart/Send_mqtt/" + mowerSn;

    Serial.printf("[OTA] JSON payload: %s\r\n", otaJson.c_str());
    sendMqttMessage(topic, otaJson, useAes, mowerSn);
    mowerOtaSentAt = millis();

    Serial.printf("[OTA] Mower OTA sent to %s (%s): %s (%d bytes)\r\n",
                  mowerSn.c_str(), useAes ? "AES" : "PLAIN",
                  mowerFwVersion.c_str(), mowerFwSize);
    statusMessage = useAes ? "OTA sent (encrypted)..." : "OTA sent (plain)...";
}

void sendMowerOta() {
    // Kick charger off WiFi — its CCMP frames destabilize the channel during download
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

void sendOtaCleanup() {
    // Send clean_ota_cache to extended_commands.py on the mower.
    // Cleans /userdata/ota/upgrade_pkg/ + resets upgrade.txt + reboots mower.
    if (!mowerConnected || mowerSn.length() == 0) return;
    String topic = "novabot/extended/" + mowerSn;
    String payload = "{\"clean_ota_cache\":{}}";
    mqttBroker.publish(std::string(topic.c_str()), std::string(payload.c_str()));
    Serial.printf("[OTA] Sent clean_ota_cache to %s (mower will reboot)\r\n", mowerSn.c_str());
}
