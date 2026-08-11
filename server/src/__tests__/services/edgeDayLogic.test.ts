import { describe, it, expect } from 'vitest';
import { isEdgeDay } from '../../services/scheduleRunner.js';
import { edgeBladeHeightMm } from '../../services/mowingService.js';

describe('isEdgeDay', () => {
  it('NULL = nooit (huidig gedrag)', () => {
    expect(isEdgeDay(null, 5)).toBe(false);
  });
  it('lege lijst = nooit', () => {
    expect(isEdgeDay('[]', 5)).toBe(false);
  });
  it('bevat de weekdag = wel, anders niet (0=zondag)', () => {
    expect(isEdgeDay('[5]', 5)).toBe(true);   // vrijdag
    expect(isEdgeDay('[5]', 1)).toBe(false);  // maandag
    expect(isEdgeDay('[0,6]', 0)).toBe(true); // zondag
  });
  it('corrupt JSON = nooit (geen crash)', () => {
    expect(isEdgeDay('nonsense', 3)).toBe(false);
  });
});

describe('edgeBladeHeightMm', () => {
  it('mm-invoer (>=20) blijft mm', () => {
    expect(edgeBladeHeightMm(40)).toBe(40);
    expect(edgeBladeHeightMm(90)).toBe(90);
  });
  it('cm-invoer (<20) wordt mm', () => {
    expect(edgeBladeHeightMm(4)).toBe(40);
    expect(edgeBladeHeightMm(9)).toBe(90);
  });
  it('clamt op 20..90', () => {
    expect(edgeBladeHeightMm(10)).toBe(90);  // cm 10 → 100mm → bovengrens
    expect(edgeBladeHeightMm(1)).toBe(20);   // cm 1 → 10mm → ondergrens
    expect(edgeBladeHeightMm(200)).toBe(90); // mm 200 → bovengrens
  });
});
