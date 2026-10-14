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
