import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import unzipper from 'unzipper';

vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: vi.fn(() => true) }));
vi.mock('../../services/mowerFileCapability.js', () => ({ isOpenNovaMower: () => true }));
vi.mock('../../services/mapBackup.js', () => ({ scheduleSnapshot: vi.fn() }));
vi.mock('../../mqtt/sensorData.js', () => ({ deviceCache: new Map(), getDockPose: vi.fn() }));
vi.mock('../../dashboard/socketHandler.js', () => ({ forwardToDashboard: vi.fn() }));
vi.mock('../../services/mowerMapOperation.js', () => ({
  withMowerMapOperation: vi.fn(async (sn, run) => run({ sn, id: 'repair-test' })),
  readMowerMapSnapshot: vi.fn(),
}));
vi.mock('../../services/mowerMapApply.js', () => ({ installVerifiedMapZip: vi.fn() }));

import { planDockChannelRepair, repairDockChannels, withConfirmedCopyDocks } from '../../services/dockChannelRepair.js';
import { readMowerMapSnapshot } from '../../services/mowerMapOperation.js';
import { installVerifiedMapZip } from '../../services/mowerMapApply.js';
import { mapRepo, deviceSettingsRepo } from '../../db/repositories/index.js';
import { clearFrameUnvalidated, markFrameUnvalidated, isFrameUnvalidated } from '../../services/frameValidation.js';
import { clearPositionTelemetry, ingestPositionTelemetry } from '../../services/positionTelemetry.js';
import { getPhotoDockPose, PHOTO_DOCK_KEY } from '../../services/dockPhotoReference.js';
import { isDeviceOnline } from '../../mqtt/broker.js';
import { previewZoneCopy } from '../../services/zoneCopy.js';

const sn = 'LFIN_REPAIR_TEST', source = 'LFIN_SOURCE_TEST';
const pose = { x: 0.03, y: 0.73, orientation: -Math.PI / 2 };
const goodChannel = '0.03,0.73\n0.03,1.93\n';
const snapshot = () => {
  const csv = { 'map0_work.csv': '-3,0\n3,0\n3,8\n-3,8\n',
    'map0tocharge_unicom.csv': '-1.1,1.18\n-1.09,0.52\n',
    'map_info.json': JSON.stringify({ charging_pose: pose }) };
  return { result: 0, snapshot_consistent: true, csv_files: csv, x3_csv_files: { ...csv },
    charging_station_yaml: `charging_pose: [${pose.x}, ${pose.y}, ${pose.orientation}]`, pos_json: '{"origin":"unchanged"}' };
};
function samples(target = sn, x = pose.x) {
  clearPositionTelemetry(target);
  for (let i = 0; i < 8; i++) ingestPositionTelemetry(target, {
    rtk_fix_quality: 4, localization_state: 'RUNNING', recharge_status: 9, map_position_x: x, map_position_y: pose.y,
  }, Date.now() - 8000 + i * 1000);
}
function rows(target: string, s = snapshot()) {
  for (const [name, text] of Object.entries(s.csv_files)) if (name.endsWith('.csv')) {
    const work = name.endsWith('_work.csv');
    mapRepo.create({ map_id: `${target}-${name}`, mower_sn: target,
      map_type: work ? 'work' : 'unicom', canonical_name: name.slice(0, work ? -9 : -4),
      map_area: JSON.stringify(text.trim().split('\n').map(line => { const [x, y] = line.split(',').map(Number); return { x, y }; })) });
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  rmSync(path.join(process.env.STORAGE_PATH!, 'dock-channel-repair'), { recursive: true, force: true });
  clearFrameUnvalidated(sn); clearFrameUnvalidated(source); samples();
  vi.mocked(isDeviceOnline).mockReturnValue(true);
  rows(sn);
  vi.mocked(readMowerMapSnapshot).mockResolvedValue(snapshot());
  vi.mocked(installVerifiedMapZip).mockImplementation(async (_sn, input) => {
    markFrameUnvalidated(sn);
    const pgm = Buffer.concat([Buffer.from('P5\n3 3\n255\n'), Buffer.alloc(9, 254)]).toString('base64');
    return { ...input.before, csv_files: Object.fromEntries(input.expectedCsv), x3_csv_files: Object.fromEntries(input.expectedCsv),
      map_files_text: { 'map.yaml': 'image: map.pgm', 'map0.yaml': 'image: map0.pgm' },
      map_files_b64: { 'map.pgm': pgm, 'map0.pgm': pgm } };
  });
});

it('repairs toward the lawn using saved heading, preserving every non-channel CSV byte', () => {
  const s = snapshot(), p = planDockChannelRepair(s);
  expect(p.channels[0].points[0]).toMatchObject({ x: pose.x, y: pose.y });
  expect(p.channels[0].points.at(-1)!.y).toBeCloseTo(1.93);
  expect(p.csvFiles['map0_work.csv']).toBe(s.csv_files['map0_work.csv']);
  expect(p.csvFiles['map_info.json']).toBe(s.csv_files['map_info.json']);
  expect(s.csv_files['map0tocharge_unicom.csv']).toBe('-1.1,1.18\n-1.09,0.52\n');
  s.x3_csv_files['map_info.json'] = JSON.stringify({ charging_pose: { x: -1.1, y: 1.18, orientation: 1.5 } });
  expect(planDockChannelRepair(s).secondaryMetadataChanged).toBe(true);
  const wrongDirection = snapshot();
  wrongDirection.csv_files['map_info.json'] = JSON.stringify({ charging_pose: { ...pose, orientation: Math.PI / 2 } });
  wrongDirection.x3_csv_files = { ...wrongDirection.csv_files };
  wrongDirection.charging_station_yaml = `charging_pose: [${pose.x}, ${pose.y}, ${Math.PI / 2}]`;
  expect(() => planDockChannelRepair(wrongDirection)).toThrow('vrije dockaanloop');
});

it('rejects contradictory dock files, incomplete copies and obstacles beside the centreline', () => {
  const bad = snapshot(); bad.charging_station_yaml = 'charging_pose: [9,9,1]';
  expect(() => planDockChannelRepair(bad)).toThrow('dockpositie');
  const different = snapshot(); different.x3_csv_files['map0_work.csv'] += '0,0\n';
  expect(() => planDockChannelRepair(different)).toThrow('kaartkopieën');
  const blocked = snapshot();
  Object.assign(blocked.csv_files, { 'map0_0_obstacle.csv': '.5,1.5\n.6,1.5\n.6,1.7\n.5,1.7' });
  blocked.x3_csv_files = { ...blocked.csv_files };
  expect(() => planDockChannelRepair(blocked)).toThrow('vrije dockaanloop');
});

it('previews without writes; backs up, verifies device, and commits only the channel and heading', async () => {
  deviceSettingsRepo.upsert(sn, PHOTO_DOCK_KEY, JSON.stringify(pose));
  const before = mapRepo.findBySnAndCanonical(sn, 'map0');
  const { preview } = await repairDockChannels(sn);
  expect(installVerifiedMapZip).not.toHaveBeenCalled();
  const result = await repairDockChannels(sn, preview.planHash);
  expect(result.applied).toBe(true);
  expect(mapRepo.findBySnAndCanonical(sn, 'map0')).toEqual(before);
  expect(mapRepo.getPolygonChargingOrientation(sn)).toBe(pose.orientation);
  expect(getPhotoDockPose(sn)).toEqual(pose);
  expect(isFrameUnvalidated(sn)).toBe(false);
  const backup = JSON.parse(readFileSync(path.join(process.env.STORAGE_PATH!, 'dock-channel-repair', 'repair-test', 'before.json'), 'utf8'));
  expect(backup.snapshot.pos_json).toBe(snapshot().pos_json);
  const input = vi.mocked(installVerifiedMapZip).mock.calls[0][1];
  const zip = await unzipper.Open.buffer(input.bytes);
  expect((await zip.files.find(f => f.path === 'csv_file/map0_work.csv')!.buffer()).toString()).toBe(snapshot().csv_files['map0_work.csv']);
});

it('rejects a changed plan, bad live frame, and uncertain transfer without committing the DB', async () => {
  const { preview } = await repairDockChannels(sn);
  mapRepo.setCalibration(sn, { charger_lat: 52 });
  await expect(repairDockChannels(sn, preview.planHash)).rejects.toThrow('gewijzigd');
  samples(sn, -1.1);
  await expect(repairDockChannels(sn)).rejects.toThrow('5 cm');
  samples(); const current = await repairDockChannels(sn);
  const before = mapRepo.findByMowerSn(sn);
  vi.mocked(installVerifiedMapZip).mockImplementation(async () => { markFrameUnvalidated(sn); return null; });
  await expect(repairDockChannels(sn, current.preview.planHash)).rejects.toThrow('niet bevestigd');
  expect(mapRepo.findByMowerSn(sn)).toEqual(before);
  expect(isFrameUnvalidated(sn)).toBe(true);
});

it('dashboard copies use confirmed native docks and refuse old-channel conflicts before writing', async () => {
  const src = snapshot(); src.csv_files['map0tocharge_unicom.csv'] = goodChannel; src.x3_csv_files = { ...src.csv_files };
  rows(source, src);
  vi.mocked(readMowerMapSnapshot).mockImplementation(async target => target === source ? src : snapshot());
  const copy = vi.fn();
  await expect(withConfirmedCopyDocks(sn, source, copy)).rejects.toThrow('Herstel eerst');
  expect(copy).not.toHaveBeenCalled();
  const target = src;
  mapRepo.updateAreaAndBoundsByIdAndMower(`${sn}-map0tocharge_unicom.csv`, sn, JSON.stringify([{ x: .03, y: .73 }, { x: .03, y: 1.93 }]), '{}');
  vi.mocked(readMowerMapSnapshot).mockResolvedValue(target);
  const result = await withConfirmedCopyDocks(sn, source, docks => previewZoneCopy(sn, source, 'map0', pose, { docks }));
  expect(result.ok && result.plan.ok).toBe(true);
  if (result.ok) expect(result.plan.channels[0].points[0]).toMatchObject({ x: pose.x, y: pose.y });
  // No former channel is needed to confirm the destination's independent dock.
  for (const row of mapRepo.findByMowerSn(sn)) mapRepo.deleteById(row.map_id);
  const empty = { ...target, csv_files: { 'map_info.json': target.csv_files['map_info.json'] }, x3_csv_files: { 'map_info.json': target.csv_files['map_info.json'] } };
  vi.mocked(readMowerMapSnapshot).mockImplementation(async targetSn => targetSn === source ? src : empty);
  const first = await withConfirmedCopyDocks(sn, source, docks => previewZoneCopy(sn, source, 'map0', pose, { docks }));
  expect(first.ok && first.plan.ok).toBe(true);
  clearPositionTelemetry(sn);
  await expect(withConfirmedCopyDocks(sn, source, copy)).rejects.toThrow('RTK Fixed');
});

if (process.env.DOCK_REPAIR_SNAPSHOT) it('checks the supplied offline mower snapshot without device access', () => {
  const native = JSON.parse(readFileSync(process.env.DOCK_REPAIR_SNAPSHOT!, 'utf8'));
  const plan = planDockChannelRepair(native);
  for (const [name, text] of Object.entries(native.csv_files)) {
    if (!name.includes('tocharge_unicom')) expect(plan.csvFiles[name]).toBe(text);
  }
  console.log('OFFLINE DOCK REPAIR', JSON.stringify({ pose: plan.pose, channels: plan.channels }));
});
