/**
 * Where a mower's own dock lies in its map frame, for server-made dock
 * channels (zone copy). A live reading taken on RTK Float once put the dock
 * 1.8 m off and the copied zone's dock channel started there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const live = vi.hoisted(() => ({ pose: null as null | { x: number; y: number; orientation: number; capturedAt: number } }));
vi.mock('../../mqtt/sensorData.js', () => ({
  getDockPose: vi.fn(() => live.pose),
}));

import { dockPoint } from '../../services/canonicalNaming.js';
import { mapRepo, dockSamplesRepo } from '../../db/repositories/index.js';

const SN = 'LFIN_DOCK_POINT';

beforeEach(() => {
  live.pose = null;
  for (const m of mapRepo.findByMowerSn(SN)) mapRepo.deleteById(m.map_id);
  dockSamplesRepo.deleteBySn(SN);
});

describe('dockPoint', () => {
  it('takes the first point of the dock channel when there is one', () => {
    mapRepo.create({ map_id: `${SN}-u`, mower_sn: SN, map_name: 'map0tocharge_unicom', map_type: 'unicom',
      map_area: JSON.stringify([{ x: 0.03, y: 0.73 }, { x: 1, y: 1 }]), canonical_name: 'map0tocharge_unicom' });
    dockSamplesRepo.insert(SN, 5, 5, null, null, 10);
    live.pose = { x: 9, y: 9, orientation: 0, capturedAt: 0 };
    expect(dockPoint(SN)).toEqual({ x: 0.03, y: 0.73 });
  });

  it('without a dock channel, prefers the median of RTK-Fixed docking stints over the live pose', () => {
    // three stints on its own dock, one on another mower's dock
    dockSamplesRepo.insert(SN, 0.01, 0.86, null, null, 10);
    dockSamplesRepo.insert(SN, 0.02, 0.84, null, null, 10);
    dockSamplesRepo.insert(SN, 12.67, 18.88, null, null, 10);
    dockSamplesRepo.insert(SN, 0.00, 0.85, null, null, 10);
    live.pose = { x: -1.70, y: 1.19, orientation: 0, capturedAt: 0 };
    const p = dockPoint(SN)!;
    expect(Math.hypot(p.x - 0.01, p.y - 0.85)).toBeLessThan(0.05);
  });

  it('picks the dock where it stood longest, not a midpoint, when stints split between two docks', () => {
    // one overnight stint at home, two short stints on another mower's dock
    dockSamplesRepo.insert(SN, 0.02, 0.85, null, null, 900);
    dockSamplesRepo.insert(SN, 12.66, 18.87, null, null, 40);
    dockSamplesRepo.insert(SN, 12.68, 18.89, null, null, 35);
    const p = dockPoint(SN)!;
    expect(Math.hypot(p.x - 0.02, p.y - 0.85)).toBeLessThan(0.05);
  });

  it('falls back to the live pose only when nothing else is known', () => {
    live.pose = { x: 0.2, y: 0.7, orientation: 0, capturedAt: 0 };
    expect(dockPoint(SN)).toEqual({ x: 0.2, y: 0.7 });
    live.pose = null;
    expect(dockPoint(SN)).toBeNull();
  });
});
