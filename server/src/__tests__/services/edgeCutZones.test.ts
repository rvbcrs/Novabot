/**
 * #148: an edge cut of chosen zones, one after another. The dock's zone starts
 * directly from the dock as before; any other zone goes through mow_zone with
 * edge:true, which drives the recorded channel first (custom-47 and up). An
 * older build would ignore edge:true and MOW the zone, so it is refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: vi.fn(() => true) }));
vi.mock('../../services/mowerFileCapability.js', () => ({ isOpenNovaMower: () => true }));
vi.mock('../../mqtt/extendedCommands.js', () => ({ publishExtendedCommand: vi.fn() }));
vi.mock('../../mqtt/mapSync.js', () => ({ publishToDevice: vi.fn() }));
vi.mock('../../services/positionTelemetry.js', async original => ({
  ...await original<object>(), freshPositionState: vi.fn(() => ({ docked: true })),
}));

import { publishExtendedCommand } from '../../mqtt/extendedCommands.js';
import { freshPositionState } from '../../services/positionTelemetry.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { mapRepo } from '../../db/repositories/index.js';
import { startEdgeCuts, continueEdgeCuts, cancelEdgeCuts } from '../../services/mowingService.js';

const SN = 'LFIN_EDGE_ZONES';
const square = (x0: number) => JSON.stringify([{ x: x0, y: 0 }, { x: x0 + 10, y: 0 }, { x: x0 + 10, y: 10 }, { x: x0, y: 10 }]);
const sent = () => vi.mocked(publishExtendedCommand).mock.calls.map(c => c[1]);

beforeEach(() => {
  vi.clearAllMocks();
  cancelEdgeCuts(SN);
  for (const m of mapRepo.findByMowerSn(SN)) mapRepo.deleteById(m.map_id);
  mapRepo.create({ map_id: `${SN}-0`, mower_sn: SN, map_type: 'work', canonical_name: 'map0', map_area: square(0) });
  mapRepo.create({ map_id: `${SN}-1`, mower_sn: SN, map_type: 'work', canonical_name: 'map1', map_area: square(30) });
  mapRepo.create({ map_id: `${SN}-d`, mower_sn: SN, map_type: 'unicom', canonical_name: 'map0tocharge_unicom',
    map_area: JSON.stringify([{ x: 0.5, y: 0.7 }, { x: 2, y: 3 }]) });
  deviceCache.set(SN, new Map([['sw_version', 'v6.0.2-custom-47']]));
  vi.mocked(freshPositionState).mockReturnValue({ docked: true } as never);
});

describe('startEdgeCuts', () => {
  it('starts the dock zone directly from the dock, as before', () => {
    expect(startEdgeCuts(SN, ['map0'], 40).ok).toBe(true);
    expect(sent()).toEqual([{ start_edge_cut: { mapName: 'map0', bladeHeight: 40, departFromDock: true } }]);
  });

  it('drives the channel first for another zone', () => {
    expect(startEdgeCuts(SN, ['map1'], 50).ok).toBe(true);
    expect(sent()).toEqual([{ mow_zone: { map: 'map1', edge: true, bladeHeight: 50, cutterhigh: 3 } }]);
  });

  it('refuses another zone on a build that would mow it instead', () => {
    deviceCache.set(SN, new Map([['sw_version', 'v6.0.2-custom-46']]));
    expect(startEdgeCuts(SN, ['map1'], 40).ok).toBe(false);
    expect(sent()).toEqual([]);
  });

  it('refuses names that are not zones', () => {
    expect(startEdgeCuts(SN, ['../x'], 40).ok).toBe(false);
    expect(startEdgeCuts(SN, [], 40).ok).toBe(false);
  });

  it('runs the zones one after another and stops queuing when told to', () => {
    startEdgeCuts(SN, ['map0', 'map1'], 40);
    vi.mocked(freshPositionState).mockReturnValue({ docked: false } as never);
    expect(continueEdgeCuts(SN)).toBe(true);
    expect(sent()[1]).toEqual({ mow_zone: { map: 'map1', edge: true, bladeHeight: 40, cutterhigh: 2 } });
    expect(continueEdgeCuts(SN)).toBe(false);   // nothing left: the caller sends it home

    startEdgeCuts(SN, ['map0', 'map1'], 40);
    cancelEdgeCuts(SN);
    expect(continueEdgeCuts(SN)).toBe(false);
  });
});
