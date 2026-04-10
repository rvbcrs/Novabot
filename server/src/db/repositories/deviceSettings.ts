/**
 * Device Settings Repository — persisted device_settings cache operations.
 */
import { db } from '../database.js';

export interface DeviceSettingRow {
  sn: string;
  key: string;
  value: string;
  updated_at: string;
}

export class DeviceSettingsRepository {
  private _listAll = db.prepare('SELECT sn, key, value, updated_at FROM device_settings');
  private _upsert = db.prepare(`
    INSERT INTO device_settings (sn, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(sn, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  listAll(): DeviceSettingRow[] {
    return this._listAll.all() as DeviceSettingRow[];
  }

  upsert(sn: string, key: string, value: string): void {
    this._upsert.run(sn, key, value);
  }
}

export const deviceSettingsRepo = new DeviceSettingsRepository();
