import { describe, it, expect } from 'vitest';
import { equipmentRepo, userRepo } from '../../db/repositories/index.js';

describe('EquipmentRepository', () => {
  const userId = 'test-user-001';

  // Helper to create a user (needed for foreign key)
  function createUser() {
    userRepo.create(userId, 'test@test.com', 'hash', 'test');
  }

  describe('create + find', () => {
    it('creates equipment and finds by mower SN', () => {
      createUser();
      equipmentRepo.create({
        equipment_id: 'eq-1',
        user_id: userId,
        mower_sn: 'LFIN0001',
        charger_sn: 'LFIC0001',
      });

      const found = equipmentRepo.findByMowerSn('LFIN0001');
      expect(found).toBeDefined();
      expect(found!.mower_sn).toBe('LFIN0001');
      expect(found!.charger_sn).toBe('LFIC0001');
    });

    it('finds by charger SN', () => {
      createUser();
      equipmentRepo.create({
        equipment_id: 'eq-1',
        user_id: userId,
        mower_sn: 'LFIN0001',
        charger_sn: 'LFIC0001',
      });

      const found = equipmentRepo.findByChargerSn('LFIC0001');
      expect(found).toBeDefined();
      expect(found!.mower_sn).toBe('LFIN0001');
    });

    it('findBySn finds by either mower or charger SN', () => {
      createUser();
      equipmentRepo.create({
        equipment_id: 'eq-1',
        user_id: userId,
        mower_sn: 'LFIN0001',
        charger_sn: 'LFIC0001',
      });

      expect(equipmentRepo.findBySn('LFIN0001')).toBeDefined();
      expect(equipmentRepo.findBySn('LFIC0001')).toBeDefined();
      expect(equipmentRepo.findBySn('LFIN9999')).toBeUndefined();
    });
  });

  describe('pair', () => {
    it('pairs mower with charger in a transaction', () => {
      createUser();
      // Create standalone charger
      equipmentRepo.create({
        equipment_id: 'eq-charger',
        user_id: userId,
        mower_sn: 'LFIC0001',  // mower_sn is PK — charger-only uses charger SN here
        charger_sn: 'LFIC0001',
      });
      // Create standalone mower
      equipmentRepo.create({
        equipment_id: 'eq-mower',
        user_id: userId,
        mower_sn: 'LFIN0001',
        charger_sn: null,
      });

      // Pair them
      equipmentRepo.pair('LFIN0001', 'LFIC0001', userId);

      // Should have only 1 equipment record now
      const all = equipmentRepo.listAll();
      const paired = all.filter(e => e.mower_sn === 'LFIN0001');
      expect(paired.length).toBe(1);
      expect(paired[0].charger_sn).toBe('LFIC0001');
    });
  });

  describe('UNIQUE constraint safety', () => {
    it('does not crash when pairing with existing mower_sn', () => {
      createUser();
      equipmentRepo.create({
        equipment_id: 'eq-1',
        user_id: userId,
        mower_sn: 'LFIN0001',
        charger_sn: null,
      });
      equipmentRepo.create({
        equipment_id: 'eq-2',
        user_id: userId,
        mower_sn: 'LFIC0001',
        charger_sn: 'LFIC0001',
      });

      // This should not throw UNIQUE constraint error
      expect(() => equipmentRepo.pair('LFIN0001', 'LFIC0001', userId)).not.toThrow();
    });
  });

  describe('LoRa cache', () => {
    it('set and get LoRa cache', () => {
      equipmentRepo.setLoraCache('LFIN0001', '719', '16');
      const lora = equipmentRepo.getLoraCache('LFIN0001');
      expect(lora).toBeDefined();
      expect(lora!.charger_address).toBe('719');
      expect(lora!.charger_channel).toBe('16');
    });

    it('setLoraCacheIfNew does not overwrite existing', () => {
      equipmentRepo.setLoraCache('LFIN0001', '719', '16');
      equipmentRepo.setLoraCacheIfNew('LFIN0001', '999', '20');
      const lora = equipmentRepo.getLoraCache('LFIN0001');
      expect(lora!.charger_address).toBe('719'); // NOT overwritten
    });

    it('syncLoraPair updates both devices', () => {
      equipmentRepo.setLoraCache('LFIN0001', '718', '15');
      equipmentRepo.setLoraCache('LFIC0001', '999', '20');
      equipmentRepo.syncLoraPair('LFIN0001', 'LFIC0001', '719', '16');
      expect(equipmentRepo.getLoraCache('LFIN0001')!.charger_address).toBe('719');
      expect(equipmentRepo.getLoraCache('LFIC0001')!.charger_address).toBe('719');
    });
  });

  describe('claimOwnership', () => {
    it('sets user_id only if NULL', () => {
      createUser();
      equipmentRepo.create({
        equipment_id: 'eq-1',
        user_id: null,
        mower_sn: 'LFIN0001',
      });
      equipmentRepo.claimOwnership('eq-1', userId);
      expect(equipmentRepo.findByMowerSn('LFIN0001')!.user_id).toBe(userId);
    });

    it('does not overwrite existing user_id', () => {
      createUser();
      userRepo.create('other-user', 'other@test.com', 'hash', 'other');
      equipmentRepo.create({
        equipment_id: 'eq-1',
        user_id: userId,
        mower_sn: 'LFIN0001',
      });
      equipmentRepo.claimOwnership('eq-1', 'other-user');
      expect(equipmentRepo.findByMowerSn('LFIN0001')!.user_id).toBe(userId); // NOT changed
    });
  });
});
