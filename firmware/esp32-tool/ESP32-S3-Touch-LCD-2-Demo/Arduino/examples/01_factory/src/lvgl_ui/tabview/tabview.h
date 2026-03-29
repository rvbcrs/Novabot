#pragma once

#include "../lvgl_ui.h"

typedef void (*wifi_mode_change_cb)(uint8_t);

extern lv_obj_t *label_sd;
extern lv_obj_t *label_chip_temp;
extern lv_obj_t *label_chip_name;
extern lv_obj_t *label_battery;
extern lv_obj_t *label_psram;
extern lv_obj_t *label_flash;
extern lv_obj_t *label_ip_address;
extern lv_obj_t *label_wifi_sta_ip;
extern lv_obj_t *label_wifi_ap_ip;

extern lv_obj_t *label_wifi_sta_ssid;
extern lv_obj_t *label_wifi_sta_pass;
extern lv_obj_t *label_wifi_ap_ssid;
extern lv_obj_t *label_wifi_ap_pass;


extern lv_obj_t *label_accel_x;
extern lv_obj_t *label_accel_y;
extern lv_obj_t *label_accel_z;
extern lv_obj_t *label_gyro_x;
extern lv_obj_t *label_gyro_y;
extern lv_obj_t *label_gyro_z;

extern lv_obj_t *img_camera;

#ifdef __cplusplus
extern "C" {
#endif

void system_tab_create(lv_obj_t * tab);
void camera_tab_create(lv_obj_t * tab);
void qmi8658_tab_create(lv_obj_t * tab);

void wifi_tab_create(lv_obj_t * tab);
void wifi_set_mode_change_cb(wifi_mode_change_cb cb);

#ifdef __cplusplus
}
#endif