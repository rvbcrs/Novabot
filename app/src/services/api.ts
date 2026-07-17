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

/** Progress of the server-orchestrated auto re-anchor (Novabot-cq3). */
export type ReanchorPhase =
  | 'idle' | 'check' | 'anchor' | 'relock' | 'wait' | 'needs_drive' | 'needs_position' | 'dock' | 'verify' | 'done' | 'error';
export interface ReanchorStatus {
  phase: ReanchorPhase;
  /** Dutch, human-readable. Kept for the (Dutch) dashboard + back-compat with
   *  servers that predate msgKey. The app prefers msgKey when present. */
  message: string;
  /** Stable i18n key for `message` so the app can translate it (en/nl/de/fr).
   *  Interpolated with pose ({{x}},{{y}}) and dist ({{dist}}) where relevant. */
  msgKey?: string;
  ok?: boolean;
  error?: string;
  pose?: { x: number; y: number };
  /** Distance (m) from the origin for the verify_failed message. */
  dist?: number;
  ts: number;
  /** Live gating booleans the server computes fresh on each status poll.
   *  onDock: mower physically on the dock now (strict, battery-FULL excluded).
   *  rtkFixed: real RTK Fixed now. relocked: has completed off-dock -> RUNNING +
   *  Fixed since the re-anchor began. Verify needs relocked && onDock; retry-auto
   *  needs onDock && rtkFixed. Optional for back-compat with older servers. */
  onDock?: boolean;
  rtkFixed?: boolean;
  relocked?: boolean;
}

export interface LocalPoint { x: number; y: number }

export interface MapData {
  mapId: string;
  mapName: string;
  mapType: string;
  /** Firmware slot identifier, e.g. "map0", "map0_0_obstacle",
   *  "map0tocharge_unicom". Carries the stable mower-side index that
   *  start_navigation.area depends on (#14, #18). */
  canonicalName?: string | null;
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
  /** #51: "every N days" mode. 0 = use weekdays. */
  intervalDays?: number;
  /** YYYY-MM-DD anchor date for interval mode. */
  intervalAnchorDate?: string | null;
  /** #51 follow-up: rotate path_direction by alternateStep° each time
   *  the schedule fires. Server multiplies the fire count by the step
   *  and wraps at 360. */
  alternateDirection?: boolean;
  alternateStep?: number;
  /** Server-derived: this schedule is the one currently being executed by the mower. */
  currentlyRunning?: boolean;
  /** Server-derived: ISO timestamp when the rain monitor paused this schedule's session, or null. */
  rainPausedAt?: string | null;
  /** YYYY-MM-DD van de dag die overgeslagen wordt; zelf-wissend na de skip. */
  skipDate?: string | null;
  /** Richting die de volgende run echt gebruikt (base + alternate rotatie). */
  nextPathDirection?: number;
  created_at: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
}

/** Shape returned by `GET /api/dashboard/work-records/:sn`. Server side
 *  comes from `messageRepo.findWorkRecordsByEquipmentId` (see
 *  `dashboard.ts`); fields are camelCase via the JSON serializer. */
export interface WorkRecord {
  recordId: string;
  /** Mower-supplied timestamp ('05/06 12:09' or 'YYYY-MM-DD HH:MM:SS'). */
  dateTime: string | null;
  /** Coverage minutes — server uses #17 round 6 jsonBody parse. */
  workTime: number | null;
  workArea: number | null;
  /** Wire enum (cutterhigh 0-7); display = value + 2 cm. Legacy rows may be mm. */
  cutGrassHeight: number | null;
  /** Mow direction in degrees (0-359), frozen at record time. */
  pathDirection: number | null;
  mapNames: string | null;
  workStatus: string | null;
  startWay: string | null;
  /** Server-side wall-clock when the row landed. */
  workRecordDate: string | null;
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

export interface MapEditDraftDto { points: { x: number; y: number }[]; deleted: boolean; isNew: boolean }
export interface MapEditEntryDto {
  mapId: string; canonical: string; mapType: 'work' | 'obstacle' | 'unicom';
  alias: string | null; parentMap: string | null;
  points: { x: number; y: number }[]; draft: MapEditDraftDto | null;
}
export interface MapEditGeometryDto { maps: MapEditEntryDto[]; pendingSync: boolean; hasVersions: boolean }
export interface MapEditApplyDto {
  ok: boolean; reason?: string;
  validation?: { ok: boolean; errors: { canonical: string; code: string; message: string }[]; warnings: { canonical: string; code: string; message: string }[] };
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
  skipDate?: string | null;
  nextPathDirection?: number;
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
  intervalDays?: number;
  intervalAnchorDate?: string | null;
  alternateDirection?: boolean;
  alternateStep?: number;
  skipDate?: string | null;
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
    intervalDays: (input as { intervalDays?: number }).intervalDays ?? 0,
    intervalAnchorDate: (input as { intervalAnchorDate?: string | null }).intervalAnchorDate ?? null,
    alternateDirection: (input as { alternateDirection?: boolean }).alternateDirection ?? false,
    alternateStep: (input as { alternateStep?: number }).alternateStep ?? 90,
    skipDate: input.skipDate ?? null,
    nextPathDirection: input.nextPathDirection ?? pathDirection,
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

  /** Post-restore re-anchor (server-orchestrated):
   * - 'auto' (default): the whole sequence — reanchor_pos with the docked Fixed
   *   GPS, drive ~1m back to re-lock, visual ArUco dock, then self-verify the
   *   docked position is on the origin before clearing frame_unvalidated. Poll
   *   getReanchorStatus() for progress.
   * - 'verify': manual backup — re-check the docked position against the origin
   *   alone (after the operator joysticked the mower back onto the dock).
   * - 'drive'/'spin'/'dock': legacy single-step diagnostics. */
  async reanchor(
    sn: string,
    action: 'auto' | 'verify' | 'drive' | 'spin' | 'dock' | 'continue_dock' | 'invalidate' = 'auto',
  ): Promise<{ ok: boolean; error?: string; message?: string }> {
    return this.request<{ ok: boolean; error?: string; message?: string }>(
      'POST',
      `/api/dashboard/reanchor/${encodeURIComponent(sn)}`,
      { body: { action } },
    );
  }

  /** Auto re-anchor progress, polled by the re-anchor wizard. */
  async getReanchorStatus(sn: string): Promise<ReanchorStatus> {
    const r = await this.request<{ ok: boolean; status: ReanchorStatus }>(
      'GET',
      `/api/dashboard/reanchor/${encodeURIComponent(sn)}/status`,
    );
    return r.status;
  }

  async clearError(sn: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      'POST',
      `/api/dashboard/error/${encodeURIComponent(sn)}/clear`,
      { body: {} },
    );
  }

  async setRainIgnoreSession(sn: string, active: boolean): Promise<{ ok: boolean; active: boolean }> {
    return this.request<{ ok: boolean; active: boolean }>(
      'POST',
      `/api/dashboard/rain-ignore-session/${encodeURIComponent(sn)}`,
      { body: { active } },
    );
  }

  /**
   * Register an Expo push token for a bound mower. Idempotent on the
   * server side — re-registering with the same (token, sn) is a no-op
   * upsert. Auth required; uses the same JWT as other authenticated
   * routes.
   */
  async registerPushToken(args: {
    token: string;
    sn: string;
    platform: 'ios' | 'android';
  }): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(
      'POST',
      '/api/push/register',
      { body: args },
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

  // Telefoon-tijdzone meesturen zodat de server-side runner start_time in de
  // zone van de gebruiker vuurt i.p.v. de container-TZ. Zelfde detectie als
  // BLE-provisioning (ble.ts): expo-localization eerst, dan Intl.
  private async deviceTimezone(): Promise<string | undefined> {
    try {
      const Localization = await import('expo-localization');
      const tz = Localization.getCalendars?.()?.[0]?.timeZone;
      if (tz) return tz;
    } catch { /* ignore */ }
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; }
    catch { return undefined; }
  }

  async createSchedule(
    sn: string,
    schedule: ScheduleWritePayload,
  ): Promise<{ ok: boolean; schedule?: Schedule }> {
    return this.request('POST', `/api/dashboard/schedules/${enc(sn)}`, {
      body: { timezone: await this.deviceTimezone(), ...schedule } as unknown as Record<string, unknown>,
    });
  }

  async updateSchedule(
    sn: string,
    scheduleId: number | string,
    updates: ScheduleWritePayload,
  ): Promise<{ ok: boolean }> {
    return this.request('PATCH', `/api/dashboard/schedules/${enc(sn)}/${enc(String(scheduleId))}`, {
      body: { timezone: await this.deviceTimezone(), ...updates } as Record<string, unknown>,
    });
  }

  async deleteSchedule(sn: string, scheduleId: number | string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/api/dashboard/schedules/${enc(sn)}/${enc(String(scheduleId))}`);
  }

  // ── Work History ─────────────────────────────────────────────────────

  async getWorkRecords(sn: string): Promise<WorkRecord[]> {
    // Server returns `{ records, total }`. Extract the array so callers can
    // keep treating the result as a flat WorkRecord[]. The HistoryScreen
    // showed "No mowing sessions yet" because we used to assume the body
    // *was* an array — Array.isArray fell through to [] and the user saw
    // nothing even when 1300+ rows existed in the DB.
    const body = await this.request<{ records?: WorkRecord[] } | WorkRecord[]>(
      'GET', `/api/dashboard/work-records/${enc(sn)}`,
    );
    if (Array.isArray(body)) return body;
    return Array.isArray(body?.records) ? body.records : [];
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

  /** Start a normal mow via the mower-side `mow_zone` orchestrator (research/
   *  documents/unicom-follow-transit-design.md). Replaces the old direct
   *  `start_navigation` send: the mower-side orchestrator now undocks, drives
   *  the recorded map-to-map unicom line when a transit is needed, then runs
   *  coverage through robot_decision, streaming phase updates
   *  (`mow_zone_status`) back on the extended_response channel. `direction`
   *  is the mow angle in degrees (0-180), or null to use the saved default. */
  async mowZone(
    sn: string,
    payload: { map: string; cutterhigh: number; area?: number; direction?: number | null },
  ): Promise<{ ok: boolean; command: string }> {
    return this.sendExtended(sn, { mow_zone: payload });
  }

  /** Read-only mapping preflight health gate (OpenNova firmware only). Returns
   *  verdict ok|warn|block + per-check detail. Throws on stock firmware/timeout
   *  (no extended_commands.py) — callers should treat that as "skip the gate". */
  async mappingPreflight(sn: string): Promise<{
    ok: boolean;
    verdict: 'ok' | 'warn' | 'block';
    checks: Record<string, { status: string; detail: string }>;
    reasons: string[];
  }> {
    return this.request('POST', `/api/dashboard/mapping-preflight/${enc(sn)}`, { body: {} });
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

  // ── Map geometry editing ─────────────────────────────────────────────

  async getMapEditGeometry(sn: string): Promise<MapEditGeometryDto> {
    return this.request<MapEditGeometryDto>('GET', `/api/dashboard/maps/${encodeURIComponent(sn)}/edit/geometry`);
  }

  async saveMapEditDraft(sn: string, body: {
    canonical?: string; mapType?: 'work' | 'obstacle'; parentMap?: string;
    points?: { x: number; y: number }[]; deleted?: boolean;
  }): Promise<{ ok: boolean; canonical?: string }> {
    const url = `${this.baseUrl}/api/dashboard/maps/${encodeURIComponent(sn)}/edit/draft`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json() as Promise<{ ok: boolean; canonical?: string }>;
  }

  async discardMapEditDrafts(sn: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/api/dashboard/maps/${encodeURIComponent(sn)}/edit/drafts`);
  }

  private async postMapEdit(sn: string, action: 'apply' | 'revert'): Promise<MapEditApplyDto> {
    const res = await fetch(`${this.baseUrl}/api/dashboard/maps/${encodeURIComponent(sn)}/edit/${action}`, { method: 'POST' });
    try { return (await res.json()) as MapEditApplyDto; }
    catch { return { ok: false, reason: `http_${res.status}` }; }
  }
  async applyMapEdits(sn: string): Promise<MapEditApplyDto> { return this.postMapEdit(sn, 'apply'); }
  async revertMapEdits(sn: string): Promise<MapEditApplyDto> { return this.postMapEdit(sn, 'revert'); }

  // ── Cutting Height ───────────────────────────────────────────────────

  async setCuttingHeight(sn: string, height: number): Promise<CommandResult> {
    return this.sendCommand(sn, { set_para_info: { defaultCuttingHeight: height } });
  }

  // ── Advanced Settings ────────────────────────────────────────────────

  /** Read the user's SAVED mower settings from the server (device_settings
   *  table). These are the source of truth the Mower Settings screen displays,
   *  because the mower firmware does NOT persist set_para_info over a reconnect
   *  (it reverts to provisioning defaults). Returns a flat key->value map; keys
   *  match the sensor-override keys (path_direction, obstacle_avoidance_sensitivity,
   *  headlight, sound, manual_controller_v/w, defaultCuttingHeight, ...). */
  async getDeviceSettings(sn: string): Promise<{ settings: Record<string, string> }> {
    const res = await this.request<{ ok: boolean; settings?: Record<string, string> }>(
      'GET',
      `/api/dashboard/device-settings/${enc(sn)}`,
    );
    return { settings: res.settings ?? {} };
  }

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

  /** Check the remote manifest for firmware newer than what's installed
   *  locally. Server-side filters out anything already on disk and sorts
   *  the result newest-first. Uses the unauth dashboard mirror of the
   *  admin endpoint so the mobile app doesn't need an admin token. */
  async checkFirmwareUpdates(): Promise<{
    available: Array<{ version: string; device_type: string; url: string; filename: string; md5: string; description: string; installed: boolean }>;
    installed: Array<{ version: string; device_type: string; md5: string }>;
  }> {
    return this.request('GET', '/api/dashboard/firmware-check-updates');
  }

  /** Download a firmware from the remote manifest into the local
   *  firmware/ directory and register it in the OTA versions table. */
  async downloadFirmware(args: {
    url: string;
    filename: string;
    version: string;
    device_type: string;
    md5: string;
    description?: string;
  }): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/dashboard/firmware-download', { body: args });
  }

  async getFirmwareFiles(): Promise<FirmwareFile[]> {
    return this.request<FirmwareFile[]>('GET', '/api/dashboard/firmware-list');
  }

  async triggerOta(
    sn: string,
    versionId: number,
    force = true,
  ): Promise<{ ok: boolean; command?: string; version?: string; backup?: { filename: string; bytes: number; createdAt: number; reason: string } | null; error?: string; detail?: string }> {
    try {
      return await this.request('POST', `/api/dashboard/ota/trigger/${enc(sn)}`, {
        body: { version_id: versionId, force },
      });
    } catch (e: unknown) {
      // request() throws `new Error("HTTP <status>: <body-text>")` on non-2xx.
      // Try to parse the JSON body from the message to surface server block reason
      // (409 BACKUP_FAILED / 500 BETA_GATE_ERROR) so the UI can display it.
      if (e instanceof Error) {
        const jsonMatch = e.message.match(/^HTTP \d+: ([\s\S]*)$/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]) as Record<string, unknown>;
            return {
              ok: false,
              error: typeof parsed.error === 'string' ? parsed.error : 'OTA_FAILED',
              detail: typeof parsed.detail === 'string' ? parsed.detail : e.message,
            };
          } catch {
            // body was not JSON
          }
        }
        return { ok: false, error: 'OTA_FAILED', detail: e.message };
      }
      return { ok: false, error: 'OTA_FAILED', detail: String(e) };
    }
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
