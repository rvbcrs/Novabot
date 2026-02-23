import { Request } from 'express';

export interface AuthRequest extends Request {
  userId?: string;
  email?: string;
}

// Exact response format van de echte Novabot API
export function ok(value: unknown = null) {
  return { success: true, code: 200, message: 'request success', value, dateline: Date.now() };
}

export function fail(message: string, code = 500) {
  return { success: false, code, message, value: null, dateline: Date.now() };
}

export interface UserRow {
  id: number;
  app_user_id: string;
  email: string;
  password: string;
  username: string | null;
  machine_token: string | null;
  created_at: string;
}

export interface EquipmentRow {
  id: number;
  equipment_id: string;
  user_id: string;
  mower_sn: string;
  charger_sn: string | null;
  equipment_nick_name: string | null;
  equipment_type_h: string | null;
  mower_version: string | null;
  charger_version: string | null;
  charger_address: string | null;
  charger_channel: string | null;
  mac_address: string | null;
  created_at: string;
}

export interface DeviceRegistryRow {
  mqtt_client_id: string;
  sn: string | null;
  mac_address: string | null;
  mqtt_username: string | null;
  last_seen: string;
}

export interface MapRow {
  id: number;
  map_id: string;
  mower_sn: string;
  map_name: string | null;
  map_area: string | null;
  map_max_min: string | null;
  file_name: string | null;
  file_size: number | null;
  created_at: string;
  updated_at: string;
}

export interface PlanRow {
  id: number;
  plan_id: string;
  equipment_id: string;
  user_id: string;
  start_time: string | null;
  end_time: string | null;
  weekday: string | null;
  repeat: number;
  repeat_count: number;
  repeat_type: string | null;
  work_time: number | null;
  work_area: string | null;
  work_day: string | null;
  created_at: string;
  updated_at: string;
}
