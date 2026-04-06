/**
 * wizard.cpp — Wizard state machine for the Nova-OTA provisioning flow.
 *
 * Contains setState(), buildFilteredResults(), and the main processWizardState()
 * function that handles all 16 wizard states.
 */

#include "wizard.h"
#include "config.h"
#include "display.h"
#include "ble.h"
#include "mqtt.h"
#include "network.h"
#include <Preferences.h>

extern Preferences prefs;

static int scanRetryCount = 0;

// ── State helper ─────────────────────────────────────────────────────────────

void setState(State newState) {
    currentState = newState;
    stateJustEntered = true;
    stateEnteredAt = millis();
    // Map state to wizard step number for progress indicator
    switch (newState) {
        case WIZ_BOOT:               wizStep = 0; break;
        case WIZ_WIFI_CONFIG:        wizStep = 1; break;
        case WIZ_SCAN_CHARGER:       wizStep = 2; break;
        case WIZ_PROVISION_CHARGER:  wizStep = 3; break;
        case WIZ_SCAN_MOWER:         wizStep = 4; break;
        case WIZ_PROVISION_MOWER:    wizStep = 5; break;
        case WIZ_WAIT_MOWER:         wizStep = 6; break;
        case WIZ_OTA_FLASH:          wizStep = 7; break;
        case WIZ_REPROVISION:        wizStep = 8; break;
        case WIZ_DONE:               wizStep = 8; break;
        default:                     break;
    }
}

// ── Helper: build filtered scan results for display ─────────────────────────
static ScanResult filteredResults[20];
static int filteredCount = 0;

// Filter scan results to only chargers or only mowers, remap selected index
int buildFilteredResults(bool showChargers) {
    filteredCount = 0;
    int newSelectedIdx = -1;
    for (int i = 0; i < scanResultCount && filteredCount < 20; i++) {
        bool match = showChargers ? scanResults[i].isCharger : scanResults[i].isMower;
        if (match) {
            filteredResults[filteredCount] = scanResults[i];
            if (showChargers && i == selectedChargerIdx) newSelectedIdx = filteredCount;
            if (!showChargers && i == selectedMowerIdx) newSelectedIdx = filteredCount;
            filteredCount++;
        }
    }
    return newSelectedIdx;
}

// ── Main wizard state machine ───────────────────────────────────────────────

void processWizardState() {
    unsigned long elapsed = (millis() - stateEnteredAt) / 1000;

    // Auto-detect OTA in progress (mower resuming cached download)
    // Only jump to flash screen from early wizard states
    if (otaProgressPercent > 0 && otaProgressPercent < 100 && otaStatus == "upgrade" &&
        currentState != WIZ_OTA_FLASH && currentState != WIZ_OTA_CONFIRM &&
        currentState != WIZ_MOWER_CHECK && currentState != WIZ_WAIT_MOWER &&
        currentState != WIZ_WAIT_REBOOT && currentState != WIZ_REPROVISION &&
        currentState != WIZ_DONE && currentState != WIZ_ERROR) {
        webLogAdd("OTA in progress detected (%d%%) — switching to flash screen", otaProgressPercent);
        setState(WIZ_OTA_FLASH);
    }

    switch (currentState) {

    case WIZ_BOOT:
        // Should not stay here -- setup() transitions to WIZ_WIFI_CONFIG or WIZ_SCAN_CHARGER
        break;

    case WIZ_WIFI_CONFIG: {
        // Sub-steps: 0=show SSID keyboard, 1=show password keyboard, 2=show MQTT keyboard
        static int wifiConfigStep = 0;

        if (stateJustEntered) {
            stateJustEntered = false;
            wifiConfigStep = 0;
            statusMessage = "Enter home WiFi SSID";
            webLogAdd("WiFi config: enter SSID");
            ui_wifiPasswordReady = false;
            display_textEntry("WiFi Network", "Step 1 of 3", "Enter SSID (network name)", "Next");
        }

        // Also accept config via WebUI at any time
        if (userWifiSsid.length() > 0 && userMqttAddr.length() > 0) {
            Serial.printf("[SETUP] Config via WebUI: WiFi=%s MQTT=%s\r\n",
                          userWifiSsid.c_str(), userMqttAddr.c_str());
            webLogAdd("Config OK: WiFi=%s MQTT=%s", userWifiSsid.c_str(), userMqttAddr.c_str());
            setState(WIZ_SCAN_CHARGER);
            break;
        }

        if (wifiConfigStep == 0 && ui_wifiPasswordReady) {
            // SSID entered via keyboard — stored in ui_wifiPassword by callback
            strncpy(ui_wifiSsid, ui_wifiPassword, sizeof(ui_wifiSsid) - 1);
            userWifiSsid = String(ui_wifiPassword);
            Serial.printf("[LCD] WiFi SSID: %s\r\n", userWifiSsid.c_str());
            wifiConfigStep = 1;
            ui_wifiPasswordReady = false;
            char sub[64];
            snprintf(sub, sizeof(sub), "Network: %s  (Step 2 of 3)", userWifiSsid.c_str());
            display_textEntry("WiFi Password", sub, "Enter password", "Next");
        }
        else if (wifiConfigStep == 1 && ui_wifiPasswordReady) {
            // Password entered
            userWifiPassword = String(ui_wifiPassword);
            Serial.printf("[LCD] WiFi password set (%d chars)\r\n", userWifiPassword.length());
            wifiConfigStep = 2;
            display_mqttAddr();  // Now ask for MQTT server IP
        }
        else if (wifiConfigStep == 2 && ui_mqttAddrReady) {
            // MQTT address entered
            userMqttAddr = String(ui_mqttAddr);
            Serial.printf("[LCD] MQTT addr: %s\r\n", userMqttAddr.c_str());

            // Save to NVS
            prefs.putString("wifi_ssid", userWifiSsid);
            prefs.putString("wifi_pass", userWifiPassword);
            prefs.putString("mqtt_addr", userMqttAddr);
            webLogAdd("Config saved: WiFi=%s MQTT=%s", userWifiSsid.c_str(), userMqttAddr.c_str());
            setState(WIZ_SCAN_CHARGER);
        }
        break;
    }

    case WIZ_SCAN_CHARGER: {
        // Step 2: BLE scan for charger — OPTIONAL, user can skip anytime
        if (stateJustEntered) {
            stateJustEntered = false;
            scanRetryCount = 0;
            ui_btnPressed = false;
            webLogAdd("BLE: Scanning for charger (optional)...");
            statusMessage = "Scanning for charger...";
            display_confirm("Scanning for Charger",
                "Looking for CHARGER_PILE via BLE...",
                "Charger provisioning is optional.",
                "Skip");
            scanResultCount = 0;
            selectedChargerIdx = -1;
            chargerDevice = nullptr;
            startBleScan();
        }
        // Skip anytime during scan
        if (ui_btnPressed) {
            ui_btnPressed = false;
            webLogAdd("Charger scan skipped by user");
            setState(WIZ_MOWER_CHECK);
            break;
        }
        if (!bleScanning) {
            int chargerCount = 0;
            for (int i = 0; i < scanResultCount; i++) {
                if (scanResults[i].isCharger) chargerCount++;
            }
            if (chargerCount > 0) {
                webLogAdd("BLE: Found %d charger(s)", chargerCount);
                int selIdx = buildFilteredResults(true);
                display_devices(filteredResults, filteredCount, selIdx, -1);
                setState(WIZ_SELECT_CHARGER);
            } else {
                scanRetryCount++;
                if (scanRetryCount >= 3) {
                    webLogAdd("BLE: No charger after 3 scans — skipping");
                    setState(WIZ_MOWER_CHECK);
                } else {
                    webLogAdd("BLE: No charger found (%d/3), retrying...", scanRetryCount);
                    delay(2000);
                    stateJustEntered = true;
                }
            }
        }
        break;
    }

    case WIZ_SELECT_CHARGER: {
        if (stateJustEntered) {
            stateJustEntered = false;
            ui_btnPressed = false;
            ui_startPressed = false;
            ui_rescanPressed = false;
        }
        if (ui_rescanPressed) {
            ui_rescanPressed = false;
            webLogAdd("BLE: Rescanning for charger...");
            setState(WIZ_SCAN_CHARGER);
        }
        else if (ui_btnPressed) {
            ui_btnPressed = false;
            ui_startPressed = false;
            webLogAdd("Charger skipped — continuing to mower");
            setState(WIZ_MOWER_CHECK);
        }
        else if (ui_startPressed) {
            ui_startPressed = false;
            if (selectedChargerIdx >= 0 && chargerDevice != nullptr) {
                webLogAdd("BLE: Selected charger: %s", scanResults[selectedChargerIdx].name.c_str());
                setState(WIZ_PROVISION_CHARGER);
            }
        }
        break;
    }

    case WIZ_PROVISION_CHARGER: {
        if (stateJustEntered) {
            stateJustEntered = false;
            webLogAdd("BLE: Provisioning charger...");
            statusMessage = "Provisioning charger...";
            provisionProgressCb = display_provision;
            reprovisioning = false;
            if (provisionDevice(chargerDevice, "charger")) {
                provisionProgressCb = nullptr;
                bool chargerToHome = userWifiSsid.length() > 0 && userMqttAddr.length() > 0;
                if (chargerToHome) {
                    webLogAdd("BLE: Charger → home WiFi (%s) + MQTT %s", userWifiSsid.c_str(), userMqttAddr.c_str());
                } else {
                    webLogAdd("BLE: Charger → our AP");
                }
                chargerWifiDetected = true;
                // After charger → check mower status
                setState(WIZ_MOWER_CHECK);
            } else {
                webLogAdd("BLE: Charger provisioning failed!");
                provisionProgressCb = nullptr;
                statusMessage = "Charger provisioning failed";
                display_error("Charger provisioning failed.\nMove closer and retry.");
                setState(WIZ_ERROR);
            }
        }
        break;
    }

    case WIZ_WAIT_CHARGER:
        // Legacy — charger goes to home WiFi now, no need to wait
        setState(WIZ_MOWER_CHECK);
        break;

    case WIZ_MOWER_CHECK: {
        // Device status screen — stays here until mower connects or user taps Scan
        if (stateJustEntered) {
            stateJustEntered = false;
            ui_btnPressed = false;
            ui_rescanPressed = false;
            webLogAdd("Waiting for mower MQTT connection...");
        }

        int mwStatus = mowerConnected ? 2 : (mowerWifiDetected ? 1 : 0);

        static unsigned long lastChkRefresh = 0;
        if (millis() - lastChkRefresh > 1000) {
            lastChkRefresh = millis();
            display_deviceStatus(0, "", mwStatus, mowerSn.c_str(), mowerFirmwareVersion.c_str(), mwStatus == 2);
        }

        // Continue button — mower on MQTT
        if (ui_btnPressed && mwStatus == 2) {
            ui_btnPressed = false;
            if (mowerFwFilename.length() > 0) {
                setState(WIZ_OTA_CONFIRM);
            } else {
                setState(WIZ_DONE);
            }
        } else if (ui_btnPressed && mwStatus < 2) {
            ui_btnPressed = false;
        }
        // Scan button — go to BLE scan manually
        if (ui_rescanPressed) {
            ui_rescanPressed = false;
            webLogAdd("Manual BLE scan requested");
            setState(WIZ_SCAN_MOWER);
        }
        break;
    }

    case WIZ_SCAN_MOWER: {
        if (stateJustEntered) {
            stateJustEntered = false;
            webLogAdd("BLE: Scanning for mower...");
            statusMessage = "Scanning for mower...";
            display_scanning();
            scanResultCount = 0;
            selectedMowerIdx = -1;
            mowerDevice = nullptr;
            startBleScan();
        }
        if (!bleScanning) {
            int mowerCount = 0;
            for (int i = 0; i < scanResultCount; i++) {
                if (scanResults[i].isMower) mowerCount++;
            }
            if (mowerCount == 0) {
                scanRetryCount++;
                if (scanRetryCount >= 3) {
                    // After 3 retries, offer skip option
                    webLogAdd("BLE: No mower after %d scans — tap to skip or wait for retry", scanRetryCount);
                    display_confirm("Mower Not Found",
                        "No mower found after 3 scans.",
                        "Is the mower powered on?",
                        "Retry");
                    setState(WIZ_SELECT_MOWER);  // reuse select state for skip
                } else {
                    webLogAdd("BLE: No mower found, retrying in 3s... (%d/3)", scanRetryCount);
                    display_error("No mower found\nMake sure mower is powered on\nand not connected to WiFi\n\nRetrying...");
                    delay(3000);
                    stateJustEntered = true;  // retry
                }
            } else {
                webLogAdd("BLE: Found %d mower(s)", mowerCount);
                int selIdx = buildFilteredResults(false);  // mowers only
                display_devices(filteredResults, filteredCount, -1, selIdx);
                setState(WIZ_SELECT_MOWER);
            }
        }
        break;
    }

    case WIZ_SELECT_MOWER: {
        if (stateJustEntered) {
            stateJustEntered = false;
            ui_btnPressed = false;
            ui_startPressed = false;
            ui_rescanPressed = false;
        }
        if (ui_rescanPressed) {
            // Skip button (left) → skip mower entirely
            ui_rescanPressed = false;
            webLogAdd("Skipping mower");
            scanRetryCount = 0;
            setState(WIZ_DONE);
        }
        else if (ui_btnPressed) {
            // Retry button (right) or confirm from "Mower Not Found" → rescan
            ui_btnPressed = false;
            if (selectedMowerIdx < 0) {
                webLogAdd("BLE: Retrying mower scan...");
                scanRetryCount = 0;
                setState(WIZ_SCAN_MOWER);
            }
        }
        else if (ui_startPressed) {
            ui_startPressed = false;
            if (selectedMowerIdx >= 0 && mowerDevice != nullptr) {
                webLogAdd("BLE: Selected mower: %s", scanResults[selectedMowerIdx].name.c_str());
                scanRetryCount = 0;
                setState(WIZ_PROVISION_MOWER);
            }
        }
        break;
    }

    case WIZ_PROVISION_MOWER: {
        if (stateJustEntered) {
            stateJustEntered = false;
            // Stop WiFi during mower BLE to avoid interference
            Serial.println("[NET] Stopping WiFi for mower BLE provisioning...");
            WiFi.enableAP(false);

            webLogAdd("BLE: Provisioning mower...");
            statusMessage = "Provisioning mower...";
            provisionProgressCb = display_provision;
            reprovisioning = false;  // Use AP credentials
            if (provisionDevice(mowerDevice, "mower")) {
                webLogAdd("BLE: Mower provisioned!");
                provisionProgressCb = nullptr;
                // Restart WiFi AP (was stopped during BLE) then wait for mower MQTT
                setupWifiAP();
                while (WiFi.softAPIP() == IPAddress(0, 0, 0, 0)) { delay(100); }
                setState(WIZ_WAIT_MOWER);
            } else {
                webLogAdd("BLE: Mower provisioning failed!");
                provisionProgressCb = nullptr;
                statusMessage = "Mower provisioning failed";
                display_error("Mower provisioning failed.\nMove closer and retry.");
                setState(WIZ_ERROR);
            }
        }
        break;
    }

    case WIZ_WAIT_MOWER: {
        if (stateJustEntered) {
            stateJustEntered = false;
            // Only restart AP if it was stopped (during mower BLE provisioning)
            if (WiFi.softAPIP() == IPAddress(0, 0, 0, 0)) {
                Serial.printf("[NET] (Re)starting WiFi AP...\r\n");
                webLogAdd("Restarting WiFi AP...");
                setupWifiAP();
                while (WiFi.softAPIP() == IPAddress(0, 0, 0, 0)) { delay(100); }
                webLogAdd("AP ready at %s", WiFi.softAPIP().toString().c_str());
            }
            webLogAdd("Waiting for mower MQTT...");
            statusMessage = "Waiting for mower MQTT...";
        }
        {
            static unsigned long lastWaitRefresh = 0;
            if (millis() - lastWaitRefresh > 1000) {
                lastWaitRefresh = millis();
                int chStatus = chargerMqttConnected ? 2 : (chargerWifiDetected ? 1 : 0);
                int mwStatus = mowerConnected ? 2 : (mowerWifiDetected ? 1 : 0);
                display_deviceStatus(chStatus, chargerSn.c_str(), mwStatus, mowerSn.c_str(), mowerFirmwareVersion.c_str(), false);
            }
        }
        if (mowerConnected) {
            webLogAdd("MQTT: Mower connected!");
            // Check if we have firmware to flash
            if (mowerFwFilename.length() > 0) {
                setState(WIZ_OTA_CONFIRM);
            } else {
                webLogAdd("No mower firmware on SD — skipping OTA");
                setState(WIZ_DONE);
            }
        }
        if (elapsed > 120) {
            webLogAdd("MQTT: Mower timeout");
            statusMessage = "Mower did not connect via MQTT";
            setState(WIZ_ERROR);
        }
        break;
    }

    case WIZ_OTA_CONFIRM: {
        if (stateJustEntered) {
            stateJustEntered = false;
            mowerOtaTriedPlain = false;
            mowerOtaTriedAes = false;
            ui_btnPressed = false;
            ui_rescanPressed = false;
            webLogAdd("Firmware available: %s (charging: %s)", mowerFwFilename.c_str(), mowerCharging ? "yes" : "no");
            statusMessage = "Flash firmware?";
        }
        {
            static unsigned long lastOtaRefresh = 0;
            static bool lastChargingState = false;
            if (stateJustEntered || millis() - lastOtaRefresh > 1000 || mowerCharging != lastChargingState) {
                lastOtaRefresh = millis();
                lastChargingState = mowerCharging;
                String line1 = String("Flash ") + mowerFwVersion + " to " + mowerSn;
                String line2 = mowerCharging
                    ? "Mower is on charger - ready!"
                    : "Place mower on charger to flash";
                display_confirm("Flash Firmware?", line1.c_str(), line2.c_str(),
                    mowerCharging ? "Flash" : "");
            }
        }
        // Flash button (ui_btnPressed from confirm screen)
        if (ui_btnPressed && mowerCharging) {
            ui_btnPressed = false;
            setState(WIZ_OTA_FLASH);
        } else if (ui_btnPressed && !mowerCharging) {
            ui_btnPressed = false;
            webLogAdd("OTA: Mower not on charger — waiting...");
        }
        // Skip button (ui_rescanPressed reused as skip)
        if (ui_rescanPressed) {
            ui_rescanPressed = false;
            webLogAdd("OTA skipped — going to reprovision");
            if (userWifiSsid.length() > 0) {
                setState(WIZ_REPROVISION);
            } else {
                setState(WIZ_DONE);
            }
        }
        break;
    }

    case WIZ_OTA_FLASH: {
        static bool otaSent = false;
        if (stateJustEntered) {
            stateJustEntered = false;
            otaSent = false;
            otaProgressPercent = 0;
            otaStatus = "";
            statusMessage = "Waiting for mower MQTT...";
            display_ota("Waiting for mower MQTT...");
        }
        // Wait for mower to be connected before sending OTA
        if (!otaSent && mowerConnected) {
            webLogAdd("OTA: Sending firmware to mower...");
            statusMessage = "Sending OTA command...";
            display_ota("Sending OTA command...");
            sendMowerOta();  // tries plain first, then AES
            otaSent = true;
        }
        // Display OTA progress — throttled to once per second
        {
            static unsigned long lastFlashRefresh = 0;
            if (millis() - lastFlashRefresh > 1000) {
                lastFlashRefresh = millis();
                int displayPercent = (otaProgressPercent > httpDownloadPercent)
                    ? otaProgressPercent : httpDownloadPercent;
                const char* statusText = "Downloading...";
                if (otaStatus.length() > 0) statusText = otaStatus.c_str();
                else if (httpDownloadPercent >= 62) statusText = "Unpacking...";
                display_firmware_flash("Mower", statusText, displayPercent);
            }
        }

        // AES retry: if plain OTA got "fail" or no response after 30s, try encrypted (v6.x)
        if (mowerOtaTriedPlain && !mowerOtaTriedAes &&
            mowerOtaSentAt > 0 && millis() - mowerOtaSentAt > 30000 &&
            otaProgressPercent == 0 && mowerConnected) {
            webLogAdd("OTA: No progress after 30s, retrying with AES...");
            display_firmware_flash("Mower", "Retrying (encrypted)...", 0);
            mowerOtaTriedAes = true;
            sendMowerOtaWithAes(true);
        }

        // Timeout: both PLAIN and AES tried, 30s after AES, still no progress → FAILED
        if (mowerOtaTriedPlain && mowerOtaTriedAes &&
            mowerOtaSentAt > 0 && millis() - mowerOtaSentAt > 30000 &&
            otaProgressPercent == 0) {
            webLogAdd("OTA: No response — cleaning cache + rebooting mower...");
            mowerOtaTriedPlain = false;
            mowerOtaTriedAes = false;
            sendOtaCleanup();  // clean cache + reboot mower
            display_error("OTA Failed!\n\nCleaning cache + rebooting mower.\nWait for reconnect, then retry.\n\nTap to retry.");
            setState(WIZ_ERROR);
            break;
        }

        // Check for completion
        if (otaStatus == "success" || otaProgressPercent >= 100) {
            webLogAdd("OTA: Firmware installed! Waiting for reboot...");
            display_firmware_flash("Mower", "Installed! Rebooting...", 100);
            // Reset OTA state so auto-detect doesn't re-trigger
            otaProgressPercent = 0;
            otaStatus = "";
            mowerOtaTriedPlain = false;
            mowerOtaTriedAes = false;
            delay(3000);
            setState(WIZ_WAIT_REBOOT);
        }

        // After device disconnects (rebooting with new firmware), also proceed
        if (!mowerConnected && mowerSn.length() > 0 && elapsed > 10) {
            webLogAdd("OTA: Mower disconnected — waiting for reboot...");
            display_firmware_flash("Mower", "Rebooting...", 100);
            delay(2000);
            setState(WIZ_WAIT_REBOOT);
        }

        // Timeout after 30 minutes
        if (elapsed > 1800) {
            statusMessage = "OTA timeout — mower did not complete firmware install";
            setState(WIZ_ERROR);
        }
        break;
    }

    case WIZ_WAIT_REBOOT: {
        // Wait for mower to reboot after OTA and reconnect via MQTT
        if (stateJustEntered) {
            stateJustEntered = false;
            mowerConnected = false;  // Reset — wait for fresh MQTT connect
            mowerFirmwareVersion = "";  // Will be re-queried after reconnect
            webLogAdd("Waiting for mower reboot...");
        }
        {
            static unsigned long lastRebootRefresh = 0;
            if (millis() - lastRebootRefresh > 1000) {
                lastRebootRefresh = millis();
                int mwStatus = mowerConnected ? 2 : (mowerWifiDetected ? 1 : 0);
                display_deviceStatus(0, "", mwStatus, mowerSn.c_str(),
                    mowerFirmwareVersion.c_str(), false);
            }
        }
        if (mowerConnected) {
            webLogAdd("Mower back online after reboot!");
            if (userWifiSsid.length() > 0) {
                setState(WIZ_REPROVISION);
            } else {
                setState(WIZ_DONE);
            }
        }
        if (elapsed > 180) {
            webLogAdd("Mower did not reconnect after 3 minutes");
            setState(WIZ_ERROR);
        }
        break;
    }

    case WIZ_REPROVISION: {
        // Step 8: Confirm, then re-provision mower to home WiFi
        static bool reprovConfirmed = false;
        if (stateJustEntered) {
            stateJustEntered = false;
            reprovConfirmed = false;
            ui_btnPressed = false;
            String line1 = "Send mower to home WiFi:";
            String line2 = userWifiSsid + " / MQTT: " + userMqttAddr;
            display_confirm("Reprovision?", line1.c_str(), line2.c_str(), "Reprovision");
        }
        if (!reprovConfirmed && ui_btnPressed) {
            ui_btnPressed = false;
            reprovConfirmed = true;
        }
        // Skip button → go to Done without reprovisioning
        if (ui_rescanPressed) {
            ui_rescanPressed = false;
            webLogAdd("Reprovision skipped");
            setState(WIZ_DONE);
            break;
        }
        if (!reprovConfirmed) break;
        {
            reprovisioning = true;
            webLogAdd("Re-provisioning mower to home WiFi: %s", userWifiSsid.c_str());
            statusMessage = "Mower → home WiFi...";

            display_reprovision("Mower -> home WiFi", 1, 1);
            bool mowerOk = false;

            if (mowerConnected && mowerSn.length() > 0) {
                // Use extended_commands.py (custom firmware) to bypass mqtt_node whitelist.
                // Stock mqtt_node only accepts *.lfibot.com for set_mqtt_info — but
                // extended_commands.py writes directly to json_config.json.
                String extTopic = "novabot/extended/" + mowerSn;
                webLogAdd("REPROVISION: via extended_commands");

                // 1. Set MQTT address first (bypasses whitelist)
                // This must be processed BEFORE WiFi switches, because
                // nmcli WiFi switch drops the MQTT connection immediately
                String mqttCmd = "{\"set_mqtt_config\":{\"addr\":\"" + userMqttAddr +
                    "\",\"port\":1883}}";
                mqttBroker.publish(std::string(extTopic.c_str()), std::string(mqttCmd.c_str()));
                Serial.printf("[REPROV] MQTT config → %s\r\n", userMqttAddr.c_str());
                delay(3000);  // Wait for json_config.json write

                // 2. Set WiFi — this triggers nmcli which switches WiFi immediately
                // After this, the mower drops off our AP and connects to home WiFi
                // The mqtt_node restart inside set_wifi_config will read the new MQTT addr
                String wifiCmd = "{\"set_wifi_config\":{\"ssid\":\"" + userWifiSsid +
                    "\",\"password\":\"" + userWifiPassword + "\"}}";
                mqttBroker.publish(std::string(extTopic.c_str()), std::string(wifiCmd.c_str()));
                Serial.printf("[REPROV] WiFi config → %s (mower will disconnect)\r\n", userWifiSsid.c_str());

                mowerOk = true;
            } else if (mowerDevice) {
                webLogAdd("REPROVISION: Mower via BLE");
                provisionProgressCb = display_provision;
                mowerOk = provisionDevice(mowerDevice, "mower");
                provisionProgressCb = nullptr;
            } else {
                webLogAdd("REPROVISION: Mower not available — skipping");
                mowerOk = true;
            }

            reprovisioning = false;

            if (mowerOk) {
                webLogAdd("Mower re-provisioned to home WiFi!");
                setState(WIZ_DONE);
            } else {
                statusMessage = "Re-provisioning failed";
                display_error("Mower re-provisioning failed.\nTap to retry.");
                setState(WIZ_ERROR);
            }
        }
        break;
    }

    case WIZ_DONE: {
        if (stateJustEntered) {
            stateJustEntered = false;
            webLogAdd("Done! All devices provisioned.");
            statusMessage = "Done!";
            display_done();
            Serial.println("[STATE] Wizard complete!");
        }
        // Tap to restart — delay to let confetti animations finish
        if (ui_btnPressed && elapsed > 15) {
            ui_btnPressed = false;
            ESP.restart();
        }
        break;
    }

    case WIZ_ERROR: {
        if (stateJustEntered) {
            stateJustEntered = false;
            webLogAdd("Error: %s", statusMessage.c_str());
            display_error(statusMessage.c_str());
        }
        if (ui_btnPressed) {
            ui_btnPressed = false;
            // Retry from the beginning
            setState(WIZ_SCAN_CHARGER);
        }
        break;
    }

    } // end switch

    // Small delay to prevent tight looping
    delay(50);
}
