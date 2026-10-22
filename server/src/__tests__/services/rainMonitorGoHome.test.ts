/**
 * GH #156: the rain monitor sent the mower home, it never reached its dock
 * (Work:FAILED after a recover error stop, out on the lawn), and when the rain
 * was over the session was dropped as no_parked_task without a word to the
 * owner.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RainSessionRow } from '../../db/repositories/schedules.js';

const mocks = vi.hoisted(() => ({
  isDeviceOnline: vi.fn((_sn: string) => true),
  publishToDevice: vi.fn(),
  // A cancelled or resumed session is no longer paused, as in the table.
  cancelRainSession: vi.fn((id: string) => { mocks.sessions = mocks.sessions.filter(s => s.session_id !== id); }),
  resumeRainSession: vi.fn((id: string) => { mocks.sessions = mocks.sessions.filter(s => s.session_id !== id); }),
  emitScheduleEvent: vi.fn(),
  shouldPauseForRain: vi.fn(() => true),   // still raining
  sessions: [] as RainSessionRow[],
}));
vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: mocks.isDeviceOnline }));
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToDevice: mocks.publishToDevice,
  publishToTopic: vi.fn(),
  goToChargePayload: vi.fn(() => ({ go_to_charge: {} })),
  getNextCmdNum: vi.fn(() => 7),
}));
vi.mock('../../dashboard/socketHandler.js', () => ({ emitScheduleEvent: mocks.emitScheduleEvent }));
vi.mock('../../services/weatherService.js', () => ({
  getWeatherForecast: vi.fn().mockResolvedValue({ hourly: [] }),
  shouldPauseForRain: mocks.shouldPauseForRain,
}));
vi.mock('../../db/repositories/index.js', () => ({
  scheduleRepo: {
    findDistinctMowersWithRainPause: vi.fn(() => []),
    findRainSessionByMower: vi.fn((sn: string, state: string) =>
      state === 'paused' ? mocks.sessions.find(s => s.mower_sn === sn) : undefined),
    findActiveRainSchedule: vi.fn(() => undefined),
    findPausedRainSessions: vi.fn(() => mocks.sessions),
    cancelRainSession: mocks.cancelRainSession,
    resumeRainSession: mocks.resumeRainSession,
  },
  mapRepo: { getChargerGps: vi.fn(() => ({ lat: 52, lng: 6 })) },
  rainSettingsRepo: {
    getEffective: vi.fn(() => ({ enabled: true, thresholdMm: 0.1, thresholdProbability: 50, lookaheadHours: 0.5 })),
  },
}));

import { deviceCache } from '../../mqtt/sensorData.js';
import { startRainMonitor, stopRainMonitor } from '../../services/rainMonitor.js';

const PAUSED_AT = new Date('2026-07-01T10:00:00Z');   // summer: Amsterdam is UTC+2
const MIN = 60_000;

// Every case its own mower and session: the monitor's memory outlives a test.
let n = 0;
let SN = '';

/** A paused rain session as SQLite stores it: paused_at from datetime('now'), UTC without a zone. */
function pausedSession(): RainSessionRow {
  const row = {
    session_id: `rain-${n}`, schedule_id: 'manual', mower_sn: SN, state: 'paused',
    rain_threshold_mm: 0.1, rain_threshold_probability: 50, rain_check_hours: 0.5,
    paused_at: PAUSED_AT.toISOString().slice(0, 19).replace('T', ' '),
  } as RainSessionRow;
  mocks.sessions = [row];
  return row;
}

/** The mower's last report, with fields overridden. */
function reports(extra: Record<string, string> = {}) {
  deviceCache.set(SN, new Map(Object.entries({
    battery_power: '85', battery_state: 'DISCHARGING', recharge_status: '0', error_status: '0',
    msg: 'Mode:COVERAGE Work:USER_STOP Prev work:COVERING Recharge: GOING', ...extra,
  })));
}

const cancelReasons = () => mocks.emitScheduleEvent.mock.calls
  .filter(c => c[0] === 'rain:cancelled').map(c => (c[1] as { reason: string }).reason);

const originalTz = process.env.TZ;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: PAUSED_AT });
  mocks.isDeviceOnline.mockReturnValue(true);
  mocks.shouldPauseForRain.mockReturnValue(true);
  n += 1;
  SN = `LFIN_RAIN_HOME_${n}`;
});
afterEach(() => {
  stopRainMonitor();
  vi.useRealTimers();
  deviceCache.clear();
  mocks.sessions = [];
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

// paused_at is UTC without a zone, and new Date() reads such a string as local
// time: in the container's Europe/Amsterdam a pause looked two hours old the
// moment it began, and west of UTC the timeouts came hours late.
describe('the age of a rain session', () => {
  it('east of UTC: a mower offline for five minutes keeps its session', async () => {
    process.env.TZ = 'Europe/Amsterdam';
    pausedSession();
    mocks.isDeviceOnline.mockReturnValue(false);
    startRainMonitor();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(mocks.cancelRainSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(cancelReasons()).toEqual(['mower_offline_timeout']);
  });

  it('west of UTC: the six-hour timeout comes after six hours', async () => {
    process.env.TZ = 'America/New_York';
    pausedSession();
    reports();
    startRainMonitor();
    await vi.advanceTimersByTimeAsync(6 * 60 * MIN + 5 * MIN);
    expect(cancelReasons()).toEqual(['timeout_6h']);
  });
});
