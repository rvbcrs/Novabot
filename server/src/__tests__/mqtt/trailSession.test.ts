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
import { updateDeviceData, getLocalTrail, getGpsTrail, clearGpsTrail, deviceCache, _forgetTrailsForTest } from '../../mqtt/sensorData.js';
import fs from 'node:fs';
import path from 'node:path';

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

  // #140 (stock 5.7.1, waltervl): after FINISHED the return to the dock is
  // reported as Work:MOVING with recharge_status 50/53 (#31), which counted as
  // the first sample of a new task and wiped the trail of the session just
  // mowed. The return trip belongs to the session; only a new mow clears.
  it('the return to the dock after finishing keeps the trail (stock 5.7.1)', () => {
    move('Mode:COVERAGE Work:COVERING Prev work:RUNNING Recharge: WAIT', { work_status: 90 });
    move('Mode:COVERAGE Work:COVERING Prev work:RUNNING Recharge: WAIT', { work_status: 90 });
    report({ msg: 'Mode:COVERAGE Work:FINISHED Prev work:FINISHED_ONCE Recharge: WAIT', task_mode: 1, work_status: 9 });
    const mowed = getLocalTrail(SN).length;
    move('Mode:COVERAGE Work:MOVING Prev work:FINISHED Recharge: WAIT', { work_status: 92, recharge_status: 50 });
    move('Mode:COVERAGE Work:MOVING Prev work:FINISHED Recharge: WAIT', { work_status: 92, recharge_status: 53 });
    expect(getLocalTrail(SN).length).toBe(mowed + 2);
    report({ msg: 'Mode:COVERAGE Work:FINISHED Prev work:MOVING Recharge: FINISHED', task_mode: 0, work_status: 0, recharge_status: 9, battery_state: 'CHARGING' });
    expect(getLocalTrail(SN).length).toBe(mowed + 2);
    move('Mode:COVERAGE Work:RUNNING Prev work:FINISHED Recharge: FINISHED', { work_status: 50, recharge_status: 0 });
    expect(getLocalTrail(SN).length).toBe(1);
  });

  // #140 (waltervl, 5 Oct): the trail was still gone some time after the mow.
  // work_status 1 is "Failed" in the firmware (WorkStatusString), not mowing,
  // and a failed start or dock attempt after the mow opened a new session.
  it('a Failed report after the mow keeps the trail', () => {
    move('Mode:COVERAGE Work:COVERING Prev work:RUNNING Recharge: WAIT', { work_status: 90 });
    report({ msg: 'Mode:COVERAGE Work:FINISHED Prev work:COVERING Recharge: FINISHED', task_mode: 0, work_status: 9 });
    const mowed = getLocalTrail(SN).length;
    move('Mode:COVERAGE Work:FAILED Prev work:FINISHED Recharge: FINISHED', { work_status: 1 });
    expect(getLocalTrail(SN).length).toBe(mowed);
  });

  // The edge cut now follows the mow directly; it finishes that session.
  it('an edge cut after the mow adds to its trail instead of starting a new one', () => {
    move('Mode:COVERAGE Work:COVERING Prev work:RUNNING Recharge: WAIT', { work_status: 90 });
    report({ msg: 'Mode:COVERAGE Work:FINISHED Prev work:COVERING Recharge: WAIT', task_mode: 0, work_status: 9 });
    const mowed = getLocalTrail(SN).length;
    deviceCache.get(SN)!.set('edge_active', '1');
    move('Mode:COVERAGE Work:WAIT Prev work:FINISHED Recharge: WAIT', { work_status: 0 });
    deviceCache.get(SN)!.set('edge_active', '0');
    expect(getLocalTrail(SN).length).toBe(mowed + 1);
  });

  // "Store and show GPS trail until the next mowing session": a server restart
  // emptied the in-memory trail, in the dashboard and the HA render alike.
  it('the trail of a finished session survives a server restart', () => {
    move('Mode:COVERAGE Work:RUNNING Prev work:FINISHED Recharge: FINISHED', { work_status: 50 });
    move('Mode:COVERAGE Work:COVERING Prev work:RUNNING Recharge: WAIT', { work_status: 90 });
    report({ msg: 'Mode:COVERAGE Work:FINISHED Prev work:COVERING Recharge: FINISHED', task_mode: 0, work_status: 9 });
    const local = getLocalTrail(SN).length, gps = getGpsTrail(SN).length;
    _forgetTrailsForTest(SN);
    expect(getLocalTrail(SN).length).toBe(local);
    expect(getGpsTrail(SN).length).toBe(gps);
    // A new mow still starts clean, and does not bring the old file back.
    move('Mode:COVERAGE Work:RUNNING Prev work:FINISHED Recharge: FINISHED', { work_status: 50 });
    _forgetTrailsForTest(SN);
    expect(getLocalTrail(SN).length).toBe(0);
  });

  // The SN comes from the /trail/:sn route too: no "../" out of storage/trails.
  it('never touches a file outside storage/trails for a crafted SN', () => {
    const victim = path.resolve(process.env.STORAGE_PATH ?? './storage', 'victim.json');
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, '{}');
    clearGpsTrail('../victim');
    expect(fs.existsSync(victim)).toBe(true);
    fs.rmSync(victim);
  });
});
