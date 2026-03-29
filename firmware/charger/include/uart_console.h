#pragma once
#include <Arduino.h>

// Initialize UART console (reads from Serial/UART0)
void consoleInit();

// Process incoming console commands — call from loop() or dedicated task
// Matches Ghidra app_main UART handler (lines 28156-28230)
// Commands: v (version), a/m/f/o/w/d (LoRa queue), @ (SN write), r (reboot), b (OTA boot)
// Also handles: SN_GET, SN_SET, LORARSSI
void consoleProcess();
