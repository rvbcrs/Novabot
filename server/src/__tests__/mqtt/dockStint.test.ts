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

import { updateDeviceData } from '../../mqtt/sensorData.js';
import { dockSamplesRepo } from '../../db/repositories/index.js';

const SN = 'LFIN_DOCK_STINT';
const report = (fields: Record<string, unknown>) =>
  updateDeviceData(SN, Buffer.from(JSON.stringify({ report_state_robot: fields })));

describe('dock samples', () => {
  it('stores the median of a docked RTK-Fixed stint when the mower leaves', () => {
    // parked, fixed, eight reports with one outlier
    const xs = [0.51, 0.52, 0.50, 0.53, 0.90, 0.51, 0.52, 0.50];
    for (const x of xs) report({ recharge_status: 9, rtk_fix_quality: 4, map_position_x: x, map_position_y: -0.20, latitude: 52.1, longitude: 5.1 });
    expect(dockSamplesRepo.listSince(SN, 1).length).toBe(0);
    report({ recharge_status: 0, rtk_fix_quality: 4, map_position_x: 1.0, map_position_y: 0 });
    const rows = dockSamplesRepo.listSince(SN, 1);
    expect(rows.length).toBe(1);
    expect(rows[0].map_x).toBeCloseTo(0.515, 3);
    expect(rows[0].map_y).toBeCloseTo(-0.20, 3);
    expect(rows[0].n).toBe(8);
    expect(rows[0].lat).toBeCloseTo(52.1, 6);
  });

  it('ignores a stint without RTK Fixed or with too few reports', () => {
    for (let i = 0; i < 8; i++) report({ recharge_status: 9, rtk_fix_quality: 5, map_position_x: 0.5, map_position_y: 0 });
    report({ recharge_status: 0 });
    for (let i = 0; i < 2; i++) report({ recharge_status: 9, rtk_fix_quality: 4, map_position_x: 0.5, map_position_y: 0 });
    report({ recharge_status: 0 });
    expect(dockSamplesRepo.listSince(SN, 1).length).toBe(0);
    // and a proper one right after is stored
    for (let i = 0; i < 6; i++) report({ recharge_status: 9, rtk_fix_quality: 4, map_position_x: 0.5, map_position_y: 0 });
    report({ recharge_status: 0 });
    expect(dockSamplesRepo.listSince(SN, 1).length).toBe(1);
  });
});

describe('live dock pose', () => {
  it('is only taken while RTK Fixed, and a Float report never replaces it', async () => {
    const { getDockPose } = await import('../../mqtt/sensorData.js');
    const sn = 'LFIN_DOCK_POSE_RTK';
    const rep = (fields: Record<string, unknown>) =>
      updateDeviceData(sn, Buffer.from(JSON.stringify({ report_state_robot: fields })));
    rep({ recharge_status: 9, rtk_fix_quality: 5, map_position_x: -1.70, map_position_y: 1.19 });
    expect(getDockPose(sn)).toBeNull();
    rep({ recharge_status: 9, rtk_fix_quality: 4, map_position_x: 0.03, map_position_y: 0.73 });
    expect(getDockPose(sn)).toMatchObject({ x: 0.03, y: 0.73 });
    rep({ recharge_status: 9, rtk_fix_quality: 5, map_position_x: -1.70, map_position_y: 1.19 });
    expect(getDockPose(sn)).toMatchObject({ x: 0.03, y: 0.73 });
  });
});
