#pragma once
#include <Arduino.h>

// Initialize LoRa UART and mode pins
void loraInit();

// Set LoRa module operating mode via M0/M1 pins
// mode 0: Normal/transparent (M0=LOW, M1=LOW)
// mode 3: Configuration (M0=HIGH, M1=HIGH)
void loraSetMode(uint8_t mode);

// Send raw bytes over LoRa UART
void loraSendRaw(const uint8_t* data, size_t len);

// Read available bytes from LoRa UART into buffer.
// Returns number of bytes read.
size_t loraReadRaw(uint8_t* buf, size_t maxLen, uint32_t timeoutMs = 100);

// Query RSSI from LoRa module.
// Returns RSSI value (0-255) or -1 on failure.
int loraQueryRssi();

// Configure LoRa channel (switches to config mode, sets channel, back to normal)
bool loraSetChannel(uint8_t channel);
