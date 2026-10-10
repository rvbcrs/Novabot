/**
 * #147: an edge cut is an NTCP goal that runs outside robot_decision. "Go home"
 * was accepted by robot_decision while the edge goal kept driving: docking
 * errors with the mower far away, still cutting the edge. A command that ends
 * or replaces the current work now stops the edge goal first and reaches the
 * mower only after that stop had time to land.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../mqtt/broker.js', () => ({
  isSnBanned: () => false,
  isDeviceOnline: () => true,
}));

import { initMapSync, publishToDevice } from '../../mqtt/mapSync.js';
import { tryDecrypt } from '../../mqtt/decrypt.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { edgeCutGate, EDGE_STOP_SETTLE_MS, _resetEdgeCutGate } from '../../services/edgeCutGuard.js';

const SN = 'LFIN1231000367';
let sent: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  _resetEdgeCutGate();
  sent = [];
  deviceCache.set(SN, new Map([['edge_active', '1']]));
  initMapSync({
    publish: (p: { topic: string; payload: Buffer }, cb: () => void) => {
      sent.push(`${p.topic} ${tryDecrypt(p.payload, SN) ?? p.payload.toString('utf8')}`);
      cb();
    },
  } as never);
});
afterEach(() => { vi.useRealTimers(); deviceCache.delete(SN); });

describe('edgeCutGate', () => {
  it('lets everything through when no edge cut runs', () => {
    expect(edgeCutGate(SN, { go_to_charge: {} }, false, 0)).toEqual({ stopNow: false, delayMs: 0 });
    // A pause during a normal mow must stay a pause, not become a cancel.
    expect(edgeCutGate(SN, { pause_run: {} }, false, 0)).toEqual({ stopNow: false, delayMs: 0 });
  });

  it('ignores commands that do not end the work', () => {
    expect(edgeCutGate(SN, { get_para_info: {} }, true, 0)).toEqual({ stopNow: false, delayMs: 0 });
  });

  it('stops the edge goal once and holds every ending command until the same moment', () => {
    expect(edgeCutGate(SN, { stop_navigation: {} }, true, 1_000)).toEqual({ stopNow: true, delayMs: EDGE_STOP_SETTLE_MS });
    // The app sends go_to_charge 500 ms after stop_navigation; it must not overtake.
    expect(edgeCutGate(SN, { go_to_charge: {} }, true, 1_500)).toEqual({ stopNow: false, delayMs: EDGE_STOP_SETTLE_MS - 500 });
    // When the held commands are re-sent the mower may still report the edge
    // cut active; they go through instead of starting another round.
    expect(edgeCutGate(SN, { go_to_charge: {} }, true, 1_000 + EDGE_STOP_SETTLE_MS)).toEqual({ stopNow: false, delayMs: 0 });
  });
});

describe('publishToDevice during an edge cut', () => {
  it('sends stop_boundary_follow first and "go home" after it had time to land, in order', () => {
    publishToDevice(SN, { stop_navigation: { cmd_num: 1 } });
    vi.advanceTimersByTime(500);
    publishToDevice(SN, { go_to_charge: { cmd_num: 2 } });
    expect(sent).toEqual([`novabot/extended/${SN} {"stop_boundary_follow":{}}`]);

    vi.advanceTimersByTime(EDGE_STOP_SETTLE_MS);
    expect(sent).toEqual([
      `novabot/extended/${SN} {"stop_boundary_follow":{}}`,
      `Dart/Send_mqtt/${SN} {"stop_navigation":{"cmd_num":1}}`,
      `Dart/Send_mqtt/${SN} {"go_to_charge":{"cmd_num":2}}`,
    ]);
  });

  it('changes nothing when the mower is not cutting the edge', () => {
    deviceCache.set(SN, new Map([['edge_active', '0']]));
    publishToDevice(SN, { go_to_charge: { cmd_num: 3 } });
    expect(sent).toEqual([`Dart/Send_mqtt/${SN} {"go_to_charge":{"cmd_num":3}}`]);
  });
});
