/**
 * touch.h — CST816D capacitive touch driver for Waveshare ESP32-S3 Touch LCD 2"
 *
 * Raw I2C communication, interrupt-driven touch detection.
 * I2C address: 0x15
 */

#pragma once

#include <Arduino.h>

void touch_init();
bool touch_available();
bool touch_read(int16_t &x, int16_t &y);
