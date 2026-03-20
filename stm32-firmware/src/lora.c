/*
 * LoRa — Charger communication via USART3
 *
 * The mower's LoRa module talks to the charging station for:
 *   - RTK correction data relay
 *   - Docking guidance
 *   - Status exchange
 *
 * USART3: TX = PB10, RX = PB11 (common STM32F407 pinout, needs PCB verification)
 */

#include "lora.h"
#include "config.h"
#include "serial_protocol.h"
#include "stm32f4xx_hal.h"
#include <string.h>

/* ========================================================================
 * USART3 handle
 * ======================================================================== */

static UART_HandleTypeDef huart3;

/* DMA receive buffer */
#define LORA_RX_BUF_SIZE  512
static uint8_t lora_rx_buf[LORA_RX_BUF_SIZE];
static volatile uint16_t lora_read_pos = 0;

/* Status */
static lora_status_t link_status = LORA_STATUS_DISCONNECTED;

/* ========================================================================
 * Initialization
 * ======================================================================== */

void lora_init(void)
{
    __HAL_RCC_USART3_CLK_ENABLE();

    /* TODO: Configure USART3 GPIO pins */
    /* PB10 = TX, PB11 = RX — needs PCB verification */

    huart3.Instance = USART3;
    huart3.Init.BaudRate = UART_LORA_BAUD;
    huart3.Init.WordLength = UART_WORDLENGTH_8B;
    huart3.Init.StopBits = UART_STOPBITS_1;
    huart3.Init.Parity = UART_PARITY_NONE;
    huart3.Init.Mode = UART_MODE_TX_RX;
    huart3.Init.HwFlowCtl = UART_HWCONTROL_NONE;
    huart3.Init.OverSampling = UART_OVERSAMPLING_16;

    if (HAL_UART_Init(&huart3) != HAL_OK)
        return;

    /* Start DMA receive (circular) */
    HAL_UART_Receive_DMA(&huart3, lora_rx_buf, LORA_RX_BUF_SIZE);
}

/* ========================================================================
 * Receive processing
 * ======================================================================== */

void lora_process(void)
{
    uint16_t write_pos = LORA_RX_BUF_SIZE - __HAL_DMA_GET_COUNTER(huart3.hdmarx);

    while (lora_read_pos != write_pos)
    {
        uint8_t byte = lora_rx_buf[lora_read_pos];
        lora_read_pos = (lora_read_pos + 1) % LORA_RX_BUF_SIZE;

        /* TODO: Parse LoRa module protocol */
        /* The DTS LoRa module has its own framing on top of UART */
        (void)byte;
    }
}

/* ========================================================================
 * Public API
 * ======================================================================== */

lora_status_t lora_get_status(void)
{
    return link_status;
}

void lora_send_data(const uint8_t *data, uint8_t len)
{
    /* Build LoRa data transfer frame (command 0x34) */
    uint8_t frame[256];
    frame[0] = LORA_CMD_DATA;
    if (len > 0 && data != NULL && len < sizeof(frame) - 1)
    {
        memcpy(&frame[1], data, len);
    }

    HAL_UART_Transmit(&huart3, frame, 1 + len, 100);
}

void lora_set_channel(uint8_t channel)
{
    /* Send channel change command (0x36) to LoRa module */
    uint8_t frame[2] = { LORA_CMD_CHANNEL, channel };
    HAL_UART_Transmit(&huart3, frame, sizeof(frame), 100);
}

void lora_handle_rtk_lost(void)
{
    /* X3 notifies us that RTK fix was lost */
    /* TODO: Could trigger LoRa reconnect or status update */
}

void lora_handle_rtk_status(const uint8_t *data, uint8_t len)
{
    /* X3 sends RTK status update */
    (void)data;
    (void)len;
}

void lora_handle_rtk_recovery(const uint8_t *data, uint8_t len)
{
    /* X3 requests RTK recovery */
    (void)data;
    (void)len;
}
