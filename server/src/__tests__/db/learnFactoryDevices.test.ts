import { describe, it, expect } from 'vitest';
import { deviceRepo, learnFactoryDevicesFromCloud } from '../../db/repositories/index.js';

describe('learnFactoryDevicesFromCloud', () => {
  it('adds serials the factory table does not have and leaves known ones alone', () => {
    deviceRepo.importFactoryDevices([{ sn: 'LFIC9990000001', mac_address: 'AA:AA:AA:AA:AA:01' }]);
    const learned = learnFactoryDevicesFromCloud([
      { sn: 'LFIC9990000001', deviceType: 'charger', macAddress: 'BB:BB:BB:BB:BB:01' },
      { sn: 'LFIN9990000002', deviceType: 'mower', macAddress: '50:41:1C:00:00:02', equipmentType: 'LFIN2',
        sysVersion: 'v5.7.1', chargerAddress: 718, chargerChannel: 16, account: null, password: null, model: 'N2000' },
      { sn: '', macAddress: 'x' },
    ]);
    expect(learned).toEqual(['LFIN9990000002']);
    expect(deviceRepo.getFactoryMac('LFIC9990000001')).toBe('AA:AA:AA:AA:AA:01');
    const row = deviceRepo.getFactoryDevice('LFIN9990000002');
    expect(row).toMatchObject({ device_type: 'mower', mac_address: '50:41:1C:00:00:02', sys_version: 'v5.7.1',
      charger_address: 718, charger_channel: 16, model: 'N2000' });
    expect(learnFactoryDevicesFromCloud([{ sn: 'LFIN9990000002' }])).toEqual([]);
  });
});
