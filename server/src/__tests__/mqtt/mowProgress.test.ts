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

import { updateDeviceData, sweepCoordinate } from '../../mqtt/sensorData.js';
import { mapRepo, mowProgressRepo } from '../../db/repositories/index.js';

// #86: while a coverage task runs the server remembers where the mower is,
// in which work map, the lane direction and which side is mowed.
const SN = 'LFIN_PROGRESS_86';
const report = (fields: Record<string, unknown>) =>
  updateDeviceData(SN, Buffer.from(JSON.stringify({ report_state_robot: fields })));

describe('mow progress on disk', () => {
  it('writes the row from the sensor stream and drops it on cancel', () => {
    mapRepo.upsert({
      map_id: 'm86', mower_sn: SN, map_name: 'Front', map_type: 'work', canonical_name: 'map0',
      map_area: JSON.stringify([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }]),
      map_max_min: null, file_name: null,
    } as never);

    // lanes north-south (0°), mowing from west to east: trail at x = 2..5, now at x = 6
    const msg = 'Mode:COVERAGE Work:COVERING Prev work:RUNNING Recharge: FINISHED';
    for (let x = 2; x <= 5; x++) report({ msg, task_mode: 1, work_status: 1, cov_direction: 0, mowing_progress: x * 5, map_position_x: x, map_position_y: 3 });
    // ten seconds later the next write is due
    vi.useFakeTimers({ now: Date.now() + 11_000 });
    report({ msg, task_mode: 1, work_status: 1, cov_direction: 0, mowing_progress: 30, map_position_x: 6, map_position_y: 3 });
    vi.useRealTimers();

    const row = mowProgressRepo.get(SN)!;
    expect(row).toBeTruthy();
    expect(row.map_id).toBe('m86');
    expect(row.canonical_name).toBe('map0');
    expect(row.direction_deg).toBe(0);
    expect(row.last_x).toBe(6);
    expect(row.percent).toBe(30);
    // the trail lies at smaller x; sweep coordinate for 0° is x → mowed side is -1
    expect(Math.sign(sweepCoordinate(2, 3, 0) - sweepCoordinate(6, 3, 0))).toBe(-1);
    expect(row.mowed_sign).toBe(-1);

    report({ msg: 'Mode:COVERAGE Work:CANCELLED Prev work:COVERING Recharge: FINISHED', task_mode: 1, work_status: 0 });
    expect(mowProgressRepo.get(SN)).toBeUndefined();
  });

  it('ignores mapping and edge cut', () => {
    report({ msg: 'Mode:MAPPING Work:USER_MAP_RECORDING', task_mode: 3, map_position_x: 1, map_position_y: 1, cov_direction: 0 });
    expect(mowProgressRepo.get(SN)).toBeUndefined();
  });
});
