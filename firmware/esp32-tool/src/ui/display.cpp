/**
 * display.cpp — LVGL 8.4 display driver for JC3248W535EN
 *
 * JC3248W535EN (AXS15231B, QSPI, I2C touch, 8MB PSRAM)
 * 320x480 display, rotated 90° → 480x320 logical.
 *
 * Dark theme (#1a1a2e) with purple/teal accents using LVGL widgets.
 */

#include <stdint.h>
#include "display.h"
#include "fonts/fa_icons.h"

#include "jc_bsp.h"
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
volatile bool ui_mqttAddrReady      = false;
char ui_mqttAddr[64]                = {0};

// v2.0: Menu + firmware UI flags

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

#define SCREEN_W 480
#define SCREEN_H 320

// ── LVGL tick period ────────────────────────────────────────────────────────

#define LV_TICK_PERIOD_MS 2
#define LV_TASK_MAX_DELAY_MS 500
#define LV_TASK_MIN_DELAY_MS 1

// ── Style helpers ────────────────────────────────────────────────────────────

// Persistent screens — created once, updated in-place to prevent memory leaks
static lv_obj_t* ds_scr = nullptr;
static lv_obj_t* cf_scr = nullptr;
static lv_obj_t* ff_scr = nullptr;
static lv_obj_t* ds_mwIcon = nullptr;
static lv_obj_t* ds_mwLbl = nullptr;
static lv_obj_t* ds_mwSn = nullptr;
static lv_obj_t* ds_legend = nullptr;
static lv_obj_t* ds_btn = nullptr;
static lv_obj_t* ds_btnLbl = nullptr;

// Persistent MQTT wait labels (forward declarations for create_screen reset)
static lv_obj_t *mqtt_scr = nullptr;
static lv_obj_t *mqtt_chg_label = nullptr;
static lv_obj_t *mqtt_mow_label = nullptr;

// Create a dark base screen
static lv_obj_t *prev_screen = nullptr;

static lv_obj_t* create_screen() {
    // Reset persistent screen pointers
    mqtt_scr = nullptr;
    mqtt_chg_label = nullptr;
    mqtt_mow_label = nullptr;
    ds_scr = nullptr;
    cf_scr = nullptr;
    ff_scr = nullptr;

    // Remember old screen for deletion after new one is loaded
    lv_obj_t *old_screen = prev_screen;

    lv_obj_t *scr = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(scr, COL_BG, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_clear_flag(scr, LV_OBJ_FLAG_SCROLLABLE);
    prev_screen = scr;

    // Delete old screen after loading the new one
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
    lv_obj_set_size(btn, SCREEN_W - 80, 44);
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
    lv_obj_clear_flag(lbl, LV_OBJ_FLAG_CLICKABLE);  // clicks pass through to button

    if (cb) lv_obj_add_event_cb(btn, cb, LV_EVENT_CLICKED, NULL);
    return btn;
}

// Helper: make label in a button click-transparent
static void btn_label_passthrough(lv_obj_t *lbl) {
    lv_obj_clear_flag(lbl, LV_OBJ_FLAG_CLICKABLE);
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

// ── Public API ──────────────────────────────────────────────────────────────

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

// lvgl_lock/unlock — delegates to jc3248w535 library
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

// ── LVGL widget functions ──────────────────────────────────────────────────

void display_boot(const char* version) {
    if (!lvgl_lock(0)) return;

    lv_obj_t *scr = create_screen();

    // OpenNova logo (192px scaled up to ~290px)
    LV_IMG_DECLARE(openova_192);
    lv_obj_t *logo = lv_img_create(scr);
    lv_img_set_src(logo, &openova_192);
    lv_img_set_zoom(logo, 384);  // 256=100%, 384=150%
    lv_obj_align(logo, LV_ALIGN_TOP_MID, 0, -20);

    // Version
    add_label(scr, version, &lv_font_montserrat_14, COL_DIM, 190);

    // Spinner at bottom
    lv_obj_t *spinner = lv_spinner_create(scr, 1000, 60);
    lv_obj_set_size(spinner, 36, 36);
    lv_obj_align(spinner, LV_ALIGN_BOTTOM_MID, 0, -50);
    lv_obj_set_style_arc_color(spinner, COL_PURPLE, LV_PART_INDICATOR);
    lv_obj_set_style_arc_color(spinner, COL_CARD, LV_PART_MAIN);
    lv_obj_set_style_arc_width(spinner, 4, LV_PART_INDICATOR);
    lv_obj_set_style_arc_width(spinner, 4, LV_PART_MAIN);

    // Status label below spinner — updated by display_boot_status()
    lv_obj_t *status = lv_label_create(scr);
    lv_label_set_text(status, "Starting...");
    lv_obj_set_style_text_font(status, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(status, COL_DIM, 0);
    lv_obj_set_style_text_align(status, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(status, SCREEN_W - 40);
    lv_obj_align(status, LV_ALIGN_BOTTOM_MID, 0, -16);

    lv_scr_load(scr);
    lvgl_unlock();
}

static lv_obj_t* _find_boot_status_label() {
    lv_obj_t *scr = lv_scr_act();
    // Last child of boot screen is the status label
    uint32_t cnt = lv_obj_get_child_cnt(scr);
    if (cnt > 0) return lv_obj_get_child(scr, cnt - 1);
    return nullptr;
}

void display_boot_status(const char* status) {
    if (!lvgl_lock(0)) return;
    lv_obj_t *lbl = _find_boot_status_label();
    if (lbl) lv_label_set_text(lbl, status);
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
    lv_obj_set_size(list, SCREEN_W - 16, SCREEN_H - 120);
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
        lv_label_set_text(icon_lbl, results[i].isCharger ? FA_BOLT : FA_ROBOT);
        lv_obj_set_style_text_font(icon_lbl, &fa_icons_28, 0);
        lv_obj_set_style_text_color(icon_lbl, accent, 0);
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
    btn_label_passthrough(rescan_lbl);
    lv_obj_add_event_cb(rescan, rescan_btn_cb, LV_EVENT_CLICKED, NULL);

    // Skip button (center) — allows skipping charger provisioning
    lv_obj_t *skip = lv_btn_create(scr);
    lv_obj_set_size(skip, 100, 42);
    lv_obj_align(skip, LV_ALIGN_BOTTOM_MID, 0, -10);
    lv_obj_set_style_bg_color(skip, lv_color_hex(0x3b3b5c), 0);
    lv_obj_set_style_bg_opa(skip, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(skip, 12, 0);
    lv_obj_set_style_shadow_width(skip, 0, 0);
    lv_obj_set_style_border_width(skip, 0, 0);
    lv_obj_t *skip_lbl = lv_label_create(skip);
    lv_label_set_text(skip_lbl, "Skip");
    lv_obj_set_style_text_font(skip_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(skip_lbl, COL_TEXT, 0);
    lv_obj_center(skip_lbl);
    btn_label_passthrough(skip_lbl);
    lv_obj_add_event_cb(skip, generic_btn_cb, LV_EVENT_CLICKED, NULL);

    // Start button (right)
    lv_obj_t *btn = lv_btn_create(scr);
    lv_obj_set_size(btn, 110, 42);
    lv_obj_align(btn, LV_ALIGN_BOTTOM_RIGHT, -12, -10);
    lv_obj_set_style_bg_color(btn, canStart ? COL_PURPLE : lv_color_hex(0x3b3b5c), 0);
    lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(btn, 12, 0);
    lv_obj_set_style_shadow_width(btn, 0, 0);
    lv_obj_set_style_border_width(btn, 0, 0);
    lv_obj_t *btn_lbl = lv_label_create(btn);
    lv_label_set_text(btn_lbl, "Start " LV_SYMBOL_RIGHT);
    lv_obj_set_style_text_font(btn_lbl, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(btn_lbl, canStart ? COL_TEXT : COL_DIM, 0);
    lv_obj_center(btn_lbl);
    btn_label_passthrough(btn_lbl);
    if (canStart) {
        lv_obj_add_event_cb(btn, start_btn_cb, LV_EVENT_CLICKED, NULL);
    }

    lv_scr_load(scr);
    lvgl_unlock();
}

// Persistent confirm screen labels
static lv_obj_t* cf_title = nullptr;
static lv_obj_t* cf_line1 = nullptr;
static lv_obj_t* cf_line2 = nullptr;
static lv_obj_t* cf_btn = nullptr;
static lv_obj_t* cf_skipBtn = nullptr;

void display_confirm(const char* title, const char* line1, const char* line2, const char* btnText) {
    if (!lvgl_lock(50)) return;

    if (!cf_scr || lv_scr_act() != cf_scr) {
        cf_scr = create_screen();
        ui_btnPressed = false;

        cf_title = lv_label_create(cf_scr);
        lv_obj_set_style_text_font(cf_title, &lv_font_montserrat_20, 0);
        lv_obj_set_style_text_color(cf_title, COL_GREEN, 0);
        lv_obj_set_style_text_align(cf_title, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_set_width(cf_title, SCREEN_W - 40);
        lv_obj_align(cf_title, LV_ALIGN_TOP_MID, 0, 60);

        cf_line1 = lv_label_create(cf_scr);
        lv_obj_set_style_text_font(cf_line1, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(cf_line1, COL_TEXT, 0);
        lv_obj_set_style_text_align(cf_line1, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_set_width(cf_line1, SCREEN_W - 40);
        lv_obj_align(cf_line1, LV_ALIGN_TOP_MID, 0, 110);

        cf_line2 = lv_label_create(cf_scr);
        lv_obj_set_style_text_font(cf_line2, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(cf_line2, COL_TEXT, 0);
        lv_obj_set_style_text_align(cf_line2, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_set_width(cf_line2, SCREEN_W - 40);
        lv_obj_align(cf_line2, LV_ALIGN_TOP_MID, 0, 140);

        // Skip button (left)
        cf_skipBtn = lv_btn_create(cf_scr);
        lv_obj_set_size(cf_skipBtn, 120, 44);
        lv_obj_align(cf_skipBtn, LV_ALIGN_BOTTOM_LEFT, 20, -12);
        lv_obj_set_style_bg_color(cf_skipBtn, lv_color_hex(0x3b3b5c), 0);
        lv_obj_set_style_bg_opa(cf_skipBtn, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(cf_skipBtn, 12, 0);
        lv_obj_set_style_shadow_width(cf_skipBtn, 0, 0);
        lv_obj_set_style_border_width(cf_skipBtn, 0, 0);
        lv_obj_t *skipLbl = lv_label_create(cf_skipBtn);
        lv_label_set_text(skipLbl, "Skip");
        lv_obj_set_style_text_font(skipLbl, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(skipLbl, COL_TEXT, 0);
        lv_obj_center(skipLbl);
        btn_label_passthrough(skipLbl);
        lv_obj_add_event_cb(cf_skipBtn, rescan_btn_cb, LV_EVENT_CLICKED, NULL);
        lv_obj_add_flag(cf_skipBtn, LV_OBJ_FLAG_HIDDEN);  // hidden by default

        // Main action button (right)
        cf_btn = lv_btn_create(cf_scr);
        lv_obj_set_size(cf_btn, SCREEN_W / 2 - 30, 44);
        lv_obj_align(cf_btn, LV_ALIGN_BOTTOM_RIGHT, -20, -12);
        lv_obj_set_style_bg_color(cf_btn, COL_PURPLE, 0);
        lv_obj_set_style_bg_opa(cf_btn, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(cf_btn, 12, 0);
        lv_obj_set_style_shadow_width(cf_btn, 0, 0);
        lv_obj_set_style_border_width(cf_btn, 0, 0);
        lv_obj_t *btnLbl = lv_label_create(cf_btn);
        lv_label_set_text(btnLbl, "");
        lv_obj_set_style_text_font(btnLbl, &lv_font_montserrat_20, 0);
        lv_obj_set_style_text_color(btnLbl, COL_TEXT, 0);
        lv_obj_center(btnLbl);
        btn_label_passthrough(btnLbl);
        lv_obj_add_event_cb(cf_btn, generic_btn_cb, LV_EVENT_CLICKED, NULL);

        lv_scr_load(cf_scr);
    }

    // Update text in-place
    lv_label_set_text(cf_title, title ? title : "");
    lv_label_set_text(cf_line1, line1 ? line1 : "");
    lv_label_set_text(cf_line2, line2 ? line2 : "");

    // Show/hide main button based on text, Skip always visible
    lv_obj_clear_flag(cf_skipBtn, LV_OBJ_FLAG_HIDDEN);
    if (btnText && strlen(btnText) > 0) {
        lv_obj_clear_flag(cf_btn, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(lv_obj_get_child(cf_btn, 0), btnText);
    } else {
        lv_obj_add_flag(cf_btn, LV_OBJ_FLAG_HIDDEN);
    }

    lvgl_unlock();
}

static lv_obj_t* ds_mwVer = nullptr;
static lv_obj_t* ds_spinner = nullptr;

void display_deviceStatus(int chargerStatus, const char* chargerSn,
                          int mowerStatus, const char* mowerSn,
                          const char* mowerVersion, bool canContinue) {
    if (!lvgl_lock(50)) return;  // Short timeout — don't block LVGL animations

    auto statusColor = [](int s) -> lv_color_t {
        if (s >= 2) return lv_color_hex(0x34D399); // green
        if (s >= 1) return lv_color_hex(0xF59E0B); // orange
        return lv_color_hex(0x4B5563);              // grey
    };

    // Create screen ONCE, then just update colors/text on subsequent calls
    if (!ds_scr || lv_scr_act() != ds_scr) {
        ds_scr = create_screen();
        ui_btnPressed = false;

        add_label(ds_scr, "Device Status", &lv_font_montserrat_20, COL_GREEN, 20);

        int mwY = 20;
        LV_IMG_DECLARE(OpenNova_Icon_2);
        ds_mwIcon = lv_img_create(ds_scr);
        lv_img_set_src(ds_mwIcon, &OpenNova_Icon_2);
        lv_img_set_zoom(ds_mwIcon, 60);  // 486px → ~115px (~24%)
        lv_obj_align(ds_mwIcon, LV_ALIGN_TOP_MID, 0, -50);

        int infoY = 140;  // Below the icon
        ds_mwLbl = lv_label_create(ds_scr);
        lv_label_set_text(ds_mwLbl, "Mower");
        lv_obj_set_style_text_font(ds_mwLbl, &lv_font_montserrat_20, 0);
        lv_obj_align(ds_mwLbl, LV_ALIGN_TOP_MID, 0, infoY);

        ds_mwSn = lv_label_create(ds_scr);
        lv_label_set_text(ds_mwSn, "...");
        lv_obj_set_style_text_font(ds_mwSn, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(ds_mwSn, lv_color_hex(0x9CA3AF), 0);
        lv_obj_align(ds_mwSn, LV_ALIGN_TOP_MID, 0, infoY + 25);

        ds_mwVer = lv_label_create(ds_scr);
        lv_label_set_text(ds_mwVer, "");
        lv_obj_set_style_text_font(ds_mwVer, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(ds_mwVer, lv_color_hex(0xA78BFA), 0);
        lv_obj_set_style_text_align(ds_mwVer, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_set_width(ds_mwVer, SCREEN_W - 40);
        lv_obj_align(ds_mwVer, LV_ALIGN_TOP_MID, 0, infoY + 43);

        // Spinner — shown while waiting for mower connection
        ds_spinner = lv_spinner_create(ds_scr, 1200, 60);
        lv_obj_set_size(ds_spinner, 30, 30);
        lv_obj_align(ds_spinner, LV_ALIGN_TOP_MID, 0, infoY + 65);
        lv_obj_set_style_arc_color(ds_spinner, COL_PURPLE, LV_PART_INDICATOR);
        lv_obj_set_style_arc_color(ds_spinner, COL_CARD, LV_PART_MAIN);
        lv_obj_set_style_arc_width(ds_spinner, 3, LV_PART_INDICATOR);
        lv_obj_set_style_arc_width(ds_spinner, 3, LV_PART_MAIN);

        // Legend removed — status is shown in the Mower label text instead

        // Scan button (left) — manual BLE scan
        lv_obj_t *scanBtn = lv_btn_create(ds_scr);
        lv_obj_set_size(scanBtn, 120, 40);
        lv_obj_align(scanBtn, LV_ALIGN_BOTTOM_LEFT, 20, -10);
        lv_obj_set_style_bg_color(scanBtn, lv_color_hex(0x3b3b5c), 0);
        lv_obj_set_style_bg_opa(scanBtn, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(scanBtn, 8, 0);
        lv_obj_set_style_shadow_width(scanBtn, 0, 0);
        lv_obj_set_style_border_width(scanBtn, 0, 0);
        lv_obj_t *scanLbl = lv_label_create(scanBtn);
        lv_label_set_text(scanLbl, LV_SYMBOL_BLUETOOTH " Scan");
        lv_obj_set_style_text_font(scanLbl, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(scanLbl, COL_TEXT, 0);
        lv_obj_center(scanLbl);
        btn_label_passthrough(scanLbl);
        lv_obj_add_event_cb(scanBtn, rescan_btn_cb, LV_EVENT_CLICKED, NULL);

        // Continue button (right)
        ds_btn = lv_btn_create(ds_scr);
        lv_obj_set_size(ds_btn, SCREEN_W / 2 - 30, 40);
        lv_obj_align(ds_btn, LV_ALIGN_BOTTOM_RIGHT, -20, -10);
        lv_obj_set_style_radius(ds_btn, 8, 0);
        lv_obj_set_style_shadow_width(ds_btn, 0, 0);
        lv_obj_set_style_border_width(ds_btn, 0, 0);
        // Start inactive — enabled when mower connects
        lv_obj_set_style_bg_color(ds_btn, lv_color_hex(0x374151), 0);
        lv_obj_clear_flag(ds_btn, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_event_cb(ds_btn, generic_btn_cb, LV_EVENT_CLICKED, NULL);
        ds_btnLbl = lv_label_create(ds_btn);
        lv_label_set_text(ds_btnLbl, "Continue");
        lv_obj_set_style_text_color(ds_btnLbl, lv_color_hex(0x6B7280), 0);
        lv_obj_center(ds_btnLbl);
        btn_label_passthrough(ds_btnLbl);

        lv_scr_load(ds_scr);
    }

    // Only update if something changed — prevents LVGL memory churn
    static int prevMwStatus = -1;
    static bool prevCanContinue = false;
    static String prevSn = "";
    static String prevVer = "";

    bool statusChanged = (mowerStatus != prevMwStatus);
    bool continueChanged = (canContinue != prevCanContinue);
    bool snChanged = (String(mowerSn ? mowerSn : "") != prevSn);
    bool verChanged = (String(mowerVersion ? mowerVersion : "") != prevVer);
    // Version display depends on status (shows "Stock firmware" when connected but no version)
    if (statusChanged) verChanged = true;

    if (!statusChanged && !continueChanged && !snChanged && !verChanged) {
        lvgl_unlock();
        return;
    }

    if (statusChanged) {
        prevMwStatus = mowerStatus;
        lv_color_t mwCol = statusColor(mowerStatus);
        if (mowerStatus >= 2) {
            lv_obj_set_style_img_recolor(ds_mwIcon, lv_color_hex(0x34D399), 0);  // green
            lv_obj_set_style_img_recolor_opa(ds_mwIcon, LV_OPA_20, 0);  // subtle
        } else if (mowerStatus == 1) {
            lv_obj_set_style_img_recolor(ds_mwIcon, lv_color_hex(0xF59E0B), 0);
            lv_obj_set_style_img_recolor_opa(ds_mwIcon, LV_OPA_40, 0);
        } else {
            lv_obj_set_style_img_recolor(ds_mwIcon, lv_color_hex(0x4B5563), 0);
            lv_obj_set_style_img_recolor_opa(ds_mwIcon, LV_OPA_70, 0);
        }
        lv_obj_set_style_text_color(ds_mwLbl, mwCol, 0);
        if (mowerStatus >= 2) {
            lv_label_set_text(ds_mwLbl, "Mower (MQTT)");
        } else if (mowerStatus == 1) {
            lv_label_set_text(ds_mwLbl, "Mower (WiFi)");
        } else {
            lv_label_set_text(ds_mwLbl, "Mower (Not Connected)");
        }

        if (mowerStatus < 2) {
            lv_obj_clear_flag(ds_spinner, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(ds_spinner, LV_OBJ_FLAG_HIDDEN);
        }
    }

    if (snChanged) {
        prevSn = String(mowerSn ? mowerSn : "");
        lv_label_set_text(ds_mwSn, prevSn.length() > 0 ? prevSn.c_str() : "Waiting...");
    }

    if (verChanged) {
        prevVer = String(mowerVersion ? mowerVersion : "");
        if (prevVer.length() > 0) {
            lv_label_set_text(ds_mwVer, prevVer.c_str());
        } else if (mowerStatus >= 2) {
            lv_label_set_text(ds_mwVer, "Stock firmware");
        } else {
            lv_label_set_text(ds_mwVer, "");
        }
    }

    if (continueChanged) {
        prevCanContinue = canContinue;
        if (canContinue) {
            lv_obj_set_style_bg_color(ds_btn, COL_TEAL, 0);
            lv_obj_add_flag(ds_btn, LV_OBJ_FLAG_CLICKABLE);
            lv_obj_set_style_text_color(ds_btnLbl, lv_color_hex(0xFFFFFF), 0);
        } else {
            lv_obj_set_style_bg_color(ds_btn, lv_color_hex(0x374151), 0);
            lv_obj_clear_flag(ds_btn, LV_OBJ_FLAG_CLICKABLE);
            lv_obj_set_style_text_color(ds_btnLbl, lv_color_hex(0x6B7280), 0);
        }
    }

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
    lv_obj_set_size(bar, SCREEN_W - 80, 16);
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

#include <math.h>

#define RND(min, max) random(min, max + 1)

// ── Veilige LVGL Callbacks ───────────────────────────────────────────────────

static void unhide_anim_cb(lv_anim_t * a) {
    if (a && a->var) lv_obj_clear_flag((lv_obj_t*)a->var, LV_OBJ_FLAG_HIDDEN);
}

static void delete_async_cb(lv_anim_t * a) {
    // async delete voorkomt crashes in de LVGL animatie loop!
    if (a && a->var) lv_obj_del_async((lv_obj_t*)a->var);
}

// ── De Animatie Functie ──────────────────────────────────────────────────────

void display_done() {
    if (!lvgl_lock(0)) return;
    ui_btnPressed = false;

    lv_obj_t *scr = create_screen();

    // UI Elementen op de achtergrond
    lv_obj_t *check = lv_label_create(scr);
    lv_label_set_text(check, LV_SYMBOL_OK);
    lv_obj_set_style_text_font(check, &lv_font_montserrat_28, 0);
    lv_obj_set_style_text_color(check, COL_GREEN, 0);
    lv_obj_align(check, LV_ALIGN_CENTER, 0, -40);

    add_label(scr, "Done!", &lv_font_montserrat_28, COL_GREEN, 150);
    add_label(scr, "All devices provisioned", &lv_font_montserrat_14, lv_color_hex(0x9CA3AF), 185);
    add_bottom_btn(scr, LV_SYMBOL_REFRESH " Restart", generic_btn_cb);

    static const lv_color_t cc[] = {
        lv_color_hex(0x34D399), lv_color_hex(0x818CF8), lv_color_hex(0xF59E0B),
        lv_color_hex(0xEC4899), lv_color_hex(0x06B6D4), lv_color_hex(0xEF4444),
        lv_color_hex(0xA78BFA), lv_color_hex(0x10B981), lv_color_hex(0xFBBF24)
    };

    // ── Subtiele Confetti (8 stuks) ──────────────────────────────────────────
    for (int c = 0; c < 8; c++) {
        lv_obj_t *dot = lv_obj_create(scr);
        lv_obj_remove_style_all(dot);
        lv_obj_clear_flag(dot, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_flag(dot, LV_OBJ_FLAG_HIDDEN); // Onzichtbaar tot start!
        
        int sz = RND(6, 12); 
        lv_obj_set_size(dot, sz, sz);
        lv_obj_set_style_radius(dot, sz / 2, 0);
        lv_obj_set_style_bg_color(dot, cc[RND(0, 8)], 0);
        lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);

        int startX = RND(20, SCREEN_W - 20);
        int targetX = startX + RND(-60, 60);
        int targetY = RND(60, SCREEN_H / 2 + 50);
        int delay = RND(0, 4000); 
        int dur = RND(1500, 2500);

        lv_obj_set_pos(dot, startX, SCREEN_H + 10);

        lv_anim_t aX; lv_anim_init(&aX);
        lv_anim_set_var(&aX, dot);
        lv_anim_set_exec_cb(&aX, [](void* o, int32_t v) { lv_obj_set_x((lv_obj_t*)o, v); });
        lv_anim_set_values(&aX, startX, targetX);
        lv_anim_set_time(&aX, dur);
        lv_anim_set_delay(&aX, delay);
        lv_anim_set_path_cb(&aX, lv_anim_path_ease_out);
        lv_anim_set_start_cb(&aX, unhide_anim_cb); // Haal HIDDEN eraf bij start
        lv_anim_start(&aX);

        lv_anim_t aY; lv_anim_init(&aY);
        lv_anim_set_var(&aY, dot);
        lv_anim_set_exec_cb(&aY, [](void* o, int32_t v) { lv_obj_set_y((lv_obj_t*)o, v); });
        lv_anim_set_values(&aY, SCREEN_H + 10, targetY);
        lv_anim_set_time(&aY, dur);
        lv_anim_set_delay(&aY, delay);
        lv_anim_set_path_cb(&aY, lv_anim_path_ease_out);
        lv_anim_start(&aY);

        lv_anim_t aFade; lv_anim_init(&aFade);
        lv_anim_set_var(&aFade, dot);
        lv_anim_set_exec_cb(&aFade, [](void* o, int32_t v) { lv_obj_set_style_opa((lv_obj_t*)o, v, 0); });
        lv_anim_set_values(&aFade, 255, 0);
        lv_anim_set_time(&aFade, dur / 2); 
        lv_anim_set_delay(&aFade, delay + (dur / 2));
        lv_anim_set_ready_cb(&aFade, delete_async_cb); // SAFE delete
        lv_anim_start(&aFade);
    }

    // ── Langdurig Vuurwerk (5 Pijlen verdeeld over ~9 sec) ───────────────────
    int fwBaseDelay = 300;
    
    for (int fw = 0; fw < 5; fw++) {
        fwBaseDelay += RND(1000, 2200); // Bouw willekeurige tussentijd op
        
        int fwX = RND(50, SCREEN_W - 50);
        int fwY = RND(40, SCREEN_H / 2); 
        lv_color_t themeColor = cc[RND(0, 8)];

        // 1. De Vuurpijl (Rocket)
        lv_obj_t *rocket = lv_obj_create(scr);
        lv_obj_remove_style_all(rocket);
        lv_obj_clear_flag(rocket, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_flag(rocket, LV_OBJ_FLAG_HIDDEN); // Onzichtbaar tot afvuurmoment
        
        lv_obj_set_size(rocket, 4, 12);
        lv_obj_set_style_radius(rocket, 2, 0);
        lv_obj_set_style_bg_color(rocket, lv_color_hex(0xFFDDaa), 0);
        lv_obj_set_style_bg_opa(rocket, LV_OPA_COVER, 0);
        lv_obj_set_pos(rocket, fwX, SCREEN_H);

        int flyTime = RND(500, 800);
        lv_anim_t rUp; lv_anim_init(&rUp);
        lv_anim_set_var(&rUp, rocket);
        lv_anim_set_exec_cb(&rUp, [](void* o, int32_t v) { lv_obj_set_y((lv_obj_t*)o, v); });
        lv_anim_set_values(&rUp, SCREEN_H, fwY);
        lv_anim_set_time(&rUp, flyTime);
        lv_anim_set_delay(&rUp, fwBaseDelay);
        lv_anim_set_path_cb(&rUp, lv_anim_path_ease_in_out);
        lv_anim_set_start_cb(&rUp, unhide_anim_cb); // Raket verschijnt precies nu
        lv_anim_set_ready_cb(&rUp, delete_async_cb); // Raket klapt en verdwijnt (SAFE)
        lv_anim_start(&rUp);

        // 2. De Explosie (Sparks)
        int burstDelay = fwBaseDelay + flyTime - 20; 
        int num_sparks = RND(9, 12); 

        for (int p = 0; p < num_sparks; p++) {
            lv_obj_t *spark = lv_obj_create(scr);
            lv_obj_remove_style_all(spark);
            lv_obj_clear_flag(spark, LV_OBJ_FLAG_CLICKABLE);
            lv_obj_add_flag(spark, LV_OBJ_FLAG_HIDDEN); // Onzichtbaar tot de knal!
            
            int ssz = RND(4, 7);
            lv_obj_set_size(spark, ssz, ssz);
            lv_obj_set_style_radius(spark, ssz / 2, 0);
            lv_obj_set_style_bg_color(spark, p % 3 == 0 ? lv_color_hex(0xFFFFFF) : themeColor, 0);
            lv_obj_set_style_bg_opa(spark, LV_OPA_COVER, 0);
            lv_obj_set_pos(spark, fwX, fwY);

            float angle = (p * (3.14159265f * 2.0f)) / num_sparks;
            angle += (RND(-50, 50) / 100.0f); 
            
            int radius = RND(50, 100);
            int ex = (int)(cos(angle) * radius);
            int ey = (int)(sin(angle) * radius);
            int gravity = RND(40, 90); 

            int sparkDur = RND(800, 1300);

            lv_anim_t aeX; lv_anim_init(&aeX);
            lv_anim_set_var(&aeX, spark);
            lv_anim_set_exec_cb(&aeX, [](void* o, int32_t v) { lv_obj_set_x((lv_obj_t*)o, v); });
            lv_anim_set_values(&aeX, fwX, fwX + ex);
            lv_anim_set_time(&aeX, sparkDur);
            lv_anim_set_delay(&aeX, burstDelay);
            lv_anim_set_path_cb(&aeX, lv_anim_path_ease_out);
            lv_anim_set_start_cb(&aeX, unhide_anim_cb); // Vonk verschijnt precies bij de knal
            lv_anim_start(&aeX);

            lv_anim_t aeY; lv_anim_init(&aeY);
            lv_anim_set_var(&aeY, spark);
            lv_anim_set_exec_cb(&aeY, [](void* o, int32_t v) { lv_obj_set_y((lv_obj_t*)o, v); });
            lv_anim_set_values(&aeY, fwY, fwY + ey + gravity); 
            lv_anim_set_time(&aeY, sparkDur);
            lv_anim_set_delay(&aeY, burstDelay);
            lv_anim_set_path_cb(&aeY, lv_anim_path_ease_out);
            lv_anim_start(&aeY);

            lv_anim_t aFade; lv_anim_init(&aFade);
            lv_anim_set_var(&aFade, spark);
            lv_anim_set_exec_cb(&aFade, [](void* o, int32_t v) { lv_obj_set_style_opa((lv_obj_t*)o, v, 0); });
            lv_anim_set_values(&aFade, 255, 0);
            lv_anim_set_time(&aFade, sparkDur - 100); 
            lv_anim_set_delay(&aFade, burstDelay + 100);
            lv_anim_set_ready_cb(&aFade, delete_async_cb); // SAFE delete
            lv_anim_start(&aFade);
        }
    }

    lv_scr_load(scr);
    lvgl_unlock();
}

void display_error(const char* msg) {
    if (!lvgl_lock(0)) return;
    ui_btnPressed = false;

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
    btn_label_passthrough(retry_lbl);
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
    btn_label_passthrough(menu_lbl);
    lv_obj_add_event_cb(menu_btn, generic_btn_cb, LV_EVENT_CLICKED, NULL);

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
    lv_obj_set_size(list, SCREEN_W - 16, SCREEN_H - 100);
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
    lv_obj_set_size(rescan, SCREEN_W - 80, 42);
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
    btn_label_passthrough(rescan_lbl);
    lv_obj_add_event_cb(rescan, wifi_rescan_cb, LV_EVENT_CLICKED, NULL);

    lv_scr_load(scr);
    lvgl_unlock();
}

// Generic text entry screen — used for SSID, password, and MQTT address
// Callback writes to ui_wifiPassword[] and sets ui_wifiPasswordReady (reused for all fields)
void display_textEntry(const char* title, const char* subtitle,
                       const char* placeholder, const char* btnText) {
    if (!lvgl_lock(0)) return;

    ui_wifiPasswordReady = false;
    memset(ui_wifiPassword, 0, sizeof(ui_wifiPassword));

    int w = SCREEN_W - 40;  // content width with 20px margin each side

    lv_obj_t *scr = create_screen();

    add_label(scr, title, &lv_font_montserrat_20, COL_TEAL, 4);
    if (subtitle && subtitle[0]) {
        add_label(scr, subtitle, &lv_font_montserrat_14, COL_DIM, 28);
    }
    add_label(scr, "Or use browser: 10.0.0.1", &lv_font_montserrat_14, COL_PURPLE, 46);

    lv_obj_t *ta = lv_textarea_create(scr);
    lv_textarea_set_one_line(ta, true);
    lv_textarea_set_password_mode(ta, false);
    lv_textarea_set_max_length(ta, 63);
    lv_textarea_set_placeholder_text(ta, placeholder);
    lv_obj_set_size(ta, w - 110, 36);  // leave room for button
    lv_obj_align(ta, LV_ALIGN_TOP_LEFT, 20, 64);
    lv_obj_set_style_bg_color(ta, COL_CARD, 0);
    lv_obj_set_style_bg_opa(ta, LV_OPA_COVER, 0);
    lv_obj_set_style_text_color(ta, COL_TEXT, 0);
    lv_obj_set_style_text_font(ta, &lv_font_montserrat_14, 0);
    lv_obj_set_style_border_color(ta, COL_PURPLE, LV_STATE_FOCUSED);
    lv_obj_set_style_border_width(ta, 2, LV_STATE_FOCUSED);

    lv_obj_t *btn = lv_btn_create(scr);
    lv_obj_set_size(btn, 100, 36);
    lv_obj_align(btn, LV_ALIGN_TOP_RIGHT, -20, 64);
    lv_obj_set_style_bg_color(btn, COL_PURPLE, 0);
    lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(btn, 8, 0);
    lv_obj_set_style_shadow_width(btn, 0, 0);
    lv_obj_set_style_border_width(btn, 0, 0);
    lv_obj_t *btn_lbl = lv_label_create(btn);
    lv_label_set_text(btn_lbl, btnText);
    lv_obj_set_style_text_font(btn_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(btn_lbl, COL_TEXT, 0);
    lv_obj_center(btn_lbl);
    btn_label_passthrough(btn_lbl);
    lv_obj_add_event_cb(btn, wifi_connect_cb, LV_EVENT_CLICKED, (void*)ta);

    lv_obj_t *kb = lv_keyboard_create(scr);
    lv_obj_set_size(kb, SCREEN_W, SCREEN_H - 106);
    lv_obj_align(kb, LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_keyboard_set_textarea(kb, ta);
    lv_obj_set_style_bg_color(kb, lv_color_hex(0x111122), 0);
    lv_obj_set_style_bg_opa(kb, LV_OPA_COVER, 0);
    lv_obj_set_style_text_font(kb, &lv_font_montserrat_14, 0);

    lv_scr_load(scr);
    lvgl_unlock();
}

void display_wifiPassword(const char* ssid) {
    char sub[64];
    snprintf(sub, sizeof(sub), "Network: %s", ssid);
    display_textEntry("Enter Password", sub, "WiFi password", "Next");
}

static void mqtt_save_cb(lv_event_t *e) {
    lv_obj_t *ta = (lv_obj_t *)lv_event_get_user_data(e);
    const char *txt = lv_textarea_get_text(ta);
    strncpy(ui_mqttAddr, txt, sizeof(ui_mqttAddr) - 1);
    ui_mqttAddr[sizeof(ui_mqttAddr) - 1] = '\0';
    ui_mqttAddrReady = true;
}

void display_mqttAddr() {
    // Reuse the text entry helper but with mqtt_save_cb instead of wifi_connect_cb
    if (!lvgl_lock(0)) return;

    ui_mqttAddrReady = false;
    memset(ui_mqttAddr, 0, sizeof(ui_mqttAddr));

    int w = SCREEN_W - 40;

    lv_obj_t *scr = create_screen();

    add_label(scr, "MQTT Server", &lv_font_montserrat_20, COL_TEAL, 4);
    add_label(scr, "Enter your server IP address", &lv_font_montserrat_14, COL_DIM, 28);
    add_label(scr, "Or use browser: 10.0.0.1", &lv_font_montserrat_14, COL_PURPLE, 46);

    lv_obj_t *ta = lv_textarea_create(scr);
    lv_textarea_set_one_line(ta, true);
    lv_textarea_set_password_mode(ta, false);
    lv_textarea_set_max_length(ta, 63);
    lv_textarea_set_placeholder_text(ta, "e.g. 192.168.0.177");
    lv_obj_set_size(ta, w - 110, 36);
    lv_obj_align(ta, LV_ALIGN_TOP_LEFT, 20, 64);
    lv_obj_set_style_bg_color(ta, COL_CARD, 0);
    lv_obj_set_style_bg_opa(ta, LV_OPA_COVER, 0);
    lv_obj_set_style_text_color(ta, COL_TEXT, 0);
    lv_obj_set_style_text_font(ta, &lv_font_montserrat_14, 0);
    lv_obj_set_style_border_color(ta, COL_PURPLE, LV_STATE_FOCUSED);
    lv_obj_set_style_border_width(ta, 2, LV_STATE_FOCUSED);

    lv_obj_t *btn = lv_btn_create(scr);
    lv_obj_set_size(btn, 100, 36);
    lv_obj_align(btn, LV_ALIGN_TOP_RIGHT, -20, 64);
    lv_obj_set_style_bg_color(btn, COL_PURPLE, 0);
    lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(btn, 8, 0);
    lv_obj_set_style_shadow_width(btn, 0, 0);
    lv_obj_set_style_border_width(btn, 0, 0);
    lv_obj_t *btn_lbl = lv_label_create(btn);
    lv_label_set_text(btn_lbl, "Save");
    lv_obj_set_style_text_font(btn_lbl, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(btn_lbl, COL_TEXT, 0);
    lv_obj_center(btn_lbl);
    btn_label_passthrough(btn_lbl);
    lv_obj_add_event_cb(btn, mqtt_save_cb, LV_EVENT_CLICKED, (void*)ta);

    lv_obj_t *kb = lv_keyboard_create(scr);
    lv_obj_set_size(kb, SCREEN_W, SCREEN_H - 106);
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
    lv_obj_set_size(bar, SCREEN_W - 80, 16);
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

// Persistent firmware flash screen labels
static lv_obj_t* ff_title = nullptr;
static lv_obj_t* ff_bar = nullptr;
static lv_obj_t* ff_pct = nullptr;
static lv_obj_t* ff_status = nullptr;

void display_firmware_flash(const char* device, const char* status, int percent) {
    if (!lvgl_lock(50)) return;

    if (!ff_scr || lv_scr_act() != ff_scr) {
        ff_scr = create_screen();

        ff_title = lv_label_create(ff_scr);
        lv_obj_set_style_text_font(ff_title, &lv_font_montserrat_20, 0);
        lv_obj_set_style_text_color(ff_title, COL_ORANGE, 0);
        lv_obj_set_style_text_align(ff_title, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_set_width(ff_title, SCREEN_W - 40);
        lv_obj_align(ff_title, LV_ALIGN_TOP_MID, 0, 50);

        ff_bar = lv_bar_create(ff_scr);
        lv_obj_set_size(ff_bar, SCREEN_W - 80, 16);
        lv_obj_align(ff_bar, LV_ALIGN_CENTER, 0, -10);
        lv_obj_set_style_bg_color(ff_bar, COL_CARD, LV_PART_MAIN);
        lv_obj_set_style_bg_opa(ff_bar, LV_OPA_COVER, LV_PART_MAIN);
        lv_obj_set_style_bg_color(ff_bar, COL_ORANGE, LV_PART_INDICATOR);
        lv_obj_set_style_bg_opa(ff_bar, LV_OPA_COVER, LV_PART_INDICATOR);
        lv_obj_set_style_radius(ff_bar, 8, LV_PART_MAIN);
        lv_obj_set_style_radius(ff_bar, 8, LV_PART_INDICATOR);
        lv_bar_set_range(ff_bar, 0, 100);

        ff_pct = lv_label_create(ff_scr);
        lv_obj_set_style_text_font(ff_pct, &lv_font_montserrat_20, 0);
        lv_obj_set_style_text_color(ff_pct, COL_TEXT, 0);
        lv_obj_set_style_text_align(ff_pct, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_set_width(ff_pct, SCREEN_W - 40);
        lv_obj_align(ff_pct, LV_ALIGN_TOP_MID, 0, 170);

        ff_status = lv_label_create(ff_scr);
        lv_obj_set_style_text_font(ff_status, &lv_font_montserrat_14, 0);
        lv_obj_set_style_text_color(ff_status, COL_DIM, 0);
        lv_obj_set_style_text_align(ff_status, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_set_width(ff_status, SCREEN_W - 30);
        lv_label_set_long_mode(ff_status, LV_LABEL_LONG_WRAP);
        lv_obj_align(ff_status, LV_ALIGN_CENTER, 0, 50);

        lv_scr_load(ff_scr);
    }

    // Update in-place
    char title[48];
    snprintf(title, sizeof(title), "Flashing %s", device);
    lv_label_set_text(ff_title, title);

    lv_bar_set_value(ff_bar, percent, LV_ANIM_OFF);

    char pctStr[16];
    snprintf(pctStr, sizeof(pctStr), "%d%%", percent);
    lv_label_set_text(ff_pct, pctStr);

    lv_label_set_text(ff_status, status);

    lvgl_unlock();
}

