/**
 * A patrol schedule starts a patrol, not a mow, and is exactly what the night
 * guard keeps mowing from: it must run at night.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: vi.fn(() => true) }));
vi.mock('../../mqtt/mapSync.js', () => ({ publishToDevice: vi.fn(), publishToTopic: vi.fn() }));
vi.mock('../../dashboard/socketHandler.js', () => ({ emitScheduleEvent: vi.fn(), pushMqttLog: vi.fn() }));
vi.mock('../../services/mowingService.js', () => ({
  startMowing: vi.fn(() => ({ ok: true })),
  edgeBladeHeightMm: vi.fn(() => 40),
  getMowerPhase: vi.fn(() => 'idle'),
  startEdgeCut: vi.fn(() => ({ ok: true })),
  EDGE_ALWAYS_KEY: 'edge_always',
  edgeAlways: vi.fn(() => false),
}));
vi.mock('../../services/patrolService.js', () => ({ startPatrol: vi.fn(() => ({ ok: true, run: '1' })) }));
vi.mock('../../services/weatherService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/weatherService.js')>()),
  getWeatherForecast: vi.fn(),
}));

import {
  startScheduleRunner, stopScheduleRunner, __getPendingEdgeForTest, disarmEdgeWatch, isScheduleWarning,
} from '../../services/scheduleRunner.js';
import { emitScheduleEvent } from '../../dashboard/socketHandler.js';
import { scheduleRepo, rainSettingsRepo, mapRepo } from '../../db/repositories/index.js';
import { db } from '../../db/database.js';
import { startMowing } from '../../services/mowingService.js';
import { startPatrol } from '../../services/patrolService.js';
import { getWeatherForecast } from '../../services/weatherService.js';

const NOW = new Date('2026-08-05T23:00:30');
const SN = 'LFIN1231000211';
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function due(id: string, kind: 'mow' | 'patrol') {
  scheduleRepo.create({
    schedule_id: id, mower_sn: SN, start_time: '23:00', kind,
    weekdays: JSON.stringify([NOW.getDay()]), enabled: 1, rain_pause: 0,
  });
}

describe('patrol schedules', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM dashboard_schedules').run();
    rainSettingsRepo.set(SN, { nightGuard: true });
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(mapRepo, 'getChargerGps').mockReturnValue({ lat: 52, lng: 6 });
    vi.mocked(getWeatherForecast).mockResolvedValue({
      hourly: [], sunriseMs: NOW.getTime() - 16 * 3_600_000, sunsetMs: NOW.getTime() - 4 * 3_600_000, cachedAt: 0,
    });
  });
  afterEach(() => {
    stopScheduleRunner();
    disarmEdgeWatch(SN, 'test cleanup');   // module state: do not leak an armed watcher into the next test
    rainSettingsRepo.set(SN, { frostGuard: false });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a patrol at night starts a patrol; a mow at night is still skipped', async () => {
    due('p-23', 'patrol');
    due('m-23', 'mow');
    startScheduleRunner();
    await flush();
    expect(startPatrol).toHaveBeenCalledWith(SN);
    expect(startMowing).not.toHaveBeenCalled();
    expect(scheduleRepo.findById('p-23')!.last_result).toBe('started');
    expect(scheduleRepo.findById('m-23')!.last_result).toBe('skipped');
  });

  it('a refused patrol is recorded as not started', async () => {
    vi.mocked(startPatrol).mockReturnValueOnce({ ok: false, error: 'battery too low' });
    due('p-23', 'patrol');
    startScheduleRunner();
    await flush();
    expect(scheduleRepo.findById('p-23')!.last_result).toBe('failed');
  });

  // The night guard is the one guard a patrol ignores; the frost guard stays.
  it('the frost guard still holds a patrol back', async () => {
    rainSettingsRepo.set(SN, { nightGuard: true, frostGuard: true, frostThresholdC: 3 });
    vi.mocked(getWeatherForecast).mockResolvedValue({
      hourly: [{ time: '2026-08-05T23:00', epochMs: NOW.getTime(), precipitation: 0, precipitationProbability: 0, temperatureC: -1 }],
      sunriseMs: NOW.getTime() - 16 * 3_600_000, sunsetMs: NOW.getTime() - 4 * 3_600_000, cachedAt: 0,
    });
    due('p-frost', 'patrol');
    startScheduleRunner();
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();
    expect(scheduleRepo.findById('p-frost')!.last_result).toBe('skipped');
  });

  // Rain pause is always off for a patrol and the night guard does not apply to
  // it, so only the frost guard needs the weather. With it off there is nothing
  // to check, and nothing to warn about when the check could not run.
  it('a patrol with only the night guard on starts without the "check could not run" warning', async () => {
    vi.spyOn(mapRepo, 'getChargerGps').mockReturnValue(null);   // no charger position: no weather check possible
    due('p-23', 'patrol');
    startScheduleRunner();
    await flush();
    expect(startPatrol).toHaveBeenCalledWith(SN);
    const row = scheduleRepo.findById('p-23')!;
    expect(row.last_result).toBe('started');
    expect(isScheduleWarning(row.last_result, row.last_result_reason)).toBe(false);
    expect(row.last_result_reason).not.toContain('regencheck');
    expect(emitScheduleEvent).not.toHaveBeenCalledWith('weather:unchecked', expect.anything());
  });

  // With no charger position the forecast cannot be fetched either way, so the
  // case above cannot show it: here the position is known.
  it('a patrol with only the night guard on fetches no forecast', async () => {
    due('p-23', 'patrol');
    startScheduleRunner();
    await flush();
    expect(startPatrol).toHaveBeenCalledWith(SN);
    expect(getWeatherForecast).not.toHaveBeenCalled();
  });

  // An edge cut armed by an earlier mow waits on the dock until the mower has
  // charged. A patrol that leaves the dock at night must take that watcher
  // with it, or the edge cut would start with the blades spinning when the
  // patrol docks. The POST /patrol route disarms it the same way.
  it('a started patrol disarms an edge cut armed by an earlier mow; a refused one leaves it armed', () => {
    // The night guard off, so the mow of an edge day starts (a mow is skipped at night).
    rainSettingsRepo.set(SN, { nightGuard: false });
    scheduleRepo.create({
      schedule_id: 'm-edge', mower_sn: SN, start_time: '23:00', kind: 'mow',
      weekdays: JSON.stringify([NOW.getDay()]), enabled: 1, rain_pause: 0,
      edge_days: JSON.stringify([NOW.getDay()]),
    });
    startScheduleRunner();
    expect(startMowing).toHaveBeenCalledTimes(1);
    expect(__getPendingEdgeForTest().has(SN)).toBe(true);

    // A refused patrol does not move the mower: the watcher stays armed.
    vi.mocked(startPatrol).mockReturnValueOnce({ ok: false, error: 'battery too low' });
    due('p-refused', 'patrol');
    vi.advanceTimersByTime(30_000);   // the runner looks again, still inside the 5-minute window
    expect(startPatrol).toHaveBeenCalledTimes(1);
    expect(__getPendingEdgeForTest().has(SN)).toBe(true);

    // An accepted patrol takes the mower off the dock: the watcher is gone.
    due('p-ok', 'patrol');
    vi.advanceTimersByTime(30_000);
    expect(startPatrol).toHaveBeenCalledTimes(2);
    expect(startMowing).toHaveBeenCalledTimes(1);   // neither patrol was started as a mow
    expect(__getPendingEdgeForTest().has(SN)).toBe(false);
  });
});
