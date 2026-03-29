#include "bsp_i2c.h"
#include "bsp_spi.h"
#include "bsp_cst816.h"
#include "bsp_lv_port.h"

#include "lvgl.h"
#include "src/lvgl_ui/lvgl_ui.h"
#include <WiFi.h>

#include "src/app/app_qmi8658.h"
#include "src/app/app_system.h"
#include "src/app/app_camera.h"
#include "src/app/app_wifi.h"

char sta_ssid[] = "waveshare";
char sta_pass[] = "12345678";

void setup() {

  Serial.begin(115200);
  bsp_i2c_init();
  bsp_lv_port_init();
  bsp_spi_init();

  bsp_lv_port_run();

  if (lvgl_lock(-1)) {
    lvgl_ui_init();
    lvgl_unlock();
  }
  app_qmi8658_init();
  app_system_init();
  app_camera_init();
  app_wifi_init(sta_ssid, sta_pass);

  app_qmi8658_run();
  app_system_run();
  app_camera_run();
  app_wifi_run();
}



void loop() {
}
