/*
 * Motor control — TIM1 (wheels) + TIM8 (blade/lift)
 *
 * Differential drive with GPIO direction + PWM magnitude.
 * CCER = 0x1111: 4 channels active, no complementary outputs.
 *
 * Wheel motors: TIM1 CH1-CH4, 50 kHz
 *   CH1 = left forward, CH2 = left reverse
 *   CH3 = right forward, CH4 = right reverse
 *   (TODO: Verify exact channel assignment from PCB)
 *
 * Blade motor: TIM8 CH1, 84 kHz
 * Lift motor:  TIM8 CH3, 25 kHz (shared timer, different ARR — needs verification)
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

    /* CH3 = lift motor (TODO: verify channel assignment) */
    HAL_TIM_PWM_ConfigChannel(&htim8, &oc, TIM_CHANNEL_3);
    HAL_TIM_PWM_Start(&htim8, TIM_CHANNEL_3);
}

/* ========================================================================
 * Public API
 * ======================================================================== */

void motor_init(void)
{
    /* TODO: Initialize motor direction GPIO pins */
    /* These need PCB verification before we can set them up */

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
     *
     * TODO: Verify channel-to-motor mapping from PCB traces.
     * The OEM firmware uses GPIO direction pins, not channel switching.
     * This is a simplified implementation until pin mapping is confirmed.
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
    if (speed_pct > 100) speed_pct = 100;

    uint16_t compare = (uint16_t)((uint32_t)speed_pct * BLADE_PWM_ARR / 100);
    __HAL_TIM_SET_COMPARE(&htim8, TIM_CHANNEL_1, compare);
}

void motor_blade_up(void)
{
    /*
     * Lift motor: direction GPIO HIGH + PWM on TIM8 CH3.
     * TODO: Set direction GPIO pin HIGH before applying PWM.
     *       GPIO pin needs PCB verification (lift motor direction).
     *
     * The lift motor runs until a Hall sensor (hall.lift) detects top position.
     * For now: apply 50% PWM in "up" direction (GPIO pin unknown = not set).
     * WARNING: Without the direction pin, motor will not move correctly.
     */
    /* HAL_GPIO_WritePin(LIFT_DIR_PORT, LIFT_DIR_PIN, GPIO_PIN_SET); */
    __HAL_TIM_SET_COMPARE(&htim8, TIM_CHANNEL_3, LIFT_PWM_ARR / 2);
}

void motor_blade_down(void)
{
    /*
     * Lift motor: direction GPIO LOW + PWM on TIM8 CH3.
     * TODO: Set direction GPIO pin LOW before applying PWM.
     *       GPIO pin needs PCB verification (lift motor direction).
     *
     * Opposite direction from motor_blade_up().
     * WARNING: Without the direction pin, this is identical to blade_up().
     */
    /* HAL_GPIO_WritePin(LIFT_DIR_PORT, LIFT_DIR_PIN, GPIO_PIN_RESET); */
    __HAL_TIM_SET_COMPARE(&htim8, TIM_CHANNEL_3, LIFT_PWM_ARR / 2);
}

void motor_set_blade_height(uint8_t height)
{
    /* TODO: Implement precise blade height control */
    /* OEM firmware has 2 height commands (0x23 and 0x44) */
    (void)height;
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
    /* TODO: Charge lock solenoid GPIO control */
    /* OEM has two commands: 0x22 (charge_lock) and 0x46 (charge_lock2) */
    (void)locked;
}
