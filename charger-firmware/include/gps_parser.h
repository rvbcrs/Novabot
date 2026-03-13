#pragma once
#include <Arduino.h>

// GPS data from UM980/UM960 NMEA parsing
struct GpsData {
    double latitude;
    double longitude;
    double altitude;
    uint8_t satellites;
    bool valid;             // GNGGA fix quality > 0
    bool rtkFixed;          // Fix quality 4 or 5 (RTK)
    char lastGngga[128];    // Raw GNGGA sentence for LoRa relay
    size_t lastGnggaLen;
};

// Initialize GPS UART
void gpsInit();

// Process incoming GPS data. Call this frequently from the GPS task.
// Returns true if a new GNGGA sentence was parsed.
bool gpsUpdate();

// Get current GPS data (thread-safe copy)
GpsData gpsGetData();
