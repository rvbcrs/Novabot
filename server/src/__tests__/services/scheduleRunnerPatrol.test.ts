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
vi.mock('../../services/patrolService.js', () => ({ startPatrol: vi.fn(() => ({ ok: true, run: '1' })), PATROL_MIN_BATTERY: 50 }));
vi.mock('../../services/weatherService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/weatherService.js')>()),
  getWeatherForecast: vi.fn(),
}));
vi.mock('../../mqtt/sensorData.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mqtt/sensorData.js')>()),
  getDeviceSnapshot: vi.fn(() => null),
}));

import {
  startScheduleRunner, stopScheduleRunner, __getPendingEdgeForTest, disarmEdgeWatch, isScheduleWarning,
  renderScheduleReason,
} from '../../services/scheduleRunner.js';
import { isDeviceOnline } from '../../mqtt/broker.js';
import { emitScheduleEvent, pushMqttLog } from '../../dashboard/socketHandler.js';
import { scheduleRepo, rainSettingsRepo, mapRepo, patrolRunsRepo } from '../../db/repositories/index.js';
import { db } from '../../db/database.js';
import { startMowing } from '../../services/mowingService.js';
import { startPatrol } from '../../services/patrolService.js';
import { getWeatherForecast } from '../../services/weatherService.js';
import { getDeviceSnapshot, deviceCache } from '../../mqtt/sensorData.js';

const NOW = new Date('2026-08-05T23:00:30');
const SN = 'LFIN1231000211';
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** A forecast for NOW, which is night (sunset 4 hours ago), with one hour at `temperatureC` around the start. */
function nightForecast(temperatureC: number) {
  return {
    hourly: [{ time: '2026-08-05T23:00', epochMs: NOW.getTime(), precipitation: 0, precipitationProbability: 0, temperatureC }],
    sunriseMs: NOW.getTime() - 16 * 3_600_000, sunsetMs: NOW.getTime() - 4 * 3_600_000, cachedAt: 0,
  };
}

function due(id: string, kind: 'mow' | 'patrol') {
  scheduleRepo.create({
    schedule_id: id, mower_sn: SN, start_time: '23:00', kind,
    weekdays: JSON.stringify([NOW.getDay()]), enabled: 1, rain_pause: 0,
  });
}

/** A windowed patrol schedule: 23:00 until 06:00, every 30 min. */
function windowed(id: string) {
  scheduleRepo.create({
    schedule_id: id, mower_sn: SN, start_time: '23:00', end_time: '06:00', interval_min: 30, kind: 'patrol',
    weekdays: JSON.stringify([NOW.getDay()]), enabled: 1, rain_pause: 0,
  });
}
/** What the mower reports: charging on the dock with this battery. */
function dockedAt(battery: number, charging = true) {
  vi.mocked(getDeviceSnapshot).mockReturnValue({ battery_state: charging ? 'CHARGING' : 'DISCHARGING', battery_power: String(battery) });
}
/** The run the server holds for the mower. */
function lastRun(over: Partial<{ schedule_id: string | null; started_at: number; ended_phase: string | null; dock_failed_at: number | null }>) {
  vi.mocked(patrolRunsRepo.get).mockReturnValue({ mower_sn: SN, run: 'r1', token: 't', started_at: NOW.getTime(), schedule_id: 'w-23', ended_phase: 'done', dock_failed_at: null, ...over } as never);
}
/**
 * The decision the runner took for a slot, as updateLastTriggered writes it:
 * SQLite's UTC text without a zone marker. scheduleRepo.update cannot set it.
 */
function decidedAt(id: string, at: Date) {
  db.prepare('UPDATE dashboard_schedules SET last_triggered_at = ? WHERE schedule_id = ?')
    .run(at.toISOString().slice(0, 19).replace('T', ' '), id);
}
// The 23:00 slot was decided ten seconds after NOW (23:00:40 local).
const FIRST_SLOT_DECIDED = new Date(NOW.getTime() + 10_000);
// The 23:30 slot, decided ten seconds in.
const SECOND_SLOT_DECIDED = new Date('2026-08-05T23:30:40');

describe('patrol schedules', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM dashboard_schedules').run();
    rainSettingsRepo.set(SN, { nightGuard: true });
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(mapRepo, 'getChargerGps').mockReturnValue({ lat: 52, lng: 6 });
    vi.spyOn(patrolRunsRepo, 'get').mockReturnValue(undefined);   // no round of tonight, unless a test says so
    vi.mocked(getDeviceSnapshot).mockReturnValue(null);
    vi.mocked(isDeviceOnline).mockReturnValue(true);
    vi.mocked(getWeatherForecast).mockResolvedValue({
      hourly: [], sunriseMs: NOW.getTime() - 16 * 3_600_000, sunsetMs: NOW.getTime() - 4 * 3_600_000, cachedAt: 0,
    });
  });
  afterEach(() => {
    stopScheduleRunner();
    disarmEdgeWatch(SN, 'test cleanup');   // module state: do not leak an armed watcher into the next test
    deviceCache.delete(SN);
    rainSettingsRepo.set(SN, { frostGuard: false });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a patrol at night starts a patrol; a mow at night is still skipped', async () => {
    due('p-23', 'patrol');
    due('m-23', 'mow');
    startScheduleRunner();
    await flush();
    // The schedule goes with it, so a refusal by the mower shows on this schedule.
    expect(startPatrol).toHaveBeenCalledWith(SN, NOW.getTime(), 'p-23');
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
    vi.mocked(getWeatherForecast).mockResolvedValue(nightForecast(-1));
    due('p-frost', 'patrol');
    startScheduleRunner();
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();
    expect(scheduleRepo.findById('p-frost')!.last_result).toBe('skipped');
    // Skipped for frost, not for the night that a patrol ignores: a night skip
    // would leave the two lines above just as true.
    expect(emitScheduleEvent).toHaveBeenCalledWith('weather:paused', expect.objectContaining({ scheduleId: 'p-frost', reason: 'frost' }));
  });

  // A patrol reaches the night check only with the frost guard on, so this is
  // the one test that pins the night-guard exemption there. Without it, a mower
  // with both guards on would lose every nightly patrol, and the frost test
  // above could not tell (it is skipped either way).
  it('with both guards on, a patrol still starts on a night without frost', async () => {
    rainSettingsRepo.set(SN, { nightGuard: true, frostGuard: true, frostThresholdC: 3 });
    vi.mocked(getWeatherForecast).mockResolvedValue(nightForecast(12));
    due('p-warm', 'patrol');
    startScheduleRunner();
    await flush();
    expect(getWeatherForecast).toHaveBeenCalledTimes(1);   // the frost guard did look
    expect(startPatrol).toHaveBeenCalledWith(SN, expect.any(Number), expect.any(String));
    expect(scheduleRepo.findById('p-warm')!.last_result).toBe('started');
    expect(emitScheduleEvent).not.toHaveBeenCalledWith('weather:paused', expect.anything());
  });

  // Rain pause is always off for a patrol and the night guard does not apply to
  // it, so only the frost guard needs the weather. With it off there is nothing
  // to check, and nothing to warn about when the check could not run.
  it('a patrol with only the night guard on starts without the "check could not run" warning', async () => {
    vi.spyOn(mapRepo, 'getChargerGps').mockReturnValue(null);   // no charger position: no weather check possible
    due('p-23', 'patrol');
    startScheduleRunner();
    await flush();
    expect(startPatrol).toHaveBeenCalledWith(SN, expect.any(Number), expect.any(String));
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
    expect(startPatrol).toHaveBeenCalledWith(SN, expect.any(Number), expect.any(String));
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

  // ── Windows: a round per slot (spec 9) ───────────────────────────────────

  it('a windowed schedule starts its first round at the start like a single one', async () => {
    windowed('w-23');
    startScheduleRunner();
    await flush();
    expect(startPatrol).toHaveBeenCalledWith(SN, NOW.getTime(), 'w-23');
  });

  // A new window is a clean slate: last night's failed round and a mower that is
  // off the dock are for the start guards (startPatrol) to judge, as for a single start.
  it('the first round of a window keeps the start guards only: not the dock, not the last run', async () => {
    windowed('w-23');
    lastRun({ ended_phase: 'error', started_at: NOW.getTime() - 86_400_000 });
    dockedAt(30, false);
    startScheduleRunner();
    await flush();
    expect(startPatrol).toHaveBeenCalledWith(SN, NOW.getTime(), 'w-23');
  });

  it('a later slot starts the next round when the previous one is done and the mower charges', async () => {
    windowed('w-23');
    decidedAt('w-23', FIRST_SLOT_DECIDED);
    lastRun({ ended_phase: 'done' });
    dockedAt(80);
    vi.setSystemTime(new Date('2026-08-05T23:30:30'));
    startScheduleRunner();
    await flush();
    expect(startPatrol).toHaveBeenCalledTimes(1);
    expect(startPatrol).toHaveBeenCalledWith(SN, new Date('2026-08-05T23:30:30').getTime(), 'w-23');
  });

  it('a slot is skipped, once, while the previous round is still out', async () => {
    windowed('w-23');
    decidedAt('w-23', FIRST_SLOT_DECIDED);
    lastRun({ ended_phase: null });
    dockedAt(80, false);
    vi.setSystemTime(new Date('2026-08-05T23:30:30'));
    startScheduleRunner();
    await flush();
    vi.advanceTimersByTime(90_000);   // three more ticks inside the 5-minute window
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();
    const row = scheduleRepo.findById('w-23')!;
    expect(row.last_result).toBe('skipped');
    expect(renderScheduleReason('en', row.last_result_reason)).toBe('the round of 23:00 is still out');
    // One decision for the slot, not one per tick, and no notification: a skip is a line on the schedule.
    expect(pushMqttLog).toHaveBeenCalledTimes(1);
    expect(emitScheduleEvent).not.toHaveBeenCalled();
    // The skip also stamps the slot as decided. Without it the 5-minute window
    // decides the same slot again on every tick (the dedupe above would hide that).
    const stamped = Date.parse(row.last_triggered_at!.replace(' ', 'T') + 'Z');
    expect(stamped).toBeGreaterThanOrEqual(new Date('2026-08-05T23:30:00').getTime());
  });

  it('a slot is skipped when the mower is not charging on the dock, or its battery is below the patrol minimum', async () => {
    windowed('w-23');
    decidedAt('w-23', FIRST_SLOT_DECIDED);
    lastRun({ ended_phase: 'done' });
    dockedAt(80, false);
    vi.setSystemTime(new Date('2026-08-05T23:30:30'));
    startScheduleRunner();
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();
    let row = scheduleRepo.findById('w-23')!;
    expect(row.last_result).toBe('skipped');
    expect(renderScheduleReason('en', row.last_result_reason)).toBe('the mower is not charging on the dock');
    stopScheduleRunner();
    decidedAt('w-23', SECOND_SLOT_DECIDED);
    scheduleRepo.update('w-23', { last_result: null });
    dockedAt(40);
    vi.setSystemTime(new Date('2026-08-06T00:00:30'));
    startScheduleRunner();
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();
    row = scheduleRepo.findById('w-23')!;
    expect(row.last_result).toBe('skipped');
    expect(renderScheduleReason('en', row.last_result_reason)).toBe('battery 40 %, still charging (at least 50 %)');
  });

  // A container restart in the middle of a night leaves the snapshot cache empty until the mower
  // reports again, a few seconds later. That is "not known yet", not "not on the dock": the slot
  // is neither skipped nor stamped, and the next tick looks again.
  it('a later slot whose mower state is not known yet waits for the next tick', async () => {
    windowed('w-23');
    decidedAt('w-23', FIRST_SLOT_DECIDED);
    lastRun({ ended_phase: 'done' });
    vi.setSystemTime(new Date('2026-08-05T23:30:30'));
    const stamp = scheduleRepo.findById('w-23')!.last_triggered_at;
    startScheduleRunner();   // the cache is empty: getDeviceSnapshot gives null
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();
    expect(scheduleRepo.findById('w-23')).toMatchObject({ last_triggered_at: stamp, last_result: null });   // not stamped, nothing recorded
    expect(pushMqttLog).not.toHaveBeenCalled();

    // Only the position stream has reported so far: still nothing about the battery or the dock.
    vi.mocked(getDeviceSnapshot).mockReturnValue({ patrol_phase: 'idle', rain_paused: '0' });
    vi.advanceTimersByTime(30_000);
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();
    expect(scheduleRepo.findById('w-23')).toMatchObject({ last_triggered_at: stamp, last_result: null });
    expect(pushMqttLog).not.toHaveBeenCalled();

    // The first battery report arrives: the next tick starts the round, inside the slot's five minutes.
    dockedAt(80);
    vi.advanceTimersByTime(30_000);
    await flush();
    expect(startPatrol).toHaveBeenCalledTimes(1);
    expect(startPatrol).toHaveBeenCalledWith(SN, new Date('2026-08-05T23:31:30').getTime(), 'w-23');
  });

  // The online check comes before the round guards: an offline mower has no snapshot, which would
  // read as "not on the dock", skip the slot and stamp it, with no retry.
  it('an offline mower is logged as offline at a later slot too, and the slot is kept for when it is back', async () => {
    windowed('w-23');
    decidedAt('w-23', FIRST_SLOT_DECIDED);
    lastRun({ ended_phase: 'done' });
    vi.mocked(isDeviceOnline).mockReturnValue(false);   // its snapshot is gone as well (beforeEach: null)
    vi.setSystemTime(new Date('2026-08-05T23:30:30'));
    const stamp = scheduleRepo.findById('w-23')!.last_triggered_at;
    startScheduleRunner();
    await flush();
    vi.advanceTimersByTime(60_000);   // two more ticks, still offline
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();
    const row = scheduleRepo.findById('w-23')!;
    expect(row.last_result).toBe('skipped');
    expect(renderScheduleReason('en', row.last_result_reason)).toBe('mower offline');
    expect(pushMqttLog).toHaveBeenCalledTimes(1);   // one decision recorded, not one per tick
    expect(row.last_triggered_at).toBe(stamp);      // and the slot is not used up

    vi.mocked(isDeviceOnline).mockReturnValue(true);
    dockedAt(80);
    vi.advanceTimersByTime(30_000);
    await flush();
    expect(startPatrol).toHaveBeenCalledTimes(1);
    expect(startPatrol).toHaveBeenCalledWith(SN, new Date('2026-08-05T23:32:00').getTime(), 'w-23');
  });

  // The decision log is deduped per slot. If it were per day, the offline decision of 00:00 would
  // count as the one already logged for 23:30: last_result_at would stay at 23:30, and the 00:00
  // slot, deliberately not stamped so it can retry, would read as undecided and be logged "missed".
  it('an offline mower skips each later slot once, and no slot of the night reads as missed', async () => {
    windowed('w-23');
    // Created before the night: a slot of a newer schedule is never "missed", which would hide the bug.
    db.prepare("UPDATE dashboard_schedules SET created_at = '2026-08-01 08:00:00' WHERE schedule_id = ?").run('w-23');
    decidedAt('w-23', FIRST_SLOT_DECIDED);
    lastRun({ ended_phase: 'done' });
    vi.mocked(isDeviceOnline).mockReturnValue(false);
    vi.setSystemTime(new Date('2026-08-05T23:30:30'));
    const stamp = scheduleRepo.findById('w-23')!.last_triggered_at;
    startScheduleRunner();
    await flush();
    vi.advanceTimersByTime(36 * 60_000);   // to 00:06:30: the five minutes of the 23:30 and of the 00:00 slot are over
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();
    const row = scheduleRepo.findById('w-23')!;
    expect(row.last_result).toBe('skipped');
    expect(renderScheduleReason('en', row.last_result_reason)).toBe('mower offline');
    expect(Date.parse(row.last_result_at!)).toBeGreaterThanOrEqual(new Date('2026-08-06T00:00:00').getTime());   // the 00:00 slot refreshed it
    expect(row.last_triggered_at).toBe(stamp);   // and neither slot was used up: an offline slot stays open for a retry
    // One decision per slot, both the same, and nothing in between: no "missed".
    const logged = vi.mocked(pushMqttLog).mock.calls.map(([entry]) => entry.payload);
    expect(logged).toHaveLength(2);
    for (const line of logged) expect(line).toMatch(/^SKIPPED .* mower offline$/);
  });

  // setInterval ticks drift by a few milliseconds, and getScheduleOccurrence keeps the milliseconds
  // of the tick it is given: the occurrence in the log's dedupe key must not carry them, or a
  // single start (a mow, a once patrol) would log its decision again on every tick of its window.
  it('a single start logs its decision once, however much the ticks drift', async () => {
    vi.mocked(isDeviceOnline).mockReturnValue(false);
    due('p-once', 'patrol');
    for (const at of ['23:00:30.100', '23:01:00.157', '23:01:30.231', '23:02:00.998']) {
      stopScheduleRunner();
      vi.setSystemTime(new Date(`2026-08-05T${at}`));
      startScheduleRunner();
      await flush();
    }
    expect(pushMqttLog).toHaveBeenCalledTimes(1);   // "mower offline", once
    expect(scheduleRepo.findById('p-once')!.last_result).toBe('skipped');
  });

  // getDeviceSnapshot translates what the mower reports (CHARGING reads
  // "Charging", FULL reads "Full"), and a full battery on the dock is still on the
  // dock: the stock mqtt_node reports it as CHARGED (pipe_charge_status 3), and the server also knows FULL.
  // The other tests feed the guard the raw spelling; this one the real snapshot.
  it('reads the dock as the real snapshot has it: charging or full counts, anything else does not', async () => {
    const real = await vi.importActual<typeof import('../../mqtt/sensorData.js')>('../../mqtt/sensorData.js');
    vi.mocked(getDeviceSnapshot).mockImplementation(real.getDeviceSnapshot);
    for (const [state, starts] of [
      ['CHARGING', true], ['FULL', true], ['CHARGED', true],
      ['DISCHARGING', false], ['NOT_CHARGING', false], ['DISCHARGED', false], ['CHARGERROR', false],
    ] as const) {
      db.prepare('DELETE FROM dashboard_schedules').run();
      vi.clearAllMocks();
      deviceCache.set(SN, new Map([['battery_state', state], ['battery_power', '80']]));
      windowed('w-23');
      decidedAt('w-23', FIRST_SLOT_DECIDED);
      lastRun({ ended_phase: 'done' });
      vi.setSystemTime(new Date('2026-08-05T23:30:30'));
      startScheduleRunner();
      await flush();
      stopScheduleRunner();
      expect(startPatrol, state).toHaveBeenCalledTimes(starts ? 1 : 0);
    }
  });

  // Walter, 2026-10-21: one round that failed at a channel ended the whole night.
  // A mower back on the dock, charging, goes out again at the next slot.
  it('a round that failed, was stopped or did not dock does not end the night: the next slot starts on the dock', async () => {
    for (const over of [
      { ended_phase: 'error' }, { ended_phase: 'stopped' }, { ended_phase: 'done', dock_failed_at: NOW.getTime() + 1 },
    ]) {
      db.prepare('DELETE FROM dashboard_schedules').run();
      vi.clearAllMocks();
      windowed('w-23');
      decidedAt('w-23', FIRST_SLOT_DECIDED);
      lastRun(over);
      dockedAt(80);
      vi.setSystemTime(new Date('2026-08-05T23:30:30'));
      startScheduleRunner();
      await flush();
      stopScheduleRunner();
      expect(startPatrol, JSON.stringify(over)).toHaveBeenCalledTimes(1);
    }
  });

  // Without its own check, the single-start rule (five minutes after the start) would still
  // fire for a window that has ended within those five minutes.
  it('nothing starts once the window has ended, however short the window', async () => {
    scheduleRepo.create({
      schedule_id: 'w-short', mower_sn: SN, start_time: '23:00', end_time: '23:02', interval_min: 15, kind: 'patrol',
      weekdays: JSON.stringify([NOW.getDay()]), enabled: 1, rain_pause: 0,
    });
    vi.setSystemTime(new Date('2026-08-05T23:03:30'));
    startScheduleRunner();
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();
  });

  it('a slot the server slept through is missed, once, and names the slot', () => {
    windowed('w-23');
    db.prepare("UPDATE dashboard_schedules SET created_at = '2026-08-01 08:00:00' WHERE schedule_id = ?").run('w-23');
    decidedAt('w-23', FIRST_SLOT_DECIDED);
    vi.setSystemTime(new Date('2026-08-05T23:40:30'));   // the 23:30 slot's five minutes are over
    startScheduleRunner();
    const row = scheduleRepo.findById('w-23')!;
    expect(row.last_result).toBe('missed');
    expect(renderScheduleReason('en', row.last_result_reason)).toBe('server was not running at 23:30');
    expect(startPatrol).not.toHaveBeenCalled();
  });

  it('a once schedule (interval 0) and a mow schedule are untouched by the window code', async () => {
    // Make a slot at 23:30 start if the window code were to apply: the night guard off (else
    // a mow is skipped at night) and a mower that charges (else the round guards skip it).
    rainSettingsRepo.set(SN, { nightGuard: false });
    dockedAt(80);
    due('p-once', 'patrol');
    scheduleRepo.update('p-once', { end_time: '06:00', interval_min: 0 });
    due('m-23', 'mow');
    scheduleRepo.update('m-23', { end_time: '06:00', interval_min: 30 });
    vi.setSystemTime(new Date('2026-08-05T23:30:30'));
    startScheduleRunner();
    await flush();
    expect(startPatrol).not.toHaveBeenCalled();    // 23:30 is outside the 5-minute window of a 23:00 single start
    expect(startMowing).not.toHaveBeenCalled();
  });
});
