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

export interface LocalPoint { x: number; y: number }

export interface MapData {
  mapId: string;
  mapName: string;
  mapType: string;
  mapArea: Array<LocalPoint>;
}

export interface ChargerGps { lat: number; lng: number }

export interface Schedule {
  id: string;
  scheduleId: string;
  sn: string;
  mowerSn?: string;
  day_of_week: number; // 0=Sun, 1=Mon, ...
  weekdays: number[];
  start_hour: number;
  start_minute: number;
  startTime: string;
  endTime?: string | null;
  duration_minutes: number;
  enabled: boolean;
  map_id?: string;
  map_name?: string | null;
  mapId?: string | null;
  mapName?: string | null;
  cutting_height?: number;
  path_direction?: number;
  cuttingHeight?: number;    // server returns camelCase
  pathDirection?: number;    // server returns camelCase
  rain_pause?: boolean;
  rainPause?: boolean;       // server returns camelCase
  workMode?: number;
  taskMode?: number;
  lastTriggeredAt?: string | null;
  scheduleName?: string | null;
  /** Server-derived: this schedule is the one currently being executed by the mower. */
  currentlyRunning?: boolean;
  /** Server-derived: ISO timestamp when the rain monitor paused this schedule's session, or null. */
  rainPausedAt?: string | null;
  created_at: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
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

interface ScheduleDto {
  scheduleId?: string;
  mowerSn?: string;
  startTime?: string;
  endTime?: string | null;
  weekdays?: number[];
  enabled?: boolean;
  mapId?: string | null;
  mapName?: string | null;
  cuttingHeight?: number;
  pathDirection?: number;
  workMode?: number;
  taskMode?: number;
  rainPause?: boolean;
  lastTriggeredAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ScheduleWritePayload {
  scheduleName?: string;
  startTime?: string;
  endTime?: string | null;
  weekdays?: number[];
  enabled?: boolean;
  mapId?: string | null;
  mapName?: string | null;
  cuttingHeight?: number;
  pathDirection?: number;
  workMode?: number;
  taskMode?: number;
  rainPause?: boolean;
  start_hour?: number;
  start_minute?: number;
  duration_minutes?: number;
  cutting_height?: number;
  path_direction?: number;
  rain_pause?: boolean;
}

type ScheduleLike = Partial<Schedule> & ScheduleDto;

function normalizeSchedule(input: ScheduleLike): Schedule {
  const scheduleId = String(input.scheduleId ?? input.id ?? '');
  const mowerSn = input.mowerSn ?? input.sn ?? '';
  const weekdays = Array.isArray(input.weekdays)
    ? [...(input.weekdays ?? [])]
    : [input.day_of_week ?? 0];
  const startTime =
    input.startTime
    ?? `${String(input.start_hour ?? 0).padStart(2, '0')}:${String(input.start_minute ?? 0).padStart(2, '0')}`;
  const [startHour = 0, startMinute = 0] = startTime.split(':').map((part) => Number(part) || 0);
  const endTime = input.endTime ?? null;
  const durationMinutes = (() => {
    if (typeof input.duration_minutes === 'number') return input.duration_minutes;
    if (!endTime) return 60;
    const [endHour = 0, endMinute = 0] = endTime.split(':').map((part) => Number(part) || 0);
    const startTotal = startHour * 60 + startMinute;
    const endTotal = endHour * 60 + endMinute;
    const rawDelta = endTotal - startTotal;
    return rawDelta > 0 ? rawDelta : rawDelta + 24 * 60;
  })();
  const cuttingHeight = input.cuttingHeight ?? input.cutting_height;
  const pathDirection = input.pathDirection ?? input.path_direction;
  const rainPause = input.rainPause ?? input.rain_pause;
  const createdAt = input.createdAt ?? input.created_at ?? '';
  const updatedAt = input.updatedAt ?? input.updated_at ?? createdAt;

  return {
    id: scheduleId,
    scheduleId,
    sn: mowerSn,
    mowerSn,
    day_of_week: weekdays[0] ?? 0,
    weekdays,
    start_hour: startHour,
    start_minute: startMinute,
    startTime,
    endTime,
    duration_minutes: durationMinutes,
    enabled: input.enabled ?? false,
    map_id: input.mapId ?? input.map_id,
    map_name: input.mapName ?? input.map_name,
    mapId: input.mapId ?? input.map_id ?? null,
    mapName: input.mapName ?? input.map_name ?? null,
    cutting_height: cuttingHeight,
    path_direction: pathDirection,
    cuttingHeight,
    pathDirection,
    rain_pause: rainPause,
    rainPause,
    workMode: input.workMode,
    taskMode: input.taskMode,
    lastTriggeredAt: input.lastTriggeredAt ?? null,
    created_at: createdAt,
    createdAt,
    updated_at: updatedAt,
    updatedAt,
  };
}

export class ApiClient {
  private baseUrl: string;

  constructor(serverUrl: string) {
    // Ensure no trailing slash
    this.baseUrl = serverUrl.replace(/\/+$/, '');
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

  async clearError(sn: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      'POST',
      `/api/dashboard/error/${encodeURIComponent(sn)}/clear`,
      { body: {} },
    );
  }

  /**
   * Fetch map data for a given serial number.
   */
  async fetchMaps(sn: string): Promise<{ maps: MapData[]; chargerGps: ChargerGps | null; chargerOrientation: number }> {
    return this.request<{ maps: MapData[]; chargerGps: ChargerGps | null; chargerOrientation: number }>(
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
    const response = await this.request<{ schedules?: Array<Schedule | ScheduleDto> } | Array<Schedule | ScheduleDto>>(
      'GET',
      `/api/dashboard/schedules/${enc(sn)}`,
    );
    const rows = Array.isArray(response) ? response : response.schedules ?? [];
    return rows.map((row) => normalizeSchedule(row));
  }

  async createSchedule(
    sn: string,
    schedule: ScheduleWritePayload,
  ): Promise<{ ok: boolean; schedule?: Schedule }> {
    return this.request('POST', `/api/dashboard/schedules/${enc(sn)}`, {
      body: schedule as unknown as Record<string, unknown>,
    });
  }

  async updateSchedule(
    sn: string,
    scheduleId: number | string,
    updates: ScheduleWritePayload,
  ): Promise<{ ok: boolean }> {
    return this.request('PATCH', `/api/dashboard/schedules/${enc(sn)}/${enc(String(scheduleId))}`, {
      body: updates as Record<string, unknown>,
    });
  }

  async deleteSchedule(sn: string, scheduleId: number | string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/api/dashboard/schedules/${enc(sn)}/${enc(String(scheduleId))}`);
  }

  // ── Work History ─────────────────────────────────────────────────────

  async getWorkRecords(sn: string): Promise<WorkRecord[]> {
    return this.request<WorkRecord[]>('GET', `/api/dashboard/work-records/${enc(sn)}`);
  }

  // ── GPS Trail ────────────────────────────────────────────────────────

  async getTrail(sn: string): Promise<TrailPoint[]> {
    return this.request<TrailPoint[]>('GET', `/api/dashboard/trail/${enc(sn)}`);
  }

  async clearTrail(sn: string): Promise<void> {
    await this.request('DELETE', `/api/dashboard/trail/${enc(sn)}`);
  }

  async getPlannedPath(sn: string): Promise<Array<{ id: string; points: LocalPoint[] }>> {
    const res = await this.request<{ paths: Array<{ id: string; points: LocalPoint[] }> }>('GET', `/api/dashboard/planned-path/${enc(sn)}`);
    return res.paths ?? [];
  }

  /** Rename a map (work zone, obstacle, unicom…) — server updates the DB row
   *  and (if the mower is online) also sends `rename_map` MQTT so the mower
   *  persists the new name in its own CSV metadata. */
  async renameMap(sn: string, mapId: string, mapName: string): Promise<void> {
    await this.request('PATCH', `/api/dashboard/maps/${enc(sn)}/${enc(mapId)}`, {
      body: { mapName },
    });
  }

  /** Send a command to the mower's extended_commands.py backchannel (topic
   *  `novabot/extended/<SN>`). Used for things the stock MQTT API doesn't
   *  expose — blade control, perception modes, log retrieval, etc. */
  async sendExtended(sn: string, command: Record<string, unknown>): Promise<{ ok: boolean; command: string }> {
    return this.request('POST', `/api/dashboard/extended/${enc(sn)}`, { body: command });
  }

  /** Preview coverage path — what the mower WILL mow, gefetchte via onze
   *  broker intercept van get_preview_cover_path_respond. Veel nauwkeuriger
   *  dan gegenereerde rechte strepen omdat dit het ECHTE pad is dat de
   *  coverage planner heeft berekend. */
  async getPreviewPath(sn: string): Promise<Array<{ id: string; points: LocalPoint[] }>> {
    const res = await this.request<{ paths: Array<{ id: string; points: LocalPoint[] }> }>('GET', `/api/dashboard/preview-path/${enc(sn)}`);
    return res.paths ?? [];
  }

  /** Server-triggered preview generation: stuurt generate_preview_cover_path
   *  naar de mower, wacht tot de coverage planner klaar is, haalt het pad op
   *  via extended_commands en retourneert de parsed paths. Gebruik dit wanneer
   *  je een verse preview nodig hebt (bv. na wijziging van path direction of
   *  bij openen van start-mow flow). */
  async refreshPreviewPath(sn: string, opts?: { covDirection?: number; mapIds?: number | number[] }): Promise<Array<{ id: string; points: LocalPoint[] }>> {
    const body: Record<string, unknown> = {};
    if (opts?.covDirection !== undefined) body.cov_direction = opts.covDirection;
    if (opts?.mapIds !== undefined) body.map_ids = opts.mapIds;
    const res = await this.request<{ ok: boolean; paths: Array<{ id: string; points: LocalPoint[] }>; error?: string }>('POST', `/api/dashboard/refresh-preview-path/${enc(sn)}`, body);
    if (!res.ok) throw new Error(res.error || 'refresh-preview-path failed');
    return res.paths ?? [];
  }

  /** Server-triggered plan path fetch — voor gebruik tijdens mowing als je de
   *  echte berekende paden (niet de gegenereerde rechte strepen) wilt tonen. */
  async refreshPlanPath(sn: string): Promise<Array<{ id: string; points: LocalPoint[] }>> {
    const res = await this.request<{ ok: boolean; paths: Array<{ id: string; points: LocalPoint[] }>; error?: string }>('POST', `/api/dashboard/refresh-plan-path/${enc(sn)}`, {});
    if (!res.ok) throw new Error(res.error || 'refresh-plan-path failed');
    return res.paths ?? [];
  }

  // ── Headlight ────────────────────────────────────────────────────────

  async setHeadlight(sn: string, on: boolean): Promise<CommandResult> {
    return this.sendCommand(sn, { set_para_info: { headlight: on ? 1 : 0 } });
  }

  // ── Equipment nickname ───────────────────────────────────────────────

  /** Rename a mower (or charger). Mirrors Novabot v2.4.0's
   *  /api/nova-user/equipment/updateEquipmentNickName payload shape so the
   *  same endpoint serves both apps. */
  /** Rename a mower via the dashboard endpoint (no JWT needed — local-network
   *  only, consistent with the rest of OpenNova's app→server traffic). The
   *  Novabot-compat `/api/nova-user/equipment/updateEquipmentNickName` route
   *  still exists for the official Novabot app. */
  async updateEquipmentNickName(sn: string, nickname: string): Promise<{ ok: boolean }> {
    return this.request('PATCH', `/api/dashboard/equipment/${encodeURIComponent(sn)}/nickname`, {
      body: { nickname },
    });
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
    // Official Flutter app: mst is List<int> [v*100, w*100, 8]
    return this.sendCommand(sn, { mst: [Math.round(xw * 100), Math.round(yv * 100), 8] });
  }

  async joystickStop(sn: string): Promise<CommandResult> {
    return this.sendCommand(sn, { stop_move: null });
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

  async deleteDevice(sn: string): Promise<{ ok: boolean }> {
    const url = `${this.baseUrl}/api/dashboard/devices/${enc(sn)}`;
    const res = await fetch(url, { method: 'DELETE' });
    return res.json();
  }

  // ── Device sets (charger↔mower pairing) ─────────────────────────────

  async getDeviceSets(): Promise<{
    sets: Array<{
      loraAddress: number | null;
      charger: { sn: string; online: boolean } | null;
      mower: { sn: string; online: boolean } | null;
    }>;
  }> {
    return this.request('GET', '/api/dashboard/device-sets');
  }

  async pairMower(mowerSn: string, chargerSn: string): Promise<{ ok: boolean; loraAddress?: number; error?: string }> {
    return this.request('POST', '/api/dashboard/pair-mower', { body: { mowerSn, chargerSn } });
  }

  async queryMowerLora(mowerSn: string): Promise<{ result: number; addr?: number; channel?: number; error?: string }> {
    return this.request('POST', `/api/dashboard/lora/query-mower/${mowerSn}`);
  }

  async setMowerLora(mowerSn: string, addr: number, channel: number): Promise<{ ok: boolean }> {
    return this.request('POST', `/api/dashboard/lora/set-mower/${mowerSn}`, { body: { addr, channel, hc: 20, lc: 14 } });
  }

  async getChargerLora(chargerSn: string): Promise<{ address: number; channel: number; hc: number; lc: number } | null> {
    try {
      return await this.request('GET', `/api/dashboard/lora/for-charger/${chargerSn}`);
    } catch { return null; }
  }

  // ── Map calibration ────────────────────────────────────────────────

  async fetchCalibration(sn: string): Promise<{ offsetLat: number; offsetLng: number; rotation: number; scale: number; chargerLat?: number | null; chargerLng?: number | null } | null> {
    try {
      const data = await this.request<{ calibration: any }>('GET', `/api/dashboard/calibration/${encodeURIComponent(sn)}`);
      return data.calibration ?? null;
    } catch { return null; }
  }

  async saveCalibration(sn: string, cal: { offsetLat: number; offsetLng: number; rotation: number; scale: number; chargerLat?: number; chargerLng?: number }): Promise<void> {
    await fetch(`${this.baseUrl}/api/dashboard/calibration/${encodeURIComponent(sn)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cal),
    });
  }

  // ── LoRa address allocation ─────────────────────────────────────────

  /** Get next free LoRa address for a new charger */
  async getNextLoraAddress(): Promise<{ address: number; channel: number; hc: number; lc: number }> {
    return this.request('GET', '/api/dashboard/lora/next-address');
  }

  /** Pair-aware LoRa resolution voor provisioning (server-side truth).
   *  Regels conform user-spec 2026-04-22 (bijgewerkt na live verificatie):
   *  - charger: max(bestaande charger addrs) + 1, channel 16
   *  - mower:   paart met orphan charger (IDENTIEKE addr EN channel), of
   *             max(bestaande mower addrs) + 1 als geen orphan (channel 16).
   *  Mower en charger zitten altijd op HETZELFDE LoRa-paar (addr+channel
   *  identiek), bewezen 22 apr 2026 bij working-lora-pair addr=718 ch=17.
   *  `basis` legt uit welke regel werd getriggerd (UI/debug).
   *
   *  Fallback: als de server nog de oude code draait (endpoint 404), val
   *  terug op `/lora/next-address` + `listLoraCache` client-side. Zo werkt
   *  de app ook voor users die nog niet docker-rebuilded hebben.
   */
  async resolveLora(type: 'charger' | 'mower'): Promise<{
    ok: boolean;
    address: number;
    channel: number;
    hc: number;
    lc: number;
    basis: string;
  }> {
    try {
      return await this.request('GET', `/api/dashboard/lora/resolve?type=${type}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!msg.includes('404')) throw e;
      // Server = oude versie → fallback via getNextLoraAddress + getDeviceSets.
      if (type === 'charger') {
        const resp = await this.getNextLoraAddress();
        return { ok: true, address: resp.address, channel: resp.channel, hc: resp.hc, lc: resp.lc, basis: 'legacy-next-address' };
      }
      // mower: zoek paired charger via device-sets
      try {
        const sets = await this.getDeviceSets();
        const orphan = sets.sets?.find(s => s.charger?.online && s.loraAddress && !s.mower);
        if (orphan?.loraAddress) {
          // Oude server heeft geen channel data → default ch16 (zelfde als charger).
          return { ok: true, address: orphan.loraAddress, channel: 16, hc: 20, lc: 14, basis: 'legacy-orphan-charger' };
        }
      } catch { /* ignore */ }
      // Geen orphan: gebruik next-address + ch16 (zelfde default als charger).
      const resp = await this.getNextLoraAddress();
      return { ok: true, address: resp.address, channel: 16, hc: 20, lc: 14, basis: 'legacy-mower-fallback' };
    }
  }

  /** Check if a LoRa addr (+ optional channel) is already assigned. Returns
   *  the list of devices using the same addr so the UI can warn the user
   *  before provisioning onto a conflicting address. */
  async checkLoraAvailability(addr: number, channel?: number): Promise<{
    ok: boolean;
    inUse: boolean;
    conflicts: Array<{ sn: string; addr: number | null; channel: number | null }>;
  }> {
    const q = channel != null ? `?addr=${addr}&channel=${channel}` : `?addr=${addr}`;
    return this.request('GET', `/api/dashboard/lora/check${q}`);
  }

  /** Get LoRa params for a specific charger (for mower provisioning) */
  async getLoraForCharger(chargerSn: string): Promise<{ address: number; channel: number; hc: number; lc: number }> {
    return this.request('GET', `/api/dashboard/lora/for-charger/${enc(chargerSn)}`);
  }

  /** Register LoRa params after charger provisioning */
  async registerLora(sn: string, address: number, channel: number): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/dashboard/lora/register', {
      body: { sn, address, channel },
    });
  }

  /**
   * Mark a mower as the active equipment pair on the server. The cloud-API
   * (userEquipmentList) filters on `is_active=1` so the official Novabot app
   * only ever sees one pair at a time. OpenNova itself is unaffected — the
   * app still addresses every mower directly.
   */
  async setActiveMower(sn: string): Promise<{ ok: boolean; activeMowerSn?: string; error?: string }> {
    return this.request('POST', '/api/dashboard/equipment/set-active', { body: { sn } });
  }

  /**
   * Recalibrate the charger pose stored in the mower's map_info.json with
   * the mower's current reported x/y/theta. Use when coverage paths drift
   * off-target because the map frame is mis-aligned with the physical
   * dock. Mower must be physically on dock with battery_state=CHARGING,
   * otherwise the server returns 400 unless `force: true` is passed.
   */
  async recalibrateChargingPose(
    sn: string,
    opts: { force?: boolean } = {},
  ): Promise<{
    ok: boolean;
    pose?: { x: number; y: number; theta: number };
    error?: string;
    batteryState?: string;
  }> {
    return this.request('POST', `/api/dashboard/maps/${enc(sn)}/recalibrate-charging-pose`, {
      body: { force: opts.force === true },
    });
  }

  // ── Cutting Height ───────────────────────────────────────────────────

  async setCuttingHeight(sn: string, height: number): Promise<CommandResult> {
    return this.sendCommand(sn, { set_para_info: { defaultCuttingHeight: height } });
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
    // Server retourneert { ok: true, versions: [...] } sinds de auto-sync
    // toegevoegd is; oudere server-versies gaven een kale array terug. We
    // accepteren beide vormen defensief zodat de app blijft werken bij
    // gemixte deployments.
    const res = await this.request<OtaVersion[] | { ok: boolean; versions: OtaVersion[] }>(
      'GET', '/api/dashboard/ota/versions',
    );
    if (Array.isArray(res)) return res;
    return (res as { versions?: OtaVersion[] }).versions ?? [];
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
