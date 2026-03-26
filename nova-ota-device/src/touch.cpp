/**
 * touch.cpp — CST816D capacitive touch driver
 *
 * I2C address 0x15, registers:
 *   0x02: number of touch points
 *   0x03: X high nibble (bits 3:0)
 *   0x04: X low byte
 *   0x05: Y high nibble (bits 3:0)
 *   0x06: Y low byte
 *
 * Interrupt on GPIO17 (FALLING edge) signals touch event.
 */

#include "touch.h"

#ifdef WAVESHARE_LCD

#include <Wire.h>

static const uint8_t CST816D_ADDR = 0x15;
static volatile bool touchFlag = false;

static void IRAM_ATTR touchISR() {
    touchFlag = true;
}

void touch_init() {
    // Initialize I2C for touch controller
    Wire.begin(TOUCH_SDA, TOUCH_SCL);
    Wire.setClock(400000);  // 400kHz fast mode

    // Hardware reset (if pin defined)
#if TOUCH_RST >= 0
    pinMode(TOUCH_RST, OUTPUT);
    digitalWrite(TOUCH_RST, LOW);
    delay(10);
    digitalWrite(TOUCH_RST, HIGH);
    delay(50);
#endif

    // Interrupt pin (if defined)
#if TOUCH_INT >= 0
    pinMode(TOUCH_INT, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(TOUCH_INT), touchISR, FALLING);
#endif

    Serial.println("[TOUCH] CST816D initialized");
}

bool touch_available() {
#if TOUCH_INT >= 0
    return touchFlag;
#else
    // No interrupt — poll I2C for touch count
    Wire.beginTransmission(CST816D_ADDR);
    Wire.write(0x02);
    if (Wire.endTransmission() != 0) return false;
    Wire.requestFrom(CST816D_ADDR, (uint8_t)1);
    if (Wire.available() < 1) return false;
    return Wire.read() > 0;
#endif
}

bool touch_read(int16_t &x, int16_t &y) {
    touchFlag = false;

    Wire.beginTransmission(CST816D_ADDR);
    Wire.write(0x02);  // Start at touch count register
    if (Wire.endTransmission() != 0) {
        return false;
    }

    Wire.requestFrom(CST816D_ADDR, (uint8_t)5);
    if (Wire.available() < 5) {
        return false;
    }

    uint8_t touchCount = Wire.read();  // 0x02: number of touch points
    uint8_t xHigh = Wire.read();       // 0x03: X[11:8]
    uint8_t xLow  = Wire.read();       // 0x04: X[7:0]
    uint8_t yHigh = Wire.read();       // 0x05: Y[11:8]
    uint8_t yLow  = Wire.read();       // 0x06: Y[7:0]

    if (touchCount == 0) {
        return false;
    }

    x = ((xHigh & 0x0F) << 8) | xLow;
    y = ((yHigh & 0x0F) << 8) | yLow;

    return true;
}

#else
// ── Stubs for non-LCD builds ────────────────────────────────────────────────

void touch_init() {}
bool touch_available() { return false; }
bool touch_read(int16_t &x, int16_t &y) { return false; }

#endif
