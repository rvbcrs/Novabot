import { describe, it, expect, vi } from 'vitest';

// Zelfde afsluiting als homeassistantLawnMower.test.ts: mapSync trekt de
// broker (en demoSimulator) binnen, en sensorData → socketHandler sluit een
// init-cyclus die in de test-importvolgorde een TDZ-fout geeft.
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToDevice: vi.fn(),
}));
vi.mock('../../dashboard/socketHandler.js', () => ({
  emitDebugPosJson: vi.fn(),
}));

import { toHaState } from '../../mqtt/homeassistant.js';
import { SENSORS } from '../../mqtt/sensorData.js';

const sensor = (field: string) => SENSORS.find(s => s.field === field);

describe('toHaState — HA-state past bij de unit', () => {
  it('cov_ratio (fractie 0..1) gaat als procent naar HA', () => {
    expect(sensor('cov_ratio')?.unit).toBe('%');
    expect(toHaState(sensor('cov_ratio'), '0.42')).toBe('42');
    expect(toHaState(sensor('cov_ratio'), '0.4567')).toBe('45.7');
    expect(toHaState(sensor('cov_ratio'), '1')).toBe('100');
    expect(toHaState(sensor('cov_ratio'), '0')).toBe('0');
  });

  it('niet-numerieke cov_ratio gaat ongewijzigd door', () => {
    expect(toHaState(sensor('cov_ratio'), '')).toBe('');
    expect(toHaState(sensor('cov_ratio'), 'n/a')).toBe('n/a');
  });

  it('sensoren zonder ha_scale (en onbekende velden) gaan ongewijzigd door', () => {
    expect(toHaState(sensor('battery_power'), '87')).toBe('87');
    expect(toHaState(sensor('cov_estimate_time'), '1.4036223888397217')).toBe('1.4036223888397217');
    expect(toHaState(undefined, '0.42')).toBe('0.42');
  });
});
