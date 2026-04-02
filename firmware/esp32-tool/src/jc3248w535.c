#include "jc3248w535.h"
#include "esp_log.h"

static const char *TAG = "JC3248W535";

static lv_disp_rot_t rotation_from_degree(int degree)
{
    switch (degree) {
    case 0:   return LV_DISP_ROT_NONE;
    case 90:  return LV_DISP_ROT_90;
    case 180: return LV_DISP_ROT_180;
    case 270: return LV_DISP_ROT_270;
    default:
        ESP_LOGW(TAG, "Unsupported rotation degree %d, falling back to 0", degree);
        return LV_DISP_ROT_NONE;
    }
}

esp_err_t jc3248w535_begin(const jc3248w535_config_t *config, jc3248w535_handles_t *out)
{
    if (!config || !out) {
        return ESP_ERR_INVALID_ARG;
    }

    const bsp_display_cfg_t bsp_cfg = {
        .lvgl_port_cfg = config->lvgl,
        .buffer_size = config->buffer_size,
        .rotate = config->rotation,
    };

    lv_disp_t *disp = bsp_display_start_with_config(&bsp_cfg);
    if (!disp) {
        return ESP_FAIL;
    }

    out->disp = disp;
    out->indev = bsp_display_get_input_dev();

    if (config->backlight_percent >= 0) {
        if (config->backlight_percent == 0) {
            (void)bsp_display_backlight_off();
        } else {
            (void)bsp_display_brightness_set(config->backlight_percent);
        }
    }

    return ESP_OK;
}

esp_err_t jc3248w535_begin_simple(int rotation_degree, jc3248w535_handles_t *out)
{
    jc3248w535_config_t cfg = JC3248W535_DEFAULT_CONFIG(rotation_from_degree(rotation_degree));
    return jc3248w535_begin(&cfg, out);
}

bool jc3248w535_lock(uint32_t timeout_ms)
{
    return bsp_display_lock(timeout_ms);
}

void jc3248w535_unlock(void)
{
    bsp_display_unlock();
}
