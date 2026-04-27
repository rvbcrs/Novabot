import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub publishToTopic before importing the dispatcher so the module sees
// the mock from first load. mapSync.ts pulls in MQTT bindings that
// require a live broker context — we don't want that during unit tests.
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToTopic: vi.fn(),
}));

import { detectAndDispatch, resetEventState } from '../../notifications/eventDetector.js';
import { dispatchEvent, getRecentEvents } from '../../notifications/dispatcher.js';
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

  it('emits "error" when error_status goes 0 → non-stuck code', () => {
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '0' }));
    detectAndDispatch(SN, snap({ error_status: '8', msg: '', battery_power: '90', recharge_status: '0', error_msg: 'LoRa lost' }));
    const ev = getRecentEvents(SN, 1)[0];
    expect(ev.type).toBe('error');
    expect(ev.data.error_status).toBe('8');
  });

  it('emits "stuck" for known stuck error codes', () => {
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '0' }));
    detectAndDispatch(SN, snap({ error_status: '124', msg: '', battery_power: '90', recharge_status: '0', error_msg: 'recharge fail' }));
    const ev = getRecentEvents(SN, 1)[0];
    expect(ev.type).toBe('stuck');
  });

  it('emits "error_cleared" on non-zero → 0 transition', () => {
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '0' }));
    detectAndDispatch(SN, snap({ error_status: '8', msg: '', battery_power: '90', recharge_status: '0' }));
    detectAndDispatch(SN, snap({ error_status: '0', msg: '', battery_power: '90', recharge_status: '0' }));
    const ev = getRecentEvents(SN, 1)[0];
    expect(ev.type).toBe('error_cleared');
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
