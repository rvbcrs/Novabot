/**
 * display.h — LVGL 8.4 display driver for JC3248W535EN
 *
 * AXS15231B, 320x480 QSPI, I2C touch, 8MB PSRAM.
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
extern volatile bool ui_mqttAddrReady;
extern char ui_mqttAddr[64];

#ifdef HAS_DISPLAY

// ── Thread safety — all lv_* calls from outside LVGL task must use these ────

bool lvgl_lock(int timeout_ms = -1);
void lvgl_unlock(void);

// ── Public API ──────────────────────────────────────────────────────────────

void display_init();
void display_run();   // Start LVGL FreeRTOS task — call AFTER SD init
void display_boot(const char* version);
void display_boot_status(const char* status);
void display_scanning();
void display_devices(ScanResult* results, int count, int selectedCharger, int selectedMower);
void display_provision(const char* device, int step, int total, const char* stepName);
void display_mqttWait(bool chargerConnected, bool mowerConnected);
void display_ota(const char* status);
void display_done();
void display_error(const char* msg);
void display_confirm(const char* title, const char* line1, const char* line2, const char* btnText);
void display_deviceStatus(int chargerStatus, const char* chargerSn,
                          int mowerStatus, const char* mowerSn,
                          const char* mowerVersion, bool canContinue);
void display_wifiList(WifiNetwork* networks, int count, int selected);
void display_wifiPassword(const char* ssid);
void display_textEntry(const char* title, const char* subtitle,
                       const char* placeholder, const char* btnText);
void display_mqttAddr();
void display_reprovision(const char* status, int step, int total);
void display_firmware_flash(const char* device, const char* status, int progress);

#else

// ── Headless stubs — no display, wizard controlled via web UI ───────────────

inline void display_init() {}
inline void display_run() {}
inline void display_boot(const char*) {}
inline void display_boot_status(const char*) {}
inline void display_scanning() {}
inline void display_devices(ScanResult*, int, int, int) {}
inline void display_provision(const char*, int, int, const char*) {}
inline void display_mqttWait(bool, bool) {}
inline void display_ota(const char*) {}
inline void display_done() {}
inline void display_error(const char*) {}
inline void display_confirm(const char*, const char*, const char*, const char*) {}
inline void display_deviceStatus(int, const char*, int, const char*, const char*, bool) {}
inline void display_wifiList(WifiNetwork*, int, int) {}
inline void display_wifiPassword(const char*) {}
inline void display_textEntry(const char*, const char*, const char*, const char*) {}
inline void display_mqttAddr() {}
inline void display_reprovision(const char*, int, int) {}
inline void display_firmware_flash(const char*, const char*, int) {}
inline bool lvgl_lock(int = -1) { return true; }
inline void lvgl_unlock() {}

#endif
