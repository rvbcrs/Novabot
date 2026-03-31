#pragma once

/**
 * mqtt.h — NovaMQTTBroker class, MQTT setup, AES-encrypted message sending,
 *          and OTA command functions.
 */

#include <sMQTTBroker.h>

// ── NovaMQTTBroker class ────────────────────────────────────────────────────

class NovaMQTTBroker : public sMQTTBroker {
public:
    bool onEvent(sMQTTEvent *event) override;
};

extern NovaMQTTBroker mqttBroker;

// ── Public API ──────────────────────────────────────────────────────────────

void setupMQTT();
void sendMqttMessage(String topic, String payload, bool useAes, String sn = "");
void sendMowerOtaWithAes(bool useAes);
void sendMowerOta();
void sendChargerOta();
void sendOtaCommand();
