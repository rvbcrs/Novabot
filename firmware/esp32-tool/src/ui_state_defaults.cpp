/**
 * ui_state_defaults.cpp — UI state flag definitions for headless builds.
 *
 * When HAS_DISPLAY is not defined, display.cpp is excluded from the build
 * but the ui_* flags are still needed by the wizard state machine and web API.
 */

#ifndef HAS_DISPLAY

#include "display.h"

volatile int  ui_selectedChargerIdx = -1;
volatile int  ui_selectedMowerIdx   = -1;
volatile bool ui_startPressed       = false;
volatile bool ui_btnPressed         = false;
volatile bool ui_rescanPressed      = false;
volatile int  ui_selectedWifiIdx    = -1;
volatile bool ui_wifiPasswordReady  = false;
volatile bool ui_wifiRescanPressed  = false;
char ui_wifiPassword[64]            = {0};
char ui_wifiSsid[33]                = {0};
volatile bool ui_mqttAddrReady      = false;
char ui_mqttAddr[64]                = {0};

#endif
