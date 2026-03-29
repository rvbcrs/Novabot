#include <Arduino.h>
#include "bsp_spi.h"
#include "SPI.h"

SPIClass bsp_spi(FSPI);

SemaphoreHandle_t bsp_spi_mux = NULL;


bool bsp_spi_lock(int timeout_ms) {
  // Convert timeout in milliseconds to FreeRTOS ticks
  // If `timeout_ms` is set to -1, the program will block until the condition is met
  const TickType_t timeout_ticks = (timeout_ms == -1) ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
  return xSemaphoreTakeRecursive(bsp_spi_mux, timeout_ticks) == pdTRUE;
}

void bsp_spi_unlock(void) {
  xSemaphoreGiveRecursive(bsp_spi_mux);
}

void bsp_spi_init(void) {
  // ESP_LOGI(TAG, "Initialize I2C");
  bsp_spi_mux = xSemaphoreCreateRecursiveMutex();
  bsp_spi.begin(EXAMPLE_PIN_NUM_SCLK, EXAMPLE_PIN_NUM_MISO, EXAMPLE_PIN_NUM_MOSI, -1);
}