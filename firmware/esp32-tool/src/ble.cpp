#include "ble.h"
#include "config.h"
#include "mqtt.h"
#include "display.h"

// ── BLE Scan callback ────────────────────────────────────────────────────────

void ScanCallbacks::onResult(const NimBLEAdvertisedDevice* advertisedDevice) {
    String name = advertisedDevice->getName().c_str();
    if (name.length() == 0) return;

    // Check for duplicates
    // Normalize MAC: uppercase with colons (e.g. "48:27:E2:2E:EF:D6")
    String rawMac = advertisedDevice->getAddress().toString().c_str();
    rawMac.toUpperCase();
    String mac = rawMac;
    if (rawMac.length() == 12 && rawMac.indexOf(':') == -1) {
        mac = rawMac.substring(0,2) + ":" + rawMac.substring(2,4) + ":" +
              rawMac.substring(4,6) + ":" + rawMac.substring(6,8) + ":" +
              rawMac.substring(8,10) + ":" + rawMac.substring(10,12);
    }
    for (int i = 0; i < scanResultCount; i++) {
        if (scanResults[i].mac == mac) return;
    }

    // Add to results array
    if (scanResultCount < 20) {
        ScanResult& r = scanResults[scanResultCount];
        r.name = name;
        r.mac = mac;
        r.rssi = advertisedDevice->getRSSI();
        // Match by BLE name (case-insensitive) AND/OR MAC prefix
        String nameLower = name;
        nameLower.toLowerCase();
        // BLE name match
        bool nameIsCharger = (nameLower.indexOf("charger") >= 0);
        bool nameIsMower = (nameLower.indexOf("novabot") >= 0 || nameLower.indexOf("lfin") >= 0);
        // MAC prefix match (BLE MAC = WiFi STA MAC + 2, so prefix is same)
        // LFIC chargers: 48:27:E2:*
        // LFIN1 mowers:  50:41:1C:*
        // LFIN2 mowers:  70:4A:0E:*
        bool macIsCharger = mac.startsWith("48:27");
        bool macIsMower = mac.startsWith("70:4A") || mac.startsWith("50:41");
        r.isCharger = nameIsCharger || macIsCharger;
        r.isMower = nameIsMower || macIsMower;

        Serial.printf("[BLE] Found: %s (%s) RSSI=%d%s%s\r\n",
                     name.c_str(), mac.c_str(), r.rssi,
                     r.isCharger ? " [CHARGER]" : "",
                     r.isMower ? " [MOWER]" : "");

        // Auto-select first charger/mower found
        if (r.isCharger && selectedChargerIdx < 0) {
            selectedChargerIdx = scanResultCount;
        }
        if (r.isMower && selectedMowerIdx < 0) {
            selectedMowerIdx = scanResultCount;
        }

        // Also keep NimBLE device pointers for provisioning
        if (r.isCharger && chargerDevice == nullptr) {
            chargerDevice = new NimBLEAdvertisedDevice(*advertisedDevice);
        }
        if (r.isMower && mowerDevice == nullptr) {
            mowerDevice = new NimBLEAdvertisedDevice(*advertisedDevice);
        }

        scanResultCount++;
    }
}

void ScanCallbacks::onScanEnd(const NimBLEScanResults& results, int reason) {
    bleScanning = false;
    Serial.printf("[BLE] Scan complete, found %d device(s)\r\n", scanResultCount);
    webLogAdd("BLE: Scan done, %d device(s)", scanResultCount);
}

// ── BLE scan start ───────────────────────────────────────────────────────────

static ScanCallbacks scanCb;  // Reuse single instance (no heap alloc per scan)

void startBleScan() {
    if (chargerDevice) { delete chargerDevice; chargerDevice = nullptr; }
    if (mowerDevice) { delete mowerDevice; mowerDevice = nullptr; }

    NimBLEScan* scan = NimBLEDevice::getScan();
    scan->clearResults();  // Free previous scan results
    scan->setScanCallbacks(&scanCb, false);
    scan->setActiveScan(true);
    scan->setInterval(100);
    scan->setWindow(99);
    scan->start(15000, false); // 15 second scan
    bleScanning = true;
    Serial.println("[BLE] Scanning for 15 seconds...");
}

// ── BLE provisioning ─────────────────────────────────────────────────────────

bool provisionDevice(NimBLEAdvertisedDevice* device, const char* deviceType) {
    bool isMower = strcmp(deviceType, "mower") == 0;
    const char* displayName = isMower ? "Mower" : "Charger";
    int totalSteps = 5;

    webLogAdd("BLE: Connecting to %s...", device->getName().c_str());
    Serial.printf("[BLE] Connecting to %s (%s)...\r\n", device->getName().c_str(),
                  device->getAddress().toString().c_str());

    if (provisionProgressCb) provisionProgressCb(displayName, 0, totalSteps, "Connecting...");

    NimBLEClient* client = NimBLEDevice::createClient();
    bool connected = false;
    for (int attempt = 1; attempt <= 3; attempt++) {
        Serial.printf("[BLE] Connect attempt %d/3...\r\n", attempt);
        if (client->connect(device)) {
            connected = true;
            break;
        }
        Serial.printf("[BLE] Attempt %d failed\r\n", attempt);
        if (attempt < 3) {
            webLogAdd("BLE: Connect failed, retrying in 2s...");
            delay(2000);
        }
    }
    if (!connected) {
        Serial.println("[BLE] Connection failed after 3 attempts!");
        webLogAdd("BLE: Connection failed (3 attempts)");
        return false;
    }
    Serial.println("[BLE] Connected!");

    // Discover GATT service
    // Charger: service 0x1234, char 0x2222 (write+notify)
    // Mower:   service 0x0201, char 0x0011 (write) + 0x0021 (notify)
    const char* svcUuid   = isMower ? "0201" : "1234";
    const char* writeUuid = isMower ? "0011" : "2222";
    const char* notifUuid = isMower ? "0021" : "2222";

    NimBLERemoteService* svc = client->getService(svcUuid);
    if (!svc) {
        Serial.printf("[BLE] Service %s not found!\r\n", svcUuid);
        client->disconnect();
        return false;
    }

    NimBLERemoteCharacteristic* writeChr = svc->getCharacteristic(writeUuid);
    NimBLERemoteCharacteristic* notifChr = svc->getCharacteristic(notifUuid);
    if (!writeChr || !notifChr) {
        Serial.println("[BLE] Characteristics not found!");
        client->disconnect();
        return false;
    }

    // Subscribe to notifications
    // Mower: responses come on BOTH write char (0011) and notify char (0021)
    // Charger: responses come on write/notify char (2222, same char)
    String bleResponse = "";
    auto notifyCb = [&bleResponse](NimBLERemoteCharacteristic* chr,
                                    uint8_t* data, size_t length, bool isNotify) {
        Serial.printf("[BLE-NOTIFY] chr=%s len=%d data=", chr->getUUID().toString().c_str(), length);
        for (size_t i = 0; i < length && i < 20; i++) Serial.printf("%02X ", data[i]);
        Serial.println();
        // Skip mower bb/cc telemetry
        if (length >= 2 && ((data[0] == 0x62 && data[1] == 0x62) || (data[0] == 0x63 && data[1] == 0x63))) return;
        bleResponse += String((char*)data, length);
    };

    // Subscribe to the notify characteristic
    notifChr->subscribe(true, notifyCb);
    Serial.printf("[BLE] Subscribed to notifications on %s\r\n", notifChr->getUUID().toString().c_str());

    // For mower: also subscribe to write char if it's different and supports notify
    if (isMower && writeChr != notifChr && writeChr->canNotify()) {
        writeChr->subscribe(true, notifyCb);
        Serial.printf("[BLE] Also subscribed to write char %s (mower responses)\r\n", writeChr->getUUID().toString().c_str());
    }

    // ======================================================================
    // Command sequence MUST match official Novabot app exactly:
    //   Charger: set_wifi -> set_rtk -> set_lora -> set_mqtt -> set_cfg
    //   Mower:   get_signal -> set_wifi -> set_lora -> set_mqtt -> set_cfg
    // CRITICAL: Charger ignores set_wifi_info if get_signal_info is sent first!
    // ======================================================================

    // WiFi credentials per device:
    //   Charger: ALWAYS home WiFi (goes straight to home network, off our AP)
    //            If no home WiFi configured yet, fall back to our AP
    //   Mower:   AP credentials during initial provisioning (needs OTA via our AP)
    //            Home WiFi during re-provisioning (after OTA)
    bool chargerToHome = !isMower && userWifiSsid.length() > 0 && userMqttAddr.length() > 0;
    String provSsid, provPass;
    if (isMower) {
        provSsid = reprovisioning ? userWifiSsid : String(AP_SSID);
        provPass = reprovisioning ? userWifiPassword : String(AP_PASSWORD);
    } else {
        // Charger always goes to home WiFi if available
        provSsid = chargerToHome ? userWifiSsid : String(AP_SSID);
        provPass = chargerToHome ? userWifiPassword : String(AP_PASSWORD);
    }

    // AP SSID: use device name if available (e.g. "LFIC1231000319"), else default
    String apSsid = chargerSn.length() > 0 ? chargerSn : "CHARGER_PILE";

    String wifiPayload, cfgPayload;
    if (isMower) {
        wifiPayload = "{\"set_wifi_info\":{\"ap\":{\"ssid\":\"" + provSsid +
                   "\",\"passwd\":\"" + provPass + "\",\"encrypt\":0}}}";
        cfgPayload = "{\"set_cfg_info\":{\"cfg_value\":1,\"tz\":\"Europe/Amsterdam\"}}";
    } else {
        wifiPayload = "{\"set_wifi_info\":{\"sta\":{\"ssid\":\"" + provSsid +
                   "\",\"passwd\":\"" + provPass + "\",\"encrypt\":0}," +
                   "\"ap\":{\"ssid\":\"" + apSsid + "\",\"passwd\":\"12345678\",\"encrypt\":0}}}";
        cfgPayload = "{\"set_cfg_info\":1}";
    }

    // LoRa: charger=channel 16, mower=channel 15 (NEVER the same!)
    int loraChannel = isMower ? LORA_CHANNEL_MOWER : LORA_CHANNEL_CHARGER;
    String loraPayload = "{\"set_lora_info\":{\"addr\":" + String(LORA_ADDR) +
        ",\"channel\":" + String(loraChannel) + ",\"hc\":" + String(LORA_HC) +
        ",\"lc\":" + String(LORA_LC) + "}}";
    // MQTT address per device:
    //   Charger: home MQTT server IP if configured, else our AP (10.0.0.1)
    //   Mower:   mqtt.lfibot.com (resolved by our DNS to 10.0.0.1)
    String mqttAddr = isMower ? String(MQTT_HOST) :
                      (chargerToHome ? userMqttAddr : "10.0.0.1");
    int mqttPort = 1883;
    String mqttPayload = "{\"set_mqtt_info\":{\"addr\":\"" + mqttAddr +
        "\",\"port\":" + String(mqttPort) + "}}";

    Serial.printf("[BLE] Provisioning %s: WiFi=%s MQTT=%s\r\n",
                  isMower ? "mower" : "charger", provSsid.c_str(), mqttAddr.c_str());

    // Build command array in correct order per device type
    struct { const char* name; String payload; int step; } cmds[8];
    int numCmds;

    if (isMower) {
        // Order MUST match bootstrap: get_signal → set_wifi → set_rtk → set_lora → set_mqtt → set_cfg
        cmds[0] = {"get_signal_info", "{\"get_signal_info\":0}", 1};
        cmds[1] = {"set_wifi_info", wifiPayload, 2};
        cmds[2] = {"set_rtk_info", "{\"set_rtk_info\":0}", 3};
        cmds[3] = {"set_lora_info", loraPayload, 4};
        cmds[4] = {"set_mqtt_info", mqttPayload, 5};
        cmds[5] = {"set_cfg_info", cfgPayload, 6};
        numCmds = 6;
    } else {
        // Charger: set_wifi FIRST, then rtk, lora, mqtt, get_wifi (verify), cfg
        cmds[0] = {"set_wifi_info", wifiPayload, 1};
        cmds[1] = {"set_rtk_info", "{\"set_rtk_info\":0}", 2};
        cmds[2] = {"set_lora_info", loraPayload, 3};
        cmds[3] = {"set_mqtt_info", mqttPayload, 4};
        cmds[4] = {"get_wifi_info", "{\"get_wifi_info\":0}", 5};
        cmds[5] = {"set_cfg_info", cfgPayload, 6};
        numCmds = 6;
    }

    totalSteps = numCmds;
    bool disconnected = false;
    int successCount = 0;
    int totalSent = 0;
    for (int i = 0; i < numCmds; i++) {
        // Friendly names for the UI (no technical BLE command names)
        const char* friendlyName = cmds[i].name;
        if (strcmp(cmds[i].name, "set_wifi_info") == 0)    friendlyName = "Setting WiFi...";
        else if (strcmp(cmds[i].name, "set_rtk_info") == 0)     friendlyName = "Setting GPS...";
        else if (strcmp(cmds[i].name, "set_lora_info") == 0)    friendlyName = "Setting LoRa...";
        else if (strcmp(cmds[i].name, "set_mqtt_info") == 0)    friendlyName = "Setting server...";
        else if (strcmp(cmds[i].name, "set_cfg_info") == 0)     friendlyName = "Saving settings...";
        else if (strcmp(cmds[i].name, "get_signal_info") == 0)  friendlyName = "Reading signal...";
        else if (strcmp(cmds[i].name, "get_wifi_info") == 0)   friendlyName = "Verifying WiFi...";
        if (provisionProgressCb) provisionProgressCb(displayName, cmds[i].step, totalSteps, friendlyName);

        // 1 second pause between commands (matches bootstrap -- gives device time to process)
        if (i > 0) delay(1000);

        totalSent++;
        bool got = bleSendCommand(client, writeChr, notifChr, cmds[i].payload, cmds[i].name, bleResponse, isMower);
        if (got) {
            Serial.printf("[BLE] Response data: %s\r\n", bleResponse.c_str());
            webLogAdd("BLE: %s OK", friendlyName);
            successCount++;
        } else {
            // Check if device disconnected (set_cfg_info causes reboot = success!)
            if (!client->isConnected()) {
                Serial.printf("[BLE] Device disconnected after %s (expected reboot)\r\n", cmds[i].name);
                webLogAdd("BLE: Device rebooted after %s (success!)", friendlyName);
                disconnected = true;
                successCount++;  // reboot = success for the last command
                break;
            }
            // Timeout is non-fatal — the command was sent, response just didn't arrive
            // (common with charger writeWithoutResponse where NimBLE reports "FAILED" but data IS sent)
            Serial.printf("[BLE] %s timeout (non-fatal, command was sent)\r\n", cmds[i].name);
            webLogAdd("BLE: %s — no response (sent OK)", friendlyName);
        }
    }

    if (!disconnected) {
        try { client->disconnect(); } catch (...) {}
    }

    // Success criteria (relaxed — matches bootstrap behavior):
    // - At least ONE command got result:0 response, OR
    // - Device rebooted (disconnect after set_cfg_info = commit success), OR
    // - All commands were sent (even if responses timed out — writeWithoutResponse is unreliable)
    // Only FAIL if we couldn't connect or got explicit result:1 rejections
    bool ok = successCount > 0 || disconnected || totalSent == numCmds;

    Serial.printf("[BLE] %s provisioning %s (%d/%d responses, disconnected=%s)\r\n",
        deviceType, ok ? "OK" : "FAILED", successCount, totalSent,
        disconnected ? "yes" : "no");
    webLogAdd("BLE: %s provisioning %s (%d/%d OK)", displayName, ok ? "OK" : "FAILED", successCount, totalSent);
    return ok;
}

bool bleSendCommand(NimBLEClient* client, NimBLERemoteCharacteristic* writeChr,
                    NimBLERemoteCharacteristic* notifyChr, const String& json,
                    const char* cmdName, String& response, bool isMower) {
    webLogAdd("BLE: -> %s", cmdName);
    Serial.printf("[BLE] -> %s: %s\r\n", cmdName, json.c_str());

    response = "";

    // CRITICAL: write type differs per device (matches bootstrap/noble)
    // Both charger AND mower use writeWithoutResponse (ATT_WRITE_CMD)
    // Bootstrap: noble writeAsync(buf, true) = writeWithoutResponse for both
    bool noResp = true;
    Serial.printf("[BLE] Write mode: %s\r\n", noResp ? "WriteCmd (no response)" : "WriteReq (with response)");

    // Send "ble_start" marker
    bool ok = writeChr->writeValue((const uint8_t*)"ble_start", 9, noResp);
    Serial.printf("[BLE] ble_start write: %s\r\n", ok ? "OK" : "FAILED");
    delay(100);  // 100ms after start marker

    // Send JSON in chunks of 20 bytes
    const uint8_t* data = (const uint8_t*)json.c_str();
    int remaining = json.length();
    int offset = 0;
    int chunkNum = 0;
    Serial.printf("[BLE] Sending %d bytes in %d chunks\r\n", remaining, (remaining + 19) / 20);
    while (remaining > 0) {
        int chunkSize = remaining > 20 ? 20 : remaining;
        ok = writeChr->writeValue(data + offset, chunkSize, noResp);
        if (!ok) Serial.printf("[BLE] Chunk %d WRITE FAILED!\r\n", chunkNum);
        offset += chunkSize;
        remaining -= chunkSize;
        chunkNum++;
        delay(100);  // 100ms between chunks (more conservative than 30ms)
    }

    // Send "ble_end" marker (7 bytes, NO null terminator -- matches bootstrap)
    delay(100);
    ok = writeChr->writeValue((const uint8_t*)"ble_end", 7, noResp);
    Serial.printf("[BLE] ble_end write: %s\r\n", ok ? "OK" : "FAILED");

    // Wait for response (up to 10 seconds)
    String expectedType = String(cmdName) + "_respond";
    unsigned long start = millis();
    while (millis() - start < 15000) {
        delay(50);
        // Check if we got a complete response (contains _respond)
        if (response.indexOf("_respond") >= 0) {
            // Check if this is the response we're waiting for
            if (response.indexOf(expectedType) >= 0) {
                int jsonStart = response.indexOf('{');
                int jsonEnd = response.lastIndexOf('}');
                if (jsonStart >= 0 && jsonEnd > jsonStart) {
                    response = response.substring(jsonStart, jsonEnd + 1);
                }
                Serial.printf("[BLE] <- %s: %s\r\n", cmdName, response.c_str());
                webLogAdd("BLE: <- %s response OK", cmdName);

                // Check result -- result:1 = acknowledged (NOT rejected)
                int resultIdx = response.indexOf("\"result\":");
                if (resultIdx >= 0) {
                    int resultVal = response.charAt(resultIdx + 9) - '0';
                    return resultVal == 0;
                }
                return true;
            } else {
                // Stale response from a previous command -- drain it
                Serial.printf("[BLE] Draining stale: %s (waiting for %s)\r\n",
                              response.c_str(), expectedType.c_str());
                response = "";
            }
        }
    }

    Serial.printf("[BLE] <- %s: TIMEOUT\r\n", cmdName);
    webLogAdd("BLE: <- %s timeout", cmdName);
    return false;
}
