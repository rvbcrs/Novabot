import type { DeviceState, SensorDef, MapData, TrailPoint, MapCalibration, Schedule } from '../types';

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

export async function saveCalibration(sn: string, cal: MapCalibration): Promise<void> {
  await fetch(`${BASE}/calibration/${encodeURIComponent(sn)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cal),
  });
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

// ── Map Export ──────────────────────────────────────────────────

export async function exportMaps(sn: string, chargingStation: { lat: number; lng: number }, chargingOrientation?: number): Promise<string> {
  const data = await (await post(`${BASE}/maps/${encodeURIComponent(sn)}/export-zip`, {
    chargingStation, chargingOrientation: chargingOrientation ?? 0,
  })).json();
  return data.downloadUrl;
}

// ── Schedules ──────────────────────────────────────────────────

export async function fetchSchedules(sn: string): Promise<Schedule[]> {
  const data = await (await get(`${BASE}/schedules/${encodeURIComponent(sn)}`)).json();
  return data.schedules ?? [];
}

export async function createSchedule(sn: string, schedule: Omit<Schedule, 'scheduleId' | 'mowerSn' | 'createdAt' | 'updatedAt'>): Promise<Schedule> {
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

export async function addOtaVersion(params: {
  version: string;
  device_type: string;
  download_url: string;
  release_notes?: string;
}): Promise<{ id: number }> {
  return (await post(`${BASE}/ota/versions`, params)).json();
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
