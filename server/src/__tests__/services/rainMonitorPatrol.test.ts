/**
 * A night patrol has no rain pause (spec 2026-10-14). Its firmware departure
 * reports an off-dock coverage task (task_mode 1, Work:MOVING or COVERING),
 * which the rain monitor took for a mow: on rain it sent pause_navigation and
 * go_to_charge into the patrol.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  publishToDevice: vi.fn(),
  createRainSession: vi.fn(),
}));
vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: vi.fn().mockReturnValue(true) }));
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToDevice: mocks.publishToDevice,
  goToChargePayload: vi.fn(() => ({ go_to_charge: {} })),
  getNextCmdNum: vi.fn().mockReturnValue(7),
}));
vi.mock('../../dashboard/socketHandler.js', () => ({ emitScheduleEvent: vi.fn() }));
vi.mock('../../services/weatherService.js', () => ({
  getWeatherForecast: vi.fn().mockResolvedValue({ hourly: [] }),
  shouldPauseForRain: vi.fn().mockReturnValue(true),   // rain is coming
}));
vi.mock('../../db/repositories/index.js', () => ({
  scheduleRepo: {
    findDistinctMowersWithRainPause: vi.fn(() => []),
    findRainSessionByMower: vi.fn(() => undefined),
    findActiveRainSchedule: vi.fn(() => undefined),
    findPausedRainSessions: vi.fn(() => []),
    createRainSession: mocks.createRainSession,
  },
  mapRepo: { getChargerGps: vi.fn(() => ({ lat: 52, lng: 6 })) },
  rainSettingsRepo: {
    getEffective: vi.fn(() => ({ enabled: true, thresholdMm: 0.1, thresholdProbability: 50, lookaheadHours: 0.5 })),
  },
}));

import { deviceCache } from '../../mqtt/sensorData.js';
import { startRainMonitor, stopRainMonitor } from '../../services/rainMonitor.js';

// The monitor remembers a mower it sent home for two minutes: every case its own mowers.
let n = 0;
let PATROL_SN = '';
let MOW_SN = '';

/** Off the dock in a coverage task, as a mow and a patrol's departure both report it. */
function outInTask(sn: string, msg: string, extra: Record<string, string> = {}) {
  deviceCache.set(sn, new Map(Object.entries({
    task_mode: '1', battery_state: 'DISCHARGING', recharge_status: '0', msg, ...extra,
  })));
}

const paused = (sn: string) => mocks.publishToDevice.mock.calls
  .filter(c => c[0] === sn && 'pause_navigation' in (c[1] as object));

beforeEach(() => {
  vi.clearAllMocks();
  deviceCache.clear();
  vi.useFakeTimers();
  n += 1;
  PATROL_SN = `LFIN_RAIN_PATROL_${n}`;
  MOW_SN = `LFIN_RAIN_MOWING_${n}`;
});
afterEach(() => {
  stopRainMonitor();
  vi.useRealTimers();
  deviceCache.clear();
});

describe('rain monitor and a night patrol', () => {
  it.each(['starting', 'localizing', 'patrolling', 'returning'])('leaves a patrol that is %s alone, and still pauses a mow', async phase => {
    outInTask(PATROL_SN, 'Mode:COVERAGE Work:MOVING Prev work:WAIT Recharge: WAIT', { patrol_phase: phase });
    outInTask(MOW_SN, 'Mode:COVERAGE Work:COVERING Prev work:MOVING Recharge: WAIT');
    startRainMonitor();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(paused(PATROL_SN)).toEqual([]);
    expect(paused(MOW_SN)).toHaveLength(1);
    expect(mocks.createRainSession.mock.calls.map(c => c[2])).toEqual([MOW_SN]);
  });

  it('a departure that reports COVERING for a moment is no mow either', async () => {
    outInTask(PATROL_SN, 'Mode:COVERAGE Work:COVERING Prev work:WAIT Recharge: WAIT', { patrol_phase: 'localizing' });
    startRainMonitor();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(paused(PATROL_SN)).toEqual([]);
  });

  it('after the patrol ended a mow is paused again', async () => {
    outInTask(PATROL_SN, 'Mode:COVERAGE Work:COVERING Prev work:MOVING Recharge: WAIT', { patrol_phase: 'done' });
    startRainMonitor();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(paused(PATROL_SN)).toHaveLength(1);
  });
});
