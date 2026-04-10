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

export interface CreateEquipmentData {
  equipment_id: string;
  user_id?: string | null;
  mower_sn: string;
  charger_sn?: string | null;
  nick_name?: string | null;
  charger_address?: string | null;
  charger_channel?: string | null;
  mac_address?: string | null;
}

export class EquipmentRepository {
  // ── Prepared statements (cached for performance) ──

  // Lookups
  private _findByMowerSn = db.prepare('SELECT * FROM equipment WHERE mower_sn = ?');
  private _findByChargerSn = db.prepare('SELECT * FROM equipment WHERE charger_sn = ?');
  private _findByMowerOrChargerSn = db.prepare('SELECT * FROM equipment WHERE mower_sn = ? OR charger_sn = ?');
  private _findByUserId = db.prepare('SELECT * FROM equipment WHERE user_id = ?');
  private _findIncompleteByUserId = db.prepare(
    'SELECT * FROM equipment WHERE user_id = ? AND (mower_sn IS NULL OR charger_sn IS NULL) LIMIT 1'
  );
  private _findByEquipmentId = db.prepare('SELECT * FROM equipment WHERE equipment_id = ?');

  // Mutations
  private _create = db.prepare(`
    INSERT INTO equipment (equipment_id, user_id, mower_sn, charger_sn, equipment_nick_name,
      charger_address, charger_channel, mac_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  private _updateMowerSn = db.prepare('UPDATE equipment SET mower_sn = ? WHERE equipment_id = ?');
  private _updateMowerSnWithMac = db.prepare('UPDATE equipment SET mower_sn = ?, mac_address = ? WHERE equipment_id = ?');
  private _updateChargerSn = db.prepare('UPDATE equipment SET charger_sn = ? WHERE equipment_id = ?');
  private _updateChargerSnFull = db.prepare(
    'UPDATE equipment SET charger_sn = ?, charger_address = ?, charger_channel = ? WHERE equipment_id = ?'
  );
  private _updateNickName = db.prepare('UPDATE equipment SET equipment_nick_name = ? WHERE equipment_id = ?');
  private _updateVersionsMower = db.prepare('UPDATE equipment SET mower_version = ? WHERE mower_sn = ?');
  private _updateVersionsCharger = db.prepare('UPDATE equipment SET charger_version = ? WHERE mower_sn = ?');
  private _updateVersionsBoth = db.prepare('UPDATE equipment SET mower_version = ?, charger_version = ? WHERE mower_sn = ?');
  private _setUserId = db.prepare('UPDATE equipment SET user_id = ? WHERE equipment_id = ?');
  private _claimOwnership = db.prepare('UPDATE equipment SET user_id = ? WHERE equipment_id = ? AND user_id IS NULL');

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
  private _setLoraCache = db.prepare('INSERT OR REPLACE INTO equipment_lora_cache (sn, charger_address, charger_channel) VALUES (?, ?, ?)');
  private _setLoraCacheIfNew = db.prepare('INSERT OR IGNORE INTO equipment_lora_cache (sn, charger_address, charger_channel) VALUES (?, ?, ?)');

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

  findIncompleteByUserId(userId: string): EquipmentRow | undefined {
    return this._findIncompleteByUserId.get(userId) as EquipmentRow | undefined;
  }

  findByEquipmentId(equipmentId: string): EquipmentRow | undefined {
    return this._findByEquipmentId.get(equipmentId) as EquipmentRow | undefined;
  }

  // ── Equipment mutations ──

  create(data: CreateEquipmentData): void {
    this._create.run(
      data.equipment_id,
      data.user_id ?? null,
      data.mower_sn,
      data.charger_sn ?? null,
      data.nick_name ?? null,
      data.charger_address ?? null,
      data.charger_channel ?? null,
      data.mac_address ?? null,
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

  updateVersions(mowerSn: string, mowerVersion?: string, chargerVersion?: string): void {
    if (mowerVersion && chargerVersion) {
      this._updateVersionsBoth.run(mowerVersion, chargerVersion, mowerSn);
    } else if (mowerVersion) {
      this._updateVersionsMower.run(mowerVersion, mowerSn);
    } else if (chargerVersion) {
      this._updateVersionsCharger.run(chargerVersion, mowerSn);
    }
  }

  setUserId(equipmentId: string, userId: string): void {
    this._setUserId.run(userId, equipmentId);
  }

  claimOwnership(equipmentId: string, userId: string): void {
    this._claimOwnership.run(userId, equipmentId);
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

  setLoraCache(sn: string, address: string, channel: string): void {
    this._setLoraCache.run(sn, address, channel);
  }

  setLoraCacheIfNew(sn: string, address: string, channel: string): void {
    this._setLoraCacheIfNew.run(sn, address, channel);
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
