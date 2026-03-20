/*
 * Display — Color LCD via SPI2
 *
 * Stub implementation — LCD controller IC unknown, needs hardware identification.
 * Likely ST7789 or ILI9341 based on common mower designs.
 *
 * SPI2 pins (common STM32F407, needs PCB verification):
 *   PB13 = SCK, PB15 = MOSI, PB12 = CS (NSS)
 *   + DC (data/command) and RST pins via GPIO
 */

#include "display.h"
#include "config.h"
#include "stm32f4xx_hal.h"
#include <string.h>

/* ========================================================================
 * SPI2 handle
 * ======================================================================== */

static SPI_HandleTypeDef hspi2;

/* ========================================================================
 * Initialization
 * ======================================================================== */

void display_init(void)
{
    __HAL_RCC_SPI2_CLK_ENABLE();

    /* TODO: Configure SPI2 GPIO pins */
    /* PB13=SCK, PB15=MOSI, PB12=CS — needs PCB verification */

    hspi2.Instance = SPI2;
    hspi2.Init.Mode = SPI_MODE_MASTER;
    hspi2.Init.Direction = SPI_DIRECTION_2LINES;
    hspi2.Init.DataSize = SPI_DATASIZE_8BIT;
    hspi2.Init.CLKPolarity = SPI_POLARITY_LOW;
    hspi2.Init.CLKPhase = SPI_PHASE_1EDGE;
    hspi2.Init.NSS = SPI_NSS_SOFT;
    hspi2.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_4; /* 42/4 = 10.5 MHz */
    hspi2.Init.FirstBit = SPI_FIRSTBIT_MSB;
    hspi2.Init.TIMode = SPI_TIMODE_DISABLE;
    hspi2.Init.CRCCalculation = SPI_CRCCALCULATION_DISABLE;

    HAL_SPI_Init(&hspi2);

    /* TODO: LCD controller init sequence (depends on controller IC) */
    /* Typical init: hardware reset, sleep out, display on, orientation, color format */
}

/* ========================================================================
 * Stub implementations
 * ======================================================================== */

void display_clear(void)
{
    /* TODO: Fill display with background color */
}

void display_set_line(uint8_t line, const char *text)
{
    /* TODO: Render text line using font bitmap */
    (void)line;
    (void)text;
}

void display_set_battery(uint8_t soc_pct)
{
    /* TODO: Draw battery icon with fill level */
    (void)soc_pct;
}

void display_set_icon(display_icon_t icon, uint8_t visible)
{
    /* TODO: Show/hide status icon */
    (void)icon;
    (void)visible;
}

void display_show_version(void)
{
    display_set_line(0, FIRMWARE_VERSION_STRING);
}

void display_show_error(uint16_t error_code)
{
    /* TODO: Show error code prominently on display */
    (void)error_code;
}

void display_refresh(void)
{
    /* TODO: Refresh display contents if using framebuffer */
}
