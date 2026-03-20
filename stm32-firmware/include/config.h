#ifndef CONFIG_H
#define CONFIG_H

/*
 * Open-source STM32F407 Motor Controller Firmware — Novabot Mower
 *
 * Single source of truth for all hardware constants, pin assignments,
 * protocol definitions, and tuning parameters.
 *
 * Sources:
 *   - research/chassis_serial_protocol.md (complete serial protocol)
 *   - research/STM32_firmware_feasibility_analysis.md (hardware analysis)
 *   - chassis_control_node binary (ARM64, not stripped) reverse engineering
 *   - URDF files (wheel dimensions, sensor positions)
 */

/* ========================================================================
 * FIRMWARE VERSION
 * ======================================================================== */

#define FIRMWARE_VERSION_MAJOR   0
#define FIRMWARE_VERSION_MINOR   1
#define FIRMWARE_VERSION_PATCH   0
#define FIRMWARE_VERSION_STRING  "v0.1.0-dev"

/* ========================================================================
 * MCU CONFIGURATION — STM32F407VGT6
 * ======================================================================== */

#define SYSCLK_FREQ_HZ          168000000U   /* 168 MHz via HSE + PLL */
#define HSE_FREQ_HZ             8000000U     /* 8 MHz external crystal */
#define APB1_FREQ_HZ            42000000U    /* APB1 = SYSCLK/4 */
#define APB2_FREQ_HZ            84000000U    /* APB2 = SYSCLK/2 */
#define SYSTICK_FREQ_HZ         1000U        /* 1ms SysTick interval */

/* ========================================================================
 * MOTOR CONFIGURATION — 4 motors, differential drive
 * ======================================================================== */

/* --- Wheel Motors (TIM1, 50kHz PWM) --- */
#define MOTOR_LEFT_TIMER         TIM1
#define MOTOR_RIGHT_TIMER        TIM1
#define MOTOR_PWM_FREQ_HZ       50000U       /* 50 kHz */
#define MOTOR_PWM_ARR            1679U        /* 84MHz / 50kHz - 1 */
#define MOTOR_TIM1_CCER          0x1111U      /* 4 channels, no complementary */

/* --- Blade Motor (TIM8, 84kHz PWM) --- */
#define BLADE_TIMER              TIM8
#define BLADE_PWM_FREQ_HZ       84000U       /* 84 kHz */
#define BLADE_PWM_ARR            999U         /* 84MHz / 84kHz - 1 */

/* --- Lift Motor (TIM8, 25kHz PWM) --- */
#define LIFT_TIMER               TIM8
#define LIFT_PWM_FREQ_HZ        25000U       /* 25 kHz */
#define LIFT_PWM_ARR             3359U        /* 84MHz / 25kHz - 1 */

/* --- Motor Direction (GPIO + PWM magnitude, NOT complementary) --- */
/* TODO: Exact GPIO pins need PCB trace / test verification */
/* #define MOTOR_LEFT_DIR_PORT    GPIOX */
/* #define MOTOR_LEFT_DIR_PIN     GPIO_PIN_X */
/* #define MOTOR_RIGHT_DIR_PORT   GPIOX */
/* #define MOTOR_RIGHT_DIR_PIN    GPIO_PIN_X */

/* ========================================================================
 * DIFFERENTIAL DRIVE KINEMATICS (from URDF)
 * ======================================================================== */

#define WHEEL_SEPARATION_M       0.40342f    /* Track width, center-to-center */
#define WHEEL_DIAMETER_M         0.22356f    /* Wheel diameter */
#define WHEEL_RADIUS_M           0.11178f    /* Wheel radius */
#define ROBOT_MASS_KG            9.366f      /* Total mass (body + 2 wheels) */

/* Speed conversion: m/s -> mm/s (serial protocol uses mm/s) */
#define SPEED_MPS_TO_MMPS        1000.0f

/* ========================================================================
 * SERIAL PROTOCOL — X3 <-> STM32 via USB (USART1 / /dev/ttyACM*)
 * ======================================================================== */

/* --- Frame format --- */
#define SERIAL_HEADER_BYTE       0x02
#define SERIAL_FOOTER_BYTE       0x03
#define SERIAL_HEADER_WORD       0x0202U     /* 2-byte header */
#define SERIAL_FOOTER_WORD       0x0303U     /* 2-byte footer */
#define SERIAL_FRAME_OVERHEAD    7U          /* header(2) + cmd(2) + len(1) + footer(2) */
#define SERIAL_MAX_PAYLOAD       255U
#define SERIAL_RX_BUFFER_SIZE    1200U       /* Matches OEM firmware */

/* --- Command IDs (big-endian in frame) --- */
#define CMD_ID_X3_TO_STM32       0x07FFU     /* All X3->STM32 commands */
#define CMD_ID_STM32_TO_X3_1     0x0001U     /* STM32->X3 data reports */
#define CMD_ID_STM32_TO_X3_2     0x0002U     /* STM32->X3 data reports */

/* --- Sub-commands: STM32 -> X3 (we SEND these) --- */
#define SUBCMD_TX_VERSION        0x01U
#define SUBCMD_TX_WHEEL_SPEED    0x03U
#define SUBCMD_TX_GNGGA          0x05U
#define SUBCMD_TX_TIME_SYNC      0x06U
#define SUBCMD_TX_IMU_COMPOSITE  0x08U
#define SUBCMD_TX_IMU_40608      0x09U
#define SUBCMD_TX_MOTOR_CURRENT  0x0AU
#define SUBCMD_TX_CHARGE_DATA    0x0BU
#define SUBCMD_TX_HALL_STATUS    0x0CU
#define SUBCMD_TX_MCU_LOG        0x0FU
#define SUBCMD_TX_BATTERY        0x17U
#define SUBCMD_TX_INCIDENT       0x18U
#define SUBCMD_TX_HW_SELFCHECK   0x20U
#define SUBCMD_TX_MATCHED_POSA   0x3DU
#define SUBCMD_TX_PSRDOPA        0x3FU
#define SUBCMD_TX_BESTPOS        0x40U
#define SUBCMD_TX_BESTVEL        0x41U
#define SUBCMD_TX_IMU_20602      0x42U
#define SUBCMD_TX_BMM150         0x43U
#define SUBCMD_TX_LORA_STATUS    0x58U
#define SUBCMD_TX_JSON_DATA      0x80U

/* --- Sub-commands: X3 -> STM32 (we RECEIVE these) --- */
#define SUBCMD_RX_VELOCITY       0x02U
#define SUBCMD_RX_LED            0x0DU
#define SUBCMD_RX_BLADE_SPEED    0x12U
#define SUBCMD_RX_BLADE_UP       0x14U
#define SUBCMD_RX_BLADE_DOWN     0x15U
#define SUBCMD_RX_RTK_LOST       0x19U
#define SUBCMD_RX_CHARGE_LOCK    0x22U
#define SUBCMD_RX_BLADE_HEIGHT   0x23U
#define SUBCMD_RX_BLADE_HEIGHT2  0x44U
#define SUBCMD_RX_CHARGE_LOCK2   0x46U
#define SUBCMD_RX_ROBOT_STATUS   0x50U
#define SUBCMD_RX_RTK_STATUS     0x55U
#define SUBCMD_RX_RTK_RECOVERY   0x5EU
#define SUBCMD_RX_UNBIND         0x71U
#define SUBCMD_RX_LED_SPECIAL    0xF1U

/* ========================================================================
 * CRC-8 — ITU-T standard (polynomial 0x07, init 0x00)
 * ======================================================================== */

#define CRC8_POLYNOMIAL          0x07U
#define CRC8_INIT                0x00U

/* ========================================================================
 * UART ASSIGNMENTS
 * ======================================================================== */

#define UART_X3_SERIAL           USART1      /* -> X3 SoC (chassis_control_node) */
#define UART_X3_BAUD             115200U

#define UART_GPS                 UART5       /* -> UM960 RTK GPS */
#define UART_GPS_BAUD            115200U

#define UART_LORA                USART3      /* -> LoRa module (charger comms) */
#define UART_LORA_BAUD           115200U

/* ========================================================================
 * I2C — Sensors
 * ======================================================================== */

#define I2C_SENSORS              I2C1        /* IMU + magnetometer */
#define IMU_ICM20602_ADDR        0x68U       /* ICM-20602 (6-axis accel/gyro) */
#define MAG_BMM150_ADDR          0x10U       /* BMM150 (3-axis magnetometer) */

/* ========================================================================
 * SPI — Display
 * ======================================================================== */

#define SPI_DISPLAY              SPI2        /* Color LCD, LVGL */

/* ========================================================================
 * ADC — Analog measurements
 * ======================================================================== */

/* ADC1 + ADC3 active (DMA continuous), ADC2 minimal */
/* TODO: Exact channel mapping needs PCB verification */
/* #define ADC_BATTERY_VOLTAGE_CH   ADC_CHANNEL_X */
/* #define ADC_MOTOR_LEFT_CURR_CH   ADC_CHANNEL_X */
/* #define ADC_MOTOR_RIGHT_CURR_CH  ADC_CHANNEL_X */
/* #define ADC_BLADE_CURR_CH        ADC_CHANNEL_X */
/* #define ADC_ADAPTER_VOLTAGE_CH   ADC_CHANNEL_X */

/* Battery threshold for PIN lock (from firmware analysis) */
#define BATTERY_VOLTAGE_THRESHOLD_V  19.0f

/* ========================================================================
 * WATCHDOG — Dual watchdog (IEC 60335 Class B)
 * ======================================================================== */

#define IWDG_PRESCALER           IWDG_PRESCALER_64
#define IWDG_RELOAD              0xFFFU      /* ~4s timeout at 32kHz LSI */
#define WWDG_PRESCALER           WWDG_PRESCALER_8

/* ========================================================================
 * HALL SENSORS — 14 total
 * ======================================================================== */

/* 4 collision (front: left_front, left_behind, right_behind, right_front) */
/* 2 uplift */
/* 2 key/button */
/* 3 cut motor */
/* 3 other (front wheel, shell, lift) */
/* TODO: GPIO pin mapping needs PCB verification */

/* ========================================================================
 * GPS — UM960 RTK receiver
 * ======================================================================== */

#define GPS_ANTENNA_OFFSET_X_M   0.186f      /* Forward from wheel axis (new HW) */
#define GPS_ANTENNA_OFFSET_Z_M   0.15f       /* Above wheel axis */
#define GPS_MAX_DIFF_AGE_S       30.0f       /* Max RTK correction age */

/* UM960 NovAtel-compatible commands (configured at 5Hz / 0.2s) */
#define GPS_CMD_BESTPOS          "#BESTPOS"
#define GPS_CMD_BESTVEL          "#BESTVEL"
#define GPS_CMD_PSRDOPA          "#PSRDOPA"
#define GPS_CMD_MATCHEDPOSA      "#MATCHEDPOSA"
#define GPS_CMD_GNGGA            "$GNGGA"

/* ========================================================================
 * IMU — ICM-20602 + BMM150
 * ======================================================================== */

#define IMU_OFFSET_X_M           -0.082f     /* Behind wheel axis (new HW) */
#define IMU_OFFSET_Z_M           0.07f       /* Above wheel axis */
#define IMU_YAW_ROTATION_RAD     1.5707f     /* 90 deg: mounted sideways */
#define IMU_ROLL_BIAS_RAD        -0.0081f    /* Physical mounting tilt */
#define IMU_ZERO_BIAS_TIME_S     18.0f       /* Gyro calibration at boot */

/* ========================================================================
 * LoRa — Charger communication
 * ======================================================================== */

#define LORA_CMD_DATA            0x34U       /* Data transfer command */
#define LORA_CMD_CHANNEL         0x36U       /* Channel change command */

/* ========================================================================
 * INCIDENT FLAGS — 48+ types (4 severity levels)
 * ======================================================================== */

/* Event flags */
#define INCIDENT_EVENT_START_MOWING      (1ULL << 0)
#define INCIDENT_EVENT_START_RECHARGING  (1ULL << 1)

/* Warning flags */
#define INCIDENT_WARN_COLLISION          (1ULL << 8)
#define INCIDENT_WARN_UPRAISE            (1ULL << 9)
#define INCIDENT_WARN_TILT               (1ULL << 10)
#define INCIDENT_WARN_LEFT_STALL         (1ULL << 11)
#define INCIDENT_WARN_RIGHT_STALL        (1ULL << 12)
#define INCIDENT_WARN_LEFT_OVERCUR       (1ULL << 13)
#define INCIDENT_WARN_RIGHT_OVERCUR      (1ULL << 14)
#define INCIDENT_WARN_BLADE_STALL        (1ULL << 15)
#define INCIDENT_WARN_BLADE_OVERCUR      (1ULL << 16)

/* Error flags */
#define INCIDENT_ERR_COLLISION           (1ULL << 24)
#define INCIDENT_ERR_TURN_OVER           (1ULL << 25)
#define INCIDENT_ERR_IMU                 (1ULL << 26)
#define INCIDENT_ERR_LORA                (1ULL << 27)
#define INCIDENT_ERR_RTK                 (1ULL << 28)
#define INCIDENT_ERR_NO_PIN_CODE         (1ULL << 29)
#define INCIDENT_ERR_USB_BUSY            (1ULL << 30)
#define INCIDENT_ERR_LIFT_MOTOR          (1ULL << 31)

/* Class B flags (IEC 60335 safety) */
#define INCIDENT_CLASSB_CPU_REGS         (1ULL << 40)
#define INCIDENT_CLASSB_STACK_OVF        (1ULL << 41)
#define INCIDENT_CLASSB_CLOCK            (1ULL << 42)
#define INCIDENT_CLASSB_FLASH_CRC        (1ULL << 43)
#define INCIDENT_CLASSB_RAM              (1ULL << 44)
#define INCIDENT_CLASSB_EXT_COMM         (1ULL << 45)
#define INCIDENT_CLASSB_ADC              (1ULL << 46)

#endif /* CONFIG_H */
