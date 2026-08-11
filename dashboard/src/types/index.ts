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
  mowerIp?: string | null;
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

/** Local meter coordinates (charger = 0,0) */
export interface LocalPoint { x: number; y: number }

/** GPS coordinates */
export interface GpsPoint { lat: number; lng: number }

export interface MapData {
  mapId: string;
  mapName: string | null;
  mapType: 'work' | 'obstacle' | 'unicom';
  mapArea: LocalPoint[];
  mapMaxMin: { minX: number; maxX: number; minY: number; maxY: number } | null;
  createdAt: string;
  /** Firmware-canonical slot identifier (`map0`, `map0_3_obstacle`,
   *  `map0tomap1_0_unicom`, `map0tocharge_unicom`). Server sets this from
   *  file_name; needed by the dashboard to distinguish charge-route
   *  unicoms from inter-map channels in the count badge (issue #28). */
  canonicalName: string | null;
  /** Original CSV filename as stored on disk. Useful as a fallback when
   *  canonicalName couldn't be derived (legacy rows pre-auto-derive). */
  fileName: string | null;
}

/** Response from /maps/:sn includes charger GPS for local→GPS conversion */
export interface MapsResponse {
  maps: MapData[];
  chargerGps: GpsPoint | null;
  chargerOrientation: number;
  /** Charger pose in local meter frame from map_info.json charging_pose */
  chargingPose: { x: number; y: number; orientation: number } | null;
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
  chargerLat?: number | null;
  chargerLng?: number | null;
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
  alternateDirection: boolean;
  alternateStep: number;
  edgeOffset: number;
  /** Weekdagen [0-6] waarop na de maaibeurt een randmaai volgt; null = geen. */
  edgeDays: number[] | null;
  rainPause: boolean;
  rainThresholdMm: number;
  rainThresholdProbability: number;
  rainCheckHours: number;
  lastTriggeredAt: string | null;
  /** YYYY-MM-DD van de dag die overgeslagen wordt; zelf-wissend na de skip. */
  skipDate?: string | null;
  /** Richting die de volgende run echt gebruikt (base + rotatie). */
  nextPathDirection?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkRecord {
  recordId: string;
  dateTime: string | null;
  workTime: number | null;
  workArea: number | null;
  cutGrassHeight: number | null;
  mapNames: string | null;
  workStatus: string | null;
  startWay: string | null;
  workRecordDate: string;
}

export interface SignalHistoryPoint {
  ts: string;
  battery: number | null;
  wifiRssi: number | null;
  rtkSat: number | null;
  locQuality: number | null;
  cpuTemp: number | null;
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

export interface BleLogEntry {
  ts: number;
  type: 'advertisement' | 'connect' | 'disconnect' | 'write' | 'notify' | 'read' | 'error';
  deviceName: string;
  mac: string;
  rssi: number;
  service?: string;
  characteristic?: string;
  data?: string;
  direction?: '\u2192DEV' | '\u2190DEV' | '';
}
