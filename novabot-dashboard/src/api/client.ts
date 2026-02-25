import type { DeviceState, SensorDef, MapData, TrailPoint, MapCalibration } from '../types';

const BASE = '/api/dashboard';

export async function fetchDevices(): Promise<DeviceState[]> {
  const res = await fetch(`${BASE}/devices`);
  const data = await res.json();
  return data.devices.map((d: DeviceState) => ({
    ...d,
    lastUpdate: Date.now(),
  }));
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
