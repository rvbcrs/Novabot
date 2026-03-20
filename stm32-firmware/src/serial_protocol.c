/*
 * Serial protocol implementation — STM32 <-> X3 SoC
 *
 * Frame: [02 02] [CMD_HI CMD_LO] [LEN] [PAYLOAD...CRC8] [03 03]
 *
 * Receive state machine parses incoming bytes one-at-a-time.
 * Transmit builds frames and writes via USART1.
 */

#include "serial_protocol.h"
#include "config.h"
#include "crc.h"
#include "stm32f4xx_hal.h"
#include <string.h>

/* ========================================================================
 * USART1 handle
 * ======================================================================== */

static UART_HandleTypeDef huart1;

/* ========================================================================
 * Receive state machine
 * ======================================================================== */

typedef enum {
    RX_WAIT_HEADER1,    /* Waiting for first 0x02 */
    RX_WAIT_HEADER2,    /* Waiting for second 0x02 */
    RX_WAIT_CMD_HI,     /* Command ID high byte */
    RX_WAIT_CMD_LO,     /* Command ID low byte */
    RX_WAIT_LEN,        /* Payload length */
    RX_PAYLOAD,         /* Accumulating payload bytes */
    RX_WAIT_FOOTER1,    /* Waiting for first 0x03 */
    RX_WAIT_FOOTER2     /* Waiting for second 0x03 */
} rx_state_t;

static struct {
    rx_state_t state;
    uint16_t   cmd_id;
    uint8_t    payload_len;
    uint8_t    payload_idx;
    uint8_t    payload[SERIAL_MAX_PAYLOAD];
} rx;

static serial_rx_callback_t rx_callback = NULL;

/* DMA receive buffer */
static uint8_t rx_dma_buf[SERIAL_RX_BUFFER_SIZE];
static volatile uint16_t rx_read_pos = 0;

/* ========================================================================
 * Initialization
 * ======================================================================== */

void serial_init(void)
{
    /* Enable USART1 clock */
    __HAL_RCC_USART1_CLK_ENABLE();

    /* Configure USART1 GPIO pins */
    /* TODO: Verify exact pins from PCB (likely PA9/PA10 or PB6/PB7) */
    GPIO_InitTypeDef gpio = {0};
    gpio.Mode = GPIO_MODE_AF_PP;
    gpio.Pull = GPIO_PULLUP;
    gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    gpio.Alternate = GPIO_AF7_USART1;

    /* PA9 = TX, PA10 = RX (common STM32F407 USART1 pins) */
    gpio.Pin = GPIO_PIN_9 | GPIO_PIN_10;
    HAL_GPIO_Init(GPIOA, &gpio);

    /* Configure USART1 */
    huart1.Instance = USART1;
    huart1.Init.BaudRate = UART_X3_BAUD;
    huart1.Init.WordLength = UART_WORDLENGTH_8B;
    huart1.Init.StopBits = UART_STOPBITS_1;
    huart1.Init.Parity = UART_PARITY_NONE;
    huart1.Init.Mode = UART_MODE_TX_RX;
    huart1.Init.HwFlowCtl = UART_HWCONTROL_NONE;
    huart1.Init.OverSampling = UART_OVERSAMPLING_16;

    if (HAL_UART_Init(&huart1) != HAL_OK)
    {
        /* Init failed — will be caught by watchdog */
        return;
    }

    /* Start DMA receive (circular) */
    HAL_UART_Receive_DMA(&huart1, rx_dma_buf, SERIAL_RX_BUFFER_SIZE);

    /* Init state machine */
    rx.state = RX_WAIT_HEADER1;
}

void serial_set_rx_callback(serial_rx_callback_t callback)
{
    rx_callback = callback;
}

/* ========================================================================
 * Receive processing — call from main loop
 * ======================================================================== */

static void rx_process_byte(uint8_t byte)
{
    switch (rx.state)
    {
    case RX_WAIT_HEADER1:
        if (byte == SERIAL_HEADER_BYTE)
            rx.state = RX_WAIT_HEADER2;
        break;

    case RX_WAIT_HEADER2:
        if (byte == SERIAL_HEADER_BYTE)
            rx.state = RX_WAIT_CMD_HI;
        else
            rx.state = RX_WAIT_HEADER1;
        break;

    case RX_WAIT_CMD_HI:
        rx.cmd_id = (uint16_t)byte << 8;
        rx.state = RX_WAIT_CMD_LO;
        break;

    case RX_WAIT_CMD_LO:
        rx.cmd_id |= byte;
        rx.state = RX_WAIT_LEN;
        break;

    case RX_WAIT_LEN:
        rx.payload_len = byte;
        rx.payload_idx = 0;
        if (byte == 0)
            rx.state = RX_WAIT_FOOTER1;
        else
            rx.state = RX_PAYLOAD;
        break;

    case RX_PAYLOAD:
        if (rx.payload_idx < SERIAL_MAX_PAYLOAD)
            rx.payload[rx.payload_idx] = byte;
        rx.payload_idx++;
        if (rx.payload_idx >= rx.payload_len)
            rx.state = RX_WAIT_FOOTER1;
        break;

    case RX_WAIT_FOOTER1:
        if (byte == SERIAL_FOOTER_BYTE)
            rx.state = RX_WAIT_FOOTER2;
        else
            rx.state = RX_WAIT_HEADER1; /* Bad footer, resync */
        break;

    case RX_WAIT_FOOTER2:
        if (byte == SERIAL_FOOTER_BYTE)
        {
            /* Valid frame received — verify CRC and dispatch */
            if (rx.payload_len >= 2)
            {
                uint8_t received_crc = rx.payload[rx.payload_len - 1];
                uint8_t computed_crc = crc8_calc(rx.payload, rx.payload_len - 1);

                if (received_crc == computed_crc && rx_callback != NULL)
                {
                    /* Dispatch: sub-command = payload[0] */
                    rx_callback(rx.payload[0], &rx.payload[1], rx.payload_len - 2);
                }
            }
        }
        rx.state = RX_WAIT_HEADER1;
        break;
    }
}

void serial_process_rx(void)
{
    /* Read available bytes from DMA circular buffer */
    uint16_t write_pos = SERIAL_RX_BUFFER_SIZE - __HAL_DMA_GET_COUNTER(huart1.hdmarx);

    while (rx_read_pos != write_pos)
    {
        rx_process_byte(rx_dma_buf[rx_read_pos]);
        rx_read_pos = (rx_read_pos + 1) % SERIAL_RX_BUFFER_SIZE;
    }
}

/* ========================================================================
 * Transmit — build frame and send
 * ======================================================================== */

static uint8_t tx_buf[SERIAL_MAX_PAYLOAD + SERIAL_FRAME_OVERHEAD];

void serial_send_frame(uint16_t cmd_id, const uint8_t *payload, uint8_t payload_len)
{
    tx_buf[0] = SERIAL_HEADER_BYTE;
    tx_buf[1] = SERIAL_HEADER_BYTE;
    tx_buf[2] = (cmd_id >> 8) & 0xFF;
    tx_buf[3] = cmd_id & 0xFF;
    tx_buf[4] = payload_len;

    if (payload_len > 0 && payload != NULL)
    {
        memcpy(&tx_buf[5], payload, payload_len);
    }

    tx_buf[5 + payload_len] = SERIAL_FOOTER_BYTE;
    tx_buf[6 + payload_len] = SERIAL_FOOTER_BYTE;

    HAL_UART_Transmit(&huart1, tx_buf, payload_len + SERIAL_FRAME_OVERHEAD, 100);
}

/* Helper: build payload with sub-command + data + CRC, then send */
static void send_report(uint8_t subcmd, const uint8_t *data, uint8_t data_len)
{
    uint8_t payload[SERIAL_MAX_PAYLOAD];
    payload[0] = subcmd;

    if (data_len > 0 && data != NULL)
    {
        memcpy(&payload[1], data, data_len);
    }

    /* CRC over subcmd + data */
    uint8_t crc = crc8_calc(payload, 1 + data_len);
    payload[1 + data_len] = crc;

    serial_send_frame(CMD_ID_STM32_TO_X3_1, payload, 2 + data_len);
}

/* ========================================================================
 * Typed send functions
 * ======================================================================== */

void serial_send_version(uint8_t major, uint8_t minor, uint8_t patch)
{
    uint8_t data[6] = {
        major, minor, patch,  /* board version */
        major, minor, patch   /* control version */
    };
    send_report(SUBCMD_TX_VERSION, data, sizeof(data));
}

void serial_send_wheel_speed(int16_t left_speed_mm, int16_t right_speed_mm)
{
    uint8_t data[4] = {
        (left_speed_mm >> 8) & 0xFF, left_speed_mm & 0xFF,
        (right_speed_mm >> 8) & 0xFF, right_speed_mm & 0xFF
    };
    send_report(SUBCMD_TX_WHEEL_SPEED, data, sizeof(data));
}

void serial_send_motor_current(int16_t left_ma, int16_t right_ma, int16_t blade_ma)
{
    uint8_t data[6] = {
        (left_ma >> 8) & 0xFF, left_ma & 0xFF,
        (right_ma >> 8) & 0xFF, right_ma & 0xFF,
        (blade_ma >> 8) & 0xFF, blade_ma & 0xFF
    };
    send_report(SUBCMD_TX_MOTOR_CURRENT, data, sizeof(data));
}

void serial_send_hall_status(uint8_t lf, uint8_t lb, uint8_t rb, uint8_t rf)
{
    uint8_t data[4] = { lf, lb, rb, rf };
    send_report(SUBCMD_TX_HALL_STATUS, data, sizeof(data));
}

void serial_send_battery(uint8_t soc_pct, uint16_t voltage_mv, int16_t current_ma)
{
    uint8_t data[5] = {
        soc_pct,
        (voltage_mv >> 8) & 0xFF, voltage_mv & 0xFF,
        (current_ma >> 8) & 0xFF, current_ma & 0xFF
    };
    send_report(SUBCMD_TX_BATTERY, data, sizeof(data));
}

void serial_send_incident(uint64_t flags)
{
    uint8_t data[8];
    for (int i = 7; i >= 0; i--)
    {
        data[7 - i] = (flags >> (i * 8)) & 0xFF;
    }
    send_report(SUBCMD_TX_INCIDENT, data, sizeof(data));
}

void serial_send_imu(int16_t ax, int16_t ay, int16_t az,
                     int16_t gx, int16_t gy, int16_t gz)
{
    uint8_t data[12] = {
        (ax >> 8) & 0xFF, ax & 0xFF,
        (ay >> 8) & 0xFF, ay & 0xFF,
        (az >> 8) & 0xFF, az & 0xFF,
        (gx >> 8) & 0xFF, gx & 0xFF,
        (gy >> 8) & 0xFF, gy & 0xFF,
        (gz >> 8) & 0xFF, gz & 0xFF
    };
    send_report(SUBCMD_TX_IMU_20602, data, sizeof(data));
}

void serial_send_charge_data(float charge_v, float charge_ma,
                             float battery_v, float adapter_v)
{
    /* TODO: Verify exact payload format from chassis_cmd_deal_charge_cur_vol */
    (void)charge_v;
    (void)charge_ma;
    (void)battery_v;
    (void)adapter_v;
}
