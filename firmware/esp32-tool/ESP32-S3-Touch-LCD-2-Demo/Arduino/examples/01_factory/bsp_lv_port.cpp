#include "bsp_lv_port.h"

#include <Arduino.h>

#include "esp_timer.h"
#include "bsp_cst816.h"
#include "SPI.h"

#include "bsp_spi.h"

#include "lvgl.h"
// #include "demos/lv_demos.h"
#include <Arduino_GFX_Library.h>

static const char *TAG = "bsp_lv_port";

static SemaphoreHandle_t lvgl_api_mux = NULL;

#define GFX_BL 1

/* More data bus class: https://github.com/moononournation/Arduino_GFX/wiki/Data-Bus-Class */
Arduino_DataBus *bus = new Arduino_ESP32SPI(
  EXAMPLE_PIN_NUM_LCD_DC /* DC */, EXAMPLE_PIN_NUM_LCD_CS /* CS */,
  EXAMPLE_PIN_NUM_LCD_SCLK /* SCK */, EXAMPLE_PIN_NUM_LCD_MOSI /* MOSI */, EXAMPLE_PIN_NUM_LCD_MISO /* MISO */, FSPI /* spi_num */, true);

/* More display class: https://github.com/moononournation/Arduino_GFX/wiki/Display-Class */
Arduino_GFX *gfx = new Arduino_ST7789(
  bus, EXAMPLE_PIN_NUM_LCD_RST /* RST */, EXAMPLE_LCD_ROTATION /* rotation */, true /* IPS */,
  EXAMPLE_LCD_H_RES /* width */, EXAMPLE_LCD_V_RES /* height */);


bool lvgl_lock(int timeout_ms) {
  // Convert timeout in milliseconds to FreeRTOS ticks
  // If `timeout_ms` is set to -1, the program will block until the condition is met
  const TickType_t timeout_ticks = (timeout_ms == -1) ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
  return xSemaphoreTakeRecursive(lvgl_api_mux, timeout_ticks) == pdTRUE;
}

void lvgl_unlock(void) {
  xSemaphoreGiveRecursive(lvgl_api_mux);
}



static void example_lvgl_flush_cb(lv_disp_drv_t *drv, const lv_area_t *area, lv_color_t *color_map) {
  uint32_t w = (area->x2 - area->x1 + 1);
  uint32_t h = (area->y2 - area->y1 + 1);
  // copy a buffer's content to a specific area of the display
  if (bsp_spi_lock(-1)) {
#if (LV_COLOR_16_SWAP != 0)
    gfx->draw16bitBeRGBBitmap(area->x1, area->y1, (uint16_t *)&color_map->full, w, h);
#else
    gfx->draw16bitRGBBitmap(area->x1, area->y1, (uint16_t *)&color_map->full, w, h);
#endif
    bsp_spi_unlock();
  }
  lv_disp_flush_ready(drv);
}



static void example_lvgl_touch_cb(lv_indev_drv_t *drv, lv_indev_data_t *data) {
  uint16_t touchpad_x;
  uint16_t touchpad_y;
  bsp_touch_read();
  if (bsp_touch_get_coordinates(&touchpad_x, &touchpad_y)) {
    data->point.x = touchpad_x;
    data->point.y = touchpad_y;
    data->state = LV_INDEV_STATE_PRESSED;
  } else {
    data->state = LV_INDEV_STATE_RELEASED;
  }
}




static void example_increase_lvgl_tick(void *arg) {
  /* Tell LVGL how many milliseconds has elapsed */
  lv_tick_inc(EXAMPLE_LVGL_TICK_PERIOD_MS);
}

void lvgl_tick_timer_init(uint32_t ms) {
  ESP_LOGI(TAG, "Install LVGL tick timer");
  // Tick interface for LVGL (using esp_timer to generate 2ms periodic event)
  const esp_timer_create_args_t lvgl_tick_timer_args = {
    .callback = &example_increase_lvgl_tick,
    .name = "lvgl_tick"
  };
  esp_timer_handle_t lvgl_tick_timer = NULL;
  ESP_ERROR_CHECK(esp_timer_create(&lvgl_tick_timer_args, &lvgl_tick_timer));
  ESP_ERROR_CHECK(esp_timer_start_periodic(lvgl_tick_timer, ms * 1000));
}


void lv_display_init(void) {
  // Init Display
  if (!gfx->begin()) {
    Serial.println("gfx->begin() failed!");
  }
  gfx->fillScreen(RED);
#ifdef GFX_BL
  pinMode(GFX_BL, OUTPUT);
  digitalWrite(GFX_BL, HIGH);
#endif
  delay(1000);
  gfx->fillScreen(GREEN);
  delay(1000);
  gfx->fillScreen(BLUE);
  delay(1000);
}

void lv_touch_init(void) {
  while (bsp_touch_init(&Wire,EXAMPLE_LCD_ROTATION, gfx->width(), gfx->height()) == false) {
    delay(1000);
  }
}


static void task(void *param) {
  lvgl_tick_timer_init(EXAMPLE_LVGL_TICK_PERIOD_MS);
  while (1) {
    uint32_t task_delay_ms = EXAMPLE_LVGL_TASK_MAX_DELAY_MS;
    while (1) {
      // Lock the mutex due to the LVGL APIs are not thread-safe
      if (lvgl_lock(-1)) {
        task_delay_ms = lv_timer_handler();
        // Release the mutex
        lvgl_unlock();
      }
      if (task_delay_ms > EXAMPLE_LVGL_TASK_MAX_DELAY_MS) {
        task_delay_ms = EXAMPLE_LVGL_TASK_MAX_DELAY_MS;
      } else if (task_delay_ms < EXAMPLE_LVGL_TASK_MIN_DELAY_MS) {
        task_delay_ms = EXAMPLE_LVGL_TASK_MIN_DELAY_MS;
      }
      vTaskDelay(pdMS_TO_TICKS(task_delay_ms));
    }
  }
}


void bsp_lv_port_init(void) {

  static lv_disp_draw_buf_t disp_buf;  // contains internal graphic buffer(s) called draw buffer(s)
  static lv_disp_drv_t disp_drv;       // contains callback functions

  static lv_indev_drv_t indev_drv;  // Input device driver (Touch)

  lvgl_api_mux = xSemaphoreCreateRecursiveMutex();
  lv_init();

  lv_display_init();
  lv_touch_init();

  // alloc draw buffers used by LVGL
  // it's recommended to choose the size of the draw buffer(s) to be at least 1/10 screen sized
  lv_color_t *buf1 = (lv_color_t *)heap_caps_malloc(EXAMPLE_LCD_H_RES * EXAMPLE_LCD_V_RES * sizeof(lv_color_t), MALLOC_CAP_SPIRAM);
  assert(buf1);
  lv_color_t *buf2 = (lv_color_t *)heap_caps_malloc(EXAMPLE_LCD_H_RES * EXAMPLE_LCD_V_RES * sizeof(lv_color_t), MALLOC_CAP_SPIRAM);
  assert(buf2);
  // initialize LVGL draw buffers
  lv_disp_draw_buf_init(&disp_buf, buf1, buf2, EXAMPLE_LCD_H_RES * EXAMPLE_LCD_V_RES);

  lv_disp_drv_init(&disp_drv);
  disp_drv.hor_res = gfx->width();
  disp_drv.ver_res = gfx->height();
  disp_drv.flush_cb = example_lvgl_flush_cb;
  // disp_drv.drv_update_cb = example_lvgl_port_update_callback;
  disp_drv.draw_buf = &disp_buf;
  disp_drv.full_refresh = 1;
  // disp_drv.user_data = panel_handle;
  lv_disp_t *disp = lv_disp_drv_register(&disp_drv);
  

  lv_indev_drv_init(&indev_drv);
  indev_drv.type = LV_INDEV_TYPE_POINTER;
  indev_drv.disp = disp;
  indev_drv.read_cb = example_lvgl_touch_cb;
  // indev_drv.user_data = tp;

  lv_indev_drv_register(&indev_drv);

  // lv_demo_widgets();

  
}

void bsp_lv_port_run(void)
{
  xTaskCreatePinnedToCore(task, "bsp_lv_port_task", 1024 * 10, NULL, 5, NULL, 1);
}
