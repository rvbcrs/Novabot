#ifndef DISPLAY_H
#define DISPLAY_H

#include <stdint.h>

/*
 * Display — Color LCD via SPI2
 *
 * Minimal status display for debugging and user feedback.
 * OEM firmware uses LVGL for full GUI — we start with basic text/icon display.
 *
 * SPI2 is on APB1 (42 MHz).
 * TODO: LCD controller IC needs identification (likely ST7789 or ILI9341)
 */

/* Display status icons */
typedef enum {
    DISPLAY_ICON_NONE = 0,
    DISPLAY_ICON_CHARGING,
    DISPLAY_ICON_MOWING,
    DISPLAY_ICON_ERROR,
    DISPLAY_ICON_GPS,
    DISPLAY_ICON_LORA,
    DISPLAY_ICON_WIFI
} display_icon_t;

/* Initialize SPI2 and LCD controller */
void display_init(void);

/* Clear display */
void display_clear(void);

/* Show status text (line 0-3) */
void display_set_line(uint8_t line, const char *text);

/* Show battery level (0-100%) */
void display_set_battery(uint8_t soc_pct);

/* Show/hide status icon */
void display_set_icon(display_icon_t icon, uint8_t visible);

/* Show firmware version on display */
void display_show_version(void);

/* Show error code */
void display_show_error(uint16_t error_code);

/* Periodic refresh (call from main loop if needed) */
void display_refresh(void);

#endif /* DISPLAY_H */
