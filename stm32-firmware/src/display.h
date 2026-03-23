#ifndef DISPLAY_H
#define DISPLAY_H

#include <stdint.h>
#include <stdbool.h>

/*
 * Display — ST7789V 240x320 color LCD via SPI2
 *
 * Identified from OEM firmware binary disassembly:
 *   Controller: ST7789V
 *   Resolution: 240x320 (portrait) / 320x240 (landscape)
 *   Color:      RGB565 (16-bit, 65K colors)
 *   Interface:  SPI2 + DC pin (data/command) + RST pin
 *   Frame rate: 60 Hz (FRCTR2 = 0x0F)
 *
 * Default orientation: landscape (320x240), MADCTL = 0x60
 *
 * SPI2 is on APB1 (42 MHz), prescaler /4 = 10.5 MHz SPI clock.
 */

/* Effective display size (after rotation) */
#if DISPLAY_ORIENTATION == 1
#define DISP_W  320U
#define DISP_H  240U
#else
#define DISP_W  240U
#define DISP_H  320U
#endif

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

/* ---- Low-level ST7789V driver ---- */

/* Initialize SPI2, GPIO, and ST7789V controller */
void display_init(void);

/* Write a command byte to ST7789V (DC=0) */
void display_write_cmd(uint8_t cmd);

/* Write data byte(s) to ST7789V (DC=1) */
void display_write_data(const uint8_t *data, uint16_t len);

/* Write a single data byte */
void display_write_data8(uint8_t data);

/* Set the drawing window (column/row address) */
void display_set_window(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1);

/* ---- Drawing primitives ---- */

/* Fill entire display with a single color */
void display_fill(uint16_t color);

/* Clear display (fill with black) */
void display_clear(void);

/* Draw a single pixel */
void display_draw_pixel(uint16_t x, uint16_t y, uint16_t color);

/* Fill a rectangle */
void display_fill_rect(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint16_t color);

/* Draw a horizontal line */
void display_draw_hline(uint16_t x, uint16_t y, uint16_t w, uint16_t color);

/* Draw a vertical line */
void display_draw_vline(uint16_t x, uint16_t y, uint16_t h, uint16_t color);

/* Draw a rectangle outline */
void display_draw_rect(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint16_t color);

/* Draw a filled rounded rectangle */
void display_fill_round_rect(uint16_t x, uint16_t y, uint16_t w, uint16_t h,
                              uint16_t r, uint16_t color);

/* ---- Text rendering (8x16 built-in font) ---- */

/* Draw a single character at pixel position */
void display_draw_char(uint16_t x, uint16_t y, char c, uint16_t fg, uint16_t bg);

/* Draw a string at pixel position */
void display_draw_string(uint16_t x, uint16_t y, const char *str,
                          uint16_t fg, uint16_t bg);

/* Draw a string with 2x scale */
void display_draw_string_2x(uint16_t x, uint16_t y, const char *str,
                              uint16_t fg, uint16_t bg);

/* Draw centered string on a given Y position */
void display_draw_centered(uint16_t y, const char *str, uint16_t fg, uint16_t bg);

/* Draw centered string with 2x scale */
void display_draw_centered_2x(uint16_t y, const char *str, uint16_t fg, uint16_t bg);

/* ---- High-level status display ---- */

/* Show status text on line 0-3 (each line = 16px tall) */
void display_set_line(uint8_t line, const char *text);

/* Show battery level icon (0-100%) */
void display_set_battery(uint8_t soc_pct);

/* Show/hide a status icon */
void display_set_icon(display_icon_t icon, uint8_t visible);

/* Show firmware version */
void display_show_version(void);

/* Show error code prominently */
void display_show_error(uint16_t error_code);

/* ---- Boot animation ---- */

/* Show "OpenNova" boot animation (called once during startup) */
void display_boot_animation(void);

/* Periodic refresh (no-op if not using framebuffer) */
void display_refresh(void);

#endif /* DISPLAY_H */
