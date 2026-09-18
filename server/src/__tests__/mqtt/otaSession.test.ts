import { describe, it, expect, beforeEach, vi } from 'vitest';

const { emitOtaEvent } = vi.hoisted(() => ({ emitOtaEvent: vi.fn() }));
vi.mock('../../dashboard/socketHandler.js', () => ({ emitOtaEvent }));

import {
  otaSessionStarted, otaSessionState, otaSessionDisconnect, otaSessionConnect,
  otaSessionVersion, getOtaSession, _resetOtaSessions,
} from '../../mqtt/otaSession.js';

const SN = 'LFIN1231000211';
const phases = () => emitOtaEvent.mock.calls.map(c => (c[2] as { phase: string }).phase);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  _resetOtaSessions();
  emitOtaEvent.mockClear();
});

describe('OTA session phases (issue #130)', () => {
  it('walks download → unpack → install → awaiting-reboot → rebooting → back → done', () => {
    otaSessionStarted(SN, 'v6.0.2-custom-50', 'v6.0.2-custom-49');
    otaSessionState(SN, { status: 'upgrade', percentage: 10 });
    otaSessionState(SN, { status: 'upgrade', percentage: 65 });
    otaSessionState(SN, { status: 'upgrade', percentage: 90 });
    otaSessionState(SN, { status: 'success', percentage: 100 });
    otaSessionDisconnect(SN);
    otaSessionConnect(SN);
    otaSessionVersion(SN, 'v6.0.2-custom-50');
    expect(phases()).toEqual(['downloading', 'unpacking', 'installing', 'awaiting-reboot', 'rebooting', 'back', 'done']);
    expect(getOtaSession(SN)?.phase).toBe('done');
  });

  it('reports rolled-back when the old version comes back', () => {
    otaSessionStarted(SN, 'v6.0.2-custom-50', 'v6.0.2-custom-49');
    otaSessionState(SN, { status: 'success', percentage: 100 });
    otaSessionDisconnect(SN);
    otaSessionConnect(SN);
    otaSessionVersion(SN, '6.0.2-custom-49'); // sensors omit the v prefix
    expect(getOtaSession(SN)?.phase).toBe('rolled-back');
  });

  it('ignores version reports and disconnects outside a session', () => {
    otaSessionVersion(SN, 'v6.0.2');
    otaSessionDisconnect(SN);
    expect(getOtaSession(SN)).toBeUndefined();
    expect(emitOtaEvent).not.toHaveBeenCalled();
  });

  it('goes to stalled after 5 min awaiting-reboot without a disconnect', () => {
    otaSessionStarted(SN, 'v2', 'v1');
    otaSessionState(SN, { status: 'success', percentage: 100 });
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(getOtaSession(SN)?.phase).toBe('awaiting-reboot');
    vi.advanceTimersByTime(1);
    const s = getOtaSession(SN)!;
    expect(s.phase).toBe('stalled');
    expect(s.lastState).toEqual({ status: 'success', percentage: 100 });
  });

  it('does not stall once the reboot has started, and marks failed on failed', () => {
    otaSessionStarted(SN, 'v2', 'v1');
    otaSessionState(SN, { status: 'success', percentage: 100 });
    otaSessionDisconnect(SN);
    vi.advanceTimersByTime(10 * 60_000);
    expect(getOtaSession(SN)?.phase).toBe('rebooting');

    otaSessionStarted(SN, 'v2', 'v1');
    otaSessionState(SN, { status: 'failed' });
    expect(getOtaSession(SN)?.phase).toBe('failed');
  });

  it('clears a finished session after 10 min and records since per phase', () => {
    otaSessionStarted(SN, 'v2', 'v1');
    vi.advanceTimersByTime(30_000);
    otaSessionState(SN, { status: 'success', percentage: 100 });
    expect(getOtaSession(SN)?.since).toBe(1_030_000);
    otaSessionDisconnect(SN);
    otaSessionConnect(SN);
    otaSessionVersion(SN, 'v2');
    vi.advanceTimersByTime(10 * 60_000);
    expect(getOtaSession(SN)).toBeUndefined();
  });
});
