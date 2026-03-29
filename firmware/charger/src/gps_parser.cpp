#include "gps_parser.h"
#include "config.h"
#include <TinyGPSPlus.h>

static TinyGPSPlus gps;
static GpsData currentData;
static SemaphoreHandle_t gpsMutex = NULL;

// Line buffer for capturing raw GNGGA sentences
static char lineBuf[256];
static size_t lineIdx = 0;
static bool inGngga = false;

void gpsInit() {
    GPS_SERIAL.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
    gpsMutex = xSemaphoreCreateMutex();
    memset(&currentData, 0, sizeof(currentData));
    Serial.println("[GPS] Initialized UART2");
}

bool gpsUpdate() {
    bool newSentence = false;

    while (GPS_SERIAL.available()) {
        char c = GPS_SERIAL.read();

        // Feed to TinyGPSPlus for parsing
        gps.encode(c);

        // Capture raw GNGGA line for LoRa relay
        if (c == '$') {
            lineIdx = 0;
            lineBuf[lineIdx++] = c;
            inGngga = false;
        } else if (lineIdx > 0 && lineIdx < sizeof(lineBuf) - 1) {
            lineBuf[lineIdx++] = c;

            // Check if this is a GNGGA sentence
            if (lineIdx == 6) {
                inGngga = (memcmp(lineBuf + 1, "GNGGA", 5) == 0);
            }

            // End of sentence
            if (c == '\n' || c == '\r') {
                if (inGngga && lineIdx > 10) {
                    lineBuf[lineIdx] = '\0';

                    if (xSemaphoreTake(gpsMutex, pdMS_TO_TICKS(50))) {
                        // Update parsed data from TinyGPSPlus
                        currentData.latitude = gps.location.lat();
                        currentData.longitude = gps.location.lng();
                        currentData.altitude = gps.altitude.meters();
                        currentData.satellites = gps.satellites.value();
                        currentData.valid = gps.location.isValid();

                        // RTK: TinyGPSPlus doesn't expose fix quality directly
                        // Parse it from the raw GNGGA sentence (field 6)
                        // $GNGGA,time,lat,N,lon,E,quality,...
                        int commaCount = 0;
                        for (size_t i = 0; i < lineIdx && commaCount < 6; i++) {
                            if (lineBuf[i] == ',') commaCount++;
                            if (commaCount == 6) {
                                int quality = lineBuf[i + 1] - '0';
                                currentData.rtkFixed = (quality == 4 || quality == 5);
                                break;
                            }
                        }

                        // Store raw GNGGA for relay
                        size_t copyLen = lineIdx;
                        if (copyLen >= sizeof(currentData.lastGngga))
                            copyLen = sizeof(currentData.lastGngga) - 1;
                        memcpy(currentData.lastGngga, lineBuf, copyLen);
                        currentData.lastGngga[copyLen] = '\0';
                        currentData.lastGnggaLen = copyLen;

                        xSemaphoreGive(gpsMutex);
                    }

                    newSentence = true;
                    inGngga = false;
                }
                lineIdx = 0;
            }
        } else {
            lineIdx = 0; // Overflow protection
        }
    }

    return newSentence;
}

GpsData gpsGetData() {
    GpsData copy;
    if (gpsMutex && xSemaphoreTake(gpsMutex, pdMS_TO_TICKS(50))) {
        copy = currentData;
        xSemaphoreGive(gpsMutex);
    } else {
        memset(&copy, 0, sizeof(copy));
    }
    return copy;
}
