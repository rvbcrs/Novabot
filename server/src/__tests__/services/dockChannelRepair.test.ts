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
import { clearFrameUnvalidated, clearMapInstallPending, markMapInstallPending, isFrameUnvalidated, markFrameUnvalidated } from '../../services/frameValidation.js';
import { getPolygonAnchor } from '../../services/anchor.js';
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
  clearFrameUnvalidated(sn); clearMapInstallPending(sn); clearFrameUnvalidated(source); clearMapInstallPending(source); samples();
  vi.mocked(isDeviceOnline).mockReturnValue(true);
  rows(sn);
  vi.mocked(readMowerMapSnapshot).mockResolvedValue(snapshot());
  vi.mocked(installVerifiedMapZip).mockImplementation(async (_sn, input) => {
    markMapInstallPending(sn);
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

// Field report (N2000, Oct 2026): with no dock channel anywhere, the anchor was
// null, so re-anchor, map pushes and this repair all refused, and only a new
// map0 mapping session could bring a channel back.
const noChannel = () => {
  const s = snapshot();
  delete (s.csv_files as Record<string, string>)['map0tocharge_unicom.csv'];
  s.x3_csv_files = { ...s.csv_files };
  return s;
};

it('creates a missing dock channel from the saved dock, into the zone it sits in', () => {
  const s = noChannel(), p = planDockChannelRepair(s);
  expect(p.created).toBe(true);
  expect(p.needed).toBe(true);
  expect(p.channels.map(c => c.name)).toEqual(['map0tocharge_unicom.csv']);
  expect(p.channels[0].points[0]).toMatchObject({ x: pose.x, y: pose.y });
  expect(p.channels[0].points.at(-1)!.y).toBeCloseTo(1.93);
  expect(p.csvFiles['map0_work.csv']).toBe(s.csv_files['map0_work.csv']);
  const far = noChannel();
  const farPose = { x: 0, y: -5, orientation: -Math.PI / 2 };
  far.csv_files['map_info.json'] = JSON.stringify({ charging_pose: farPose });
  far.x3_csv_files = { ...far.csv_files };
  far.charging_station_yaml = `charging_pose: [${farPose.x}, ${farPose.y}, ${farPose.orientation}]`;
  expect(() => planDockChannelRepair(far)).toThrow('verder dan 3 m');
});

it('leaves a channel that already starts at the saved dock alone', async () => {
  const healthy = snapshot();
  healthy.csv_files['map0tocharge_unicom.csv'] = goodChannel; healthy.x3_csv_files = { ...healthy.csv_files };
  expect(planDockChannelRepair(healthy).needed).toBe(false);
  for (const row of mapRepo.findByMowerSn(sn)) mapRepo.deleteById(row.map_id);
  rows(sn, healthy);
  vi.mocked(readMowerMapSnapshot).mockResolvedValue(healthy);
  const { preview } = await repairDockChannels(sn);
  expect(preview.needed).toBe(false);
  await expect(repairDockChannels(sn, preview.planHash)).rejects.toThrow('niets te herstellen');
  expect(installVerifiedMapZip).not.toHaveBeenCalled();
});

it('creates the channel on an unvalidated frame and gives the server its anchor back', async () => {
  for (const row of mapRepo.findByMowerSn(sn)) mapRepo.deleteById(row.map_id);
  rows(sn, noChannel());
  vi.mocked(readMowerMapSnapshot).mockResolvedValue(noChannel());
  expect(getPolygonAnchor(sn)).toBeNull();
  // A frame that is off is why the mower reads half a metre from its saved dock.
  markFrameUnvalidated(sn);
  samples(sn, pose.x + 0.5);
  const { preview } = await repairDockChannels(sn);
  expect(preview).toMatchObject({ created: true, needed: true, zone: 'map0' });
  expect(preview.seatOffsetM).toBeCloseTo(0.5, 2);
  const result = await repairDockChannels(sn, preview.planHash);
  expect(result.applied).toBe(true);
  expect(getPolygonAnchor(sn)).toMatchObject({ x: pose.x, y: pose.y });
  expect(mapRepo.findBySnAndCanonical(sn, 'map0tocharge_unicom')?.map_type).toBe('unicom');
  // Validating the frame is the re-anchor's job, not this repair's.
  expect(isFrameUnvalidated(sn)).toBe(true);
});

it('still refuses to rebuild an existing channel on an unvalidated frame', async () => {
  markFrameUnvalidated(sn);
  await expect(repairDockChannels(sn)).rejects.toThrow('gevalideerd frame');
});

it('accepts a connector filtered in csv_file while x3_csv_file keeps the route (touching zones)', () => {
  const s = snapshot();
  (s.csv_files as Record<string, string>)['map0tomap1_0_unicom.csv'] = '';
  (s.x3_csv_files as Record<string, string>)['map0tomap1_0_unicom.csv'] = '3,4\n8,4\n';
  expect(planDockChannelRepair(s).csvFiles['map0tomap1_0_unicom.csv']).toBe('3,4\n8,4\n');
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
  // Seating plus RTK leaves .244 5 to 6 cm from its saved dock (since 2026-06);
  // the gate exists for frame errors of decimetres to metres (1.15 m on 2026-09-26).
  samples(sn, pose.x - .08);
  expect((await repairDockChannels(sn)).ok).toBe(true);
  samples(sn, pose.x - .12);
  await expect(repairDockChannels(sn)).rejects.toThrow('10 cm');
  samples(); const current = await repairDockChannels(sn);
  const before = mapRepo.findByMowerSn(sn);
  vi.mocked(installVerifiedMapZip).mockImplementation(async () => { markMapInstallPending(sn); return null; });
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

it('quick placement accepts a docked mower up to 30 cm from its saved dock; the default stays 10 cm', async () => {
  const src = snapshot(); src.csv_files['map0tocharge_unicom.csv'] = goodChannel; src.x3_csv_files = { ...src.csv_files };
  rows(source, src);
  mapRepo.updateAreaAndBoundsByIdAndMower(`${sn}-map0tocharge_unicom.csv`, sn, JSON.stringify([{ x: .03, y: .73 }, { x: .03, y: 1.93 }]), '{}');
  vi.mocked(readMowerMapSnapshot).mockResolvedValue(src);
  samples(sn, pose.x + 0.2);
  await expect(withConfirmedCopyDocks(sn, source, vi.fn())).rejects.toThrow('10 cm');
  const seen = await withConfirmedCopyDocks(sn, source, docks => docks.seatToleranceM, true, 0.3);
  expect(seen).toBe(0.3);
  samples(sn, pose.x + 0.35);
  await expect(withConfirmedCopyDocks(sn, source, vi.fn(), true, 0.3)).rejects.toThrow('30 cm');
});

it('admits a target whose own failed install is pending, but never a source in that state', async () => {
  const src = snapshot(); src.csv_files['map0tocharge_unicom.csv'] = goodChannel; src.x3_csv_files = { ...src.csv_files };
  rows(source, src);
  mapRepo.updateAreaAndBoundsByIdAndMower(`${sn}-map0tocharge_unicom.csv`, sn, JSON.stringify([{ x: .03, y: .73 }, { x: .03, y: 1.93 }]), '{}');
  // The unfinished install left a zone on the target that the DB never learned.
  const leftover = { ...src.csv_files, 'map1_work.csv': '4,0\n10,0\n10,8\n4,8\n' };
  const target = { ...src, csv_files: leftover, x3_csv_files: { ...leftover } };
  vi.mocked(readMowerMapSnapshot).mockImplementation(async s => s === source ? src : target);
  markMapInstallPending(sn);
  const result = await withConfirmedCopyDocks(sn, source, docks => previewZoneCopy(sn, source, 'map0', pose, { docks }));
  expect(result.ok && result.plan.ok).toBe(true);
  clearMapInstallPending(sn);
  await expect(withConfirmedCopyDocks(sn, source, vi.fn())).rejects.toThrow('verschillende kaarten');
  vi.mocked(readMowerMapSnapshot).mockResolvedValue(src);
  markMapInstallPending(source);
  await expect(withConfirmedCopyDocks(sn, source, vi.fn())).rejects.toThrow('gevalideerd frame');
});

if (process.env.DOCK_REPAIR_SNAPSHOT) it('checks the supplied offline mower snapshot without device access', () => {
  const native = JSON.parse(readFileSync(process.env.DOCK_REPAIR_SNAPSHOT!, 'utf8'));
  const plan = planDockChannelRepair(native);
  for (const [name, text] of Object.entries(native.csv_files)) {
    if (!name.includes('tocharge_unicom')) expect(plan.csvFiles[name]).toBe(text);
  }
  console.log('OFFLINE DOCK REPAIR', JSON.stringify({ pose: plan.pose, channels: plan.channels }));
});
