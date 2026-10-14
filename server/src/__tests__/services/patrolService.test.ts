// server/src/__tests__/services/patrolService.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../mqtt/extendedCommands.js', () => ({ publishExtendedCommand: vi.fn() }));
vi.mock('../../mqtt/mapSync.js', () => ({ publishToTopic: vi.fn(), publishToDevice: vi.fn(), getNextCmdNum: vi.fn(() => 1) }));
vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: vi.fn(() => true) }));
vi.mock('../../mqtt/sensorData.js', () => ({ deviceCache: new Map<string, Map<string, string>>() }));
vi.mock('../../services/mowerFileCapability.js', () => ({ isOpenNovaMower: vi.fn(() => true) }));
vi.mock('../../services/mowingService.js', () => ({ isMowerBusy: vi.fn(() => false), goHome: vi.fn(() => ({ ok: true })) }));
vi.mock('../../services/mowerMapOperation.js', () => ({ isMowerMapOperationBusy: vi.fn(() => false) }));
vi.mock('../../services/frameValidation.js', () => ({ isFrameUnvalidated: vi.fn(() => false) }));
vi.mock('../../services/anchor.js', () => ({ getPolygonAnchor: vi.fn(() => ({ x: 1, y: 1, orientation: 0, orientationSource: 'x' })) }));
vi.mock('../../services/positionTelemetry.js', () => ({
  freshPositionState: vi.fn(() => ({ fixed: false, running: false, docked: true, dockKnown: true, pose: null })),
}));
vi.mock('../../notifications/eventDetector.js', () => ({
  dispatchPatrolDetectionEvent: vi.fn(), dispatchPatrolFailedEvent: vi.fn(),
}));

import {
  startPatrol, stopPatrol, onPatrolStatus, onPatrolFrame, onPatrolRefused, readPatrolSettings, alertKinds, _resetPatrolState,
  isActivePatrolRun, PATROL_ALERT_GAP_MS, PATROL_HOME_DELAY_MS, PATROL_RUN_TTL_MS,
} from '../../services/patrolService.js';
import { publishExtendedCommand } from '../../mqtt/extendedCommands.js';
import { publishToTopic, publishToDevice } from '../../mqtt/mapSync.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { goHome } from '../../services/mowingService.js';
import { freshPositionState } from '../../services/positionTelemetry.js';
import { dispatchPatrolDetectionEvent, dispatchPatrolFailedEvent } from '../../notifications/eventDetector.js';
import { mapRepo, deviceSettingsRepo, scheduleRepo } from '../../db/repositories/index.js';
import { renderMsg, type Msg } from '../../services/serverText.js';
import { patrolDockingUnderWay } from '../../services/patrolRuns.js';

const SN = 'LFIN_PATROL_0001';
const SQ = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

function mower(fields: Record<string, string>) {
  deviceCache.set(SN, new Map(Object.entries({ sw_version: 'v6.0.2-custom-50', battery_power: '80', ...fields })));
}

/** What fresh telemetry says about the dock (positionTelemetry.freshPositionState). */
function dockTelemetry(state: { dockKnown: boolean; docked: boolean }) {
  vi.mocked(freshPositionState).mockReturnValue({ fixed: false, running: false, pose: null, ...state });
}

/** The run and token of the patrol command that startPatrol published last. */
function lastPatrol(): { run: string; token: string } {
  const calls = vi.mocked(publishExtendedCommand).mock.calls;
  return (calls[calls.length - 1][1] as { patrol: { run: string; token: string } }).patrol;
}

describe('patrol service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPatrolState();
    deviceCache.clear();
    dockTelemetry({ dockKnown: true, docked: true });
    for (const m of mapRepo.findByMowerSn(SN)) mapRepo.deleteWithCascade(m.map_id, SN);
    for (const r of deviceSettingsRepo.findBySn(SN)) deviceSettingsRepo.remove(SN, r.key);
    mapRepo.create({ map_id: 'pz0', mower_sn: SN, map_name: 'map0', canonical_name: 'map0',
      map_type: 'work', map_area: JSON.stringify(SQ), file_name: 'map0.csv' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a patrol of the dock zone with the saved settings', () => {
    mower({});
    deviceSettingsRepo.upsert(SN, 'patrol_dwell_s', '8');
    const r = startPatrol(SN, 1000);
    expect(r).toEqual({ ok: true, run: '1000' });
    const cmd = vi.mocked(publishExtendedCommand).mock.calls[0][1] as { patrol: { run: string; token: string; zones: Array<{ zone: string; points: number[][] }>; dwell_s: number; photo_topic: string } };
    expect(cmd.patrol.run).toBe('1000');
    expect(cmd.patrol.token).toMatch(/^[0-9a-f]{32}$/);
    expect(cmd.patrol.zones[0].zone).toBe('map0');
    expect(cmd.patrol.zones[0].points.length).toBeGreaterThan(0);
    expect(cmd.patrol.dwell_s).toBe(8);
    expect(cmd.patrol.photo_topic).toBe('front');
  });

  it('refuses a build without patrol, a low battery and a garden without checkpoints', () => {
    mower({ sw_version: 'v6.0.2-custom-49' });
    expect(startPatrol(SN).error).toContain('50');
    mower({ battery_power: '30' });
    expect(startPatrol(SN).ok).toBe(false);
    mower({});
    mapRepo.deleteWithCascade('pz0', SN);
    expect(startPatrol(SN).ok).toBe(false);
    expect(publishExtendedCommand).not.toHaveBeenCalled();
  });

  it('clamps settings and ignores nonsense', () => {
    deviceSettingsRepo.upsert(SN, 'patrol_spacing_m', '100');
    deviceSettingsRepo.upsert(SN, 'patrol_photo_topic', '/etc/passwd');
    deviceSettingsRepo.upsert(SN, 'patrol_zones', '["map1","x;y"]');
    const s = readPatrolSettings(SN);
    expect(s.spacingM).toBe(15);
    expect(s.photoTopic).toBe('front');
    expect(s.zones).toEqual(['map1']);
    expect(s.minPoints).toBe(40);
  });

  it('an error before the mower left the dock turns the light off but sends nobody home', () => {
    onPatrolStatus(SN, 'error', 'busy_mowing');
    expect(publishToTopic).toHaveBeenCalledWith(`novabot/cmd/${SN}`, { led_set: 0 });
    expect(goHome).not.toHaveBeenCalled();
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledWith(SN, 'busy_mowing', false);
  });

  it('a finished patrol: light on while out, off BEFORE go_to_charge', () => {
    onPatrolStatus(SN, 'patrolling');
    expect(publishToTopic).toHaveBeenCalledWith(`novabot/cmd/${SN}`, { led_set: 100 });
    onPatrolStatus(SN, 'done');
    const offCall = vi.mocked(publishToTopic).mock.calls.findIndex(c => (c[1] as { led_set: number }).led_set === 0);
    expect(offCall).toBeGreaterThan(-1);
    expect(vi.mocked(publishToTopic).mock.invocationCallOrder[offCall])
      .toBeLessThan(vi.mocked(goHome).mock.invocationCallOrder[0]);
  });

  it('localizing and returning are not ends: no light off, no docking, no failed event, and the mower still counts as out', () => {
    vi.useFakeTimers();
    onPatrolStatus(SN, 'localizing');
    onPatrolStatus(SN, 'patrolling');
    onPatrolStatus(SN, 'returning');
    onPatrolStatus(SN, 'localizing');
    expect(publishToTopic).toHaveBeenCalledTimes(1);   // the light on at patrolling, nothing since
    expect(publishToTopic).not.toHaveBeenCalledWith(`novabot/cmd/${SN}`, { led_set: 0 });
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).not.toHaveBeenCalled();
    expect(dispatchPatrolFailedEvent).not.toHaveBeenCalled();
    onPatrolStatus(SN, 'done');   // telemetry says docked, so only "was out" can send it home
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  it('starting is a no-op: no light, no docking, no failed event, and it does not count as having left the dock', () => {
    vi.useFakeTimers();
    onPatrolStatus(SN, 'starting');
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(publishToTopic).not.toHaveBeenCalled();
    expect(goHome).not.toHaveBeenCalled();
    expect(dispatchPatrolFailedEvent).not.toHaveBeenCalled();
    onPatrolStatus(SN, 'error', 'not_localized');   // the drive fails before it leaves the docked mower
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).not.toHaveBeenCalled();
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledWith(SN, 'not_localized', false);
  });

  it('a stop leaves the mower where it is, light off', () => {
    onPatrolStatus(SN, 'patrolling');
    onPatrolStatus(SN, 'stopped');
    expect(goHome).not.toHaveBeenCalled();
    expect(publishToTopic).toHaveBeenLastCalledWith(`novabot/cmd/${SN}`, { led_set: 0 });
  });

  it('a stop leaves a mower that telemetry sees off its dock where it is, even after the delay', () => {
    vi.useFakeTimers();
    dockTelemetry({ dockKnown: true, docked: false });
    onPatrolStatus(SN, 'patrolling');
    onPatrolStatus(SN, 'stopped');
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).not.toHaveBeenCalled();
  });

  it('an error out in the garden says so at once, turns the light off, and sends it home after the delay', () => {
    vi.useFakeTimers();
    onPatrolStatus(SN, 'patrolling');
    onPatrolStatus(SN, 'error', 'checkpoints_unreachable');
    expect(publishToTopic).toHaveBeenLastCalledWith(`novabot/cmd/${SN}`, { led_set: 0 });
    expect(goHome).not.toHaveBeenCalled();
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledWith(SN, 'checkpoints_unreachable', true);
    // The mower-side cleanup cancels every nav goal asynchronously: wait it out.
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS - 1);
    expect(goHome).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(goHome).toHaveBeenCalledTimes(1);
    expect(goHome).toHaveBeenCalledWith(SN);
  });

  it('an error before patrolling, with the mower seen off its dock, sends it home too', () => {
    vi.useFakeTimers();
    dockTelemetry({ dockKnown: true, docked: false });
    onPatrolStatus(SN, 'error', 'not_localized');
    expect(goHome).not.toHaveBeenCalled();
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledWith(SN, 'not_localized', true);
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).toHaveBeenCalledTimes(1);
    expect(goHome).toHaveBeenCalledWith(SN);
  });

  it('an error before patrolling with an unknown dock state sends nobody home', () => {
    vi.useFakeTimers();
    dockTelemetry({ dockKnown: false, docked: false });
    onPatrolStatus(SN, 'error', 'not_localized');
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).not.toHaveBeenCalled();
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledWith(SN, 'not_localized', false);
  });

  it.each(['busy_mowing', 'no_dock_zone'])('a refusal (%s) before anything moved never sends the mower home, also when it reads off its dock', reason => {
    vi.useFakeTimers();
    dockTelemetry({ dockKnown: true, docked: false });   // a live task owns the mower, it is out in the garden
    onPatrolStatus(SN, 'error', reason);
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).not.toHaveBeenCalled();
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledWith(SN, reason, false);
  });

  it('a refusal sends nobody home either when the server still counts the mower as out', () => {
    vi.useFakeTimers();
    dockTelemetry({ dockKnown: true, docked: false });
    onPatrolStatus(SN, 'patrolling');   // an older run whose end never arrived
    onPatrolStatus(SN, 'error', 'busy_mowing');
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).not.toHaveBeenCalled();
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledWith(SN, 'busy_mowing', false);
  });

  it('a finished patrol the server never saw leave still docks a mower that is off its dock, at once', () => {
    dockTelemetry({ dockKnown: true, docked: false });
    onPatrolStatus(SN, 'done');
    expect(goHome).toHaveBeenCalledTimes(1);
    expect(goHome).toHaveBeenCalledWith(SN);
  });

  it('a new patrol started within the delay cancels the docking of the failed one', () => {
    vi.useFakeTimers();
    mower({});
    onPatrolStatus(SN, 'patrolling');
    onPatrolStatus(SN, 'error', 'checkpoints_unreachable');
    expect(startPatrol(SN, 1000).ok).toBe(true);
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).not.toHaveBeenCalled();
  });

  it('a start that is refused leaves the docking of the failed patrol in place', () => {
    vi.useFakeTimers();
    mower({ battery_power: '30' });
    onPatrolStatus(SN, 'patrolling');
    onPatrolStatus(SN, 'error', 'checkpoints_unreachable');
    expect(startPatrol(SN, 1000).ok).toBe(false);
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).toHaveBeenCalledTimes(1);
    expect(goHome).toHaveBeenCalledWith(SN);
  });

  it('a patrol that starts after one whose end was lost does not inherit its "left the dock"', () => {
    vi.useFakeTimers();
    mower({});
    onPatrolStatus(SN, 'patrolling');   // the first patrol: reboot or MQTT drop, its end never arrives
    expect(startPatrol(SN, 1000).ok).toBe(true);
    onPatrolStatus(SN, 'error', 'not_localized');   // the second fails before it left the docked mower
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).not.toHaveBeenCalled();
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledWith(SN, 'not_localized', false);
  });

  it('a start that is refused keeps the running patrol counted as out', () => {
    mower({ battery_power: '30' });
    onPatrolStatus(SN, 'patrolling');
    expect(startPatrol(SN, 1000).ok).toBe(false);
    onPatrolStatus(SN, 'done');   // telemetry says docked, so only "was out" can send it home
    expect(goHome).toHaveBeenCalledTimes(1);
    expect(goHome).toHaveBeenCalledWith(SN);
  });

  it('a patrol that reports it is out within the delay cancels the docking of the failed one', () => {
    vi.useFakeTimers();
    onPatrolStatus(SN, 'patrolling');
    onPatrolStatus(SN, 'error', 'checkpoints_unreachable');
    onPatrolStatus(SN, 'patrolling');
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).not.toHaveBeenCalled();
  });

  it('a stop within the delay leaves the mower where it is', () => {
    vi.useFakeTimers();
    onPatrolStatus(SN, 'patrolling');
    onPatrolStatus(SN, 'error', 'checkpoints_unreachable');
    stopPatrol(SN);
    expect(publishExtendedCommand).toHaveBeenLastCalledWith(SN, { stop_mow_zone: {} });
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).not.toHaveBeenCalled();
  });

  it('a stop ends the firmware task first, then kills the patrol drive', () => {
    // stop_navigation ends the departure task while the patrol still localizes;
    // stop_mow_zone kills the drive.
    stopPatrol(SN);
    expect(publishToDevice).toHaveBeenCalledTimes(1);
    expect(publishToDevice).toHaveBeenCalledWith(SN, { stop_navigation: { cmd_num: 1 } });
    expect(publishExtendedCommand).toHaveBeenCalledTimes(1);
    expect(publishExtendedCommand).toHaveBeenCalledWith(SN, { stop_mow_zone: {} });
    expect(vi.mocked(publishToDevice).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(publishExtendedCommand).mock.invocationCallOrder[0]);
  });

  it('two errors in a row dock the mower once', () => {
    vi.useFakeTimers();
    dockTelemetry({ dockKnown: true, docked: false });
    onPatrolStatus(SN, 'error', 'not_localized');
    onPatrolStatus(SN, 'error', 'not_localized');
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  it('headlight 0 in the settings means no light at all', () => {
    deviceSettingsRepo.upsert(SN, 'patrol_headlight', '0');
    onPatrolStatus(SN, 'patrolling');
    expect(publishToTopic).not.toHaveBeenCalled();
  });

  it('no perception data is never an alert', () => {
    expect(alertKinds({ person: 500, animal: 500, frames: 1 }, 40)).toBeNull();
    expect(onPatrolFrame(SN, { run: '1', seq: 1, person: 500, animal: 0, frames: 1, image: true })).toEqual([]);
    expect(dispatchPatrolDetectionEvent).not.toHaveBeenCalled();
  });

  it('alerts once per class per run within the gap', () => {
    const f = { run: '1', seq: 1, person: 60, animal: 0, frames: 3, image: true };
    expect(onPatrolFrame(SN, f, 0)).toEqual(['person']);
    expect(onPatrolFrame(SN, { ...f, seq: 2 }, 1000)).toEqual([]);
    expect(onPatrolFrame(SN, { ...f, seq: 3 }, PATROL_ALERT_GAP_MS + 1)).toEqual(['person']);
    expect(onPatrolFrame(SN, { ...f, run: '2' }, PATROL_ALERT_GAP_MS + 2)).toEqual(['person']);
    expect(dispatchPatrolDetectionEvent).toHaveBeenCalledTimes(3);
    expect(dispatchPatrolDetectionEvent).toHaveBeenCalledWith(SN, { run: '1', seq: 1, kind: 'person', points: 60, image: true });
  });

  it('accepts a patrol run only with the token the server issued for it, within the TTL', () => {
    mower({});
    expect(startPatrol(SN, 1000).ok).toBe(true);
    const { run, token } = lastPatrol();
    expect(isActivePatrolRun(SN, run, token, 1000)).toBe(true);
    expect(isActivePatrolRun(SN, run, '0'.repeat(32), 1000)).toBe(false);
    expect(isActivePatrolRun(SN, run, 'abc', 1000)).toBe(false);
    expect(isActivePatrolRun(SN, '999', token, 1000)).toBe(false);
    expect(isActivePatrolRun('LFIN_PATROL_9999', run, token, 1000)).toBe(false);
    expect(isActivePatrolRun(SN, run, token, 1000 + PATROL_RUN_TTL_MS)).toBe(true);
    expect(isActivePatrolRun(SN, run, token, 1000 + PATROL_RUN_TTL_MS + 1)).toBe(false);
  });

  it('a newer patrol retires the token of the one before it', () => {
    mower({});
    expect(startPatrol(SN, 1000).ok).toBe(true);
    const first = lastPatrol();
    expect(startPatrol(SN, 2000).ok).toBe(true);
    const second = lastPatrol();
    expect(isActivePatrolRun(SN, first.run, first.token, 2000)).toBe(false);
    expect(isActivePatrolRun(SN, second.run, second.token, 2000)).toBe(true);
  });

  // An edge cut is an NTCP goal outside robot_decision: isMowerBusy does not
  // see it, and a patrol would drive beside it.
  it('refuses while an edge cut runs', () => {
    mower({ edge_active: '1' });
    const r = startPatrol(SN, 1000);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('the mower is cutting an edge; stop that first');
    expect(publishExtendedCommand).not.toHaveBeenCalled();
    mower({ edge_active: '0' });
    expect(startPatrol(SN, 1000).ok).toBe(true);
  });

  // A server restart in the middle of a patrol keeps that run's uploads and
  // its place: the run, token and start time are on disk.
  it('a restart in the middle of a patrol keeps taking its uploads and keeps the run filter', () => {
    vi.useFakeTimers();
    mower({});
    expect(startPatrol(SN, 1000).ok).toBe(true);
    const older = lastPatrol();
    expect(startPatrol(SN, 2000).ok).toBe(true);
    const { run, token } = lastPatrol();
    _resetPatrolState({ keepRuns: true });   // the server restarts: what is in memory is gone
    expect(isActivePatrolRun(SN, run, token, 2000)).toBe(true);
    expect(isActivePatrolRun(SN, older.run, older.token, 2000)).toBe(false);
    onPatrolStatus(SN, 'stopped', undefined, older.run);   // the taken-over run's late end
    expect(publishToTopic).not.toHaveBeenCalled();
    onPatrolStatus(SN, 'error', 'checkpoints_unreachable', run);
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledTimes(1);
  });

  it("an old run's late stopped leaves the newer run alone: no light off, still counted as out", () => {
    vi.useFakeTimers();
    mower({});
    expect(startPatrol(SN, 1000).ok).toBe(true);
    expect(startPatrol(SN, 2000).ok).toBe(true);
    onPatrolStatus(SN, 'patrolling', undefined, '2000');
    vi.mocked(publishToTopic).mockClear();
    onPatrolStatus(SN, 'stopped', undefined, '1000');
    expect(publishToTopic).not.toHaveBeenCalled();
    onPatrolStatus(SN, 'done', undefined, '2000');   // telemetry says docked: only "was out" docks it
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  // The mower re-sends its last status after every MQTT reconnect.
  it('a repeated end of the same run docks and notifies once', () => {
    vi.useFakeTimers();
    mower({});
    expect(startPatrol(SN, 1000).ok).toBe(true);
    onPatrolStatus(SN, 'patrolling', undefined, '1000');
    onPatrolStatus(SN, 'error', 'checkpoints_unreachable', '1000');
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    onPatrolStatus(SN, 'error', 'checkpoints_unreachable', '1000');
    _resetPatrolState({ keepRuns: true });   // also after a server restart
    onPatrolStatus(SN, 'error', 'checkpoints_unreachable', '1000');
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).toHaveBeenCalledTimes(1);
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledTimes(1);
  });

  it('a patrolling that arrives after its run ended switches nothing on and claims nothing', () => {
    mower({});
    expect(startPatrol(SN, 1000).ok).toBe(true);
    onPatrolStatus(SN, 'patrolling', undefined, '1000');
    onPatrolStatus(SN, 'done', undefined, '1000');
    vi.mocked(publishToTopic).mockClear();
    onPatrolStatus(SN, 'patrolling', undefined, '1000');   // re-sent before the end, arrived after it
    expect(publishToTopic).not.toHaveBeenCalled();
    expect(startPatrol(SN, 2000).ok).toBe(true);
    onPatrolStatus(SN, 'error', 'not_localized', '2000');   // docked: only "was out" could send it home
    expect(goHome).toHaveBeenCalledTimes(1);                // the first patrol's done, nothing more
  });

  // R3: the STOP button, a lift or a tilt end a patrol as `stopped` with that flag.
  it('a patrol stopped on the mower tells the owner once, and sends nobody home', () => {
    vi.useFakeTimers();
    mower({});
    dockTelemetry({ dockKnown: true, docked: false });
    expect(startPatrol(SN, 1000).ok).toBe(true);
    onPatrolStatus(SN, 'patrolling', undefined, '1000');
    onPatrolStatus(SN, 'stopped', 'error_push_button_stop', '1000');
    onPatrolStatus(SN, 'stopped', 'error_push_button_stop', '1000');   // re-sent after a reconnect
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).not.toHaveBeenCalled();
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledTimes(1);
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledWith(SN, 'error_push_button_stop', false, true);
    expect(publishToTopic).toHaveBeenLastCalledWith(`novabot/cmd/${SN}`, { led_set: 0 });
  });

  it("the owner's own stop notifies nobody", () => {
    mower({});
    expect(startPatrol(SN, 1000).ok).toBe(true);
    onPatrolStatus(SN, 'patrolling', undefined, '1000');
    onPatrolStatus(SN, 'stopped', undefined, '1000');
    expect(dispatchPatrolFailedEvent).not.toHaveBeenCalled();
    expect(goHome).not.toHaveBeenCalled();
  });

  // R4: the mower re-sends its last status after every reconnect, also when the
  // server's database lost the run (restored or reset).
  it('an end of a run the database does not know is handled once, and takes no uploads', () => {
    vi.useFakeTimers();
    dockTelemetry({ dockKnown: true, docked: false });
    onPatrolStatus(SN, 'error', 'checkpoints_unreachable', '5000');
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    onPatrolStatus(SN, 'error', 'checkpoints_unreachable', '5000');
    onPatrolStatus(SN, 'error', 'checkpoints_unreachable', '5000');
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).toHaveBeenCalledTimes(1);
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(publishToTopic).mock.calls.filter(c => (c[1] as { led_set: number }).led_set === 0)).toHaveLength(1);
    expect(isActivePatrolRun(SN, '5000', '0'.repeat(32), 5000)).toBe(false);
  });

  // R8: the drive home after a patrol reports Work:MOVING; that is no mow.
  it('marks the docking it starts after a patrol, at once after done and after the delay after an error', () => {
    vi.useFakeTimers();
    mower({});
    expect(startPatrol(SN, 1000).ok).toBe(true);
    onPatrolStatus(SN, 'patrolling', undefined, '1000');
    expect(patrolDockingUnderWay(SN, false)).toBe(false);
    onPatrolStatus(SN, 'done', undefined, '1000');
    expect(patrolDockingUnderWay(SN, false)).toBe(true);

    _resetPatrolState();
    expect(startPatrol(SN, 2000).ok).toBe(true);
    onPatrolStatus(SN, 'patrolling', undefined, '2000');
    onPatrolStatus(SN, 'error', 'checkpoints_unreachable', '2000');
    expect(patrolDockingUnderWay(SN, false)).toBe(false);
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(patrolDockingUnderWay(SN, false)).toBe(true);
  });

  it('a stop leaves the mower where it is: no docking to mark', () => {
    mower({});
    expect(startPatrol(SN, 1000).ok).toBe(true);
    onPatrolStatus(SN, 'patrolling', undefined, '1000');
    onPatrolStatus(SN, 'stopped', undefined, '1000');
    expect(patrolDockingUnderWay(SN, false)).toBe(false);
  });

  it('a repeated done docks once', () => {
    mower({});
    expect(startPatrol(SN, 1000).ok).toBe(true);
    onPatrolStatus(SN, 'patrolling', undefined, '1000');
    onPatrolStatus(SN, 'done', undefined, '1000');
    onPatrolStatus(SN, 'done', undefined, '1000');
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  it('a patrol the mower refused before anything moved: failed, never sent home, and its schedule shows it', () => {
    vi.useFakeTimers();
    mower({});
    dockTelemetry({ dockKnown: true, docked: false });
    scheduleRepo.create({
      schedule_id: 'p-refused', mower_sn: SN, start_time: '23:00', kind: 'patrol',
      weekdays: JSON.stringify([1]), enabled: 1, rain_pause: 0,
    });
    scheduleRepo.update('p-refused', { last_result: 'started', last_result_reason: 'patrol run=1000' });
    expect(startPatrol(SN, 1000, 'p-refused').ok).toBe(true);
    onPatrolRefused(SN, 'invalid_token');
    vi.advanceTimersByTime(PATROL_HOME_DELAY_MS);
    expect(goHome).not.toHaveBeenCalled();
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledWith(SN, 'invalid_token', false);
    const row = scheduleRepo.findById('p-refused')!;
    expect(row.last_result).toBe('failed');
    expect(renderMsg('en', JSON.parse(row.last_result_reason!) as Msg)).toBe('the mower refused the patrol (invalid_token)');
    onPatrolRefused(SN, 'invalid_token');   // once
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledTimes(1);
    scheduleRepo.delete('p-refused');
  });

  it('a refused patrol that no schedule started touches no schedule', () => {
    mower({});
    expect(startPatrol(SN, 1000).ok).toBe(true);
    onPatrolRefused(SN, 'drive_script_missing');
    expect(dispatchPatrolFailedEvent).toHaveBeenCalledWith(SN, 'drive_script_missing', false);
    expect(goHome).not.toHaveBeenCalled();
  });
});
