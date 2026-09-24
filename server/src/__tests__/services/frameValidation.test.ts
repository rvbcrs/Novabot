import { describe, it, expect, beforeEach } from 'vitest';
import {
  markFrameUnvalidated, clearFrameUnvalidated, isFrameUnvalidated,
  loadFrameValidationFromDb, checkDockedFrame, FRAME_TOLERANCE_M,
} from '../../services/frameValidation.js';
import { deviceSettingsRepo } from '../../db/repositories/deviceSettings.js';

const SN = 'LFIN_TEST_0001';

describe('frameValidation', () => {
  beforeEach(() => { clearFrameUnvalidated(SN); });

  it('marks and reads unvalidated', () => {
    expect(isFrameUnvalidated(SN)).toBe(false);
    markFrameUnvalidated(SN);
    expect(isFrameUnvalidated(SN)).toBe(true);
  });

  it('clears', () => {
    markFrameUnvalidated(SN);
    clearFrameUnvalidated(SN);
    expect(isFrameUnvalidated(SN)).toBe(false);
  });

  it('persists to device_settings and reloads (simulated restart)', () => {
    markFrameUnvalidated(SN);
    const rows = deviceSettingsRepo.listAll()
      .filter(r => r.sn === SN && r.key === 'frame_unvalidated');
    expect(rows[0]?.value).toBe('1');
    clearFrameUnvalidated(SN);            // wipe in-memory + persist '0'
    markFrameUnvalidated(SN);             // re-persist '1'
    loadFrameValidationFromDb();
    expect(isFrameUnvalidated(SN)).toBe(true);
  });
});

// Verify-first na een restore: staat de maaier gedockt met RTK Fixed op het
// dock-anker uit de teruggezette kaart, dan klopt het frame en is her-ankeren
// overbodig. Dezelfde 0,4 m als de zelfverificatie van het her-ankeren.
describe('checkDockedFrame', () => {
  const anchor = { x: 0.03, y: 0.73 };
  const base = { docked: true, rtkFixed: true, anchor, pose: { x: -0.01, y: 0.78 } };

  it('gedockt, Fixed, binnen de tolerantie: ok met de afstand', () => {
    const r = checkDockedFrame(base);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('ok');
    expect(r.distM).toBeCloseTo(Math.hypot(0.04, 0.05), 6);
  });

  it('precies op de tolerantie telt nog als ok', () => {
    expect(checkDockedFrame({ ...base, pose: { x: anchor.x + FRAME_TOLERANCE_M, y: anchor.y } }).ok).toBe(true);
    expect(checkDockedFrame({ ...base, pose: { x: anchor.x + FRAME_TOLERANCE_M + 0.01, y: anchor.y } })).toMatchObject({ ok: false, reason: 'off' });
  });

  it('te ver van het anker: off, met de afstand erbij', () => {
    const r = checkDockedFrame({ ...base, pose: { x: 2.14, y: 0.02 } });
    expect(r).toMatchObject({ ok: false, reason: 'off' });
    expect(r.distM).toBeCloseTo(Math.hypot(2.11, -0.71), 6);
  });

  it('niet gedockt, geen Fixed, geen positie of geen anker: elk zijn eigen reden', () => {
    expect(checkDockedFrame({ ...base, docked: false })).toMatchObject({ ok: false, reason: 'not_docked' });
    expect(checkDockedFrame({ ...base, rtkFixed: false })).toMatchObject({ ok: false, reason: 'no_rtk_fixed' });
    expect(checkDockedFrame({ ...base, pose: null })).toMatchObject({ ok: false, reason: 'no_pose', distM: null });
    expect(checkDockedFrame({ ...base, anchor: null })).toMatchObject({ ok: false, reason: 'no_anchor', distM: null });
  });
});
