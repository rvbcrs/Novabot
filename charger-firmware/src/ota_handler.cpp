#include "ota_handler.h"
#include "config.h"
#include "mqtt_handler.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <Update.h>
#include <MD5Builder.h>

static void publishOtaProgress(const char* status, int percentage) {
    char json[128];
    snprintf(json, sizeof(json),
             "{\"ota_upgrade_state\":{\"status\":\"%s\",\"percentage\":%d}}",
             status, percentage);
    mqttPublishRaw(json);
}

void otaTask(void* param) {
    QueueHandle_t otaQueue = mqttGetOtaQueue();

    for (;;) {
        OtaRequest req;
        if (xQueueReceive(otaQueue, &req, portMAX_DELAY) != pdTRUE) continue;

        Serial.printf("[OTA] Starting download: %s\n", req.url);
        publishOtaProgress("downloading", 0);

        HTTPClient http;
        http.begin(req.url);
        http.setTimeout(30000);

        int httpCode = http.GET();
        if (httpCode != HTTP_CODE_OK) {
            Serial.printf("[OTA] HTTP error: %d\n", httpCode);
            publishOtaProgress("error", 0);
            http.end();
            continue;
        }

        int contentLength = http.getSize();
        if (contentLength <= 0) {
            Serial.println("[OTA] Invalid content length");
            publishOtaProgress("error", 0);
            http.end();
            continue;
        }

        if (!Update.begin(contentLength)) {
            Serial.printf("[OTA] Not enough space: %d bytes\n", contentLength);
            publishOtaProgress("error", 0);
            http.end();
            continue;
        }

        WiFiClient* stream = http.getStreamPtr();
        MD5Builder md5;
        md5.begin();

        uint8_t buf[1024];
        int totalRead = 0;
        int lastPercent = 0;

        while (http.connected() && totalRead < contentLength) {
            int available = stream->available();
            if (available <= 0) {
                delay(10);
                continue;
            }

            int toRead = available;
            if (toRead > (int)sizeof(buf)) toRead = sizeof(buf);
            if (toRead > contentLength - totalRead) toRead = contentLength - totalRead;

            int bytesRead = stream->readBytes(buf, toRead);
            if (bytesRead <= 0) break;

            Update.write(buf, bytesRead);
            md5.add(buf, bytesRead);
            totalRead += bytesRead;

            int percent = (totalRead * 100) / contentLength;
            if (percent != lastPercent && percent % 10 == 0) {
                lastPercent = percent;
                publishOtaProgress("downloading", percent);
                Serial.printf("[OTA] %d%%\n", percent);
            }
        }

        http.end();

        if (totalRead != contentLength) {
            Serial.printf("[OTA] Incomplete download: %d / %d\n", totalRead, contentLength);
            Update.abort();
            publishOtaProgress("error", 0);
            continue;
        }

        // Verify MD5 if provided
        if (strlen(req.md5) > 0) {
            md5.calculate();
            String calculated = md5.toString();
            if (!calculated.equalsIgnoreCase(req.md5)) {
                Serial.printf("[OTA] MD5 mismatch: %s != %s\n", calculated.c_str(), req.md5);
                Update.abort();
                publishOtaProgress("error", 0);
                continue;
            }
            Serial.println("[OTA] MD5 verified OK");
        }

        if (!Update.end(true)) {
            Serial.printf("[OTA] Flash error: %s\n", Update.errorString());
            publishOtaProgress("error", 0);
            continue;
        }

        Serial.println("[OTA] Success — rebooting");
        publishOtaProgress("done", 100);
        delay(1000);
        ESP.restart();
    }
}
