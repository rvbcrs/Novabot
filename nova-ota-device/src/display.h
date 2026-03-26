/**
 * display.h — LovyanGFX driver for Waveshare ESP32-S3 Touch LCD 2"
 *
 * ST7789T3, 240x320, SPI, with PWM backlight.
 * Dark theme with purple/teal accents.
 */

#pragma once

#include <Arduino.h>

// Scan result — shared between main.cpp and display.cpp
struct ScanResult {
    String name;
    String mac;
    int rssi;
    bool isCharger;   // name == "CHARGER_PILE"
    bool isMower;     // name contains "novabot" or "Novabot"
};

// ── Theme colors (RGB565) ───────────────────────────────────────────────────

#define COL_BG        0x0000  // Black
#define COL_TEXT      0xFFFF  // White
#define COL_DIM       0x7BEF  // Gray
#define COL_PURPLE    0x781F  // Purple accent (#8000FF approx)
#define COL_TEAL      0x07F0  // Teal accent
#define COL_GREEN     0x07E0  // Bright green
#define COL_RED       0xF800  // Red
#define COL_ORANGE    0xFD20  // Orange
#define COL_DARK_GRAY 0x2104  // Dark gray for list items
#define COL_SELECTED  0x03E0  // Dark green for selected items
#define COL_BTN       0x781F  // Purple button

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
bool display_btnHit(int16_t x, int16_t y);  // Check if bottom button was tapped

// ── Hit detection helpers ───────────────────────────────────────────────────

// Returns device index tapped in the list, or -1 if none.
// startBtnHit is set to true if the "Start" button was tapped.
int display_hitTest(int16_t x, int16_t y, int deviceCount, bool& startBtnHit);
