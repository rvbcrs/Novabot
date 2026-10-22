import { describe, expect, it, vi } from 'vitest';

vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: () => true }));
vi.mock('../../services/mowerFileCapability.js', () => ({ isOpenNovaMower: () => true }));
vi.mock('../../services/mapBackup.js', () => ({ scheduleSnapshot: vi.fn() }));
vi.mock('../../mqtt/sensorData.js', () => ({ deviceCache: new Map(), getDockPose: vi.fn() }));
vi.mock('../../dashboard/socketHandler.js', () => ({ forwardToDashboard: vi.fn() }));
vi.mock('../../services/mapApplyStatus.js', async original => ({ ...await original<object>(), waitForPlannerBack: vi.fn(async () => 'settled') }));
vi.mock('../../services/positionTelemetry.js', async original => ({ ...await original<object>(), freshPositionState: () => ({ docked: true }) }));
vi.mock('../../services/mowerMapOperation.js', () => ({
  withMowerMapOperation: vi.fn(async (sn, run) => run({ sn, id: 'apply-test' })),
  readMowerMapSnapshot: vi.fn(),
}));

import { applyMapsToMower, installVerifiedMapZip } from '../../services/mowerMapApply.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { readMowerMapSnapshot } from '../../services/mowerMapOperation.js';
import type { MowerMapOperation } from '../../services/mowerMapOperation.js';
import type { MapApply } from '../../services/mapApplyStatus.js';
import { parsePgm } from '../../maps/validateGrid.js';

const sn = 'LFIN_APPLY_TEST';
const anchor = { x: 0.03, y: 0.73 };
const yaml = 'charging_pose: [0.03, 0.73, -1.518115032497305]';
const serverInfo = JSON.stringify({
  charging_pose: { orientation: -1.518115032497305, x: 0.03, y: 0.73 },
  'map3_work.csv': { map_size: 111.31750000000002 },
  'map0_work.csv': { map_size: 203.65 },
}, null, 3) + '\n';
// Byte-for-byte what novabot_mapping wrote on LFIN2230700238 eight seconds
// after the restart that sync_map triggers (2026-10-02): its own float
// formatting and key order, and map_size recomputed from the polygon.
const firmwareInfo = '{\n   "charging_pose" : {\n      "orientation" : -1.518115032497305,\n      "x" : 0.029999999999999999,\n      "y" : 0.72999999999999998\n   },\n'
  + '   "map0_work.csv" : {\n      "map_size" : 213.69750000000005\n   },\n   "map3_work.csv" : {\n      "map_size" : 111.31750000000002\n   }\n}\n';
const files: Record<string, string> = {
  'map0_work.csv': '-3,0\n3,0\n3,8\n-3,8\n',
  'map3_work.csv': '10,0\n14,0\n14,5\n10,5\n',
  'map0tocharge_unicom.csv': '0.030000,0.730000\n0.017362,0.969667\n',
  'map_info.json': serverInfo,
};
const before = { result: 0, snapshot_consistent: true, csv_files: { ...files }, x3_csv_files: { ...files }, charging_station_yaml: yaml, pos_json: '{"origin":"same"}' };
const input = () => ({ bytes: Buffer.from('zip'), expectedCsv: new Map(Object.entries(files)), before, anchor });

function mower(after: Record<string, unknown>): MowerMapOperation {
  vi.mocked(readMowerMapSnapshot).mockResolvedValue(after);
  const command = vi.fn(async (name: string) => name === 'sync_map' ? { result: 0, restart: true, auto_recharge_restart: true }
    : name === 'regenerate_per_map_files' ? { result: 0 } : null);
  return { sn, id: 'apply-test', command } as unknown as MowerMapOperation;
}
const apply = () => ({ phase: vi.fn(), fail: vi.fn(), done: vi.fn() }) satisfies MapApply;

it('accepts the csv_file/map_info.json that novabot_mapping rewrites after its restart', async () => {
  const after = { ...before, csv_files: { ...files, 'map_info.json': firmwareInfo }, x3_csv_files: { ...files } };
  const a = apply();
  expect(await installVerifiedMapZip(sn, input(), mower(after), a)).toBe(after);
  expect(a.fail).not.toHaveBeenCalled();
});

it('still rejects a rewritten map_info.json that lost a zone', async () => {
  const lost = JSON.parse(firmwareInfo); delete lost['map3_work.csv'];
  const after = { ...before, csv_files: { ...files, 'map_info.json': JSON.stringify(lost) }, x3_csv_files: { ...files } };
  const a = apply();
  expect(await installVerifiedMapZip(sn, input(), mower(after), a)).toBeNull();
  expect(a.fail).toHaveBeenCalledWith('install_mismatch');
});

it('still rejects a polygon that came back different', async () => {
  const after = { ...before, csv_files: { ...files, 'map3_work.csv': '10,0\n14,0\n14,6\n10,6\n' }, x3_csv_files: { ...files } };
  const a = apply();
  expect(await installVerifiedMapZip(sn, input(), mower(after), a)).toBeNull();
  expect(a.fail).toHaveBeenCalledWith('install_mismatch');
});

it('names a changed origin or dock yaml as a frame change', async () => {
  const after = { ...before, pos_json: '{"origin":"moved"}' };
  const a = apply();
  expect(await installVerifiedMapZip(sn, input(), mower(after), a)).toBeNull();
  expect(a.fail).toHaveBeenCalledWith('frame_changed');
});

// GH #161 (LFIN2231000451, custom-50): home0 had lost map.yaml/map.pgm. sync_map
// can only bring CSVs, so regenerate_per_map_files refused ("call save_map
// type:1 first") and every Retry failed the same way.
describe('a mower without the whole-garden raster', () => {
  const lost = { ...before, map_files_text: { 'map0.yaml': 'image: map0.pgm\n' }, map_files_b64: {} };
  const names = (op: MowerMapOperation) => vi.mocked(op.command).mock.calls.map(c => c[0]);
  const written = (op: MowerMapOperation) => vi.mocked(op.command).mock.calls.find(c => c[0] === 'write_map_files')?.[1] as Record<string, any>;
  const lostInput = () => ({ ...input(), before: lost });

  it('gets one built from the installed CSVs before the per-zone grids', async () => {
    const op = mower(before);
    vi.mocked(op.command).mockImplementation(async (name: string) => name === 'sync_map' ? { result: 0, restart: true, auto_recharge_restart: true }
      : ['write_map_files', 'regenerate_per_map_files'].includes(name) ? { result: 0 } : null);
    const a = apply();
    expect(await installVerifiedMapZip(sn, lostInput(), op, a)).toBe(before);
    expect(a.fail).not.toHaveBeenCalled();
    expect(names(op)).toEqual(['sync_map', 'write_map_files', 'regenerate_per_map_files']);
    const params = written(op);
    // The CSVs sync_map just installed, unchanged, in both trees; nothing pruned or restarted.
    expect(params.csv_files).toEqual(files);
    expect(params.x3_csv_files).toEqual(files);
    expect(params.prune_connectors).toBeFalsy();
    expect(params.restart_mapping).toBe(false);
    expect(params).not.toHaveProperty('charging_station_yaml');
    expect(params).not.toHaveProperty('pos_json');
    expect(Object.keys(params.map_files_text)).toEqual(['map.yaml']);
    expect(Object.keys(params.map_files_b64).sort()).toEqual(['map.pgm', 'map.png']);
    expect(params.map_files_text['map.yaml']).toMatch(/^image: map\.pgm$/m);
    const grid = parsePgm(Buffer.from(params.map_files_b64['map.pgm'], 'base64'));
    // Both zones, 1 m border each side, at 5 cm: x -3..14, y 0..8.
    expect(grid && [grid.W, grid.H]).toEqual([380, 200]);
  });

  it.each([[null, 'regenerate_timeout'], [{ result: 1, error: 'disk full' }, 'regenerate_failed']] as const)(
    'stops before regenerate when writing it fails (%o)', async (answer, error) => {
      const op = mower(before);
      vi.mocked(op.command).mockImplementation(async (name: string) => name === 'sync_map' ? { result: 0, restart: true, auto_recharge_restart: true }
        : name === 'write_map_files' ? answer : { result: 0 });
      const a = apply();
      expect(await installVerifiedMapZip(sn, lostInput(), op, a)).toBeNull();
      expect(a.fail).toHaveBeenCalledWith(error);
      expect(names(op)).toEqual(['sync_map', 'write_map_files']);
    });

  it('keeps a raster that is there', async () => {
    const present = { ...before, map_files_text: { 'map.yaml': 'image: map.pgm\n' }, map_files_b64: { 'map.pgm': 'UDU=' } };
    const op = mower(before);
    expect(await installVerifiedMapZip(sn, { ...input(), before: present }, op, apply())).toBe(before);
    expect(names(op)).toEqual(['sync_map', 'regenerate_per_map_files']);
  });
});

// Field report (N2000, Oct 2026): a mower without any dock channel got the same
// sync_failed as a failed transfer, and the owner spent a day looking elsewhere.
it('says a push was refused because there is no dock anchor', async () => {
  const lone = 'LFIN_NO_ANCHOR';
  expect(await applyMapsToMower(lone)).toBe(false);
  expect(deviceCache.get(lone)?.get('map_apply_error')).toBe('no_dock_anchor');
});
