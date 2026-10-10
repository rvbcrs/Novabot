/**
 * #155: a change that arrived inside HA_THROTTLE_MS was dropped, and since
 * updateDeviceData reports a change only once, HA kept the old value for good
 * ("Driving" while the mower stood docked on "User recharge").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../mqtt/mapSync.js', () => ({ publishToDevice: vi.fn() }));
vi.mock('../../dashboard/socketHandler.js', () => ({ emitDebugPosJson: vi.fn() }));
vi.mock('../../services/scheduleRunner.js', () => ({ computeScheduleArea: vi.fn(() => 1) }));
vi.mock('../../services/mowingService.js', () => ({ startMowing: vi.fn(), goHome: vi.fn() }));

import { forwardToHomeAssistant, _useHaClientForTest } from '../../mqtt/homeassistant.js';

const SN = 'LFIN_HA_THROTTLE';
let published: Array<[string, string]> = [];
const stateOf = (field: string) => published.filter(([t]) => t === `novabot/${SN}/${field}`).map(([, v]) => v);
const report = (fields: Record<string, string>) =>
  forwardToHomeAssistant(`Dart/Receive_mqtt/${SN}`, Buffer.from('{}'), SN, new Map(Object.entries(fields)));

beforeEach(() => {
  vi.useFakeTimers();
  published = [];
  _useHaClientForTest({ publish: (topic: string, value: string) => { published.push([topic, String(value)]); } });
});
afterEach(() => { vi.useRealTimers(); _useHaClientForTest(null); });

describe('HA throttle keeps changes instead of dropping them', () => {
  it('sends a change that came inside the throttle window when the window ends', () => {
    report({ work_status: 'Driving' });
    vi.advanceTimersByTime(500);
    report({ work_status: 'User recharge' });
    expect(stateOf('work_status')).toEqual(['Driving']);

    vi.advanceTimersByTime(2_000);
    expect(stateOf('work_status')).toEqual(['Driving', 'User recharge']);
  });

  it('sends only the latest value of a field that changed several times in one window', () => {
    report({ battery_power: '80' });
    report({ battery_power: '79' });
    report({ battery_power: '78' });
    vi.advanceTimersByTime(2_000);
    expect(stateOf('battery_power')).toEqual(['80', '78']);
  });
});
