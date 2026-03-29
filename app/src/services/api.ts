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
}
