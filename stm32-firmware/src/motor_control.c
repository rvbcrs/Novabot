/*
 * Motor control — TIM1 (wheels) + TIM8 (blade/lift)
 *
 * Differential drive with GPIO direction + PWM magnitude.
 * CCER = 0x1111: 4 channels active, no complementary outputs.
 *
 * Wheel motors: TIM1 CH1-CH4, 50 kHz
 *   CH1 = left forward, CH2 = left reverse
 *   CH3 = right forward, CH4 = right reverse
 *
 * Blade motor: TIM8 CH1, 84 kHz
 * Lift motor:  TIM8 CH3, 25 kHz (shared timer, different ARR — needs verification)
 *
 * LED control: GPIO PA1 (display_lock pin from OEM analysis)
 *   Value 0-255 mapped to PWM or simple on/off.
 */

#include "motor_control.h"
#include "config.h"
#include "stm32f4xx_hal.h"

/* ========================================================================
 * Timer handles
 * ======================================================================== */

static TIM_HandleTypeDef htim1;  /* Wheel motors */
static TIM_HandleTypeDef htim8;  /* Blade + lift */

/* Current commanded velocities */
static int16_t current_left_mm_s  = 0;
static int16_t current_right_mm_s = 0;

/* Charge lock state */
static bool charge_locked = false;

/* LED brightness (0-255, controlled by X3 via sub-cmd 0x0D) */
static uint8_t led_brightness = 0;

/* ========================================================================
 * Helper: speed (mm/s) to PWM compare value
 * ======================================================================== */

/* Max wheel speed ~500 mm/s (from OEM firmware analysis) */
#define WHEEL_MAX_SPEED_MMS    500

static uint16_t speed_to_pwm(int16_t speed_mm_s)
{
    /* Clamp to max */
    int16_t abs_speed = (speed_mm_s < 0) ? -speed_mm_s : speed_mm_s;
    if (abs_speed > WHEEL_MAX_SPEED_MMS)
        abs_speed = WHEEL_MAX_SPEED_MMS;

    /* Linear mapping: 0 mm/s → 0, max → ARR */
    return (uint16_t)((uint32_t)abs_speed * MOTOR_PWM_ARR / WHEEL_MAX_SPEED_MMS);
}

/* ========================================================================
 * TIM1 — Wheel motors (50 kHz)
 * ======================================================================== */

static void tim1_init(void)
{
    __HAL_RCC_TIM1_CLK_ENABLE();

    htim1.Instance = TIM1;
    htim1.Init.Prescaler = 0;
    htim1.Init.CounterMode = TIM_COUNTERMODE_UP;
    htim1.Init.Period = MOTOR_PWM_ARR;
    htim1.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
    htim1.Init.RepetitionCounter = 0;
    htim1.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;

    if (HAL_TIM_PWM_Init(&htim1) != HAL_OK)
        return;

    /* Configure 4 PWM channels */
    TIM_OC_InitTypeDef oc = {0};
    oc.OCMode = TIM_OCMODE_PWM1;
    oc.Pulse = 0;  /* Start with 0% duty */
    oc.OCPolarity = TIM_OCPOLARITY_HIGH;
    oc.OCFastMode = TIM_OCFAST_DISABLE;

    HAL_TIM_PWM_ConfigChannel(&htim1, &oc, TIM_CHANNEL_1);
    HAL_TIM_PWM_ConfigChannel(&htim1, &oc, TIM_CHANNEL_2);
    HAL_TIM_PWM_ConfigChannel(&htim1, &oc, TIM_CHANNEL_3);
    HAL_TIM_PWM_ConfigChannel(&htim1, &oc, TIM_CHANNEL_4);

    /* Start all 4 channels */
    HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1);
    HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_2);
    HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_3);
    HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_4);

    /* Set CCER to match OEM firmware */
    TIM1->CCER = MOTOR_TIM1_CCER;
}

/* ========================================================================
 * TIM8 — Blade + Lift motors
 * ======================================================================== */

static void tim8_init(void)
{
    __HAL_RCC_TIM8_CLK_ENABLE();

    htim8.Instance = TIM8;
    htim8.Init.Prescaler = 0;
    htim8.Init.CounterMode = TIM_COUNTERMODE_UP;
    htim8.Init.Period = BLADE_PWM_ARR;  /* 84 kHz for blade */
    htim8.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
    htim8.Init.RepetitionCounter = 0;
    htim8.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;

    if (HAL_TIM_PWM_Init(&htim8) != HAL_OK)
        return;

    TIM_OC_InitTypeDef oc = {0};
    oc.OCMode = TIM_OCMODE_PWM1;
    oc.Pulse = 0;
    oc.OCPolarity = TIM_OCPOLARITY_HIGH;
    oc.OCFastMode = TIM_OCFAST_DISABLE;

    /* CH1 = blade motor */
    HAL_TIM_PWM_ConfigChannel(&htim8, &oc, TIM_CHANNEL_1);
    HAL_TIM_PWM_Start(&htim8, TIM_CHANNEL_1);

    /* CH3 = lift motor */
    HAL_TIM_PWM_ConfigChannel(&htim8, &oc, TIM_CHANNEL_3);
    HAL_TIM_PWM_Start(&htim8, TIM_CHANNEL_3);
}

/* ========================================================================
 * LED GPIO (PA1 — identified from OEM display_lock() analysis)
 * ======================================================================== */

static void led_gpio_init(void)
{
    GPIO_InitTypeDef gpio = {0};
    gpio.Pin = GPIO_PIN_1;
    gpio.Mode = GPIO_MODE_OUTPUT_PP;
    gpio.Pull = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(GPIOA, &gpio);
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_1, GPIO_PIN_RESET);
}

/* ========================================================================
 * Charge lock GPIO
 *
 * The charger has contact pins; a solenoid locks the mower onto the dock.
 * GPIO pin unknown — common patterns: PE2 or PD15 on STM32F407 designs.
 * Using PE2 as placeholder (needs PCB verification).
 * ======================================================================== */

#define CHARGE_LOCK_PORT    GPIOE
#define CHARGE_LOCK_PIN     GPIO_PIN_2

static void charge_lock_gpio_init(void)
{
    GPIO_InitTypeDef gpio = {0};
    gpio.Pin = CHARGE_LOCK_PIN;
    gpio.Mode = GPIO_MODE_OUTPUT_PP;
    gpio.Pull = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(CHARGE_LOCK_PORT, &gpio);
    HAL_GPIO_WritePin(CHARGE_LOCK_PORT, CHARGE_LOCK_PIN, GPIO_PIN_RESET);
}

/* ========================================================================
 * Lift motor direction GPIO
 *
 * The lift motor uses a direction pin + PWM magnitude.
 * GPIO pin unknown — using PD13 as placeholder (needs PCB verification).
 * ======================================================================== */

#define LIFT_DIR_PORT    GPIOD
#define LIFT_DIR_PIN     GPIO_PIN_13

static void lift_dir_gpio_init(void)
{
    GPIO_InitTypeDef gpio = {0};
    gpio.Pin = LIFT_DIR_PIN;
    gpio.Mode = GPIO_MODE_OUTPUT_PP;
    gpio.Pull = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(LIFT_DIR_PORT, &gpio);
}

/* ========================================================================
 * Public API
 * ======================================================================== */

void motor_init(void)
{
    led_gpio_init();
    charge_lock_gpio_init();
    lift_dir_gpio_init();
    tim1_init();
    tim8_init();
}

void motor_set_velocity(int16_t left_mm_s, int16_t right_mm_s)
{
    current_left_mm_s  = left_mm_s;
    current_right_mm_s = right_mm_s;

    uint16_t left_pwm  = speed_to_pwm(left_mm_s);
    uint16_t right_pwm = speed_to_pwm(right_mm_s);

    /*
     * Differential drive: direction via which channel gets PWM.
     *   Forward: CH1 (left fwd) + CH3 (right fwd) active
     *   Reverse: CH2 (left rev) + CH4 (right rev) active
     */

    if (left_mm_s >= 0)
    {
        __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, left_pwm);
        __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_2, 0);
    }
    else
    {
        __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, 0);
        __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_2, left_pwm);
    }

    if (right_mm_s >= 0)
    {
        __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_3, right_pwm);
        __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_4, 0);
    }
    else
    {
        __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_3, 0);
        __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_4, right_pwm);
    }
}

void motor_set_blade_speed(uint8_t speed_pct)
{
#ifdef BLADE_MOTOR_DISABLED
    /*
     * SAFETY SWITCH ACTIVE: BLADE_MOTOR_DISABLED is defined in config.h.
     * Blade motor (TIM8 CH1) is forced to 0% duty cycle regardless of command.
     * Remove BLADE_MOTOR_DISABLED from config.h and recompile to enable the blade.
     */
    (void)speed_pct;
    __HAL_TIM_SET_COMPARE(&htim8, TIM_CHANNEL_1, 0);
    return;
#endif

    if (speed_pct > 100) speed_pct = 100;

    uint16_t compare = (uint16_t)((uint32_t)speed_pct * BLADE_PWM_ARR / 100);
    __HAL_TIM_SET_COMPARE(&htim8, TIM_CHANNEL_1, compare);
}

void motor_blade_up(void)
{
    HAL_GPIO_WritePin(LIFT_DIR_PORT, LIFT_DIR_PIN, GPIO_PIN_SET);
    __HAL_TIM_SET_COMPARE(&htim8, TIM_CHANNEL_3, LIFT_PWM_ARR / 2);
}

void motor_blade_down(void)
{
    HAL_GPIO_WritePin(LIFT_DIR_PORT, LIFT_DIR_PIN, GPIO_PIN_RESET);
    __HAL_TIM_SET_COMPARE(&htim8, TIM_CHANNEL_3, LIFT_PWM_ARR / 2);
}

void motor_set_blade_height(uint8_t height)
{
    /*
     * Blade height: OEM firmware has 2 sub-commands (0x23 and 0x44).
     * The lift motor runs until a Hall sensor detects the target position.
     * Height values observed: 0 = lowest, typically 5-6 levels.
     *
     * For now: simple timed drive based on height delta.
     * A proper implementation would use the lift Hall sensor for feedback.
     */
    if (height > 0)
        motor_blade_up();
    else
        motor_blade_down();
}

void motor_emergency_stop(void)
{
    /* All PWM to 0 immediately */
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, 0);
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_2, 0);
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_3, 0);
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_4, 0);
    __HAL_TIM_SET_COMPARE(&htim8, TIM_CHANNEL_1, 0);
    __HAL_TIM_SET_COMPARE(&htim8, TIM_CHANNEL_3, 0);

    current_left_mm_s  = 0;
    current_right_mm_s = 0;
}

void motor_get_wheel_speed(int16_t *left_mm_s, int16_t *right_mm_s)
{
    if (left_mm_s  != NULL) *left_mm_s  = current_left_mm_s;
    if (right_mm_s != NULL) *right_mm_s = current_right_mm_s;
}

void motor_set_charge_lock(bool locked)
{
    charge_locked = locked;
    HAL_GPIO_WritePin(CHARGE_LOCK_PORT, CHARGE_LOCK_PIN,
                      locked ? GPIO_PIN_SET : GPIO_PIN_RESET);
}

bool motor_get_charge_lock(void)
{
    return charge_locked;
}

void motor_set_led(uint8_t brightness)
{
    led_brightness = brightness;
    /* PA1: simple on/off (threshold at 128) for non-PWM GPIO.
     * For proper dimming, PA1 could be mapped to a timer PWM channel. */
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_1,
                      (brightness >= 128) ? GPIO_PIN_SET : GPIO_PIN_RESET);
}

uint8_t motor_get_led(void)
{
    return led_brightness;
}
