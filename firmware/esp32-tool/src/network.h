#pragma once

/**
 * network.h — WiFi AP setup, custom DNS server, HTTP server with all endpoints,
 *             and SD card firmware loading.
 */

#include <ESPAsyncWebServer.h>
extern AsyncWebServer httpServer;
#include <WiFiUdp.h>
extern WiFiUDP dnsUdp;

// ── Public API ──────────────────────────────────────────────────────────────

void setupWifiAP();
void connectHomeWifi();  // Connect STA to home WiFi (AP stays active)
void setupDNS();
void processDNS();
void setupHTTP();

bool loadFirmwareInfo();
String computeMd5(const char* path);

// ESP32 self-OTA (PSRAM buffer + main-loop flash)
extern volatile bool espOtaReady;
extern uint8_t* espOtaBuf;
extern size_t espOtaSize;
extern size_t espOtaTotal;
void processEspOta();
