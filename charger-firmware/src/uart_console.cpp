#include "uart_console.h"
#include "config.h"
#include "nvs_storage.h"
#include "lora_commands.h"
#include "mqtt_handler.h"
#include <nvs_flash.h>
#include <nvs.h>
#include <esp_ota_ops.h>

// ── Static State ────────────────────────────────────────────────────────────

static char cmdBuf[256] = {0};
static size_t cmdIdx = 0;
static QueueHandle_t loraQueue = NULL;

// ── Init ────────────────────────────────────────────────────────────────────

void consoleInit() {
    loraQueue = mqttGetLoraQueue();
}

// ── Process UART console input ──────────────────────────────────────────────
// Matches Ghidra app_main console handler (lines 28156-28230)
// Single-character commands are dispatched immediately.
// Multi-character commands (SN_GET, SN_SET, LORARSSI) require newline.

void consoleProcess() {
    while (Serial.available()) {
        char c = Serial.read();

        // Accumulate into buffer for multi-char commands
        if (c == '\n' || c == '\r') {
            if (cmdIdx == 0) continue;
            cmdBuf[cmdIdx] = '\0';

            // ── Multi-character commands ────────────────────────────────

            // SN_GET — read serial number
            if (strcmp(cmdBuf, "SN_GET") == 0) {
                char sn[32] = {0};
                if (nvsReadSN(sn, sizeof(sn))) {
                    Serial.printf("SN: %s\n", sn);
                } else {
                    Serial.println("SN: (not set)");
                }
            }
            // SN_SET:<value> — write serial number to factory NVS
            else if (strncmp(cmdBuf, "SN_SET:", 7) == 0) {
                const char* newSN = cmdBuf + 7;
                if (strlen(newSN) > 0) {
                    nvs_handle_t handle;
                    esp_err_t err = nvs_open_from_partition("fctry", NVS_NS_FACTORY, NVS_READWRITE, &handle);
                    if (err == ESP_OK) {
                        nvs_set_str(handle, NVS_KEY_SN, newSN);
                        nvs_commit(handle);
                        nvs_close(handle);
                        Serial.printf("SN set: %s\n", newSN);
                    } else {
                        Serial.printf("SN write failed: %s\n", esp_err_to_name(err));
                    }
                }
            }
            // LORARSSI — print current LoRa RSSI
            else if (strcmp(cmdBuf, "LORARSSI") == 0) {
                Serial.printf("LoRa RSSI: %d\n", loraRssiValue);
            }

            cmdIdx = 0;
            continue;
        }

        // Buffer character
        if (cmdIdx < sizeof(cmdBuf) - 1) {
            cmdBuf[cmdIdx++] = c;
        }

        // ── Single-character commands ── matches Ghidra exactly ────────
        // Each command echoes back "c: <char>" and queues to LoRa task

        if (cmdIdx == 1) {
            LoraQueueCmd cmd = {};

            switch (c) {
                case 'v':
                    // VERSION — print firmware version
                    Serial.printf("charger_pile_version: %s\n", FIRMWARE_VERSION);
                    Serial.printf("c: %c\n", 0x76);
                    cmdIdx = 0;
                    break;

                case 'a':
                    // ANTENNA — queue cmd 0x00
                    cmd.queueId = 0x00;
                    if (loraQueue) xQueueSend(loraQueue, &cmd, pdMS_TO_TICKS(1000));
                    Serial.printf("c: %c\n", 0x61);
                    cmdIdx = 0;
                    break;

                case 'm':
                    // MODE — queue cmd 0x01
                    cmd.queueId = 0x01;
                    if (loraQueue) xQueueSend(loraQueue, &cmd, pdMS_TO_TICKS(1000));
                    Serial.printf("c: %c\n", 0x6d);
                    cmdIdx = 0;
                    break;

                case 'f':
                    // FIRMWARE — queue cmd 0x02
                    cmd.queueId = 0x02;
                    if (loraQueue) xQueueSend(loraQueue, &cmd, pdMS_TO_TICKS(1000));
                    Serial.printf("c: %c\n", 0x66);
                    cmdIdx = 0;
                    break;

                case 'o':
                    // (Unknown) — queue cmd 0x03
                    cmd.queueId = 0x03;
                    if (loraQueue) xQueueSend(loraQueue, &cmd, pdMS_TO_TICKS(1000));
                    Serial.printf("c: %c\n", 0x6f);
                    cmdIdx = 0;
                    break;

                case 'w':
                    // (Unknown) — queue cmd 0x04
                    cmd.queueId = 0x04;
                    if (loraQueue) xQueueSend(loraQueue, &cmd, pdMS_TO_TICKS(1000));
                    Serial.printf("c: %c\n", 0x77);
                    cmdIdx = 0;
                    break;

                case 'd':
                    // DEBUG — queue cmd 0x05
                    cmd.queueId = 0x05;
                    if (loraQueue) xQueueSend(loraQueue, &cmd, pdMS_TO_TICKS(1000));
                    Serial.printf("c: %c\n", 0x64);
                    cmdIdx = 0;
                    break;

                case '@':
                    // FACTORY RESET — erase fctry NVS
                    {
                        nvs_handle_t handle;
                        if (nvs_open_from_partition("fctry", NVS_NS_FACTORY, NVS_READWRITE, &handle) == ESP_OK) {
                            nvs_erase_all(handle);
                            nvs_commit(handle);
                            nvs_close(handle);
                            Serial.println("[Console] Factory NVS erased");
                        }
                    }
                    cmdIdx = 0;
                    break;

                case 'r':
                    // REBOOT
                    Serial.println("[Console] Rebooting...");
                    vTaskDelay(pdMS_TO_TICKS(1000));
                    ESP.restart();
                    break;

                case 'b':
                    // OTA BOOT — set boot partition and restart
                    {
                        const esp_partition_t* nextPart = esp_ota_get_next_update_partition(NULL);
                        if (nextPart) {
                            esp_ota_set_boot_partition(nextPart);
                            Serial.printf("[Console] Boot partition set to: %s\n", nextPart->label);
                        }
                        vTaskDelay(pdMS_TO_TICKS(1000));
                        ESP.restart();
                    }
                    break;

                default:
                    // Not a single-char command — continue accumulating
                    break;
            }
        }
    }
}
