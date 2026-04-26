/**
 * Shared types for the OpenNova React Native app.
 */

export type MowerActivity =
  | 'idle'
  | 'mowing'
  | 'edge_cutting'
  | 'returning'
  | 'charging'
  | 'error'
  | 'paused'
  | 'mapping';

export interface DeviceState {
  sn: string;
  deviceType: 'charger' | 'mower';
  online: boolean;
  sensors: Record<string, string>;
  lastUpdate: number;
  nickname?: string | null;
  mowerIp?: string | null;
  firmwareVersion?: string | null;
  /**
   * BLE MAC address from server's equipment table. Used by MappingScreen
   * to filter BLE scan results so the joystick connects to the ACTIVE mower
   * (not whichever mower advertises first when 2+ are within range).
   * Null on iOS where `device.id` is an anonymous per-app UUID rather than
   * the real MAC — see ble-scan-sn-identification.md memory.
   */
  macAddress?: string | null;
}

export interface MowerStatus {
  sn: string;
  online: boolean;
  activity: MowerActivity;
  battery: number;
  batteryCharging: boolean;
  wifiRssi: string | undefined;
  rtkSat: string | undefined;
  errorStatus: string | undefined;
  errorCode: string | undefined;
  errorMsg: string | undefined;
  hasError: boolean;
}

export interface Equipment {
  sn: string;
  deviceType: string;
  chargerSn: string | null;
  mowerSn: string | null;
  userId: number;
  sysVersion: string | null;
}

export interface LoginResponse {
  success: boolean;
  code: number;
  value: {
    accessToken: string;
    appUserId: number;
    email: string;
    phone?: string;
    firstName?: string;
    lastName?: string;
    newUserFlag?: number;
  } | null;
  message?: string;
}

export interface RegisterResponse {
  success: boolean;
  code: number;
  value: {
    appUserId: number;
    email: string;
    token: string;
  } | null;
  message?: string;
}

export interface EquipmentListResponse {
  success: boolean;
  code: number;
  value: Equipment[] | null;
  message?: string;
}

export interface DeviceUpdateEvent {
  sn: string;
  fields: Record<string, string>;
  timestamp: number;
}

export interface DeviceOnlineEvent {
  sn: string;
  deviceType: string;
  online: boolean;
}

export interface SnapshotDevice {
  sn: string;
  deviceType: string;
  online: boolean;
  sensors: Record<string, string>;
  nickname?: string | null;
  firmwareVersion?: string | null;
  macAddress?: string | null;
}
