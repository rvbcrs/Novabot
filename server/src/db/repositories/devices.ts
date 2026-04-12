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

export interface DeviceAdminRow {
  mqtt_client_id: string;
  sn: string | null;
  mac_address: string | null;
  mqtt_username: string | null;
  last_seen: string;
  ip_address: string | null;
  equipment_id: string | null;
  user_id: string | null;
  equipment_nick_name: string | null;
  lora_address: string | null;
  lora_channel: string | null;
  is_online: number;
  device_type: string;
  is_bound: number;
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
  private _insertIfMissing = db.prepare(`
    INSERT OR IGNORE INTO device_registry (mqtt_client_id, sn, mac_address, mqtt_username, last_seen)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  private _upsertDevicePreserving = db.prepare(`
    INSERT INTO device_registry (mqtt_client_id, sn, mac_address, mqtt_username, last_seen)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mqtt_client_id) DO UPDATE SET
      sn = COALESCE(excluded.sn, sn),
      mac_address = COALESCE(excluded.mac_address, mac_address),
      mqtt_username = excluded.mqtt_username,
      last_seen = excluded.last_seen
  `);
  private _updateMacBySn = db.prepare(
    "UPDATE device_registry SET mac_address = ?, last_seen = datetime('now') WHERE sn = ?"
  );
  private _updateMacIfMissingBySn = db.prepare(
    'UPDATE device_registry SET mac_address = ? WHERE sn = ? AND mac_address IS NULL'
  );
  private _updateIpBySn = db.prepare('UPDATE device_registry SET ip_address = ? WHERE sn = ?');
  private _findPreferredMacBySnAndUsername = db.prepare(`
    SELECT mac_address FROM device_registry
    WHERE sn = ? AND mac_address IS NOT NULL AND mqtt_username = ?
    ORDER BY last_seen DESC LIMIT 1
  `);
  private _findMacBySnExcludingApp = db.prepare(`
    SELECT mac_address FROM device_registry
    WHERE sn = ? AND mac_address IS NOT NULL AND mqtt_username NOT LIKE 'app:%'
    ORDER BY last_seen DESC LIMIT 1
  `);
  private _findRecentlyOnline = db.prepare(
    "SELECT * FROM device_registry WHERE last_seen >= datetime('now', '-' || ? || ' minutes') ORDER BY last_seen DESC"
  );
  private _findRecentlyOnlineBySnPrefix = db.prepare(`
    SELECT * FROM device_registry
    WHERE sn LIKE ? AND last_seen >= datetime('now', '-' || ? || ' minutes')
    ORDER BY last_seen DESC
  `);
  private _hasRecentlyOnlineBySnPrefix = db.prepare(`
    SELECT 1
    FROM device_registry
    WHERE sn LIKE ? AND datetime(last_seen) > datetime('now', '-' || ? || ' minutes')
    LIMIT 1
  `);
  private _countOnline = db.prepare(
    "SELECT COUNT(*) as count FROM device_registry WHERE last_seen >= datetime('now', '-' || ? || ' minutes')"
  );
  private _countAll = db.prepare('SELECT COUNT(*) as count FROM device_registry');
  private _listAll = db.prepare('SELECT * FROM device_registry ORDER BY last_seen DESC');
  private _listLatestBySn = db.prepare(`
    SELECT d.* FROM device_registry d
    INNER JOIN (
      SELECT sn, MAX(last_seen) as max_seen FROM device_registry
      WHERE sn IS NOT NULL GROUP BY sn
    ) latest ON d.sn = latest.sn AND d.last_seen = latest.max_seen
    ORDER BY d.last_seen DESC
  `);
  private _deleteBySn = db.prepare('DELETE FROM device_registry WHERE sn = ?');
  private _listAdminDevices = db.prepare(`
    SELECT d.mqtt_client_id, d.sn,
           COALESCE(d.mac_address, f.mac_address) as mac_address,
           d.mqtt_username, MAX(d.last_seen) as last_seen, d.ip_address,
           e.equipment_id, e.user_id, e.equipment_nick_name,
           l.charger_address as lora_address, l.charger_channel as lora_channel,
           CASE WHEN julianday('now') - julianday(MAX(d.last_seen)) < 0.003 THEN 1 ELSE 0 END as is_online,
           CASE WHEN d.sn LIKE 'LFIC%' THEN 'charger'
                WHEN d.sn LIKE 'LFIN%' THEN 'mower'
                ELSE 'unknown' END as device_type,
           CASE WHEN e.user_id IS NOT NULL THEN 1 ELSE 0 END as is_bound,
           CASE WHEN d.sn = e.mower_sn AND e.charger_sn IS NOT NULL THEN e.charger_sn
                WHEN d.sn = e.charger_sn AND e.mower_sn IS NOT NULL AND e.mower_sn LIKE 'LFIN%' THEN e.mower_sn
                ELSE NULL END as paired_with,
           CASE WHEN d.sn LIKE 'LFIN%' THEN e.mower_version
                WHEN d.sn LIKE 'LFIC%' THEN e.charger_version
                ELSE NULL END as firmware_version,
           COALESCE(e.is_opennova, 0) as is_opennova,
           COALESCE(e.is_active, 0) as is_active
    FROM device_registry d
    LEFT JOIN equipment e ON (e.mower_sn = d.sn OR e.charger_sn = d.sn)
    LEFT JOIN device_factory f ON f.sn = d.sn
    LEFT JOIN equipment_lora_cache l ON l.sn = d.sn
    WHERE d.sn IS NOT NULL AND (d.sn LIKE 'LFIN%' OR d.sn LIKE 'LFIC%')
    GROUP BY d.sn
    ORDER BY is_online DESC, d.last_seen DESC
  `);

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

  upsertDevicePreserving(clientId: string, sn: string | null, mac: string | null, username?: string | null): void {
    this._upsertDevicePreserving.run(clientId, sn, mac, username ?? null);
  }

  insertIfMissing(clientId: string, sn: string | null, mac: string | null, username?: string | null): void {
    this._insertIfMissing.run(clientId, sn, mac, username ?? null);
  }

  findBySn(sn: string): DeviceRegistryRow | undefined {
    return this._findBySn.get(sn) as DeviceRegistryRow | undefined;
  }

  findByClientId(clientId: string): DeviceRegistryRow | undefined {
    return this._findByClientId.get(clientId) as DeviceRegistryRow | undefined;
  }

  updateMacBySn(sn: string, mac: string): void {
    this._updateMacBySn.run(mac, sn);
  }

  updateMacIfMissingBySn(sn: string, mac: string): void {
    this._updateMacIfMissingBySn.run(mac, sn);
  }

  updateIpBySn(sn: string, ipAddress: string): void {
    this._updateIpBySn.run(ipAddress, sn);
  }

  findPreferredMacBySnAndUsername(sn: string, username: string): string | null {
    const row = this._findPreferredMacBySnAndUsername.get(sn, username) as { mac_address: string | null } | undefined;
    return row?.mac_address ?? null;
  }

  findMacBySnExcludingApp(sn: string): string | null {
    const row = this._findMacBySnExcludingApp.get(sn) as { mac_address: string | null } | undefined;
    return row?.mac_address ?? null;
  }

  findRecentlyOnline(minutes = 5): DeviceRegistryRow[] {
    return this._findRecentlyOnline.all(minutes) as DeviceRegistryRow[];
  }

  findRecentlyOnlineBySnPrefix(prefix: string, minutes = 5): DeviceRegistryRow[] {
    return this._findRecentlyOnlineBySnPrefix.all(prefix, minutes) as DeviceRegistryRow[];
  }

  hasRecentlyOnlineBySnPrefix(prefix: string, minutes = 5): boolean {
    return !!this._hasRecentlyOnlineBySnPrefix.get(prefix, minutes);
  }

  countOnline(minutes = 5): number {
    return (this._countOnline.get(minutes) as { count: number }).count;
  }

  countAll(): number {
    return (this._countAll.get() as { count: number }).count;
  }

  listAll(): DeviceRegistryRow[] {
    return this._listAll.all() as DeviceRegistryRow[];
  }

  listLatestBySn(): DeviceRegistryRow[] {
    return this._listLatestBySn.all() as DeviceRegistryRow[];
  }

  deleteBySn(sn: string): void {
    this._deleteBySn.run(sn);
  }

  listAdminDevices(): DeviceAdminRow[] {
    return this._listAdminDevices.all() as DeviceAdminRow[];
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
