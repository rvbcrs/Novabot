/**
 * touch.cpp — CST816D capacitive touch driver
 *
 * With LVGL (WAVESHARE_LCD): touch is handled entirely by the LVGL input
 * driver callback in display.cpp. These functions are no-ops.
 *
 * Without WAVESHARE_LCD: stubs that return false.
 */

#include "touch.h"

#ifdef WAVESHARE_LCD

// Touch is now handled by LVGL input driver in display.cpp.
// These are kept as no-ops so main.cpp compiles without changes.
void touch_init() {
    // I2C and touch are initialized in display_init()
}

bool touch_available() {
    return false;  // Not used — LVGL polls touch internally
}

bool touch_read(int16_t &x, int16_t &y) {
    return false;  // Not used — LVGL polls touch internally
}

#else
// ── Stubs for non-LCD builds ────────────────────────────────────────────────

void touch_init() {}
bool touch_available() { return false; }
bool touch_read(int16_t &x, int16_t &y) { return false; }

#endif
