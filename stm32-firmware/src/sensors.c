/*
 * Sensor management — IMU (ICM-20602), magnetometer (BMM150),
 * Hall sensors (14x), ADC (battery, motor current, adapter voltage)
 *
 * All sensor reads are cached and updated periodically from the main loop.
 * The serial protocol module reads cached values for reporting to X3.
 */

#include "sensors.h"
#include "config.h"
#include "stm32f4xx_hal.h"
#include <string.h>

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
 * ======================================================================== */

static void i2c1_init(void)
{
    __HAL_RCC_I2C1_CLK_ENABLE();

    /* TODO: Configure I2C1 GPIO pins (likely PB6=SCL, PB7=SDA) */
    /* Needs PCB verification */

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
#define ICM20602_WHO_AM_I     0x75
#define ICM20602_PWR_MGMT_1   0x6B
#define ICM20602_ACCEL_XOUT_H 0x3B
#define ICM20602_GYRO_XOUT_H  0x43
#define ICM20602_WHO_AM_I_VAL 0x12

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

    /* Wake up (clear sleep bit) */
    reg = 0x01;  /* Auto-select best clock source */
    HAL_I2C_Mem_Write(&hi2c1, IMU_ICM20602_ADDR << 1, ICM20602_PWR_MGMT_1,
                      I2C_MEMADD_SIZE_8BIT, &reg, 1, 100);

    imu_initialized = true;
}

static void imu_read(void)
{
    if (!imu_initialized) return;

    uint8_t buf[12];

    /* Read 6 bytes accelerometer (XYZ, big-endian) */
    HAL_I2C_Mem_Read(&hi2c1, IMU_ICM20602_ADDR << 1, ICM20602_ACCEL_XOUT_H,
                     I2C_MEMADD_SIZE_8BIT, buf, 6, 100);

    cached_imu.accel_x = (int16_t)((buf[0] << 8) | buf[1]);
    cached_imu.accel_y = (int16_t)((buf[2] << 8) | buf[3]);
    cached_imu.accel_z = (int16_t)((buf[4] << 8) | buf[5]);

    /* Read 6 bytes gyroscope (XYZ, big-endian) */
    HAL_I2C_Mem_Read(&hi2c1, IMU_ICM20602_ADDR << 1, ICM20602_GYRO_XOUT_H,
                     I2C_MEMADD_SIZE_8BIT, buf, 6, 100);

    cached_imu.gyro_x = (int16_t)((buf[0] << 8) | buf[1]) - gyro_bias_x;
    cached_imu.gyro_y = (int16_t)((buf[2] << 8) | buf[3]) - gyro_bias_y;
    cached_imu.gyro_z = (int16_t)((buf[4] << 8) | buf[5]) - gyro_bias_z;
}

/* ========================================================================
 * BMM150 Magnetometer
 * ======================================================================== */

/* BMM150 register addresses */
#define BMM150_CHIP_ID_REG    0x40
#define BMM150_DATA_X_LSB     0x42
#define BMM150_PWR_CTRL       0x4B
#define BMM150_OP_MODE        0x4C
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

    /* Set normal mode, default ODR */
    reg = 0x00;  /* Normal mode */
    HAL_I2C_Mem_Write(&hi2c1, MAG_BMM150_ADDR << 1, BMM150_OP_MODE,
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
 * ======================================================================== */

static ADC_HandleTypeDef hadc1;

static void adc_init(void)
{
    __HAL_RCC_ADC1_CLK_ENABLE();

    hadc1.Instance = ADC1;
    hadc1.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV4;
    hadc1.Init.Resolution = ADC_RESOLUTION_12B;
    hadc1.Init.ScanConvMode = ENABLE;
    hadc1.Init.ContinuousConvMode = ENABLE;
    hadc1.Init.DiscontinuousConvMode = DISABLE;
    hadc1.Init.NbrOfConversion = 1;
    hadc1.Init.DataAlign = ADC_DATAALIGN_RIGHT;
    hadc1.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;

    HAL_ADC_Init(&hadc1);

    /* TODO: Configure ADC channels for battery, motor currents, adapter */
    /* Exact channel mapping needs PCB verification */
}

static void adc_read(void)
{
    /* TODO: Read ADC values and convert to physical units */
    /* For now, use placeholder values */
}

/* ========================================================================
 * Hall Sensors — 14 GPIO inputs
 * ======================================================================== */

static void hall_init(void)
{
    /* TODO: Configure 14 Hall sensor GPIO pins as inputs with pull-ups */
    /* Pin mapping needs PCB verification */
}

static void hall_read(void)
{
    /* TODO: Read all 14 Hall sensor GPIO pins */
    /* For now, all clear (no collision/uplift) */
    memset(&cached_hall, 0, sizeof(cached_hall));
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

    /* Motor overcurrent detection */
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
    /* TODO: Implement tilt detection from IMU accelerometer data */
    /* OEM uses ~45 degree threshold */
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

    /* TODO: Add more self-checks (ADC, RAM, Flash CRC, clock) */

    return result;
}
