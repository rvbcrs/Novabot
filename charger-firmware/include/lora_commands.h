#pragma once
#include <Arduino.h>
#include "config.h"

// ── LoRa Queue Command (MQTT/BLE → LoRa task) ───────────────────────────────
// Matches original firmware stack layout for xQueueSend
struct LoraQueueCmd {
    uint8_t  queueId;       // LORA_Q_xxx
    uint8_t  mapName;       // start_run: mapName param
    uint16_t area;          // start_run: area param
    uint8_t  reserved[2];
    uint8_t  cutterhigh;    // start_run: cutter height
    uint8_t  pad;
};

// ── Mower Status (parsed from LoRa heartbeat 0x34/0x02) ─────────────────────
struct MowerStatus {
    uint32_t mowerStatus;   // Operating state bitfield
    uint32_t mowerInfo;     // Additional info
    uint32_t mowerX;        // Position X (uint24)
    uint32_t mowerY;        // Position Y (uint24)
    uint32_t mowerZ;        // Position Z / heading (uint24)
    uint16_t mowerInfo1;    // Extra info
    uint32_t mowerError;    // Heartbeat miss counter
    bool     dataValid;     // Has received at least one report
};

// ── Shared Global State (MQTT handler ↔ LoRa task) ──────────────────────────
extern volatile int     loraAckResult;      // 0=pending, 1=success, 0x101=error
extern volatile int     loraRssiValue;      // Last RSSI from module (raw byte)
extern MowerStatus      mowerStatus;        // Current mower status from LoRa

// ── LoRa Packet Building ────────────────────────────────────────────────────

// Build heartbeat poll: [0x34, 0x01]
size_t loraBuildHeartbeatPoll(uint8_t* buf, size_t bufSize);

// Parse mower status report: [0x34, 0x02, <19 bytes>]
bool loraParseStatusReport(const uint8_t* payload, size_t payloadLen, MowerStatus& status);

// Build ORDER command payload from queue item
size_t loraBuildOrderCommand(uint8_t* buf, size_t bufSize, const LoraQueueCmd& cmd);

// Build RTK NMEA relay: [0x31, NMEA_data...]
size_t loraBuildRtkRelay(uint8_t* buf, size_t bufSize, const char* nmea, size_t nmeaLen);

// Build GPS position: [0x33, lat(8B LE double), lon(8B LE double)]
size_t loraBuildGpsPosition(uint8_t* buf, size_t bufSize, double lat, double lon);

// Build CONFIG packets (WiFi/MQTT/LoRa settings relay to mower via LoRa 0x32)
size_t loraBuildConfigWifi(uint8_t* buf, size_t bufSize);
size_t loraBuildConfigMqtt(uint8_t* buf, size_t bufSize);
size_t loraBuildConfigLora(uint8_t* buf, size_t bufSize);

// Build Hall ACK: [0x30, 0x02]
size_t loraBuildHallAck(uint8_t* buf, size_t bufSize);

// Build IRQ ACK: [0x30, 0x06]
size_t loraBuildIrqAck(uint8_t* buf, size_t bufSize);
