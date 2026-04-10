/**
 * Device Repository — device_registry + device_factory database operations.
 * All queries use prepared statements (SQL injection safe).
 */
import { db } from '../database.js';

export interface DeviceRegistryRow {
  mqtt_client_id: string;
  sn: string | null;
  mac_address: string | null;
  mqtt_username: string | null;
  ip_address: string | null;
  last_seen: string;
}

export interface DeviceFactoryRow {
  sn: string;
  device_type: string | null;
  mac_address: string | null;
  equipment_type: string | null;
  sys_version: string | null;
  charger_address: number | null;
  charger_channel: number | null;
  mqtt_account: string | null;
  mqtt_password: string | null;
  model: string | null;
}

export interface ImportFactoryDevice {
  sn: string;
  device_type?: string | null;
  mac_address?: string | null;
  equipment_type?: string | null;
  sys_version?: string | null;
  charger_address?: number | null;
  charger_channel?: number | null;
  mqtt_account?: string | null;
  mqtt_password?: string | null;
  model?: string | null;
}

export class DeviceRepository {
  // ── Prepared statements (cached for performance) ──

  // Device registry
  private _upsertDevice = db.prepare(`
    INSERT OR REPLACE INTO device_registry (mqtt_client_id, sn, mac_address, mqtt_username, last_seen)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  private _findBySn = db.prepare('SELECT * FROM device_registry WHERE sn = ?');
  private _findByClientId = db.prepare('SELECT * FROM device_registry WHERE mqtt_client_id = ?');
  private _findRecentlyOnline = db.prepare(
    "SELECT * FROM device_registry WHERE last_seen >= datetime('now', '-' || ? || ' minutes') ORDER BY last_seen DESC"
  );
  private _countOnline = db.prepare(
    "SELECT COUNT(*) as count FROM device_registry WHERE last_seen >= datetime('now', '-' || ? || ' minutes')"
  );
  private _countAll = db.prepare('SELECT COUNT(*) as count FROM device_registry');
  private _deleteBySn = db.prepare('DELETE FROM device_registry WHERE sn = ?');

  // Device factory
  private _getFactoryDevice = db.prepare('SELECT * FROM device_factory WHERE sn = ?');
  private _getFactoryMac = db.prepare('SELECT mac_address FROM device_factory WHERE sn = ?');
  private _insertFactory = db.prepare(`
    INSERT OR IGNORE INTO device_factory
      (sn, device_type, mac_address, equipment_type, sys_version,
       charger_address, charger_channel, mqtt_account, mqtt_password, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // ── Device registry methods ──

  upsertDevice(clientId: string, sn: string | null, mac: string | null, username?: string | null): void {
    this._upsertDevice.run(clientId, sn, mac, username ?? null);
  }

  findBySn(sn: string): DeviceRegistryRow | undefined {
    return this._findBySn.get(sn) as DeviceRegistryRow | undefined;
  }

  findByClientId(clientId: string): DeviceRegistryRow | undefined {
    return this._findByClientId.get(clientId) as DeviceRegistryRow | undefined;
  }

  findRecentlyOnline(minutes = 5): DeviceRegistryRow[] {
    return this._findRecentlyOnline.all(minutes) as DeviceRegistryRow[];
  }

  countOnline(minutes = 5): number {
    return (this._countOnline.get(minutes) as { count: number }).count;
  }

  countAll(): number {
    return (this._countAll.get() as { count: number }).count;
  }

  deleteBySn(sn: string): void {
    this._deleteBySn.run(sn);
  }

  // ── Device factory methods ──

  getFactoryDevice(sn: string): DeviceFactoryRow | undefined {
    return this._getFactoryDevice.get(sn) as DeviceFactoryRow | undefined;
  }

  getFactoryMac(sn: string): string | null {
    const row = this._getFactoryMac.get(sn) as { mac_address: string | null } | undefined;
    return row?.mac_address ?? null;
  }

  importFactoryDevices(devices: ImportFactoryDevice[]): number {
    const tx = db.transaction(() => {
      let imported = 0;
      for (const d of devices) {
        if (!d.sn) continue;
        this._insertFactory.run(
          d.sn,
          d.device_type ?? null,
          d.mac_address ?? null,
          d.equipment_type ?? null,
          d.sys_version ?? null,
          d.charger_address ?? null,
          d.charger_channel ?? null,
          d.mqtt_account ?? null,
          d.mqtt_password ?? null,
          d.model ?? null,
        );
        imported++;
      }
      return imported;
    });
    return tx();
  }
}

export const deviceRepo = new DeviceRepository();
