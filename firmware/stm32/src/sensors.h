#ifndef SENSORS_H
#define SENSORS_H

#include <stdint.h>
#include <stdbool.h>

/*
 * Sensor management — IMU, Hall sensors, ADC, magnetometer
 *
 * IMU: ICM-20602 (6-axis accel/gyro) via I2C1 at 0x68
 * Magnetometer: BMM150 (3-axis) via I2C1 at 0x10
 * Hall sensors: 14 total (4 collision, 2 uplift, 2 key, 3 blade, 3 other)
 * ADC: Battery voltage, motor currents, adapter voltage
 *
 * IMU mounting (from URDF):
 *   Offset: x = -0.082m (behind wheel axis), z = 0.07m (above)
 *   Yaw rotation: 90 deg (mounted sideways)
 *   Roll bias: -0.0081 rad
 *   Zero-bias calibration: 18s at boot
 */

/* ---- IMU data ---- */
typedef struct {
    int16_t accel_x, accel_y, accel_z;   /* Raw accelerometer (LSB) */
    int16_t gyro_x, gyro_y, gyro_z;      /* Raw gyroscope (LSB) */
} imu_data_t;

/* ---- Magnetometer data ---- */
typedef struct {
    int16_t mag_x, mag_y, mag_z;         /* Raw magnetometer (LSB) */
} mag_data_t;

/* ---- Hall sensor status ---- */
typedef struct {
    /* Collision (4 bumper sensors) */
    uint8_t collision_lf;    /* Left-front */
    uint8_t collision_lb;    /* Left-behind */
    uint8_t collision_rb;    /* Right-behind */
    uint8_t collision_rf;    /* Right-front */

    /* Uplift (2 sensors) */
    uint8_t uplift_left;
    uint8_t uplift_right;

    /* Key/button (2 sensors) */
    uint8_t key1;
    uint8_t key2;

    /* Blade motor (3 sensors — Hall commutation) */
    uint8_t blade_hall1;
    uint8_t blade_hall2;
    uint8_t blade_hall3;

    /* Other (3 sensors) */
    uint8_t front_wheel;
    uint8_t shell;           /* Cover/hood open detection */
    uint8_t lift;            /* Blade deck lift sensor */
} hall_status_t;

/* ---- Battery/ADC data ---- */
typedef struct {
    uint8_t  soc_pct;        /* State of charge (0-100%) */
    uint16_t voltage_mv;     /* Battery voltage in mV */
    int16_t  current_ma;     /* Battery current in mA (negative = discharging) */
    uint16_t adapter_mv;     /* Charger adapter voltage in mV */
} battery_data_t;

/* ---- Motor current data ---- */
typedef struct {
    int16_t left_ma;         /* Left wheel motor current */
    int16_t right_ma;        /* Right wheel motor current */
    int16_t blade_ma;        /* Blade motor current */
} motor_current_t;

/* ---- Charge data ---- */
typedef struct {
    float charge_voltage;    /* Charging voltage (V) */
    float charge_current;    /* Charging current (mA) */
    float battery_voltage;   /* Battery voltage (V) */
    float adapter_voltage;   /* Adapter voltage (V) */
} charge_data_t;

/* Initialize all sensors (I2C, ADC, GPIO) */
void sensors_init(void);

/* Periodic update — call from main loop (reads sensors, updates caches) */
void sensors_periodic_update(void);

/* ---- Accessors ---- */
void sensors_get_imu(imu_data_t *data);
void sensors_get_mag(mag_data_t *data);
void sensors_get_hall(hall_status_t *status);
void sensors_get_battery(battery_data_t *data);
void sensors_get_motor_current(motor_current_t *data);
void sensors_get_charge(charge_data_t *data);

/* ---- Incident detection ---- */
/* Returns current incident flags (see config.h INCIDENT_* defines) */
uint64_t sensors_get_incident_flags(void);

/* Check if any collision is active */
bool sensors_collision_active(void);

/* Check if robot is uplifted */
bool sensors_uplift_active(void);

/* Check if robot is tilted beyond safe angle */
bool sensors_tilt_detected(void);

/* IMU zero-bias calibration (called at boot, takes ~18s) */
void sensors_imu_calibrate(void);

/* Hardware self-check (IEC 60335 Class B) */
uint8_t sensors_hw_selfcheck(void);

#endif /* SENSORS_H */
