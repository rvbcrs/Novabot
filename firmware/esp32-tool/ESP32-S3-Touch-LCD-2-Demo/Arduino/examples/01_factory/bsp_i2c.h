#pragma once
#include <stdio.h>
#include <string.h>
#include <stdbool.h>

#define EXAMPLE_PIN_NUM_I2C_SDA     48
#define EXAMPLE_PIN_NUM_I2C_SCL     47


void bsp_i2c_init(void);
bool bsp_i2c_reg8_read(uint8_t dev_addr, uint8_t reg_addr, uint8_t *data, uint8_t len);
bool bsp_i2c_reg8_write(uint8_t dev_addr, uint8_t reg_addr, uint8_t *data, uint8_t len);


bool bsp_i2c_lock(int timeout_ms);
void bsp_i2c_unlock(void);
