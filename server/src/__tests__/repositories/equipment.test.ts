import { describe, it, expect } from 'vitest';
import { equipmentRepo, userRepo, deviceRepo } from '../../db/repositories/index.js';

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

  describe('mac_address backfill from device_factory', () => {
    function seedFactory(mower = '70:4A:0E:4A:99:CF', charger = '48:27:E2:AA:BB:CC') {
      deviceRepo.importFactoryDevices([
        { sn: 'LFIN0001', device_type: 'mower', mac_address: mower },
        { sn: 'LFIC0001', device_type: 'charger', mac_address: charger },
      ]);
    }

    it('create() fills in mac_address from factory when caller passes null', () => {
      createUser();
      seedFactory();
      equipmentRepo.create({
        equipment_id: 'eq-1',
        user_id: userId,
        mower_sn: 'LFIN0001',
        charger_sn: 'LFIC0001',
        // intentionally no mac_address
      });
      expect(equipmentRepo.findByMowerSn('LFIN0001')!.mac_address).toBe('70:4A:0E:4A:99:CF');
    });

    it('create() never substitutes the charger MAC onto a mower row', () => {
      createUser();
      // Factory has only a charger entry for this SN pair — must NOT leak onto equipment
      deviceRepo.importFactoryDevices([
        { sn: 'LFIC0001', device_type: 'charger', mac_address: '48:27:E2:AA:BB:CC' },
      ]);
      equipmentRepo.create({
        equipment_id: 'eq-1',
        user_id: userId,
        mower_sn: 'LFIN0001',
        charger_sn: 'LFIC0001',
      });
      expect(equipmentRepo.findByMowerSn('LFIN0001')!.mac_address).toBeNull();
    });

    it('create() preserves an explicit mac_address (no factory override)', () => {
      createUser();
      seedFactory('70:4A:0E:4A:99:CF');
      equipmentRepo.create({
        equipment_id: 'eq-1',
        user_id: userId,
        mower_sn: 'LFIN0001',
        mac_address: 'EXPLICIT:MAC',
      });
      expect(equipmentRepo.findByMowerSn('LFIN0001')!.mac_address).toBe('EXPLICIT:MAC');
    });

    it('backfillMissingMacsFromFactory() heals existing rows with null MAC', () => {
      createUser();
      // Row was created BEFORE factory data was available
      equipmentRepo.create({ equipment_id: 'eq-1', user_id: userId, mower_sn: 'LFIN0001' });
      expect(equipmentRepo.findByMowerSn('LFIN0001')!.mac_address).toBeNull();
      seedFactory();

      const healed = equipmentRepo.backfillMissingMacsFromFactory();
      expect(healed).toBe(1);
      expect(equipmentRepo.findByMowerSn('LFIN0001')!.mac_address).toBe('70:4A:0E:4A:99:CF');
    });

    it('backfillMissingMacsFromFactory() is idempotent', () => {
      createUser();
      seedFactory();
      equipmentRepo.create({ equipment_id: 'eq-1', user_id: userId, mower_sn: 'LFIN0001' });
      // First call heals it; second call should find nothing to do
      equipmentRepo.backfillMissingMacsFromFactory();
      expect(equipmentRepo.backfillMissingMacsFromFactory()).toBe(0);
    });
  });

  describe('discovered_ip', () => {
    it('setDiscoveredIp persists IP and stamps discovered_ip_at', () => {
      createUser();
      equipmentRepo.create({ equipment_id: 'eq-1', user_id: userId, mower_sn: 'LFIN0001' });

      equipmentRepo.setDiscoveredIp('LFIN0001', '192.168.0.100');
      const row = equipmentRepo.findResolvedMowerIp('LFIN0001');
      expect(row?.discovered_ip).toBe('192.168.0.100');
      expect(row?.discovered_ip_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('setDiscoveredIp with null clears the discovered IP', () => {
      createUser();
      equipmentRepo.create({ equipment_id: 'eq-1', user_id: userId, mower_sn: 'LFIN0001' });
      equipmentRepo.setDiscoveredIp('LFIN0001', '192.168.0.100');
      equipmentRepo.setDiscoveredIp('LFIN0001', null);
      expect(equipmentRepo.findResolvedMowerIp('LFIN0001')?.discovered_ip).toBeNull();
    });

    it('listDiscoverable returns every LFI* mower', () => {
      createUser();
      equipmentRepo.create({ equipment_id: 'eq-1', user_id: userId, mower_sn: 'LFIN0001' });
      equipmentRepo.create({ equipment_id: 'eq-2', user_id: userId, mower_sn: 'LFIN0002', mower_ip: '192.168.0.101' });

      const list = equipmentRepo.listDiscoverable();
      expect(list.length).toBe(2);
      expect(list.map(r => r.mower_sn).sort()).toEqual(['LFIN0001', 'LFIN0002']);
      // mower_ip is included so the discovery loop can skip user-pinned rows
      const pinned = list.find(r => r.mower_sn === 'LFIN0002');
      expect(pinned?.mower_ip).toBe('192.168.0.101');
    });
  });
});
