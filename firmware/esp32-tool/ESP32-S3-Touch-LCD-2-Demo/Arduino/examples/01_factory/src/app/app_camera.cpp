
#include <Arduino.h>
#include "app_camera.h"
#include "../lvgl_ui/lvgl_ui.h"
#include "lvgl.h"
#include "../../bsp_lv_port.h"

esp_err_t cam_err;

static camera_config_t camera_config = {
  .pin_pwdn = PWDN_GPIO_NUM,
  .pin_reset = RESET_GPIO_NUM,
  .pin_xclk = XCLK_GPIO_NUM,
  .pin_sccb_sda = SIOD_GPIO_NUM,  // If pin_sccb_sda is -1, sccb will use the already initialized i2c port specified by `sccb_i2c_port`.
  .pin_sccb_scl = SIOC_GPIO_NUM,

  .pin_d7 = Y9_GPIO_NUM,
  .pin_d6 = Y8_GPIO_NUM,
  .pin_d5 = Y7_GPIO_NUM,
  .pin_d4 = Y6_GPIO_NUM,
  .pin_d3 = Y5_GPIO_NUM,
  .pin_d2 = Y4_GPIO_NUM,
  .pin_d1 = Y3_GPIO_NUM,
  .pin_d0 = Y2_GPIO_NUM,
  .pin_vsync = VSYNC_GPIO_NUM,
  .pin_href = HREF_GPIO_NUM,
  .pin_pclk = PCLK_GPIO_NUM,

  // XCLK 20MHz or 10MHz for OV2640 double FPS (Experimental)
  .xclk_freq_hz = 20000000,
  .ledc_timer = CAM_LEDC_TIMER,
  .ledc_channel = CAM_LEDC_CHANNEL,
  // PIXFORMAT_JPEG
  .pixel_format = PIXFORMAT_RGB565,  // YUV422,GRAYSCALE,RGB565,JPEG
  .frame_size = FRAMESIZE_240X240,   // QQVGA-UXGA, For ESP32, do not use sizes above QVGA when not JPEG. The performance of the ESP32-S series has improved a lot, but JPEG mode always gives better frame rates.

  .jpeg_quality = 12,  // 0-63, for OV series camera sensors, lower number means higher quality
  .fb_count = 1,       // When jpeg mode is used, if fb_count more than one, the driver will work in continuous mode.
  .fb_location = CAMERA_FB_IN_PSRAM,
  .grab_mode = CAMERA_GRAB_WHEN_EMPTY,
};


void app_camera_task(void *arg) {
  camera_fb_t *pic;
  lv_img_dsc_t img_dsc;
  img_dsc.header.always_zero = 0;
  img_dsc.header.w = 240;
  img_dsc.header.h = 240;
  img_dsc.data_size = 240 * 240 * 2;
  img_dsc.header.cf = LV_IMG_CF_TRUE_COLOR;
  img_dsc.data = NULL;

  // lv_img_set_src(img_camera, &pic);
  while (1) {
    if (cam_err != ESP_OK)
      break;
    pic = esp_camera_fb_get();

    if (NULL != pic) {
      img_dsc.data = pic->buf;
      if (lvgl_lock(-1)) {
        lv_img_set_src(img_camera, &img_dsc);
        lvgl_unlock();
      }
    }
    esp_camera_fb_return(pic);
    vTaskDelay(pdMS_TO_TICKS(10));
  }
  vTaskDelete(NULL);
}


void app_camera_init(void) {
  cam_err = esp_camera_init(&camera_config);
  if (cam_err == ESP_OK) {
    sensor_t *s = esp_camera_sensor_get();
    s->set_vflip(s, 1);
    // s->set_hmirror(s, 1);
  }
}

void app_camera_run(void) {
  xTaskCreate(app_camera_task, "app_camera_task", 4096, NULL, 5, NULL);
}


void app_camera_pause(void) {
}
