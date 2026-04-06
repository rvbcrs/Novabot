/*
 * GPS — UM960 RTK receiver via UART5
 *
 * The STM32 acts as a relay: it receives GPS data from the UM960
 * and forwards it to the X3 SoC via the serial protocol.
 *
 * Incoming data types:
 *   - $GNGGA   → sub-cmd 0x05 (NMEA GGA sentence)
 *   - #BESTPOS  → sub-cmd 0x40
 *   - #BESTVEL  → sub-cmd 0x41
 *   - #PSRDOPA  → sub-cmd 0x3F
 *   - #MATCHEDPOSA → sub-cmd 0x3D
 *
 * UART5: TX = PC12, RX = PD2 (common STM32F407 pinout)
 */

#include "gps.h"
#include "config.h"
#include "serial_protocol.h"
#include "stm32f4xx_hal.h"
#include <string.h>

/* ========================================================================
 * UART5 handle
 * ======================================================================== */

static UART_HandleTypeDef huart5;

/* DMA receive buffer */
#define GPS_RX_BUF_SIZE  2048
static uint8_t gps_rx_buf[GPS_RX_BUF_SIZE];
static volatile uint16_t gps_read_pos = 0;

/* Line buffer for assembling complete sentences */
#define GPS_LINE_BUF_SIZE  512
static uint8_t gps_line_buf[GPS_LINE_BUF_SIZE];
static uint16_t gps_line_idx = 0;

/* Cached data */
static gps_position_t cached_position = {0};
static gps_velocity_t cached_velocity = {0};

/* ========================================================================
 * Initialization
 * ======================================================================== */

void gps_init(void)
{
    __HAL_RCC_UART5_CLK_ENABLE();

    /* Configure UART5 GPIO pins: PC12=TX, PD2=RX */
    GPIO_InitTypeDef gpio = {0};
    gpio.Mode = GPIO_MODE_AF_PP;
    gpio.Pull = GPIO_PULLUP;
    gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    gpio.Alternate = GPIO_AF8_UART5;

    gpio.Pin = GPIO_PIN_12;  /* PC12 = TX */
    HAL_GPIO_Init(GPIOC, &gpio);

    gpio.Pin = GPIO_PIN_2;   /* PD2 = RX */
    HAL_GPIO_Init(GPIOD, &gpio);

    huart5.Instance = UART5;
    huart5.Init.BaudRate = UART_GPS_BAUD;
    huart5.Init.WordLength = UART_WORDLENGTH_8B;
    huart5.Init.StopBits = UART_STOPBITS_1;
    huart5.Init.Parity = UART_PARITY_NONE;
    huart5.Init.Mode = UART_MODE_TX_RX;
    huart5.Init.HwFlowCtl = UART_HWCONTROL_NONE;
    huart5.Init.OverSampling = UART_OVERSAMPLING_16;

    if (HAL_UART_Init(&huart5) != HAL_OK)
        return;

    /* Start DMA receive (circular) */
    HAL_UART_Receive_DMA(&huart5, gps_rx_buf, GPS_RX_BUF_SIZE);
}

/* ========================================================================
 * NMEA GGA parsing (minimal — just for local status)
 * ======================================================================== */

static bool parse_gga(const char *sentence)
{
    /* $GNGGA,hhmmss.ss,ddmm.mmmm,N,dddmm.mmmm,E,q,nn,hdop,alt,M,...*cc */
    /* We only need fix quality (field 6) and num sats (field 7) for local use */
    /* The raw sentence is forwarded to X3 for full processing */

    int field = 0;
    const char *p = sentence;

    while (*p && field < 7)
    {
        if (*p == ',')
        {
            field++;
            p++;

            if (field == 6)
            {
                /* Fix quality */
                cached_position.fix_type = (gps_fix_t)(*p - '0');
                cached_position.valid = (cached_position.fix_type != GPS_FIX_NONE);
            }
            else if (field == 7)
            {
                /* Number of satellites */
                cached_position.num_sats = 0;
                while (*p >= '0' && *p <= '9')
                {
                    cached_position.num_sats = cached_position.num_sats * 10 + (*p - '0');
                    p++;
                }
                return true;
            }
        }
        else
        {
            p++;
        }
    }

    return false;
}

/* ========================================================================
 * Line processing — detect sentence type and forward to X3
 * ======================================================================== */

static void process_line(const uint8_t *line, uint16_t len)
{
    if (len < 6) return;

    /* NMEA: $GNGGA */
    if (line[0] == '$' && line[1] == 'G' && line[2] == 'N' &&
        line[3] == 'G' && line[4] == 'G' && line[5] == 'A')
    {
        parse_gga((const char *)line);
        /* Forward raw GGA to X3 as sub-cmd 0x05 */
        serial_send_frame(CMD_ID_STM32_TO_X3_1, line, len);
    }
    /* NovAtel binary: #BESTPOS */
    else if (len > 8 && memcmp(line, "#BESTPOS", 8) == 0)
    {
        serial_send_frame(CMD_ID_STM32_TO_X3_1, line, len);
    }
    /* NovAtel binary: #BESTVEL */
    else if (len > 8 && memcmp(line, "#BESTVEL", 8) == 0)
    {
        serial_send_frame(CMD_ID_STM32_TO_X3_1, line, len);
    }
    /* NovAtel binary: #PSRDOPA */
    else if (len > 8 && memcmp(line, "#PSRDOP", 7) == 0)
    {
        serial_send_frame(CMD_ID_STM32_TO_X3_1, line, len);
    }
    /* NovAtel binary: #MATCHEDPOSA */
    else if (len > 12 && memcmp(line, "#MATCHEDPOS", 11) == 0)
    {
        serial_send_frame(CMD_ID_STM32_TO_X3_1, line, len);
    }
}

/* ========================================================================
 * Public API
 * ======================================================================== */

void gps_process(void)
{
    /* Read available bytes from DMA circular buffer */
    uint16_t write_pos = GPS_RX_BUF_SIZE - __HAL_DMA_GET_COUNTER(huart5.hdmarx);

    while (gps_read_pos != write_pos)
    {
        uint8_t byte = gps_rx_buf[gps_read_pos];
        gps_read_pos = (gps_read_pos + 1) % GPS_RX_BUF_SIZE;

        if (byte == '\n' || byte == '\r')
        {
            if (gps_line_idx > 0)
            {
                process_line(gps_line_buf, gps_line_idx);
                gps_line_idx = 0;
            }
        }
        else
        {
            if (gps_line_idx < GPS_LINE_BUF_SIZE - 1)
            {
                gps_line_buf[gps_line_idx++] = byte;
            }
            else
            {
                /* Line too long, discard */
                gps_line_idx = 0;
            }
        }
    }
}

void gps_get_position(gps_position_t *pos)
{
    if (pos != NULL) *pos = cached_position;
}

void gps_get_velocity(gps_velocity_t *vel)
{
    if (vel != NULL) *vel = cached_velocity;
}

bool gps_has_rtk_fix(void)
{
    return (cached_position.fix_type == GPS_FIX_RTK_FIX);
}

/* Forward functions — these are called by the relay logic above */
void gps_forward_gga(void) { /* Handled in process_line */ }
void gps_forward_bestpos(void) { /* Handled in process_line */ }
void gps_forward_bestvel(void) { /* Handled in process_line */ }
void gps_forward_psrdopa(void) { /* Handled in process_line */ }
void gps_forward_matchedposa(void) { /* Handled in process_line */ }
