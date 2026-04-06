#ifndef LORA_H
#define LORA_H

#include <stdint.h>
#include <stdbool.h>

/*
 * LoRa — Charger communication via USART3
 *
 * The mower communicates with the charging station via LoRa.
 * The charger provides RTK correction data and docking guidance.
 *
 * Protocol (from firmware analysis):
 *   Command 0x34: Data transfer (charger ↔ mower)
 *   Command 0x36: Channel change
 *
 * Channels: Charger = ch16, Mower = ch15 (this is CORRECT, DO NOT CHANGE)
 */

/* LoRa link status */
typedef enum {
    LORA_STATUS_DISCONNECTED = 0,
    LORA_STATUS_CONNECTING,
    LORA_STATUS_CONNECTED
} lora_status_t;

/* Initialize USART3 for LoRa module */
void lora_init(void);

/* Process received LoRa data (call from main loop) */
void lora_process(void);

/* Get link status */
lora_status_t lora_get_status(void);

/* Send data to charger */
void lora_send_data(const uint8_t *data, uint8_t len);

/* Set LoRa channel (WARNING: do not change from default!) */
void lora_set_channel(uint8_t channel);

/* Handle RTK lost notification from X3 (sub-cmd 0x19) */
void lora_handle_rtk_lost(void);

/* Handle RTK status update from X3 (sub-cmd 0x55) */
void lora_handle_rtk_status(const uint8_t *data, uint8_t len);

/* Handle RTK recovery from X3 (sub-cmd 0x5E) */
void lora_handle_rtk_recovery(const uint8_t *data, uint8_t len);

#endif /* LORA_H */
