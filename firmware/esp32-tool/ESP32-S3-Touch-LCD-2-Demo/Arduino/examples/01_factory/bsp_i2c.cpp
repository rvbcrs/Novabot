#include "bsp_i2c.h"
#include "esp_log.h"
#include <Arduino.h>
#include "Wire.h"

static const char *TAG = "bsp_i2c";

static SemaphoreHandle_t bsp_i2c_mux = NULL;

bool bsp_i2c_lock(int timeout_ms) {
  // Convert timeout in milliseconds to FreeRTOS ticks
  // If `timeout_ms` is set to -1, the program will block until the condition is met
  const TickType_t timeout_ticks = (timeout_ms == -1) ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
  return xSemaphoreTakeRecursive(bsp_i2c_mux, timeout_ticks) == pdTRUE;
}

void bsp_i2c_unlock(void) {
  xSemaphoreGiveRecursive(bsp_i2c_mux);
}

void bsp_i2c_init(void) {
  // ESP_LOGI(TAG, "Initialize I2C");
  bsp_i2c_mux = xSemaphoreCreateRecursiveMutex();
  Wire.begin(EXAMPLE_PIN_NUM_I2C_SDA, EXAMPLE_PIN_NUM_I2C_SCL);
  Wire.setClock(400000); //400khz clock
}


bool bsp_i2c_reg8_read(uint8_t dev_addr, uint8_t reg_addr, uint8_t *data, uint8_t len) {
  uint8_t error;
  if (bsp_i2c_lock(-1)) {
    Wire.beginTransmission(dev_addr);
    Wire.write(reg_addr);
    error = Wire.endTransmission(true);
    if (error) {
      Serial.printf("endTransmission: %u\n", error);
      bsp_i2c_unlock();
      return false;
    }
    Wire.requestFrom(dev_addr, len);
    for (int i = 0; i < len; i++) {
      *data++ = Wire.read();
    }
    bsp_i2c_unlock();
    return true;
  }
  return false;
}

bool bsp_i2c_reg8_write(uint8_t dev_addr, uint8_t reg_addr, uint8_t *data, uint8_t len) {
  uint8_t error;
  if (bsp_i2c_lock(-1)) {
    Wire.beginTransmission(dev_addr);
    Wire.write(reg_addr);
    for (int i = 0; i < len; i++) {
      Wire.write(*data++);
    }
    error = Wire.endTransmission(true);
    bsp_i2c_unlock();
    if (error) {
      Serial.printf("endTransmission: %u\n", error);
      return false;
    }
    return true;
  }
  return false;
}
