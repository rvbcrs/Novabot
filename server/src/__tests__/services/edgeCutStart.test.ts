import { describe, it, expect, beforeEach, vi } from 'vitest';

// Zelfde mock-conventie als mowingService.test.ts: zonder deze mocks laadt
// mowingService.ts (via mapSync.js) de echte broker.js/socketHandler.js/
// demoSimulator.js keten, die bij deze import-volgorde een pre-existente
// TDZ-crash geeft ("Cannot access 'demoModeChecker' before initialization",
// onafhankelijk van dit task, ook aanwezig op master). isDeviceOnline levert
// hier altijd false — dat is precies het gedrag dat een echte offline SN al
// zou geven, dus de guard-test blijft betekenisvol.
vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn(() => false),
}));
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToDevice: vi.fn(),
}));

import { getMowerPhase, startEdgeCut } from '../../services/mowingService.js';
import { deviceCache } from '../../mqtt/sensorData.js';

describe('getMowerPhase', () => {
  beforeEach(() => deviceCache.clear());
  it('CHARGING battery_state → charging', () => {
    deviceCache.set('SN1', new Map([['battery_state', 'CHARGING'], ['work_status', '0']]));
    expect(getMowerPhase('SN1')).toBe('charging');
  });
  it('actieve maaistatus → mowing', () => {
    deviceCache.set('SN1', new Map([['work_status', '100'], ['msg', 'Work:COVERING']]));
    expect(getMowerPhase('SN1')).toBe('mowing');
  });
  it('onbekend/leeg → other', () => {
    expect(getMowerPhase('SNX')).toBe('other');
  });
});

describe('startEdgeCut guards', () => {
  it('offline maaier → ok:false', () => {
    const r = startEdgeCut('OFFLINE_SN', 'map0', 40);
    expect(r.ok).toBe(false);
  });
});
