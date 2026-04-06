import type { ScannedDevice } from '../services/ble';

// ── Auth Stack (Login/Register) ──────────────────────────────────────────────

export type AuthStackParams = {
  Login: undefined;
  Register: undefined;
};

// ── Provision Stack (BLE provisioning flow) ──────────────────────────────────

export type ProvisionStackParams = {
  Settings: undefined;
  DeviceChoice: { mqttAddr: string; mqttPort: number };
  Wifi: {
    mqttAddr: string;
    mqttPort: number;
    deviceMode: 'charger' | 'mower' | 'both';
  };
  BleScan: {
    mqttAddr: string;
    mqttPort: number;
    deviceMode: 'charger' | 'mower' | 'both';
    wifiSsid: string;
    wifiPassword: string;
  };
  Provision: {
    mqttAddr: string;
    mqttPort: number;
    deviceMode: 'charger' | 'mower' | 'both';
    wifiSsid: string;
    wifiPassword: string;
    devices: ScannedDevice[];
  };
};

/**
 * @deprecated Use ProvisionStackParams instead. Kept for backward compatibility
 * with existing provisioning screens.
 */
export type RootStackParams = ProvisionStackParams;

// ── Main Tab Navigator ───────────────────────────────────────────────────────

export type MainTabParams = {
  Home: undefined;
  Map: undefined;
  Control: undefined;
  Camera: undefined;
  Schedules: undefined;
  History: undefined;
  AppSettings: undefined;
  ProvisionTab: undefined;
  Messages: undefined;
};

// ── Settings Stack (nested in Settings tab) ─────────────────────────

export type SettingsStackParams = {
  SettingsMain: undefined;
  OTA: undefined;
  MowerSettings: undefined;
  Mapping: undefined;
  ProvisionFlow: undefined;
};
