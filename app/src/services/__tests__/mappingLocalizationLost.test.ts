import { describe, it, expect } from 'vitest';
import { isLocalizationLost } from '../mappingTelemetry';

describe('isLocalizationLost', () => {
  it('over BLE only an explicit false counts as lost', () => {
    expect(isLocalizationLost({ useBle: true, bleLocalized: false })).toBe(true);
    expect(isLocalizationLost({ useBle: true, bleLocalized: true })).toBe(false);
    expect(isLocalizationLost({ useBle: true })).toBe(false);
  });
  it('over the server uses state and quality', () => {
    expect(isLocalizationLost({ useBle: false, locState: 'NOT_INITIALIZED', locQuality: 100 })).toBe(true);
    // de sensorcache levert het vertaalde label
    expect(isLocalizationLost({ useBle: false, locState: 'Not initialized', locQuality: 0 })).toBe(true);
    expect(isLocalizationLost({ useBle: false, locState: 'RUNNING', locQuality: 30 })).toBe(true);
    expect(isLocalizationLost({ useBle: false, locState: 'RUNNING', locQuality: 100 })).toBe(false);
    expect(isLocalizationLost({ useBle: false, locState: 'RUNNING', locQuality: 0 })).toBe(false);
  });
});
