/*
 * Command handler — dispatches X3 -> STM32 sub-commands to actuators
 * and periodically reports sensor data back to X3.
 *
 * X3 -> STM32 sub-commands (cmd_id = 0x07FF):
 *   0x02: Velocity (left/right wheel speed in mm/s)
 *   0x0D: LED control
 *   0x12: Blade speed
 *   0x14: Blade up
 *   0x15: Blade down
 *   0x19: RTK lost notification
 *   0x22: Charge lock
 *   0x23: Blade height
 *   0x44: Blade height (alternate)
 *   0x46: Charge lock (alternate)
 *   0x50: Robot status update
 *   0x55: RTK status
 *   0x5E: RTK recovery
 *   0x71: Unbind
 *   0xF1: LED special effect
 *
 * STM32 -> X3 periodic reports:
 *   Every 20ms:  wheel speed (0x03), IMU (0x42)
 *   Every 100ms: motor current (0x0A), hall status (0x0C), battery (0x17)
 *   Every 200ms: incident flags (0x18), magnetometer (0x43)
 *   Every 1s:    version (0x01), LoRa status (0x58), self-check (0x20)
 */

#include "command_handler.h"
#include "config.h"
#include "serial_protocol.h"
#include "motor_control.h"
#include "sensors.h"
#include "lora.h"
#include "stm32f4xx_hal.h"

/* ========================================================================
 * Timing for periodic reports
 * ======================================================================== */

static uint32_t last_20ms_tick   = 0;
static uint32_t last_100ms_tick  = 0;
static uint32_t last_200ms_tick  = 0;
static uint32_t last_1s_tick     = 0;

/* ========================================================================
 * Command dispatch callback (registered with serial protocol)
 * ======================================================================== */

static void on_command_received(uint8_t subcmd, const uint8_t *payload, uint8_t len)
{
    switch (subcmd)
    {
    case SUBCMD_RX_VELOCITY:
        /* Velocity command: [left_hi, left_lo, right_hi, right_lo, 0x00, 0x00] */
        if (len >= 4)
        {
            int16_t left  = (int16_t)((payload[0] << 8) | payload[1]);
            int16_t right = (int16_t)((payload[2] << 8) | payload[3]);
            motor_set_velocity(left, right);
        }
        break;

    case SUBCMD_RX_LED:
        /* LED control */
        /* TODO: Implement LED driver (GPIO or dedicated LED controller) */
        break;

    case SUBCMD_RX_BLADE_SPEED:
        /* Blade speed (0-100%) */
        if (len >= 1)
        {
            motor_set_blade_speed(payload[0]);
        }
        break;

    case SUBCMD_RX_BLADE_UP:
        motor_blade_up();
        break;

    case SUBCMD_RX_BLADE_DOWN:
        motor_blade_down();
        break;

    case SUBCMD_RX_RTK_LOST:
        lora_handle_rtk_lost();
        break;

    case SUBCMD_RX_CHARGE_LOCK:
        /* Charge lock control */
        if (len >= 1)
        {
            motor_set_charge_lock(payload[0] != 0);
        }
        break;

    case SUBCMD_RX_BLADE_HEIGHT:
        /* Blade height adjustment */
        if (len >= 1)
        {
            motor_set_blade_height(payload[0]);
        }
        break;

    case SUBCMD_RX_BLADE_HEIGHT2:
        /* Alternate blade height command */
        if (len >= 1)
        {
            motor_set_blade_height(payload[0]);
        }
        break;

    case SUBCMD_RX_CHARGE_LOCK2:
        /* Alternate charge lock */
        if (len >= 1)
        {
            motor_set_charge_lock(payload[0] != 0);
        }
        break;

    case SUBCMD_RX_ROBOT_STATUS:
        /* Robot status update from X3 (state machine state) */
        /* TODO: Could update display or LED based on robot state */
        break;

    case SUBCMD_RX_RTK_STATUS:
        lora_handle_rtk_status(payload, len);
        break;

    case SUBCMD_RX_RTK_RECOVERY:
        lora_handle_rtk_recovery(payload, len);
        break;

    case SUBCMD_RX_UNBIND:
        /* Unbind command — reset to factory state */
        /* TODO: Clear stored calibration/pairing data */
        break;

    case SUBCMD_RX_LED_SPECIAL:
        /* Special LED effect (animations, patterns) */
        /* TODO: Implement LED animation system */
        break;

    default:
        /* Unknown sub-command — ignore */
        break;
    }
}

/* ========================================================================
 * Initialization
 * ======================================================================== */

void command_handler_init(void)
{
    serial_set_rx_callback(on_command_received);

    uint32_t now = HAL_GetTick();
    last_20ms_tick  = now;
    last_100ms_tick = now;
    last_200ms_tick = now;
    last_1s_tick    = now;
}

/* ========================================================================
 * Periodic sensor reporting to X3
 * ======================================================================== */

void command_handler_periodic_report(void)
{
    uint32_t now = HAL_GetTick();

    /* 20ms interval: wheel speed + IMU (50 Hz) */
    if ((now - last_20ms_tick) >= 20)
    {
        last_20ms_tick = now;

        /* Wheel speed */
        int16_t left_mm_s, right_mm_s;
        motor_get_wheel_speed(&left_mm_s, &right_mm_s);
        serial_send_wheel_speed(left_mm_s, right_mm_s);

        /* IMU */
        imu_data_t imu;
        sensors_get_imu(&imu);
        serial_send_imu(imu.accel_x, imu.accel_y, imu.accel_z,
                        imu.gyro_x, imu.gyro_y, imu.gyro_z);
    }

    /* 100ms interval: motor current + hall + battery (10 Hz) */
    if ((now - last_100ms_tick) >= 100)
    {
        last_100ms_tick = now;

        /* Motor currents */
        motor_current_t current;
        sensors_get_motor_current(&current);
        serial_send_motor_current(current.left_ma, current.right_ma, current.blade_ma);

        /* Hall sensor status */
        hall_status_t hall;
        sensors_get_hall(&hall);
        serial_send_hall_status(hall.collision_lf, hall.collision_lb,
                                hall.collision_rb, hall.collision_rf);

        /* Battery */
        battery_data_t bat;
        sensors_get_battery(&bat);
        serial_send_battery(bat.soc_pct, bat.voltage_mv, bat.current_ma);
    }

    /* 200ms interval: incident flags + magnetometer (5 Hz) */
    if ((now - last_200ms_tick) >= 200)
    {
        last_200ms_tick = now;

        /* Incident flags */
        uint64_t flags = sensors_get_incident_flags();
        serial_send_incident(flags);

        /* TODO: Send magnetometer data (sub-cmd 0x43) */
    }

    /* 1s interval: version + LoRa status + self-check (1 Hz) */
    if ((now - last_1s_tick) >= 1000)
    {
        last_1s_tick = now;

        /* Version */
        serial_send_version(FIRMWARE_VERSION_MAJOR,
                            FIRMWARE_VERSION_MINOR,
                            FIRMWARE_VERSION_PATCH);

        /* TODO: Send LoRa status (sub-cmd 0x58) */
        /* TODO: Send hardware self-check (sub-cmd 0x20) */
    }
}
