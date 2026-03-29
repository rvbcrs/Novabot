/**
 * Shared types for the OpenNova React Native app.
 */

export type MowerActivity =
  | 'idle'
  | 'mowing'
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
}
