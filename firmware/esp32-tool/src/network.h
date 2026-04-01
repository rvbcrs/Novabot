#pragma once

/**
 * network.h — WiFi AP setup, custom DNS server, HTTP server with all endpoints,
 *             and SD card firmware loading.
 */

#include <WebServer.h>
#include <WiFiUdp.h>

extern WebServer httpServer;
extern WebServer otaHttpServer;
extern WiFiUDP dnsUdp;

// ── Public API ──────────────────────────────────────────────────────────────

void setupWifiAP();
void setupDNS();
void processDNS();
void setupHTTP();

bool loadFirmwareInfo();
String computeMd5(const char* path);
