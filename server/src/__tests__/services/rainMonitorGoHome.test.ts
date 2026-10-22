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
import { startRainMonitor, stopRainMonitor, _resumeSession, RAIN_GO_HOME_TIMEOUT_MS } from '../../services/rainMonitor.js';
import { detectAndDispatch } from '../../notifications/eventDetector.js';
import { getRecentEvents } from '../../notifications/dispatcher.js';
import { ingestPositionTelemetry } from '../../services/positionTelemetry.js';

const PAUSED_AT = new Date('2026-07-01T10:00:00Z');   // summer: Amsterdam is UTC+2
const MIN = 60_000;
/** The reporter's last msg (GH #156), error_status OK. */
const STOPPED = 'Mode:COVERAGE Work:FAILED Prev work:RECOVER_ERROR_STOP Recharge: ALIGN_PILE';
const COVERING = 'Mode:COVERAGE Work:COVERING Prev work:USER_STOP Recharge: WAIT';

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
const events = (type: string) => getRecentEvents(SN, 50).filter(e => e.type === type);

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

describe('a rain go home that does not reach the dock', () => {
  it('tells the owner once, with what the mower reports and what to do', async () => {
    pausedSession();
    reports({ msg: STOPPED });
    startRainMonitor();
    await vi.advanceTimersByTimeAsync(RAIN_GO_HOME_TIMEOUT_MS - MIN);
    expect(events('dock_failed')).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    const [ev, ...rest] = events('dock_failed');
    expect(rest).toEqual([]);
    expect(ev.title).toBe('Mower could not dock');
    expect(ev.message).toBe(
      'The mower was sent home for rain but did not reach its dock within 10 minutes.'
      + ' It reports work state FAILED, recharge state ALIGN_PILE.'
      + ' Check it in the garden, clear what stopped it, and send it home from the app or the dashboard.');
    expect(ev.data).toMatchObject({ rain: true, session_id: `rain-${n}`, msg: STOPPED, error_status: '0' });
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(events('dock_failed')).toHaveLength(1);
  });

  it('names the error the mower reports', async () => {
    pausedSession();
    reports({ msg: 'Mode:COVERAGE Work:RECOVER_ERROR_STOP Prev work:SLIPPING_HANDLE Recharge: WAIT', error_status: '123' });
    startRainMonitor();
    await vi.advanceTimersByTimeAsync(RAIN_GO_HOME_TIMEOUT_MS);
    expect(events('dock_failed').map(e => e.message)).toEqual([
      'The mower was sent home for rain but did not reach its dock within 10 minutes.'
      + ' It reports work state RECOVER_ERROR_STOP, recharge state WAIT. Error 123: Wheels are slipping. Please check the surface.'
      + ' Check it in the garden, clear what stopped it, and send it home from the app or the dashboard.',
    ]);
  });

  it('a go home that ends on the dock: nothing', async () => {
    pausedSession();
    reports({ msg: 'Mode:COVERAGE Work:USER_STOP Prev work:COVERING Recharge: FINISHED', battery_state: 'CHARGING', recharge_status: '9' });
    startRainMonitor();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(events('dock_failed')).toEqual([]);
  });

  it('a mower that reached its dock and is taken off it later: nothing, the go home worked', async () => {
    pausedSession();
    reports({ battery_state: 'CHARGING', recharge_status: '9' });
    startRainMonitor();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    reports({ msg: STOPPED });
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(events('dock_failed')).toEqual([]);
  });

  // positionTelemetry counts recharge_status 1 as docked; on the wire it is the
  // drive home (RETURNING_RECHARGE_STATUS), so it must not settle the go home.
  it('a recharge_status 1 on the way home is no docking', async () => {
    pausedSession();
    reports({ recharge_status: '1' });
    startRainMonitor();
    await vi.advanceTimersByTimeAsync(5 * MIN - 1000);
    ingestPositionTelemetry(SN, { recharge_status: '1' });
    await vi.advanceTimersByTimeAsync(2000);   // the 5-minute tick, with that reading fresh
    reports({ msg: STOPPED });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(events('dock_failed')).toHaveLength(1);
  });

  // The stock app's Continue reaches the mower without the server knowing.
  it('a mower that is still driving or mows again: not while it moves', async () => {
    pausedSession();
    reports({ msg: COVERING, task_mode: '1' });
    startRainMonitor();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(events('dock_failed')).toEqual([]);
    reports({ msg: STOPPED });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(events('dock_failed')).toHaveLength(1);
  });

  it('an offline mower: nothing, its state is unknown', async () => {
    pausedSession();
    reports({ msg: STOPPED });
    mocks.isDeviceOnline.mockReturnValue(false);
    startRainMonitor();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(events('dock_failed')).toEqual([]);
  });

  it('one dock_failed per go home: a failed recharge the detector reported counts', async () => {
    pausedSession();
    reports();
    detectAndDispatch(SN, deviceCache.get(SN)!);
    reports({ msg: 'Mode:COVERAGE Work:USER_STOP Prev work:COVERING Recharge: FAILED' });
    detectAndDispatch(SN, deviceCache.get(SN)!);
    expect(events('dock_failed')).toHaveLength(1);
    startRainMonitor();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(events('dock_failed')).toHaveLength(1);
  });
});

describe('the rain is over and nothing is parked to resume', () => {
  it('on the dock: the owner hears that the mowing does not continue', () => {
    const session = pausedSession();
    reports({ msg: 'Mode:COVERAGE Work:WAIT Prev work:WAIT Recharge: FINISHED', work_status: '0', battery_state: 'CHARGING', recharge_status: '9' });
    _resumeSession(session);
    expect(cancelReasons()).toEqual(['no_parked_task']);
    const [ev, ...rest] = events('rain_resume_failed');
    expect(rest).toEqual([]);
    expect(ev.title).toBe('Mowing not resumed after rain');
    expect(ev.message).toBe(
      'The rain is over, but the mowing it paused cannot continue: the mower no longer has a paused task, for example after a restart.'
      + ' Start mowing again from the app or the dashboard.');
    expect(ev.data).toMatchObject({ rain: true, session_id: `rain-${n}`, on_dock: true });
  });

  it('off the dock (GH #156): what the mower reports and what to do', () => {
    const session = pausedSession();
    reports({ msg: STOPPED });
    _resumeSession(session);
    expect(cancelReasons()).toEqual(['no_parked_task']);
    expect(events('rain_resume_failed').map(e => e.message)).toEqual([
      'The rain is over, but the mowing it paused cannot continue: the mower no longer has a paused task and is not on its dock.'
      + ' It reports work state FAILED, recharge state ALIGN_PILE.'
      + ' Check it in the garden, clear what stopped it, then send it home or start mowing again from the app or the dashboard.',
    ]);
  });

  it('mowing again: the owner took over, nothing to say', () => {
    const session = pausedSession();
    reports({ msg: COVERING, task_mode: '1' });
    _resumeSession(session);
    expect(cancelReasons()).toEqual(['no_parked_task']);
    expect(events('rain_resume_failed')).toEqual([]);
  });

  it('end to end: the dry tick after a go home that stopped on the lawn', async () => {
    pausedSession();
    reports({ msg: STOPPED });
    mocks.shouldPauseForRain.mockReturnValue(false);
    startRainMonitor();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(cancelReasons()).toEqual(['no_parked_task']);
    expect(events('rain_resume_failed')).toHaveLength(1);
  });
});
