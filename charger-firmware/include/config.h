#pragma once

// ── Firmware version (single source of truth) ──────────────────────────────
#define FIRMWARE_VERSION "v0.1.0"

// ── UART0 — Debug console ───────────────────────────────────────────────────
#define UART_DEBUG          Serial
#define DEBUG_BAUD          115200

// ── UART1 — LoRa (EBYTE E32/E22, 433 MHz) ──────────────────────────────────
#define LORA_SERIAL         Serial1
#define LORA_TX_PIN         17
#define LORA_RX_PIN         18
#define LORA_BAUD           9600
#define LORA_M0_PIN         12
#define LORA_M1_PIN         46

// ── UART2 — GPS (UM980/UM960, GNGGA NMEA) ──────────────────────────────────
#define GPS_SERIAL          Serial2
#define GPS_TX_PIN          19
#define GPS_RX_PIN          20
#define GPS_BAUD            115200

// ── AES-128-CBC ─────────────────────────────────────────────────────────────
#define AES_KEY_PREFIX      "abcdabcd1234"     // 12 chars + SN[-4:] = 16 bytes
#define AES_IV              "abcd1234abcd1234"  // 16 bytes, static

// ── MQTT ────────────────────────────────────────────────────────────────────
#define MQTT_DEFAULT_PORT   1883
#define MQTT_TOPIC_PUB_FMT  "Dart/Receive_mqtt/%s"
#define MQTT_TOPIC_SUB_FMT  "Dart/Send_mqtt/%s"
#define MQTT_QOS_PUB        0
#define MQTT_QOS_SUB        1

// ── BLE Provisioning ────────────────────────────────────────────────────────
#define BLE_DEVICE_NAME     "CHARGER_PILE"
#define BLE_SERVICE_UUID    "00001234-0000-1000-8000-00805f9b34fb"
#define BLE_CHAR_CMD_UUID   "00002222-0000-1000-8000-00805f9b34fb"
#define BLE_CHAR_DATA_UUID  "00003333-0000-1000-8000-00805f9b34fb"
#define BLE_COMPANY_ID      0x5566
#define BLE_CHUNK_SIZE      20
#define BLE_CHUNK_DELAY_MS  30
#define BLE_RX_BUFFER_SIZE  1024

// ── LoRa Protocol ───────────────────────────────────────────────────────────
#define LORA_START_BYTE     0x02
#define LORA_END_BYTE       0x03
#define LORA_DEFAULT_ADDR_HI 0x00
#define LORA_DEFAULT_ADDR_LO 0x03  // Charger address

// ── LoRa Command Categories (first payload byte) ───────────────────────────
#define LORA_CAT_CHARGER    0x30   // Hardware control (Hall, IRQ)
#define LORA_CAT_RTK_RELAY  0x31   // RTK NMEA relay to mower
#define LORA_CAT_CONFIG     0x32   // Configuration ACK
#define LORA_CAT_GPS        0x33   // GPS position (lat/lon doubles)
#define LORA_CAT_REPORT     0x34   // Heartbeat poll + status report
#define LORA_CAT_ORDER      0x35   // Mowing commands + heartbeat
#define LORA_CAT_SCAN       0x36   // Channel scanning

// ── LoRa Order Sub-commands (ORDER 0x35) ────────────────────────────────────
#define LORA_ORDER_START    0x01
#define LORA_ORDER_START_ACK 0x02
#define LORA_ORDER_PAUSE    0x03
#define LORA_ORDER_PAUSE_ACK 0x04
#define LORA_ORDER_RESUME   0x05
#define LORA_ORDER_RESUME_ACK 0x06
#define LORA_ORDER_STOP     0x07
#define LORA_ORDER_STOP_ACK 0x08
#define LORA_ORDER_STOP_TIME 0x09
#define LORA_ORDER_STOP_TIME_ACK 0x0A
#define LORA_ORDER_GO_PILE  0x0B
#define LORA_ORDER_GO_PILE_ACK 0x0C

// ── LoRa Charger Sub-commands (CHARGER 0x30) ───────────────────────────────
// From Ghidra: queue 0x05 → [0x30, 0x01, 0x01], queue 0x06 → [0x30, 0x04]
#define LORA_CHARGER_HALL_SUB   0x01   // Hall ACK: [0x30, 0x01, 0x01]
#define LORA_CHARGER_IRQ_SUB    0x04   // IRQ ACK: [0x30, 0x04]

// ── LoRa CONFIG Sub-commands (CONFIG 0x32) ──────────────────────────────────
#define LORA_CONFIG_WIFI        0x01   // WiFi credentials relay to mower
#define LORA_CONFIG_MQTT        0x02   // MQTT broker relay to mower
#define LORA_CONFIG_LORA        0x03   // LoRa params relay to mower
#define LORA_CONFIG_APPLY       0x04   // Config apply/commit signal

// ── LoRa Queue IDs (internal FreeRTOS queue commands) ───────────────────────
#define LORA_Q_RTK_RELAY     0x01  // RTK GPS relay
#define LORA_Q_CONFIG        0x02  // Config command
#define LORA_Q_GPS_POS       0x03  // GPS position relay
#define LORA_Q_GPS_ACK       0x04  // GPS ACK
#define LORA_Q_HALL_ACK      0x05  // Hall sensor ACK
#define LORA_Q_IRQ_ACK       0x06  // IRQ ACK
#define LORA_Q_START_RUN     0x20
#define LORA_Q_PAUSE_RUN     0x21
#define LORA_Q_RESUME_RUN    0x22
#define LORA_Q_STOP_RUN      0x23
#define LORA_Q_STOP_TIME_RUN 0x24
#define LORA_Q_GO_PILE       0x25
#define LORA_Q_SCAN_CHANNEL  0x26  // Channel scan command
#define LORA_Q_CONFIG_VERIFY 0x27  // Config write verify

// ── LoRa Config State Machine ───────────────────────────────────────────────
#define LORA_STATE_IDLE      0
#define LORA_STATE_SCANNING  1
#define LORA_STATE_DONE      2

// ── Charger Config Task Queue Commands ──────────────────────────────────────
// From Ghidra charger_config_task (FUN_4200a458)
#define CHARGER_Q_SET_ON_OFF    0x02   // Hall sensor on/off request
#define CHARGER_Q_HALL_STATE_ON  0x01  // Hall sensor ON value
#define CHARGER_Q_HALL_STATE_OFF 0x00  // Hall sensor OFF value

// ── WiFi ────────────────────────────────────────────────────────────────────
#define WIFI_CMD_CFG_AP      0x00  // Configure AP + STA
#define WIFI_CMD_CONNECT     0x01  // Connect to STA network
#define WIFI_CMD_SCAN        0x02  // WiFi scan
#define WIFI_CMD_DISCONNECT  0x03  // Disconnect
#define WIFI_CMD_TIMEOUT     0x04  // Timeout handler
#define WIFI_CONNECT_TIMEOUT_S 55  // WiFi connect timeout (55 iterations)
#define WIFI_AP_PASSWORD     "12345678"

// ── Timing ──────────────────────────────────────────────────────────────────
#define STATUS_PUBLISH_MS   2000   // up_status_info publish interval
#define LORA_HEARTBEAT_MS   1500   // LoRa heartbeat poll interval
#define LORA_QUEUE_TIMEOUT  0x96   // 150 ticks queue receive timeout (Ghidra: 0x96)
#define LORA_ACK_TIMEOUT_MS 3000   // Max wait for LoRa ACK (3 iterations × 1s)
#define LORA_ACK_RETRIES    3      // Retry count on ACK timeout
#define LORA_SCAN_TIMEOUT_S 60     // Channel scan timeout (60 seconds)
#define RTK_CONFIG_TIMEOUT_S 30    // RTK config timeout (30 seconds)
#define SIGNAL_MEASURE_TIMEOUT_S 60 // Signal measurement timeout (60 seconds)
#define LORA_HEARTBEAT_TICKS 10    // Heartbeat every 10 × 150ms ≈ 1.5s

// ── RSSI ────────────────────────────────────────────────────────────────────
#define LORA_RSSI_THRESHOLD 0x92   // -110 dBm + threshold
#define LORA_RSSI_MAX_VALID 145
#define LORA_MAX_SCAN_CHANNELS 0x22 // 34 channels max

// ── FreeRTOS Task Config ────────────────────────────────────────────────────
#define MQTT_TASK_STACK     4096
#define MQTT_TASK_PRIORITY  4
#define MQTT_TASK_CORE      0

#define LORA_TASK_STACK     8192
#define LORA_TASK_PRIORITY  10
#define LORA_TASK_CORE      1

#define GPS_TASK_STACK      4096
#define GPS_TASK_PRIORITY   10  // Same as LoRa (from Ghidra: rtk_config_task priority=10)
#define GPS_TASK_CORE       0

#define OTA_TASK_STACK      12288  // 12KB (from Ghidra: 0xc * 1024)
#define OTA_TASK_PRIORITY   0      // Low priority (from Ghidra)
#define OTA_TASK_CORE       0

#define HTTPS_TASK_STACK    6144   // 6KB (from Ghidra: 0x600)
#define HTTPS_TASK_PRIORITY 5
#define HTTPS_TASK_CORE     0

#define WIFI_TASK_STACK     4096
#define WIFI_TASK_PRIORITY  5
#define WIFI_TASK_CORE      0

// ── NVS Namespaces & Keys ───────────────────────────────────────────────────
#define NVS_NS_FACTORY      "fctry"
#define NVS_NS_STORAGE      "storage"
#define NVS_KEY_SN          "sn_code"
#define NVS_KEY_SN_FLAG     "sn_flag"
#define NVS_KEY_WIFI        "wifi_data"
#define NVS_KEY_WIFI_AP     "wifi_ap_data"
#define NVS_KEY_MQTT        "mqtt_data"
#define NVS_KEY_LORA        "lora_data"
#define NVS_KEY_LORA_HCLC   "lora_hc_lc"
#define NVS_KEY_RTK         "rtk_data"
#define NVS_KEY_CFG_FLAG    "cfg_flag"

// ── NVS Blob Sizes ──────────────────────────────────────────────────────────
#define NVS_WIFI_SIZE       96   // SSID(32) + password(64)
#define NVS_WIFI_AP_SIZE    96   // AP SSID(32) + AP password(64)
#define NVS_MQTT_SIZE       32   // host(30) + port(2 at offset 0x1E)
#define NVS_LORA_SIZE       4    // addr_hi, addr_lo, channel, 0x00
#define NVS_LORA_HCLC_SIZE  2    // hc, lc
#define NVS_RTK_SIZE        40   // lat(8)+NS(1)+lon(8)+EW(1)+alt(8)+...

// ── LORA_MAX_PAYLOAD (shared) ───────────────────────────────────────────────
#ifndef LORA_MAX_PAYLOAD
#define LORA_MAX_PAYLOAD    128
#endif
