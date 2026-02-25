/**
 * Gedeelde sensor definities, waarde-vertalingen en data cache.
 *
 * Wordt gebruikt door zowel de Home Assistant bridge (homeassistant.ts)
 * als het dashboard (socketHandler.ts). Eén keer updateDeviceData()
 * aanroepen per inkomend MQTT bericht vanuit broker.ts.
 */

// ── Sensor definities ────────────────────────────────────────────

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

export const SENSORS: SensorDef[] = [
  // ── Charger velden (uit up_status_info, plain JSON) ──────────
  { field: 'charger_status',   name: 'Charger Status',    component: 'sensor', icon: 'mdi:ev-station',           entity_category: 'diagnostic' },

  // Mower velden (gerapporteerd door charger via LoRa → up_status_info)
  { field: 'mower_status',     name: 'Mower Status',      component: 'sensor', icon: 'mdi:robot-mower' },
  { field: 'mower_x',          name: 'Mower Position X',  component: 'sensor', icon: 'mdi:map-marker',           entity_category: 'diagnostic' },
  { field: 'mower_y',          name: 'Mower Position Y',  component: 'sensor', icon: 'mdi:map-marker',           entity_category: 'diagnostic' },
  { field: 'mower_z',          name: 'Mower Position Z',  component: 'sensor', icon: 'mdi:map-marker',           entity_category: 'diagnostic' },
  { field: 'mower_info',       name: 'Mower Info',        component: 'sensor', icon: 'mdi:information-outline',  entity_category: 'diagnostic' },
  { field: 'mower_info1',      name: 'Mower Info 1',      component: 'sensor', icon: 'mdi:information-outline',  entity_category: 'diagnostic' },
  { field: 'mower_error',      name: 'LoRa Search Count', component: 'sensor', icon: 'mdi:alert-circle',         entity_category: 'diagnostic' },

  // Batterij (charger report)
  { field: 'battery_capacity', name: 'Battery',           component: 'sensor', icon: 'mdi:battery', device_class: 'battery', state_class: 'measurement', unit: '%' },

  // Werk status (charger report)
  { field: 'work_mode',        name: 'Work Mode',         component: 'sensor', icon: 'mdi:cog' },
  { field: 'work_state',       name: 'Work State',        component: 'sensor', icon: 'mdi:state-machine' },
  { field: 'work_status',      name: 'Work Status',       component: 'sensor', icon: 'mdi:progress-wrench' },
  { field: 'task_mode',        name: 'Task Mode',         component: 'sensor', icon: 'mdi:clipboard-list' },
  { field: 'recharge_status',  name: 'Recharge Status',   component: 'sensor', icon: 'mdi:battery-charging' },
  { field: 'mowing_progress',  name: 'Mowing Progress',   component: 'sensor', icon: 'mdi:percent', state_class: 'measurement', unit: '%' },

  // Fout info (charger report)
  { field: 'error_code',       name: 'Error Code',        component: 'sensor', icon: 'mdi:alert',                entity_category: 'diagnostic' },
  { field: 'error_msg',        name: 'Error Message',     component: 'sensor', icon: 'mdi:alert-circle-outline', entity_category: 'diagnostic' },
  { field: 'error_status',     name: 'Error Status',      component: 'sensor', icon: 'mdi:alert-outline',        entity_category: 'diagnostic' },

  // GPS (charger report)
  { field: 'latitude',         name: 'Latitude',          component: 'sensor', icon: 'mdi:crosshairs-gps',       entity_category: 'diagnostic' },
  { field: 'longitude',        name: 'Longitude',         component: 'sensor', icon: 'mdi:crosshairs-gps',       entity_category: 'diagnostic' },

  // ── Maaier directe sensoren (uit AES-ontsleutelde MQTT berichten) ──

  // report_state_robot
  { field: 'battery_power',    name: 'Battery',           component: 'sensor', icon: 'mdi:battery', device_class: 'battery', state_class: 'measurement', unit: '%' },
  { field: 'battery_state',    name: 'Battery State',     component: 'sensor', icon: 'mdi:battery-charging' },
  { field: 'cpu_temperature',  name: 'CPU Temperature',   component: 'sensor', icon: 'mdi:thermometer', device_class: 'temperature', state_class: 'measurement', unit: '°C' },
  { field: 'sw_version',       name: 'Firmware Version',  component: 'sensor', icon: 'mdi:tag',                  entity_category: 'diagnostic' },
  { field: 'loc_quality',      name: 'Location Quality',  component: 'sensor', icon: 'mdi:crosshairs-gps', state_class: 'measurement', unit: '%' },
  { field: 'mow_blade_work_time', name: 'Blade Work Time', component: 'sensor', icon: 'mdi:fan', device_class: 'duration', state_class: 'total_increasing', unit: 's' },
  { field: 'mow_speed',        name: 'Mow Speed',         component: 'sensor', icon: 'mdi:speedometer', state_class: 'measurement' },
  { field: 'working_hours',    name: 'Working Hours',     component: 'sensor', icon: 'mdi:timer', device_class: 'duration', state_class: 'total_increasing', unit: 'h' },
  { field: 'covering_area',    name: 'Covering Area',     component: 'sensor', icon: 'mdi:texture-box', state_class: 'measurement' },
  { field: 'finished_area',    name: 'Finished Area',     component: 'sensor', icon: 'mdi:check-decagram', state_class: 'measurement' },
  { field: 'cov_direction',    name: 'Mow Direction',     component: 'sensor', icon: 'mdi:compass', state_class: 'measurement', unit: '°' },
  { field: 'path_direction',   name: 'Path Direction',    component: 'sensor', icon: 'mdi:compass-outline', state_class: 'measurement', unit: '°' },
  { field: 'x',                name: 'Position X',        component: 'sensor', icon: 'mdi:map-marker',           entity_category: 'diagnostic' },
  { field: 'y',                name: 'Position Y',        component: 'sensor', icon: 'mdi:map-marker',           entity_category: 'diagnostic' },
  { field: 'z',                name: 'Position Z',        component: 'sensor', icon: 'mdi:map-marker',           entity_category: 'diagnostic' },
  { field: 'ota_state',        name: 'OTA State',         component: 'sensor', icon: 'mdi:update',               entity_category: 'diagnostic' },
  { field: 'prev_state',       name: 'Previous State',    component: 'sensor', icon: 'mdi:history',              entity_category: 'diagnostic' },
  { field: 'current_map_id',   name: 'Current Map',       component: 'sensor', icon: 'mdi:map',                  entity_category: 'diagnostic' },

  // report_exception_state
  { field: 'button_stop',      name: 'Emergency Stop',    component: 'binary_sensor', device_class: 'safety', icon: 'mdi:stop-circle' },
  { field: 'chassis_err',      name: 'Chassis Error',     component: 'sensor', icon: 'mdi:car-wrench',           entity_category: 'diagnostic' },
  { field: 'rtk_sat',          name: 'RTK Satellites',    component: 'sensor', icon: 'mdi:satellite-variant', state_class: 'measurement' },
  { field: 'wifi_rssi',        name: 'WiFi Signal',       component: 'sensor', icon: 'mdi:wifi', device_class: 'signal_strength', state_class: 'measurement', unit: 'dBm' },

  // report_state_timer_data
  { field: 'localization_state', name: 'Localization',    component: 'sensor', icon: 'mdi:crosshairs-question' },
];

// Commando's die geneste data-objecten bevatten die we willen verwerken
export const DATA_COMMANDS = [
  'up_status_info',          // Charger → plain JSON
  'report_state_robot',      // Maaier → AES ontsleuteld
  'report_exception_state',  // Maaier → AES ontsleuteld
  'report_state_timer_data', // Maaier → AES ontsleuteld
];

// ── Waarde vertalingen ────────────────────────────────────────────

const MOWER_STATUS_MAP: Record<string, string> = {
  'backingCharger':    'Returning to charger',
  'backedCharger':     'At charger',
  'pauseAndCharging':  'Paused & charging',
  'gotoCharging':      'Going to charger',
  'startMowing':       'Mowing',
  'startMapping':      'Mapping',
  'noMowingUncharged': 'Low battery',
};

function translateChargerStatus(raw: number): string {
  if (raw === 0) return 'Idle';
  if ((raw & 0x0101) === 0x0101) return 'Operational';
  return String(raw);
}

function translateMowerError(raw: number): string {
  if (raw === 0) return 'OK';
  if (raw >= 1) return `Searching mower (${raw})`;
  return String(raw);
}

function translateBatteryState(raw: string): string {
  switch (raw) {
    case 'CHARGING': return 'Charging';
    case 'NOT_CHARGING': return 'Not charging';
    case 'DISCHARGING': return 'Discharging';
    case 'FULL': return 'Full';
    default: return raw;
  }
}

function translateLocalization(raw: string): string {
  switch (raw) {
    case 'NOT_INITIALIZED': return 'Not initialized';
    case 'INITIALIZING': return 'Initializing';
    case 'INITIALIZED': return 'Initialized';
    case 'LOST': return 'Lost';
    default: return raw;
  }
}

export function translateValue(field: string, rawValue: string): string {
  switch (field) {
    case 'charger_status': {
      const n = parseInt(rawValue, 10);
      return isNaN(n) ? rawValue : translateChargerStatus(n);
    }
    case 'mower_status':
      return MOWER_STATUS_MAP[rawValue] ?? rawValue;
    case 'mower_error': {
      const n = parseInt(rawValue, 10);
      return isNaN(n) ? rawValue : translateMowerError(n);
    }
    case 'error_code': {
      const n = parseInt(rawValue, 10);
      return (isNaN(n) || n === 0) ? 'None' : rawValue;
    }
    case 'error_status': {
      const n = parseInt(rawValue, 10);
      return (isNaN(n) || n === 0) ? 'OK' : `Error (${rawValue})`;
    }
    case 'recharge_status': {
      const n = parseInt(rawValue, 10);
      if (isNaN(n)) return rawValue;
      if (n === 0) return 'Not charging';
      if (n === 1) return 'Charging';
      return `Charging (${n})`;
    }
    case 'battery_state':
      return translateBatteryState(rawValue);
    case 'localization_state':
      return translateLocalization(rawValue);
    case 'button_stop':
      return rawValue === 'true' ? 'ON' : 'OFF';
    case 'wifi_rssi': {
      const n = parseInt(rawValue, 10);
      return isNaN(n) ? rawValue : String(n > 0 ? -n : n);
    }
    default:
      return rawValue;
  }
}

// ── GPS trail ──────────────────────────────────────────────────

export interface TrailPoint {
  lat: number;
  lng: number;
  ts: number;
}

const MAX_TRAIL_POINTS = 5000;
const gpsTrails = new Map<string, TrailPoint[]>();

function appendTrailPoint(sn: string, rawLat: string, rawLng: string): void {
  const lat = parseFloat(rawLat);
  const lng = parseFloat(rawLng);
  if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) return;

  if (!gpsTrails.has(sn)) gpsTrails.set(sn, []);
  const trail = gpsTrails.get(sn)!;

  // Dedup: sla over als laatste punt (bijna) identiek is
  if (trail.length > 0) {
    const last = trail[trail.length - 1];
    if (Math.abs(last.lat - lat) < 0.0000005 && Math.abs(last.lng - lng) < 0.0000005) return;
  }

  trail.push({ lat, lng, ts: Date.now() });
  if (trail.length > MAX_TRAIL_POINTS) trail.splice(0, trail.length - MAX_TRAIL_POINTS);
}

export function getGpsTrail(sn: string): TrailPoint[] {
  return gpsTrails.get(sn) ?? [];
}

export function clearGpsTrail(sn: string): void {
  gpsTrails.delete(sn);
}

// ── Data cache ──────────────────────────────────────────────────

// Cache van laatst bekende waarden per SN per veld (ruwe waarde)
export const deviceCache = new Map<string, Map<string, string>>();

/**
 * Verwerk een inkomend MQTT bericht en update de cache.
 * Retourneert een Map van alleen de gewijzigde velden met hun vertaalde waarden,
 * of null als het bericht niet verwerkt kon worden.
 */
export function updateDeviceData(sn: string, payload: Buffer): Map<string, string> | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload.toString());
  } catch {
    return null;
  }

  const commandName = Object.keys(parsed)[0];
  if (!commandName || !DATA_COMMANDS.includes(commandName)) return null;

  const data = parsed[commandName];
  if (typeof data !== 'object' || data === null) return null;

  if (!deviceCache.has(sn)) deviceCache.set(sn, new Map());
  const snValues = deviceCache.get(sn)!;

  const changes = new Map<string, string>();

  for (const [field, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue; // skip arrays/objects (bijv. timer_task)

    const strValue = String(value);
    if (snValues.get(field) === strValue) continue; // ongewijzigd

    snValues.set(field, strValue);
    changes.set(field, translateValue(field, strValue));
  }

  // Append GPS trail als lat of lng gewijzigd zijn
  if (changes.has('latitude') || changes.has('longitude')) {
    const lat = snValues.get('latitude');
    const lng = snValues.get('longitude');
    if (lat && lng) appendTrailPoint(sn, lat, lng);
  }

  return changes.size > 0 ? changes : null;
}

/**
 * Haal de volledige gecachte state op voor één device (vertaalde waarden).
 */
export function getDeviceSnapshot(sn: string): Record<string, string> | null {
  const snValues = deviceCache.get(sn);
  if (!snValues) return null;

  const result: Record<string, string> = {};
  for (const [field, rawValue] of snValues) {
    result[field] = translateValue(field, rawValue);
  }
  return result;
}

/**
 * Haal alle devices op met hun gecachte state (vertaalde waarden).
 */
export function getAllDeviceSnapshots(): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const [sn] of deviceCache) {
    const snapshot = getDeviceSnapshot(sn);
    if (snapshot) result[sn] = snapshot;
  }
  return result;
}

/**
 * Haal het ruwe commando naam + data op uit een payload (voor raw topic publishing).
 */
export function parseCommand(payload: Buffer): { command: string; data: unknown } | null {
  try {
    const parsed = JSON.parse(payload.toString());
    const command = Object.keys(parsed)[0];
    if (!command) return null;
    return { command, data: parsed[command] };
  } catch {
    return null;
  }
}
