import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { clearPositionTelemetry, freshPositionState, ingestPositionTelemetry, positionTelemetry, stablePosition } from '../../services/positionTelemetry.js';
const sn = 'MEASURE';
const data = { rtk_fix_quality: 4, battery_state: 'CHARGING', localization_state: 'RUNNING', map_position_x: 0.03, map_position_y: 0.73, latitude: 52.14, longitude: 6.23 };
beforeEach(() => { clearPositionTelemetry(sn); vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => vi.useRealTimers());
it('eight cache reads are one sample; eight actual equal packets are eight samples', () => {
  ingestPositionTelemetry(sn, data);
  for (let i = 0; i < 8; i++) expect(stablePosition(sn)).toBeNull();
  for (let i = 1; i < 8; i++) { vi.advanceTimersByTime(1000); ingestPositionTelemetry(sn, data); }
  expect(stablePosition(sn)).toMatchObject({ x: 0.03, y: 0.73, sampleCount: 8, spreadM: 0 });
  vi.advanceTimersByTime(10_001);
  expect(stablePosition(sn)).toBeNull();
});
it('a quality drop breaks the window and a bare rtk boolean cannot replace Fixed', () => {
  for (let i = 0; i < 8; i++) { vi.advanceTimersByTime(1000); ingestPositionTelemetry(sn, data); }
  ingestPositionTelemetry(sn, { rtk_fix_quality: 5 });
  expect(stablePosition(sn)).toBeNull();
  ingestPositionTelemetry(sn, { rtk: true });
  expect(freshPositionState(sn).fixed).toBe(false);
  ingestPositionTelemetry(sn, data);
  expect(positionTelemetry(sn)?.poses).toHaveLength(1);
});
it('reads real nested timer positions, refuses invalid coordinates and stale dock/quality', () => {
  ingestPositionTelemetry(sn, { rtk_fix_quality: 4, recharge_status: 9 });
  ingestPositionTelemetry(sn, { localization: { localization_state: 'RUNNING', map_position: { x: 1, y: 2 }, gps_position: { latitude: 52, longitude: 6 } } });
  expect(freshPositionState(sn).pose).toMatchObject({ x: 1, y: 2 });
  expect(positionTelemetry(sn)?.gps.at(-1)).toMatchObject({ lat: 52, lng: 6, fixed: true });
  ingestPositionTelemetry(sn, { map_position_x: null, map_position_y: 2 });
  expect(freshPositionState(sn).pose).toBeNull();
  vi.advanceTimersByTime(10_001);
  expect(freshPositionState(sn)).toMatchObject({ fixed: false, docked: false, dockKnown: false });
});
it('requires samples from after the requested origin load and rejects excessive motion', () => {
  for (let i = 0; i < 8; i++) { vi.advanceTimersByTime(1000); ingestPositionTelemetry(sn, data); }
  expect(stablePosition(sn, { after: Date.now() })).toBeNull();
  vi.advanceTimersByTime(1000); ingestPositionTelemetry(sn, { ...data, map_position_x: 1 });
  expect(stablePosition(sn)).toBeNull();
});
