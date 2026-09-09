/**
 * Gedeelde sensor definities, waarde-vertalingen en data cache.
 *
 * Wordt gebruikt door zowel de Home Assistant bridge (homeassistant.ts)
 * als het dashboard (socketHandler.ts). Eén keer updateDeviceData()
 * aanroepen per inkomend MQTT bericht vanuit broker.ts.
 */

import { spawn } from 'node:child_process';
import { db } from '../db/database.js';
import { equipmentRepo } from '../db/repositories/equipment.js';
import { scheduleRepo } from '../db/repositories/schedules.js';
import { detectAndDispatch, resetEventState } from '../notifications/eventDetector.js';
import { isFrameUnvalidated, noteDockState } from '../services/frameValidation.js';
import { resolveMowerIp } from '../services/mowerIpDiscovery.js';
import { isSimulatedStock, SIMULATED_STOCK_VERSION } from '../services/mowerFileCapability.js';
import { emitDebugPosJson } from '../dashboard/socketHandler.js';

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
  { field: 'msg',              name: 'Status Message',    component: 'sensor', icon: 'mdi:message-text',       entity_category: 'diagnostic' },
  { field: 'plan_path',        name: 'Plan Path',         component: 'sensor', icon: 'mdi:map-marker-path',    entity_category: 'diagnostic' },
  { field: 'cov_ratio',        name: 'Coverage Ratio',    component: 'sensor', icon: 'mdi:percent', state_class: 'measurement', unit: '%' },
  { field: 'cov_area',         name: 'Coverage Area',     component: 'sensor', icon: 'mdi:texture-box', state_class: 'measurement', unit: 'm²' },
  { field: 'cov_work_time',    name: 'Coverage Work Time', component: 'sensor', icon: 'mdi:timer', state_class: 'measurement', unit: 's' },
  { field: 'cov_estimate_time',name: 'Coverage Estimated Remaining', component: 'sensor', icon: 'mdi:timer-sand', state_class: 'measurement', unit: 'min' },
  { field: 'cov_remaining_area', name: 'Coverage Remaining Area', component: 'sensor', icon: 'mdi:texture-box', state_class: 'measurement', unit: 'm²' },
  { field: 'valid_cov_work_time', name: 'Valid Coverage Work Time', component: 'sensor', icon: 'mdi:timer-check', state_class: 'measurement', unit: 'min', entity_category: 'diagnostic' },
  { field: 'cpu_temperature',  name: 'CPU Temperature',   component: 'sensor', icon: 'mdi:thermometer', device_class: 'temperature', state_class: 'measurement', unit: '°C' },
  { field: 'sw_version',       name: 'Firmware Version',  component: 'sensor', icon: 'mdi:tag',                  entity_category: 'diagnostic' },
  { field: 'loc_quality',      name: 'Location Quality',  component: 'sensor', icon: 'mdi:crosshairs-gps', state_class: 'measurement', unit: '%' },
  { field: 'mow_blade_work_time', name: 'Blade Work Time', component: 'sensor', icon: 'mdi:fan', device_class: 'duration', state_class: 'total_increasing', unit: 's' },
  // Blade RPM relayed by extended_commands.py from /blade_speed_get ROS topic.
  // Lets the OpenNova app distinguish 'cutting' from 'driving without blades'.
  { field: 'blade_speed',      name: 'Blade RPM',         component: 'sensor', icon: 'mdi:saw-blade', state_class: 'measurement', unit: 'rpm' },
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

  // Cover path voortgang (uit report_state_timer_data.cover_path.covered).
  // finished_area = space-separated indices van voltooide planned_path
  // sub-gebieden; covering_area_id = sub-gebied dat nu gemaaid wordt.
  // Deze state leeft op de maaier en overleeft app-restart: elke MQTT tick
  // bevat de actuele stand.
  { field: 'cover_map_id',          name: 'Cover Map ID',          component: 'sensor', icon: 'mdi:map-marker', entity_category: 'diagnostic' },
  { field: 'finished_area',         name: 'Finished Sub-Areas',    component: 'sensor', icon: 'mdi:check-all', entity_category: 'diagnostic' },
  { field: 'covering_area_id',      name: 'Current Sub-Area',      component: 'sensor', icon: 'mdi:target', entity_category: 'diagnostic' },
  { field: 'covering_area_points',  name: 'Current Sub-Area Pts',  component: 'sensor', icon: 'mdi:dots-horizontal', entity_category: 'diagnostic' },
  { field: 'covering_points',       name: 'Recent Cover Segment',  component: 'sensor', icon: 'mdi:vector-polyline', entity_category: 'diagnostic' },
  { field: 'missed_points',         name: 'Missed Points',         component: 'sensor', icon: 'mdi:map-marker-question', entity_category: 'diagnostic' },
];

// Commando's die geneste data-objecten bevatten die we willen verwerken
export const DATA_COMMANDS = [
  'up_status_info',           // Charger → plain JSON
  'report_state_robot',       // Maaier → AES ontsleuteld
  'report_exception_state',   // Maaier → AES ontsleuteld
  'report_state_timer_data',  // Maaier → AES ontsleuteld
  'ota_version_info_respond', // Charger/Maaier → huidige firmware versie
  'get_para_info_respond',    // Maaier → headlight, sound, path_direction etc.
  'get_wifi_rssi_respond',    // Maaier → expliciet ververste WiFi RSSI
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

// The charger relays the mower's status over LoRa as a uint32 LE that packs four
// bytes: derived_mode | task_mode<<8 | work_status<<16 | recharge_status<<24
// (mower chassis_control_node robot_status_cb → STM32 → LoRa bytes 7-10, copied
// verbatim by the charger). work_status (byte 2) is the informative one. These
// numeric values are from the robot_decision binary's WorkStatusString() jump
// table (Ghidra-verified) — NOT the wrong values in mower/state_machine.py.
const WORK_STATUS_NUM: Record<number, string> = {
  0: 'Wait', 1: 'Failed', 2: 'Cancelled', 7: 'Failed', 8: 'Finished', 9: 'Finished',
  10: 'User stop', 11: 'Sent to charge', 12: 'Low-battery stop', 13: 'Error stop',
  14: 'Time-limit stop', 15: 'Recover error', 49: 'Resuming', 50: 'Return to charger',
  51: 'Aligning dock', 53: 'Sensor init', 54: 'UTM init', 55: 'Localization init',
  56: 'Undocking', 57: 'System check', 59: 'Init done', 61: 'Loc-error recover',
  62: 'LoRa-error recover', 63: 'Slip recover', 64: 'Out-of-map recover',
  90: 'Mowing', 91: 'Avoiding', 92: 'Moving', 93: 'Edge cutting', 94: 'Coverage gap',
  130: 'Mapping zone', 131: 'Mapping obstacle', 132: 'Mapping corridor',
  133: 'Mapping corridor→dock', 134: 'Setting dock', 135: 'Deleting sub-map',
  136: 'Deleting obstacle', 137: 'Deleting corridor', 138: 'Auto-erase',
  139: 'Auto-erase failed', 140: 'Auto-erase done', 141: 'Assisted mapping zone',
  142: 'Assisted mapping obstacle', 143: 'Map edit', 169: 'Stop recording',
  191: 'Return to charger', 192: 'Visual docking', 193: 'Aligning dock',
};
const DERIVED_MODE_NUM: Record<number, string> = {
  0: 'Idle', 1: 'Mapping', 2: 'Mowing', 5: 'Recharging', 7: 'Fault',
};

function translateMowerStatus(raw: number): string {
  const work = (raw >>> 16) & 0xff;
  const mode = raw & 0xff;
  return WORK_STATUS_NUM[work] ?? DERIVED_MODE_NUM[mode] ?? String(raw);
}

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

// WorkStatus enum mapping — mirrors state_machine.WorkStatus in mower/.
// Published as numeric int in RobotStatus.work_status. Display in HA needs
// human-readable labels because raw values like 9 / 100 / 150 are opaque.
// Decoded 1:1 from the firmware function robot_status::WorkStatusString(uint8)
// in the robot_decision binary (a 194-entry jump table). This is the AUTHORITATIVE
// source for the work_status code the mower reports; the previous table conflicted
// with the firmware (e.g. 10/50/51 meant something else, and 100-250 are never
// emitted). Codes not listed here are not produced by the firmware (they fall
// through to the default "State N"). 0 decodes to a partial inline string, so we
// keep the conventional 'Idle'.
const WORK_STATUS_LABELS: Record<number, string> = {
  0: 'Idle',
  1: 'Failed',
  2: 'Cancelled',
  7: 'Failed once',
  8: 'Finished once',
  9: 'Finished',
  10: 'User stopped',
  11: 'User recharge',
  12: 'Low power',
  13: 'Error stop',
  14: 'Time limit',
  15: 'Recovery error',
  49: 'Resuming',
  50: 'Start requested',
  51: 'Sensor init',
  53: 'Map init',
  54: 'UTM init',
  55: 'Localization init',
  56: 'Leaving dock',
  57: 'System check',
  59: 'Init success',
  61: 'Localization error',
  62: 'LoRa error',
  63: 'Wheels slipping',
  64: 'Out of map',
  90: 'Mowing',
  91: 'Avoiding obstacle',
  92: 'Driving',
  93: 'Edge cutting',
  94: 'Re-covering missed spots',
  130: 'Mapping work zone',
  131: 'Mapping obstacle',
  132: 'Mapping channel',
  133: 'Mapping channel to dock',
  134: 'Setting dock position',
  135: 'Deleting map',
  136: 'Deleting obstacle',
  137: 'Deleting channel',
  138: 'Auto-erasing map',
  139: 'Auto-erase failed',
  140: 'Auto-erase done',
  141: 'Auto-mapping work zone',
  142: 'Auto-mapping obstacle',
  143: 'Editing map',
  169: 'Mapping paused',
  191: 'Returning to dock',
  192: 'Searching for dock',
  193: 'Aligning dock',
};

function translateWorkStatus(raw: string): string {
  const n = parseInt(raw, 10);
  if (isNaN(n)) return raw;
  return WORK_STATUS_LABELS[n] ?? `State ${n}`;
}

// ── Mowing session timer (issue #17) ────────────────────────────────────────
// Stock v5.x firmware emits cov_work_time / valid_cov_work_time inconsistently:
// they read 0 in the cache by the time the mower POSTs saveCutGrassRecord,
// so the work-record row landed with `mowed minutes = 0`. Track sessions
// server-side from the work_status sensor stream — any active task status
// (100..150) starts/refreshes the session, and saveCutGrassRecord computes
// the duration from start → last-active when the body field is missing.

export interface MowingSession {
  startedAt: number;     // ms epoch when the SN first entered a mowing status
  lastActiveAt: number;  // ms epoch of the most recent mowing-status ping
}

const ACTIVE_MOWING_STATUSES = new Set<number>([100, 101, 102, 103, 150]);

const mowingSessions = new Map<string, MowingSession>();

function isActiveMowingStatus(value: string | null | undefined): boolean {
  if (value == null) return false;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && ACTIVE_MOWING_STATUSES.has(n);
}

/** Returns the live session timer for a mower, or undefined when no
 *  mowing status has been observed since the last `clearMowingSession` call.
 *  Used by the cloud-API `saveCutGrassRecord` fallback to compute duration
 *  when the firmware POST omits / zeroes the workTime field. */
export function getMowingSession(sn: string): MowingSession | undefined {
  return mowingSessions.get(sn);
}

/** Drop the session after a work record is persisted so the next coverage
 *  task starts fresh. Idempotent. */
export function clearMowingSession(sn: string): void {
  mowingSessions.delete(sn);
}

/** Internal — called from processSensors when work_status changes. Exported
 *  for unit testing the transition rules in isolation. */
export function _updateMowingSession(sn: string, newWorkStatus: string, now = Date.now()): void {
  if (!isActiveMowingStatus(newWorkStatus)) return; // leaving mowing leaves the session intact
  const existing = mowingSessions.get(sn);
  if (existing) {
    existing.lastActiveAt = now;
  } else {
    mowingSessions.set(sn, { startedAt: now, lastActiveAt: now });
  }
}

export function translateValue(field: string, rawValue: string): string {
  switch (field) {
    case 'charger_status': {
      const n = parseInt(rawValue, 10);
      return isNaN(n) ? rawValue : translateChargerStatus(n);
    }
    case 'mower_status': {
      const mapped = MOWER_STATUS_MAP[rawValue];
      if (mapped) return mapped;
      const n = parseInt(rawValue, 10);
      return isNaN(n) ? rawValue : translateMowerStatus(n);
    }
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
    case 'work_status':
      return translateWorkStatus(rawValue);
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
    case 'rtk_fix_quality':
      switch (rawValue) {
        case '0': return 'No fix';
        case '1': return 'GPS';
        case '2': return 'DGPS';
        case '4': return 'RTK Fixed';
        case '5': return 'RTK Float';
        default:  return rawValue;
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

// ── Local meter trail (from map_position_x/y, much more accurate than GPS) ──

export interface LocalTrailPoint { x: number; y: number; ts: number }

const localTrails = new Map<string, LocalTrailPoint[]>();

function appendLocalTrailPoint(sn: string, x: number, y: number): void {
  if (isNaN(x) || isNaN(y)) return;
  if (!localTrails.has(sn)) localTrails.set(sn, []);
  const trail = localTrails.get(sn)!;

  // Dedup: skip als < 5cm verplaatsing
  if (trail.length > 0) {
    const last = trail[trail.length - 1];
    const dx = x - last.x, dy = y - last.y;
    if (dx * dx + dy * dy < 0.0025) return; // 5cm threshold
  }

  trail.push({ x, y, ts: Date.now() });
  if (trail.length > MAX_TRAIL_POINTS) trail.splice(0, trail.length - MAX_TRAIL_POINTS);
}

export function getLocalTrail(sn: string): LocalTrailPoint[] {
  return localTrails.get(sn) ?? [];
}

export function clearLocalTrail(sn: string): void {
  localTrails.delete(sn);
}

// ── Validation trail (RTK-FIX paired GPS + map_position samples) ────────────
//
// Captured ONLY while the mower is reporting both:
//   - latitude/longitude with non-zero values
//   - map_position_x/y with non-zero values
//   - loc_quality === 100 (RTK FIX)
//
// Used by the admin map's "validate position" view to overlay a green GPS-
// derived trail on top of the blue firmware-frame trail and surface the
// median offset as a suggested polygon-offset calibration.

export interface ValidationSample {
  ts: number;
  lat: number;
  lng: number;
  mx: number;
  my: number;
}

const MAX_VALIDATION_POINTS = 2000;
const validationTrails = new Map<string, ValidationSample[]>();

function appendValidationSample(
  sn: string,
  lat: number,
  lng: number,
  mx: number,
  my: number,
): void {
  if (
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    !Number.isFinite(mx) || !Number.isFinite(my) ||
    lat === 0 || lng === 0 || (mx === 0 && my === 0)
  ) return;
  if (!validationTrails.has(sn)) validationTrails.set(sn, []);
  const trail = validationTrails.get(sn)!;
  // Dedup: skip if last sample is < 5cm away in map frame
  if (trail.length > 0) {
    const last = trail[trail.length - 1];
    const dx = mx - last.mx, dy = my - last.my;
    if (dx * dx + dy * dy < 0.0025) return;
  }
  trail.push({ ts: Date.now(), lat, lng, mx, my });
  if (trail.length > MAX_VALIDATION_POINTS) {
    trail.splice(0, trail.length - MAX_VALIDATION_POINTS);
  }
}

export function getValidationTrail(sn: string, sinceMs?: number): ValidationSample[] {
  const trail = validationTrails.get(sn) ?? [];
  if (sinceMs == null) return trail;
  const cutoff = Date.now() - sinceMs;
  return trail.filter((p) => p.ts >= cutoff);
}

export function clearValidationTrail(sn: string): void {
  validationTrails.delete(sn);
}

/**
 * Wis alle gecachte sensor data voor een apparaat (bij disconnect).
 * Hierdoor toont het dashboard geen stale waarden voor offline apparaten.
 */
export function clearDeviceData(sn: string): void {
  deviceCache.delete(sn);
  pinVerifiedSns.delete(sn);
  signalSampleMetaBySn.delete(sn);
  lastSignalSampleTime.delete(sn);
  lastWifiHeatmapSampleTime.delete(sn);
  lastWifiRssiRefreshRequestTime.delete(sn);
  pendingWifiRssiRefreshRequests.delete(sn);
  // Drop the notifications detector's cached "previous frame" too —
  // otherwise the next reconnect's first sensor frame compares an
  // empty msg ('') against a stale prev=Work:COVERING and emits a
  // bogus mowing_started → mowing_finished pair on every disconnect.
  resetEventState(sn);
}

// ── Signal history sampling ──────────────────────────────────────

const SAMPLE_INTERVAL_MS = 30_000; // 30 seconden
const POSITIONED_WIFI_MAX_AGE_MS = 15_000;
const WIFI_RSSI_REFRESH_INTERVAL_MS = SAMPLE_INTERVAL_MS;
const lastSignalSampleTime = new Map<string, number>();
const lastWifiHeatmapSampleTime = new Map<string, number>();
const lastWifiRssiRefreshRequestTime = new Map<string, number>();
const pendingWifiRssiRefreshRequests = new Set<string>();

interface SignalSampleMeta {
  lastWifiAt?: number;
  lastPoseAt?: number;
}

const signalSampleMetaBySn = new Map<string, SignalSampleMeta>();

function queueWifiRssiRefresh(sn: string, now: number): void {
  if (!sn.startsWith('LFIN')) return;
  const last = lastWifiRssiRefreshRequestTime.get(sn);
  if (last !== undefined && now - last < WIFI_RSSI_REFRESH_INTERVAL_MS) return;
  lastWifiRssiRefreshRequestTime.set(sn, now);
  pendingWifiRssiRefreshRequests.add(sn);
}

export function consumeWifiRssiRefreshRequest(sn: string): boolean {
  const pending = pendingWifiRssiRefreshRequests.has(sn);
  pendingWifiRssiRefreshRequests.delete(sn);
  return pending;
}

const signalHistoryInsert = db.prepare(`
  INSERT INTO signal_history
    (sn, battery, wifi_rssi, rtk_sat, loc_quality, cpu_temp, map_x, map_y, latitude, longitude)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function normaliseWifiRssi(n: number): number {
  return n > 0 ? -n : n;
}

function sampleSignalHistory(sn: string, snValues: Map<string, string>, meta: SignalSampleMeta): void {
  const now = Date.now();
  const lastSignal = lastSignalSampleTime.get(sn) ?? 0;
  const lastHeatmap = lastWifiHeatmapSampleTime.get(sn) ?? 0;

  // Alleen samplen als er minstens één relevant signaal veld is
  const battery = parseInt(snValues.get('battery_power') ?? snValues.get('battery_capacity') ?? '', 10);
  const wifiRssi = parseInt(snValues.get('wifi_rssi') ?? '', 10);
  const rtkSat = parseInt(snValues.get('rtk_sat') ?? '', 10);
  const locQuality = parseInt(snValues.get('loc_quality') ?? '', 10);
  const cpuTemp = parseInt(snValues.get('cpu_temperature') ?? '', 10);
  const mapX = parseFloat(snValues.get('map_position_x') ?? '');
  const mapY = parseFloat(snValues.get('map_position_y') ?? '');
  const latitude = parseFloat(snValues.get('latitude') ?? '');
  const longitude = parseFloat(snValues.get('longitude') ?? '');

  if (isNaN(battery) && isNaN(wifiRssi) && isNaN(rtkSat) && isNaN(locQuality) && isNaN(cpuTemp)) return;

  const hasFreshPositionedWifi =
    !isNaN(wifiRssi)
    && !isNaN(mapX)
    && !isNaN(mapY)
    && meta.lastWifiAt !== undefined
    && meta.lastPoseAt !== undefined
    && now - meta.lastWifiAt <= POSITIONED_WIFI_MAX_AGE_MS
    && now - meta.lastPoseAt <= POSITIONED_WIFI_MAX_AGE_MS
    && Math.abs(meta.lastWifiAt - meta.lastPoseAt) <= POSITIONED_WIFI_MAX_AGE_MS;

  const shouldSampleSignal = now - lastSignal >= SAMPLE_INTERVAL_MS;
  const shouldSampleHeatmap = hasFreshPositionedWifi && now - lastHeatmap >= SAMPLE_INTERVAL_MS;
  if (!shouldSampleSignal && !shouldSampleHeatmap) return;

  try {
    signalHistoryInsert.run(
      sn,
      isNaN(battery) ? null : battery,
      isNaN(wifiRssi) ? null : normaliseWifiRssi(wifiRssi),
      isNaN(rtkSat) ? null : rtkSat,
      isNaN(locQuality) ? null : locQuality,
      isNaN(cpuTemp) ? null : cpuTemp,
      hasFreshPositionedWifi ? mapX : null,
      hasFreshPositionedWifi ? mapY : null,
      isNaN(latitude) || latitude === 0 ? null : latitude,
      isNaN(longitude) || longitude === 0 ? null : longitude,
    );
    if (shouldSampleSignal) lastSignalSampleTime.set(sn, now);
    if (shouldSampleHeatmap) lastWifiHeatmapSampleTime.set(sn, now);
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

// ── mower_error debouncer ───────────────────────────────────────
// The charger publishes mower_error inside up_status_info every ~1s while
// the LoRa link is alive. Code 2 ("Searching mower") fires routinely
// during normal pair handshakes — surfacing it instantly causes false
// alarms on the app/admin UI. We track consecutive identical non-zero
// values so the consumer can require N persistent samples before showing
// the warning. Reset on `0` or when the value flips to a different code.
const mowerErrorCounters = new Map<string, { value: string; count: number }>();

export function _updateMowerErrorCounter(sn: string, raw: string): void {
  const n = parseInt(raw, 10);
  if (isNaN(n) || n === 0) {
    mowerErrorCounters.delete(sn);
    return;
  }
  const existing = mowerErrorCounters.get(sn);
  if (existing && existing.value === raw) {
    existing.count += 1;
  } else {
    mowerErrorCounters.set(sn, { value: raw, count: 1 });
  }
}

export function getMowerErrorState(sn: string): { value: string; count: number } | null {
  return mowerErrorCounters.get(sn) ?? null;
}

// ── Dock pose capture ───────────────────────────────────────────
// Stock firmware's heading-discovery drives the mower physically before
// declaring its localization origin (0,0). The polygon stored on disk is
// therefore relative to a post-discovery pose, NOT the physical dock.
// The app used to render the charger icon at hardcoded (0,0) which lands
// somewhere INSIDE the polygon for that reason.
// Workaround: snapshot map_position_x/y/orientation the moment the mower
// reports it is on the charger (recharge_status numeric == 9 OR
// battery_state == "CHARGING"). That captures the real dock pose in the
// same local frame as the polygon. The app reads this via the device
// snapshot and renders the charger icon there.
export interface DockPose { x: number; y: number; orientation: number; capturedAt: number }
const dockPoseBySn = new Map<string, DockPose>();

// Tracks which mowers are currently in the docked state. Used to detect
// the leading edge of a docking event (not-docked → docked) so we trigger
// one-shot debug actions (pos.json fetch) instead of firing on every report.
const dockedSns = new Set<string>();

// Debug-only: SSH into the mower and read /userdata/pos.json, then
// broadcast its contents to dashboard + app via Socket.io. Fire-and-forget;
// failures are silent (logged to stderr). Triggered only on the leading
// edge of a docking transition.
async function fetchPosJsonAndEmit(sn: string): Promise<void> {
  try {
    const ip = await resolveMowerIp(sn, { awaitDiscovery: false });
    if (!ip) return;
    const raw = await sshCatPosJson(ip);
    if (raw == null) return;
    let parsed: unknown = null;
    try { parsed = JSON.parse(raw); } catch { /* keep raw only */ }
    emitDebugPosJson(sn, parsed, raw);
  } catch (e) {
    console.error('[debug-pos] fetch failed for', sn, e);
  }
}

function sshCatPosJson(ip: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('sshpass', [
      '-p', 'novabot', 'ssh',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=5',
      `root@${ip}`, 'cat /userdata/pos.json',
    ], { timeout: 15000 });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error('[debug-pos] ssh exit', code, err.slice(0, 200));
        return resolve(null);
      }
      resolve(out);
    });
    proc.on('error', (e) => {
      console.error('[debug-pos] ssh spawn error:', (e as Error).message);
      resolve(null);
    });
  });
}

export function getDockPose(sn: string): DockPose | null {
  return dockPoseBySn.get(sn) ?? null;
}

function isDockedByValues(snValues: Map<string, string>): boolean {
  const rs = snValues.get('recharge_status') ?? '';
  // recharge_status raw is numeric — '9' = docked / charging finished.
  // Catch both raw and translated forms so this works regardless of
  // ordering (translateValue runs in another path).
  if (rs === '9' || rs.startsWith('Charging')) return true;
  const bs = (snValues.get('battery_state') ?? '').toUpperCase();
  return bs === 'CHARGING' || bs === 'FULL';
}

// ── PIN verify suppressie ────────────────────────────────────────
// Na PIN verify blijft mqtt_node error_status 151 rapporteren omdat alleen
// de STM32 MCU de error cleart — de Linux-kant weet daar niets van.
// We onderdrukken PIN-gerelateerde errors totdat:
// - error_status daadwerkelijk 0 wordt (maaier cleart zelf), of
// - een ANDERE error binnenkomt (echt nieuw probleem), of
// - het apparaat offline gaat (clearDeviceData wist alles)
const pinVerifiedSns = new Set<string>();
const PIN_ERROR_CODES = new Set(['151']);

export function markPinVerified(sn: string): void {
  pinVerifiedSns.add(sn);
}

export function clearPinVerified(sn: string): void {
  pinVerifiedSns.delete(sn);
}

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

  // JSON.parse accepts bare "null", "123", "true" etc. WITHOUT throwing, so
  // `parsed` can be null or a non-object. Object.keys(null) throws "Cannot
  // convert undefined or null to object" — the mower's stray null/keepalive
  // payloads (literal "null") crashed the broker's publish handler right here.
  if (parsed === null || typeof parsed !== 'object') return null;

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

  // Voor get_wifi_rssi_respond: mqtt_node retourneert meestal
  // { result, value: { rssi } }. Normaliseer naar het bestaande wifi_rssi veld.
  if (commandName === 'get_wifi_rssi_respond') {
    const d = data as Record<string, unknown>;
    const message = typeof d.message === 'object' && d.message !== null
      ? d.message as Record<string, unknown>
      : null;
    const source = message ?? d;
    const value = source.value;
    let rssi = source.wifi_rssi ?? source.rssi;
    if (rssi === undefined && typeof value === 'object' && value !== null) {
      const valueObj = value as Record<string, unknown>;
      rssi = valueObj.wifi_rssi ?? valueObj.rssi;
    } else if (rssi === undefined && value !== undefined) {
      rssi = value;
    }
    data = rssi === undefined ? {} : { wifi_rssi: rssi };
  }

  // Voor report_state_to_server_work_respond: waarden zitten in value, en sv/hv/ov moeten gemapt worden
  if (commandName === 'report_state_to_server_work_respond' && typeof (data as Record<string, unknown>).value === 'object') {
    const raw = (data as Record<string, unknown>).value as Record<string, unknown>;
    // Map afkortingen naar volledige sensor namen
    const mapped: Record<string, unknown> = { ...raw };
    if (raw.sv !== undefined) { mapped.sw_version = raw.sv; delete mapped.sv; }
    // Stock-simulatie (SIMULATE_STOCK_FIRMWARE): versie vervangen vóór cache/DB-sync,
    // zodat dashboard en app deze maaier ook als stock zien.
    if (mapped.sw_version !== undefined && isSimulatedStock(sn)) mapped.sw_version = SIMULATED_STOCK_VERSION;
    if (raw.hv !== undefined) { mapped.hw_version = raw.hv; delete mapped.hv; }
    if (raw.ov !== undefined) { mapped.os_version = raw.ov; delete mapped.ov; }
    data = mapped;
  }

  // Sync version van MQTT-sensor naar equipment.mower_version DB-kolom.
  // Zonder dit blijft de DB op de pre-OTA versie plakken (observed 2026-04-21
  // na upgrade naar custom-24 → app toonde nog steeds custom-21 in admin
  // panel want die leest uit equipment.mower_version, niet uit de sensor).
  // We doen dit alleen als de sw_version daadwerkelijk wijzigt (changes set)
  // zodat we geen onnodige DB writes elke 2s doen.
  // NB: gebeurt verderop, na de changes loop die sw_version toevoegt aan
  // de Map. We laten die loop eerst de wijziging detecteren.

  if (!deviceCache.has(sn)) deviceCache.set(sn, new Map());
  const snValues = deviceCache.get(sn)!;

  const changes = new Map<string, string>();
  const pinSuppressed = pinVerifiedSns.has(sn);
  const frameReceivedAt = Date.now();
  const signalMeta = signalSampleMetaBySn.get(sn) ?? {};
  signalSampleMetaBySn.set(sn, signalMeta);

  for (const [field, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue; // skip arrays/objects (bijv. timer_task)

    const strValue = String(value);

    // PIN suppressie: na verify blijft mqtt_node error 151 rapporteren.
    // Onderdruk zolang het dezelfde PIN-error is. Laat door als:
    // - waarde is '0' (error daadwerkelijk gecleared)
    // - het een andere error is (nieuw probleem)
    if (pinSuppressed && field === 'error_status') {
      if (PIN_ERROR_CODES.has(strValue)) continue;           // zelfde PIN error → skip
      if (strValue === '0') pinVerifiedSns.delete(sn);       // error gecleared → stop suppressie
    }
    if (pinSuppressed && field === 'error_msg') {
      if (String(value).toLowerCase().includes('input pin')) continue;  // PIN-gerelateerde msg → skip
    }
    if (pinSuppressed && field === 'error_code') {
      if (PIN_ERROR_CODES.has(strValue)) continue;           // zelfde PIN error code → skip
    }

    if (snValues.get(field) === strValue) continue; // ongewijzigd

    snValues.set(field, strValue);
    changes.set(field, translateValue(field, strValue));

    // Issue #17: refresh the in-memory mowing-session timer whenever
    // work_status passes through an active task value (100..150).
    if (field === 'work_status') _updateMowingSession(sn, strValue);

    // mower_error gateway state — track consecutive identical non-zero
    // values so the UI can debounce transient "Searching mower (2)"
    // blips that the LoRa link emits during normal pair handshakes.
    if (field === 'mower_error') _updateMowerErrorCounter(sn, strValue);
  }

  // Extraheer geneste GPS data uit report_state_timer_data → localization.gps_position
  const dataObj = data as Record<string, unknown>;
  const frameWifiRssi = parseInt(String(dataObj.wifi_rssi ?? ''), 10);
  const hasExplicitWifiRssi = commandName === 'get_wifi_rssi_respond' && !isNaN(frameWifiRssi);
  if (hasExplicitWifiRssi) signalMeta.lastWifiAt = frameReceivedAt;

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
    // Map position (local x/y in meters relative to charger, + orientation in radians)
    if (typeof loc.map_position === 'object' && loc.map_position !== null) {
      const mp = loc.map_position as Record<string, unknown>;
      const frameMapX = parseFloat(String(mp.x ?? ''));
      const frameMapY = parseFloat(String(mp.y ?? ''));
      if (!isNaN(frameMapX) && !isNaN(frameMapY)) {
        signalMeta.lastPoseAt = frameReceivedAt;
        queueWifiRssiRefresh(sn, frameReceivedAt);
      }

      for (const mpField of ['x', 'y', 'orientation'] as const) {
        if (mp[mpField] !== undefined && mp[mpField] !== null) {
          const key = mpField === 'x' ? 'map_position_x' : mpField === 'y' ? 'map_position_y' : 'map_position_orientation';
          const strValue = String(mp[mpField]);
          if (snValues.get(key) !== strValue) {
            snValues.set(key, strValue);
            changes.set(key, strValue);
          }
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

  // ── Extract cover_path voortgang uit report_state_timer_data ─────
  //
  // De maaier rapporteert in report_state_timer_data.cover_path.covered welke
  // sub-gebieden van de planned_path af zijn, welk sub-gebied nu bezig is,
  // en een klein live segmentje met de recente positie. Deze state leeft op
  // de maaier en overleeft dus app-restart / reconnect: elke nieuwe tick
  // bevat de volledige huidige stand.
  //
  // Formaat (bewezen via live MQTT capture 2026-04-20):
  //   cover_path.covered = {
  //     covering:      "2.48 -1.62,2.49 -1.63",          // huidig segmentje (comma-sep)
  //     covering_area: { area_id: "14", points: "4" },    // actief sub-gebied
  //     finished_area: " 0 1 2 3 4 5 6 7 8 9 10 11 12 13", // space-sep indices
  //     missed:        "3.68 -6.07;3.51 -5.51;..."         // ; -sep gemiste punten
  //   }
  //
  // We kopiëren deze velden naar sensorstate zodat de app ze via socket krijgt.
  if (commandName === 'report_state_timer_data' && typeof dataObj.cover_path === 'object' && dataObj.cover_path !== null) {
    const cp = dataObj.cover_path as Record<string, unknown>;
    if (typeof cp.map_id !== 'undefined' && cp.map_id !== null) {
      const v = String(cp.map_id);
      if (snValues.get('cover_map_id') !== v) {
        snValues.set('cover_map_id', v);
        changes.set('cover_map_id', v);
      }
    }
    const covered = cp.covered as Record<string, unknown> | undefined;
    if (covered && typeof covered === 'object') {
      if (typeof covered.finished_area === 'string') {
        // Normaliseer leading/trailing spaces, single-space separator
        const v = covered.finished_area.trim().replace(/\s+/g, ' ');
        if (snValues.get('finished_area') !== v) {
          snValues.set('finished_area', v);
          changes.set('finished_area', v);
        }
      }
      if (typeof covered.covering_area === 'object' && covered.covering_area !== null) {
        const ca = covered.covering_area as Record<string, unknown>;
        if (ca.area_id !== undefined && ca.area_id !== null) {
          const aid = String(ca.area_id);
          if (snValues.get('covering_area_id') !== aid) {
            snValues.set('covering_area_id', aid);
            changes.set('covering_area_id', aid);
          }
        }
        if (ca.points !== undefined && ca.points !== null) {
          const pts = String(ca.points);
          if (snValues.get('covering_area_points') !== pts) {
            snValues.set('covering_area_points', pts);
            changes.set('covering_area_points', pts);
          }
        }
      }
      if (typeof covered.covering === 'string') {
        const v = covered.covering;
        if (snValues.get('covering_points') !== v) {
          snValues.set('covering_points', v);
          changes.set('covering_points', v);
        }
      }
      if (typeof covered.missed === 'string') {
        const v = covered.missed;
        if (snValues.get('missed_points') !== v) {
          snValues.set('missed_points', v);
          changes.set('missed_points', v);
        }
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

  // plan_path change: NIET automatisch get_map_plan_path sturen.
  // Dit commando veroorzaakt mqtt_node disconnect bij sommige maaiers.
  // De app stuurt dit commando zelf als het nodig is.

  // Append trails wanneer de maaier actief beweegt (maaien, navigeren, mapping, edge-cut).
  // Edge-cut bypasst robot_decision, dus `msg` reflecteert dat pad niet —
  // `edge_active` wordt door onze extended_response handler gezet zodra de
  // NTCP monitor thread rapporteert.
  // Mapping: firmware rapporteert task_mode=3 / start_edit_or_assistant_map_flag=1
  // en msg patronen als "Mode:MAPPING Work:USER_MAP_*". Zonder mapping erbij
  // vroor de live trail mid-sessie zodra de chassis state weg-rolde van
  // Work:MOVING — paarse lijn verdween, gebied werd grijs.
  const currentMsg = snValues.get('msg') ?? '';
  const edgeActive = snValues.get('edge_active') === '1';
  const taskMode = snValues.get('task_mode') ?? '';
  const workStatus = snValues.get('work_status') ?? '';
  // Bitmask, not boolean. Live LFIN1231000211 reports values like 16 during
  // mapping. Treat any non-zero value as active.
  const mappingFlagRaw = snValues.get('start_edit_or_assistant_map_flag') ?? '0';
  const mappingFlag = mappingFlagRaw !== '0' && mappingFlagRaw !== '';
  // work_status numeric values from original v1.0.0 (ad7bb872): 1=mowing, 5=mapping.
  // The b1924ef2 refactor switched to msg-text patterns and lost the numeric
  // mapping detection — user firmware reports work_status=5 during mapping
  // even when msg text doesn't include any of the patterns below. Keep both
  // detections so any firmware variant gets the trail captured.
  const mappingActive = mappingFlag
    || taskMode === '3'
    || workStatus === '5'
    || currentMsg.includes('Mode:MAPPING')
    || currentMsg.includes('USER_MAP')
    || currentMsg.includes('ASSISTANT_MAP');
  const mowingByStatus = workStatus === '1';
  const isActive = edgeActive
    || mappingActive
    || mowingByStatus
    || currentMsg.includes('Work:RUNNING')
    || currentMsg.includes('Work:NAVIGATING')
    || currentMsg.includes('Work:COVERING')
    || currentMsg.includes('Work:MOVING');

  if (isActive) {
    // GPS trail
    if (changes.has('latitude') || changes.has('longitude')) {
      const lat = snValues.get('latitude');
      const lng = snValues.get('longitude');
      if (lat && lng) appendTrailPoint(sn, lat, lng);
    }
    // Local meter trail (from map_position_x/y — much more accurate)
    if (changes.has('map_position_x') || changes.has('map_position_y')) {
      const mx = parseFloat(snValues.get('map_position_x') ?? '');
      const my = parseFloat(snValues.get('map_position_y') ?? '');
      if (!isNaN(mx) && !isNaN(my)) {
        appendLocalTrailPoint(sn, mx, my);
        // Derive driving speed (m/s) from consecutive map-frame pose samples.
        // The pose stream is ~1 Hz so this is coarse, but enough to show the real
        // speed and confirm the navigation-max-speed setting. Light EMA + a small
        // deadband de-jitter it; it surfaces as the existing `mow_speed` sensor so
        // both the dashboard and the app display it without extra plumbing.
        const lt = getLocalTrail(sn);
        if (lt.length >= 2) {
          const a = lt[lt.length - 2];
          const b = lt[lt.length - 1];
          const dt = (b.ts - a.ts) / 1000;
          if (dt >= 0.2 && dt <= 5) {
            const raw = Math.hypot(b.x - a.x, b.y - a.y) / dt;
            const prev = parseFloat(snValues.get('mow_speed') ?? '');
            const ema = Number.isFinite(prev) ? prev * 0.5 + raw * 0.5 : raw;
            const sv = (ema < 0.03 ? 0 : ema).toFixed(2);
            if (snValues.get('mow_speed') !== sv) {
              snValues.set('mow_speed', sv);
              changes.set('mow_speed', sv);
            }
          }
        }
      }
    }
    // Validation trail — paired GPS + map_position samples, RTK FIX only.
    // Sampled on every active frame because we need a stream of pairs for
    // the offset-suggestion median, not just on changes.
    const locQuality = parseInt(snValues.get('loc_quality') ?? '', 10);
    if (locQuality === 100) {
      const lat = parseFloat(snValues.get('latitude') ?? '');
      const lng = parseFloat(snValues.get('longitude') ?? '');
      const mx = parseFloat(snValues.get('map_position_x') ?? '');
      const my = parseFloat(snValues.get('map_position_y') ?? '');
      appendValidationSample(sn, lat, lng, mx, my);
    }
  }

  // Dock pose capture — independent of isActive. Whenever the mower
  // reports it is currently on the charger, snapshot its map_position so
  // the app can render the charger icon at the real dock location instead
  // of hardcoded (0,0). Captures both during initial dock and on every
  // subsequent report while docked (in case localization drifts after
  // re-dock). Only stores when a valid map_position is present.
  const docked = isDockedByValues(snValues);
  if (docked && snValues.get('mow_speed') !== '0.00') {
    // Parked → speed is 0 (avoid a stale non-zero reading lingering on the dock).
    snValues.set('mow_speed', '0.00');
    changes.set('mow_speed', '0.00');
  }
  if (docked) {
    const mx = parseFloat(snValues.get('map_position_x') ?? '');
    const my = parseFloat(snValues.get('map_position_y') ?? '');
    const mo = parseFloat(snValues.get('map_position_orientation') ?? '0');
    if (!isNaN(mx) && !isNaN(my) && (mx !== 0 || my !== 0)) {
      dockPoseBySn.set(sn, {
        x: mx,
        y: my,
        orientation: isNaN(mo) ? 0 : mo,
        capturedAt: Date.now(),
      });
    }
  }

  // Debug: on the just-docked transition (not-docked → docked) fetch
  // /userdata/pos.json from the mower and emit it to subscribed sockets.
  // Per-operator opt-in via DEBUG_POS_JSON=1 (every Novabot container is
  // single-user but each user is admin of their own DB, so an admin-role
  // gate alone wouldn't keep this feature private). Default off; only
  // takes effect for the operator who explicitly sets the env var.
  if (docked && !dockedSns.has(sn)) {
    dockedSns.add(sn);
    if (process.env.DEBUG_POS_JSON === '1') void fetchPosJsonAndEmit(sn);
  } else if (!docked && dockedSns.has(sn)) {
    dockedSns.delete(sn);
  }

  // Charger GPS positie wordt NIET automatisch bijgewerkt — GPS jitter (2-3m) verschuift
  // de conversie-origin en daarmee alle kaartpolygonen. Charger positie wordt eenmalig
  // ingesteld via dashboard of bij eerste mapping sessie.

  // Sync sw_version / charger_version naar equipment DB wanneer ze wijzigen.
  // Zonder dit blijft de admin panel + firmware screen een oude versie tonen
  // na OTA (observed 2026-04-21 na upgrade naar custom-24). We schrijven alleen
  // bij échte wijzigingen zodat we geen continue DB writes krijgen.
  if (changes.has('sw_version') || changes.has('mqtt_version')) {
    const v = snValues.get('sw_version') || snValues.get('mqtt_version');
    if (v) {
      try {
        if (sn.startsWith('LFIN')) {
          equipmentRepo.updateVersions(sn, v);
        } else if (sn.startsWith('LFIC')) {
          equipmentRepo.updateChargerVersionByChargerSn(sn, v);
        }
      } catch { /* ignore DB errors — equipment row may not exist yet */ }
    }
  }

  // Sample signal history elke 30s
  if (changes.size > 0 || hasExplicitWifiRssi) {
    sampleSignalHistory(sn, snValues, signalMeta);
  }

  // Notification event detection — only mowers, only when there were
  // changes (skip duplicate-frame ticks that the cache filtered out).
  // The detector tracks its own per-SN snapshot and emits events only on
  // real transitions, so calling here is cheap.
  if (changes.size > 0 && sn.startsWith('LFIN')) {
    try {
      detectAndDispatch(sn, snValues);
    } catch (err) {
      console.warn('[NOTIFY] detectAndDispatch failed:', err);
    }
    // Issue #30: the FIRMWARE auto-resumes coverage itself after a proper
    // AutoCharging dock (RobotDecision::coverContinueDeal, battery-gated on
    // full_battery_power). No server-side resume is needed — see
    // research/documents/firmware-auto-continue-after-recharge.md. The former
    // autoResume.ts was a redundant re-implementation and has been removed.
  }

  // Post-restore re-anchor lifecycle: the flag clears only after the mower
  // leaves the dock and re-docks (a real auto_recharge re-anchor), NOT on the
  // stale docked state present at import time. noteDockState handles that
  // undock-then-redock transition. Always surface the current flag so the app
  // can show the wizard and lock Go-home.
  const wasUnvalidated = isFrameUnvalidated(sn);
  if (wasUnvalidated) {
    noteDockState(sn, docked);
    if (!isFrameUnvalidated(sn)) {
      console.log(`[sensor] frame_unvalidated cleared for ${sn} (re-docked after undock)`);
    }
  }
  const fuNow = isFrameUnvalidated(sn) ? '1' : '0';
  if (snValues.get('frame_unvalidated') !== fuNow) {
    snValues.set('frame_unvalidated', fuNow);
    changes.set('frame_unvalidated', fuNow);
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
  // Rain-pause flag: a rain pause now sets Work:USER_STOP (same as a manual
  // pause), so this flag is the only way the app can tell rain apart from a
  // manual pause. Only mowers (LFIN*) have rain sessions.
  result.rain_paused =
    sn.startsWith('LFIN') && scheduleRepo.findRainSessionByMower(sn, 'paused')
      ? '1'
      : '0';
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
