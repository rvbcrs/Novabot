#include "lora_commands.h"
#include "config.h"
#include "nvs_storage.h"
#include <string.h>

// ── Shared Global State (defined here, declared extern in header) ────────────

volatile int loraAckResult  = 0;     // 0=pending, 1=success, 0x101=error
volatile int loraRssiValue  = 0;     // Last RSSI from LoRa module
MowerStatus  mowerStatus    = {};    // Current mower status from LoRa heartbeat

// ── Little-endian helpers ───────────────────────────────────────────────────

static uint32_t readUint32LE(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint32_t readUint24LE(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16);
}

static uint16_t readUint16LE(const uint8_t* p) {
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

// ── Heartbeat Poll ─────────────────────────────────────────────────────────

size_t loraBuildHeartbeatPoll(uint8_t* buf, size_t bufSize) {
    if (bufSize < 2) return 0;
    buf[0] = LORA_CAT_REPORT;  // 0x34
    buf[1] = 0x01;             // Poll sub-command
    return 2;
}

// ── Status Report Parser ────────────────────────────────────────────────────
// Parses mower status from LoRa heartbeat response [0x34, 0x02, <19 bytes>]

bool loraParseStatusReport(const uint8_t* payload, size_t payloadLen, MowerStatus& status) {
    if (payloadLen < 21) return false;
    if (payload[0] != LORA_CAT_REPORT || payload[1] != 0x02) return false;

    const uint8_t* data = payload + 2;

    status.mowerStatus = readUint32LE(data);       // bytes 0-3
    status.mowerInfo   = readUint32LE(data + 4);   // bytes 4-7
    status.mowerX      = readUint24LE(data + 8);   // bytes 8-10
    status.mowerY      = readUint24LE(data + 11);  // bytes 11-13
    status.mowerZ      = readUint24LE(data + 14);  // bytes 14-16
    status.mowerInfo1  = readUint16LE(data + 17);  // bytes 17-18
    status.mowerError  = 0;  // Reset heartbeat miss counter on successful report
    status.dataValid   = true;

    return true;
}

// ── ORDER Command Builder — matches Ghidra lora_config_task queue 0x20-0x25 ─
// Builds LoRa payload from LoraQueueCmd, returns payload length.
// start_run: [0x35, 0x01, mapName, area(lo), cutterhigh] (5 bytes)
// others:    [0x35, <sub>] (2 bytes)

size_t loraBuildOrderCommand(uint8_t* buf, size_t bufSize, const LoraQueueCmd& cmd) {
    if (bufSize < 5) return 0;

    buf[0] = LORA_CAT_ORDER;  // 0x35

    switch (cmd.queueId) {
        case LORA_Q_START_RUN:
            buf[1] = LORA_ORDER_START;              // 0x01
            buf[2] = cmd.mapName;
            buf[3] = (uint8_t)(cmd.area & 0xFF);   // area truncated to uint8 (Ghidra: cast to char)
            buf[4] = cmd.cutterhigh;
            return 5;

        case LORA_Q_PAUSE_RUN:
            buf[1] = LORA_ORDER_PAUSE;              // 0x03
            return 2;

        case LORA_Q_RESUME_RUN:
            buf[1] = LORA_ORDER_RESUME;             // 0x05
            return 2;

        case LORA_Q_STOP_RUN:
            buf[1] = LORA_ORDER_STOP;               // 0x07
            return 2;

        case LORA_Q_STOP_TIME_RUN:
            buf[1] = LORA_ORDER_STOP_TIME;          // 0x09
            return 2;

        case LORA_Q_GO_PILE:
            buf[1] = LORA_ORDER_GO_PILE;            // 0x0B
            return 2;

        default:
            return 0;
    }
}

// ── RTK NMEA Relay ──────────────────────────────────────────────────────────
// [0x31, NMEA_data...]

size_t loraBuildRtkRelay(uint8_t* buf, size_t bufSize, const char* nmea, size_t nmeaLen) {
    if (nmeaLen + 1 > bufSize || nmeaLen + 1 > LORA_MAX_PAYLOAD) return 0;

    buf[0] = LORA_CAT_RTK_RELAY;  // 0x31
    memcpy(buf + 1, nmea, nmeaLen);
    return nmeaLen + 1;
}

// ── GPS Position ────────────────────────────────────────────────────────────
// [0x33, lat(8B double LE), lon(8B double LE)] = 17 bytes

size_t loraBuildGpsPosition(uint8_t* buf, size_t bufSize, double lat, double lon) {
    if (bufSize < 17) return 0;

    buf[0] = LORA_CAT_GPS;  // 0x33
    memcpy(buf + 1, &lat, 8);  // ESP32 is little-endian
    memcpy(buf + 9, &lon, 8);
    return 17;
}

// ── CONFIG Packets — relay settings to mower via LoRa 0x32 ─────────────────
// These send the charger's stored WiFi/MQTT/LoRa config to the mower
// so it can connect to the same network after BLE provisioning.
// Called from main.cpp before restart when set_cfg_info=1.

size_t loraBuildConfigWifi(uint8_t* buf, size_t bufSize) {
    // [0x32, 0x01, ssid(32B), password(64B)] = 98 bytes
    if (bufSize < 98) return 0;

    WifiConfig wifi;
    if (!nvsReadWifi(wifi)) return 0;

    buf[0] = LORA_CAT_CONFIG;       // 0x32
    buf[1] = LORA_CONFIG_WIFI;      // 0x01
    memset(buf + 2, 0, 96);
    memcpy(buf + 2, wifi.ssid, strlen(wifi.ssid));
    memcpy(buf + 2 + 32, wifi.password, strlen(wifi.password));
    return 98;
}

size_t loraBuildConfigMqtt(uint8_t* buf, size_t bufSize) {
    // [0x32, 0x02, host(30B), port(2B LE)] = 34 bytes
    if (bufSize < 34) return 0;

    MqttConfig mqttCfg;
    if (!nvsReadMqtt(mqttCfg)) return 0;

    buf[0] = LORA_CAT_CONFIG;       // 0x32
    buf[1] = LORA_CONFIG_MQTT;      // 0x02
    memset(buf + 2, 0, 32);
    memcpy(buf + 2, mqttCfg.host, strlen(mqttCfg.host));
    buf[32] = mqttCfg.port & 0xFF;
    buf[33] = (mqttCfg.port >> 8) & 0xFF;
    return 34;
}

size_t loraBuildConfigLora(uint8_t* buf, size_t bufSize) {
    // [0x32, 0x03, addrHi, addrLo, channel] = 5 bytes
    if (bufSize < 5) return 0;

    LoraConfig loraCfg;
    if (!nvsReadLora(loraCfg)) return 0;

    buf[0] = LORA_CAT_CONFIG;       // 0x32
    buf[1] = LORA_CONFIG_LORA;      // 0x03
    buf[2] = loraCfg.addrHi;
    buf[3] = loraCfg.addrLo;
    buf[4] = loraCfg.channel;
    return 5;
}

// ── Hall/IRQ ACK Packets ────────────────────────────────────────────────────
// From Ghidra: queue 0x05 → [0x30, 0x01, 0x01], queue 0x06 → [0x30, 0x04]

size_t loraBuildHallAck(uint8_t* buf, size_t bufSize) {
    // [0x30, 0x01, 0x01] — 3 bytes (matches Ghidra queue cmd 0x05)
    if (bufSize < 3) return 0;
    buf[0] = LORA_CAT_CHARGER;        // 0x30
    buf[1] = LORA_CHARGER_HALL_SUB;   // 0x01
    buf[2] = 0x01;                     // Enable/active
    return 3;
}

size_t loraBuildIrqAck(uint8_t* buf, size_t bufSize) {
    // [0x30, 0x04] — 2 bytes (matches Ghidra queue cmd 0x06)
    if (bufSize < 2) return 0;
    buf[0] = LORA_CAT_CHARGER;        // 0x30
    buf[1] = LORA_CHARGER_IRQ_SUB;    // 0x04
    return 2;
}
