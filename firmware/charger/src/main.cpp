#include <Arduino.h>
#include <WiFi.h>
#include "config.h"
#include "nvs_storage.h"
#include "aes_crypto.h"
#include "mqtt_handler.h"
#include "lora_driver.h"
#include "lora_protocol.h"
#include "lora_commands.h"
#include "gps_parser.h"
#include "ble_provisioning.h"
#include "ota_handler.h"
#include "wifi_manager.h"
#include "uart_console.h"

// ── Global State ────────────────────────────────────────────────────────────

static char serialNumber[32] = {0};

// LoRa addressing from NVS (shared with LoRa task)
static LoraConfig  loraGlobalCfg  = {};
static LoraHcLc    loraGlobalHcLc = {};

// Charger config task queue
static QueueHandle_t chargerQueue = NULL;

// ── Channel Scan State Machine ──────────────────────────────────────────────
// Matches Ghidra adaptive RSSI scan (lines 31533-31600)
static volatile int scanDirection = -1; // 1=UP, 0=DOWN, -1=idle/done
static uint8_t  scanRssiArr[LORA_MAX_SCAN_CHANNELS];
static uint8_t  scanChanArr[LORA_MAX_SCAN_CHANNELS];
static uint8_t  scanCount = 0;
static uint8_t  scanCurrentChannel = 0;
static uint8_t  scanHc = 0;   // Upper bound
static uint8_t  scanLc = 0;   // Lower bound

// ── Helper: send LoRa payload (build frame + transmit) ──────────────────────

static void loraSendPayload(const uint8_t* payload, size_t payloadLen) {
    uint8_t packet[LORA_MAX_PAYLOAD + 8];
    size_t pktLen = loraBuildPacket(packet, sizeof(packet),
                                    loraGlobalCfg.addrHi, loraGlobalCfg.addrLo,
                                    payload, payloadLen);
    if (pktLen > 0) {
        loraSendRaw(packet, pktLen);
    }
}

// ── Helper: send with delay + flush — matches Ghidra ORDER pattern ──────────
// Ghidra: vTaskDelay(10) → send → FUN_4200abd8 (flush) → FUN_4200b1fc(100)

static void loraSendPayloadWithFlush(const uint8_t* payload, size_t payloadLen) {
    vTaskDelay(pdMS_TO_TICKS(10));
    loraSendPayload(payload, payloadLen);
    while (LORA_SERIAL.available()) LORA_SERIAL.read();
    vTaskDelay(pdMS_TO_TICKS(100));
}

// ── Bubble sort for channel scan — matches Ghidra FUN_4200a6e4 ─────────────
// Sorts RSSI array ascending (lowest = least interference = best channel).
// Returns best channel (chanArr[0] after sort).

static uint8_t bubbleSortBestChannel(uint8_t* rssiArr, uint8_t* chanArr, uint8_t count) {
    if (count == 0) return 0;

    for (uint8_t i = 0; i < count; i++) {
        Serial.printf("arr_rssi[%d] = %d, arr_channel[%d] = %d\n",
                       i, rssiArr[i], i, chanArr[i]);
    }

    // Bubble sort ascending by RSSI
    for (uint8_t i = 0; i < count; i++) {
        for (uint8_t j = 0; (int)j < (int)(count - i - 1); j++) {
            if (rssiArr[j + 1] < rssiArr[j]) {
                uint8_t tmp = rssiArr[j];
                rssiArr[j] = rssiArr[j + 1];
                rssiArr[j + 1] = tmp;
                tmp = chanArr[j];
                chanArr[j] = chanArr[j + 1];
                chanArr[j + 1] = tmp;
            }
        }
    }

    for (uint8_t i = 0; i < count; i++) {
        Serial.printf("arr_rssi[%d] = %d, arr_channel[%d] = %d\n",
                       i, rssiArr[i], i, chanArr[i]);
    }

    return chanArr[0];
}

// ── Channel scan step — one iteration ───────────────────────────────────────
// Returns true when scan is complete.

static bool channelScanStep() {
    loraSetChannel(scanCurrentChannel);
    vTaskDelay(pdMS_TO_TICKS(100));

    int rssi = loraQueryRssi();
    Serial.printf("lora_cmd_get_rssi_data cmd_chann: %d\n", scanCurrentChannel);

    if (rssi < 0) rssi = 0xFF;

    // Below threshold → use immediately
    if (rssi < LORA_RSSI_THRESHOLD) {
        loraGlobalCfg.channel = scanCurrentChannel;
        Serial.println("lora_cmd_get_rssi_data_ok2");
        return true;
    }

    // Store measurement
    if (scanCount < LORA_MAX_SCAN_CHANNELS) {
        scanRssiArr[scanCount] = (uint8_t)rssi;
        scanChanArr[scanCount] = scanCurrentChannel;
        scanCount++;
    }

    // Max samples reached → sort
    if (scanCount >= LORA_MAX_SCAN_CHANNELS) {
        Serial.println("lora_rssi_i > LORA_RSSI_THRESHOLD");
        loraGlobalCfg.channel = bubbleSortBestChannel(scanRssiArr, scanChanArr, scanCount);
        return true;
    }

    Serial.printf("lora_rssi_i: %d\n", rssi);

    // Scan direction state machine (Ghidra lines 31542-31595)
    if (scanDirection == 1) {
        // Scanning UP
        if (scanCurrentChannel < scanHc) {
            Serial.println("cmd_channel < cmd_hc");
            scanCurrentChannel++;
        } else if (scanCurrentChannel == scanHc) {
            Serial.println("cmd_channel == cmd_hc");
            scanDirection = 0;
            scanCurrentChannel = loraGlobalCfg.channel;
        }
    }

    if (scanDirection == 0) {
        // Scanning DOWN
        if (scanLc < scanCurrentChannel) {
            Serial.println("cmd_lc < cmd_channel");
            scanCurrentChannel--;
        } else if (scanLc == scanCurrentChannel) {
            Serial.println("cmd_lc == cmd_channel");
            scanDirection = -1;
            loraGlobalCfg.channel = bubbleSortBestChannel(scanRssiArr, scanChanArr, scanCount);
            return true;
        }
    }

    return false;
}

// ── Process inbound LoRa packet ─────────────────────────────────────────────

static void processInboundLora() {
    uint8_t rxBuf[LORA_MAX_PAYLOAD + 8];
    size_t rxLen = loraReadRaw(rxBuf, sizeof(rxBuf), 50);
    if (rxLen == 0) return;

    uint8_t payload[LORA_MAX_PAYLOAD];
    size_t payloadLen = loraParsePacket(rxBuf, rxLen, payload, sizeof(payload));
    if (payloadLen < 2) return;

    uint8_t category = payload[0];
    uint8_t subCmd = payload[1];

    switch (category) {
        case LORA_CAT_CHARGER: // 0x30 — Hall/IRQ from mower
            if (subCmd == LORA_CHARGER_HALL_SUB) {
                Serial.println("[LoRa] Hall event from mower");
                LoraQueueCmd cmd = {};
                cmd.queueId = LORA_Q_HALL_ACK;
                xQueueSend(mqttGetLoraQueue(), &cmd, 0);
            }
            break;

        case LORA_CAT_CONFIG: // 0x32 — Config ACK from mower
            Serial.printf("[LoRa] CONFIG ACK sub=%d\n", subCmd);
            break;

        case LORA_CAT_GPS: // 0x33 — GPS ACK from mower
            break;

        case LORA_CAT_REPORT: // 0x34 — Mower status report
            if (subCmd == 0x02 && payloadLen >= 21) {
                MowerStatus newStatus;
                if (loraParseStatusReport(payload, payloadLen, newStatus)) {
                    mowerStatus = newStatus;
                }
            }
            break;

        case LORA_CAT_ORDER: // 0x35 — ORDER ACK from mower
            // Even sub-commands are ACKs (0x02, 0x04, 0x06, 0x08, 0x0A, 0x0C)
            if (subCmd % 2 == 0) {
                Serial.printf("[LoRa] ORDER ACK sub=0x%02x\n", subCmd);
                loraAckResult = 1;       // Success
            } else {
                Serial.printf("[LoRa] ORDER NAK sub=0x%02x\n", subCmd);
                loraAckResult = 0x101;   // Error
            }
            break;

        case LORA_CAT_SCAN: // 0x36 — Scan response
            if (payloadLen >= 3) {
                loraRssiValue = payload[2];
            }
            break;

        default:
            Serial.printf("[LoRa] Unknown cat=0x%02x sub=0x%02x len=%d\n",
                           category, subCmd, (int)payloadLen);
            break;
    }
}

// ── lora_config_task — matches Ghidra FUN_4200b8d4 ──────────────────────────
// Main LoRa task: processes outbound commands from queue, handles heartbeat
// polling, channel scanning, and inbound packet processing.

static void loraConfigTask(void* param) {
    QueueHandle_t loraQueue = mqttGetLoraQueue();
    uint32_t heartbeatCounter = 0;
    bool scanning = false;

    // Read LoRa config from NVS
    nvsReadLora(loraGlobalCfg);
    nvsReadLoraHcLc(loraGlobalHcLc);

    // Configure LoRa module channel
    loraSetChannel(loraGlobalCfg.channel);

    Serial.printf("[LoRa] Task started: addr=%02x%02x ch=%d\n",
                   loraGlobalCfg.addrHi, loraGlobalCfg.addrLo, loraGlobalCfg.channel);

    for (;;) {
        // ── Receive from queue (150 ticks timeout, Ghidra: 0x96) ────
        LoraQueueCmd cmd = {};
        bool gotCmd = (xQueueReceive(loraQueue, &cmd, LORA_QUEUE_TIMEOUT) == pdTRUE);

        if (gotCmd) {
            uint8_t payload[LORA_MAX_PAYLOAD];
            size_t payloadLen = 0;

            switch (cmd.queueId) {

                // ── Queue 0x01: RTK relay (reserved, unknown in Ghidra) ──
                case LORA_Q_RTK_RELAY:
                    break;

                // ── Queue 0x02: CONFIG → [0x32, 0x04] ──────────────────
                case LORA_Q_CONFIG:
                    Serial.println("lora_config_task LORA_QUEUE_CMD");
                    payload[0] = LORA_CAT_CONFIG;
                    payload[1] = LORA_CONFIG_APPLY;
                    loraSendPayload(payload, 2);
                    break;

                // ── Queue 0x03: GPS GNGGA relay → [0x31, GNGGA...] ─────
                case LORA_Q_GPS_POS: {
                    GpsData gps = gpsGetData();
                    if (gps.lastGnggaLen > 0) {
                        payloadLen = loraBuildRtkRelay(payload, sizeof(payload),
                                                       gps.lastGngga, gps.lastGnggaLen);
                        if (payloadLen > 0) loraSendPayload(payload, payloadLen);
                    }
                    break;
                }

                // ── Queue 0x04: GPS position → [0x33, lat, lon] ────────
                case LORA_Q_GPS_ACK: {
                    GpsData gps = gpsGetData();
                    if (gps.valid) {
                        payloadLen = loraBuildGpsPosition(payload, sizeof(payload),
                                                          gps.latitude, gps.longitude);
                        if (payloadLen > 0) loraSendPayload(payload, payloadLen);
                    }
                    break;
                }

                // ── Queue 0x05: Hall ACK → [0x30, 0x01, 0x01] ─────────
                case LORA_Q_HALL_ACK:
                    Serial.println("lora_config_task LORA_QUEUE_CMD");
                    payloadLen = loraBuildHallAck(payload, sizeof(payload));
                    if (payloadLen > 0) loraSendPayload(payload, payloadLen);
                    break;

                // ── Queue 0x06: IRQ ACK → [0x30, 0x04] ────────────────
                case LORA_Q_IRQ_ACK:
                    Serial.println("lora_config_task LORA_QUEUE_CMD");
                    payloadLen = loraBuildIrqAck(payload, sizeof(payload));
                    if (payloadLen > 0) loraSendPayload(payload, payloadLen);
                    break;

                // ── Queue 0x20-0x25: ORDER commands → [0x35, sub, ...] ─
                case LORA_Q_START_RUN:
                case LORA_Q_PAUSE_RUN:
                case LORA_Q_RESUME_RUN:
                case LORA_Q_STOP_RUN:
                case LORA_Q_STOP_TIME_RUN:
                case LORA_Q_GO_PILE:
                    Serial.println("lora_config_task LORA_QUEUE_CMD");
                    payloadLen = loraBuildOrderCommand(payload, sizeof(payload), cmd);
                    if (payloadLen > 0) {
                        loraSendPayloadWithFlush(payload, payloadLen);
                    }
                    break;

                // ── Queue 0x26: Start channel scan ─────────────────────
                case LORA_Q_SCAN_CHANNEL:
                    Serial.println("[LoRa] Starting channel scan");
                    scanning = true;
                    scanDirection = 1;  // Start scanning UP
                    scanCount = 0;
                    scanCurrentChannel = loraGlobalCfg.channel;
                    scanHc = loraGlobalHcLc.hc;
                    scanLc = loraGlobalHcLc.lc;
                    break;

                default:
                    Serial.printf("[LoRa] Unknown queue cmd: 0x%02x\n", cmd.queueId);
                    break;
            }
        }

        // ── Channel scan processing ────────────────────────────────────
        if (scanning) {
            if (channelScanStep()) {
                scanning = false;
                scanDirection = -1;
                nvsWriteLora(loraGlobalCfg);
                loraSetChannel(loraGlobalCfg.channel);
                Serial.printf("[LoRa] Scan complete, assigned channel=%d\n",
                               loraGlobalCfg.channel);
            }
        }

        // ── Heartbeat poll every ~1.5s (10 × 150ms) ────────────────────
        heartbeatCounter++;
        if (heartbeatCounter >= LORA_HEARTBEAT_TICKS && !scanning) {
            heartbeatCounter = 0;

            uint8_t hbPayload[2];
            loraBuildHeartbeatPoll(hbPayload, sizeof(hbPayload));
            loraSendPayload(hbPayload, 2);

            // Read heartbeat response
            uint8_t rxBuf[64];
            size_t rxLen = loraReadRaw(rxBuf, sizeof(rxBuf), 200);
            if (rxLen > 0) {
                uint8_t respPayload[LORA_MAX_PAYLOAD];
                size_t respLen = loraParsePacket(rxBuf, rxLen, respPayload, sizeof(respPayload));
                if (respLen >= 21) {
                    MowerStatus newStatus;
                    if (loraParseStatusReport(respPayload, respLen, newStatus)) {
                        mowerStatus = newStatus;
                    }
                }
            } else {
                // No response — increment miss counter
                mowerStatus.mowerError++;
            }
        }

        // ── Check for unsolicited inbound data ─────────────────────────
        if (!scanning) {
            processInboundLora();
        }
    }
}

// ── charger_config_task — matches Ghidra charger_config_task ────────────────
// Monitors hall sensor, handles ON/OFF requests from LoRa.

static void chargerConfigTask(void* param) {
    for (;;) {
        uint8_t cmd[2] = {0};

        if (xQueueReceive(chargerQueue, cmd, pdMS_TO_TICKS(1000)) == pdTRUE) {
            if (cmd[0] == CHARGER_Q_SET_ON_OFF) {
                if (cmd[1] == CHARGER_Q_HALL_STATE_ON) {
                    Serial.println("CHARGER_QUEUE_CMD_SET_ON_OFF_REQ ON");
                } else if (cmd[1] == CHARGER_Q_HALL_STATE_OFF) {
                    Serial.println("CHARGER_QUEUE_CMD_SET_ON_OFF_REQ OFF");
                }
                vTaskDelay(pdMS_TO_TICKS(100));

                // Send IRQ ACK via LoRa queue
                LoraQueueCmd loraCmd = {};
                loraCmd.queueId = LORA_Q_IRQ_ACK;
                QueueHandle_t loraQ = mqttGetLoraQueue();
                if (loraQ) xQueueSend(loraQ, &loraCmd, pdMS_TO_TICKS(1000));
            }
        }

        // Periodic hall sensor polling (Ghidra: FUN_4200a2bc)
        // Hall sensor GPIO not confirmed from Ghidra — placeholder
        // In real hardware: digitalRead(HALL_PIN) → 0=detected, 1=not
    }
}

// ── GPS Task — queue GNGGA + position relays to LoRa task ───────────────────

static void gpsTaskFunc(void* param) {
    QueueHandle_t loraQueue = mqttGetLoraQueue();
    uint32_t lastGpsPosRelay = 0;

    for (;;) {
        if (gpsUpdate()) {
            GpsData data = gpsGetData();

            // Queue GNGGA relay (queue cmd 0x03) for RTK correction
            if (data.lastGnggaLen > 0 && loraQueue) {
                LoraQueueCmd cmd = {};
                cmd.queueId = LORA_Q_GPS_POS;  // 0x03 → [0x31, GNGGA...]
                xQueueSend(loraQueue, &cmd, 0);
            }

            // Queue GPS position relay (queue cmd 0x04) every 2 seconds
            uint32_t now = millis();
            if (now - lastGpsPosRelay >= 2000 && data.valid && loraQueue) {
                lastGpsPosRelay = now;
                LoraQueueCmd cmd = {};
                cmd.queueId = LORA_Q_GPS_ACK;  // 0x04 → [0x33, lat, lon]
                xQueueSend(loraQueue, &cmd, 0);
            }
        }

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

// ── Send CONFIG to mower via LoRa — matches Ghidra FUN_42060d58 ────────────
// Called before restart when set_cfg_info=1.
// Sends WiFi/MQTT/LoRa config packets, then apply signal.

static void sendConfigToMower() {
    uint8_t buf[LORA_MAX_PAYLOAD];
    size_t len;

    Serial.println("[LoRa] Sending CONFIG to mower...");

    len = loraBuildConfigWifi(buf, sizeof(buf));
    if (len > 0) {
        loraSendPayload(buf, len);
        vTaskDelay(pdMS_TO_TICKS(200));
    }

    len = loraBuildConfigMqtt(buf, sizeof(buf));
    if (len > 0) {
        loraSendPayload(buf, len);
        vTaskDelay(pdMS_TO_TICKS(200));
    }

    len = loraBuildConfigLora(buf, sizeof(buf));
    if (len > 0) {
        loraSendPayload(buf, len);
        vTaskDelay(pdMS_TO_TICKS(200));
    }

    // Apply signal: [0x32, 0x04]
    buf[0] = LORA_CAT_CONFIG;
    buf[1] = LORA_CONFIG_APPLY;
    loraSendPayload(buf, 2);
    vTaskDelay(pdMS_TO_TICKS(100));

    Serial.println("[LoRa] CONFIG sent");
}

// ── Setup ───────────────────────────────────────────────────────────────────

void setup() {
    Serial.begin(DEBUG_BAUD);
    delay(1000);
    Serial.println("\n=== OpenNova Charger Firmware ===");
    Serial.println(FIRMWARE_VERSION);

    // Initialize NVS
    if (!nvsInit()) {
        Serial.println("[FATAL] NVS init failed");
        return;
    }

    // Read serial number from factory partition
    if (!nvsReadSN(serialNumber, sizeof(serialNumber))) {
        Serial.println("[FATAL] No serial number in NVS");
        strncpy(serialNumber, "LFIC_UNKNOWN", sizeof(serialNumber));
    }
    Serial.printf("[SYS] SN: %s\n", serialNumber);

    // Initialize hardware peripherals
    loraInit();
    gpsInit();

    // Create charger config task queue (2 bytes per item: cmd + param)
    chargerQueue = xQueueCreate(5, 2);

    // Initialize WiFi in STA+AP mode (mode 3) — matches Ghidra
    wifiInit(serialNumber);

    // Initialize MQTT client
    MqttConfig mqttCfg;
    if (nvsReadMqtt(mqttCfg)) {
        mqttInit(serialNumber, mqttCfg.host, mqttCfg.port);
    } else {
        Serial.println("[MQTT] No config in NVS, using defaults");
        mqttInit(serialNumber, "mqtt.lfibot.com", MQTT_DEFAULT_PORT);
    }

    // ── Create FreeRTOS tasks — matching Ghidra task layout ────────
    xTaskCreatePinnedToCore(wifiTask, "wifi_task",
        WIFI_TASK_STACK, NULL, WIFI_TASK_PRIORITY, NULL, WIFI_TASK_CORE);

    xTaskCreatePinnedToCore(mqttConfigTask, "mqtt_config_task",
        MQTT_TASK_STACK, NULL, MQTT_TASK_PRIORITY, NULL, MQTT_TASK_CORE);

    xTaskCreatePinnedToCore(loraConfigTask, "lora_config_task",
        LORA_TASK_STACK, NULL, LORA_TASK_PRIORITY, NULL, LORA_TASK_CORE);

    xTaskCreatePinnedToCore(gpsTaskFunc, "rtk_config_task",
        GPS_TASK_STACK, NULL, GPS_TASK_PRIORITY, NULL, GPS_TASK_CORE);

    xTaskCreatePinnedToCore(chargerConfigTask, "charger_config_task",
        4096, NULL, 5, NULL, 0);

    xTaskCreatePinnedToCore(otaTask, "ota_task",
        OTA_TASK_STACK, NULL, OTA_TASK_PRIORITY, NULL, OTA_TASK_CORE);

    // Initialize UART debug console
    consoleInit();

    // Start BLE provisioning if no WiFi credentials configured
    WifiConfig wifiCfg;
    if (!nvsReadWifi(wifiCfg) || strlen(wifiCfg.ssid) == 0) {
        Serial.println("[SYS] No WiFi config — starting BLE provisioning");
        bleInit(serialNumber);
    }

    Serial.println("[SYS] All tasks started");
}

// ── Loop — BLE monitoring + UART console ────────────────────────────────────

void loop() {
    // Process UART debug console commands
    consoleProcess();

    // Check if BLE provisioning completed (set_cfg_info=1)
    if (bleIsActive() && bleWasConfigCommitted()) {
        Serial.println("[SYS] BLE config committed");
        bleStop();

        // Relay WiFi/MQTT/LoRa config to mower via LoRa
        // Matches Ghidra: FUN_42060d58() → delay(1000) → esp_restart()
        sendConfigToMower();

        delay(1000);
        Serial.println("[SYS] Restarting...");
        ESP.restart();
    }

    // WiFi connected → stop BLE (BLE only active when WiFi not connected)
    if (bleIsActive() && wifiIsConnected()) {
        Serial.println("[SYS] WiFi connected — stopping BLE");
        bleStop();
    }

    // WiFi lost for 60s → restart BLE provisioning
    if (!bleIsActive() && !wifiIsConnected()) {
        static uint32_t wifiLostTime = 0;
        if (wifiLostTime == 0) {
            wifiLostTime = millis();
        } else if (millis() - wifiLostTime > 60000) {
            Serial.println("[SYS] WiFi lost 60s — starting BLE provisioning");
            wifiLostTime = 0;
            bleInit(serialNumber);
        }
    }

    delay(100);
}
