export interface SensorDef {
  field: string;
  name: string;
  component: 'sensor' | 'binary_sensor';
  device_class?: string;
  state_class?: string;
  unit?: string;
  icon?: string;
  entity_category?: string;
}

export interface DeviceState {
  sn: string;
  deviceType: 'charger' | 'mower';
  online: boolean;
  nickname?: string | null;
  macAddress?: string | null;
  lastSeen?: string | null;
  sensors: Record<string, string>;
  lastUpdate: number;
}

export interface DeviceUpdateEvent {
  sn: string;
  fields: Record<string, string>;
  timestamp: number;
}

export interface DeviceOnlineEvent {
  sn: string;
  timestamp: number;
}

export interface MapData {
  mapId: string;
  mapName: string | null;
  mapType: 'work' | 'obstacle' | 'unicom';
  mapArea: Array<{ lat: number; lng: number }>;
  mapMaxMin: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null;
  createdAt: string;
}

export interface TrailPoint {
  lat: number;
  lng: number;
  ts: number;
}

export interface MapCalibration {
  offsetLat: number;
  offsetLng: number;
  rotation: number;
  scale: number;
}

export interface Schedule {
  scheduleId: string;
  mowerSn: string;
  scheduleName: string | null;
  startTime: string;
  endTime: string | null;
  weekdays: number[];
  enabled: boolean;
  mapId: string | null;
  mapName: string | null;
  cuttingHeight: number;
  pathDirection: number;
  workMode: number;
  taskMode: number;
  createdAt: string;
  updatedAt: string;
}

export interface MqttLogEntry {
  ts: number;
  type: 'connect' | 'disconnect' | 'subscribe' | 'publish' | 'error';
  clientId: string;
  clientType: 'APP' | 'DEV' | '?';
  sn: string | null;
  direction: '→DEV' | '←DEV' | '';
  topic: string;
  payload: string;
  encrypted: boolean;
}
