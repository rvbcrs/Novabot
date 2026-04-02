/**
 * jc_bsp.h — Board Support Package for JC3248W535 (AXS15231B QSPI display)
 *
 * Adapted from demo code: DEMO_LVGL/esp_bsp.h + DEMO_LVGL/display.h
 * Only compiled when -DJC3248W535 is set.
 *
 * SPDX-FileCopyrightText: 2022-2024 Espressif Systems (Shanghai) CO LTD
 * SPDX-License-Identifier: Apache-2.0
 */

#pragma once

#ifdef JC3248W535

#include "sdkconfig.h"
#include "driver/gpio.h"
#include "driver/i2c.h"
#include "lvgl.h"
#include "lv_port.h"

// ── Display resolution ───────────────────────────────────────────────────────

#define JC_LCD_H_RES      (320)
#define JC_LCD_V_RES      (480)

// ── LCD color format ─────────────────────────────────────────────────────────

#define BSP_LCD_BITS_PER_PIXEL  (16)

// ── QSPI host ────────────────────────────────────────────────────────────────

#define JC_LCD_QSPI_HOST    (SPI2_HOST)

// ── Pin definitions (from platformio.ini -D flags) ───────────────────────────

#ifndef LCD_CS
#define LCD_CS   45
#endif
#ifndef LCD_SCK
#define LCD_SCK  47
#endif
#ifndef LCD_SDA0
#define LCD_SDA0 21
#endif
#ifndef LCD_SDA1
#define LCD_SDA1 48
#endif
#ifndef LCD_SDA2
#define LCD_SDA2 40
#endif
#ifndef LCD_SDA3
#define LCD_SDA3 39
#endif
#ifndef LCD_TE
#define LCD_TE   38
#endif
#ifndef LCD_RST
#define LCD_RST  -1
#endif
#ifndef LCD_BL
#define LCD_BL    1
#endif

#ifndef TOUCH_SDA
#define TOUCH_SDA  4
#endif
#ifndef TOUCH_SCL
#define TOUCH_SCL  8
#endif
#ifndef TOUCH_INT
#define TOUCH_INT  3
#endif
#ifndef TOUCH_RST
#define TOUCH_RST -1
#endif

// ── BSP I2C ──────────────────────────────────────────────────────────────────

#define BSP_I2C_NUM             (I2C_NUM_0)
#define BSP_I2C_CLK_SPEED_HZ   400000

// ── Tear-sync task config macro ───────────────────────────────────────────────

#define BSP_SYNC_TASK_CONFIG(te_io, intr_type)  \
    {                                           \
        .task_priority = 4,                     \
        .task_stack = 2048,                     \
        .task_affinity = -1,                    \
        .time_Tvdl = 13,                        \
        .time_Tvdh = 3,                         \
        .te_gpio_num = te_io,                   \
        .tear_intr_type = intr_type,            \
    }

// ── BSP display config struct (low-level) ────────────────────────────────────

typedef struct {
    int max_transfer_sz;
    struct {
        int task_priority;
        int task_stack;
        int task_affinity;
        uint32_t time_Tvdl;
        uint32_t time_Tvdh;
        int te_gpio_num;
        gpio_int_type_t tear_intr_type;
    } tear_cfg;
} bsp_display_config_t;

// ── BSP high-level config struct (for bsp_display_start_with_config) ─────────

typedef struct {
    lvgl_port_cfg_t lvgl_port_cfg;
    uint32_t buffer_size;
    lv_disp_rot_t rotate;
} bsp_display_cfg_t;

#ifdef __cplusplus
extern "C" {
#endif

// ── Public API ────────────────────────────────────────────────────────────────

esp_err_t bsp_i2c_init(void);
esp_err_t bsp_i2c_deinit(void);

lv_disp_t *bsp_display_start_with_config(const bsp_display_cfg_t *cfg);
lv_indev_t *bsp_display_get_input_dev(void);

esp_err_t bsp_display_brightness_set(int brightness_percent);
esp_err_t bsp_display_backlight_on(void);
esp_err_t bsp_display_backlight_off(void);

bool bsp_display_lock(uint32_t timeout_ms);
void bsp_display_unlock(void);

#ifdef __cplusplus
}
#endif

#endif // JC3248W535
