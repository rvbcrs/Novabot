/**
 * Integration test — device pairing flow.
 * Tests the pair-devices logic that was broken before.
 * Note: pair() uses db.transaction() which conflicts with the global beforeEach cleanup.
 * So we test the individual steps instead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { userRepo, equipmentRepo } from '../../db/repositories/index.js';

describe('Device Pairing', () => {
  const userId = 'user-1';

  beforeEach(() => {
    userRepo.create(userId, 'test@test.com', 'hash', 'test');
  });

  it('pairs standalone charger + standalone mower via manual steps', () => {
    equipmentRepo.create({ equipment_id: 'eq-c', user_id: userId, mower_sn: 'LFIC0001', charger_sn: 'LFIC0001' });
    equipmentRepo.create({ equipment_id: 'eq-m', user_id: userId, mower_sn: 'LFIN0001' });

    // Steps that pair() does inside its transaction:
    const chargerEquip = equipmentRepo.findByChargerSn('LFIC0001');
    expect(chargerEquip).toBeDefined();
    equipmentRepo.deleteStandaloneMower('LFIN0001', chargerEquip!.equipment_id);
    equipmentRepo.updateMowerSn(chargerEquip!.equipment_id, 'LFIN0001');

    const result = equipmentRepo.findBySn('LFIN0001');
    expect(result).toBeDefined();
    expect(result!.charger_sn).toBe('LFIC0001');
  });

  it('DELETE before UPDATE prevents UNIQUE constraint violation', () => {
    equipmentRepo.create({ equipment_id: 'eq-1', user_id: userId, mower_sn: 'LFIN0001' });
    equipmentRepo.create({ equipment_id: 'eq-2', user_id: userId, mower_sn: 'LFIC0001', charger_sn: 'LFIC0001' });

    const chargerEquip = equipmentRepo.findByChargerSn('LFIC0001');
    equipmentRepo.deleteStandaloneMower('LFIN0001', chargerEquip!.equipment_id);
    expect(() => equipmentRepo.updateMowerSn(chargerEquip!.equipment_id, 'LFIN0001')).not.toThrow();
  });

  it('syncLoraPair updates both devices', () => {
    equipmentRepo.setLoraCache('LFIN0001', '718', '15');
    equipmentRepo.setLoraCache('LFIC0001', '51154', '19');

    equipmentRepo.syncLoraPair('LFIN0001', 'LFIC0001', '719', '16');

    expect(equipmentRepo.getLoraCache('LFIN0001')!.charger_address).toBe('719');
    expect(equipmentRepo.getLoraCache('LFIC0001')!.charger_address).toBe('719');
  });

  it('claimOwnership does not overwrite existing owner', () => {
    userRepo.create('user-2', 'other@test.com', 'hash', 'other');
    equipmentRepo.create({ equipment_id: 'eq-1', user_id: userId, mower_sn: 'LFIN0001', charger_sn: 'LFIC0001' });

    equipmentRepo.claimOwnership('eq-1', 'user-2');
    expect(equipmentRepo.findByMowerSn('LFIN0001')!.user_id).toBe(userId);
  });

  it('setLoraCacheIfNew does not overwrite working config', () => {
    equipmentRepo.setLoraCache('LFIC0001', '719', '16');
    equipmentRepo.setLoraCacheIfNew('LFIC0001', '51154', '19');
    expect(equipmentRepo.getLoraCache('LFIC0001')!.charger_address).toBe('719');
  });
});
