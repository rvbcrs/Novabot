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
