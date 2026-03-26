/**
 * display.cpp — LovyanGFX driver for Waveshare ESP32-S3 Touch LCD 2"
 *
 * ST7789T3 240x320, SPI bus. PWM backlight on GPIO6.
 * All drawing is direct (no LVGL), simple and readable.
 */

#include "display.h"

#ifdef WAVESHARE_LCD

#define LGFX_USE_V1
#include <LovyanGFX.hpp>

// ── LovyanGFX configuration ────────────────────────────────────────────────

class LGFX : public lgfx::LGFX_Device {
    lgfx::Panel_ST7789P3 _panel;  // Waveshare-specific driver with proper init
    lgfx::Bus_SPI       _bus;
    lgfx::Light_PWM     _light;

public:
    LGFX() {
        // SPI bus
        {
            auto cfg = _bus.config();
            cfg.spi_host   = SPI2_HOST;
            cfg.spi_mode   = 0;
            cfg.freq_write  = 40000000;
            cfg.freq_read   = 16000000;
            cfg.pin_mosi   = LCD_MOSI;   // 2
            cfg.pin_miso   = LCD_MISO;   // 42
            cfg.pin_sclk   = LCD_SCLK;   // 4
            cfg.pin_dc     = LCD_DC;     // 41
            _bus.config(cfg);
            _panel.setBus(&_bus);
        }

        // Panel
        {
            auto cfg = _panel.config();
            cfg.pin_cs     = LCD_CS;     // 39
            cfg.pin_rst    = LCD_RST;    // 40
            cfg.pin_busy   = -1;
            cfg.panel_width  = 240;
            cfg.panel_height = 320;
            cfg.offset_x     = 0;
            cfg.offset_y     = 0;
            cfg.offset_rotation = 0;
            cfg.invert       = true;     // ST7789T3 needs invert
            cfg.rgb_order    = false;
            cfg.dlen_16bit   = false;
            cfg.bus_shared   = true;     // SD card shares SPI bus
            _panel.config(cfg);
        }

        // Backlight PWM
        {
            auto cfg = _light.config();
            cfg.pin_bl     = LCD_BL;     // 6
            cfg.invert     = false;
            cfg.freq       = 44100;
            cfg.pwm_channel = 7;
            _light.config(cfg);
            _panel.setLight(&_light);
        }

        setPanel(&_panel);
    }
};

static LGFX tft;

// ── Layout constants ────────────────────────────────────────────────────────

static const int SCREEN_W = 240;
static const int SCREEN_H = 320;
static const int LIST_Y_START = 60;   // Y offset for first list item
static const int LIST_ITEM_H = 40;    // Height per device row
static const int BTN_H = 44;          // Start button height
static const int BTN_Y = SCREEN_H - BTN_H - 8;  // Start button Y position
static const int BTN_X = 20;
static const int BTN_W = SCREEN_W - 40;
static const int PROGRESS_BAR_H = 16;

// Keep track of last drawn state to avoid full redraws
static int lastDeviceCount = -1;

// ── Public functions ────────────────────────────────────────────────────────

void display_init() {
    tft.init();
    tft.setRotation(0);  // Portrait: 240 wide x 320 tall
    tft.fillScreen(COL_BG);
    tft.setBrightness(200);
}

void display_boot(const char* version) {
    tft.fillScreen(COL_BG);

    // OpenNova logo text
    tft.setTextDatum(lgfx::middle_center);
    tft.setTextColor(COL_PURPLE);
    tft.setFont(&fonts::Font4);
    tft.drawString("OpenNova", SCREEN_W / 2, SCREEN_H / 2 - 30);

    // Subtitle
    tft.setTextColor(COL_TEAL);
    tft.setFont(&fonts::Font2);
    tft.drawString("Provisioner", SCREEN_W / 2, SCREEN_H / 2 + 10);

    // Version
    tft.setTextColor(COL_DIM);
    tft.setFont(&fonts::Font0);
    tft.drawString(version, SCREEN_W / 2, SCREEN_H / 2 + 40);
}

void display_scanning() {
    // Animated dots — call repeatedly to animate
    static int dotFrame = 0;
    static unsigned long lastDotTime = 0;

    // Only redraw full screen once
    if (dotFrame == 0 && millis() - lastDotTime > 2000) {
        tft.fillScreen(COL_BG);

        tft.setTextDatum(lgfx::middle_center);
        tft.setTextColor(COL_TEXT);
        tft.setFont(&fonts::Font4);
        tft.drawString("Scanning", SCREEN_W / 2, SCREEN_H / 2 - 20);

        // BLE icon hint
        tft.setTextColor(COL_TEAL);
        tft.setFont(&fonts::Font2);
        tft.drawString("Looking for devices...", SCREEN_W / 2, SCREEN_H / 2 + 20);
    }

    // Animate dots at bottom
    if (millis() - lastDotTime > 400) {
        lastDotTime = millis();
        dotFrame = (dotFrame + 1) % 4;

        // Clear dot area
        tft.fillRect(0, SCREEN_H / 2 + 50, SCREEN_W, 20, COL_BG);

        String dots = "";
        for (int i = 0; i < dotFrame; i++) dots += ". ";

        tft.setTextDatum(lgfx::middle_center);
        tft.setTextColor(COL_PURPLE);
        tft.setFont(&fonts::Font4);
        tft.drawString(dots, SCREEN_W / 2, SCREEN_H / 2 + 58);
    }
}

void display_devices(ScanResult* results, int count, int selectedCharger, int selectedMower) {
    tft.fillScreen(COL_BG);

    // Title
    tft.setTextDatum(lgfx::top_center);
    tft.setTextColor(COL_TEXT);
    tft.setFont(&fonts::Font4);
    tft.drawString("Select Devices", SCREEN_W / 2, 6);

    tft.setTextColor(COL_DIM);
    tft.setFont(&fonts::Font2);
    tft.drawString("Tap to select", SCREEN_W / 2, 32);

    // Only show Novabot devices (charger + mower)
    int row = 0;
    for (int i = 0; i < count && row < 4; i++) {
        if (!results[i].isCharger && !results[i].isMower) continue;

        int y = LIST_Y_START + row * LIST_ITEM_H;
        bool isSelected = (i == selectedCharger || i == selectedMower);

        // Background
        uint16_t bgColor = isSelected ? COL_SELECTED : COL_DARK_GRAY;
        tft.fillRoundRect(4, y, SCREEN_W - 8, LIST_ITEM_H - 4, 6, bgColor);

        // Device name — big white bold
        tft.setTextDatum(lgfx::middle_left);
        tft.setTextColor(COL_TEXT);
        tft.setFont(&fonts::Font4);
        const char* label = results[i].isCharger ? "Charger" : "Mower";
        tft.drawString(label, 14, y + LIST_ITEM_H / 2 - 8);

        // BLE name + RSSI
        tft.setTextColor(results[i].isCharger ? COL_ORANGE : COL_TEAL);
        tft.setFont(&fonts::Font2);
        String info = results[i].name + "  " + String(results[i].rssi) + "dB";
        tft.drawString(info.c_str(), 14, y + LIST_ITEM_H / 2 + 12);

        // Selection checkmark
        if (isSelected) {
            tft.setTextColor(COL_GREEN);
            tft.setFont(&fonts::Font4);
            tft.setTextDatum(lgfx::middle_right);
            tft.drawString("v", SCREEN_W - 14, y + LIST_ITEM_H / 2);
        }

        row++;
    }

    if (row == 0) {
        tft.setTextDatum(lgfx::middle_center);
        tft.setTextColor(COL_TEXT);
        tft.setFont(&fonts::Font4);
        tft.drawString("No Novabot", SCREEN_W / 2, SCREEN_H / 2 - 15);
        tft.drawString("devices found", SCREEN_W / 2, SCREEN_H / 2 + 15);
    }

    // Start button
    bool canStart = (selectedCharger >= 0 || selectedMower >= 0);
    uint16_t btnColor = canStart ? COL_PURPLE : COL_DARK_GRAY;
    tft.fillRoundRect(BTN_X, BTN_Y, BTN_W, BTN_H, 8, btnColor);
    tft.setTextDatum(lgfx::middle_center);
    tft.setTextColor(canStart ? COL_TEXT : COL_DIM);
    tft.setFont(&fonts::Font4);
    tft.drawString("Start", BTN_X + BTN_W / 2, BTN_Y + BTN_H / 2);

    lastDeviceCount = count;
}

void display_provision(const char* device, int step, int total, const char* stepName) {
    tft.fillScreen(COL_BG);

    // Device name
    tft.setTextDatum(lgfx::top_center);
    tft.setTextColor(COL_TEAL);
    tft.setFont(&fonts::Font4);
    tft.drawString(device, SCREEN_W / 2, 40);

    // "Provisioning..."
    tft.setTextColor(COL_TEXT);
    tft.setFont(&fonts::Font2);
    tft.drawString("Provisioning...", SCREEN_W / 2, 80);

    // Progress bar background
    int barY = 130;
    int barX = 20;
    int barW = SCREEN_W - 40;
    tft.fillRoundRect(barX, barY, barW, PROGRESS_BAR_H, 4, COL_DARK_GRAY);

    // Progress bar fill
    int fillW = (barW * step) / total;
    if (fillW > 0) {
        tft.fillRoundRect(barX, barY, fillW, PROGRESS_BAR_H, 4, COL_PURPLE);
    }

    // Step counter
    tft.setTextDatum(lgfx::top_center);
    tft.setTextColor(COL_DIM);
    tft.setFont(&fonts::Font2);
    String stepStr = "Step " + String(step) + "/" + String(total);
    tft.drawString(stepStr, SCREEN_W / 2, barY + PROGRESS_BAR_H + 10);

    // Step name
    tft.setTextColor(COL_TEXT);
    tft.setFont(&fonts::Font2);
    tft.drawString(stepName, SCREEN_W / 2, barY + PROGRESS_BAR_H + 35);
}

void display_mqttWait(bool chargerConnected, bool mowerConnected) {
    static unsigned long lastAnim = 0;
    static int animFrame = 0;

    // Full redraw periodically for animation
    if (millis() - lastAnim > 600) {
        lastAnim = millis();
        animFrame = (animFrame + 1) % 4;

        tft.fillScreen(COL_BG);

        tft.setTextDatum(lgfx::top_center);
        tft.setTextColor(COL_TEXT);
        tft.setFont(&fonts::Font4);
        tft.drawString("Waiting", SCREEN_W / 2, 50);

        tft.setTextColor(COL_DIM);
        tft.setFont(&fonts::Font2);
        tft.drawString("for MQTT connection...", SCREEN_W / 2, 90);

        // Status indicators
        int y = 150;

        // Charger status
        uint16_t chgCol = chargerConnected ? COL_GREEN : COL_DIM;
        tft.fillCircle(40, y, 8, chgCol);
        tft.setTextDatum(lgfx::middle_left);
        tft.setTextColor(COL_TEXT);
        tft.setFont(&fonts::Font2);
        tft.drawString("Charger", 58, y);

        // Mower status
        y += 40;
        uint16_t mowCol = mowerConnected ? COL_GREEN : COL_DIM;
        tft.fillCircle(40, y, 8, mowCol);
        tft.setTextDatum(lgfx::middle_left);
        tft.drawString("Mower", 58, y);

        // Animated dots
        String dots = "";
        for (int i = 0; i <= animFrame; i++) dots += ".";
        tft.setTextDatum(lgfx::middle_center);
        tft.setTextColor(COL_PURPLE);
        tft.setFont(&fonts::Font4);
        tft.drawString(dots, SCREEN_W / 2, 260);
    }
}

void display_ota(const char* status) {
    tft.fillScreen(COL_BG);

    tft.setTextDatum(lgfx::top_center);
    tft.setTextColor(COL_ORANGE);
    tft.setFont(&fonts::Font4);
    tft.drawString("OTA Update", SCREEN_W / 2, 60);

    // Firmware icon (simple rectangle)
    tft.drawRoundRect(SCREEN_W / 2 - 30, 110, 60, 40, 4, COL_TEAL);
    tft.setTextDatum(lgfx::middle_center);
    tft.setTextColor(COL_TEAL);
    tft.setFont(&fonts::Font2);
    tft.drawString("FW", SCREEN_W / 2, 130);

    // Status text
    tft.setTextColor(COL_TEXT);
    tft.setFont(&fonts::Font2);

    // Word-wrap status if long
    String statusStr = status;
    if (statusStr.length() > 28) {
        // Split at space nearest to middle
        int mid = statusStr.length() / 2;
        int splitAt = statusStr.indexOf(' ', mid);
        if (splitAt < 0) splitAt = statusStr.lastIndexOf(' ', mid);
        if (splitAt > 0) {
            tft.drawString(statusStr.substring(0, splitAt), SCREEN_W / 2, 180);
            tft.drawString(statusStr.substring(splitAt + 1), SCREEN_W / 2, 200);
        } else {
            tft.drawString(statusStr, SCREEN_W / 2, 180);
        }
    } else {
        tft.drawString(statusStr, SCREEN_W / 2, 180);
    }
}

void display_done() {
    tft.fillScreen(COL_GREEN);

    // Checkmark
    tft.setTextDatum(lgfx::middle_center);
    tft.setTextColor(COL_BG);
    tft.setFont(&fonts::Font4);

    // Draw a simple checkmark with lines
    int cx = SCREEN_W / 2;
    int cy = SCREEN_H / 2 - 40;
    tft.drawLine(cx - 30, cy, cx - 10, cy + 20, COL_BG);
    tft.drawLine(cx - 30, cy + 1, cx - 10, cy + 21, COL_BG);
    tft.drawLine(cx - 30, cy + 2, cx - 10, cy + 22, COL_BG);
    tft.drawLine(cx - 10, cy + 20, cx + 30, cy - 20, COL_BG);
    tft.drawLine(cx - 10, cy + 21, cx + 30, cy - 19, COL_BG);
    tft.drawLine(cx - 10, cy + 22, cx + 30, cy - 18, COL_BG);

    tft.drawString("Done!", cx, SCREEN_H / 2 + 20);

    tft.setFont(&fonts::Font2);
    tft.drawString("Tap to restart", cx, SCREEN_H / 2 + 60);
}

void display_error(const char* msg) {
    tft.fillScreen(COL_RED);

    // X mark
    int cx = SCREEN_W / 2;
    int cy = SCREEN_H / 2 - 50;
    for (int i = -2; i <= 2; i++) {
        tft.drawLine(cx - 25, cy - 25 + i, cx + 25, cy + 25 + i, COL_TEXT);
        tft.drawLine(cx + 25, cy - 25 + i, cx - 25, cy + 25 + i, COL_TEXT);
    }

    tft.setTextDatum(lgfx::middle_center);
    tft.setTextColor(COL_TEXT);
    tft.setFont(&fonts::Font4);
    tft.drawString("Error", cx, SCREEN_H / 2 + 10);

    // Error message (word-wrapped)
    tft.setFont(&fonts::Font2);
    String m = msg;
    if (m.length() > 28) {
        int splitAt = m.indexOf(' ', m.length() / 2);
        if (splitAt < 0) splitAt = m.lastIndexOf(' ', m.length() / 2);
        if (splitAt > 0) {
            tft.drawString(m.substring(0, splitAt), cx, SCREEN_H / 2 + 45);
            tft.drawString(m.substring(splitAt + 1), cx, SCREEN_H / 2 + 65);
        } else {
            tft.drawString(m, cx, SCREEN_H / 2 + 45);
        }
    } else {
        tft.drawString(m, cx, SCREEN_H / 2 + 45);
    }

    tft.setTextColor(COL_TEXT);
    tft.setFont(&fonts::Font0);
    tft.drawString("Tap to retry", cx, SCREEN_H / 2 + 95);
}

int display_hitTest(int16_t x, int16_t y, int deviceCount, bool& startBtnHit) {
    startBtnHit = false;

    // Check Start button
    if (y >= BTN_Y && y <= BTN_Y + BTN_H && x >= BTN_X && x <= BTN_X + BTN_W) {
        startBtnHit = true;
        return -1;
    }

    // Check device list rows (returns visual row index, 0-based)
    for (int i = 0; i < 4; i++) {
        int itemY = LIST_Y_START + i * LIST_ITEM_H;
        if (y >= itemY && y < itemY + LIST_ITEM_H && x >= 4 && x <= SCREEN_W - 4) {
            return i;
        }
    }

    return -1;
}

void display_confirm(const char* title, const char* line1, const char* line2, const char* btnText) {
    tft.fillScreen(COL_BG);
    int cx = SCREEN_W / 2;

    // Title
    tft.setTextDatum(lgfx::middle_center);
    tft.setTextColor(COL_GREEN);
    tft.setFont(&fonts::Font4);
    tft.drawString(title, cx, 60);

    // Info lines
    tft.setTextColor(COL_TEXT);
    tft.setFont(&fonts::Font2);
    if (line1 && strlen(line1) > 0) tft.drawString(line1, cx, 110);
    if (line2 && strlen(line2) > 0) tft.drawString(line2, cx, 140);

    // Button
    tft.fillRoundRect(BTN_X, BTN_Y, BTN_W, BTN_H, 8, COL_PURPLE);
    tft.setTextDatum(lgfx::middle_center);
    tft.setTextColor(COL_TEXT);
    tft.setFont(&fonts::Font4);
    tft.drawString(btnText, BTN_X + BTN_W / 2, BTN_Y + BTN_H / 2);
}

bool display_btnHit(int16_t x, int16_t y) {
    return (y >= BTN_Y && y <= BTN_Y + BTN_H && x >= BTN_X && x <= BTN_X + BTN_W);
}

#else
// ── Stub implementations for non-LCD builds ─────────────────────────────────

void display_init() {}
void display_boot(const char*) {}
void display_scanning() {}
void display_devices(ScanResult*, int, int, int) {}
void display_provision(const char*, int, int, const char*) {}
void display_mqttWait(bool, bool) {}
void display_ota(const char*) {}
void display_done() {}
void display_error(const char*) {}
void display_confirm(const char*, const char*, const char*, const char*) {}
bool display_btnHit(int16_t, int16_t) { return false; }
int display_hitTest(int16_t, int16_t, int, bool&) { return -1; }

#endif
