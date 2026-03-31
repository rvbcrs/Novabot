/**
 * display.h — LVGL 8.4 display driver for Waveshare ESP32-S3 Touch LCD 2"
 *
 * ST7789, 240x320, SPI, CST816D touch.
 * Dark theme with purple/teal accents using LVGL widgets.
 */

#pragma once

#include <Arduino.h>

// WiFi scan result — shared between main.cpp and display.cpp
struct WifiNetwork {
    String ssid;
    int rssi;
    bool isOpen;  // no password needed
};

// Scan result — shared between main.cpp and display.cpp
struct ScanResult {
    String name;
    String mac;
    int rssi;
    bool isCharger;   // name == "CHARGER_PILE"
    bool isMower;     // name contains "novabot" or "Novabot"
};

// ── UI state flags (set by LVGL event callbacks, read by main.cpp) ──────────

extern volatile int ui_selectedChargerIdx;
extern volatile int ui_selectedMowerIdx;
extern volatile bool ui_startPressed;
extern volatile bool ui_btnPressed;       // Generic button press (confirm screens, done, error)
extern volatile bool ui_rescanPressed;

// Phase 2: WiFi re-provisioning UI flags
extern volatile int  ui_selectedWifiIdx;
extern volatile bool ui_wifiPasswordReady;
extern volatile bool ui_wifiRescanPressed;
extern char ui_wifiPassword[64];
extern char ui_wifiSsid[33];

// ── Thread safety — all lv_* calls from outside LVGL task must use these ────

bool lvgl_lock(int timeout_ms = -1);
void lvgl_unlock(void);

// ── Public API ──────────────────────────────────────────────────────────────

void display_init();
void display_boot(const char* version);
void display_scanning();
void display_devices(ScanResult* results, int count, int selectedCharger, int selectedMower);
void display_provision(const char* device, int step, int total, const char* stepName);
void display_mqttWait(bool chargerConnected, bool mowerConnected);
void display_ota(const char* status);
void display_done();
void display_error(const char* msg);
void display_confirm(const char* title, const char* line1, const char* line2, const char* btnText);

// Phase 2: WiFi re-provisioning screens
void display_wifiList(WifiNetwork* networks, int count, int selected);
void display_wifiPassword(const char* ssid);
void display_reprovision(const char* status, int step, int total);

// Phase 3: Menu + firmware flash screens
extern volatile int ui_menuSelection;     // -1 = no selection, 0+ = menu item
extern volatile bool ui_flashConfirmed;
extern volatile bool ui_flashSkipped;
extern volatile bool ui_backPressed;

void display_detect(int secondsElapsed, int apClients, bool chargerConn, bool mowerConn);
void display_menu(bool sdMounted, bool hasMowerFw, bool hasChargerFw,
                  const char* mowerVer, const char* chargerVer,
                  bool mowerConn, bool chargerConn);
void display_firmware_check(bool hasMowerFw, bool hasChargerFw,
                            const char* mowerVer, const char* chargerVer,
                            bool mowerConn, bool chargerConn);
void display_firmware_flash(const char* device, const char* status, int progress);

// Legacy hit-test API — kept as no-ops for compatibility, LVGL handles touch natively
bool display_btnHit(int16_t x, int16_t y);
int display_hitTest(int16_t x, int16_t y, int deviceCount, bool& startBtnHit);
