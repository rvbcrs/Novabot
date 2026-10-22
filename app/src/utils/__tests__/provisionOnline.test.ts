import { describe, it, expect } from 'vitest';
import { provisionedDevicesForSn, allProvisionedOnline } from '../provisionOnline';

// GH #160: the dock came online on the new server, the mower did not, and the
// provisioning screen still said both were online.
const charger = { id: 'ble-charger', name: 'CHARGER_PILE', type: 'charger' as const };
const mower = { id: 'ble-mower', name: 'Novabot', type: 'mower' as const };

describe('provisionedDevicesForSn (GH #160)', () => {
  it('a charger SN marks only the charger', () => {
    expect(provisionedDevicesForSn([charger, mower], 'LFIC2231000522')).toEqual(['ble-charger']);
  });
  it('a mower SN marks only the mower', () => {
    expect(provisionedDevicesForSn([charger, mower], 'LFIN2231000451')).toEqual(['ble-mower']);
  });
  it('an SN of a type that was not provisioned marks nothing', () => {
    expect(provisionedDevicesForSn([charger], 'LFIN2231000451')).toEqual([]);
  });
  it('an unknown SN marks nothing', () => {
    expect(provisionedDevicesForSn([charger, mower], 'ESP32_1bA408')).toEqual([]);
    expect(provisionedDevicesForSn([charger, mower], '')).toEqual([]);
  });
  it('a device that advertises its SN matches only that SN, in any case', () => {
    const named = { id: 'ble-named', name: 'lfin2230700238', type: 'mower' as const };
    expect(provisionedDevicesForSn([named], 'LFIN2230700238')).toEqual(['ble-named']);
    expect(provisionedDevicesForSn([named], 'LFIN2231000451')).toEqual([]);
  });
});

describe('allProvisionedOnline (GH #160)', () => {
  it('needs every provisioned device', () => {
    expect(allProvisionedOnline([charger, mower], { 'ble-charger': true })).toBe(false);
    expect(allProvisionedOnline([charger, mower], { 'ble-charger': true, 'ble-mower': true })).toBe(true);
  });
  it('is false without devices', () => {
    expect(allProvisionedOnline([], {})).toBe(false);
  });
});
