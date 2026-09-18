import { describe, it, expect, vi } from 'vitest';

// Break the broker chain that fires when sensorData.ts is imported.
vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(false),
  writeRawPublish: vi.fn(),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
  banishSn: vi.fn(),
  forceDisconnectDevice: vi.fn(),
  lookupMac: vi.fn(),
}));
import { updateDeviceData, getLocalTrail, getGpsTrail } from '../../mqtt/sensorData.js';

// #111: the trail is one mowing session, cleared only when a NEW task starts.
const SN = 'LFIN_TRAIL_111';
let n = 0;
const report = (fields: Record<string, unknown>) =>
  updateDeviceData(SN, Buffer.from(JSON.stringify({ report_state_robot: fields })));
const move = (msg: string, extra: Record<string, unknown> = {}) =>
  report({ msg, task_mode: 1, map_position_x: ++n, map_position_y: 0, latitude: 52 + n / 1000, longitude: 5, ...extra });

describe('trail session lifecycle', () => {
  it('keeps the trail through pause, recharge stop and resume, clears on the next task', () => {
    move('Mode:COVERAGE Work:RUNNING Prev work:FINISHED Recharge: FINISHED');
    move('Mode:COVERAGE Work:COVERING Prev work:RUNNING Recharge: FINISHED');
    expect(getLocalTrail(SN).length).toBe(2);
    expect(getGpsTrail(SN).length).toBe(2);

    // user pause, then resume: same session
    report({ msg: 'Mode:COVERAGE Work:PAUSED Prev work:COVERING Recharge: FINISHED', task_mode: 1 });
    move('Mode:COVERAGE Work:COVERING Prev work:PAUSED Recharge: FINISHED');
    expect(getLocalTrail(SN).length).toBe(3);

    // low battery: back to the dock (stock 5.7.1 work_status 12), charged, resumed
    report({ msg: 'Mode:COVERAGE Work:BATTERY_LOW_RECHARGE Prev work:COVERING Recharge: RUNNING', task_mode: 1, work_status: 12, battery_state: 'CHARGING' });
    report({ msg: 'Mode:COVERAGE Work:BATTERY_LOW_RECHARGE Prev work:COVERING Recharge: FINISHED', task_mode: 1, work_status: 12, battery_state: 'CHARGING' });
    move('Mode:COVERAGE Work:COVERING Prev work:BATTERY_LOW_RECHARGE Recharge: FINISHED', { work_status: 1, battery_state: 'DISCHARGING' });
    expect(getLocalTrail(SN).length).toBe(4);

    // task done, parked: trail stays visible
    report({ msg: 'Mode:COVERAGE Work:FINISHED Prev work:COVERING Recharge: FINISHED', task_mode: 0, work_status: 0 });
    expect(getLocalTrail(SN).length).toBe(4);
    expect(getGpsTrail(SN).length).toBe(4);

    // a new task: fresh trail from its first sample
    move('Mode:COVERAGE Work:RUNNING Prev work:FINISHED Recharge: FINISHED', { work_status: 1 });
    expect(getLocalTrail(SN).length).toBe(1);
    expect(getGpsTrail(SN).length).toBe(1);
  });

  it('a cancelled task also ends the session', () => {
    move('Mode:COVERAGE Work:COVERING Prev work:RUNNING Recharge: FINISHED', { work_status: 1 });
    const before = getLocalTrail(SN).length;
    report({ msg: 'Mode:COVERAGE Work:CANCELLED Prev work:COVERING Recharge: FINISHED', task_mode: 1, work_status: 0 });
    expect(getLocalTrail(SN).length).toBe(before);
    move('Mode:COVERAGE Work:RUNNING Prev work:CANCELLED Recharge: FINISHED', { work_status: 1 });
    expect(getLocalTrail(SN).length).toBe(1);
  });
});
