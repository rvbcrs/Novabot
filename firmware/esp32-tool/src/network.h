#pragma once

/**
 * network.h — WiFi AP setup, custom DNS server, HTTP server with all endpoints,
 *             and SD card firmware loading.
 */

#ifdef JC3248W535
#include <ESPAsyncWebServer.h>
extern AsyncWebServer httpServer;
#else
#include <WebServer.h>
extern WebServer httpServer;
#endif
#include <WiFiUdp.h>
extern WiFiUDP dnsUdp;

// ── Public API ──────────────────────────────────────────────────────────────

void setupWifiAP();
void setupDNS();
void processDNS();
void setupHTTP();

bool loadFirmwareInfo();
String computeMd5(const char* path);
void kickChargerForOta();
void allowChargerAfterOta();
