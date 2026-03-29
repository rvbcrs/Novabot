import type { DeviceState, SensorDef, MapData, TrailPoint, MapCalibration, Schedule, WorkRecord, SignalHistoryPoint } from '../types';

const BASE = '/api/dashboard';

async function get(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res;
}

async function post(url: string, body?: unknown): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res;
}

export async function fetchDevices(): Promise<DeviceState[]> {
  const data = await (await get(`${BASE}/devices`)).json();
  return (data.devices ?? []).map((d: DeviceState) => ({
    ...d,
    lastUpdate: Date.now(),
  }));
}

export async function deleteDevice(sn: string): Promise<void> {
  await fetch(`${BASE}/devices/${encodeURIComponent(sn)}`, { method: 'DELETE' });
}

export async function fetchSensors(): Promise<SensorDef[]> {
  const data = await (await get(`${BASE}/sensors`)).json();
  return data.sensors ?? [];
}

export async function fetchMaps(sn: string): Promise<MapData[]> {
  const data = await (await get(`${BASE}/maps/${encodeURIComponent(sn)}`)).json();
  return data.maps ?? [];
}

export async function fetchAllMaps(): Promise<MapData[]> {
  const data = await (await get(`${BASE}/maps`)).json();
  return data.maps ?? [];
}

export async function fetchTrail(sn: string): Promise<TrailPoint[]> {
  const data = await (await get(`${BASE}/trail/${encodeURIComponent(sn)}`)).json();
  return data.trail ?? [];
}

export async function clearTrail(sn: string): Promise<void> {
  await fetch(`${BASE}/trail/${encodeURIComponent(sn)}`, { method: 'DELETE' });
}

export async function fetchCalibration(sn: string): Promise<MapCalibration> {
  const data = await (await get(`${BASE}/calibration/${encodeURIComponent(sn)}`)).json();
  return data.calibration;
}

export async function saveCalibration(
  sn: string, cal: MapCalibration, opts?: { relocateCharger?: boolean },
): Promise<{ mapsRecalculated?: number }> {
  const res = await fetch(`${BASE}/calibration/${encodeURIComponent(sn)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...cal, ...(opts?.relocateCharger ? { relocateCharger: true } : {}) }),
  });
  return res.json();
}

export async function renameMap(sn: string, mapId: string, mapName: string): Promise<void> {
  await fetch(`${BASE}/maps/${encodeURIComponent(sn)}/${encodeURIComponent(mapId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapName }),
  });
}

export async function updateMapArea(sn: string, mapId: string, mapArea: Array<{ lat: number; lng: number }>): Promise<void> {
  await fetch(`${BASE}/maps/${encodeURIComponent(sn)}/${encodeURIComponent(mapId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapArea }),
  });
}

export async function createMap(sn: string, mapName: string, mapArea: Array<{ lat: number; lng: number }>, mapType?: string): Promise<MapData> {
  const data = await (await post(`${BASE}/maps/${encodeURIComponent(sn)}`, { mapName, mapArea, mapType })).json();
  return data.map;
}

export async function deleteMap(sn: string, mapId: string): Promise<void> {
  await fetch(`${BASE}/maps/${encodeURIComponent(sn)}/${encodeURIComponent(mapId)}`, {
    method: 'DELETE',
  });
}

// ── MQTT Commands ──────────────────────────────────────────────

export interface CommandResult {
  ok: boolean;
  command: string;
  encrypted?: boolean;
  size?: number;
  error?: string;
}

export async function sendCommand(sn: string, command: Record<string, unknown>): Promise<CommandResult> {
  const res = await post(`${BASE}/command/${encodeURIComponent(sn)}`, { command });
  return res.json();
}

// ── Demo/simulatie modus ────────────────────────────────────────

export interface DemoStatus {
  demoMode: boolean;
  state: string;
  progress: number;
}

export async function setDemoMode(sn: string, enabled: boolean): Promise<DemoStatus & { ok: boolean }> {
  const res = await post(`${BASE}/demo/${encodeURIComponent(sn)}`, { enabled });
  return res.json();
}

export async function getDemoMode(sn: string): Promise<{ sn: string } & DemoStatus> {
  const res = await get(`${BASE}/demo/${encodeURIComponent(sn)}`);
  return res.json();
}

// ── PIN Code Management ─────────────────────────────────────────

export interface PinResult {
  ok: boolean;
  action: string;
  cfg_value: number;
  error?: string;
}

export async function pinQuery(sn: string): Promise<PinResult> {
  return (await post(`${BASE}/pin/${encodeURIComponent(sn)}/query`)).json();
}

export async function pinSet(sn: string, code: string): Promise<PinResult> {
  return (await post(`${BASE}/pin/${encodeURIComponent(sn)}/set`, { code })).json();
}

export async function pinVerify(sn: string, code: string): Promise<PinResult> {
  return (await post(`${BASE}/pin/${encodeURIComponent(sn)}/verify`, { code })).json();
}

export async function pinRaw(sn: string, cfg_value: number, code: string): Promise<PinResult> {
  return (await post(`${BASE}/pin/${encodeURIComponent(sn)}/raw`, { cfg_value, code })).json();
}

// ── Map Export ──────────────────────────────────────────────────

export async function exportMaps(sn: string, chargingStation: { lat: number; lng: number }, chargingOrientation?: number): Promise<string> {
  const data = await (await post(`${BASE}/maps/${encodeURIComponent(sn)}/export-zip`, {
    chargingStation, chargingOrientation: chargingOrientation ?? 0,
  })).json();
  return data.downloadUrl;
}

// ── Charger Calibration ──────────────────────────────────────────

/** Na autonomous mapping: stuur maaier terug naar station via go_to_charge + ArUco scan.
 *  Wacht tot de maaier gedockt is (battery_state = CHARGING), dan save_recharge_pos. */
export async function dockAndSave(sn: string): Promise<{ ok: boolean; waited?: number; error?: string }> {
  const data = await (await post(`${BASE}/maps/${encodeURIComponent(sn)}/dock-and-save`, {})).json();
  return data;
}

/** Kalibreer laadstation: maaier rijdt ~1m naar voren en parkeert automatisch terug via go_to_charge + ArUco. */
export async function calibrateCharger(sn: string): Promise<{ ok: boolean }> {
  const data = await (await post(`${BASE}/maps/${encodeURIComponent(sn)}/calibrate-charger`, {})).json();
  return data;
}

// ── Work Records (Mowing History) ────────────────────────────────

export async function fetchWorkRecords(sn: string, limit = 50, offset = 0): Promise<{ records: WorkRecord[]; total: number }> {
  const data = await (await get(`${BASE}/work-records/${encodeURIComponent(sn)}?limit=${limit}&offset=${offset}`)).json();
  return { records: data.records ?? [], total: data.total ?? 0 };
}

// ── Signal History ──────────────────────────────────────────────

export async function fetchSignalHistory(sn: string, hours = 24): Promise<SignalHistoryPoint[]> {
  const data = await (await get(`${BASE}/signal-history/${encodeURIComponent(sn)}?hours=${hours}`)).json();
  return data.history ?? [];
}

// ── Schedules ──────────────────────────────────────────────────

export async function fetchSchedules(sn: string): Promise<Schedule[]> {
  const data = await (await get(`${BASE}/schedules/${encodeURIComponent(sn)}`)).json();
  return data.schedules ?? [];
}

export async function createSchedule(sn: string, schedule: Omit<Schedule, 'scheduleId' | 'mowerSn' | 'createdAt' | 'updatedAt' | 'lastTriggeredAt'>): Promise<Schedule> {
  const data = await (await post(`${BASE}/schedules/${encodeURIComponent(sn)}`, schedule)).json();
  return data.schedule;
}

export async function updateSchedule(sn: string, scheduleId: string, updates: Partial<Schedule>): Promise<Schedule> {
  const res = await fetch(`${BASE}/schedules/${encodeURIComponent(sn)}/${encodeURIComponent(scheduleId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.schedule;
}

export async function deleteSchedule(sn: string, scheduleId: string): Promise<void> {
  await fetch(`${BASE}/schedules/${encodeURIComponent(sn)}/${encodeURIComponent(scheduleId)}`, {
    method: 'DELETE',
  });
}

export async function sendSchedule(sn: string, scheduleId: string): Promise<void> {
  await post(`${BASE}/schedules/${encodeURIComponent(sn)}/${encodeURIComponent(scheduleId)}/send`);
}

// ── Rain Sessions ───────────────────────────────────────────────

export interface RainSession {
  session_id: string;
  schedule_id: string;
  mower_sn: string;
  state: 'paused' | 'resuming' | 'completed' | 'cancelled';
  map_id: string | null;
  map_name: string | null;
  cutting_height: number;
  path_direction: number;
  paused_at: string;
  resumed_at: string | null;
}

export async function fetchRainSessions(sn: string): Promise<RainSession[]> {
  const data = await (await get(`${BASE}/rain-sessions/${encodeURIComponent(sn)}`)).json();
  return data.sessions ?? [];
}

export interface RainForecast {
  available: boolean;
  clearAt: string | null;
  upcoming: Array<{ time: string; mm: number; prob: number }>;
}

export async function fetchRainForecast(sn: string): Promise<RainForecast> {
  const data = await (await get(`${BASE}/rain-forecast/${encodeURIComponent(sn)}`)).json();
  return data;
}

// ── Extended Mower Commands ────────────────────────────────────

export async function navigateToPosition(sn: string, latitude: number, longitude: number, angle = 0): Promise<CommandResult> {
  return (await post(`${BASE}/navigate-to/${encodeURIComponent(sn)}`, { latitude, longitude, angle })).json();
}

export async function stopNavigation(sn: string): Promise<CommandResult> {
  return (await post(`${BASE}/stop-navigation/${encodeURIComponent(sn)}`)).json();
}

export async function startPatrol(sn: string): Promise<CommandResult> {
  return (await post(`${BASE}/patrol/${encodeURIComponent(sn)}`)).json();
}

export async function stopPatrol(sn: string): Promise<CommandResult> {
  return (await post(`${BASE}/stop-patrol/${encodeURIComponent(sn)}`)).json();
}

export async function setChargeThreshold(sn: string, threshold: number): Promise<CommandResult> {
  return (await post(`${BASE}/charge-threshold/${encodeURIComponent(sn)}`, { threshold })).json();
}

export async function setMaxSpeed(sn: string, speed: number): Promise<CommandResult> {
  return (await post(`${BASE}/max-speed/${encodeURIComponent(sn)}`, { speed })).json();
}

export async function previewPath(sn: string, polygonArea: Array<{ latitude: number; longitude: number }>, covDirection = 0): Promise<CommandResult> {
  return (await post(`${BASE}/preview-path/${encodeURIComponent(sn)}`, { polygonArea, covDirection })).json();
}

// ── Virtual Walls ──────────────────────────────────────────────

export interface VirtualWall {
  wall_id: string;
  mower_sn: string;
  wall_name: string | null;
  lat1: number;
  lng1: number;
  lat2: number;
  lng2: number;
  enabled: number;
  created_at: string;
}

export async function fetchVirtualWalls(sn: string): Promise<VirtualWall[]> {
  const data = await (await get(`${BASE}/virtual-walls/${encodeURIComponent(sn)}`)).json();
  return data.walls ?? [];
}

export async function createVirtualWall(sn: string, wall: { wallName?: string; lat1: number; lng1: number; lat2: number; lng2: number }): Promise<{ ok: boolean; wallId: string }> {
  return (await post(`${BASE}/virtual-walls/${encodeURIComponent(sn)}`, wall)).json();
}

export async function deleteVirtualWall(sn: string, wallId: string): Promise<void> {
  await fetch(`${BASE}/virtual-walls/${encodeURIComponent(sn)}/${encodeURIComponent(wallId)}`, { method: 'DELETE' });
}

// ── Extended Commands (firmware Python node) ───────────────────

export async function sendExtendedCommand(sn: string, command: Record<string, unknown>): Promise<CommandResult> {
  return (await post(`${BASE}/extended/${encodeURIComponent(sn)}`, command)).json();
}

export async function rebootMower(sn: string): Promise<CommandResult> {
  return sendExtendedCommand(sn, { set_robot_reboot: {} });
}

export async function setPerceptionMode(sn: string, mode: number): Promise<CommandResult> {
  return sendExtendedCommand(sn, { set_perception_mode: { mode } });
}

export async function setSemanticMode(sn: string, mode: number): Promise<CommandResult> {
  return sendExtendedCommand(sn, { set_semantic_mode: { mode } });
}

export async function getPerceptionStatus(sn: string): Promise<CommandResult> {
  return sendExtendedCommand(sn, { get_perception_status: {} });
}

// ── OTA Firmware ────────────────────────────────────────────────

export interface OtaVersion {
  id: number;
  version: string;
  device_type: string;
  release_notes: string | null;
  download_url: string | null;
  md5: string | null;
  created_at: string;
}

export interface FirmwareFile {
  name: string;
  md5: string;
  size: number;
}

export async function fetchOtaVersions(): Promise<OtaVersion[]> {
  const data = await (await get(`${BASE}/ota/versions`)).json();
  return data.versions ?? [];
}

export async function updateOtaVersion(id: number, params: {
  version?: string;
  device_type?: string;
  download_url?: string;
  release_notes?: string;
}): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/ota/versions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
}

export async function deleteOtaVersion(id: number): Promise<void> {
  await fetch(`${BASE}/ota/versions/${id}`, { method: 'DELETE' });
}

export async function triggerOta(sn: string, versionId: number, force = false): Promise<{ ok: boolean; version: string }> {
  return (await post(`${BASE}/ota/trigger/${encodeURIComponent(sn)}`, { version_id: versionId, force })).json();
}

export async function fetchFirmwareFiles(): Promise<FirmwareFile[]> {
  const data = await (await get(`${BASE}/firmware-list`)).json();
  return data.files ?? [];
}

// ── Device Registration ─────────────────────────────────────────

export interface BleDevice {
  name: string;
  mac: string;
  rssi: number;
}

export async function scanBleDevices(duration = 5): Promise<BleDevice[]> {
  const res = await get(`/api/admin/ble-scan?duration=${duration}`);
  const data = await res.json();
  return data.devices ?? [];
}

export async function registerDeviceMac(sn: string, macAddress: string): Promise<void> {
  await post(`/api/admin/devices/${encodeURIComponent(sn)}/mac`, { macAddress });
}

// ── Setup / DNS ──────────────────────────────────────────────────────────────

export interface SetupInfo {
  targetIp: string | null;
  dnsEnabled: boolean;
  port: number;
  mqttPort: number;
}

export async function fetchSetupInfo(): Promise<SetupInfo> {
  const res = await get(`${BASE}/setup/info`);
  return res.json();
}

export async function checkSetupStatus(): Promise<{ hasUsers: boolean }> {
  const res = await fetch(`${BASE}/setup/status`);
  return res.json();
}

export async function createFirstUser(email: string, password: string, username?: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE}/setup/create-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, username }),
  });
  return res.json();
}

/**
 * Test DNS by trying to reach the server via app.lfibot.com.
 * Returns true if DNS correctly resolves to this server.
 */
export async function testDns(serverPort: number): Promise<{ ok: boolean; resolvedTo?: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://app.lfibot.com:${serverPort}/api/dashboard/setup/info`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json() as SetupInfo;
    return { ok: true, resolvedTo: data.targetIp ?? undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'DNS lookup failed' };
  }
}

/**
 * Check of het CA-certificaat vertrouwd is door een HTTPS-fetch te proberen.
 * Als de fetch slaagt → cert is geïnstalleerd en vertrouwd.
 * Als de fetch faalt (SSL error / network error) → cert niet vertrouwd.
 */
export async function checkCertTrusted(): Promise<boolean> {
  // Als de dashboard al via HTTP geopend wordt, is er geen TLS cert nodig
  if (window.location.protocol === 'http:') return true;
  try {
    const httpsUrl = `https://${window.location.hostname}/api/dashboard/setup/status`;
    // AbortSignal.timeout is niet beschikbaar in Safari < 16 — gebruik een fallback
    let signal: AbortSignal | undefined;
    try {
      signal = AbortSignal.timeout(5000);
    } catch {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);
      signal = controller.signal;
    }
    const res = await fetch(httpsUrl, { signal });
    return res.ok;
  } catch {
    return false;
  }
}

export interface UnboundDevice {
  sn: string;
  deviceType: 'mower' | 'charger';
  online: boolean;
  lastSeen: string | null;
}

export async function fetchUnboundDevices(): Promise<UnboundDevice[]> {
  const res = await get(`${BASE}/unbound-devices`);
  const data = await res.json();
  return data.devices ?? [];
}

export async function bindDevice(sn: string, name?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await post(`${BASE}/bind-device`, { sn, name });
    return res.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Onbekende fout' };
  }
}
