#pragma once

#include "esp_err.h"
#include "lvgl.h"
#include "lv_port.h"
#include "jc_bsp.h"

#ifndef EXAMPLE_LCD_QSPI_H_RES
#define EXAMPLE_LCD_QSPI_H_RES 320
#endif
#ifndef EXAMPLE_LCD_QSPI_V_RES
#define EXAMPLE_LCD_QSPI_V_RES 480
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    lvgl_port_cfg_t lvgl;           /* LVGL task/timer configuration */
    uint32_t buffer_size;           /* Buffer size in pixels */
    lv_disp_rot_t rotation;         /* LVGL rotation */
    int backlight_percent;          /* 0..100; -1 to leave unchanged */
} jc3248w535_config_t;

typedef struct {
    lv_disp_t *disp;                /* LVGL display handle */
    lv_indev_t *indev;              /* LVGL input device handle */
} jc3248w535_handles_t;

#define JC3248W535_DEFAULT_CONFIG(_rotation) \
    (jc3248w535_config_t){ \
        .lvgl = ESP_LVGL_PORT_INIT_CONFIG(), \
        .buffer_size = EXAMPLE_LCD_QSPI_H_RES * EXAMPLE_LCD_QSPI_V_RES, \
        .rotation = (_rotation), \
        .backlight_percent = 100, \
    }

esp_err_t jc3248w535_begin(const jc3248w535_config_t *config, jc3248w535_handles_t *out);

esp_err_t jc3248w535_begin_simple(int rotation_degree, jc3248w535_handles_t *out);

bool jc3248w535_lock(uint32_t timeout_ms);
void jc3248w535_unlock(void);

static inline esp_err_t jc3248w535_backlight_set(int percent) {
    return bsp_display_brightness_set(percent);
}

#ifdef __cplusplus
}
#endif
