import { describe, it, expect } from 'vitest';
import { deviceRepo } from '../../db/repositories/index.js';

describe('DeviceRepository', () => {
  describe('upsertDevice', () => {
    it('inserts a new device', () => {
      deviceRepo.upsertDevice('ESP32_ABC', 'LFIC0001', '48:27:E2:AA:BB:CC');
      const found = deviceRepo.findBySn('LFIC0001');
      expect(found).toBeDefined();
      expect(found!.mac_address).toBe('48:27:E2:AA:BB:CC');
    });

    it('updates existing device on re-insert', () => {
      deviceRepo.upsertDevice('ESP32_ABC', 'LFIC0001', 'OLD:MAC');
      deviceRepo.upsertDevice('ESP32_ABC', 'LFIC0001', 'NEW:MAC');
      const found = deviceRepo.findByClientId('ESP32_ABC');
      expect(found!.mac_address).toBe('NEW:MAC');
    });
  });

  describe('countAll + countOnline', () => {
    it('counts all devices', () => {
      deviceRepo.upsertDevice('c1', 'LFIN0001', null);
      deviceRepo.upsertDevice('c2', 'LFIC0001', null);
      expect(deviceRepo.countAll()).toBe(2);
    });

    it('countOnline returns recently seen devices', () => {
      deviceRepo.upsertDevice('c1', 'LFIN0001', null);
      // Just inserted — should be "online" (within 5 minutes)
      expect(deviceRepo.countOnline(5)).toBeGreaterThanOrEqual(1);
    });
  });

  describe('deleteBySn', () => {
    it('deletes device by SN', () => {
      deviceRepo.upsertDevice('c1', 'LFIN0001', null);
      deviceRepo.upsertDevice('c2', 'LFIC0001', null);
      deviceRepo.deleteBySn('LFIN0001');
      expect(deviceRepo.countAll()).toBe(1);
      expect(deviceRepo.findBySn('LFIN0001')).toBeUndefined();
    });
  });

  describe('factory devices', () => {
    it('getFactoryMac returns null for unknown SN', () => {
      expect(deviceRepo.getFactoryMac('LFIN9999')).toBeNull();
    });
  });
});
