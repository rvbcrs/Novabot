#ifndef COMMAND_HANDLER_H
#define COMMAND_HANDLER_H

#include <stdint.h>

/*
 * Command handler — dispatches received serial sub-commands from X3
 *
 * Registered as serial_rx_callback. Routes sub-commands to appropriate
 * motor control, LED, blade, and other actuator functions.
 *
 * All X3 -> STM32 commands use cmd_id 0x07FF with sub-command in payload[0].
 */

/* Initialize command handler (registers serial callback) */
void command_handler_init(void);

/* Periodic reporting — sends sensor data to X3 at configured intervals */
void command_handler_periodic_report(void);

#endif /* COMMAND_HANDLER_H */
