/**
 * touch.h — CST816D capacitive touch driver for Waveshare ESP32-S3 Touch LCD 2"
 *
 * With LVGL: touch is handled by the LVGL input driver callback in display.cpp.
 * This header is kept for backwards compatibility with non-LCD builds.
 * The init and read functions are no longer needed — LVGL handles everything.
 */

#pragma once

#include <Arduino.h>

// Legacy API — kept for non-LCD builds only
void touch_init();
bool touch_available();
bool touch_read(int16_t &x, int16_t &y);
