/**
 * display.cpp — LVGL 8.4 display driver
 *
 * Supports two hardware targets:
 *   WAVESHARE_LCD — Waveshare ESP32-S3 Touch LCD 2" (ST7789, SPI, CST816D touch)
 *                   No PSRAM — buffers in internal SRAM.
 *   JC3248W535    — JC3248W535EN (AXS15231B, QSPI, I2C touch, 8MB PSRAM)
 *                   320x480 display, rotated 90° → 480x320 logical.
 *
 * Dark theme (#1a1a2e) with purple/teal accents using LVGL widgets.
 *
 * v2.1 — JC3248W535 QSPI board support via BSP.
 */

#include <stdint.h>
#include "display.h"
#include "logo.h"

#if defined(WAVESHARE_LCD) || defined(JC3248W535)

#ifdef WAVESHARE_LCD
#include <Arduino_GFX_Library.h>
#include <Wire.h>
#endif

#ifdef JC3248W535
#include "jc_bsp.h"
#endif

#include "lvgl.h"
#include "esp_timer.h"

// ── UI state flags (read by main.cpp) ───────────────────────────────────────

volatile int  ui_selectedChargerIdx = -1;
volatile int  ui_selectedMowerIdx   = -1;
volatile bool ui_startPressed       = false;
volatile bool ui_btnPressed         = false;
volatile bool ui_rescanPressed     = false;

// Phase 2: WiFi re-provisioning UI flags
volatile int  ui_selectedWifiIdx    = -1;
volatile bool ui_wifiPasswordReady  = false;
volatile bool ui_wifiRescanPressed  = false;
char ui_wifiPassword[64]            = {0};
char ui_wifiSsid[33]                = {0};

// v2.0: Menu + firmware UI flags
volatile int  ui_menuSelection      = -1;
volatile bool ui_backPressed        = false;
volatile bool ui_flashConfirmed     = false;
volatile bool ui_flashSkipped       = false;

// ── Theme colors ────────────────────────────────────────────────────────────

#define COL_BG       lv_color_hex(0x1a1a2e)
#define COL_CARD     lv_color_hex(0x16213e)
#define COL_TEXT     lv_color_hex(0xe0e0e0)
#define COL_DIM      lv_color_hex(0x6b7280)
#define COL_PURPLE   lv_color_hex(0x7c3aed)
#define COL_TEAL     lv_color_hex(0x00d4aa)
#define COL_GREEN    lv_color_hex(0x22c55e)
#define COL_RED      lv_color_hex(0xef4444)
#define COL_ORANGE   lv_color_hex(0xf59e0b)
#define COL_GRAY_BTN lv_color_hex(0x374151)

// ── Screen dimensions ───────────────────────────────────────────────────────
// JC3248W535: 320x480 display, rotated 90° → logical 480x320
// Waveshare:  240x320 (portrait)

#ifdef JC3248W535
#define SCREEN_W 480
#define SCREEN_H 320
#else
#define SCREEN_W 240
#define SCREEN_H 320
#endif

// ── LVGL tick period ────────────────────────────────────────────────────────

#define LV_TICK_PERIOD_MS 2
#define LV_TASK_MAX_DELAY_MS 500
#define LV_TASK_MIN_DELAY_MS 1

// ── Arduino_GFX display instance (Waveshare only) ────────────────────────────

#ifdef WAVESHARE_LCD
static Arduino_DataBus *bus = nullptr;
static Arduino_GFX *gfx = nullptr;

// ── SPI mutex (shared with SD card) ─────────────────────────────────────────

static SemaphoreHandle_t spi_mux = nullptr;

static bool spi_lock(int timeout_ms = -1) {
    const TickType_t ticks = (timeout_ms == -1) ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
    return xSemaphoreTakeRecursive(spi_mux, ticks) == pdTRUE;
}

static void spi_unlock() {
    xSemaphoreGiveRecursive(spi_mux);
}
#endif // WAVESHARE_LCD

// ── LVGL mutex — Waveshare only (JC3248W535 uses jc3248w535_lock/unlock) ────

#ifdef WAVESHARE_LCD
static SemaphoreHandle_t lvgl_mux = nullptr;

bool lvgl_lock(int timeout_ms) {
    const TickType_t ticks = (timeout_ms == -1) ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
    return xSemaphoreTakeRecursive(lvgl_mux, ticks) == pdTRUE;
}

void lvgl_unlock() {
    xSemaphoreGiveRecursive(lvgl_mux);
}
#endif

// ── LVGL draw buffers — Waveshare only (JC3248W535 uses PSRAM via BSP) ───────

#ifdef WAVESHARE_LCD
static lv_color_t draw_buf1[SCREEN_W * 32];   // 240 * 32 * 2 = 15360 bytes
static lv_color_t draw_buf2[SCREEN_W * 32];   // 15360 bytes
static lv_disp_draw_buf_t disp_draw_buf;
#endif // WAVESHARE_LCD

// ── Touch + flush callbacks — Waveshare only (JC3248W535 uses BSP/esp_lvgl_port) ──

#ifdef WAVESHARE_LCD

static const uint8_t CST816D_ADDR = 0x15;

static void touch_read_cb(lv_indev_drv_t *drv, lv_indev_data_t *data) {
    Wire.beginTransmission(CST816D_ADDR);
    Wire.write(0x02);
    if (Wire.endTransmission() != 0) {
        data->state = LV_INDEV_STATE_RELEASED;
        return;
    }

    Wire.requestFrom(CST816D_ADDR, (uint8_t)5);
    if (Wire.available() < 5) {
        data->state = LV_INDEV_STATE_RELEASED;
        return;
    }

    uint8_t touchCount = Wire.read();
    uint8_t xHigh = Wire.read();
    uint8_t xLow  = Wire.read();
    uint8_t yHigh = Wire.read();
    uint8_t yLow  = Wire.read();

    if (touchCount > 0) {
        data->point.x = ((xHigh & 0x0F) << 8) | xLow;
        data->point.y = ((yHigh & 0x0F) << 8) | yLow;
        data->state = LV_INDEV_STATE_PRESSED;
    } else {
        data->state = LV_INDEV_STATE_RELEASED;
    }
}

// ── Display flush callback ──────────────────────────────────────────────────

static void disp_flush_cb(lv_disp_drv_t *drv, const lv_area_t *area, lv_color_t *color_map) {
    uint32_t w = (area->x2 - area->x1 + 1);
    uint32_t h = (area->y2 - area->y1 + 1);
    if (spi_lock(-1)) {
#if (LV_COLOR_16_SWAP != 0)
        gfx->draw16bitBeRGBBitmap(area->x1, area->y1, (uint16_t *)&color_map->full, w, h);
#else
        gfx->draw16bitRGBBitmap(area->x1, area->y1, (uint16_t *)&color_map->full, w, h);
#endif
        spi_unlock();
    }
    lv_disp_flush_ready(drv);
}

// ── LVGL tick + task — Waveshare only (JC3248W535 uses lv_port.c internal task) ──

static void lvgl_tick_cb(void *arg) {
    lv_tick_inc(LV_TICK_PERIOD_MS);
}

static void lvgl_task(void *param) {
    const esp_timer_create_args_t tick_args = {
        .callback = &lvgl_tick_cb,
        .name = "lvgl_tick"
    };
    esp_timer_handle_t tick_timer = nullptr;
    esp_timer_create(&tick_args, &tick_timer);
    esp_timer_start_periodic(tick_timer, LV_TICK_PERIOD_MS * 1000);

    while (true) {
        uint32_t delay_ms = LV_TASK_MAX_DELAY_MS;
        if (lvgl_lock(-1)) {
            delay_ms = lv_timer_handler();
            lvgl_unlock();
        }
        if (delay_ms > LV_TASK_MAX_DELAY_MS) delay_ms = LV_TASK_MAX_DELAY_MS;
        else if (delay_ms < LV_TASK_MIN_DELAY_MS) delay_ms = LV_TASK_MIN_DELAY_MS;
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
    }
}

#endif // WAVESHARE_LCD

// ── Style helpers — shared by both boards ────────────────────────────────────

// Persistent MQTT wait labels (forward declarations for create_screen reset)
static lv_obj_t *mqtt_scr = nullptr;
static lv_obj_t *mqtt_chg_label = nullptr;
static lv_obj_t *mqtt_mow_label = nullptr;

// Persistent detect screen labels
static lv_obj_t *detect_scr = nullptr;
static lv_obj_t *detect_time_label = nullptr;
static lv_obj_t *detect_wifi_label = nullptr;
static lv_obj_t *detect_chg_label = nullptr;
static lv_obj_t *detect_mow_label = nullptr;

// Create a dark base screen
static lv_obj_t *prev_screen = nullptr;

static lv_obj_t* create_screen() {
    // Reset persistent screen pointers
    mqtt_scr = nullptr;
    mqtt_chg_label = nullptr;
    mqtt_mow_label = nullptr;
    detect_scr = nullptr;
    detect_time_label = nullptr;
    detect_wifi_label = nullptr;
    detect_chg_label = nullptr;
    detect_mow_label = nullptr;

    // Remember old screen for deletion after new one is loaded
    lv_obj_t *old_screen = prev_screen;

    lv_obj_t *scr = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(scr, COL_BG, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_clear_flag(scr, LV_OBJ_FLAG_SCROLLABLE);
    prev_screen = scr;

    // Delete old screen to free memory (ESP32-S3 has no PSRAM!)
    // Use async delete — caller will lv_scr_load(scr) after building widgets
    if (old_screen) {
        lv_obj_del_async(old_screen);
    }

    return scr;
}

// Centered label
static lv_obj_t* add_label(lv_obj_t *parent, const char *text, const lv_font_t *font,
                           lv_color_t color, lv_coord_t y_ofs) {
    lv_obj_t *lbl = lv_label_create(parent);
    lv_label_set_text(lbl, text);
    lv_obj_set_style_text_font(lbl, font, 0);
    lv_obj_set_style_text_color(lbl, color, 0);
    lv_obj_set_style_text_align(lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(lbl, SCREEN_W - 20);
    lv_obj_align(lbl, LV_ALIGN_TOP_MID, 0, y_ofs);
    return lbl;
}

// Purple rounded button at bottom
static lv_obj_t* add_bottom_btn(lv_obj_t *parent, const char *text, lv_event_cb_t cb) {
    lv_obj_t *btn = lv_btn_create(parent);
    lv_obj_set_size(btn, 200, 44);
    lv_obj_align(btn, LV_ALIGN_BOTTOM_MID, 0, -12);
    lv_obj_set_style_bg_color(btn, COL_PURPLE, 0);
    lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(btn, 12, 0);
    lv_obj_set_style_shadow_width(btn, 0, 0);
    lv_obj_set_style_border_width(btn, 0, 0);

    lv_obj_t *lbl = lv_label_create(btn);
    lv_label_set_text(lbl, text);
    lv_obj_set_style_text_font(lbl, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(lbl, COL_TEXT, 0);
    lv_obj_center(lbl);

    if (cb) lv_obj_add_event_cb(btn, cb, LV_EVENT_CLICKED, NULL);
    return btn;
}

// ── Device list state — needed for LVGL callbacks ───────────────────────────

static ScanResult* g_scanResults = nullptr;
static int g_scanCount = 0;
// Map from visual list row to scanResults index
static int g_rowToIdx[8];
static int g_rowCount = 0;

// ── LVGL event callbacks ────────────────────────────────────────────────────

static void start_btn_cb(lv_event_t *e) {
    ui_startPressed = true;
}

static void rescan_btn_cb(lv_event_t *e) {
    ui_rescanPressed = true;
}

static void generic_btn_cb(lv_event_t *e) {
    ui_btnPressed = true;
}

static unsigned long lastDeviceTapMs = 0;

static void device_item_cb(lv_event_t *e) {
    // Debounce: ignore taps within 300ms of each other (screen redraw causes double events)
    unsigned long now = millis();
    if (now - lastDeviceTapMs < 150) return;
    lastDeviceTapMs = now;

    int row = (int)(intptr_t)lv_event_get_user_data(e);
    if (row < 0 || row >= g_rowCount) return;
    int realIdx = g_rowToIdx[row];
    if (realIdx < 0 || realIdx >= g_scanCount) return;

    ScanResult &r = g_scanResults[realIdx];
    if (r.isCharger) {
        ui_selectedChargerIdx = (ui_selectedChargerIdx == realIdx) ? -1 : realIdx;
    } else if (r.isMower) {
        ui_selectedMowerIdx = (ui_selectedMowerIdx == realIdx) ? -1 : realIdx;
    }

    // Redraw device list
    display_devices(g_scanResults, g_scanCount, ui_selectedChargerIdx, ui_selectedMowerIdx);
}

static void done_tap_cb(lv_event_t *e) {
    ui_btnPressed = true;
}

static void error_tap_cb(lv_event_t *e) {
    ui_btnPressed = true;
}

// v2.0: Menu callbacks
static void menu_btn_cb(lv_event_t *e) {
    int idx = (int)(intptr_t)lv_event_get_user_data(e);
    ui_menuSelection = idx;
}

static void back_btn_cb(lv_event_t *e) {
    ui_backPressed = true;
}

static void flash_confirm_cb(lv_event_t *e) {
    ui_flashConfirmed = true;
}

static void flash_skip_cb(lv_event_t *e) {
    ui_flashSkipped = true;
}

// ── Public API ──────────────────────────────────────────────────────────────

#ifdef JC3248W535
#include "jc3248w535.h"

static jc3248w535_handles_t jc_handles;

void display_init() {
    // Initialize JC3248W535 display + touch + LVGL via the clean library
    jc3248w535_begin_simple(90, &jc_handles);  // 90° rotation → landscape
    jc3248w535_backlight_set(100);
    Serial.printf("[DISPLAY] JC3248W535 initialized (%dx%d, PSRAM)\r\n", SCREEN_W, SCREEN_H);
}

void display_run() {
    // LVGL task is already started by esp_lvgl_port inside jc3248w535_begin_simple
    Serial.println("[DISPLAY] LVGL task running (via esp_lvgl_port)");
}

// lvgl_lock/unlock for JC3248W535 — delegates to jc3248w535 library
// Note: jc_bsp uses timeout_ms==0 to mean "wait forever" (portMAX_DELAY)
bool lvgl_lock(int timeout_ms) {
    // Map our timeout: -1 or 0 → wait forever (pass 0 to bsp_display_lock)
    // Positive values → actual timeout in ms
    if (timeout_ms <= 0) return jc3248w535_lock(0);
    return jc3248w535_lock((uint32_t)timeout_ms);
}
void lvgl_unlock(void) {
    jc3248w535_unlock();
}

#elif defined(WAVESHARE_LCD)
void display_init() {
    // SPI mutex
    spi_mux = xSemaphoreCreateRecursiveMutex();

    // Arduino_GFX: same config as factory demo
    bus = new Arduino_ESP32SPI(
        LCD_DC, LCD_CS, LCD_SCLK, LCD_MOSI, LCD_MISO, FSPI, true);
    gfx = new Arduino_ST7789(
        bus, LCD_RST, 0 /* rotation */, true /* IPS */,
        SCREEN_W, SCREEN_H);

    gfx->begin();
    gfx->fillScreen(BLACK);

    // Backlight ON
    pinMode(LCD_BL, OUTPUT);
    digitalWrite(LCD_BL, HIGH);

    // Touch I2C
    Wire.begin(TOUCH_SDA, TOUCH_SCL);
    Wire.setClock(400000);

    // LVGL init
    lvgl_mux = xSemaphoreCreateRecursiveMutex();
    lv_init();

    // Draw buffer init — static arrays, NOT PSRAM
    lv_disp_draw_buf_init(&disp_draw_buf, draw_buf1, draw_buf2, SCREEN_W * 32);

    // Display driver
    static lv_disp_drv_t disp_drv;
    lv_disp_drv_init(&disp_drv);
    disp_drv.hor_res = SCREEN_W;
    disp_drv.ver_res = SCREEN_H;
    disp_drv.flush_cb = disp_flush_cb;
    disp_drv.draw_buf = &disp_draw_buf;
    disp_drv.full_refresh = 0;  // Partial refresh to save bandwidth
    lv_disp_t *disp = lv_disp_drv_register(&disp_drv);

    // Input device (touch)
    static lv_indev_drv_t indev_drv;
    lv_indev_drv_init(&indev_drv);
    indev_drv.type = LV_INDEV_TYPE_POINTER;
    indev_drv.disp = disp;
    indev_drv.read_cb = touch_read_cb;
    lv_indev_drv_register(&indev_drv);

    // DON'T start LVGL task yet — call display_run() after SD init
    Serial.println("[DISPLAY] LVGL 8.4 initialized (240x320, no PSRAM)");
}

void display_run() {
    // Start LVGL task on core 1 — call AFTER SD init to avoid SPI conflict
    xTaskCreatePinnedToCore(lvgl_task, "lvgl", 1024 * 10, NULL, 5, NULL, 1);
    Serial.println("[DISPLAY] LVGL task started");
}

#endif // JC3248W535 / WAVESHARE_LCD display_init/display_run

// ── Shared LVGL widget functions (used by both boards) ─────────────────────

void display_boot(const char* version) {
    if (!lvgl_lock(0)) return;

    lv_obj_t *scr = create_screen();

    // OpenNova logo
    lv_obj_t *logo = lv_img_create(scr);
    lv_img_set_src(logo, &logo_img);
    lv_obj_align(logo, LV_ALIGN_TOP_MID, 0, 30);

    // OpenNova title below logo
    add_label(scr, "OpenNova", &lv_font_montserrat_28, COL_TEXT, 120);

    // Subtitle
    add_label(scr, "Provisioner", &lv_font_montserrat_20, COL_TEAL, 155);

    // Version
    add_label(scr, version, &lv_font_montserrat_14, COL_DIM, 185);

    // Spinner at bottom
    lv_obj_t *spinner = lv_spinner_create(scr, 1000, 60);
    lv_obj_set_size(spinner, 36, 36);
    lv_obj_align(spinner, LV_ALIGN_BOTTOM_MID, 0, -30);
    lv_obj_set_style_arc_color(spinner, COL_PURPLE, LV_PART_INDICATOR);
    lv_obj_set_style_arc_color(spinner, COL_CARD, LV_PART_MAIN);
    lv_obj_set_style_arc_width(spinner, 4, LV_PART_INDICATOR);
    lv_obj_set_style_arc_width(spinner, 4, LV_PART_MAIN);

    lv_scr_load(scr);
    lvgl_unlock();
}

void display_scanning() {
    if (!lvgl_lock(0)) return;

    lv_obj_t *scr = create_screen();

    add_label(scr, "Scanning...", &lv_font_montserrat_20, COL_TEXT, 100);

    // Spinner
    lv_obj_t *spinner = lv_spinner_create(scr, 1200, 60);
    lv_obj_set_size(spinner, 60, 60);
    lv_obj_align(spinner, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_style_arc_color(spinner, COL_PURPLE, LV_PART_INDICATOR);
    lv_obj_set_style_arc_color(spinner, COL_CARD, LV_PART_MAIN);
    lv_obj_set_style_arc_width(spinner, 6, LV_PART_INDICATOR);
    lv_obj_set_style_arc_width(spinner, 6, LV_PART_MAIN);

    add_label(scr, "Looking for Novabot devices", &lv_font_montserrat_14, COL_DIM, 210);

    lv_scr_load(scr);
    lvgl_unlock();
}

void display_devices(ScanResult* results, int count, int selectedCharger, int selectedMower) {
    if (!lvgl_lock(0)) return;

    // Store for callbacks
    g_scanResults = results;
    g_scanCount = count;
    g_rowCount = 0;

    lv_obj_t *scr = create_screen();

    // Title
    add_label(scr, "Found Devices", &lv_font_montserrat_20, COL_TEXT, 8);

    // List
    lv_obj_t *list = lv_list_create(scr);
    lv_obj_set_size(list, 232, 200);
    lv_obj_align(list, LV_ALIGN_TOP_MID, 0, 42);
    lv_obj_set_style_bg_color(list, COL_BG, 0);
    lv_obj_set_style_bg_opa(list, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(list, 0, 0);
    lv_obj_set_style_pad_row(list, 4, 0);
    lv_obj_set_style_pad_all(list, 2, 0);

    int row = 0;
    bool anyDevice = false;
    for (int i = 0; i < count && row < 6; i++) {
        if (!results[i].isCharger && !results[i].isMower) continue;
        anyDevice = true;

        bool isSelected = (i == selectedCharger || i == selectedMower);
        g_rowToIdx[row] = i;

        // Device tile — custom layout: icon left, text column right
        const char *typeStr = results[i].isCharger ? "Charger" : "Mower";
        lv_color_t accent = results[i].isCharger ? COL_ORANGE : COL_TEAL;

        // Container (clickable)
        lv_obj_t *item = lv_obj_create(list);
        lv_obj_set_size(item, LV_PCT(100), 72);
        lv_obj_set_style_bg_color(item, isSelected ? lv_color_hex(0x1a3a2e) : COL_CARD, 0);
        lv_obj_set_style_bg_opa(item, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(item, 10, 0);
        lv_obj_set_style_pad_all(item, 10, 0);
        lv_obj_set_flex_flow(item, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(item, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
        lv_obj_clear_flag(item, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_add_flag(item, LV_OBJ_FLAG_CLICKABLE);
        if (isSelected) {
            lv_obj_set_style_border_width(item, 3, 0);
            lv_obj_set_style_border_color(item, COL_GREEN, 0);
            lv_obj_set_style_border_side(item, LV_BORDER_SIDE_LEFT, 0);
        }

        // Icon
        lv_obj_t *icon_lbl = lv_label_create(item);
        lv_label_set_text(icon_lbl, results[i].isCharger ? LV_SYMBOL_CHARGE : LV_SYMBOL_SETTINGS);
        lv_obj_set_style_text_color(icon_lbl, accent, 0);
        lv_obj_set_style_text_font(icon_lbl, &lv_font_montserrat_28, 0);
        lv_obj_set_style_pad_right(icon_lbl, 10, 0);
        lv_obj_add_flag(icon_lbl, LV_OBJ_FLAG_EVENT_BUBBLE);
        lv_obj_clear_flag(icon_lbl, LV_OBJ_FLAG_CLICKABLE);

        // Text column
        lv_obj_t *col = lv_obj_create(item);
        lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_flex_grow(col, 1);
        lv_obj_set_size(col, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        lv_obj_set_style_pad_all(col, 0, 0);
        lv_obj_set_style_bg_opa(col, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(col, 0, 0);
        lv_obj_clear_flag(col, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_flag(col, LV_OBJ_FLAG_EVENT_BUBBLE);

        // Line 1: device type (big, white)
        lv_obj_t *name_lbl = lv_label_create(col);
        lv_label_set_text(name_lbl, typeStr);
        lv_obj_set_style_text_color(name_lbl, COL_TEXT, 0);
        lv_obj_set_style_text_font(name_lbl, &lv_font_montserrat_20, 0);

        // Line 2: MAC address + RSSI (small, gray)
        char sub_text[48];
        snprintf(sub_text, sizeof(sub_text), "%s  %ddB", results[i].mac.c_str(), results[i].rssi);
        lv_obj_t *sub = lv_label_create(col);
        lv_label_set_text(sub, sub_text);
        lv_obj_set_style_text_color(sub, COL_DIM, 0);
        lv_obj_set_style_text_font(sub, &lv_font_montserrat_14, 0);

        lv_obj_add_event_cb(item, device_item_cb, LV_EVENT_CLICKED, (void*)(intptr_t)row);
        row++;
    }
    g_rowCount = row;

    if (!anyDevice) {
        add_label(scr, "No Novabot\ndevices found", &lv_font_montserrat_20, COL_DIM, 140);
    }

    // Button row at bottom
    bool canStart = (selectedCharger >= 0 || selectedMower >= 0);

    // Rescan button (left)
    lv_obj_t *rescan = lv_btn_create(scr);
    lv_obj_set_size(rescan, 100, 42);
    lv_obj_align(rescan, LV_ALIGN_BOTTOM_LEFT, 12, -10);
    lv_obj_set_style_bg_color(rescan, COL_CARD, 0);
    lv_obj_set_style_bg_opa(rescan, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(rescan, 12, 0);
    lv_obj_set_style_shadow_width(rescan, 0, 0);
    lv_obj_set_style_border_width(rescan, 0, 0);
    lv_obj_t *rescan_lbl = lv_label_create(rescan);
    lv_label_set_text(rescan_lbl, LV_SYMBOL_REFRESH " Scan");
    lv_obj_set_style_text_font(rescan_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(rescan_lbl, COL_TEXT, 0);
    lv_obj_center(rescan_lbl);
    lv_obj_add_event_cb(rescan, rescan_btn_cb, LV_EVENT_CLICKED, NULL);

    // Start button (right)
    lv_obj_t *btn = lv_btn_create(scr);
    lv_obj_set_size(btn, 110, 42);
    lv_obj_align(btn, LV_ALIGN_BOTTOM_RIGHT, -12, -10);
    lv_obj_set_style_bg_color(btn, canStart ? COL_PURPLE : lv_color_hex(0x2a2a3e), 0);
    lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(btn, 12, 0);
    lv_obj_set_style_shadow_width(btn, 0, 0);
    lv_obj_set_style_border_width(btn, 0, 0);
    lv_obj_t *btn_lbl = lv_label_create(btn);
    lv_label_set_text(btn_lbl, "Start " LV_SYMBOL_RIGHT);
    lv_obj_set_style_text_font(btn_lbl, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(btn_lbl, canStart ? COL_TEXT : COL_DIM, 0);
    lv_obj_center(btn_lbl);
    if (canStart) {
        lv_obj_add_event_cb(btn, start_btn_cb, LV_EVENT_CLICKED, NULL);
    }

    lv_scr_load(scr);
    lvgl_unlock();
}

void display_confirm(const char* title, const char* line1, const char* line2, const char* btnText) {
    if (!lvgl_lock(0)) return;
    ui_btnPressed = false;

    lv_obj_t *scr = create_screen();

    // Title
    add_label(scr, title, &lv_font_montserrat_20, COL_GREEN, 60);

    // Info lines
    if (line1 && strlen(line1) > 0) {
        add_label(scr, line1, &lv_font_montserrat_14, COL_TEXT, 110);
    }
    if (line2 && strlen(line2) > 0) {
        add_label(scr, line2, &lv_font_montserrat_14, COL_TEXT, 140);
    }

    // Button
    add_bottom_btn(scr, btnText, generic_btn_cb);

    lv_scr_load(scr);
    lvgl_unlock();
}

void display_deviceStatus(int chargerStatus, const char* chargerSn,
                          int mowerStatus, const char* mowerSn,
                          bool canContinue) {
    if (!lvgl_lock(0)) return;
    ui_btnPressed = false;

    lv_obj_t *scr = create_screen();

    // Title
    add_label(scr, "Device Status", &lv_font_montserrat_20, COL_GREEN, 20);

    // Color mapping: 0=grey, 1=orange(WiFi), 2=green(MQTT)
    auto statusColor = [](int s) -> lv_color_t {
        if (s >= 2) return lv_color_hex(0x34D399); // green
        if (s >= 1) return lv_color_hex(0xF59E0B); // orange
        return lv_color_hex(0x4B5563);              // grey
    };

    // Helper: add bouncing dots at position
    auto addDots = [&](lv_obj_t* parent, int xOff, int y) {
        for (int d = 0; d < 3; d++) {
            lv_obj_t *dot = lv_obj_create(parent);
            lv_obj_remove_style_all(dot);
            lv_obj_set_size(dot, 6, 6);
            lv_obj_set_style_radius(dot, 3, 0);
            lv_obj_set_style_bg_color(dot, lv_color_hex(0x4B5563), 0);
            lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
            lv_obj_align(dot, LV_ALIGN_TOP_MID, xOff + (d - 1) * 12, y);
            lv_anim_t a;
            lv_anim_init(&a);
            lv_anim_set_var(&a, dot);
            lv_anim_set_exec_cb(&a, [](void* obj, int32_t v) { lv_obj_set_style_opa((lv_obj_t*)obj, v, 0); });
            lv_anim_set_values(&a, 80, 255);
            lv_anim_set_time(&a, 400);
            lv_anim_set_playback_time(&a, 400);
            lv_anim_set_delay(&a, d * 200);
            lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
            lv_anim_start(&a);
        }
    };

    // ── Charger block (icon centered above name + SN/dots) ──
    int chY = 65;
    lv_obj_t *chIcon = lv_label_create(scr);
    lv_label_set_text(chIcon, LV_SYMBOL_CHARGE);
    lv_obj_set_style_text_font(chIcon, &lv_font_montserrat_28, 0);
    lv_obj_set_style_text_color(chIcon, statusColor(chargerStatus), 0);
    lv_obj_align(chIcon, LV_ALIGN_TOP_MID, 0, chY);

    lv_obj_t *chLbl = lv_label_create(scr);
    lv_label_set_text(chLbl, "Charger");
    lv_obj_set_style_text_font(chLbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(chLbl, statusColor(chargerStatus), 0);
    lv_obj_align(chLbl, LV_ALIGN_TOP_MID, 0, chY + 35);

    if (chargerSn && strlen(chargerSn) > 0) {
        lv_obj_t *chSn = lv_label_create(scr);
        lv_label_set_text(chSn, chargerSn);
        lv_obj_set_style_text_font(chSn, &lv_font_montserrat_12, 0);
        lv_obj_set_style_text_color(chSn, lv_color_hex(0x9CA3AF), 0);
        lv_obj_align(chSn, LV_ALIGN_TOP_MID, 0, chY + 53);
    } else {
        addDots(scr, 0, chY + 58);
    }

    // ── Mower block (icon centered above name + SN/dots) ──
    int mwY = 145;
    lv_obj_t *mwIcon = lv_label_create(scr);
    lv_label_set_text(mwIcon, LV_SYMBOL_DRIVE);
    lv_obj_set_style_text_font(mwIcon, &lv_font_montserrat_28, 0);
    lv_obj_set_style_text_color(mwIcon, statusColor(mowerStatus), 0);
    lv_obj_align(mwIcon, LV_ALIGN_TOP_MID, 0, mwY);

    lv_obj_t *mwLbl = lv_label_create(scr);
    lv_label_set_text(mwLbl, "Mower");
    lv_obj_set_style_text_font(mwLbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(mwLbl, statusColor(mowerStatus), 0);
    lv_obj_align(mwLbl, LV_ALIGN_TOP_MID, 0, mwY + 35);

    if (mowerSn && strlen(mowerSn) > 0) {
        lv_obj_t *mwSn = lv_label_create(scr);
        lv_label_set_text(mwSn, mowerSn);
        lv_obj_set_style_text_font(mwSn, &lv_font_montserrat_12, 0);
        lv_obj_set_style_text_color(mwSn, lv_color_hex(0x9CA3AF), 0);
        lv_obj_align(mwSn, LV_ALIGN_TOP_MID, 0, mwY + 53);
    } else {
        addDots(scr, 0, mwY + 58);
    }

    // Legend at bottom
    lv_obj_t *legend = lv_label_create(scr);
    lv_label_set_text(legend, "Grey=waiting  Orange=WiFi  Green=MQTT");
    lv_obj_set_style_text_font(legend, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(legend, lv_color_hex(0x6B7280), 0);
    lv_obj_set_style_text_align(legend, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(legend, 220);
    lv_obj_align(legend, LV_ALIGN_BOTTOM_MID, 0, -60);

    // Continue button — always visible, greyed out when not ready
    lv_obj_t *btn = lv_btn_create(scr);
    lv_obj_set_size(btn, 200, 40);
    lv_obj_align(btn, LV_ALIGN_BOTTOM_MID, 0, -10);
    lv_obj_set_style_radius(btn, 8, 0);
    if (canContinue) {
        lv_obj_set_style_bg_color(btn, COL_TEAL, 0);
        lv_obj_add_event_cb(btn, generic_btn_cb, LV_EVENT_CLICKED, NULL);
    } else {
        lv_obj_set_style_bg_color(btn, lv_color_hex(0x374151), 0);
        lv_obj_clear_flag(btn, LV_OBJ_FLAG_CLICKABLE);
    }
    lv_obj_t *btnLbl = lv_label_create(btn);
    lv_label_set_text(btnLbl, "Continue");
    lv_obj_set_style_text_color(btnLbl, canContinue ? lv_color_hex(0xFFFFFF) : lv_color_hex(0x6B7280), 0);
    lv_obj_center(btnLbl);

    lv_scr_load(scr);
    lvgl_unlock();
}

void display_provision(const char* device, int step, int total, const char* stepName) {
    if (!lvgl_lock(0)) return;

    lv_obj_t *scr = create_screen();

    // Device name
    add_label(scr, device, &lv_font_montserrat_20, COL_TEAL, 50);

    // "Provisioning..."
    add_label(scr, "Provisioning...", &lv_font_montserrat_14, COL_TEXT, 85);

    // Progress bar
    lv_obj_t *bar = lv_bar_create(scr);
    lv_obj_set_size(bar, 200, 16);
    lv_obj_align(bar, LV_ALIGN_CENTER, 0, -10);
    lv_obj_set_style_bg_color(bar, COL_CARD, LV_PART_MAIN);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_bg_color(bar, COL_PURPLE, LV_PART_INDICATOR);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, LV_PART_INDICATOR);
    lv_obj_set_style_radius(bar, 8, LV_PART_MAIN);
    lv_obj_set_style_radius(bar, 8, LV_PART_INDICATOR);
    lv_bar_set_range(bar, 0, 100);
    int pct = (total > 0) ? (step * 100 / total) : 0;
    lv_bar_set_value(bar, pct, LV_ANIM_OFF);

    // Step counter
    char stepStr[32];
    snprintf(stepStr, sizeof(stepStr), "Step %d / %d", step, total);
    add_label(scr, stepStr, &lv_font_montserrat_14, COL_DIM, 180);

    // Step name
    add_label(scr, stepName, &lv_font_montserrat_14, COL_TEXT, 210);

    lv_scr_load(scr);
    lvgl_unlock();
}

void display_mqttWait(bool chargerConnected, bool mowerConnected) {
    if (!lvgl_lock(0)) return;

    // Create screen only once
    if (!mqtt_scr || lv_scr_act() != mqtt_scr) {
        mqtt_scr = create_screen();

        add_label(mqtt_scr, "Waiting for\ndevices...", &lv_font_montserrat_20, COL_TEXT, 30);

        // Spinner (created once, LVGL animates it)
        lv_obj_t *spinner = lv_spinner_create(mqtt_scr, 1200, 60);
        lv_obj_set_size(spinner, 50, 50);
        lv_obj_align(spinner, LV_ALIGN_CENTER, 0, -20);
        lv_obj_set_style_arc_color(spinner, COL_PURPLE, LV_PART_INDICATOR);
        lv_obj_set_style_arc_color(spinner, COL_CARD, LV_PART_MAIN);
        lv_obj_set_style_arc_width(spinner, 5, LV_PART_INDICATOR);
        lv_obj_set_style_arc_width(spinner, 5, LV_PART_MAIN);

        // Charger status label
        mqtt_chg_label = lv_label_create(mqtt_scr);
        lv_obj_set_style_text_font(mqtt_chg_label, &lv_font_montserrat_14, 0);
        lv_obj_align(mqtt_chg_label, LV_ALIGN_LEFT_MID, 20, 50);

        // Mower status label
        mqtt_mow_label = lv_label_create(mqtt_scr);
        lv_obj_set_style_text_font(mqtt_mow_label, &lv_font_montserrat_14, 0);
        lv_obj_align(mqtt_mow_label, LV_ALIGN_LEFT_MID, 20, 80);

        // Skip button
        add_bottom_btn(mqtt_scr, "Next " LV_SYMBOL_RIGHT, generic_btn_cb);

        lv_scr_load(mqtt_scr);
    }

    // Update labels (every call, no screen recreation)
    char chgStr[40];
    snprintf(chgStr, sizeof(chgStr), "%s  Charger: %s",
             chargerConnected ? LV_SYMBOL_OK : LV_SYMBOL_REFRESH,
             chargerConnected ? "Connected" : "waiting...");
    lv_label_set_text(mqtt_chg_label, chgStr);
    lv_obj_set_style_text_color(mqtt_chg_label, chargerConnected ? COL_GREEN : COL_DIM, 0);

    char mowStr[40];
    snprintf(mowStr, sizeof(mowStr), "%s  Mower: %s",
             mowerConnected ? LV_SYMBOL_OK : LV_SYMBOL_REFRESH,
             mowerConnected ? "Connected" : "waiting...");
    lv_label_set_text(mqtt_mow_label, mowStr);
    lv_obj_set_style_text_color(mqtt_mow_label, mowerConnected ? COL_GREEN : COL_DIM, 0);

    lvgl_unlock();
}

void display_ota(const char* status) {
    if (!lvgl_lock(0)) return;

    lv_obj_t *scr = create_screen();

    add_label(scr, "Firmware Update", &lv_font_montserrat_20, COL_ORANGE, 50);

    // Spinner
    lv_obj_t *spinner = lv_spinner_create(scr, 1000, 60);
    lv_obj_set_size(spinner, 50, 50);
    lv_obj_align(spinner, LV_ALIGN_CENTER, 0, -20);
    lv_obj_set_style_arc_color(spinner, COL_TEAL, LV_PART_INDICATOR);
    lv_obj_set_style_arc_color(spinner, COL_CARD, LV_PART_MAIN);
    lv_obj_set_style_arc_width(spinner, 5, LV_PART_INDICATOR);
    lv_obj_set_style_arc_width(spinner, 5, LV_PART_MAIN);

    // Status text with word wrap
    lv_obj_t *lbl = lv_label_create(scr);
    lv_label_set_text(lbl, status);
    lv_obj_set_style_text_font(lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(lbl, COL_TEXT, 0);
    lv_obj_set_style_text_align(lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(lbl, SCREEN_W - 30);
    lv_label_set_long_mode(lbl, LV_LABEL_LONG_WRAP);
    lv_obj_align(lbl, LV_ALIGN_CENTER, 0, 50);

    lv_scr_load(scr);
    lvgl_unlock();
}

void display_done() {
    if (!lvgl_lock(0)) return;
    ui_btnPressed = false;

    lv_obj_t *scr = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(scr, lv_color_hex(0x030712), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_clear_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

    // Confetti particles — colored dots flying outward from center
    static const lv_color_t confettiColors[] = {
        lv_color_hex(0x34D399), lv_color_hex(0x818CF8), lv_color_hex(0xF59E0B),
        lv_color_hex(0xEC4899), lv_color_hex(0x06B6D4), lv_color_hex(0xEF4444),
        lv_color_hex(0xA78BFA), lv_color_hex(0x10B981),
    };
    for (int i = 0; i < 20; i++) {
        lv_obj_t *dot = lv_obj_create(scr);
        lv_obj_remove_style_all(dot);
        int sz = 4 + (i % 3) * 2;
        lv_obj_set_size(dot, sz, sz);
        lv_obj_set_style_radius(dot, sz / 2, 0);
        lv_obj_set_style_bg_color(dot, confettiColors[i % 8], 0);
        lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
        // Start from center
        lv_obj_align(dot, LV_ALIGN_CENTER, 0, -30);

        // Animate X outward
        int targetX = -100 + (i * 211 % 200);  // pseudo-random spread
        lv_anim_t ax;
        lv_anim_init(&ax);
        lv_anim_set_var(&ax, dot);
        lv_anim_set_exec_cb(&ax, [](void* obj, int32_t v) {
            lv_obj_set_x((lv_obj_t*)obj, v);
        });
        lv_anim_set_values(&ax, 120, 120 + targetX);
        lv_anim_set_time(&ax, 800 + (i * 37 % 400));
        lv_anim_set_delay(&ax, i * 50);
        lv_anim_set_path_cb(&ax, lv_anim_path_ease_out);
        lv_anim_start(&ax);

        // Animate Y outward + fade
        int targetY = -120 + (i * 173 % 240);
        lv_anim_t ay;
        lv_anim_init(&ay);
        lv_anim_set_var(&ay, dot);
        lv_anim_set_exec_cb(&ay, [](void* obj, int32_t v) {
            lv_obj_set_y((lv_obj_t*)obj, v);
        });
        lv_anim_set_values(&ay, 130, 130 + targetY);
        lv_anim_set_time(&ay, 800 + (i * 37 % 400));
        lv_anim_set_delay(&ay, i * 50);
        lv_anim_set_path_cb(&ay, lv_anim_path_ease_out);
        lv_anim_start(&ay);

        // Fade out
        lv_anim_t af;
        lv_anim_init(&af);
        lv_anim_set_var(&af, dot);
        lv_anim_set_exec_cb(&af, [](void* obj, int32_t v) {
            lv_obj_set_style_opa((lv_obj_t*)obj, v, 0);
        });
        lv_anim_set_values(&af, 255, 0);
        lv_anim_set_time(&af, 1200);
        lv_anim_set_delay(&af, i * 50 + 600);
        lv_anim_start(&af);
    }

    // Large checkmark
    lv_obj_t *check = lv_label_create(scr);
    lv_label_set_text(check, LV_SYMBOL_OK);
    lv_obj_set_style_text_font(check, &lv_font_montserrat_28, 0);
    lv_obj_set_style_text_color(check, COL_GREEN, 0);
    lv_obj_align(check, LV_ALIGN_CENTER, 0, -40);

    add_label(scr, "Done!", &lv_font_montserrat_28, COL_GREEN, 150);
    add_label(scr, "All devices provisioned", &lv_font_montserrat_14, lv_color_hex(0x9CA3AF), 185);

    // Restart button
    add_bottom_btn(scr, LV_SYMBOL_REFRESH " Restart", generic_btn_cb);

    lv_scr_load(scr);
    lvgl_unlock();
}

void display_error(const char* msg) {
    if (!lvgl_lock(0)) return;
    ui_btnPressed = false;
    ui_backPressed = false;

    lv_obj_t *scr = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(scr, lv_color_hex(0x2e0a0a), 0);  // Dark red tint
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_clear_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

    // X mark
    lv_obj_t *xmark = lv_label_create(scr);
    lv_label_set_text(xmark, LV_SYMBOL_CLOSE);
    lv_obj_set_style_text_font(xmark, &lv_font_montserrat_28, 0);
    lv_obj_set_style_text_color(xmark, COL_RED, 0);
    lv_obj_align(xmark, LV_ALIGN_CENTER, 0, -70);

    add_label(scr, "Error", &lv_font_montserrat_28, COL_RED, 110);

    // Error message with word wrap
    lv_obj_t *lbl = lv_label_create(scr);
    lv_label_set_text(lbl, msg);
    lv_obj_set_style_text_font(lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(lbl, COL_TEXT, 0);
    lv_obj_set_style_text_align(lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(lbl, SCREEN_W - 30);
    lv_label_set_long_mode(lbl, LV_LABEL_LONG_WRAP);
    lv_obj_align(lbl, LV_ALIGN_CENTER, 0, 10);

    // Two buttons: Retry + Menu
    lv_obj_t *retry_btn = lv_btn_create(scr);
    lv_obj_set_size(retry_btn, 100, 40);
    lv_obj_align(retry_btn, LV_ALIGN_BOTTOM_LEFT, 16, -16);
    lv_obj_set_style_bg_color(retry_btn, COL_RED, 0);
    lv_obj_set_style_bg_opa(retry_btn, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(retry_btn, 10, 0);
    lv_obj_set_style_shadow_width(retry_btn, 0, 0);
    lv_obj_set_style_border_width(retry_btn, 0, 0);
    lv_obj_t *retry_lbl = lv_label_create(retry_btn);
    lv_label_set_text(retry_lbl, "Retry");
    lv_obj_set_style_text_font(retry_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(retry_lbl, COL_TEXT, 0);
    lv_obj_center(retry_lbl);
    lv_obj_add_event_cb(retry_btn, error_tap_cb, LV_EVENT_CLICKED, NULL);

    lv_obj_t *menu_btn = lv_btn_create(scr);
    lv_obj_set_size(menu_btn, 100, 40);
    lv_obj_align(menu_btn, LV_ALIGN_BOTTOM_RIGHT, -16, -16);
    lv_obj_set_style_bg_color(menu_btn, COL_PURPLE, 0);
    lv_obj_set_style_bg_opa(menu_btn, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(menu_btn, 10, 0);
    lv_obj_set_style_shadow_width(menu_btn, 0, 0);
    lv_obj_set_style_border_width(menu_btn, 0, 0);
    lv_obj_t *menu_lbl = lv_label_create(menu_btn);
    lv_label_set_text(menu_lbl, "Menu");
    lv_obj_set_style_text_font(menu_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(menu_lbl, COL_TEXT, 0);
    lv_obj_center(menu_lbl);
    lv_obj_add_event_cb(menu_btn, back_btn_cb, LV_EVENT_CLICKED, NULL);

    lv_scr_load(scr);
    lvgl_unlock();
}

// ── Phase 2: WiFi list + password screens ────────────────────────────────────

// WiFi list state for callbacks
static WifiNetwork* g_wifiNetworks = nullptr;
static int g_wifiCount = 0;

static void wifi_item_cb(lv_event_t *e) {
    int idx = (int)(intptr_t)lv_event_get_user_data(e);
    if (idx >= 0 && idx < g_wifiCount) {
        ui_selectedWifiIdx = idx;
    }
}

static void wifi_rescan_cb(lv_event_t *e) {
    ui_wifiRescanPressed = true;
}

static void wifi_connect_cb(lv_event_t *e) {
    lv_obj_t *ta = (lv_obj_t *)lv_event_get_user_data(e);
    const char *txt = lv_textarea_get_text(ta);
    strncpy(ui_wifiPassword, txt, sizeof(ui_wifiPassword) - 1);
    ui_wifiPassword[sizeof(ui_wifiPassword) - 1] = '\0';
    ui_wifiPasswordReady = true;
}

void display_wifiList(WifiNetwork* networks, int count, int selected) {
    if (!lvgl_lock(0)) return;

    g_wifiNetworks = networks;
    g_wifiCount = count;
    ui_selectedWifiIdx = -1;

    lv_obj_t *scr = create_screen();

    // Title
    add_label(scr, "Select Home WiFi", &lv_font_montserrat_20, COL_TEAL, 6);

    // List
    lv_obj_t *list = lv_list_create(scr);
    lv_obj_set_size(list, 232, 220);
    lv_obj_align(list, LV_ALIGN_TOP_MID, 0, 36);
    lv_obj_set_style_bg_color(list, COL_BG, 0);
    lv_obj_set_style_bg_opa(list, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(list, 0, 0);
    lv_obj_set_style_pad_row(list, 3, 0);
    lv_obj_set_style_pad_all(list, 2, 0);

    int shown = 0;
    for (int i = 0; i < count; i++) {
        // Container (clickable)
        lv_obj_t *item = lv_obj_create(list);
        lv_obj_set_size(item, LV_PCT(100), LV_SIZE_CONTENT);
        lv_obj_set_style_bg_color(item, (i == selected) ? lv_color_hex(0x1a3a2e) : COL_CARD, 0);
        lv_obj_set_style_bg_opa(item, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(item, 8, 0);
        lv_obj_set_style_pad_all(item, 6, 0);
        lv_obj_set_flex_flow(item, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(item, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
        lv_obj_clear_flag(item, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_add_flag(item, LV_OBJ_FLAG_CLICKABLE);

        // WiFi icon
        lv_obj_t *icon = lv_label_create(item);
        lv_label_set_text(icon, LV_SYMBOL_WIFI);
        lv_obj_set_style_text_color(icon, COL_TEAL, 0);
        lv_obj_set_style_text_font(icon, &lv_font_montserrat_14, 0);
        lv_obj_set_style_pad_right(icon, 8, 0);
        lv_obj_add_flag(icon, LV_OBJ_FLAG_EVENT_BUBBLE);   // pass clicks to parent

        // SSID + signal column
        lv_obj_t *col = lv_obj_create(item);
        lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_flex_grow(col, 1);
        lv_obj_set_size(col, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        lv_obj_set_style_pad_all(col, 0, 0);
        lv_obj_set_style_bg_opa(col, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(col, 0, 0);
        lv_obj_clear_flag(col, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_flag(col, LV_OBJ_FLAG_EVENT_BUBBLE);    // pass clicks to parent

        lv_obj_t *ssid_lbl = lv_label_create(col);
        lv_label_set_text(ssid_lbl, networks[i].ssid.c_str());
        lv_obj_set_style_text_color(ssid_lbl, COL_TEXT, 0);
        lv_obj_set_style_text_font(ssid_lbl, &lv_font_montserrat_14, 0);
        lv_label_set_long_mode(ssid_lbl, LV_LABEL_LONG_DOT);
        lv_obj_set_width(ssid_lbl, 180);
        lv_obj_add_flag(ssid_lbl, LV_OBJ_FLAG_EVENT_BUBBLE);

        // Signal strength text
        char sig[24];
        int bars = 0;
        if (networks[i].rssi > -50) bars = 4;
        else if (networks[i].rssi > -65) bars = 3;
        else if (networks[i].rssi > -75) bars = 2;
        else bars = 1;
        snprintf(sig, sizeof(sig), "%ddB %s", networks[i].rssi,
                 bars >= 4 ? "||||" : bars == 3 ? "|||" : bars == 2 ? "||" : "|");
        lv_obj_t *sig_lbl = lv_label_create(col);
        lv_label_set_text(sig_lbl, sig);
        lv_obj_set_style_text_color(sig_lbl, COL_DIM, 0);
        lv_obj_set_style_text_font(sig_lbl, &lv_font_montserrat_14, 0);
        lv_obj_add_flag(sig_lbl, LV_OBJ_FLAG_EVENT_BUBBLE);

        lv_obj_add_event_cb(item, wifi_item_cb, LV_EVENT_CLICKED, (void*)(intptr_t)i);
        shown++;
    }

    if (shown == 0) {
        add_label(scr, "No WiFi networks\nfound", &lv_font_montserrat_20, COL_DIM, 140);
    }

    // Rescan button at bottom
    lv_obj_t *rescan = lv_btn_create(scr);
    lv_obj_set_size(rescan, 200, 42);
    lv_obj_align(rescan, LV_ALIGN_BOTTOM_MID, 0, -10);
    lv_obj_set_style_bg_color(rescan, COL_CARD, 0);
    lv_obj_set_style_bg_opa(rescan, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(rescan, 12, 0);
    lv_obj_set_style_shadow_width(rescan, 0, 0);
    lv_obj_set_style_border_width(rescan, 0, 0);
    lv_obj_t *rescan_lbl = lv_label_create(rescan);
    lv_label_set_text(rescan_lbl, LV_SYMBOL_REFRESH " Rescan");
    lv_obj_set_style_text_font(rescan_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(rescan_lbl, COL_TEXT, 0);
    lv_obj_center(rescan_lbl);
    lv_obj_add_event_cb(rescan, wifi_rescan_cb, LV_EVENT_CLICKED, NULL);

    lv_scr_load(scr);
    lvgl_unlock();
}

void display_wifiPassword(const char* ssid) {
    if (!lvgl_lock(0)) return;

    ui_wifiPasswordReady = false;
    memset(ui_wifiPassword, 0, sizeof(ui_wifiPassword));

    lv_obj_t *scr = create_screen();

    // Title
    add_label(scr, "Enter Password", &lv_font_montserrat_20, COL_TEAL, 4);

    // SSID label
    char ssidStr[48];
    snprintf(ssidStr, sizeof(ssidStr), "Network: %s", ssid);
    add_label(scr, ssidStr, &lv_font_montserrat_14, COL_DIM, 28);

    // Hint: use phone instead
    add_label(scr, "Or use phone: 10.0.0.1/wifi", &lv_font_montserrat_14, COL_PURPLE, 46);

    // Textarea for password input — NO PASSWORD MASKING (screen is tiny)
    lv_obj_t *ta = lv_textarea_create(scr);
    lv_textarea_set_one_line(ta, true);
    lv_textarea_set_password_mode(ta, false);  // Show plain text
    lv_textarea_set_max_length(ta, 63);
    lv_textarea_set_placeholder_text(ta, "WiFi password");
    lv_obj_set_size(ta, 220, 36);
    lv_obj_align(ta, LV_ALIGN_TOP_MID, 0, 64);
    lv_obj_set_style_bg_color(ta, COL_CARD, 0);
    lv_obj_set_style_bg_opa(ta, LV_OPA_COVER, 0);
    lv_obj_set_style_text_color(ta, COL_TEXT, 0);
    lv_obj_set_style_text_font(ta, &lv_font_montserrat_14, 0);
    lv_obj_set_style_border_color(ta, COL_PURPLE, LV_STATE_FOCUSED);
    lv_obj_set_style_border_width(ta, 2, LV_STATE_FOCUSED);

    // Connect button — between textarea and keyboard
    lv_obj_t *btn = lv_btn_create(scr);
    lv_obj_set_size(btn, 100, 32);
    lv_obj_align(btn, LV_ALIGN_TOP_RIGHT, -10, 104);
    lv_obj_set_style_bg_color(btn, COL_PURPLE, 0);
    lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(btn, 8, 0);
    lv_obj_set_style_shadow_width(btn, 0, 0);
    lv_obj_set_style_border_width(btn, 0, 0);
    lv_obj_t *btn_lbl = lv_label_create(btn);
    lv_label_set_text(btn_lbl, "Connect");
    lv_obj_set_style_text_font(btn_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(btn_lbl, COL_TEXT, 0);
    lv_obj_center(btn_lbl);
    lv_obj_add_event_cb(btn, wifi_connect_cb, LV_EVENT_CLICKED, (void*)ta);

    // LVGL on-screen keyboard — fills bottom portion
    lv_obj_t *kb = lv_keyboard_create(scr);
    lv_obj_set_size(kb, 240, 180);
    lv_obj_align(kb, LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_keyboard_set_textarea(kb, ta);
    lv_obj_set_style_bg_color(kb, lv_color_hex(0x111122), 0);
    lv_obj_set_style_bg_opa(kb, LV_OPA_COVER, 0);
    lv_obj_set_style_text_font(kb, &lv_font_montserrat_14, 0);

    lv_scr_load(scr);
    lvgl_unlock();
}

void display_reprovision(const char* status, int step, int total) {
    if (!lvgl_lock(0)) return;

    lv_obj_t *scr = create_screen();

    // Title
    add_label(scr, "Re-provisioning", &lv_font_montserrat_20, COL_TEAL, 50);

    // Progress bar
    lv_obj_t *bar = lv_bar_create(scr);
    lv_obj_set_size(bar, 200, 16);
    lv_obj_align(bar, LV_ALIGN_CENTER, 0, -10);
    lv_obj_set_style_bg_color(bar, COL_CARD, LV_PART_MAIN);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_bg_color(bar, COL_TEAL, LV_PART_INDICATOR);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, LV_PART_INDICATOR);
    lv_obj_set_style_radius(bar, 8, LV_PART_MAIN);
    lv_obj_set_style_radius(bar, 8, LV_PART_INDICATOR);
    lv_bar_set_range(bar, 0, 100);
    int pct = (total > 0) ? (step * 100 / total) : 0;
    lv_bar_set_value(bar, pct, LV_ANIM_OFF);

    // Step counter
    char stepStr[32];
    snprintf(stepStr, sizeof(stepStr), "Step %d / %d", step, total);
    add_label(scr, stepStr, &lv_font_montserrat_14, COL_DIM, 180);

    // Status text
    lv_obj_t *lbl = lv_label_create(scr);
    lv_label_set_text(lbl, status);
    lv_obj_set_style_text_font(lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(lbl, COL_TEXT, 0);
    lv_obj_set_style_text_align(lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(lbl, SCREEN_W - 30);
    lv_label_set_long_mode(lbl, LV_LABEL_LONG_WRAP);
    lv_obj_align(lbl, LV_ALIGN_CENTER, 0, 40);

    lv_scr_load(scr);
    lvgl_unlock();
}

// ══════════════════════════════════════════════════════════════════════════════
// v2.0: New display functions — Menu, Detect, Firmware Check, Firmware Flash
// ══════════════════════════════════════════════════════════════════════════════

void display_menu(bool sdMounted, bool hasMowerFw, bool hasChargerFw,
                  const char* mowerFwVer, const char* chargerFwVer,
                  bool mowerMqtt, bool chargerMqtt) {
    if (!lvgl_lock(0)) return;
    ui_menuSelection = -1;

    lv_obj_t *scr = create_screen();

    // ── Title bar ──
    lv_obj_t *title = lv_label_create(scr);
    lv_label_set_text(title, "OpenNova Setup");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(title, COL_TEXT, 0);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 10, 6);

    lv_obj_t *ver = lv_label_create(scr);
    lv_label_set_text(ver, "v2.0");
    lv_obj_set_style_text_font(ver, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(ver, COL_DIM, 0);
    lv_obj_align(ver, LV_ALIGN_TOP_RIGHT, -10, 10);

    // ── Menu buttons (4 options) ──
    // Helper: create a menu button with icon, title, subtitle
    struct MenuEntry {
        const char* icon;
        const char* label;
        const char* sub;
        bool enabled;
        int index;
    };

    bool canFlash = (hasMowerFw && mowerMqtt) || (hasChargerFw && chargerMqtt);
    bool canWifi = mowerMqtt || chargerMqtt;

    MenuEntry entries[4] = {
        { LV_SYMBOL_SETTINGS, "Provision + Flash", "Full setup with firmware", true, 0 },
        { LV_SYMBOL_WIFI,     "Provision Only",    "BLE setup, no firmware",   true, 1 },
        { LV_SYMBOL_DOWNLOAD, "Flash Firmware",    "Update connected devices", canFlash, 2 },
        { LV_SYMBOL_HOME,     "Home WiFi Setup",   "Switch to home network",   canWifi, 3 },
    };

    lv_coord_t y = 34;
    for (int i = 0; i < 4; i++) {
        lv_obj_t *btn = lv_btn_create(scr);
        lv_obj_set_size(btn, 220, 54);
        lv_obj_align(btn, LV_ALIGN_TOP_MID, 0, y);
        lv_obj_set_style_bg_color(btn, entries[i].enabled ? COL_PURPLE : COL_GRAY_BTN, 0);
        lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(btn, 10, 0);
        lv_obj_set_style_shadow_width(btn, 0, 0);
        lv_obj_set_style_border_width(btn, 0, 0);
        lv_obj_set_style_pad_left(btn, 12, 0);
        lv_obj_set_style_pad_right(btn, 12, 0);
        lv_obj_set_style_pad_top(btn, 6, 0);
        lv_obj_set_style_pad_bottom(btn, 6, 0);
        lv_obj_set_flex_flow(btn, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(btn, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

        // Icon
        lv_obj_t *ico = lv_label_create(btn);
        lv_label_set_text(ico, entries[i].icon);
        lv_obj_set_style_text_font(ico, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(ico, entries[i].enabled ? COL_TEXT : COL_DIM, 0);
        lv_obj_set_style_pad_right(ico, 10, 0);

        // Text container (title + subtitle stacked)
        lv_obj_t *textCol = lv_obj_create(btn);
        lv_obj_set_size(textCol, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        lv_obj_set_style_bg_opa(textCol, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(textCol, 0, 0);
        lv_obj_set_style_pad_all(textCol, 0, 0);
        lv_obj_set_flex_flow(textCol, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_style_pad_row(textCol, 2, 0);

        // Title
        lv_obj_t *lbl = lv_label_create(textCol);
        lv_label_set_text(lbl, entries[i].label);
        lv_obj_set_style_text_font(lbl, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(lbl, entries[i].enabled ? COL_TEXT : COL_DIM, 0);

        // Subtitle inside button
        lv_obj_t *sub = lv_label_create(textCol);
        lv_label_set_text(sub, entries[i].sub);
        lv_obj_set_style_text_font(sub, &lv_font_montserrat_12, 0);
        lv_obj_set_style_text_color(sub, entries[i].enabled ? lv_color_hex(0xc0c8d0) : COL_DIM, 0);

        if (entries[i].enabled) {
            lv_obj_add_event_cb(btn, menu_btn_cb, LV_EVENT_CLICKED, (void*)(intptr_t)entries[i].index);
        }

        y += 60;  // button height (54) + gap (6)
    }

    // ── Status bar at bottom ──
    // SD + firmware info
    char sdLine[80];
    if (sdMounted) {
        char parts[60] = "";
        if (hasMowerFw) {
            snprintf(parts, sizeof(parts), "Mower %s", mowerFwVer ? mowerFwVer : "?");
        }
        if (hasChargerFw) {
            if (strlen(parts) > 0) strncat(parts, " " LV_SYMBOL_DUMMY " ", sizeof(parts) - strlen(parts) - 1);
            strncat(parts, "Charger ", sizeof(parts) - strlen(parts) - 1);
            strncat(parts, chargerFwVer ? chargerFwVer : LV_SYMBOL_OK, sizeof(parts) - strlen(parts) - 1);
        }
        if (strlen(parts) == 0) {
            snprintf(sdLine, sizeof(sdLine), "SD: mounted, no firmware");
        } else {
            snprintf(sdLine, sizeof(sdLine), "SD: %s", parts);
        }
    } else {
        snprintf(sdLine, sizeof(sdLine), "SD: not mounted");
    }

    lv_obj_t *sd_lbl = lv_label_create(scr);
    lv_label_set_text(sd_lbl, sdLine);
    lv_obj_set_style_text_font(sd_lbl, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(sd_lbl, COL_DIM, 0);
    lv_obj_set_width(sd_lbl, SCREEN_W - 16);
    lv_label_set_long_mode(sd_lbl, LV_LABEL_LONG_DOT);
    lv_obj_align(sd_lbl, LV_ALIGN_BOTTOM_LEFT, 8, -36);

    // Charger status
    char chgLine[48];
    snprintf(chgLine, sizeof(chgLine), "%s Charger: %s",
             chargerMqtt ? LV_SYMBOL_OK : LV_SYMBOL_CLOSE,
             chargerMqtt ? "connected" : "not connected");
    lv_obj_t *chg_lbl = lv_label_create(scr);
    lv_label_set_text(chg_lbl, chgLine);
    lv_obj_set_style_text_font(chg_lbl, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(chg_lbl, chargerMqtt ? COL_GREEN : COL_DIM, 0);
    lv_obj_align(chg_lbl, LV_ALIGN_BOTTOM_LEFT, 8, -22);

    // Mower status
    char mowLine[48];
    snprintf(mowLine, sizeof(mowLine), "%s Mower: %s",
             mowerMqtt ? LV_SYMBOL_OK : LV_SYMBOL_CLOSE,
             mowerMqtt ? "connected" : "not connected");
    lv_obj_t *mow_lbl = lv_label_create(scr);
    lv_label_set_text(mow_lbl, mowLine);
    lv_obj_set_style_text_font(mow_lbl, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(mow_lbl, mowerMqtt ? COL_GREEN : COL_DIM, 0);
    lv_obj_align(mow_lbl, LV_ALIGN_BOTTOM_LEFT, 8, -8);

    lv_scr_load(scr);
    lvgl_unlock();
}

void display_detect(int secondsElapsed, int wifiClients, bool chargerMqtt, bool mowerMqtt) {
    if (!lvgl_lock(0)) return;

    // Create screen only once — update labels on subsequent calls
    if (!detect_scr || lv_scr_act() != detect_scr) {
        detect_scr = create_screen();

        add_label(detect_scr, "Detecting devices...", &lv_font_montserrat_20, COL_TEXT, 30);

        // Spinner
        lv_obj_t *spinner = lv_spinner_create(detect_scr, 1200, 60);
        lv_obj_set_size(spinner, 50, 50);
        lv_obj_align(spinner, LV_ALIGN_CENTER, 0, -30);
        lv_obj_set_style_arc_color(spinner, COL_PURPLE, LV_PART_INDICATOR);
        lv_obj_set_style_arc_color(spinner, COL_CARD, LV_PART_MAIN);
        lv_obj_set_style_arc_width(spinner, 5, LV_PART_INDICATOR);
        lv_obj_set_style_arc_width(spinner, 5, LV_PART_MAIN);

        // Dynamic labels
        detect_time_label = lv_label_create(detect_scr);
        lv_obj_set_style_text_font(detect_time_label, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(detect_time_label, COL_DIM, 0);
        lv_obj_align(detect_time_label, LV_ALIGN_CENTER, 0, 30);

        detect_wifi_label = lv_label_create(detect_scr);
        lv_obj_set_style_text_font(detect_wifi_label, &lv_font_montserrat_14, 0);
        lv_obj_align(detect_wifi_label, LV_ALIGN_LEFT_MID, 20, 60);

        detect_chg_label = lv_label_create(detect_scr);
        lv_obj_set_style_text_font(detect_chg_label, &lv_font_montserrat_14, 0);
        lv_obj_align(detect_chg_label, LV_ALIGN_LEFT_MID, 20, 80);

        detect_mow_label = lv_label_create(detect_scr);
        lv_obj_set_style_text_font(detect_mow_label, &lv_font_montserrat_14, 0);
        lv_obj_align(detect_mow_label, LV_ALIGN_LEFT_MID, 20, 100);

        // Skip button
        add_bottom_btn(detect_scr, "Skip " LV_SYMBOL_RIGHT, generic_btn_cb);

        lv_scr_load(detect_scr);
    }

    // Update dynamic labels
    char timeBuf[32];
    snprintf(timeBuf, sizeof(timeBuf), "%ds elapsed", secondsElapsed);
    lv_label_set_text(detect_time_label, timeBuf);

    char wifiBuf[32];
    snprintf(wifiBuf, sizeof(wifiBuf), LV_SYMBOL_WIFI "  WiFi clients: %d", wifiClients);
    lv_label_set_text(detect_wifi_label, wifiBuf);
    lv_obj_set_style_text_color(detect_wifi_label, wifiClients > 0 ? COL_TEAL : COL_DIM, 0);

    char chgBuf[40];
    snprintf(chgBuf, sizeof(chgBuf), "%s  Charger: %s",
             chargerMqtt ? LV_SYMBOL_OK : LV_SYMBOL_CLOSE,
             chargerMqtt ? "connected" : "waiting...");
    lv_label_set_text(detect_chg_label, chgBuf);
    lv_obj_set_style_text_color(detect_chg_label, chargerMqtt ? COL_GREEN : COL_DIM, 0);

    char mowBuf[40];
    snprintf(mowBuf, sizeof(mowBuf), "%s  Mower: %s",
             mowerMqtt ? LV_SYMBOL_OK : LV_SYMBOL_CLOSE,
             mowerMqtt ? "connected" : "waiting...");
    lv_label_set_text(detect_mow_label, mowBuf);
    lv_obj_set_style_text_color(detect_mow_label, mowerMqtt ? COL_GREEN : COL_DIM, 0);

    lvgl_unlock();
}

void display_firmware_check(bool hasMowerFw, bool hasChargerFw,
                            const char* mowerVer, const char* chargerVer,
                            bool mowerOnline, bool chargerOnline) {
    if (!lvgl_lock(0)) return;
    ui_flashConfirmed = false;
    ui_flashSkipped = false;

    lv_obj_t *scr = create_screen();

    add_label(scr, "Flash Firmware", &lv_font_montserrat_20, COL_ORANGE, 12);

    lv_coord_t y = 48;

    // Mower firmware
    char mowLine[80];
    if (hasMowerFw) {
        snprintf(mowLine, sizeof(mowLine), "%s Mower: %s  %s",
                 LV_SYMBOL_DOWNLOAD,
                 mowerVer ? mowerVer : "?",
                 mowerOnline ? "(online)" : "(offline)");
    } else {
        snprintf(mowLine, sizeof(mowLine), "%s Mower: no firmware on SD", LV_SYMBOL_CLOSE);
    }
    lv_obj_t *mow_lbl = lv_label_create(scr);
    lv_label_set_text(mow_lbl, mowLine);
    lv_obj_set_style_text_font(mow_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(mow_lbl, (hasMowerFw && mowerOnline) ? COL_GREEN : COL_DIM, 0);
    lv_obj_set_width(mow_lbl, SCREEN_W - 20);
    lv_label_set_long_mode(mow_lbl, LV_LABEL_LONG_DOT);
    lv_obj_align(mow_lbl, LV_ALIGN_TOP_LEFT, 10, y);
    y += 28;

    // Charger firmware
    char chgLine[80];
    if (hasChargerFw) {
        snprintf(chgLine, sizeof(chgLine), "%s Charger: %s  %s",
                 LV_SYMBOL_DOWNLOAD,
                 chargerVer ? chargerVer : "ready",
                 chargerOnline ? "(online)" : "(offline)");
    } else {
        snprintf(chgLine, sizeof(chgLine), "%s Charger: no firmware on SD", LV_SYMBOL_CLOSE);
    }
    lv_obj_t *chg_lbl = lv_label_create(scr);
    lv_label_set_text(chg_lbl, chgLine);
    lv_obj_set_style_text_font(chg_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(chg_lbl, (hasChargerFw && chargerOnline) ? COL_GREEN : COL_DIM, 0);
    lv_obj_set_width(chg_lbl, SCREEN_W - 20);
    lv_label_set_long_mode(chg_lbl, LV_LABEL_LONG_DOT);
    lv_obj_align(chg_lbl, LV_ALIGN_TOP_LEFT, 10, y);
    y += 40;

    // Info text
    bool canFlash = (hasMowerFw && mowerOnline) || (hasChargerFw && chargerOnline);
    if (canFlash) {
        add_label(scr, "Ready to flash firmware.\nDevices will reboot.", &lv_font_montserrat_14, COL_TEXT, y);
    } else {
        add_label(scr, "No flashable devices.\nConnect devices first.", &lv_font_montserrat_14, COL_DIM, y);
    }

    // Bottom buttons: Skip + Flash
    lv_obj_t *skip_btn = lv_btn_create(scr);
    lv_obj_set_size(skip_btn, 100, 40);
    lv_obj_align(skip_btn, LV_ALIGN_BOTTOM_LEFT, 16, -16);
    lv_obj_set_style_bg_color(skip_btn, COL_CARD, 0);
    lv_obj_set_style_bg_opa(skip_btn, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(skip_btn, 10, 0);
    lv_obj_set_style_shadow_width(skip_btn, 0, 0);
    lv_obj_set_style_border_width(skip_btn, 0, 0);
    lv_obj_t *skip_lbl = lv_label_create(skip_btn);
    lv_label_set_text(skip_lbl, "Skip");
    lv_obj_set_style_text_font(skip_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(skip_lbl, COL_TEXT, 0);
    lv_obj_center(skip_lbl);
    lv_obj_add_event_cb(skip_btn, flash_skip_cb, LV_EVENT_CLICKED, NULL);

    lv_obj_t *flash_btn = lv_btn_create(scr);
    lv_obj_set_size(flash_btn, 100, 40);
    lv_obj_align(flash_btn, LV_ALIGN_BOTTOM_RIGHT, -16, -16);
    lv_obj_set_style_bg_color(flash_btn, canFlash ? COL_ORANGE : COL_GRAY_BTN, 0);
    lv_obj_set_style_bg_opa(flash_btn, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(flash_btn, 10, 0);
    lv_obj_set_style_shadow_width(flash_btn, 0, 0);
    lv_obj_set_style_border_width(flash_btn, 0, 0);
    lv_obj_t *flash_lbl = lv_label_create(flash_btn);
    lv_label_set_text(flash_lbl, "Flash");
    lv_obj_set_style_text_font(flash_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(flash_lbl, canFlash ? COL_TEXT : COL_DIM, 0);
    lv_obj_center(flash_lbl);
    if (canFlash) {
        lv_obj_add_event_cb(flash_btn, flash_confirm_cb, LV_EVENT_CLICKED, NULL);
    }

    lv_scr_load(scr);
    lvgl_unlock();
}

void display_firmware_flash(const char* device, const char* status, int percent) {
    if (!lvgl_lock(0)) return;

    lv_obj_t *scr = create_screen();

    // Title: "Flashing <device>"
    char title[48];
    snprintf(title, sizeof(title), "Flashing %s", device);
    add_label(scr, title, &lv_font_montserrat_20, COL_ORANGE, 50);

    // Progress bar
    lv_obj_t *bar = lv_bar_create(scr);
    lv_obj_set_size(bar, 200, 16);
    lv_obj_align(bar, LV_ALIGN_CENTER, 0, -10);
    lv_obj_set_style_bg_color(bar, COL_CARD, LV_PART_MAIN);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_bg_color(bar, COL_ORANGE, LV_PART_INDICATOR);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, LV_PART_INDICATOR);
    lv_obj_set_style_radius(bar, 8, LV_PART_MAIN);
    lv_obj_set_style_radius(bar, 8, LV_PART_INDICATOR);
    lv_bar_set_range(bar, 0, 100);
    lv_bar_set_value(bar, percent, LV_ANIM_OFF);

    // Percentage text
    char pctStr[16];
    snprintf(pctStr, sizeof(pctStr), "%d%%", percent);
    add_label(scr, pctStr, &lv_font_montserrat_20, COL_TEXT, 170);

    // Status text
    lv_obj_t *lbl = lv_label_create(scr);
    lv_label_set_text(lbl, status);
    lv_obj_set_style_text_font(lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(lbl, COL_DIM, 0);
    lv_obj_set_style_text_align(lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(lbl, SCREEN_W - 30);
    lv_label_set_long_mode(lbl, LV_LABEL_LONG_WRAP);
    lv_obj_align(lbl, LV_ALIGN_CENTER, 0, 50);

    lv_scr_load(scr);
    lvgl_unlock();
}

// ── Legacy hit-test API (no-ops — LVGL handles touch natively) ──────────────

bool display_btnHit(int16_t x, int16_t y) {
    return ui_btnPressed;
}

int display_hitTest(int16_t x, int16_t y, int deviceCount, bool& startBtnHit) {
    startBtnHit = ui_startPressed;
    return -1;
}

#else
// ── Stub implementations for non-LCD builds ─────────────────────────────────

volatile int  ui_selectedChargerIdx = -1;
volatile int  ui_selectedMowerIdx   = -1;
volatile bool ui_startPressed       = false;
volatile bool ui_btnPressed         = false;
volatile bool ui_rescanPressed     = false;

volatile int  ui_selectedWifiIdx    = -1;
volatile bool ui_wifiPasswordReady  = false;
volatile bool ui_wifiRescanPressed  = false;
char ui_wifiPassword[64]            = {0};
char ui_wifiSsid[33]                = {0};

volatile int  ui_menuSelection      = -1;
volatile bool ui_backPressed        = false;
volatile bool ui_flashConfirmed     = false;
volatile bool ui_flashSkipped       = false;

bool lvgl_lock(int) { return true; }
void lvgl_unlock() {}

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
void display_wifiList(WifiNetwork*, int, int) {}
void display_wifiPassword(const char*) {}
void display_reprovision(const char*, int, int) {}
void display_menu(bool, bool, bool, const char*, const char*, bool, bool) {}
void display_detect(int, int, bool, bool) {}
void display_firmware_check(bool, bool, const char*, const char*, bool, bool) {}
void display_firmware_flash(const char*, const char*, int) {}
bool display_btnHit(int16_t, int16_t) { return false; }
int display_hitTest(int16_t, int16_t, int, bool&) { return -1; }

#endif
