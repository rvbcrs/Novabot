#pragma once
#include <stdio.h>
#include <stdbool.h>
#include "SPI.h"

#define EXAMPLE_PIN_NUM_SCLK 39
#define EXAMPLE_PIN_NUM_MOSI 38
#define EXAMPLE_PIN_NUM_MISO 40


bool bsp_spi_lock(int timeout_ms);
void bsp_spi_unlock(void);
void bsp_spi_init(void);

extern SPIClass bsp_spi;
extern SemaphoreHandle_t bsp_spi_mux;