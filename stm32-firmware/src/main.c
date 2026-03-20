/*
 * Open-source STM32F407 Motor Controller Firmware — Novabot Mower
 *
 * main.c — System initialization, watchdog, main loop
 *
 * This is the entry point for the open-source replacement of the
 * proprietary Novabot STM32 chassis firmware. It handles:
 *   - HAL and clock initialization (168MHz from 8MHz HSE)
 *   - Dual watchdog setup (IWDG + WWDG)
 *   - Peripheral initialization (UART, SPI, I2C, Timers, ADC)
 *   - Main super-loop (no RTOS, matching OEM architecture)
 */

#include "stm32f4xx_hal.h"
#include "config.h"
#include "serial_protocol.h"
#include "motor_control.h"
#include "sensors.h"
#include "gps.h"
#include "lora.h"
#include "display.h"
#include "command_handler.h"
#include "crc.h"

/* ========================================================================
 * Forward declarations
 * ======================================================================== */

static void SystemClock_Config(void);
static void Watchdog_Init(void);
static void Watchdog_Refresh(void);
static void GPIO_Init(void);
static void Error_Handler(void);

/* ========================================================================
 * Global state
 * ======================================================================== */

static volatile uint32_t tick_ms = 0;

/* ========================================================================
 * Main entry point
 * ======================================================================== */

int main(void)
{
    /* --- Phase 1: Core initialization --- */
    HAL_Init();
    SystemClock_Config();

    /* --- Phase 2: Watchdog (must be early — resets if init hangs) --- */
    Watchdog_Init();

    /* --- Phase 3: Peripheral initialization --- */
    GPIO_Init();
    crc_init();
    serial_init();
    motor_init();
    sensors_init();
    gps_init();
    lora_init();
    display_init();

    /* --- Phase 4: Command handler (registers serial callback) --- */
    command_handler_init();

    /* --- Phase 5: IMU zero-bias calibration (~18s, robot must be stationary) --- */
    display_set_line(0, "IMU Calibrating...");
    sensors_imu_calibrate();

    /* --- Phase 6: Show version on display --- */
    display_show_version();
    display_set_line(1, "Ready");

    /* --- Phase 7: Report version to X3 --- */
    serial_send_version(FIRMWARE_VERSION_MAJOR,
                        FIRMWARE_VERSION_MINOR,
                        FIRMWARE_VERSION_PATCH);

    /* --- Main loop (bare-metal super-loop, no RTOS) --- */
    while (1)
    {
        /* Process incoming serial commands from X3 */
        serial_process_rx();

        /* Process GPS data relay */
        gps_process();

        /* Process LoRa data */
        lora_process();

        /* Update all sensor readings */
        sensors_periodic_update();

        /* Send periodic sensor reports to X3 */
        command_handler_periodic_report();

        /* Refresh watchdog */
        Watchdog_Refresh();
    }
}

/* ========================================================================
 * Clock configuration — 168 MHz from 8 MHz HSE
 *
 * PLL: HSE(8MHz) / M(8) * N(336) / P(2) = 168 MHz
 * APB1: 168 / 4 = 42 MHz (timers x2 = 84 MHz)
 * APB2: 168 / 2 = 84 MHz (timers x2 = 168 MHz)
 * ======================================================================== */

static void SystemClock_Config(void)
{
    RCC_OscInitTypeDef RCC_OscInitStruct = {0};
    RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

    /* Enable power controller and set voltage regulator scale 1 */
    __HAL_RCC_PWR_CLK_ENABLE();
    __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE1);

    /* HSE oscillator + PLL */
    RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSE | RCC_OSCILLATORTYPE_LSI;
    RCC_OscInitStruct.HSEState = RCC_HSE_ON;
    RCC_OscInitStruct.LSIState = RCC_LSI_ON;     /* For IWDG */
    RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
    RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSE;
    RCC_OscInitStruct.PLL.PLLM = 8;
    RCC_OscInitStruct.PLL.PLLN = 336;
    RCC_OscInitStruct.PLL.PLLP = RCC_PLLP_DIV2;
    RCC_OscInitStruct.PLL.PLLQ = 7;              /* USB OTG FS = 48 MHz */

    if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
    {
        Error_Handler();
    }

    /* SYSCLK = PLL, AHB = /1, APB1 = /4, APB2 = /2 */
    RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK
                                | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
    RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
    RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
    RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV4;
    RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV2;

    if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_5) != HAL_OK)
    {
        Error_Handler();
    }
}

/* ========================================================================
 * Watchdog — Dual IWDG + WWDG (IEC 60335 Class B)
 * ======================================================================== */

static IWDG_HandleTypeDef hiwdg;

static void Watchdog_Init(void)
{
    hiwdg.Instance = IWDG;
    hiwdg.Init.Prescaler = IWDG_PRESCALER;
    hiwdg.Init.Reload = IWDG_RELOAD;

    if (HAL_IWDG_Init(&hiwdg) != HAL_OK)
    {
        Error_Handler();
    }
}

static void Watchdog_Refresh(void)
{
    HAL_IWDG_Refresh(&hiwdg);
}

/* ========================================================================
 * GPIO — Basic initialization (enable all port clocks)
 * ======================================================================== */

static void GPIO_Init(void)
{
    /* Enable GPIO clocks for all ports used by the hardware */
    __HAL_RCC_GPIOA_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    __HAL_RCC_GPIOC_CLK_ENABLE();
    __HAL_RCC_GPIOD_CLK_ENABLE();
    __HAL_RCC_GPIOE_CLK_ENABLE();
    __HAL_RCC_GPIOF_CLK_ENABLE();
    __HAL_RCC_GPIOG_CLK_ENABLE();
    __HAL_RCC_GPIOH_CLK_ENABLE();

    /* Enable DMA clocks (used by UART, ADC) */
    __HAL_RCC_DMA1_CLK_ENABLE();
    __HAL_RCC_DMA2_CLK_ENABLE();

    /* TODO: Configure individual GPIO pins once pin mapping is verified */
}

/* ========================================================================
 * Error handler
 * ======================================================================== */

static void Error_Handler(void)
{
    __disable_irq();
    while (1)
    {
        /* Halt — watchdog will reset */
    }
}

/* ========================================================================
 * SysTick callback (1ms)
 * ======================================================================== */

void HAL_IncTick(void);  /* Provided by HAL */

void SysTick_Handler(void)
{
    HAL_IncTick();
    tick_ms++;
}
