/**
 * Equipment Repository — all equipment + LoRa cache database operations.
 * All queries use prepared statements (SQL injection safe).
 */
import { db } from '../database.js';

export interface EquipmentRow {
  id: number;
  equipment_id: string;
  user_id: string | null;
  mower_sn: string;
  charger_sn: string | null;
  equipment_nick_name: string | null;
  equipment_type_h: string | null;
  mower_version: string | null;
  charger_version: string | null;
  charger_address: string | null;
  charger_channel: string | null;
  mac_address: string | null;
  wifi_name: string | null;
  wifi_password: string | null;
  mower_ip: string | null;
  created_at: string;
}

export interface LoraCacheRow {
  sn: string;
  charger_address: string | null;
  charger_channel: string | null;
}

export interface EquipmentWithUserEmailRow extends EquipmentRow {
  user_email: string | null;
}

export interface BoundEquipmentSnRow {
  mower_sn: string;
  charger_sn: string | null;
}

export interface ResolvedMowerIpRow {
  mower_ip: string | null;
  detected_ip: string | null;
}

export interface CreateEquipmentData {
  equipment_id: string;
  user_id?: string | null;
  mower_sn: string;
  charger_sn?: string | null;
  nick_name?: string | null;
  equipment_type_h?: string | null;
  charger_address?: string | null;
  charger_channel?: string | null;
  mac_address?: string | null;
  mower_version?: string | null;
  charger_version?: string | null;
  mower_ip?: string | null;
}

export class EquipmentRepository {
  // ── Prepared statements (cached for performance) ──

  // Lookups
  private _findByMowerSn = db.prepare('SELECT * FROM equipment WHERE mower_sn = ?');
  private _findByChargerSn = db.prepare('SELECT * FROM equipment WHERE charger_sn = ?');
  private _findByMowerOrChargerSn = db.prepare('SELECT * FROM equipment WHERE mower_sn = ? OR charger_sn = ?');
  private _findByUserId = db.prepare('SELECT * FROM equipment WHERE user_id = ?');
  private _findBySnAndUser = db.prepare('SELECT * FROM equipment WHERE (mower_sn = ? OR charger_sn = ?) AND user_id = ?');
  private _findByIdAndUser = db.prepare('SELECT * FROM equipment WHERE id = ? AND user_id = ?');
  private _findIncompleteByUserId = db.prepare(
    "SELECT * FROM equipment WHERE user_id = ? AND (mower_sn IS NULL OR mower_sn NOT LIKE 'LFIN%' OR charger_sn IS NULL) LIMIT 1"
  );
  private _findByEquipmentId = db.prepare('SELECT * FROM equipment WHERE equipment_id = ?');
  private _findFirstMowerVersionByPrefix = db.prepare('SELECT mower_version FROM equipment WHERE mower_sn LIKE ? LIMIT 1');
  private _listBoundSnForExistingUsers = db.prepare(`
    SELECT mower_sn, charger_sn FROM equipment
    WHERE user_id IS NOT NULL
      AND user_id IN (SELECT app_user_id FROM users)
  `);
  private _listWithUserEmail = db.prepare(`
    SELECT e.*, u.email as user_email
    FROM equipment e
    LEFT JOIN users u ON u.app_user_id = e.user_id
    ORDER BY e.created_at DESC
  `);

  // Mutations
  private _create = db.prepare(`
    INSERT INTO equipment (
      equipment_id, user_id, mower_sn, charger_sn, equipment_nick_name,
      equipment_type_h, charger_address, charger_channel, mac_address,
      mower_version, charger_version, mower_ip
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  private _updateMowerSn = db.prepare('UPDATE equipment SET mower_sn = ? WHERE equipment_id = ?');
  private _updateMowerSnWithMac = db.prepare('UPDATE equipment SET mower_sn = ?, mac_address = ? WHERE equipment_id = ?');
  private _updateChargerSn = db.prepare('UPDATE equipment SET charger_sn = ? WHERE equipment_id = ?');
  private _updateChargerSnFull = db.prepare(
    'UPDATE equipment SET charger_sn = ?, charger_address = ?, charger_channel = ? WHERE equipment_id = ?'
  );
  private _updateNickName = db.prepare('UPDATE equipment SET equipment_nick_name = ? WHERE equipment_id = ?');
  private _updateNickNameByIdAndUser = db.prepare(
    'UPDATE equipment SET equipment_nick_name = ? WHERE id = ? AND user_id = ?'
  );
  private _updateUserAndNickName = db.prepare(`
    UPDATE equipment
    SET user_id = ?, equipment_nick_name = COALESCE(?, equipment_nick_name)
    WHERE equipment_id = ?
  `);
  private _updateMacBySn = db.prepare('UPDATE equipment SET mac_address = ? WHERE mower_sn = ? OR charger_sn = ?');
  private _updateMacBySnIfMissing = db.prepare(
    'UPDATE equipment SET mac_address = ? WHERE (mower_sn = ? OR charger_sn = ?) AND mac_address IS NULL'
  );
  private _updateMowerIp = db.prepare('UPDATE equipment SET mower_ip = ? WHERE mower_sn = ?');
  private _setOpenNova = db.prepare('UPDATE equipment SET is_opennova = 1 WHERE mower_sn = ?');
  private _updateVersionsMower = db.prepare('UPDATE equipment SET mower_version = ? WHERE mower_sn = ?');
  private _updateVersionsCharger = db.prepare('UPDATE equipment SET charger_version = ? WHERE mower_sn = ?');
  private _updateVersionsBoth = db.prepare('UPDATE equipment SET mower_version = ?, charger_version = ? WHERE mower_sn = ?');
  private _updateChargerVersionByChargerSn = db.prepare('UPDATE equipment SET charger_version = ? WHERE charger_sn = ?');
  private _updateVersionsByIdAndUser = db.prepare(`
    UPDATE equipment
    SET mower_version = COALESCE(?, mower_version),
        charger_version = COALESCE(?, charger_version)
    WHERE id = ? AND user_id = ?
  `);
  private _updateVersionsByMowerSnAndUser = db.prepare(`
    UPDATE equipment
    SET mower_version = COALESCE(?, mower_version),
        charger_version = COALESCE(?, charger_version)
    WHERE mower_sn = ? AND user_id = ?
  `);
  private _setUserId = db.prepare('UPDATE equipment SET user_id = ? WHERE equipment_id = ?');
  private _clearUserIdById = db.prepare('UPDATE equipment SET user_id = NULL WHERE id = ?');
  private _clearUserIdBySn = db.prepare('UPDATE equipment SET user_id = NULL WHERE mower_sn = ? OR charger_sn = ?');
  private _clearUserIdByUserId = db.prepare('UPDATE equipment SET user_id = NULL WHERE user_id = ?');
  private _claimOwnership = db.prepare('UPDATE equipment SET user_id = ? WHERE equipment_id = ? AND user_id IS NULL');
  private _rebind = db.prepare(`
    UPDATE equipment
    SET user_id = ?,
        charger_channel = COALESCE(?, charger_channel),
        charger_address = COALESCE(?, charger_address),
        equipment_nick_name = COALESCE(?, equipment_nick_name)
    WHERE equipment_id = ?
  `);
  private _findResolvedMowerIp = db.prepare(`
    SELECT e.mower_ip, d.ip_address as detected_ip
    FROM equipment e
    LEFT JOIN device_registry d ON d.sn = e.mower_sn AND d.ip_address IS NOT NULL
    WHERE e.mower_sn = ?
    ORDER BY d.last_seen DESC LIMIT 1
  `);
  private _swapChargerFirstToPaired = db.prepare(
    'UPDATE equipment SET charger_sn = mower_sn, mower_sn = ? WHERE equipment_id = ?'
  );
  private _setMowerAndChargerSn = db.prepare(
    'UPDATE equipment SET mower_sn = ?, charger_sn = ? WHERE equipment_id = ?'
  );
  private _updateDashboardImportCharger = db.prepare(`
    UPDATE equipment
    SET user_id = ?, charger_address = COALESCE(?, charger_address),
        charger_channel = COALESCE(?, charger_channel),
        mac_address = COALESCE(?, mac_address),
        equipment_nick_name = COALESCE(?, equipment_nick_name)
    WHERE equipment_id = ?
  `);
  private _updateDashboardImportMower = db.prepare(`
    UPDATE equipment
    SET user_id = ?, charger_sn = COALESCE(?, charger_sn),
        mac_address = COALESCE(?, mac_address),
        mower_version = COALESCE(?, mower_version),
        equipment_nick_name = COALESCE(?, equipment_nick_name)
    WHERE equipment_id = ?
  `);

  // Deletes
  private _deleteBySn = db.prepare('DELETE FROM equipment WHERE mower_sn = ? OR charger_sn = ?');
  private _deleteById = db.prepare('DELETE FROM equipment WHERE equipment_id = ?');
  private _deleteStandaloneMower = db.prepare('DELETE FROM equipment WHERE mower_sn = ? AND equipment_id != ?');
  private _deleteStandaloneCharger = db.prepare('DELETE FROM equipment WHERE charger_sn = ? AND equipment_id != ?');

  // Aggregates
  private _count = db.prepare('SELECT COUNT(*) as count FROM equipment');
  private _listAll = db.prepare('SELECT * FROM equipment ORDER BY created_at DESC');

  // ── LoRa cache statements ──
  private _getLoraCache = db.prepare('SELECT charger_address, charger_channel FROM equipment_lora_cache WHERE sn = ?');
  private _listLoraCache = db.prepare('SELECT sn, charger_address, charger_channel FROM equipment_lora_cache');
  private _listUsedLoraAddresses = db.prepare(
    'SELECT charger_address FROM equipment_lora_cache WHERE charger_address IS NOT NULL'
  );
  private _setLoraCache = db.prepare('INSERT OR REPLACE INTO equipment_lora_cache (sn, charger_address, charger_channel) VALUES (?, ?, ?)');
  private _setLoraCacheIfNew = db.prepare('INSERT OR IGNORE INTO equipment_lora_cache (sn, charger_address, charger_channel) VALUES (?, ?, ?)');
  private _upsertLoraCachePreserving = db.prepare(`
    INSERT INTO equipment_lora_cache (sn, charger_address, charger_channel) VALUES (?, ?, ?)
    ON CONFLICT(sn) DO UPDATE SET
      charger_address = COALESCE(excluded.charger_address, charger_address),
      charger_channel = COALESCE(excluded.charger_channel, charger_channel)
  `);
  private _deleteLoraCache = db.prepare('DELETE FROM equipment_lora_cache WHERE sn = ?');

  // ── Equipment lookups ──

  findByMowerSn(sn: string): EquipmentRow | undefined {
    return this._findByMowerSn.get(sn) as EquipmentRow | undefined;
  }

  findByChargerSn(sn: string): EquipmentRow | undefined {
    return this._findByChargerSn.get(sn) as EquipmentRow | undefined;
  }

  findBySn(sn: string): EquipmentRow | undefined {
    return this._findByMowerOrChargerSn.get(sn, sn) as EquipmentRow | undefined;
  }

  findByUserId(userId: string): EquipmentRow[] {
    return this._findByUserId.all(userId) as EquipmentRow[];
  }

  findBySnAndUser(sn: string, userId: string): EquipmentRow | undefined {
    return this._findBySnAndUser.get(sn, sn, userId) as EquipmentRow | undefined;
  }

  findByIdAndUser(id: number, userId: string): EquipmentRow | undefined {
    return this._findByIdAndUser.get(id, userId) as EquipmentRow | undefined;
  }

  findIncompleteByUserId(userId: string): EquipmentRow | undefined {
    return this._findIncompleteByUserId.get(userId) as EquipmentRow | undefined;
  }

  findByEquipmentId(equipmentId: string): EquipmentRow | undefined {
    return this._findByEquipmentId.get(equipmentId) as EquipmentRow | undefined;
  }

  findFirstMowerVersionByPrefix(prefix: string): string | null {
    const row = this._findFirstMowerVersionByPrefix.get(prefix) as { mower_version?: string | null } | undefined;
    return row?.mower_version ?? null;
  }

  listBoundSnForExistingUsers(): BoundEquipmentSnRow[] {
    return this._listBoundSnForExistingUsers.all() as BoundEquipmentSnRow[];
  }

  listWithUserEmail(): EquipmentWithUserEmailRow[] {
    return this._listWithUserEmail.all() as EquipmentWithUserEmailRow[];
  }

  // ── Equipment mutations ──

  create(data: CreateEquipmentData): void {
    this._create.run(
      data.equipment_id,
      data.user_id ?? null,
      data.mower_sn,
      data.charger_sn ?? null,
      data.nick_name ?? null,
      data.equipment_type_h ?? null,
      data.charger_address ?? null,
      data.charger_channel ?? null,
      data.mac_address ?? null,
      data.mower_version ?? null,
      data.charger_version ?? null,
      data.mower_ip ?? null,
    );
  }

  updateMowerSn(equipmentId: string, mowerSn: string, mac?: string): void {
    if (mac) {
      this._updateMowerSnWithMac.run(mowerSn, mac, equipmentId);
    } else {
      this._updateMowerSn.run(mowerSn, equipmentId);
    }
  }

  updateChargerSn(equipmentId: string, chargerSn: string, address?: string, channel?: string): void {
    if (address !== undefined || channel !== undefined) {
      this._updateChargerSnFull.run(chargerSn, address ?? null, channel ?? null, equipmentId);
    } else {
      this._updateChargerSn.run(chargerSn, equipmentId);
    }
  }

  updateNickName(equipmentId: string, name: string): void {
    this._updateNickName.run(name, equipmentId);
  }

  updateNickNameByIdAndUser(id: number, userId: string, name: string | null): void {
    this._updateNickNameByIdAndUser.run(name, id, userId);
  }

  updateUserAndNickName(equipmentId: string, userId: string, name?: string | null): void {
    this._updateUserAndNickName.run(userId, name ?? null, equipmentId);
  }

  updateMacAddress(sn: string, mac: string, onlyIfMissing = false): void {
    if (onlyIfMissing) {
      this._updateMacBySnIfMissing.run(mac, sn, sn);
    } else {
      this._updateMacBySn.run(mac, sn, sn);
    }
  }

  updateMowerIp(mowerSn: string, ipAddress: string): number {
    return this._updateMowerIp.run(ipAddress, mowerSn).changes;
  }

  setOpenNova(mowerSn: string): void {
    this._setOpenNova.run(mowerSn);
  }

  updateVersions(mowerSn: string, mowerVersion?: string, chargerVersion?: string): void {
    if (mowerVersion && chargerVersion) {
      this._updateVersionsBoth.run(mowerVersion, chargerVersion, mowerSn);
    } else if (mowerVersion) {
      this._updateVersionsMower.run(mowerVersion, mowerSn);
    } else if (chargerVersion) {
      this._updateVersionsCharger.run(chargerVersion, mowerSn);
    }
  }

  updateChargerVersionByChargerSn(chargerSn: string, chargerVersion: string): void {
    this._updateChargerVersionByChargerSn.run(chargerVersion, chargerSn);
  }

  updateVersionsByIdAndUser(id: number, userId: string, mowerVersion?: string | null, chargerVersion?: string | null): void {
    this._updateVersionsByIdAndUser.run(mowerVersion ?? null, chargerVersion ?? null, id, userId);
  }

  updateVersionsByMowerSnAndUser(mowerSn: string, userId: string, mowerVersion?: string | null, chargerVersion?: string | null): void {
    this._updateVersionsByMowerSnAndUser.run(mowerVersion ?? null, chargerVersion ?? null, mowerSn, userId);
  }

  setUserId(equipmentId: string, userId: string): void {
    this._setUserId.run(userId, equipmentId);
  }

  unbindById(id: number): void {
    this._clearUserIdById.run(id);
  }

  clearUserIdBySn(sn: string): void {
    this._clearUserIdBySn.run(sn, sn);
  }

  clearUserIdByUserId(userId: string): void {
    this._clearUserIdByUserId.run(userId);
  }

  claimOwnership(equipmentId: string, userId: string): void {
    this._claimOwnership.run(userId, equipmentId);
  }

  rebind(equipmentId: string, userId: string, chargerChannel?: string | null, chargerAddress?: string | null, nickName?: string | null): void {
    this._rebind.run(userId, chargerChannel ?? null, chargerAddress ?? null, nickName ?? null, equipmentId);
  }

  findResolvedMowerIp(mowerSn: string): ResolvedMowerIpRow | undefined {
    return this._findResolvedMowerIp.get(mowerSn) as ResolvedMowerIpRow | undefined;
  }

  swapChargerFirstToPaired(equipmentId: string, mowerSn: string): void {
    this._swapChargerFirstToPaired.run(mowerSn, equipmentId);
  }

  setMowerAndChargerSn(equipmentId: string, mowerSn: string, chargerSn: string): void {
    this._setMowerAndChargerSn.run(mowerSn, chargerSn, equipmentId);
  }

  updateDashboardImportCharger(
    equipmentId: string,
    userId: string,
    chargerAddress?: string | null,
    chargerChannel?: string | null,
    macAddress?: string | null,
    nickName?: string | null,
  ): void {
    this._updateDashboardImportCharger.run(
      userId,
      chargerAddress ?? null,
      chargerChannel ?? null,
      macAddress ?? null,
      nickName ?? null,
      equipmentId,
    );
  }

  updateDashboardImportMower(
    equipmentId: string,
    userId: string,
    chargerSn?: string | null,
    macAddress?: string | null,
    mowerVersion?: string | null,
    nickName?: string | null,
  ): void {
    this._updateDashboardImportMower.run(
      userId,
      chargerSn ?? null,
      macAddress ?? null,
      mowerVersion ?? null,
      nickName ?? null,
      equipmentId,
    );
  }

  // ── Deletes ──

  deleteBySn(sn: string): void {
    this._deleteBySn.run(sn, sn);
  }

  deleteById(equipmentId: string): void {
    this._deleteById.run(equipmentId);
  }

  deleteStandaloneMower(mowerSn: string, exceptId: string): void {
    this._deleteStandaloneMower.run(mowerSn, exceptId);
  }

  deleteStandaloneCharger(chargerSn: string, exceptId: string): void {
    this._deleteStandaloneCharger.run(chargerSn, exceptId);
  }

  // ── Aggregates ──

  count(): number {
    return (this._count.get() as { count: number }).count;
  }

  listAll(): EquipmentRow[] {
    return this._listAll.all() as EquipmentRow[];
  }

  // ── Pair (transactional) ──

  pair(mowerSn: string, chargerSn: string, userId: string): void {
    const tx = db.transaction(() => {
      // Check if a paired record already exists for this mower
      const existing = this.findByMowerSn(mowerSn);
      if (existing) {
        // Update existing record with charger info
        this._updateChargerSn.run(chargerSn, existing.equipment_id);
        if (!existing.user_id) {
          this._setUserId.run(userId, existing.equipment_id);
        }
        // Remove standalone charger records that are now merged
        this._deleteStandaloneCharger.run(chargerSn, existing.equipment_id);
        return;
      }

      // Check if a record exists for this charger
      const chargerRecord = this.findByChargerSn(chargerSn);
      if (chargerRecord) {
        // Update with mower SN
        this._updateMowerSn.run(mowerSn, chargerRecord.equipment_id);
        if (!chargerRecord.user_id) {
          this._setUserId.run(userId, chargerRecord.equipment_id);
        }
        // Remove standalone mower records
        this._deleteStandaloneMower.run(mowerSn, chargerRecord.equipment_id);
        return;
      }

      // No existing record — create a new paired one
      const equipmentId = `EQ_${mowerSn}_${chargerSn}`;
      this._create.run(equipmentId, userId, mowerSn, chargerSn, null, null, null, null);
    });
    tx();
  }

  // ── LoRa cache ──

  getLoraCache(sn: string): { charger_address: string | null; charger_channel: string | null } | undefined {
    return this._getLoraCache.get(sn) as { charger_address: string | null; charger_channel: string | null } | undefined;
  }

  listLoraCache(): LoraCacheRow[] {
    return this._listLoraCache.all() as LoraCacheRow[];
  }

  listUsedLoraAddresses(): number[] {
    const rows = this._listUsedLoraAddresses.all() as Array<{ charger_address: string | null }>;
    return rows
      .map(row => Number(row.charger_address))
      .filter(addr => !Number.isNaN(addr));
  }

  setLoraCache(sn: string, address: string, channel: string): void {
    this._setLoraCache.run(sn, address, channel);
  }

  setLoraCacheIfNew(sn: string, address: string, channel: string): void {
    this._setLoraCacheIfNew.run(sn, address, channel);
  }

  upsertLoraCachePreserving(sn: string, address?: string | null, channel?: string | null): void {
    this._upsertLoraCachePreserving.run(sn, address ?? null, channel ?? null);
  }

  deleteLoraCache(sn: string): void {
    this._deleteLoraCache.run(sn);
  }

  syncLoraPair(mowerSn: string, chargerSn: string, address: string, channel: string): void {
    const tx = db.transaction(() => {
      this._setLoraCache.run(mowerSn, address, channel);
      this._setLoraCache.run(chargerSn, address, channel);
    });
    tx();
  }
}

export const equipmentRepo = new EquipmentRepository();
