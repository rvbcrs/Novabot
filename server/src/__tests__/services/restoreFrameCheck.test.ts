/** Fresh telemetry can diagnose a restored frame, but cannot release its navigation lock. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../mqtt/sensorData.js', () => ({
  deviceCache: new Map<string, Map<string, string>>(),
  translateValue: (field: string, raw: string) =>
    field === 'rtk_fix_quality' ? ({ '4': 'RTK Fixed', '5': 'RTK Float' } as Record<string, string>)[raw] ?? raw : raw,
}));

import { deviceCache } from '../../mqtt/sensorData.js';
import { mapRepo } from '../../db/repositories/index.js';
import { isFrameUnvalidated, clearFrameUnvalidated, markFrameUnvalidated } from '../../services/frameValidation.js';
import { clearPositionTelemetry, ingestPositionTelemetry } from '../../services/positionTelemetry.js';
import { settleRestoredFrame } from '../../services/restoreFrameCheck.js';

const SN = 'LFIN_RESTORE_CHECK';
const anchor = { x: 0.03, y: 0.73 };

function seed(over: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries({
    battery_state: 'CHARGING', recharge_status: '9', rtk_fix_quality: '4',
    map_position_x: '-0.01', map_position_y: '0.78', ...over,
  }));
  deviceCache.set(SN, m);
  const now = Date.now();
  for (let i = 0; i < 8; i++) ingestPositionTelemetry(SN,
    { ...Object.fromEntries(m), localization_state: 'RUNNING' }, now - 700 + i * 100);
}

describe('settleRestoredFrame', () => {
  beforeEach(() => {
    deviceCache.clear();
    clearPositionTelemetry(SN);
    clearFrameUnvalidated(SN);
    for (const r of mapRepo.findByMowerSn(SN)) mapRepo.deleteById(r.map_id);
    mapRepo.create({ map_id: `${SN}-u`, mower_sn: SN, map_type: 'unicom', canonical_name: 'map0tocharge_unicom',
      map_area: JSON.stringify([anchor, { x: -0.4, y: 0.94 }]) });
  });

  it('gedockt op het anker met verse RTK Fixed: diagnose slaagt, frame blijft geblokkeerd', () => {
    markFrameUnvalidated(SN);
    seed();
    const r = settleRestoredFrame(SN);
    expect(r.ok).toBe(true);
    expect(isFrameUnvalidated(SN)).toBe(true);
  });

  it('gedockt maar 2 m van het anker: ongevalideerd, met reden off', () => {
    seed({ map_position_x: '2.14', map_position_y: '0.02' });
    expect(settleRestoredFrame(SN)).toMatchObject({ ok: false, reason: 'off' });
    expect(isFrameUnvalidated(SN)).toBe(true);
  });

  it('niet gedockt: ongevalideerd', () => {
    seed({ battery_state: 'DISCHARGING', recharge_status: '0' });
    expect(settleRestoredFrame(SN)).toMatchObject({ ok: false, reason: 'not_docked' });
    expect(isFrameUnvalidated(SN)).toBe(true);
  });

  it('RTK Float telt niet als Fixed', () => {
    seed({ rtk_fix_quality: '5' });
    expect(settleRestoredFrame(SN)).toMatchObject({ ok: false, reason: 'no_rtk_fixed' });
  });

  it('zonder dockkanaal in de DB is er geen anker', () => {
    for (const r of mapRepo.findByMowerSn(SN)) mapRepo.deleteById(r.map_id);
    seed();
    expect(settleRestoredFrame(SN)).toMatchObject({ ok: false, reason: 'no_anchor' });
    expect(isFrameUnvalidated(SN)).toBe(true);
  });

  it('maaier zonder sensoren (offline): ongevalideerd', () => {
    expect(settleRestoredFrame(SN).ok).toBe(false);
    expect(isFrameUnvalidated(SN)).toBe(true);
  });
});
