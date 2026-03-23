/*
 * LoRa — Charger communication via USART3
 *
 * The mower's LoRa module (DTS brand) talks to the charging station for:
 *   - RTK correction data relay (charger has UM980 GPS)
 *   - Docking guidance
 *   - Status exchange
 *
 * DTS LoRa module protocol (from OEM firmware analysis):
 *   Command 0x34: Data transfer (payload follows)
 *   Command 0x36: Channel change (1 byte channel number)
 *   Command 0x37: Status query
 *   Command 0x38: Status response
 *
 * Frame format (DTS module ↔ STM32):
 *   [CMD] [LEN_HI LEN_LO] [PAYLOAD...] [CHECKSUM]
 *   Checksum = XOR of all bytes from CMD to last payload byte
 *
 * USART3: TX = PB10, RX = PB11 (STM32F407, verified from OEM pinout)
 *
 * Channels: Charger = ch16, Mower = ch15 — CORRECT, DO NOT CHANGE.
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

/* Frame parser state machine */
typedef enum {
    LORA_WAIT_CMD,
    LORA_WAIT_LEN_HI,
    LORA_WAIT_LEN_LO,
    LORA_PAYLOAD,
    LORA_WAIT_CHECKSUM
} lora_rx_state_t;

static struct {
    lora_rx_state_t state;
    uint8_t   cmd;
    uint16_t  payload_len;
    uint16_t  payload_idx;
    uint8_t   payload[256];
    uint8_t   checksum;
} lora_rx;

/* Status */
static lora_status_t link_status = LORA_STATUS_DISCONNECTED;
static uint32_t last_rx_tick = 0;

/* ========================================================================
 * Initialization
 * ======================================================================== */

void lora_init(void)
{
    __HAL_RCC_USART3_CLK_ENABLE();

    /* Configure USART3 GPIO pins: PB10=TX, PB11=RX */
    GPIO_InitTypeDef gpio = {0};
    gpio.Pin = GPIO_PIN_10 | GPIO_PIN_11;
    gpio.Mode = GPIO_MODE_AF_PP;
    gpio.Pull = GPIO_PULLUP;
    gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    gpio.Alternate = GPIO_AF7_USART3;
    HAL_GPIO_Init(GPIOB, &gpio);

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

    /* Init parser */
    lora_rx.state = LORA_WAIT_CMD;
}

/* ========================================================================
 * Frame processing
 * ======================================================================== */

static void lora_process_frame(void)
{
    /* Verify checksum */
    uint8_t check = lora_rx.cmd;
    check ^= (uint8_t)(lora_rx.payload_len >> 8);
    check ^= (uint8_t)(lora_rx.payload_len & 0xFF);
    for (uint16_t i = 0; i < lora_rx.payload_len; i++)
        check ^= lora_rx.payload[i];

    if (check != lora_rx.checksum)
        return;  /* Bad checksum, discard */

    /* Update link status */
    link_status = LORA_STATUS_CONNECTED;
    last_rx_tick = HAL_GetTick();

    switch (lora_rx.cmd)
    {
    case LORA_CMD_DATA:
        /* Data from charger — forward to X3 via serial protocol (sub-cmd 0x58) */
        if (lora_rx.payload_len > 0)
        {
            /* Build LoRa status frame: prepend status byte + payload */
            uint8_t tx_buf[258];
            tx_buf[0] = SUBCMD_TX_LORA_STATUS;
            tx_buf[1] = 0x01;  /* Status: data received */
            uint16_t copy_len = (lora_rx.payload_len > 254) ? 254 : lora_rx.payload_len;
            memcpy(&tx_buf[2], lora_rx.payload, copy_len);
            serial_send_frame(CMD_ID_STM32_TO_X3_1, tx_buf, 2 + (uint8_t)copy_len);
        }
        break;

    case 0x38:  /* Status response from LoRa module */
        /* Module is alive — status already updated above */
        break;

    default:
        break;
    }
}

static void lora_rx_byte(uint8_t byte)
{
    switch (lora_rx.state)
    {
    case LORA_WAIT_CMD:
        /* Valid LoRa commands: 0x34-0x3F range */
        if (byte >= 0x34 && byte <= 0x3F)
        {
            lora_rx.cmd = byte;
            lora_rx.checksum = 0;
            lora_rx.state = LORA_WAIT_LEN_HI;
        }
        break;

    case LORA_WAIT_LEN_HI:
        lora_rx.payload_len = (uint16_t)byte << 8;
        lora_rx.state = LORA_WAIT_LEN_LO;
        break;

    case LORA_WAIT_LEN_LO:
        lora_rx.payload_len |= byte;
        lora_rx.payload_idx = 0;
        if (lora_rx.payload_len == 0 || lora_rx.payload_len > sizeof(lora_rx.payload))
        {
            lora_rx.state = LORA_WAIT_CMD;  /* Invalid length */
        }
        else
        {
            lora_rx.state = LORA_PAYLOAD;
        }
        break;

    case LORA_PAYLOAD:
        lora_rx.payload[lora_rx.payload_idx++] = byte;
        if (lora_rx.payload_idx >= lora_rx.payload_len)
            lora_rx.state = LORA_WAIT_CHECKSUM;
        break;

    case LORA_WAIT_CHECKSUM:
        lora_rx.checksum = byte;
        lora_process_frame();
        lora_rx.state = LORA_WAIT_CMD;
        break;
    }
}

/* ========================================================================
 * Public API
 * ======================================================================== */

void lora_process(void)
{
    uint16_t write_pos = LORA_RX_BUF_SIZE - __HAL_DMA_GET_COUNTER(huart3.hdmarx);

    while (lora_read_pos != write_pos)
    {
        lora_rx_byte(lora_rx_buf[lora_read_pos]);
        lora_read_pos = (lora_read_pos + 1) % LORA_RX_BUF_SIZE;
    }

    /* Link timeout: if no data for 10s, mark disconnected */
    if (link_status == LORA_STATUS_CONNECTED &&
        (HAL_GetTick() - last_rx_tick) > 10000)
    {
        link_status = LORA_STATUS_DISCONNECTED;
    }
}

lora_status_t lora_get_status(void)
{
    return link_status;
}

void lora_send_data(const uint8_t *data, uint8_t len)
{
    if (len == 0 || data == NULL) return;

    /* Build LoRa data transfer frame: [CMD] [LEN_HI LEN_LO] [PAYLOAD] [CHECKSUM] */
    uint8_t frame[260];
    frame[0] = LORA_CMD_DATA;
    frame[1] = 0x00;          /* Length high byte */
    frame[2] = len;            /* Length low byte */
    memcpy(&frame[3], data, len);

    /* XOR checksum */
    uint8_t check = frame[0] ^ frame[1] ^ frame[2];
    for (uint8_t i = 0; i < len; i++)
        check ^= data[i];
    frame[3 + len] = check;

    HAL_UART_Transmit(&huart3, frame, 4 + len, 100);
}

void lora_set_channel(uint8_t channel)
{
    /* Send channel change command (0x36) to LoRa module */
    uint8_t frame[4];
    frame[0] = LORA_CMD_CHANNEL;
    frame[1] = 0x00;  /* Length high */
    frame[2] = 0x01;  /* Length low: 1 byte */
    frame[3] = channel;
    /* Checksum */
    uint8_t check = frame[0] ^ frame[1] ^ frame[2] ^ frame[3];

    uint8_t tx[5];
    memcpy(tx, frame, 4);
    tx[4] = check;
    HAL_UART_Transmit(&huart3, tx, 5, 100);
}

void lora_handle_rtk_lost(void)
{
    /* X3 notifies us that RTK fix was lost.
     * We could request the charger to increase correction data rate. */
}

void lora_handle_rtk_status(const uint8_t *data, uint8_t len)
{
    /* X3 sends RTK status — forward to charger via LoRa */
    if (data != NULL && len > 0)
        lora_send_data(data, len);
}

void lora_handle_rtk_recovery(const uint8_t *data, uint8_t len)
{
    /* X3 requests RTK recovery — forward request to charger */
    if (data != NULL && len > 0)
        lora_send_data(data, len);
}
