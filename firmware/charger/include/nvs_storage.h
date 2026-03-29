#pragma once
#include <Arduino.h>

// WiFi STA credentials from NVS
struct WifiConfig {
    char ssid[33];      // 32 + null
    char password[65];  // 64 + null
};

// WiFi AP credentials from NVS
struct WifiApConfig {
    char ssid[33];
    char password[65];
};

// MQTT broker config from NVS
struct MqttConfig {
    char host[31];      // 30 + null
    uint16_t port;
};

// LoRa radio config from NVS
struct LoraConfig {
    uint8_t addrHi;
    uint8_t addrLo;
    uint8_t channel;
};

// LoRa channel scan range
struct LoraHcLc {
    uint8_t hc;
    uint8_t lc;
};

// RTK position data from NVS
struct RtkConfig {
    uint8_t data[40];
};

// Initialize NVS flash
bool nvsInit();

// Read serial number from factory NVS
bool nvsReadSN(char* snBuf, size_t bufSize);

// WiFi STA config
bool nvsReadWifi(WifiConfig& cfg);
bool nvsWriteWifi(const WifiConfig& cfg);

// WiFi AP config
bool nvsReadWifiAp(WifiApConfig& cfg);
bool nvsWriteWifiAp(const WifiApConfig& cfg);

// MQTT config
bool nvsReadMqtt(MqttConfig& cfg);
bool nvsWriteMqtt(const MqttConfig& cfg);

// LoRa config
bool nvsReadLora(LoraConfig& cfg);
bool nvsWriteLora(const LoraConfig& cfg);

// LoRa HC/LC scan range
bool nvsReadLoraHcLc(LoraHcLc& cfg);
bool nvsWriteLoraHcLc(const LoraHcLc& cfg);

// RTK data
bool nvsReadRtk(RtkConfig& cfg);
bool nvsWriteRtk(const RtkConfig& cfg);

// Config committed flag
bool nvsReadCfgFlag(uint8_t& flag);
bool nvsWriteCfgFlag(uint8_t flag);
