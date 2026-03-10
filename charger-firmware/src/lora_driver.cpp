#include "lora_driver.h"
#include "config.h"

void loraInit() {
    // Configure M0/M1 pins
    pinMode(LORA_M0_PIN, OUTPUT);
    pinMode(LORA_M1_PIN, OUTPUT);

    // Start in normal/transparent mode
    loraSetMode(0);

    // Initialize UART1 for LoRa
    LORA_SERIAL.begin(LORA_BAUD, SERIAL_8N1, LORA_RX_PIN, LORA_TX_PIN);

    Serial.println("[LoRa] Initialized UART1");
}

void loraSetMode(uint8_t mode) {
    switch (mode) {
        case 0: // Normal/transparent
            digitalWrite(LORA_M0_PIN, LOW);
            digitalWrite(LORA_M1_PIN, LOW);
            break;
        case 3: // Configuration
            digitalWrite(LORA_M0_PIN, HIGH);
            digitalWrite(LORA_M1_PIN, HIGH);
            break;
        default:
            return;
    }
    delay(50); // Allow module to switch modes
}

void loraSendRaw(const uint8_t* data, size_t len) {
    LORA_SERIAL.write(data, len);
    LORA_SERIAL.flush();
}

size_t loraReadRaw(uint8_t* buf, size_t maxLen, uint32_t timeoutMs) {
    uint32_t start = millis();
    size_t idx = 0;

    while (idx < maxLen && (millis() - start) < timeoutMs) {
        if (LORA_SERIAL.available()) {
            buf[idx++] = LORA_SERIAL.read();
        } else {
            delay(1);
        }
    }
    return idx;
}

int loraQueryRssi() {
    const uint8_t query[] = {0xC0, 0xC1, 0xC2, 0xC3, 0x00, 0x01};

    // Switch to config mode
    loraSetMode(3);
    delay(100);

    // Flush any pending data
    while (LORA_SERIAL.available()) LORA_SERIAL.read();

    // Send RSSI query
    loraSendRaw(query, sizeof(query));

    // Read response: [0xC1, 0x00, 0x01, <RSSI>]
    uint8_t resp[4];
    size_t len = loraReadRaw(resp, sizeof(resp), 500);

    // Back to normal mode
    loraSetMode(0);

    if (len >= 4 && resp[0] == 0xC1) {
        return resp[3];
    }
    return -1;
}

bool loraSetChannel(uint8_t channel) {
    // EBYTE E32/E22 channel configuration via register write
    // Register format varies by model — this is a simplified version
    // The actual implementation needs the module's specific register map
    loraSetMode(3);
    delay(100);

    // E32 config: [0xC0, ADDH, ADDL, SPEED, CHAN, OPTION]
    // For now, only channel byte is changed
    // Full implementation needs to read current config first
    uint8_t cmd[] = {0xC0, 0x00, 0x03, 0x1A, channel, 0x17};
    loraSendRaw(cmd, sizeof(cmd));
    delay(200);

    loraSetMode(0);
    return true;
}
