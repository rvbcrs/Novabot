#pragma once
#include <stdio.h>
#include <stdbool.h>

#define EXAMPLE_LCD_PIXEL_CLOCK_HZ          (80 * 1000 * 1000)

#define EXAMPLE_PIN_NUM_LCD_SCLK            39
#define EXAMPLE_PIN_NUM_LCD_MOSI            38
#define EXAMPLE_PIN_NUM_LCD_MISO            40
#define EXAMPLE_PIN_NUM_LCD_DC              42
#define EXAMPLE_PIN_NUM_LCD_RST             -1
#define EXAMPLE_PIN_NUM_LCD_CS              45
#define EXAMPLE_LCD_CMD_BITS                8
#define EXAMPLE_LCD_PARAM_BITS              8


#define EXAMPLE_LCD_ROTATION                1
#define EXAMPLE_LCD_H_RES                   240
#define EXAMPLE_LCD_V_RES                   320

#define EXAMPLE_LVGL_TICK_PERIOD_MS         2
#define EXAMPLE_LVGL_TASK_MAX_DELAY_MS      500
#define EXAMPLE_LVGL_TASK_MIN_DELAY_MS      1


void bsp_lv_port_init(void);
void bsp_lv_port_run(void);
bool lvgl_lock(int timeout_ms);
void lvgl_unlock(void);
