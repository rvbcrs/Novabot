import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: vi.fn(() => true) }));
vi.mock('../../services/mapBackup.js', () => ({ scheduleSnapshot: vi.fn() }));
vi.mock('../../services/mowerMapOperation.js', () => ({
  withMowerMapOperation: vi.fn(async (_sn, run) => run({ id: 'read-only-lease' })),
  readMowerMapSnapshot: vi.fn(),
}));

import { alignDockPhoto, getPhotoDockPose, snapshotDockPose } from '../../services/dockPhotoReference.js';
import { readMowerMapSnapshot } from '../../services/mowerMapOperation.js';
import { isDeviceOnline } from '../../mqtt/broker.js';
import { mapRepo } from '../../db/repositories/index.js';
import { clearFrameUnvalidated, markFrameUnvalidated } from '../../services/frameValidation.js';
import { clearPositionTelemetry, ingestPositionTelemetry } from '../../services/positionTelemetry.js';

const sn = 'PHOTO_DOCK_TEST';
const pose = { x: 0.03, y: 0.73, orientation: -1.518115 };
const snapshot = () => ({ result: 0, snapshot_consistent: true,
  csv_files: { 'map_info.json': JSON.stringify({ charging_pose: pose }), 'map0tocharge_unicom.csv': '-1.10,1.18\n-1.09,0.52\n' },
  charging_station_yaml: `charging_pose: [${pose.x}, ${pose.y}, ${pose.orientation}]`,
  pos_json: '{"unchanged":"origin"}', snapshot_manifest: { 'map0_work.csv': 'hash' },
});
function samples(x = pose.x, quality = 4) {
  for (let i = 0; i < 8; i++) ingestPositionTelemetry(sn, {
    rtk_fix_quality: quality, localization_state: 'RUNNING', recharge_status: 9,
    map_position_x: x, map_position_y: pose.y,
  }, Date.now() - 8000 + i * 1000);
}
beforeEach(() => {
  clearFrameUnvalidated(sn); clearPositionTelemetry(sn);
  vi.mocked(isDeviceOnline).mockReturnValue(true);
  vi.mocked(readMowerMapSnapshot).mockReset().mockResolvedValue(snapshot());
  mapRepo.setCalibration(sn, { charger_lat: 52, charger_lng: 6 });
});

it('pairs the independently stored dock to the photo while preserving polygons and saved heading', async () => {
  mapRepo.create({ map_id: 'photo-work', mower_sn: sn, canonical_name: 'map0', map_area: '[{"x":2,"y":3}]' });
  mapRepo.setPolygonChargingOrientation(sn, pose.orientation);
  const before = mapRepo.findByMowerSn(sn);
  samples();
  const result = await alignDockPhoto(sn, 52.1, 6.2);
  expect(result.chargingPose).toEqual(pose);
  expect(getPhotoDockPose(sn)).toEqual(pose);
  expect(mapRepo.getChargerGps(sn)).toEqual({ lat: 52.1, lng: 6.2 });
  expect(mapRepo.getPolygonChargingOrientation(sn)).toBe(pose.orientation);
  expect(mapRepo.findByMowerSn(sn)).toEqual(before);
  expect(vi.mocked(readMowerMapSnapshot).mock.calls).toEqual([[sn, { id: 'read-only-lease' }]]);
  const backup = JSON.parse(readFileSync(path.join(process.env.STORAGE_PATH!, 'photo-calibration', `${result.backupId}.json`), 'utf8'));
  expect(backup.calibration.charger_lat).toBe(52);
  expect(backup.origin).toBe(snapshot().pos_json);
  markFrameUnvalidated(sn);
  expect(getPhotoDockPose(sn)).toBeNull();
});

it('rejects wrong-frame Fixed poses, missing confirmation and non-matching saved dock files', async () => {
  samples(-1.28);
  await expect(alignDockPhoto(sn, 52.1, 6.2)).rejects.toThrow('niet bevestigd');
  clearPositionTelemetry(sn); samples();
  for (const bad of [null, { ...snapshot(), snapshot_consistent: false },
    { ...snapshot(), charging_station_yaml: 'charging_pose: [0, 0, 1.5]' }]) {
    vi.mocked(readMowerMapSnapshot).mockResolvedValue(bad);
    await expect(alignDockPhoto(sn, 52.1, 6.2)).rejects.toThrow('niet bevestigd');
  }
  expect(mapRepo.getChargerGps(sn)).toEqual({ lat: 52, lng: 6 });
  expect(getPhotoDockPose(sn)).toBeNull();
});

it('refuses missing/stale/Float/offline measurements and invalid image coordinates', async () => {
  await expect(alignDockPhoto(sn, 52.1, 6.2)).rejects.toThrow('verse');
  samples(pose.x, 5);
  await expect(alignDockPhoto(sn, 52.1, 6.2)).rejects.toThrow('verse');
  clearPositionTelemetry(sn); samples();
  vi.mocked(isDeviceOnline).mockReturnValue(false);
  await expect(alignDockPhoto(sn, 52.1, 6.2)).rejects.toThrow('verse');
  for (const lat of [null, '', '52.1', NaN, 91]) await expect(alignDockPhoto(sn, lat, 6.2)).rejects.toThrow('geldig');
  expect(readMowerMapSnapshot).not.toHaveBeenCalled();
});

it('does not combine the new photo reference with a physical zone offset or legacy transform', async () => {
  samples();
  mapRepo.setPolygonOffset(sn, 0.1, 0);
  await expect(alignDockPhoto(sn, 52.1, 6.2)).rejects.toThrow('verschuiving');
  mapRepo.setPolygonOffset(sn, 0, 0); mapRepo.setCalibration(sn, { rotation: 2 });
  await expect(alignDockPhoto(sn, 52.1, 6.2)).rejects.toThrow('rotatie');
  expect(readMowerMapSnapshot).not.toHaveBeenCalled();
});

it('does not accept empty YAML cells as zero', () => {
  expect(snapshotDockPose({ ...snapshot(), charging_station_yaml: 'charging_pose: [,0.73,-1.518115]' })).toBeNull();
});
