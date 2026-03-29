import type { ScannedDevice } from '../services/ble';

export type RootStackParams = {
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
