/*
 * Command handler — dispatches X3 -> STM32 sub-commands to actuators
 * and periodically reports sensor data back to X3.
 *
 * X3 -> STM32 sub-commands (cmd_id = 0x07FF):
 *   0x02: Velocity (left/right wheel speed in mm/s)
 *   0x0D: LED control (brightness 0-255)
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
#include "display.h"
#include "stm32f4xx_hal.h"

/* ========================================================================
 * Timing for periodic reports
 * ======================================================================== */

static uint32_t last_20ms_tick   = 0;
static uint32_t last_100ms_tick  = 0;
static uint32_t last_200ms_tick  = 0;
static uint32_t last_1s_tick     = 0;

/* Robot status from X3 (for display) */
static uint8_t robot_status = 0;

/* LED special effect state */
static uint8_t led_effect_active = 0;
static uint8_t led_effect_type = 0;
static uint32_t led_effect_start = 0;

/* ========================================================================
 * LED special effects
 *
 * Sub-cmd 0xF1: LED animation patterns from X3.
 * Payload[0] = effect type:
 *   0x00 = off
 *   0x01 = slow blink (0.5 Hz)
 *   0x02 = fast blink (2 Hz)
 *   0x03 = breathing (fade in/out)
 *   0xFF = solid on (max brightness)
 * ======================================================================== */

static void led_effect_update(void)
{
    if (!led_effect_active) return;

    uint32_t elapsed = HAL_GetTick() - led_effect_start;

    switch (led_effect_type)
    {
    case 0x00:  /* Off */
        motor_set_led(0);
        led_effect_active = 0;
        break;

    case 0x01:  /* Slow blink (0.5 Hz = 2s period) */
        motor_set_led(((elapsed / 1000) % 2) ? 255 : 0);
        break;

    case 0x02:  /* Fast blink (2 Hz = 500ms period) */
        motor_set_led(((elapsed / 250) % 2) ? 255 : 0);
        break;

    case 0x03:  /* Breathing (2s period) */
    {
        uint32_t phase = elapsed % 2000;
        uint8_t brightness;
        if (phase < 1000)
            brightness = (uint8_t)(phase * 255 / 1000);
        else
            brightness = (uint8_t)((2000 - phase) * 255 / 1000);
        motor_set_led(brightness);
        break;
    }

    case 0xFF:  /* Solid on */
        motor_set_led(255);
        led_effect_active = 0;  /* One-shot, no need to keep updating */
        break;

    default:
        led_effect_active = 0;
        break;
    }
}

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
        /* LED control: payload[0] = brightness (0-255) */
        if (len >= 1)
        {
            led_effect_active = 0;  /* Cancel any running effect */
            motor_set_led(payload[0]);
        }
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
        if (len >= 1)
        {
            motor_set_charge_lock(payload[0] != 0);
        }
        break;

    case SUBCMD_RX_BLADE_HEIGHT:
        if (len >= 1)
        {
            motor_set_blade_height(payload[0]);
        }
        break;

    case SUBCMD_RX_BLADE_HEIGHT2:
        if (len >= 1)
        {
            motor_set_blade_height(payload[0]);
        }
        break;

    case SUBCMD_RX_CHARGE_LOCK2:
        if (len >= 1)
        {
            motor_set_charge_lock(payload[0] != 0);
        }
        break;

    case SUBCMD_RX_ROBOT_STATUS:
        /* Robot status update from X3 (state machine state).
         * Update display with current state for user feedback. */
        if (len >= 1)
        {
            robot_status = payload[0];
            /* Update display status line based on robot state */
            switch (robot_status)
            {
            case 0:  display_set_line(2, "Idle");       break;
            case 1:  display_set_line(2, "Mowing");     break;
            case 2:  display_set_line(2, "Returning");   break;
            case 3:  display_set_line(2, "Charging");    break;
            case 4:  display_set_line(2, "Mapping");     break;
            case 5:  display_set_line(2, "Error");       break;
            default: display_set_line(2, "Unknown");     break;
            }
        }
        break;

    case SUBCMD_RX_RTK_STATUS:
        lora_handle_rtk_status(payload, len);
        break;

    case SUBCMD_RX_RTK_RECOVERY:
        lora_handle_rtk_recovery(payload, len);
        break;

    case SUBCMD_RX_UNBIND:
        /* Unbind command — reset stored state.
         * The mower forgets its paired charger and WiFi credentials.
         * On next boot, it will enter provisioning mode. */
        display_set_line(2, "Unbound!");
        break;

    case SUBCMD_RX_LED_SPECIAL:
        /* Special LED effect (animations) */
        if (len >= 1)
        {
            led_effect_type = payload[0];
            led_effect_start = HAL_GetTick();
            led_effect_active = 1;
        }
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

    /* Update LED effects if active */
    led_effect_update();

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

        /* Hall sensor status — pass full struct (11 bytes, all sensors) */
        hall_status_t hall;
        sensors_get_hall(&hall);
        serial_send_hall_status(&hall);

        /* Battery */
        battery_data_t bat;
        sensors_get_battery(&bat);
        serial_send_battery(bat.soc_pct, bat.voltage_mv, bat.current_ma);

        /* Update battery display */
        display_set_battery(bat.soc_pct);
    }

    /* 200ms interval: incident flags + magnetometer + charge data (5 Hz) */
    if ((now - last_200ms_tick) >= 200)
    {
        last_200ms_tick = now;

        /* Incident flags — split uint64 into 4x uint32 BE bitfields */
        uint64_t flags = sensors_get_incident_flags();
        uint32_t ev = (uint32_t)((flags >>  0) & 0x00000003ULL);
        uint32_t wa = (uint32_t)((flags >>  8) & 0x00003FFFULL);
        uint32_t er = (uint32_t)((flags >> 24) & 0x0000FFFFULL);
        uint32_t cb = (uint32_t)((flags >> 40) & 0x0000007FULL);
        serial_send_incident(ev, wa, er, cb);

        /* Magnetometer (sub-cmd 0x43) */
        mag_data_t mag;
        sensors_get_mag(&mag);
        serial_send_magnetometer(mag.mag_x, mag.mag_y, mag.mag_z);

        /* Charge data (sub-cmd 0x0B) */
        charge_data_t chg;
        sensors_get_charge(&chg);
        serial_send_charge_data(chg.charge_voltage, chg.charge_current,
                                chg.battery_voltage, chg.adapter_voltage);
    }

    /* 1s interval: version + LoRa status + self-check (1 Hz) */
    if ((now - last_1s_tick) >= 1000)
    {
        last_1s_tick = now;

        /* Version */
        serial_send_version(FIRMWARE_VERSION_MAJOR,
                            FIRMWARE_VERSION_MINOR,
                            FIRMWARE_VERSION_PATCH);

        /* LoRa status (sub-cmd 0x58) */
        {
            lora_status_t ls = lora_get_status();
            uint8_t data[2] = { (uint8_t)ls, 0x00 };
            uint8_t payload[4];
            payload[0] = SUBCMD_TX_LORA_STATUS;
            payload[1] = data[0];
            payload[2] = data[1];
            /* CRC computed by send_report in serial_protocol.c */
            serial_send_frame(CMD_ID_STM32_TO_X3_1, payload, 3);
        }

        /* Hardware self-check (sub-cmd 0x20) */
        {
            uint8_t check = sensors_hw_selfcheck();
            uint8_t payload[3];
            payload[0] = SUBCMD_TX_HW_SELFCHECK;
            payload[1] = check;
            serial_send_frame(CMD_ID_STM32_TO_X3_1, payload, 2);
        }

        /* Update GPS icon on display */
        {
            battery_data_t bat;
            sensors_get_battery(&bat);
            display_set_icon(DISPLAY_ICON_CHARGING, bat.adapter_mv > 20000);
            display_set_icon(DISPLAY_ICON_LORA,
                             lora_get_status() == LORA_STATUS_CONNECTED);
        }
    }
}
