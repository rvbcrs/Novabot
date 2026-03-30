/**
 * API client for the OpenNova server.
 *
 * All methods accept a token parameter for authentication.
 * The server URL is passed to the constructor.
 */

import type {
  LoginResponse,
  RegisterResponse,
  EquipmentListResponse,
  Equipment,
} from '../types';

export class AuthError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'AuthError';
  }
}

export interface CommandResult {
  ok: boolean;
  command: string;
  encrypted?: boolean;
  size?: number;
  error?: string;
}

export interface MapData {
  mapId: string;
  mapName: string;
  mapType: string;
  mapArea: Array<{ lat: number; lng: number }>;
}

export interface Schedule {
  id: number;
  sn: string;
  day_of_week: number; // 0=Sun, 1=Mon, ...
  start_hour: number;
  start_minute: number;
  duration_minutes: number;
  enabled: boolean;
  map_id?: string;
  cutting_height?: number;
  path_angle?: number;
  created_at: string;
}

export interface WorkRecord {
  id: number;
  sn: string;
  start_time: string;
  end_time: string | null;
  duration_seconds: number;
  area_m2: number;
  status: string;
  map_name: string | null;
}

export interface TrailPoint {
  lat: number;
  lng: number;
  ts: number;
}

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

export interface RobotMessage {
  id: number;
  sn: string;
  type: string;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
}

export class ApiClient {
  private baseUrl: string;

  constructor(serverUrl: string) {
    // Ensure no trailing slash
    this.baseUrl = serverUrl.replace(/\/+$/, '');
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options?: {
      body?: Record<string, unknown>;
      token?: string;
    },
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};

    if (options?.token) {
      headers['Authorization'] = options.token;
    }

    if (options?.body != null) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method,
      headers,
      body: options?.body != null ? JSON.stringify(options.body) : undefined,
    });

    if (res.status === 401) {
      throw new AuthError();
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  /**
   * Login with email and password.
   * Password can be sent as plain text -- the server supports both plain and AES encrypted.
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    return this.request<LoginResponse>('POST', '/api/nova-user/appUser/login', {
      body: { email, password },
    });
  }

  /**
   * Register a new user account.
   */
  async register(
    email: string,
    password: string,
    username?: string,
  ): Promise<RegisterResponse> {
    return this.request<RegisterResponse>('POST', '/api/nova-user/appUser/regist', {
      body: { email, password, username: username ?? undefined },
    });
  }

  /**
   * Get the list of equipment (mowers/chargers) for the authenticated user.
   */
  async getEquipmentList(token: string): Promise<EquipmentListResponse> {
    return this.request<EquipmentListResponse>(
      'POST',
      '/api/nova-user/equipment/userEquipmentList',
      { token },
    );
  }

  /**
   * Get equipment details by serial number.
   */
  async getEquipmentBySN(
    token: string,
    sn: string,
  ): Promise<{ success: boolean; code: number; value: Equipment | null }> {
    return this.request('POST', '/api/nova-user/equipment/getEquipmentBySN', {
      body: { sn },
      token,
    });
  }

  /**
   * Send an MQTT command to a device via the dashboard API.
   */
  async sendCommand(
    sn: string,
    command: Record<string, unknown>,
  ): Promise<CommandResult> {
    return this.request<CommandResult>(
      'POST',
      `/api/dashboard/command/${encodeURIComponent(sn)}`,
      { body: { command } },
    );
  }

  /**
   * Fetch map data for a given serial number.
   */
  async fetchMaps(sn: string): Promise<{ maps: MapData[] }> {
    return this.request<{ maps: MapData[] }>(
      'GET',
      `/api/dashboard/maps/${encodeURIComponent(sn)}`,
    );
  }

  /**
   * Health check -- used for server discovery and connection verification.
   */
  async healthCheck(): Promise<{ server: string; mqtt: string }> {
    return this.request<{ server: string; mqtt: string }>(
      'GET',
      '/api/setup/health',
    );
  }

  // ── Schedules ────────────────────────────────────────────────────────

  async getSchedules(sn: string): Promise<Schedule[]> {
    return this.request<Schedule[]>('GET', `/api/dashboard/schedules/${enc(sn)}`);
  }

  async createSchedule(
    sn: string,
    schedule: Omit<Schedule, 'id' | 'sn' | 'created_at'>,
  ): Promise<{ ok: boolean; id: number }> {
    return this.request('POST', `/api/dashboard/schedules/${enc(sn)}`, {
      body: schedule as unknown as Record<string, unknown>,
    });
  }

  async updateSchedule(
    sn: string,
    scheduleId: number,
    updates: Partial<Omit<Schedule, 'id' | 'sn' | 'created_at'>>,
  ): Promise<{ ok: boolean }> {
    return this.request('POST', `/api/dashboard/schedules/${enc(sn)}/${scheduleId}`, {
      body: { ...updates, _method: 'PATCH' } as Record<string, unknown>,
    });
  }

  async deleteSchedule(sn: string, scheduleId: number): Promise<{ ok: boolean }> {
    return this.request('POST', `/api/dashboard/schedules/${enc(sn)}/${scheduleId}`, {
      body: { _method: 'DELETE' },
    });
  }

  // ── Work History ─────────────────────────────────────────────────────

  async getWorkRecords(sn: string): Promise<WorkRecord[]> {
    return this.request<WorkRecord[]>('GET', `/api/dashboard/work-records/${enc(sn)}`);
  }

  // ── GPS Trail ────────────────────────────────────────────────────────

  async getTrail(sn: string): Promise<TrailPoint[]> {
    return this.request<TrailPoint[]>('GET', `/api/dashboard/trail/${enc(sn)}`);
  }

  // ── Headlight ────────────────────────────────────────────────────────

  async setHeadlight(sn: string, on: boolean): Promise<CommandResult> {
    return this.sendCommand(sn, { set_headlight: on ? 1 : 0 });
  }

  // ── Joystick (manual control) ────────────────────────────────────────

  async joystickStart(sn: string, holdType: number): Promise<CommandResult> {
    return this.sendCommand(sn, { start_move: holdType });
  }

  async joystickMove(
    sn: string,
    xw: number,
    yv: number,
  ): Promise<CommandResult> {
    return this.sendCommand(sn, { mst: { x_w: xw, y_v: yv, z_g: 0 } });
  }

  async joystickStop(sn: string): Promise<CommandResult> {
    return this.sendCommand(sn, { stop_move: {} });
  }

  // ── Device Info ──────────────────────────────────────────────────────

  async getDevices(): Promise<Array<{
    sn: string;
    deviceType: string;
    online: boolean;
    nickname?: string;
    sysVersion?: string;
  }>> {
    return this.request('GET', '/api/dashboard/devices');
  }

  // ── Cutting Height ───────────────────────────────────────────────────

  async setCuttingHeight(sn: string, height: number): Promise<CommandResult> {
    return this.sendCommand(sn, { set_cutting_height: height });
  }

  // ── Advanced Settings ────────────────────────────────────────────────

  async getParaInfo(sn: string): Promise<CommandResult> {
    return this.sendCommand(sn, { get_para_info: {} });
  }

  async setObstacleSensitivity(sn: string, level: number): Promise<CommandResult> {
    return this.sendCommand(sn, { set_para_info: { obstacle_avoidance_sensitivity: level } });
  }

  async setPathDirection(sn: string, angle: number): Promise<CommandResult> {
    return this.sendCommand(sn, { set_para_info: { path_direction: angle } });
  }

  // ── OTA ──────────────────────────────────────────────────────────────

  async getOtaVersions(): Promise<OtaVersion[]> {
    return this.request<OtaVersion[]>('GET', '/api/dashboard/ota/versions');
  }

  async getFirmwareFiles(): Promise<FirmwareFile[]> {
    return this.request<FirmwareFile[]>('GET', '/api/dashboard/firmware-list');
  }

  async triggerOta(
    sn: string,
    versionId: number,
    force = true,
  ): Promise<{ ok: boolean; command?: string; version?: string }> {
    return this.request('POST', `/api/dashboard/ota/trigger/${enc(sn)}`, {
      body: { version_id: versionId, force },
    });
  }

  // ── Messages (robot alerts) ──────────────────────────────────────────

  async getRobotMessages(sn: string): Promise<RobotMessage[]> {
    // Uses the novabot-message endpoint
    return this.request<RobotMessage[]>(
      'GET',
      `/api/dashboard/work-records/${enc(sn)}`,
    ).catch(() => []);
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
