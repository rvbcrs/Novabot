#ifndef MOTOR_CONTROL_H
#define MOTOR_CONTROL_H

#include <stdint.h>
#include <stdbool.h>

/*
 * Motor control — 4 motors via TIM1 (wheels) and TIM8 (blade + lift)
 *
 * Differential drive: left/right wheel speed in mm/s.
 * Direction via GPIO pin (HIGH/LOW), speed via PWM duty cycle.
 * NOT complementary PWM — H-bridge uses separate direction pin.
 *
 * Timer config (from firmware analysis):
 *   TIM1: APB2 = 84MHz, prescaler=0, ARR=1679 → 50 kHz (wheels)
 *   TIM8: APB2 = 84MHz, prescaler=0, ARR=999  → 84 kHz (blade)
 *         or ARR=3359 → 25 kHz (lift motor)
 */

/* Initialize motor timers and GPIO */
void motor_init(void);

/* Set wheel velocities (mm/s, signed: positive = forward) */
void motor_set_velocity(int16_t left_mm_s, int16_t right_mm_s);

/* Set blade motor speed (0-100%) */
void motor_set_blade_speed(uint8_t speed_pct);

/* Blade lift control */
void motor_blade_up(void);
void motor_blade_down(void);
void motor_set_blade_height(uint8_t height);

/* Emergency stop — all motors off immediately */
void motor_emergency_stop(void);

/* Get current wheel speeds (for odometry reporting) */
void motor_get_wheel_speed(int16_t *left_mm_s, int16_t *right_mm_s);

/* Charge lock solenoid control */
void motor_set_charge_lock(bool locked);

#endif /* MOTOR_CONTROL_H */
