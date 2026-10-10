/**
 * Nacht-, vorst- en regenbewaking hebben een GPS-positie en een weerbericht
 * nodig. Kan de check niet, dan start de beurt toch (fail-open, zoals sinds de
 * eerste versie), maar niet meer stil: de reden staat op het schema, in de
 * MQTT-log en als event.
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
vi.mock('../../services/weatherService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/weatherService.js')>()),
  getWeatherForecast: vi.fn(),
}));

import {
  startScheduleRunner, stopScheduleRunner, renderScheduleReason, isScheduleWarning,
} from '../../services/scheduleRunner.js';
import { scheduleRepo, rainSettingsRepo, mapRepo } from '../../db/repositories/index.js';
import { db } from '../../db/database.js';
import { startMowing } from '../../services/mowingService.js';
import { getWeatherForecast } from '../../services/weatherService.js';
import { emitScheduleEvent, pushMqttLog } from '../../dashboard/socketHandler.js';

const NOW = new Date('2026-08-05T13:00:30');
const SN = 'LFIN1231000211';
const ID = 's-13:00';

function dueSchedule() {
  scheduleRepo.create({
    schedule_id: ID, mower_sn: SN, start_time: '13:00',
    weekdays: JSON.stringify([NOW.getDay()]), enabled: 1, rain_pause: 0,
  });
}

describe('schedule start when the weather guards cannot be checked', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM dashboard_schedules').run();
    db.prepare('DELETE FROM map_calibration').run();
    rainSettingsRepo.set(SN, { nightGuard: true });
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    stopScheduleRunner();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts without a charger GPS position, and says so on the schedule', () => {
    dueSchedule();
    startScheduleRunner();

    expect(startMowing).toHaveBeenCalledTimes(1);
    const row = scheduleRepo.findById(ID)!;
    expect(row.last_result).toBe('started');
    expect(renderScheduleReason('en', row.last_result_reason))
      .toBe('without the night, frost or rain check: the charging station has no GPS position');
    expect(renderScheduleReason('nl', row.last_result_reason))
      .toBe('zonder nacht-, vorst- of regencheck: geen GPS-positie van het laadstation');
    expect(isScheduleWarning(row.last_result, row.last_result_reason)).toBe(true);

    expect(emitScheduleEvent).toHaveBeenCalledWith('weather:unchecked', expect.objectContaining({
      scheduleId: ID, mowerSn: SN, reason: 'no_gps',
    }));
    // In the MQTT log as an error, so it stands out from a normal start.
    expect(pushMqttLog).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', sn: SN, payload: expect.stringContaining('STARTED'),
    }));
  });

  it('starts when the forecast fails, and keeps the error as the reason', async () => {
    vi.spyOn(mapRepo, 'getChargerGps').mockReturnValue({ lat: 52.1, lng: 5.1 });
    vi.mocked(getWeatherForecast).mockRejectedValue(new Error('Open-Meteo API error: 503'));
    dueSchedule();
    startScheduleRunner();

    await vi.waitFor(() => expect(startMowing).toHaveBeenCalledTimes(1));
    const row = scheduleRepo.findById(ID)!;
    expect(row.last_result).toBe('started');
    expect(renderScheduleReason('en', row.last_result_reason))
      .toBe('without the night, frost or rain check: weather forecast not fetched (Open-Meteo API error: 503)');
    expect(isScheduleWarning(row.last_result, row.last_result_reason)).toBe(true);
    expect(emitScheduleEvent).toHaveBeenCalledWith('weather:unchecked', expect.objectContaining({
      reason: 'forecast_failed',
    }));
  });

  it('a normal start carries no warning', () => {
    rainSettingsRepo.set(SN, { nightGuard: false });
    dueSchedule();
    startScheduleRunner();

    expect(startMowing).toHaveBeenCalledTimes(1);
    const row = scheduleRepo.findById(ID)!;
    expect(row.last_result).toBe('started');
    expect(isScheduleWarning(row.last_result, row.last_result_reason)).toBe(false);
    expect(emitScheduleEvent).not.toHaveBeenCalledWith('weather:unchecked', expect.anything());
  });

  it('only a human reason on a started run is a warning', () => {
    const msg = JSON.stringify({ key: 'maaier offline', values: [] });
    expect(isScheduleWarning('started', 'area=1 height=5cm dir=0°')).toBe(false);
    expect(isScheduleWarning('started', msg)).toBe(true);
    expect(isScheduleWarning('skipped', msg)).toBe(false);
    expect(isScheduleWarning('started', null)).toBe(false);
    expect(isScheduleWarning('started', '{not json')).toBe(false);
  });
});
