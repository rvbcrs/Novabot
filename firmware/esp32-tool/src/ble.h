#pragma once

/**
 * ble.h — BLE scanning and provisioning for Novabot charger + mower
 */

#include <NimBLEDevice.h>

// ── BLE scan callback class ─────────────────────────────────────────────────

class ScanCallbacks : public NimBLEScanCallbacks {
    void onResult(const NimBLEAdvertisedDevice* advertisedDevice) override;
    void onScanEnd(const NimBLEScanResults& results, int reason) override;
};

// ── Public API ──────────────────────────────────────────────────────────────

void startBleScan();
bool provisionDevice(NimBLEAdvertisedDevice* device, const char* deviceType);
bool bleSendCommand(NimBLEClient* client, NimBLERemoteCharacteristic* writeChr,
                    NimBLERemoteCharacteristic* notifyChr, const String& json,
                    const char* cmdName, String& response, bool isMower = false);
