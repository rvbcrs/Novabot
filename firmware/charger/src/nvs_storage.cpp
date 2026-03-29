#include "nvs_storage.h"
#include "config.h"
#include <nvs_flash.h>
#include <nvs.h>

// ── Init ────────────────────────────────────────────────────────────────────

bool nvsInit() {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        // NVS partition was truncated — erase and retry
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    if (err != ESP_OK) return false;

    // Also init the factory partition (separate NVS partition "fctry")
    err = nvs_flash_init_partition("fctry");
    if (err != ESP_OK && err != ESP_ERR_NVS_NO_FREE_PAGES) {
        Serial.printf("[NVS] fctry partition init failed: %s\n", esp_err_to_name(err));
    }
    return true;
}

// ── Serial Number (factory partition) ───────────────────────────────────────

bool nvsReadSN(char* snBuf, size_t bufSize) {
    nvs_handle_t handle;
    esp_err_t err = nvs_open_from_partition("fctry", NVS_NS_FACTORY, NVS_READONLY, &handle);
    if (err != ESP_OK) {
        Serial.printf("[NVS] Failed to open fctry: %s\n", esp_err_to_name(err));
        return false;
    }

    size_t len = bufSize;
    err = nvs_get_str(handle, NVS_KEY_SN, snBuf, &len);
    nvs_close(handle);

    if (err != ESP_OK) {
        Serial.printf("[NVS] Failed to read SN: %s\n", esp_err_to_name(err));
        return false;
    }
    return true;
}

// ── Helper: read/write blob ─────────────────────────────────────────────────

static bool readBlob(const char* key, void* buf, size_t expectedSize) {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NS_STORAGE, NVS_READONLY, &handle);
    if (err != ESP_OK) return false;

    size_t len = expectedSize;
    err = nvs_get_blob(handle, key, buf, &len);
    nvs_close(handle);
    return err == ESP_OK;
}

static bool writeBlob(const char* key, const void* buf, size_t size) {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NS_STORAGE, NVS_READWRITE, &handle);
    if (err != ESP_OK) return false;

    err = nvs_set_blob(handle, key, buf, size);
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    return err == ESP_OK;
}

// ── WiFi STA ────────────────────────────────────────────────────────────────

bool nvsReadWifi(WifiConfig& cfg) {
    uint8_t blob[NVS_WIFI_SIZE] = {0};
    if (!readBlob(NVS_KEY_WIFI, blob, NVS_WIFI_SIZE)) return false;

    memset(&cfg, 0, sizeof(cfg));
    memcpy(cfg.ssid, blob, 32);
    cfg.ssid[32] = '\0';
    memcpy(cfg.password, blob + 32, 64);
    cfg.password[64] = '\0';
    return true;
}

bool nvsWriteWifi(const WifiConfig& cfg) {
    uint8_t blob[NVS_WIFI_SIZE] = {0};
    strncpy((char*)blob, cfg.ssid, 32);
    strncpy((char*)(blob + 32), cfg.password, 64);
    return writeBlob(NVS_KEY_WIFI, blob, NVS_WIFI_SIZE);
}

// ── WiFi AP ─────────────────────────────────────────────────────────────────

bool nvsReadWifiAp(WifiApConfig& cfg) {
    uint8_t blob[NVS_WIFI_AP_SIZE] = {0};
    if (!readBlob(NVS_KEY_WIFI_AP, blob, NVS_WIFI_AP_SIZE)) return false;

    memset(&cfg, 0, sizeof(cfg));
    memcpy(cfg.ssid, blob, 32);
    cfg.ssid[32] = '\0';
    memcpy(cfg.password, blob + 32, 64);
    cfg.password[64] = '\0';
    return true;
}

bool nvsWriteWifiAp(const WifiApConfig& cfg) {
    uint8_t blob[NVS_WIFI_AP_SIZE] = {0};
    strncpy((char*)blob, cfg.ssid, 32);
    strncpy((char*)(blob + 32), cfg.password, 64);
    return writeBlob(NVS_KEY_WIFI_AP, blob, NVS_WIFI_AP_SIZE);
}

// ── MQTT ────────────────────────────────────────────────────────────────────

bool nvsReadMqtt(MqttConfig& cfg) {
    uint8_t blob[NVS_MQTT_SIZE] = {0};
    if (!readBlob(NVS_KEY_MQTT, blob, NVS_MQTT_SIZE)) return false;

    memset(&cfg, 0, sizeof(cfg));
    memcpy(cfg.host, blob, 30);
    cfg.host[30] = '\0';
    // Port is stored as uint16 at offset 0x1E (30)
    cfg.port = blob[30] | (blob[31] << 8);
    if (cfg.port == 0) cfg.port = MQTT_DEFAULT_PORT;
    return true;
}

bool nvsWriteMqtt(const MqttConfig& cfg) {
    uint8_t blob[NVS_MQTT_SIZE] = {0};
    strncpy((char*)blob, cfg.host, 30);
    blob[30] = cfg.port & 0xFF;
    blob[31] = (cfg.port >> 8) & 0xFF;
    return writeBlob(NVS_KEY_MQTT, blob, NVS_MQTT_SIZE);
}

// ── LoRa ────────────────────────────────────────────────────────────────────

bool nvsReadLora(LoraConfig& cfg) {
    uint8_t blob[NVS_LORA_SIZE] = {0};
    if (!readBlob(NVS_KEY_LORA, blob, NVS_LORA_SIZE)) return false;

    cfg.addrHi = blob[0];
    cfg.addrLo = blob[1];
    cfg.channel = blob[2];
    return true;
}

bool nvsWriteLora(const LoraConfig& cfg) {
    uint8_t blob[NVS_LORA_SIZE] = {0};
    blob[0] = cfg.addrHi;
    blob[1] = cfg.addrLo;
    blob[2] = cfg.channel;
    blob[3] = 0x00;
    return writeBlob(NVS_KEY_LORA, blob, NVS_LORA_SIZE);
}

// ── LoRa HC/LC ──────────────────────────────────────────────────────────────

bool nvsReadLoraHcLc(LoraHcLc& cfg) {
    uint8_t blob[NVS_LORA_HCLC_SIZE] = {0};
    if (!readBlob(NVS_KEY_LORA_HCLC, blob, NVS_LORA_HCLC_SIZE)) return false;

    cfg.hc = blob[0];
    cfg.lc = blob[1];
    return true;
}

bool nvsWriteLoraHcLc(const LoraHcLc& cfg) {
    uint8_t blob[NVS_LORA_HCLC_SIZE];
    blob[0] = cfg.hc;
    blob[1] = cfg.lc;
    return writeBlob(NVS_KEY_LORA_HCLC, blob, NVS_LORA_HCLC_SIZE);
}

// ── RTK ─────────────────────────────────────────────────────────────────────

bool nvsReadRtk(RtkConfig& cfg) {
    return readBlob(NVS_KEY_RTK, cfg.data, NVS_RTK_SIZE);
}

bool nvsWriteRtk(const RtkConfig& cfg) {
    return writeBlob(NVS_KEY_RTK, cfg.data, NVS_RTK_SIZE);
}

// ── Config Flag ─────────────────────────────────────────────────────────────

bool nvsReadCfgFlag(uint8_t& flag) {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NS_STORAGE, NVS_READONLY, &handle);
    if (err != ESP_OK) return false;

    err = nvs_get_u8(handle, NVS_KEY_CFG_FLAG, &flag);
    nvs_close(handle);
    return err == ESP_OK;
}

bool nvsWriteCfgFlag(uint8_t flag) {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NS_STORAGE, NVS_READWRITE, &handle);
    if (err != ESP_OK) return false;

    err = nvs_set_u8(handle, NVS_KEY_CFG_FLAG, flag);
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    return err == ESP_OK;
}
