/**
 * Gedeelde sensor definities, waarde-vertalingen en data cache.
 *
 * Wordt gebruikt door zowel de Home Assistant bridge (homeassistant.ts)
 * als het dashboard (socketHandler.ts). Eén keer updateDeviceData()
 * aanroepen per inkomend MQTT bericht vanuit broker.ts.
 */

import { db } from '../db/database.js';

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

  // get_para_info_respond — mower settings
  { field: 'obstacle_avoidance_sensitivity', name: 'Obstacle Sensitivity', component: 'sensor', icon: 'mdi:shield-alert',     entity_category: 'config' },
  { field: 'manual_controller_v',            name: 'Max Speed Setting',    component: 'sensor', icon: 'mdi:speedometer',      entity_category: 'config' },
  { field: 'manual_controller_w',            name: 'Handling Setting',     component: 'sensor', icon: 'mdi:steering',         entity_category: 'config' },
  { field: 'sound',                          name: 'Sound',                component: 'sensor', icon: 'mdi:volume-high',      entity_category: 'config' },
  { field: 'headlight',                      name: 'Headlight',            component: 'sensor', icon: 'mdi:car-light-high',   entity_category: 'config' },

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
  'up_status_info',           // Charger → plain JSON
  'report_state_robot',       // Maaier → AES ontsleuteld
  'report_exception_state',   // Maaier → AES ontsleuteld
  'report_state_timer_data',  // Maaier → AES ontsleuteld
  'ota_version_info_respond', // Charger/Maaier → huidige firmware versie
  'get_para_info_respond',    // Maaier → headlight, sound, path_direction etc.
  'report_state_to_server_work_respond', // Maaier → server-only status met sv/hv/ov versies
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

/**
 * Wis alle gecachte sensor data voor een apparaat (bij disconnect).
 * Hierdoor toont het dashboard geen stale waarden voor offline apparaten.
 */
export function clearDeviceData(sn: string): void {
  deviceCache.delete(sn);
}

// ── Signal history sampling ──────────────────────────────────────

const SAMPLE_INTERVAL_MS = 30_000; // 30 seconden
const lastSampleTime = new Map<string, number>();

const signalHistoryInsert = db.prepare(`
  INSERT INTO signal_history (sn, battery, wifi_rssi, rtk_sat, loc_quality, cpu_temp)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function sampleSignalHistory(sn: string, snValues: Map<string, string>): void {
  const now = Date.now();
  const last = lastSampleTime.get(sn) ?? 0;
  if (now - last < SAMPLE_INTERVAL_MS) return;

  // Alleen samplen als er minstens één relevant signaal veld is
  const battery = parseInt(snValues.get('battery_power') ?? snValues.get('battery_capacity') ?? '', 10);
  const wifiRssi = parseInt(snValues.get('wifi_rssi') ?? '', 10);
  const rtkSat = parseInt(snValues.get('rtk_sat') ?? '', 10);
  const locQuality = parseInt(snValues.get('loc_quality') ?? '', 10);
  const cpuTemp = parseInt(snValues.get('cpu_temperature') ?? '', 10);

  if (isNaN(battery) && isNaN(wifiRssi) && isNaN(rtkSat) && isNaN(locQuality) && isNaN(cpuTemp)) return;

  try {
    signalHistoryInsert.run(
      sn,
      isNaN(battery) ? null : battery,
      isNaN(wifiRssi) ? null : wifiRssi,
      isNaN(rtkSat) ? null : rtkSat,
      isNaN(locQuality) ? null : locQuality,
      isNaN(cpuTemp) ? null : cpuTemp,
    );
    lastSampleTime.set(sn, now);
  } catch {
    // DB write failure — skip silently
  }
}

/** Verwijder signal_history records ouder dan 7 dagen. Roep aan bij server start. */
export function cleanupSignalHistory(): void {
  try {
    const result = db.prepare("DELETE FROM signal_history WHERE ts < datetime('now', '-7 days')").run();
    if (result.changes > 0) {
      console.log(`[SIGNAL] Cleaned up ${result.changes} old signal_history records`);
    }
  } catch {
    // ignore
  }
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

  // Detecteer commando naam — twee formaten:
  // Maaier:  {"report_state_robot":{...}}   → key = "report_state_robot"
  // Charger: {"type":"ota_version_info_respond","message":{...}} → type wrapper
  let commandName = Object.keys(parsed)[0];
  let data = parsed[commandName];

  // Type-wrapper normalisatie (charger + maaier server berichten)
  // Formaat: {"type":"command_name","message":{...}} of {"message":{...},"type":"command_name"}
  if (typeof parsed.type === 'string' && parsed.message != null && !DATA_COMMANDS.includes(commandName)) {
    commandName = parsed.type as string;
    data = parsed.message;
  }

  if (!commandName || !DATA_COMMANDS.includes(commandName)) return null;
  if (typeof data !== 'object' || data === null) return null;

  // Voor ota_version_info_respond: versie zit in message.value.version
  if (commandName === 'ota_version_info_respond' && typeof (data as Record<string, unknown>).value === 'object') {
    data = (data as Record<string, unknown>).value;
  }

  // Voor get_para_info_respond: waarden kunnen in meerdere formaten zitten
  // NB: maaier reageert momenteel NIET op get_para_info — settings worden
  // lokaal bijgehouden via set_para_info cache in dashboard.ts.
  // Parser blijft als fallback voor het geval firmware dit later wel stuurt.
  if (commandName === 'get_para_info_respond') {
    const d = data as Record<string, unknown>;
    if (typeof d.message === 'object' && d.message !== null && typeof (d.message as Record<string, unknown>).value === 'object') {
      data = (d.message as Record<string, unknown>).value;
    } else if (typeof d.value === 'object' && d.value !== null) {
      data = d.value;
    }
  }

  // Voor report_state_to_server_work_respond: waarden zitten in value, en sv/hv/ov moeten gemapt worden
  if (commandName === 'report_state_to_server_work_respond' && typeof (data as Record<string, unknown>).value === 'object') {
    const raw = (data as Record<string, unknown>).value as Record<string, unknown>;
    // Map afkortingen naar volledige sensor namen
    const mapped: Record<string, unknown> = { ...raw };
    if (raw.sv !== undefined) { mapped.sw_version = raw.sv; delete mapped.sv; }
    if (raw.hv !== undefined) { mapped.hw_version = raw.hv; delete mapped.hv; }
    if (raw.ov !== undefined) { mapped.os_version = raw.ov; delete mapped.ov; }
    data = mapped;
  }

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

  // Extraheer geneste GPS data uit report_state_timer_data → localization.gps_position
  const dataObj = data as Record<string, unknown>;
  if (commandName === 'report_state_timer_data' && typeof dataObj.localization === 'object' && dataObj.localization !== null) {
    const loc = dataObj.localization as Record<string, unknown>;
    // GPS positie
    if (typeof loc.gps_position === 'object' && loc.gps_position !== null) {
      const gps = loc.gps_position as Record<string, unknown>;
      for (const gpsField of ['latitude', 'longitude', 'altitude'] as const) {
        if (gps[gpsField] !== undefined && gps[gpsField] !== null) {
          const strValue = String(gps[gpsField]);
          if (snValues.get(gpsField) !== strValue) {
            snValues.set(gpsField, strValue);
            changes.set(gpsField, translateValue(gpsField, strValue));
          }
        }
      }
      // GPS state (ENABLE/DISABLE) — opslaan als 'gps_state' om conflict met andere 'state' velden te voorkomen
      if (gps.state !== undefined && gps.state !== null) {
        const strValue = String(gps.state);
        if (snValues.get('gps_state') !== strValue) {
          snValues.set('gps_state', strValue);
          changes.set('gps_state', translateValue('gps_state', strValue));
        }
      }
    }
    // Localization state
    if (typeof loc.localization_state === 'string') {
      const field = 'localization_state';
      if (snValues.get(field) !== loc.localization_state) {
        snValues.set(field, loc.localization_state);
        changes.set(field, translateValue(field, loc.localization_state));
      }
    }
  }

  // Extraheer virtuele sensorvelden uit charger_status bitfield
  if (changes.has('charger_status')) {
    const raw = parseInt(snValues.get('charger_status') ?? '0', 10);
    if (!isNaN(raw)) {
      const gpsSats = String((raw >> 24) & 0xFF);
      const gpsValid = (raw & 0x01) !== 0 ? '1' : '0';
      const rtkOk = (raw & 0x100) !== 0 ? '1' : '0';
      for (const [vf, vv] of [['gps_satellites', gpsSats], ['gps_valid', gpsValid], ['rtk_ok', rtkOk]] as const) {
        if (snValues.get(vf) !== vv) {
          snValues.set(vf, vv);
          changes.set(vf, vv);
        }
      }
    }
  }

  // Append GPS trail als lat of lng gewijzigd zijn
  if (changes.has('latitude') || changes.has('longitude')) {
    const lat = snValues.get('latitude');
    const lng = snValues.get('longitude');
    if (lat && lng) appendTrailPoint(sn, lat, lng);
  }

  // Sample signal history elke 30s
  if (changes.size > 0) {
    sampleSignalHistory(sn, snValues);
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
