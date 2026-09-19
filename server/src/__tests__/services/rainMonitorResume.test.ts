import { describe, it, expect, beforeEach, vi } from 'vitest';

// Keep the broker → demoSimulator → socketHandler init chain out of the test;
// resumeSession only needs the sensor cache, publishToDevice and the repo.
const mocks = vi.hoisted(() => ({
  publishToDevice: vi.fn(),
  resumeRainSession: vi.fn(),
  cancelRainSession: vi.fn(),
  emitScheduleEvent: vi.fn(),
}));
vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(true),
  writeRawPublish: vi.fn(), getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(), banishSn: vi.fn(), forceDisconnectDevice: vi.fn(), lookupMac: vi.fn(),
}));
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToDevice: mocks.publishToDevice,
  goToChargePayload: vi.fn(),
  getNextCmdNum: vi.fn().mockReturnValue(4242),
}));
vi.mock('../../dashboard/socketHandler.js', () => ({ emitScheduleEvent: mocks.emitScheduleEvent }));
vi.mock('../../services/weatherService.js', () => ({ getWeatherForecast: vi.fn(), shouldPauseForRain: vi.fn() }));
vi.mock('../../db/repositories/index.js', () => ({
  scheduleRepo: { resumeRainSession: mocks.resumeRainSession, cancelRainSession: mocks.cancelRainSession },
  mapRepo: {}, rainSettingsRepo: {},
}));

import { deviceCache } from '../../mqtt/sensorData.js';
import { _resumeSession } from '../../services/rainMonitor.js';
import type { RainSessionRow } from '../../db/repositories/schedules.js';

const SN = 'LFIN1231000211';
const session = { session_id: 's1', schedule_id: 'sch1', mower_sn: SN, cutting_height: 3, path_direction: 120 } as RainSessionRow;

beforeEach(() => {
  vi.clearAllMocks();
  deviceCache.clear();
});

describe('rain resume (#112)', () => {
  it('continues the parked task with resume_navigation, exactly like the app Continue button', () => {
    deviceCache.set(SN, new Map([['work_status', '10'], ['msg', 'Mode:COVERAGE Work:USER_STOP Prev work:COVERING Recharge: FINISHED']]));
    _resumeSession(session);
    expect(mocks.publishToDevice.mock.calls).toEqual([[SN, { resume_navigation: { cmd_num: 4242 } }]]);
    expect(mocks.resumeRainSession).toHaveBeenCalledWith('s1');
    expect(mocks.cancelRainSession).not.toHaveBeenCalled();
  });

  it('sends no set_para_info and no start command: the task keeps its own cutterhigh', () => {
    deviceCache.set(SN, new Map([['work_status', '10']]));
    _resumeSession(session);
    const keys = mocks.publishToDevice.mock.calls.map(c => Object.keys(c[1] as object)[0]);
    expect(keys).toEqual(['resume_navigation']);
  });

  it('cancels the session when there is no parked task any more (mower rebooted during the pause)', () => {
    deviceCache.set(SN, new Map([['work_status', '0'], ['msg', 'Mode:COVERAGE Work:WAIT Prev work:WAIT Recharge: FINISHED']]));
    _resumeSession(session);
    expect(mocks.publishToDevice).not.toHaveBeenCalled();
    expect(mocks.cancelRainSession).toHaveBeenCalledWith('s1');
    expect(mocks.emitScheduleEvent).toHaveBeenCalledWith('rain:cancelled', expect.objectContaining({ reason: 'no_parked_task' }));
  });
});
