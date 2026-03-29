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
    /*
     * UNVERIFIED PAYLOAD FORMAT — needs Ghidra analysis of chassis_cmd_deal_wheel_speed
     *
     * The spec only says "encoder data + timestamp" — exact byte layout unknown.
     * The OEM STM32 likely sends raw encoder ticks + a millisecond timestamp,
     * NOT processed mm/s values. The X3 then converts ticks → odometry using:
     *   wheel_separation = 0.40342m, wheel_diameter = 0.22356m
     *
     * Current implementation sends mm/s directly (4 bytes).
     * If X3 rejects this: increase to 8 or 12 bytes with timestamp padding.
     *
     * Known: publishes odom, odom_raw, odom_3d, /tf (odom→base_link)
     */
    /*
     * VERIFIED via Ghidra (chassis_cmd_deal_wheel_speed @ 0x117640):
     *   [1-2] int16 BE  left wheel mm/s  ← CORRECT
     *   [3-4] int16 BE  right wheel mm/s ← CORRECT
     *   [5..N-10] padding (unused)
     *   [N-9..N-2] float64 LE timestamp in seconds (8 bytes)
     *   [N-1] trailing byte
     *
     * Minimum frame: 5 data bytes + 8 timestamp + 1 trailing = 14 bytes payload.
     * The X3 uses the timestamp for ROS Time construction.
     * We send HAL_GetTick() / 1000.0 as the timestamp.
     */
    uint32_t tick_ms = HAL_GetTick();
    double   ts      = tick_ms / 1000.0;  /* seconds, float64 */
    uint8_t  ts_bytes[8];
    memcpy(ts_bytes, &ts, 8);             /* native LE on Cortex-M4 */

    uint8_t data[14] = {
        (left_speed_mm >> 8) & 0xFF, left_speed_mm & 0xFF,
        (right_speed_mm >> 8) & 0xFF, right_speed_mm & 0xFF,
        0x00,                             /* padding */
        ts_bytes[0], ts_bytes[1], ts_bytes[2], ts_bytes[3],
        ts_bytes[4], ts_bytes[5], ts_bytes[6], ts_bytes[7],
        0x00                              /* trailing byte */
    };
    send_report(SUBCMD_TX_WHEEL_SPEED, data, sizeof(data));
}

void serial_send_motor_current(int16_t left_ma, int16_t right_ma, int16_t blade_ma)
{
    /*
     * VERIFIED via Ghidra (chassis_cmd_deal_motor_current @ 0x1029b0):
     *   4x float32 LITTLE-ENDIAN, unit = Amperes (X3 multiplies by 1000 → mA)
     *   [1-4]   float32 LE  motor_current_0 (A)
     *   [5-8]   float32 LE  motor_current_1 (A)
     *   [9-12]  float32 LE  motor_current_2 (A)
     *   [13-16] float32 LE  motor_current_3 (A) — 4th motor (lift?)
     *
     * PREVIOUS IMPLEMENTATION WAS WRONG: int16 BE mA → fixed to float32 LE Amperes
     */
    float f_left  = left_ma  / 1000.0f;  /* mA → Amperes */
    float f_right = right_ma / 1000.0f;
    float f_blade = blade_ma / 1000.0f;
    float f_lift  = 0.0f;                 /* lift motor current — ADC TODO */

    uint8_t data[16];
    memcpy(&data[0],  &f_left,  4);  /* native LE on Cortex-M4 */
    memcpy(&data[4],  &f_right, 4);
    memcpy(&data[8],  &f_blade, 4);
    memcpy(&data[12], &f_lift,  4);
    send_report(SUBCMD_TX_MOTOR_CURRENT, data, sizeof(data));
}

void serial_send_hall_status(const hall_status_t *hall)
{
    /*
     * VERIFIED via Ghidra (chassis_cmd_deal_hall_status @ 0x1030f0):
     *   9 bytes minimum (payload[1..9]), 11 bytes extended (payload[1..11])
     *   Stored at member offsets 0xa80..0xa8a:
     *   [1] hall_0 → 0xa80  (collision lf)
     *   [2] hall_1 → 0xa81  (collision lb)
     *   [3] hall_2 → 0xa82  (collision rb)
     *   [4] hall_3 → 0xa83  (collision rf)
     *   [5] hall_4 → 0xa86
     *   [6] hall_5 → 0xa87
     *   [7] hall_6 → 0xa88
     *   [8] hall_7 → 0xa89
     *   [9] hall_8 → 0xa8a
     *   [10] hall_9 → 0xa84  (only if len > 11)
     *   [11] hall_10 → 0xa85 (only if len > 11)
     *
     * PREVIOUS IMPLEMENTATION WAS WRONG: only 4 bytes sent.
     */
    if (hall == NULL) return;

    uint8_t data[11] = {
        hall->collision_lf,   /* [1] hall_0 */
        hall->collision_lb,   /* [2] hall_1 */
        hall->collision_rb,   /* [3] hall_2 */
        hall->collision_rf,   /* [4] hall_3 */
        hall->uplift_left,    /* [5] hall_4 */
        hall->uplift_right,   /* [6] hall_5 */
        hall->key1,           /* [7] hall_6 */
        hall->key2,           /* [8] hall_7 */
        hall->front_wheel,    /* [9] hall_8 */
        hall->shell,          /* [10] hall_9  */
        hall->lift            /* [11] hall_10 */
    };
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

void serial_send_incident(uint32_t bitfield_b, uint32_t bitfield_a,
                          uint32_t bitfield_c, uint32_t bitfield_d)
{
    /*
     * VERIFIED via Ghidra (chassis_cmd_deal_chassis_incident @ 0x1037e0):
     *   16 data bytes = 4x uint32 BIG-ENDIAN (confirmed by REV instruction).
     *   [1-4]   uint32 BE  bitfield_B → 2 event flags   (bits 0-1)
     *   [5-8]   uint32 BE  bitfield_A → 14 warning flags (bits 0-13)
     *   [9-12]  uint32 BE  bitfield_C → 21 error flags   (bits 0-20)
     *   [13-16] uint32 BE  bitfield_D → 7 Class-B flags  (bits 0-6)
     *
     * PREVIOUS IMPLEMENTATION WAS WRONG: sent uint64 as 8 bytes.
     * Flag mapping (see config.h INCIDENT_* defines):
     *   bitfield_B = event flags   (INCIDENT_EVENT_*)
     *   bitfield_A = warning flags (INCIDENT_WARN_*)
     *   bitfield_C = error flags   (INCIDENT_ERR_*)
     *   bitfield_D = Class-B flags (INCIDENT_CLASSB_*)
     */
    uint8_t data[16] = {
        (bitfield_b >> 24) & 0xFF, (bitfield_b >> 16) & 0xFF,
        (bitfield_b >>  8) & 0xFF,  bitfield_b        & 0xFF,
        (bitfield_a >> 24) & 0xFF, (bitfield_a >> 16) & 0xFF,
        (bitfield_a >>  8) & 0xFF,  bitfield_a        & 0xFF,
        (bitfield_c >> 24) & 0xFF, (bitfield_c >> 16) & 0xFF,
        (bitfield_c >>  8) & 0xFF,  bitfield_c        & 0xFF,
        (bitfield_d >> 24) & 0xFF, (bitfield_d >> 16) & 0xFF,
        (bitfield_d >>  8) & 0xFF,  bitfield_d        & 0xFF,
    };
    send_report(SUBCMD_TX_INCIDENT, data, sizeof(data));
}

void serial_send_imu(int16_t ax, int16_t ay, int16_t az,
                     int16_t gx, int16_t gy, int16_t gz)
{
    /*
     * VERIFIED via Ghidra (chassis_cmd_deal_imu20602 @ 0x119d90):
     *   12 bytes, int16 BIG-ENDIAN, axis order = Z-X-Y (NOT X-Y-Z!)
     *   [1-2]   int16 BE  accel_z  (* 0.0011963 → m/s², ±4g mode)
     *   [3-4]   int16 BE  accel_x
     *   [5-6]   int16 BE  accel_y
     *   [7-8]   int16 BE  gyro_z   (* 0.00053254 → rad/s, ±1000dps mode)
     *   [9-10]  int16 BE  gyro_x
     *   [11-12] int16 BE  gyro_y
     *
     * PREVIOUS IMPLEMENTATION WAS WRONG: axis order was X-Y-Z.
     * Scale factors are applied by X3, STM32 sends raw ADC counts.
     */
    uint8_t data[12] = {
        /* Z-X-Y order for accel */
        (az >> 8) & 0xFF, az & 0xFF,
        (ax >> 8) & 0xFF, ax & 0xFF,
        (ay >> 8) & 0xFF, ay & 0xFF,
        /* Z-X-Y order for gyro */
        (gz >> 8) & 0xFF, gz & 0xFF,
        (gx >> 8) & 0xFF, gx & 0xFF,
        (gy >> 8) & 0xFF, gy & 0xFF
    };
    send_report(SUBCMD_TX_IMU_20602, data, sizeof(data));
}

void serial_send_magnetometer(int16_t mx, int16_t my, int16_t mz)
{
    /* BMM150 magnetometer — sub-cmd 0x43 */
    /* Payload: [mx_hi mx_lo] [my_hi my_lo] [mz_hi mz_lo] — 6 bytes, big-endian */
    uint8_t data[6] = {
        (mx >> 8) & 0xFF, mx & 0xFF,
        (my >> 8) & 0xFF, my & 0xFF,
        (mz >> 8) & 0xFF, mz & 0xFF
    };
    send_report(SUBCMD_TX_BMM150, data, sizeof(data));
}

void serial_send_charge_data(float charge_v, float charge_ma,
                             float battery_v, float adapter_v)
{
    /*
     * VERIFIED via Ghidra (chassis_cmd_deal_charge_cur_vol @ 0x102d50):
     *   4x float32 LITTLE-ENDIAN:
     *   [1-4]   float32 LE  charge_vol_v   (V)
     *   [5-8]   float32 LE  charge_cur_ma  (A or mA — X3 log label says _ma)
     *   [9-12]  float32 LE  battery_vol_v  (V)
     *   [13-16] float32 LE  adapter_vol_v  (V)
     *
     * PREVIOUS IMPLEMENTATION WAS WRONG: uint16 centi-units → fixed to float32 LE.
     */
    uint8_t data[16];
    memcpy(&data[0],  &charge_v,  4);  /* native LE on Cortex-M4 */
    memcpy(&data[4],  &charge_ma, 4);
    memcpy(&data[8],  &battery_v, 4);
    memcpy(&data[12], &adapter_v, 4);
    send_report(SUBCMD_TX_CHARGE_DATA, data, sizeof(data));
}
