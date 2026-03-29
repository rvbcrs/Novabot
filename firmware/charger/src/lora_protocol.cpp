#include "lora_protocol.h"
#include "config.h"

uint8_t loraXorChecksum(const uint8_t* data, size_t len) {
    uint8_t xor_val = 0;
    for (size_t i = 0; i < len; i++) {
        xor_val ^= data[i];
    }
    return xor_val;
}

size_t loraBuildPacket(uint8_t* packetBuf, size_t packetBufSize,
                       uint8_t addrHi, uint8_t addrLo,
                       const uint8_t* payload, size_t payloadLen) {
    // Minimum packet: 2(start) + 2(addr) + 1(len) + payload + 1(checksum) + 2(end)
    size_t totalLen = 2 + 2 + 1 + payloadLen + 1 + 2;
    if (totalLen > packetBufSize || payloadLen > LORA_MAX_PAYLOAD) return 0;

    size_t idx = 0;

    // Start markers
    packetBuf[idx++] = LORA_START_BYTE;
    packetBuf[idx++] = LORA_START_BYTE;

    // Address
    packetBuf[idx++] = addrHi;
    packetBuf[idx++] = addrLo;

    // Length + 1
    packetBuf[idx++] = (uint8_t)(payloadLen + 1);

    // Payload
    memcpy(packetBuf + idx, payload, payloadLen);
    idx += payloadLen;

    // XOR checksum over payload bytes
    packetBuf[idx++] = loraXorChecksum(payload, payloadLen);

    // End markers
    packetBuf[idx++] = LORA_END_BYTE;
    packetBuf[idx++] = LORA_END_BYTE;

    return idx;
}

size_t loraParsePacket(const uint8_t* raw, size_t rawLen,
                       uint8_t* payloadBuf, size_t payloadBufSize) {
    // Minimum: [0x02 0x02] [addr addr] [len] [1 byte payload] [checksum] [0x03 0x03]
    if (rawLen < 8) return 0;

    // Find start markers
    size_t startIdx = 0;
    bool found = false;
    for (size_t i = 0; i + 1 < rawLen; i++) {
        if (raw[i] == LORA_START_BYTE && raw[i + 1] == LORA_START_BYTE) {
            startIdx = i;
            found = true;
            break;
        }
    }
    if (!found) return 0;

    // Parse header
    if (startIdx + 5 > rawLen) return 0;
    // uint8_t addrHi = raw[startIdx + 2];  // Available if needed
    // uint8_t addrLo = raw[startIdx + 3];
    uint8_t lenField = raw[startIdx + 4];

    // lenField = payloadLen + 1 (the +1 includes the checksum byte in the count)
    if (lenField < 2) return 0; // At least 1 payload byte + 1 checksum
    size_t payloadLen = lenField - 1;

    // Check we have enough data
    size_t dataStart = startIdx + 5;
    size_t expectedEnd = dataStart + payloadLen + 1 + 2; // payload + checksum + end markers
    if (expectedEnd > rawLen) return 0;

    // Verify end markers
    if (raw[expectedEnd - 2] != LORA_END_BYTE || raw[expectedEnd - 1] != LORA_END_BYTE) return 0;

    // Verify checksum
    uint8_t receivedChecksum = raw[dataStart + payloadLen];
    uint8_t computedChecksum = loraXorChecksum(raw + dataStart, payloadLen);
    if (receivedChecksum != computedChecksum) {
        Serial.printf("[LoRa] Checksum mismatch: got 0x%02X, expected 0x%02X\n",
                      receivedChecksum, computedChecksum);
        return 0;
    }

    // Copy payload
    if (payloadLen > payloadBufSize) return 0;
    memcpy(payloadBuf, raw + dataStart, payloadLen);
    return payloadLen;
}
