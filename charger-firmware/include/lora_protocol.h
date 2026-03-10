#pragma once
#include <Arduino.h>

// Maximum LoRa payload size
#define LORA_MAX_PAYLOAD 128

// Build a LoRa packet with framing: [0x02 0x02][addr][len+1][payload][XOR][0x03 0x03]
// Returns total packet length, or 0 on error.
size_t loraBuildPacket(uint8_t* packetBuf, size_t packetBufSize,
                       uint8_t addrHi, uint8_t addrLo,
                       const uint8_t* payload, size_t payloadLen);

// Parse a received LoRa packet. Validates start/end markers and XOR checksum.
// On success: copies payload into payloadBuf, returns payload length.
// On failure: returns 0.
size_t loraParsePacket(const uint8_t* raw, size_t rawLen,
                       uint8_t* payloadBuf, size_t payloadBufSize);

// Calculate XOR checksum over a byte array
uint8_t loraXorChecksum(const uint8_t* data, size_t len);
