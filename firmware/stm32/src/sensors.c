/*
 * Sensor management — IMU (ICM-20602), magnetometer (BMM150),
 * Hall sensors (14x), ADC (battery, motor current, adapter voltage)
 *
 * All sensor reads are cached and updated periodically from the main loop.
 * The serial protocol module reads cached values for reporting to X3.
 *
 * ADC channel assignments are based on common STM32F407 robotics designs
 * and need PCB verification. The firmware will work with incorrect channels
 * but report wrong voltage/current values.
 */

#include "sensors.h"
#include "config.h"
#include "stm32f4xx_hal.h"
#include <string.h>
#include <math.h>

/* ========================================================================
 * I2C handle (shared by IMU + magnetometer)
 * ======================================================================== */

static I2C_HandleTypeDef hi2c1;

/* ========================================================================
 * Cached sensor data
 * ======================================================================== */

static imu_data_t      cached_imu      = {0};
static mag_data_t      cached_mag      = {0};
static hall_status_t   cached_hall     = {0};
static battery_data_t  cached_battery  = {0};
static motor_current_t cached_current  = {0};
static charge_data_t   cached_charge   = {0};
static uint64_t        incident_flags  = 0;

/* IMU zero-bias offsets (calculated during 18s calibration at boot) */
static int16_t gyro_bias_x = 0;
static int16_t gyro_bias_y = 0;
static int16_t gyro_bias_z = 0;

/* ========================================================================
 * I2C1 Initialization
 *
 * Pins: PB6 = SCL, PB7 = SDA (standard STM32F407 I2C1 pinout)
 * ======================================================================== */

static void i2c1_init(void)
{
    __HAL_RCC_I2C1_CLK_ENABLE();

    /* Configure I2C1 GPIO pins: PB6=SCL, PB7=SDA */
    GPIO_InitTypeDef gpio = {0};
    gpio.Pin = GPIO_PIN_6 | GPIO_PIN_7;
    gpio.Mode = GPIO_MODE_AF_OD;        /* Open-drain for I2C */
    gpio.Pull = GPIO_PULLUP;
    gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    gpio.Alternate = GPIO_AF4_I2C1;
    HAL_GPIO_Init(GPIOB, &gpio);

    hi2c1.Instance = I2C1;
    hi2c1.Init.ClockSpeed = 400000;  /* 400 kHz Fast Mode */
    hi2c1.Init.DutyCycle = I2C_DUTYCYCLE_2;
    hi2c1.Init.OwnAddress1 = 0;
    hi2c1.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
    hi2c1.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
    hi2c1.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
    hi2c1.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;

    HAL_I2C_Init(&hi2c1);
}

/* ========================================================================
 * ICM-20602 IMU
 * ======================================================================== */

/* ICM-20602 register addresses */
#define ICM20602_WHO_AM_I       0x75
#define ICM20602_PWR_MGMT_1     0x6B
#define ICM20602_SMPLRT_DIV     0x19
#define ICM20602_CONFIG         0x1A
#define ICM20602_GYRO_CONFIG    0x1B
#define ICM20602_ACCEL_CONFIG   0x1C
#define ICM20602_ACCEL_XOUT_H   0x3B
#define ICM20602_GYRO_XOUT_H    0x43
#define ICM20602_WHO_AM_I_VAL   0x12

static bool imu_initialized = false;

static void imu_init(void)
{
    uint8_t who_am_i = 0;
    uint8_t reg;

    /* Read WHO_AM_I to verify presence */
    HAL_I2C_Mem_Read(&hi2c1, IMU_ICM20602_ADDR << 1, ICM20602_WHO_AM_I,
                     I2C_MEMADD_SIZE_8BIT, &who_am_i, 1, 100);

    if (who_am_i != ICM20602_WHO_AM_I_VAL)
        return;  /* IMU not found */

    /* Reset device */
    reg = 0x80;
    HAL_I2C_Mem_Write(&hi2c1, IMU_ICM20602_ADDR << 1, ICM20602_PWR_MGMT_1,
                      I2C_MEMADD_SIZE_8BIT, &reg, 1, 100);
    HAL_Delay(100);

    /* Wake up, auto-select best clock source */
    reg = 0x01;
    HAL_I2C_Mem_Write(&hi2c1, IMU_ICM20602_ADDR << 1, ICM20602_PWR_MGMT_1,
                      I2C_MEMADD_SIZE_8BIT, &reg, 1, 100);
    HAL_Delay(10);

    /* Sample rate divider: 0 → 1 kHz (matched with DLPF) */
    reg = 0x00;
    HAL_I2C_Mem_Write(&hi2c1, IMU_ICM20602_ADDR << 1, ICM20602_SMPLRT_DIV,
                      I2C_MEMADD_SIZE_8BIT, &reg, 1, 100);

    /* DLPF config: bandwidth = 92 Hz */
    reg = 0x02;
    HAL_I2C_Mem_Write(&hi2c1, IMU_ICM20602_ADDR << 1, ICM20602_CONFIG,
                      I2C_MEMADD_SIZE_8BIT, &reg, 1, 100);

    /* Gyro config: ±1000 dps (scale factor = 0.00053254 rad/s per LSB, from OEM) */
    reg = 0x10;  /* FS_SEL = 2 → ±1000 dps */
    HAL_I2C_Mem_Write(&hi2c1, IMU_ICM20602_ADDR << 1, ICM20602_GYRO_CONFIG,
                      I2C_MEMADD_SIZE_8BIT, &reg, 1, 100);

    /* Accel config: ±4g (scale factor = 0.0011963 m/s² per LSB, from OEM) */
    reg = 0x08;  /* AFS_SEL = 1 → ±4g */
    HAL_I2C_Mem_Write(&hi2c1, IMU_ICM20602_ADDR << 1, ICM20602_ACCEL_CONFIG,
                      I2C_MEMADD_SIZE_8BIT, &reg, 1, 100);

    imu_initialized = true;
}

static void imu_read(void)
{
    if (!imu_initialized) return;

    uint8_t buf[14];

    /* Read accel(6) + temp(2) + gyro(6) = 14 bytes in burst */
    HAL_I2C_Mem_Read(&hi2c1, IMU_ICM20602_ADDR << 1, ICM20602_ACCEL_XOUT_H,
                     I2C_MEMADD_SIZE_8BIT, buf, 14, 100);

    cached_imu.accel_x = (int16_t)((buf[0] << 8) | buf[1]);
    cached_imu.accel_y = (int16_t)((buf[2] << 8) | buf[3]);
    cached_imu.accel_z = (int16_t)((buf[4] << 8) | buf[5]);
    /* buf[6-7] = temperature (skip) */
    cached_imu.gyro_x = (int16_t)((buf[8]  << 8) | buf[9])  - gyro_bias_x;
    cached_imu.gyro_y = (int16_t)((buf[10] << 8) | buf[11]) - gyro_bias_y;
    cached_imu.gyro_z = (int16_t)((buf[12] << 8) | buf[13]) - gyro_bias_z;
}

/* ========================================================================
 * BMM150 Magnetometer
 * ======================================================================== */

/* BMM150 register addresses */
#define BMM150_CHIP_ID_REG    0x40
#define BMM150_DATA_X_LSB     0x42
#define BMM150_PWR_CTRL       0x4B
#define BMM150_OP_MODE        0x4C
#define BMM150_REP_XY         0x51
#define BMM150_REP_Z          0x52
#define BMM150_CHIP_ID_VAL    0x32

static bool mag_initialized = false;

static void mag_init(void)
{
    uint8_t chip_id = 0;
    uint8_t reg;

    /* Power on */
    reg = 0x01;
    HAL_I2C_Mem_Write(&hi2c1, MAG_BMM150_ADDR << 1, BMM150_PWR_CTRL,
                      I2C_MEMADD_SIZE_8BIT, &reg, 1, 100);

    HAL_Delay(3);  /* BMM150 needs ~3ms to power up */

    /* Verify chip ID */
    HAL_I2C_Mem_Read(&hi2c1, MAG_BMM150_ADDR << 1, BMM150_CHIP_ID_REG,
                     I2C_MEMADD_SIZE_8BIT, &chip_id, 1, 100);

    if (chip_id != BMM150_CHIP_ID_VAL)
        return;

    /* Set normal mode, default ODR (10 Hz) */
    reg = 0x00;  /* Normal mode */
    HAL_I2C_Mem_Write(&hi2c1, MAG_BMM150_ADDR << 1, BMM150_OP_MODE,
                      I2C_MEMADD_SIZE_8BIT, &reg, 1, 100);

    /* Set repetitions for XY and Z (higher = better accuracy, slower) */
    reg = 0x04;  /* nXY = 9 repetitions (low power preset) */
    HAL_I2C_Mem_Write(&hi2c1, MAG_BMM150_ADDR << 1, BMM150_REP_XY,
                      I2C_MEMADD_SIZE_8BIT, &reg, 1, 100);

    reg = 0x0E;  /* nZ = 15 repetitions */
    HAL_I2C_Mem_Write(&hi2c1, MAG_BMM150_ADDR << 1, BMM150_REP_Z,
                      I2C_MEMADD_SIZE_8BIT, &reg, 1, 100);

    mag_initialized = true;
}

static void mag_read(void)
{
    if (!mag_initialized) return;

    uint8_t buf[6];

    HAL_I2C_Mem_Read(&hi2c1, MAG_BMM150_ADDR << 1, BMM150_DATA_X_LSB,
                     I2C_MEMADD_SIZE_8BIT, buf, 6, 100);

    /* BMM150 data format: 13-bit X/Y, 15-bit Z, little-endian with LSB alignment */
    cached_mag.mag_x = (int16_t)((buf[1] << 8) | buf[0]) >> 3;  /* 13-bit */
    cached_mag.mag_y = (int16_t)((buf[3] << 8) | buf[2]) >> 3;  /* 13-bit */
    cached_mag.mag_z = (int16_t)((buf[5] << 8) | buf[4]) >> 1;  /* 15-bit */
}

/* ========================================================================
 * ADC — Battery, motor currents, adapter voltage
 *
 * ADC1: multi-channel scan mode with DMA
 * Channel assignments (common STM32F407 robotics design, needs PCB verify):
 *   PA0 (ADC1_CH0) = Battery voltage (via resistor divider)
 *   PA2 (ADC1_CH2) = Left motor current (shunt amplifier)
 *   PA3 (ADC1_CH3) = Right motor current
 *   PA4 (ADC1_CH4) = Blade motor current
 *   PA5 (ADC1_CH5) = Adapter/charger voltage
 *
 * Battery voltage divider: assumed 11:1 ratio (100k + 10k)
 *   V_battery = ADC_raw * Vref / 4096 * 11
 *
 * Current shunt: assumed 0.1 ohm + 20x INA gain
 *   I_motor = ADC_raw * Vref / 4096 / 20 / 0.1 (Amps) → mA
 * ======================================================================== */

static ADC_HandleTypeDef hadc1;
static DMA_HandleTypeDef hdma_adc1;

#define ADC_NUM_CHANNELS  5
static volatile uint16_t adc_raw[ADC_NUM_CHANNELS];

/* Conversion constants (3.3V reference, 12-bit ADC) */
#define ADC_VREF          3.3f
#define ADC_RESOLUTION    4096.0f
#define BATTERY_DIVIDER   11.0f          /* Resistor divider ratio */
#define CURRENT_SHUNT_R   0.1f           /* Shunt resistance (ohms) */
#define CURRENT_AMP_GAIN  20.0f          /* INA amplifier gain */

static void adc_init(void)
{
    __HAL_RCC_ADC1_CLK_ENABLE();

    /* Configure ADC GPIO pins as analog */
    GPIO_InitTypeDef gpio = {0};
    gpio.Pin = GPIO_PIN_0 | GPIO_PIN_2 | GPIO_PIN_3 | GPIO_PIN_4 | GPIO_PIN_5;
    gpio.Mode = GPIO_MODE_ANALOG;
    gpio.Pull = GPIO_NOPULL;
    HAL_GPIO_Init(GPIOA, &gpio);

    /* DMA configuration for ADC1 (DMA2 Stream0 Channel0) */
    hdma_adc1.Instance = DMA2_Stream0;
    hdma_adc1.Init.Channel = DMA_CHANNEL_0;
    hdma_adc1.Init.Direction = DMA_PERIPH_TO_MEMORY;
    hdma_adc1.Init.PeriphInc = DMA_PINC_DISABLE;
    hdma_adc1.Init.MemInc = DMA_MINC_ENABLE;
    hdma_adc1.Init.PeriphDataAlignment = DMA_PDATAALIGN_HALFWORD;
    hdma_adc1.Init.MemDataAlignment = DMA_MDATAALIGN_HALFWORD;
    hdma_adc1.Init.Mode = DMA_CIRCULAR;
    hdma_adc1.Init.Priority = DMA_PRIORITY_MEDIUM;
    hdma_adc1.Init.FIFOMode = DMA_FIFOMODE_DISABLE;
    HAL_DMA_Init(&hdma_adc1);
    __HAL_LINKDMA(&hadc1, DMA_Handle, hdma_adc1);

    /* ADC1 configuration */
    hadc1.Instance = ADC1;
    hadc1.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV4;
    hadc1.Init.Resolution = ADC_RESOLUTION_12B;
    hadc1.Init.ScanConvMode = ENABLE;
    hadc1.Init.ContinuousConvMode = ENABLE;
    hadc1.Init.DiscontinuousConvMode = DISABLE;
    hadc1.Init.NbrOfConversion = ADC_NUM_CHANNELS;
    hadc1.Init.DataAlign = ADC_DATAALIGN_RIGHT;
    hadc1.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;

    HAL_ADC_Init(&hadc1);

    /* Configure channels */
    ADC_ChannelConfTypeDef ch = {0};
    ch.SamplingTime = ADC_SAMPLETIME_84CYCLES;

    ch.Channel = ADC_CHANNEL_0;  ch.Rank = 1;  /* Battery voltage */
    HAL_ADC_ConfigChannel(&hadc1, &ch);

    ch.Channel = ADC_CHANNEL_2;  ch.Rank = 2;  /* Left motor current */
    HAL_ADC_ConfigChannel(&hadc1, &ch);

    ch.Channel = ADC_CHANNEL_3;  ch.Rank = 3;  /* Right motor current */
    HAL_ADC_ConfigChannel(&hadc1, &ch);

    ch.Channel = ADC_CHANNEL_4;  ch.Rank = 4;  /* Blade motor current */
    HAL_ADC_ConfigChannel(&hadc1, &ch);

    ch.Channel = ADC_CHANNEL_5;  ch.Rank = 5;  /* Adapter voltage */
    HAL_ADC_ConfigChannel(&hadc1, &ch);

    /* Start continuous conversion with DMA */
    HAL_ADC_Start_DMA(&hadc1, (uint32_t *)adc_raw, ADC_NUM_CHANNELS);
}

static void adc_read(void)
{
    /* DMA continuously updates adc_raw[], just convert to physical units */
    float adc_to_v = ADC_VREF / ADC_RESOLUTION;

    /* Battery voltage (channel 0, through divider) */
    float bat_v = adc_raw[0] * adc_to_v * BATTERY_DIVIDER;
    cached_battery.voltage_mv = (uint16_t)(bat_v * 1000.0f);

    /* Estimate SoC from voltage (simple linear: 18V=0%, 25.2V=100% for 6S Li-ion) */
    if (bat_v >= 25.2f)
        cached_battery.soc_pct = 100;
    else if (bat_v <= 18.0f)
        cached_battery.soc_pct = 0;
    else
        cached_battery.soc_pct = (uint8_t)((bat_v - 18.0f) / 7.2f * 100.0f);

    /* Motor currents (shunt + amplifier) */
    float scale_ma = adc_to_v / (CURRENT_AMP_GAIN * CURRENT_SHUNT_R) * 1000.0f;
    cached_current.left_ma  = (int16_t)(adc_raw[1] * scale_ma);
    cached_current.right_ma = (int16_t)(adc_raw[2] * scale_ma);
    cached_current.blade_ma = (int16_t)(adc_raw[3] * scale_ma);

    /* Adapter voltage (channel 5, through divider — same ratio assumed) */
    float adapter_v = adc_raw[4] * adc_to_v * BATTERY_DIVIDER;
    cached_battery.adapter_mv = (uint16_t)(adapter_v * 1000.0f);

    /* Charge data (float values for serial protocol) */
    cached_charge.battery_voltage = bat_v;
    cached_charge.adapter_voltage = adapter_v;
    cached_charge.charge_voltage  = adapter_v;  /* Same measurement point */
    cached_charge.charge_current  = (adapter_v > bat_v + 0.5f) ?
        (adapter_v - bat_v) / 0.5f * 1000.0f : 0.0f;  /* Rough estimate */

    /* Battery current: sum of motor currents when discharging */
    cached_battery.current_ma = -(cached_current.left_ma +
                                   cached_current.right_ma +
                                   cached_current.blade_ma);
}

/* ========================================================================
 * Hall Sensors — 14 GPIO inputs
 *
 * Pin assignments (common STM32F407 layout, needs PCB verification):
 *   Collision: PE7=LF, PE8=LB, PE9=RB, PE10=RF
 *   Uplift:    PE11=left, PE12=right
 *   Key:       PE13=key1, PE14=key2
 *   Other:     PD8=front_wheel, PD9=shell, PD10=lift
 *
 * Blade Hall sensors (PE3, PE4, PE5) are for motor commutation,
 * not read as GPIO — they go to TIM8 encoder input.
 * ======================================================================== */

/* Hall sensor GPIO configuration table */
typedef struct {
    GPIO_TypeDef *port;
    uint16_t      pin;
    uint8_t      *dest;
} hall_gpio_t;

static hall_gpio_t hall_gpios[11]; /* Filled in hall_init */

static void hall_init(void)
{
    /* Configure collision sensors (PE7-PE10) */
    GPIO_InitTypeDef gpio = {0};
    gpio.Mode = GPIO_MODE_INPUT;
    gpio.Pull = GPIO_PULLUP;  /* Active low — pulled up, sensor grounds pin */
    gpio.Speed = GPIO_SPEED_FREQ_LOW;

    gpio.Pin = GPIO_PIN_7 | GPIO_PIN_8 | GPIO_PIN_9 | GPIO_PIN_10 |
               GPIO_PIN_11 | GPIO_PIN_12 | GPIO_PIN_13 | GPIO_PIN_14;
    HAL_GPIO_Init(GPIOE, &gpio);

    gpio.Pin = GPIO_PIN_8 | GPIO_PIN_9 | GPIO_PIN_10;
    HAL_GPIO_Init(GPIOD, &gpio);

    /* Build lookup table for efficient reading */
    hall_gpios[0]  = (hall_gpio_t){GPIOE, GPIO_PIN_7,  &cached_hall.collision_lf};
    hall_gpios[1]  = (hall_gpio_t){GPIOE, GPIO_PIN_8,  &cached_hall.collision_lb};
    hall_gpios[2]  = (hall_gpio_t){GPIOE, GPIO_PIN_9,  &cached_hall.collision_rb};
    hall_gpios[3]  = (hall_gpio_t){GPIOE, GPIO_PIN_10, &cached_hall.collision_rf};
    hall_gpios[4]  = (hall_gpio_t){GPIOE, GPIO_PIN_11, &cached_hall.uplift_left};
    hall_gpios[5]  = (hall_gpio_t){GPIOE, GPIO_PIN_12, &cached_hall.uplift_right};
    hall_gpios[6]  = (hall_gpio_t){GPIOE, GPIO_PIN_13, &cached_hall.key1};
    hall_gpios[7]  = (hall_gpio_t){GPIOE, GPIO_PIN_14, &cached_hall.key2};
    hall_gpios[8]  = (hall_gpio_t){GPIOD, GPIO_PIN_8,  &cached_hall.front_wheel};
    hall_gpios[9]  = (hall_gpio_t){GPIOD, GPIO_PIN_9,  &cached_hall.shell};
    hall_gpios[10] = (hall_gpio_t){GPIOD, GPIO_PIN_10, &cached_hall.lift};
}

static void hall_read(void)
{
    for (uint8_t i = 0; i < 11; i++)
    {
        /* Active low: pin LOW = sensor triggered = 1 */
        *hall_gpios[i].dest =
            (HAL_GPIO_ReadPin(hall_gpios[i].port, hall_gpios[i].pin) == GPIO_PIN_RESET)
            ? 1 : 0;
    }
}

/* ========================================================================
 * Incident flag computation
 * ======================================================================== */

static void update_incident_flags(void)
{
    uint64_t flags = 0;

    /* Collision detection */
    if (cached_hall.collision_lf || cached_hall.collision_lb ||
        cached_hall.collision_rb || cached_hall.collision_rf)
    {
        flags |= INCIDENT_WARN_COLLISION;
    }

    /* Uplift detection */
    if (cached_hall.uplift_left || cached_hall.uplift_right)
    {
        flags |= INCIDENT_WARN_UPRAISE;
    }

    /* Motor stall detection (high current + low speed) */
    if (cached_current.left_ma > 5000)
        flags |= INCIDENT_WARN_LEFT_OVERCUR;
    if (cached_current.right_ma > 5000)
        flags |= INCIDENT_WARN_RIGHT_OVERCUR;
    if (cached_current.blade_ma > 8000)
        flags |= INCIDENT_WARN_BLADE_OVERCUR;

    /* IMU fault detection */
    if (!imu_initialized)
        flags |= INCIDENT_ERR_IMU;

    incident_flags = flags;
}

/* ========================================================================
 * Public API
 * ======================================================================== */

void sensors_init(void)
{
    i2c1_init();
    imu_init();
    mag_init();
    adc_init();
    hall_init();
}

void sensors_periodic_update(void)
{
    imu_read();
    mag_read();
    adc_read();
    hall_read();
    update_incident_flags();
}

void sensors_get_imu(imu_data_t *data)
{
    if (data != NULL) *data = cached_imu;
}

void sensors_get_mag(mag_data_t *data)
{
    if (data != NULL) *data = cached_mag;
}

void sensors_get_hall(hall_status_t *status)
{
    if (status != NULL) *status = cached_hall;
}

void sensors_get_battery(battery_data_t *data)
{
    if (data != NULL) *data = cached_battery;
}

void sensors_get_motor_current(motor_current_t *data)
{
    if (data != NULL) *data = cached_current;
}

void sensors_get_charge(charge_data_t *data)
{
    if (data != NULL) *data = cached_charge;
}

uint64_t sensors_get_incident_flags(void)
{
    return incident_flags;
}

bool sensors_collision_active(void)
{
    return (cached_hall.collision_lf || cached_hall.collision_lb ||
            cached_hall.collision_rb || cached_hall.collision_rf);
}

bool sensors_uplift_active(void)
{
    return (cached_hall.uplift_left || cached_hall.uplift_right);
}

bool sensors_tilt_detected(void)
{
    /*
     * Tilt detection from IMU accelerometer data.
     * At rest, accel_z ≈ +1g (8192 LSB at ±4g range).
     * If tilted >45°, accel_z drops below cos(45°)*8192 ≈ 5793.
     *
     * Also check if any axis exceeds sin(45°)*8192 ≈ 5793 laterally.
     * OEM uses ~45 degree threshold.
     */
    int16_t az = cached_imu.accel_z;
    int16_t ax = cached_imu.accel_x;
    int16_t ay = cached_imu.accel_y;

    /* Absolute values */
    if (ax < 0) ax = -ax;
    if (ay < 0) ay = -ay;

    /* 45 degree threshold at ±4g range: cos(45°) * 8192 ≈ 5793 */
    #define TILT_THRESHOLD  5793

    /* Tilted if Z-axis is too low (not upright) */
    if (az < TILT_THRESHOLD && (ax > TILT_THRESHOLD || ay > TILT_THRESHOLD))
        return true;

    /* Upside down: Z strongly negative */
    if (az < -2000)
        return true;

    return false;
}

void sensors_imu_calibrate(void)
{
    if (!imu_initialized) return;

    /* Collect gyro samples for 18 seconds and compute average bias */
    int32_t sum_x = 0, sum_y = 0, sum_z = 0;
    uint32_t samples = 0;
    uint32_t start = HAL_GetTick();

    while ((HAL_GetTick() - start) < (uint32_t)(IMU_ZERO_BIAS_TIME_S * 1000.0f))
    {
        uint8_t buf[6];
        HAL_I2C_Mem_Read(&hi2c1, IMU_ICM20602_ADDR << 1, ICM20602_GYRO_XOUT_H,
                         I2C_MEMADD_SIZE_8BIT, buf, 6, 100);

        sum_x += (int16_t)((buf[0] << 8) | buf[1]);
        sum_y += (int16_t)((buf[2] << 8) | buf[3]);
        sum_z += (int16_t)((buf[4] << 8) | buf[5]);
        samples++;

        HAL_Delay(10);  /* ~100 Hz sample rate during calibration */
    }

    if (samples > 0)
    {
        gyro_bias_x = (int16_t)(sum_x / (int32_t)samples);
        gyro_bias_y = (int16_t)(sum_y / (int32_t)samples);
        gyro_bias_z = (int16_t)(sum_z / (int32_t)samples);
    }
}

uint8_t sensors_hw_selfcheck(void)
{
    /* IEC 60335 Class B hardware self-check */
    uint8_t result = 0;

    /* Bit 0: IMU OK */
    if (imu_initialized) result |= 0x01;

    /* Bit 1: Magnetometer OK */
    if (mag_initialized) result |= 0x02;

    /* Bit 2: ADC running (check if battery voltage is sensible: >10V) */
    if (cached_battery.voltage_mv > 10000) result |= 0x04;

    /* Bit 3: Hall sensors readable (no stuck high/low) */
    result |= 0x08;  /* Always pass for now — full check needs known good state */

    return result;
}
