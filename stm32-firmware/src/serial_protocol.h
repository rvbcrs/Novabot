#ifndef SERIAL_PROTOCOL_H
#define SERIAL_PROTOCOL_H

#include <stdint.h>

/*
 * Serial protocol between STM32 (this firmware) and X3 SoC (chassis_control_node)
 *
 * Frame format (both directions):
 *   [02 02] [CMD_HI CMD_LO] [PAYLOAD_LEN] [PAYLOAD...CRC8] [03 03]
 *
 * X3 -> STM32: cmd_id = 0x07FF, sub-command in payload[0]
 * STM32 -> X3: cmd_id = 0x0001 or 0x0002, sub-command in payload[0]
 *
 * See: research/chassis_serial_protocol.md for full specification
 */

/* Received command callback — called for each valid sub-command */
typedef void (*serial_rx_callback_t)(uint8_t subcmd, const uint8_t *payload, uint8_t len);

/* Initialize USART1 for X3 communication */
void serial_init(void);

/* Process received bytes (call from main loop) */
void serial_process_rx(void);

/* Register callback for received commands */
void serial_set_rx_callback(serial_rx_callback_t callback);

/* --- Send functions (STM32 -> X3) --- */

/* Send raw frame with cmd_id and payload */
void serial_send_frame(uint16_t cmd_id, const uint8_t *payload, uint8_t payload_len);

/* Send version report (sub-cmd 0x01) */
void serial_send_version(uint8_t major, uint8_t minor, uint8_t patch);

/* Send wheel speed / odometry (sub-cmd 0x03) */
void serial_send_wheel_speed(int16_t left_speed_mm, int16_t right_speed_mm);

/* Send motor current (sub-cmd 0x0A) */
void serial_send_motor_current(int16_t left_ma, int16_t right_ma, int16_t blade_ma);

/* Send hall sensor status (sub-cmd 0x0C) */
void serial_send_hall_status(uint8_t lf, uint8_t lb, uint8_t rb, uint8_t rf);

/* Send battery message (sub-cmd 0x17) */
void serial_send_battery(uint8_t soc_pct, uint16_t voltage_mv, int16_t current_ma);

/* Send incident flags (sub-cmd 0x18) */
void serial_send_incident(uint64_t flags);

/* Send IMU data (sub-cmd 0x42 for ICM-20602) */
void serial_send_imu(int16_t ax, int16_t ay, int16_t az,
                     int16_t gx, int16_t gy, int16_t gz);

/* Send charge data (sub-cmd 0x0B) */
void serial_send_charge_data(float charge_v, float charge_ma,
                             float battery_v, float adapter_v);

#endif /* SERIAL_PROTOCOL_H */
