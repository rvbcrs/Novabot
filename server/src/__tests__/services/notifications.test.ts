import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub publishToTopic before importing the dispatcher so the module sees
// the mock from first load. mapSync.ts pulls in MQTT bindings that
// require a live broker context — we don't want that during unit tests.
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToTopic: vi.fn(),
}));

import { detectAndDispatch, resetEventState } from '../../notifications/eventDetector.js';
import { dispatchEvent, getRecentEvents, setDashboardEventEmitter } from '../../notifications/dispatcher.js';
import { publishToTopic } from '../../mqtt/mapSync.js';
import { patrolRunsRepo } from '../../db/repositories/patrolRuns.js';
import { markPatrolDocking, PATROL_DOCKING_MAX_MS, _resetPatrolDocking } from '../../services/patrolRuns.js';

const SN = 'LFIN1231000211';

function snap(map: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(map));
}

beforeEach(() => {
  resetEventState(SN);
  // dispatcher's ring buffer accumulates across tests; we don't reset it
  // because each test asserts on its own emitted events anyway.
  vi.mocked(publishToTopic).mockClear();
});

describe('eventDetector', () => {
  it('emits no events on the first frame (initial snapshot)', () => {
    detectAndDispatch(SN, snap({ error_status: '0', msg: 'Mode:COVERAGE Work:WAIT', battery_power: '90', recharge_status: '0' }));
    const events = getRecentEvents(SN, 50);
    // Filter to events emitted after this test's reset to keep the
    // assertion independent from test ordering.
    expect(events.filter(e => e.ts > Date.now() - 100)).toHaveLength(0);
  });

  it('emits generic "error" for unmapped error_status codes (off dock)', () => {
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGED' }));
    detectAndDispatch(SN, snap({ error_status: '99', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGED', error_msg: 'unknown fault' }));
    const ev = getRecentEvents(SN, 1)[0];
    expect(ev.type).toBe('error');
    expect(ev.data.error_status).toBe('99');
    // Unmapped codes use the firmware's own error_msg as the body.
    expect(ev.message).toBe('unknown fault');
  });

  it('SUPPRESSES code 8 (LoRa flicker) — too noisy', () => {
    const before = getRecentEvents(SN, 50).length;
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGED' }));
    detectAndDispatch(SN, snap({ error_status: '8', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGED', error_msg: 'LoRa lost' }));
    const after = getRecentEvents(SN, 50).length;
    expect(after).toBe(before);
  });

  it('SUPPRESSES any error while on dock (CHARGING)', () => {
    const before = getRecentEvents(SN, 50).length;
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'CHARGING' }));
    detectAndDispatch(SN, snap({ error_status: '124', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'CHARGING', error_msg: 'out of area' }));
    const after = getRecentEvents(SN, 50).length;
    expect(after).toBe(before);
  });

  it('emits "stuck" for code 124 (return-to-charge fail) — only off dock', () => {
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGED' }));
    detectAndDispatch(SN, snap({ error_status: '124', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGED', error_msg: 'recharge fail' }));
    const ev = getRecentEvents(SN, 1)[0];
    expect(ev.type).toBe('stuck');
  });

  it('emits "safety" for tilt code 158', () => {
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '0' }));
    detectAndDispatch(SN, snap({ error_status: '158', msg: '', battery_power: '90', recharge_status: '0', error_msg: '' }));
    const ev = getRecentEvents(SN, 1)[0];
    expect(ev.type).toBe('safety');
    expect(ev.message).toContain('tilted');
  });

  it('SUPPRESSES code 132 (transmission loss) — auto-recovers', () => {
    const before = getRecentEvents(SN, 50).length;
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGED' }));
    detectAndDispatch(SN, snap({ error_status: '132', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGED', error_msg: '' }));
    const after = getRecentEvents(SN, 50).length;
    expect(after).toBe(before);
  });

  it('emits "error_cleared" on non-zero → 0 transition (off dock, real code)', () => {
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGED' }));
    detectAndDispatch(SN, snap({ error_status: '124', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGED' }));
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGED' }));
    const ev = getRecentEvents(SN, 1)[0];
    expect(ev.type).toBe('error_cleared');
  });

  it('does NOT emit "error_cleared" when the prior error was suppressed', () => {
    const before = getRecentEvents(SN, 50).length;
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGED' }));
    detectAndDispatch(SN, snap({ error_status: '8', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGED' }));
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGED' }));
    const after = getRecentEvents(SN, 50).length;
    expect(after).toBe(before);
  });

  it('emits mowing_started when msg enters Work:RUNNING', () => {
    detectAndDispatch(SN, snap({ error_status: '0', msg: 'Mode:COVERAGE Work:WAIT', battery_power: '90', recharge_status: '0' }));
    detectAndDispatch(SN, snap({ error_status: '0', msg: 'Mode:COVERAGE Work:RUNNING', battery_power: '90', recharge_status: '0' }));
    const ev = getRecentEvents(SN, 1)[0];
    expect(ev.type).toBe('mowing_started');
  });

  it('emits mowing_finished only when error_status=0 at completion', () => {
    detectAndDispatch(SN, snap({ error_status: '0', msg: 'Mode:COVERAGE Work:RUNNING', battery_power: '90', recharge_status: '0' }));
    detectAndDispatch(SN, snap({ error_status: '0', msg: 'Mode:COVERAGE Work:FINISHED', battery_power: '90', recharge_status: '0' }));
    const ev = getRecentEvents(SN, 1)[0];
    expect(ev.type).toBe('mowing_finished');
  });

  it('emits docked when recharge_status reaches 9', () => {
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '1' }));
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '9' }));
    const ev = getRecentEvents(SN, 1)[0];
    expect(ev.type).toBe('docked');
  });

  it('emits low_battery only on the descending crossing', () => {
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '40', recharge_status: '0' }));
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '15', recharge_status: '0' }));
    let ev = getRecentEvents(SN, 1)[0];
    expect(ev.type).toBe('low_battery');
    expect(ev.data.battery_power).toBe(15);

    // Staying low must not re-trigger.
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '12', recharge_status: '0' }));
    ev = getRecentEvents(SN, 1)[0];
    expect(ev.type).toBe('low_battery');
    expect(ev.data.battery_power).toBe(15);   // still the original event, not 12
  });
});

// A night patrol leaves the dock through the firmware's own departure, a
// coverage task that reports Work:MOVING: that is no mow, and "Mowing started"
// on every patrol was a false push.
describe('mowing events during a night patrol', () => {
  // Every case its own mower: the dispatcher's event list outlives a test.
  let n = 0;
  let PSN = '';
  const frame = (msg: string, patrolPhase?: string) => snap({
    error_status: '0', msg, battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGING',
    ...(patrolPhase ? { patrol_phase: patrolPhase } : {}),
  });
  const mowingEvents = () => getRecentEvents(PSN, 50)
    .filter(e => e.type === 'mowing_started' || e.type === 'mowing_finished');
  beforeEach(() => {
    n += 1;
    PSN = `LFIN_NOTIFY_PATROL_${n}`;
    resetEventState(PSN);
    _resetPatrolDocking();
    patrolRunsRepo.start({ mower_sn: PSN, run: String(Date.now()), token: '0'.repeat(32), started_at: Date.now(), schedule_id: null });
  });

  it('no mowing started or finished while the patrol drives', () => {
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:WAIT', 'starting'));
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:MOVING', 'localizing'));
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:FINISHED', 'patrolling'));
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:MOVING', 'returning'));
    expect(mowingEvents()).toEqual([]);
  });

  it('the departure seen during the patrol is not reported once the patrol has ended', () => {
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:WAIT', 'starting'));
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:MOVING', 'localizing'));
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:MOVING', 'stopped'));
    expect(mowingEvents()).toEqual([]);
  });

  it('a mow after the patrol is reported again', () => {
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:WAIT', 'done'));
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:RUNNING', 'done'));
    expect(mowingEvents().map(e => e.type)).toEqual(['mowing_started']);
  });

  // R5: a cached phase never expires; without a run that is out, a mow is a mow.
  it('a stale patrol phase without a live run keeps no mowing push away', () => {
    patrolRunsRepo.clearAll();
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:WAIT', 'patrolling'));
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:RUNNING', 'patrolling'));
    expect(mowingEvents().map(e => e.type)).toEqual(['mowing_started']);
  });

  // R8: after a patrol the server sends the mower home, and the firmware reports
  // Work:MOVING on the way. From that go home until the mower is docked or
  // charging (at most 15 minutes) that is no mow.
  const docked = (msg: string) => snap({
    error_status: '0', msg, battery_power: '90', recharge_status: '9', battery_state: 'CHARGING', patrol_phase: 'done',
  });

  it("no 'Mowing started' or 'Mowing finished' for the drive home after a patrol", () => {
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:WAIT', 'done'));
    markPatrolDocking(PSN);
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:MOVING', 'done'));
    detectAndDispatch(PSN, docked('Mode:COVERAGE Work:FINISHED'));
    expect(mowingEvents()).toEqual([]);
  });

  it('once it is docked, a mow is reported again', () => {
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:WAIT', 'done'));
    markPatrolDocking(PSN);
    detectAndDispatch(PSN, docked('Mode:COVERAGE Work:WAIT'));
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:RUNNING', 'done'));
    expect(mowingEvents().map(e => e.type)).toEqual(['mowing_started']);
  });

  it('after 15 minutes without a dock it ends as well', () => {
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:WAIT', 'done'));
    markPatrolDocking(PSN, Date.now() - PATROL_DOCKING_MAX_MS - 1);
    detectAndDispatch(PSN, frame('Mode:COVERAGE Work:RUNNING', 'done'));
    expect(mowingEvents().map(e => e.type)).toEqual(['mowing_started']);
  });
});

// Novabot-bqzs, live 2026-10-15: patrol_failed said the mower was sent back to
// its dock, the recharge then failed (error 126, nav2 "goal is occupied" at the
// pile pose) and the mower stood 17 m out for six hours without another word.
// From the server's go home after a patrol until the mower charges (at most 15
// minutes) a recharge that fails is one dock_failed that says so.
describe('dock_failed after the drive home of a night patrol', () => {
  const PATROL_SENTENCE = 'Docking after the patrol failed; the mower is standing still in the garden.';
  const GENERIC_SENTENCE = 'Mower returned to the charger but failed to dock';
  const RUN = '1760000000000';
  const GOING = 'Mode:COVERAGE Work:MOVING Prev work:FINISHED Recharge: GOING';
  const FAILED = 'Mode:COVERAGE Work:MOVING Prev work:FINISHED Recharge: FAILED';
  // Every case its own mower: the dispatcher's event list outlives a test.
  let n = 0;
  let PSN = '';
  const frame = (extra: Record<string, string> = {}) => snap({
    error_status: '0', msg: GOING, battery_power: '90', recharge_status: '0', battery_state: 'DISCHARGING', ...extra,
  });
  const charging = (extra: Record<string, string> = {}) => frame({
    msg: 'Mode:COVERAGE Work:FINISHED Prev work:MOVING Recharge: FINISHED', recharge_status: '9', battery_state: 'CHARGING', ...extra,
  });
  const events = (type: string) => getRecentEvents(PSN, 50).filter(e => e.type === type);
  const dockFailedAt = () => patrolRunsRepo.get(PSN)?.dock_failed_at;

  beforeEach(() => {
    n += 1;
    PSN = `LFIN_NOTIFY_DOCK_${n}`;
    resetEventState(PSN);
    _resetPatrolDocking();
    patrolRunsRepo.start({ mower_sn: PSN, run: RUN, token: '0'.repeat(32), started_at: Date.now(), schedule_id: null });
    detectAndDispatch(PSN, frame());   // the first frame only sets the snapshot
  });

  it('a recharge that fails after the go home is one dock_failed that says the patrol docking failed', () => {
    markPatrolDocking(PSN);
    detectAndDispatch(PSN, frame({ msg: FAILED }));
    const [ev, ...rest] = events('dock_failed');
    expect(rest).toEqual([]);
    expect(ev.title).toBe('Mower could not dock');
    expect(ev.message).toBe(PATROL_SENTENCE);
    expect(ev.data).toMatchObject({ patrol: true, run: RUN });
  });

  it('the failure is recorded on the run', () => {
    expect(dockFailedAt()).toBeNull();
    markPatrolDocking(PSN);
    const before = Date.now();
    detectAndDispatch(PSN, frame({ msg: FAILED }));
    expect(dockFailedAt()).toBeGreaterThanOrEqual(before);
  });

  // Error 126 (MOVE_ROBOT_FAIL, "Return-to-charge failed") is what the first
  // live patrol showed.
  it('error 126 after the go home is a failed docking too, when the msg does not say so', () => {
    markPatrolDocking(PSN);
    detectAndDispatch(PSN, frame({ error_status: '126', error_msg: 'recharge fail' }));
    const [ev, ...rest] = events('dock_failed');
    expect(rest).toEqual([]);
    expect(ev.message).toBe(PATROL_SENTENCE);
    expect(ev.data).toMatchObject({ patrol: true, run: RUN, error_status: '126' });
    expect(dockFailedAt()).not.toBeNull();
  });

  // Error 113 ("no aruco code find") comes up while the firmware retries the
  // alignment at the dock, and goes away again: no failed docking by itself.
  it('error 113 inside the window raises nothing, and records nothing on the run', () => {
    markPatrolDocking(PSN);
    detectAndDispatch(PSN, frame({ error_status: '113', error_msg: 'no aruco code find' }));
    expect(events('dock_failed')).toEqual([]);
    expect(dockFailedAt()).toBeNull();
  });

  it('error 113 followed by Recharge: FAILED raises once', () => {
    markPatrolDocking(PSN);
    detectAndDispatch(PSN, frame({ error_status: '113' }));
    expect(events('dock_failed')).toEqual([]);
    detectAndDispatch(PSN, frame({ error_status: '113', msg: FAILED }));
    expect(events('dock_failed').map(e => e.message)).toEqual([PATROL_SENTENCE]);
    expect(dockFailedAt()).not.toBeNull();
  });

  it('an error 113 that clears again leaves the go home watched: a later Recharge: FAILED still raises once', () => {
    markPatrolDocking(PSN);
    detectAndDispatch(PSN, frame({ error_status: '113' }));
    detectAndDispatch(PSN, frame());                        // the retry found the marker
    expect(events('dock_failed')).toEqual([]);
    detectAndDispatch(PSN, frame({ msg: FAILED }));
    expect(events('dock_failed').map(e => e.message)).toEqual([PATROL_SENTENCE]);
  });

  it('error 126 still raises the generic stuck event next to it', () => {
    markPatrolDocking(PSN);
    detectAndDispatch(PSN, frame({ error_status: '126', error_msg: 'recharge fail' }));
    expect(events('stuck')).toHaveLength(1);
  });

  const oneEach: Array<[string, Array<Record<string, string>>]> = [
    ['Recharge: FAILED, then error 126', [{ msg: FAILED }, { msg: FAILED, error_status: '126' }]],
    ['error 126, then Recharge: FAILED', [{ error_status: '126' }, { error_status: '126', msg: FAILED }]],
    ['Recharge: FAILED twice', [{ msg: FAILED }, { msg: GOING }, { msg: FAILED }]],
    ['error 113, then error 126', [{ error_status: '113' }, { error_status: '126' }]],
  ];
  it.each(oneEach)('%s is one dock_failed per go home', (_name, frames) => {
    markPatrolDocking(PSN);
    for (const f of frames) detectAndDispatch(PSN, frame(f));
    expect(events('dock_failed')).toHaveLength(1);
    expect(events('dock_failed')[0].message).toBe(PATROL_SENTENCE);
  });

  it('a mower that charges within the 15 minutes gets none', () => {
    markPatrolDocking(PSN);
    detectAndDispatch(PSN, frame({ msg: 'Mode:COVERAGE Work:MOVING Prev work:FINISHED Recharge: RUNNING' }));   // on its way
    detectAndDispatch(PSN, charging());                                                                         // on the dock
    expect(events('dock_failed')).toEqual([]);
    expect(dockFailedAt()).toBeNull();
  });

  it('an error 126 while the mower is already charging is no failed docking', () => {
    markPatrolDocking(PSN);
    detectAndDispatch(PSN, charging({ error_status: '126' }));
    expect(events('dock_failed')).toEqual([]);
    expect(dockFailedAt()).toBeNull();
  });

  it('after the 15 minutes the generic dock_failed reports it, unchanged', () => {
    markPatrolDocking(PSN, Date.now() - PATROL_DOCKING_MAX_MS - 1);
    detectAndDispatch(PSN, frame({ msg: FAILED }));
    const [ev, ...rest] = events('dock_failed');
    expect(rest).toEqual([]);
    expect(ev.message).toContain(GENERIC_SENTENCE);
    expect(ev.data).not.toHaveProperty('patrol');
    expect(dockFailedAt()).toBeNull();
  });

  it('a failed recharge with no patrol go home is the generic dock_failed, unchanged', () => {
    detectAndDispatch(PSN, frame({ msg: FAILED }));
    const [ev, ...rest] = events('dock_failed');
    expect(rest).toEqual([]);
    expect(ev.title).toBe('Mower could not dock');
    expect(ev.message.startsWith(GENERIC_SENTENCE)).toBe(true);
    expect(ev.message.endsWith('Manually move the mower onto the dock or retry.')).toBe(true);
    expect(ev.data).toEqual({ msg: FAILED, battery_power: 90 });
    expect(dockFailedAt()).toBeNull();
  });

  it('a failed recharge with the mower already charging stays the generic dock_failed', () => {
    markPatrolDocking(PSN);
    detectAndDispatch(PSN, charging({ msg: FAILED }));
    expect(events('dock_failed').map(e => e.message.startsWith(GENERIC_SENTENCE))).toEqual([true]);
    expect(dockFailedAt()).toBeNull();
  });

  it('error 126 with no patrol go home raises no dock_failed, as before', () => {
    detectAndDispatch(PSN, frame({ error_status: '126', error_msg: 'recharge fail' }));
    expect(events('dock_failed')).toEqual([]);
    expect(events('stuck')).toHaveLength(1);
  });

  it('a patrol that started since the go home owns the mower: the old go home claims no failure', () => {
    markPatrolDocking(PSN);
    patrolRunsRepo.start({ mower_sn: PSN, run: String(Number(RUN) + 1), token: '1'.repeat(32), started_at: Date.now(), schedule_id: null });
    detectAndDispatch(PSN, frame({ msg: FAILED }));
    expect(events('dock_failed').map(e => e.message.startsWith(GENERIC_SENTENCE))).toEqual([true]);
    expect(dockFailedAt()).toBeNull();
  });

  it('the next patrol is watched anew', () => {
    markPatrolDocking(PSN);
    detectAndDispatch(PSN, frame({ msg: FAILED }));
    detectAndDispatch(PSN, charging());          // it docked in the end
    detectAndDispatch(PSN, frame());             // and left for the next patrol
    patrolRunsRepo.start({ mower_sn: PSN, run: String(Number(RUN) + 1), token: '1'.repeat(32), started_at: Date.now(), schedule_id: null });
    expect(dockFailedAt()).toBeNull();           // a new run starts without a failure
    markPatrolDocking(PSN);
    detectAndDispatch(PSN, frame({ msg: FAILED }));
    expect(events('dock_failed')).toHaveLength(2);
    expect(events('dock_failed')[0].data).toMatchObject({ run: String(Number(RUN) + 1) });
    expect(dockFailedAt()).not.toBeNull();
  });
});

describe('dispatcher', () => {
  it('publishes to the local MQTT events topic prefix', () => {
    dispatchEvent({
      sn: SN, type: 'docked', ts: 1, title: 't', message: 'm', data: {},
    });
    const calls = vi.mocked(publishToTopic).mock.calls;
    expect(calls[0][0]).toBe(`novabot/events/${SN}`);
    expect(calls[1][0]).toBe(`novabot/events/${SN}/docked`);
  });
});

describe('dashboard fan-out', () => {
  // The detector and the dispatcher have always produced these events, but the
  // only real-time delivery was an Expo push to the mobile app. A dashboard
  // user never saw "docked" or "mowing finished"; its Settings panel said
  // "coming soon" while the events flowed past it.
  it('hands every dispatched event to the dashboard emitter', () => {
    const seen: Array<{ type: string; sn: string }> = [];
    setDashboardEventEmitter(ev => seen.push({ type: ev.type, sn: ev.sn }));
    try {
      dispatchEvent({
        sn: SN, type: 'docked', ts: Date.now(),
        title: 'Mower docked', message: 'on the dock', data: {},
      });
      expect(seen).toEqual([{ type: 'docked', sn: SN }]);
    } finally {
      setDashboardEventEmitter(null);
    }
  });

  it('a throwing dashboard emitter does not break the other channels', () => {
    setDashboardEventEmitter(() => { throw new Error('socket gone'); });
    try {
      expect(() => dispatchEvent({
        sn: SN, type: 'mowing_finished', ts: Date.now(),
        title: 'Mowing finished', message: 'done', data: {},
      })).not.toThrow();
      // MQTT still got it: one publish for the SN topic, one for the typed topic.
      expect(vi.mocked(publishToTopic).mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(getRecentEvents(SN, 1)[0].type).toBe('mowing_finished');
    } finally {
      setDashboardEventEmitter(null);
    }
  });

  it('no emitter registered is not an error', () => {
    setDashboardEventEmitter(null);
    expect(() => dispatchEvent({
      sn: SN, type: 'low_battery', ts: Date.now(),
      title: 'Low battery', message: '15%', data: {},
    })).not.toThrow();
  });
});
