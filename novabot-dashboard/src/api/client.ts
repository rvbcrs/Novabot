import type { DeviceState, SensorDef, MapData, TrailPoint, MapCalibration, Schedule } from '../types';

const BASE = '/api/dashboard';

export async function fetchDevices(): Promise<DeviceState[]> {
  const res = await fetch(`${BASE}/devices`);
  const data = await res.json();
  return data.devices.map((d: DeviceState) => ({
    ...d,
    lastUpdate: Date.now(),
  }));
}

export async function deleteDevice(sn: string): Promise<void> {
  await fetch(`${BASE}/devices/${encodeURIComponent(sn)}`, { method: 'DELETE' });
}

export async function fetchSensors(): Promise<SensorDef[]> {
  const res = await fetch(`${BASE}/sensors`);
  const data = await res.json();
  return data.sensors;
}

export async function fetchMaps(sn: string): Promise<MapData[]> {
  const res = await fetch(`${BASE}/maps/${encodeURIComponent(sn)}`);
  const data = await res.json();
  return data.maps;
}

export async function fetchTrail(sn: string): Promise<TrailPoint[]> {
  const res = await fetch(`${BASE}/trail/${encodeURIComponent(sn)}`);
  const data = await res.json();
  return data.trail;
}

export async function clearTrail(sn: string): Promise<void> {
  await fetch(`${BASE}/trail/${encodeURIComponent(sn)}`, { method: 'DELETE' });
}

export async function fetchCalibration(sn: string): Promise<MapCalibration> {
  const res = await fetch(`${BASE}/calibration/${encodeURIComponent(sn)}`);
  const data = await res.json();
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
  const res = await fetch(`${BASE}/maps/${encodeURIComponent(sn)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapName, mapArea, mapType }),
  });
  const data = await res.json();
  return data.map;
}

export async function deleteMap(sn: string, mapId: string): Promise<void> {
  await fetch(`${BASE}/maps/${encodeURIComponent(sn)}/${encodeURIComponent(mapId)}`, {
    method: 'DELETE',
  });
}

// ── MQTT Commands ──────────────────────────────────────────────

export async function sendCommand(sn: string, command: Record<string, unknown>): Promise<void> {
  await fetch(`${BASE}/command/${encodeURIComponent(sn)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  });
}

// ── Map Export ──────────────────────────────────────────────────

export async function exportMaps(sn: string, chargingStation: { lat: number; lng: number }, chargingOrientation?: number): Promise<string> {
  const res = await fetch(`${BASE}/maps/${encodeURIComponent(sn)}/export-zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chargingStation, chargingOrientation: chargingOrientation ?? 0 }),
  });
  const data = await res.json();
  return data.downloadUrl;
}

// ── Schedules ──────────────────────────────────────────────────

export async function fetchSchedules(sn: string): Promise<Schedule[]> {
  const res = await fetch(`${BASE}/schedules/${encodeURIComponent(sn)}`);
  const data = await res.json();
  return data.schedules;
}

export async function createSchedule(sn: string, schedule: Omit<Schedule, 'scheduleId' | 'mowerSn' | 'createdAt' | 'updatedAt'>): Promise<Schedule> {
  const res = await fetch(`${BASE}/schedules/${encodeURIComponent(sn)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schedule),
  });
  const data = await res.json();
  return data.schedule;
}

export async function updateSchedule(sn: string, scheduleId: string, updates: Partial<Schedule>): Promise<Schedule> {
  const res = await fetch(`${BASE}/schedules/${encodeURIComponent(sn)}/${encodeURIComponent(scheduleId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const data = await res.json();
  return data.schedule;
}

export async function deleteSchedule(sn: string, scheduleId: string): Promise<void> {
  await fetch(`${BASE}/schedules/${encodeURIComponent(sn)}/${encodeURIComponent(scheduleId)}`, {
    method: 'DELETE',
  });
}

export async function sendSchedule(sn: string, scheduleId: string): Promise<void> {
  await fetch(`${BASE}/schedules/${encodeURIComponent(sn)}/${encodeURIComponent(scheduleId)}/send`, {
    method: 'POST',
  });
}
