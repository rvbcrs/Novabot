/**
 * Integration test — auto-bind + auto-pair flow.
 * Tests the logic from autoBindDevice() in mapSync.ts by exercising
 * the repository methods directly (no MQTT side effects).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../db/database.js';
import { userRepo, equipmentRepo } from '../../db/repositories/index.js';

describe('Auto-bind', () => {
  const userId = 'user-auto';
  const mowerSn = 'LFIN2230700238';
  const chargerSn = 'LFIC1230700004';

  beforeEach(() => {
    userRepo.create(userId, 'auto@test.com', 'hash', 'auto');
  });

  it('creates equipment when user exists (mower)', () => {
    // Simulate autoBindDevice for a mower: findFirst → create record
    const user = userRepo.findFirst();
    expect(user).toBeDefined();

    equipmentRepo.create({
      equipment_id: 'eq-auto-mower',
      user_id: user!.app_user_id,
      mower_sn: mowerSn,
      charger_sn: null,
    });

    const row = equipmentRepo.findByMowerSn(mowerSn);
    expect(row).toBeDefined();
    expect(row!.user_id).toBe(userId);
    expect(row!.mower_sn).toBe(mowerSn);
  });

  it('creates equipment when user exists (charger uses SN as mower_sn placeholder)', () => {
    // Charger-only: mower_sn = charger SN (NOT NULL constraint)
    const user = userRepo.findFirst();
    equipmentRepo.create({
      equipment_id: 'eq-auto-charger',
      user_id: user!.app_user_id,
      mower_sn: chargerSn,
      charger_sn: chargerSn,
    });

    const row = equipmentRepo.findBySn(chargerSn);
    expect(row).toBeDefined();
    expect(row!.user_id).toBe(userId);
    expect(row!.charger_sn).toBe(chargerSn);
    // mower_sn is the charger SN placeholder
    expect(row!.mower_sn).toBe(chargerSn);
  });

  it('does nothing when no user exists', () => {
    // Wipe users table (setup already cleared, but we created one in beforeEach)
    db.exec('DELETE FROM users');

    const user = userRepo.findFirst();
    expect(user).toBeUndefined();
    // autoBindDevice would return early — no equipment created
    expect(equipmentRepo.count()).toBe(0);
  });

  it('auto-pairs charger to existing mower-only record', () => {
    // Mower-only record: has mower_sn=LFIN, charger_sn=NULL
    equipmentRepo.create({
      equipment_id: 'eq-mower-only',
      user_id: userId,
      mower_sn: mowerSn,
      charger_sn: null,
    });

    // Simulate autoBindDevice for charger: find incomplete, update charger_sn
    const incomplete = equipmentRepo.findIncompleteByUserId(userId);
    expect(incomplete).toBeDefined();
    expect(incomplete!.charger_sn).toBeNull();

    equipmentRepo.updateChargerSn(incomplete!.equipment_id, chargerSn);

    const updated = equipmentRepo.findByMowerSn(mowerSn);
    expect(updated!.charger_sn).toBe(chargerSn);
    expect(updated!.mower_sn).toBe(mowerSn);
  });

  it('auto-pairs mower to existing charger-only record', () => {
    // Charger-only record: mower_sn = charger SN (placeholder), charger_sn = charger SN
    equipmentRepo.create({
      equipment_id: 'eq-charger-only',
      user_id: userId,
      mower_sn: chargerSn,  // placeholder
      charger_sn: chargerSn,
    });

    // findIncompleteByUserId should find this (mower_sn NOT LIKE 'LFIN%')
    const incomplete = equipmentRepo.findIncompleteByUserId(userId);
    expect(incomplete).toBeDefined();
    expect(incomplete!.mower_sn).toBe(chargerSn); // placeholder, not LFIN

    // autoBindDevice updates mower_sn to real mower SN
    equipmentRepo.updateMowerSn(incomplete!.equipment_id, mowerSn);

    const updated = equipmentRepo.findByMowerSn(mowerSn);
    expect(updated).toBeDefined();
    expect(updated!.mower_sn).toBe(mowerSn);
    expect(updated!.charger_sn).toBe(chargerSn);
  });

  it('skips already-bound devices', () => {
    equipmentRepo.create({
      equipment_id: 'eq-bound',
      user_id: userId,
      mower_sn: mowerSn,
      charger_sn: chargerSn,
    });

    // autoBindDevice checks: existing?.user_id → return early
    const existing = equipmentRepo.findBySn(mowerSn);
    expect(existing).toBeDefined();
    expect(existing!.user_id).toBe(userId);
    // No second record should be created
    expect(equipmentRepo.count()).toBe(1);
  });

  it('claims ownership on unbound existing record', () => {
    // Equipment exists but user_id is NULL
    equipmentRepo.create({
      equipment_id: 'eq-unbound',
      user_id: null,
      mower_sn: mowerSn,
      charger_sn: null,
    });

    const existing = equipmentRepo.findBySn(mowerSn);
    expect(existing).toBeDefined();
    expect(existing!.user_id).toBeNull();

    // autoBindDevice: claimOwnership sets user_id
    equipmentRepo.claimOwnership(existing!.equipment_id, userId);

    const claimed = equipmentRepo.findBySn(mowerSn);
    expect(claimed!.user_id).toBe(userId);
  });
});

describe('findIncompleteByUserId', () => {
  const userId = 'user-inc';

  beforeEach(() => {
    userRepo.create(userId, 'inc@test.com', 'hash', 'inc');
  });

  it('finds charger-only records (mower_sn NOT LIKE LFIN%)', () => {
    // Charger-only: mower_sn is charger SN placeholder
    equipmentRepo.create({
      equipment_id: 'eq-c-only',
      user_id: userId,
      mower_sn: 'LFIC1230700004',
      charger_sn: 'LFIC1230700004',
    });

    const inc = equipmentRepo.findIncompleteByUserId(userId);
    expect(inc).toBeDefined();
    expect(inc!.mower_sn).toBe('LFIC1230700004');
  });

  it('finds mower-only records (charger_sn IS NULL)', () => {
    equipmentRepo.create({
      equipment_id: 'eq-m-only',
      user_id: userId,
      mower_sn: 'LFIN2230700238',
      charger_sn: null,
    });

    const inc = equipmentRepo.findIncompleteByUserId(userId);
    expect(inc).toBeDefined();
    expect(inc!.mower_sn).toBe('LFIN2230700238');
    expect(inc!.charger_sn).toBeNull();
  });

  it('returns nothing for complete records', () => {
    equipmentRepo.create({
      equipment_id: 'eq-complete',
      user_id: userId,
      mower_sn: 'LFIN2230700238',
      charger_sn: 'LFIC1230700004',
    });

    const inc = equipmentRepo.findIncompleteByUserId(userId);
    expect(inc).toBeUndefined();
  });

  it('ignores records from other users', () => {
    userRepo.create('user-other', 'other@test.com', 'hash', 'other');
    equipmentRepo.create({
      equipment_id: 'eq-other',
      user_id: 'user-other',
      mower_sn: 'LFIN0001',
      charger_sn: null,
    });

    const inc = equipmentRepo.findIncompleteByUserId(userId);
    expect(inc).toBeUndefined();
  });
});

describe('LoRa cache — mower channel = charger channel - 1', () => {
  it('setLoraCache stores address and channel', () => {
    equipmentRepo.setLoraCache('LFIC1230700004', '718', '16');

    const cache = equipmentRepo.getLoraCache('LFIC1230700004');
    expect(cache).toBeDefined();
    expect(cache!.charger_address).toBe('718');
    expect(cache!.charger_channel).toBe('16');
  });

  it('mower gets charger_channel - 1', () => {
    const chargerChannel = 16;
    const mowerChannel = chargerChannel - 1; // 15

    equipmentRepo.setLoraCache('LFIC1230700004', '718', String(chargerChannel));
    equipmentRepo.setLoraCache('LFIN2230700238', '718', String(mowerChannel));

    const chargerLora = equipmentRepo.getLoraCache('LFIC1230700004');
    const mowerLora = equipmentRepo.getLoraCache('LFIN2230700238');

    expect(Number(chargerLora!.charger_channel)).toBe(16);
    expect(Number(mowerLora!.charger_channel)).toBe(15);
    expect(Number(chargerLora!.charger_channel) - 1).toBe(Number(mowerLora!.charger_channel));
  });

  it('syncLoraPair sets same address for both devices', () => {
    equipmentRepo.syncLoraPair('LFIN2230700238', 'LFIC1230700004', '719', '16');

    const mowerLora = equipmentRepo.getLoraCache('LFIN2230700238');
    const chargerLora = equipmentRepo.getLoraCache('LFIC1230700004');

    expect(mowerLora!.charger_address).toBe('719');
    expect(chargerLora!.charger_address).toBe('719');
    // Both share the same channel value in the pair sync
    expect(mowerLora!.charger_channel).toBe(chargerLora!.charger_channel);
  });
});

describe('Equipment API split — merged row produces 2 entries', () => {
  const userId = 'user-split';
  const mowerSn = 'LFIN2230700238';
  const chargerSn = 'LFIC1230700004';

  beforeEach(() => {
    userRepo.create(userId, 'split@test.com', 'hash', 'split');
  });

  it('flatMap logic produces charger + mower from single merged row', () => {
    // Create a merged equipment row (both mower + charger)
    equipmentRepo.create({
      equipment_id: 'eq-merged',
      user_id: userId,
      mower_sn: mowerSn,
      charger_sn: chargerSn,
      charger_address: '718',
      charger_channel: '16',
    });

    const rows = equipmentRepo.findByUserId(userId);
    expect(rows).toHaveLength(1);

    // Replicate the flatMap logic from userEquipmentList
    const entries = rows.flatMap(r => {
      const result: Array<{ sn: string; deviceType: string }> = [];
      if (r.mower_sn?.startsWith('LFIN')) {
        result.push({ sn: r.mower_sn, deviceType: 'mower' });
      }
      if (r.charger_sn?.startsWith('LFIC')) {
        result.push({ sn: r.charger_sn, deviceType: 'charger' });
      }
      if (result.length === 0) {
        result.push({ sn: r.mower_sn, deviceType: r.mower_sn.startsWith('LFIC') ? 'charger' : 'mower' });
      }
      return result;
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ sn: mowerSn, deviceType: 'mower' });
    expect(entries[1]).toEqual({ sn: chargerSn, deviceType: 'charger' });
  });

  it('charger-only row produces 1 charger entry', () => {
    equipmentRepo.create({
      equipment_id: 'eq-c-only',
      user_id: userId,
      mower_sn: chargerSn,  // placeholder
      charger_sn: chargerSn,
    });

    const rows = equipmentRepo.findByUserId(userId);
    const entries = rows.flatMap(r => {
      const result: Array<{ sn: string; deviceType: string }> = [];
      if (r.mower_sn?.startsWith('LFIN')) {
        result.push({ sn: r.mower_sn, deviceType: 'mower' });
      }
      if (r.charger_sn?.startsWith('LFIC')) {
        result.push({ sn: r.charger_sn, deviceType: 'charger' });
      }
      if (result.length === 0) {
        result.push({ sn: r.mower_sn, deviceType: r.mower_sn.startsWith('LFIC') ? 'charger' : 'mower' });
      }
      return result;
    });

    // Only charger entry — mower_sn is LFIC placeholder, doesn't match LFIN
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ sn: chargerSn, deviceType: 'charger' });
  });

  it('getEquipmentBySN charger fix: querying charger SN returns charger data', () => {
    equipmentRepo.create({
      equipment_id: 'eq-pair',
      user_id: userId,
      mower_sn: mowerSn,
      charger_sn: chargerSn,
      charger_address: '718',
      charger_channel: '16',
      mower_version: 'v6.0.2',
      charger_version: 'v0.4.0',
    });

    // When querying charger SN, findBySn finds the merged row
    const row = equipmentRepo.findBySn(chargerSn);
    expect(row).toBeDefined();

    // The fix: detect charger query and swap mower_sn to charger_sn for DTO
    const isChargerQuery = chargerSn === row!.charger_sn && chargerSn !== row!.mower_sn;
    expect(isChargerQuery).toBe(true);

    // Build effective row (as equipment.ts does)
    const effectiveRow = isChargerQuery
      ? { ...row!, mower_sn: row!.charger_sn! }
      : row!;

    expect(effectiveRow.mower_sn).toBe(chargerSn);

    // Verify DTO would use charger version, not mower version
    const isCharger = effectiveRow.mower_sn.startsWith('LFIC');
    expect(isCharger).toBe(true);
    const sysVersion = isCharger ? (effectiveRow.charger_version ?? 'v0.3.6') : (effectiveRow.mower_version ?? 'v5.7.1');
    expect(sysVersion).toBe('v0.4.0');
  });
});
