#pragma once

/**
 * config.h — Configuration constants, global variable declarations, enums,
 *            and the web log facility shared across all modules.
 */

#include <Arduino.h>
#include <NimBLEDevice.h>
#include "display.h"

// ── WiFi AP settings ────────────────────────────────────────────────────────

extern const char* AP_SSID;
extern const char* AP_PASSWORD;

// ── MQTT settings ───────────────────────────────────────────────────────────

extern const char* MQTT_HOST;
extern const int   MQTT_PORT;

// ── BLE provisioning — WiFi credentials to send to devices ──────────────────

extern String userWifiSsid;
extern String userWifiPassword;

// ── LoRa defaults (same as official app — NEVER change) ─────────────────────

extern const int LORA_ADDR;
extern const int LORA_CHANNEL_CHARGER;  // Charger = channel 16
extern const int LORA_CHANNEL_MOWER;    // Mower = channel 15
extern const int LORA_HC;
extern const int LORA_LC;

// ── Hardware pins ───────────────────────────────────────────────────────────

#ifdef WAVESHARE_LCD
static const int SD_CS_PIN = SD_CS;  // GPIO38
#else
static const int LED_PIN   = 2;      // Built-in LED (non-LCD builds)
static const int SD_CS_PIN = 5;      // SD card chip select
static const int BUTTON_PIN = 0;     // Boot button
#endif

// ── AES encryption ──────────────────────────────────────────────────────────

extern const uint8_t AES_IV[17];

// ── Version string ──────────────────────────────────────────────────────────

extern const char* VERSION;

// ── Linear wizard states ────────────────────────────────────────────────────

enum State {
    WIZ_BOOT,                   // Hardware init, start AP + DNS + MQTT + HTTP
    WIZ_SCAN_CHARGER,           // BLE scan for CHARGER_PILE
    WIZ_SELECT_CHARGER,         // Select charger from list (if multiple)
    WIZ_PROVISION_CHARGER,      // Provision charger with AP wifi + mqtt
    WIZ_WAIT_CHARGER,           // Wait for charger MQTT connect
    WIZ_CHARGER_CONNECTED,      // Charger connected — confirm before mower scan
    WIZ_SCAN_MOWER,             // BLE scan for NOVABOT
    WIZ_SELECT_MOWER,           // Select mower from list (if multiple)
    WIZ_PROVISION_MOWER,        // Provision mower with AP wifi + mqtt.lfibot.com
    WIZ_WAIT_MOWER,             // Wait for mower MQTT connect
    WIZ_OTA_CONFIRM,            // Confirm before flashing firmware
    WIZ_OTA_FLASH,              // Flash mower firmware (if .deb on SD)
    WIZ_REPROVISION,            // Re-provision both to home WiFi (if configured)
    WIZ_DONE,                   // All done!
    WIZ_ERROR,                  // Error — tap to retry current step
};

// ── State machine globals ───────────────────────────────────────────────────

extern State currentState;
extern bool sdMounted;
extern String statusMessage;
extern bool stateJustEntered;
extern unsigned long stateEnteredAt;
extern int wizStep;
extern const int WIZ_TOTAL_STEPS;
extern bool reprovisioning;

// ── Scan results ────────────────────────────────────────────────────────────

extern ScanResult scanResults[10];
extern int scanResultCount;
extern int selectedChargerIdx;
extern int selectedMowerIdx;

// ── WiFi scan results ───────────────────────────────────────────────────────

extern WifiNetwork wifiNetworks[16];
extern int wifiNetworkCount;
extern bool wifiScanInProgress;

// ── MQTT broker state ───────────────────────────────────────────────────────

extern bool mowerConnected;
extern bool chargerMqttConnected;
extern bool mowerCharging;          // true if battery_state == "CHARGING"
extern String mowerSn;
extern String chargerSn;
extern String chargerTopic;
extern unsigned long mowerConnectTime;

// ── OTA progress ────────────────────────────────────────────────────────────

extern int otaProgressPercent;
extern String otaStatus;

// ── OTA retry state ─────────────────────────────────────────────────────────

extern bool mowerOtaTriedPlain;
extern bool mowerOtaTriedAes;
extern unsigned long mowerOtaSentAt;

// ── BLE state ───────────────────────────────────────────────────────────────

extern NimBLEAdvertisedDevice* chargerDevice;
extern NimBLEAdvertisedDevice* mowerDevice;
extern bool bleScanning;

// ── WiFi-detected devices (by MAC prefix, before BLE scan) ──────────────────
extern bool chargerWifiDetected;
extern bool mowerWifiDetected;

// ── Firmware info (from SD card) ────────────────────────────────────────────

extern String mowerFwFilename;
extern size_t mowerFwSize;
extern String mowerFwMd5;
extern String mowerFwVersion;
extern String chargerFwFilename;
extern size_t chargerFwSize;
extern String chargerFwMd5;
extern String chargerFwVersion;
// Legacy aliases
extern String& firmwareFilename;
extern size_t& firmwareSize;
extern String& firmwareMd5;
extern String& firmwareVersion;

// ── Provision progress callback ─────────────────────────────────────────────

typedef void (*ProvisionProgressCb)(const char* device, int step, int total, const char* stepName);
extern ProvisionProgressCb provisionProgressCb;

// ── Web console log ring buffer ─────────────────────────────────────────────

#define WEB_LOG_SIZE 50
#define WEB_LOG_LINE 120
extern char webLog[WEB_LOG_SIZE][WEB_LOG_LINE];
extern int webLogHead;
extern int webLogCount;

void webLogAdd(const char* fmt, ...) __attribute__((format(printf, 1, 2)));

// ── Forward declarations for non-LCD LED helpers ────────────────────────────

#ifndef WAVESHARE_LCD
void setLed(bool on);
void blinkLed(int times, int delayMs);
#endif
