import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ online: true, stable: true, unvalidated: new Set<string>(), revisions: new Map<string, number>(), command: vi.fn() }));
vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: () => state.online }));
vi.mock('../../services/mowerFileCapability.js', () => ({ isOpenNovaMower: () => true }));
vi.mock('../../services/frameValidation.js', () => ({ isFrameUnvalidated: (sn: string) => state.unvalidated.has(sn), getFrameRevision: (sn: string) => state.revisions.get(sn) ?? 0 }));
vi.mock('../../services/positionTelemetry.js', () => ({ stablePosition: () => state.stable ? { x: 0, y: 0 } : null }));
vi.mock('../../services/mowerMapOperation.js', () => ({
  withMowerMapOperation: vi.fn(async (sn, run) => run({ sn, id: 'alignment-test', command: (...args: unknown[]) => state.command(sn, ...args) })),
  readMowerMapSnapshot: vi.fn(),
}));

import { readMowerMapSnapshot } from '../../services/mowerMapOperation.js';
import { beginCopyAlignment, captureCopyAlignment, consumeCopyAlignment, frameSnapshotSignature, getCopyAlignment, validateCopyAlignment } from '../../services/copyAlignment.js';

const sourceSn = 'LFIN_ALIGNMENT_SOURCE', targetSn = 'LFIN_ALIGNMENT_TARGET', canonical = 'map0';
const snapshot = () => ({
  result: 0, snapshot_consistent: true,
  pos_json: JSON.stringify({ time_stamp: 123, utm_origin: { x: 300000, y: 5700000, z: 0, utm_zone: 32 } }),
  charging_station_yaml: 'charging_pose: [0.03,0.73,-1.5]',
  csv_files: {
    'map_info.json': JSON.stringify({ charging_pose: { x: .03, y: .73, orientation: -1.5 } }),
    'map0_work.csv': '0,0\n3,0\n3,3\n0,3\n',
    'map0_0_obstacle.csv': '1,1\n2,1\n2,2\n1,2\n',
  },
});
let snapshots: Record<string, ReturnType<typeof snapshot>>;
let counts: Record<string, number>;
let override: (raw: Record<string, unknown>) => Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-26T10:00:00Z'));
  state.online = true; state.stable = true; state.unvalidated.clear(); state.revisions.clear(); state.command.mockReset();
  counts = {}; override = raw => raw;
  snapshots = { [sourceSn]: snapshot(), [targetSn]: snapshot() };
  vi.mocked(readMowerMapSnapshot).mockReset().mockImplementation(async sn => structuredClone(snapshots[sn]));
  state.command.mockImplementation(async (sn: string, cmd: string, _params: unknown, timeout: number) => {
    expect(cmd).toBe('measure_dock_marker'); expect(timeout).toBe(35_000);
    const i = counts[sn] ?? 0; counts[sn] = i + 1;
    const x = sn === sourceSn ? 2 : 12, y = sn === sourceSn ? 1 : 21;
    const started = Date.now() / 1000 + .1;
    vi.setSystemTime(Date.now() + 8_000);
    return override({ result: 0, protocol: 'aruco-map-marker-v1',
      marker: { x, y, z: .2, yaw: .7 }, base: { x: x - 1 + i * .2, y, z: 0, yaw: 0 },
      sample_count: 22, unique_stamps: 22, spread_m: .01, yaw_spread_rad: .018, max_pair_dt_s: .11,
      frame_fingerprint: frameSnapshotSignature(snapshots[sn]), capture_started: started, capture_finished: started + 7,
    });
  });
});
afterEach(() => vi.useRealTimers());

async function complete() {
  const s = await beginCopyAlignment(targetSn, sourceSn, canonical);
  const phases = ['source_first'];
  for (const side of ['source', 'source', 'target', 'target'] as const) phases.push((await captureCopyAlignment(s.alignmentId, side)).phase);
  expect(phases).toEqual(['source_first', 'source_second', 'target_first', 'target_second', 'ready']);
  return s.alignmentId;
}
const validate = (id: string) => validateCopyAlignment(id, { targetSn, sourceSn, canonical, sourceSnapshot: snapshots[sourceSn], targetSnapshot: snapshots[targetSn] });

it('has the same normalized fingerprint as Python BE doubles and ignores only origin timestamp/JSON formatting', () => {
  const s = snapshot();
  expect(frameSnapshotSignature(s)).toBe('b29d26ce4347bc20909832fb94d8eea345cd844108ab7d502111970607c8a3e4');
  s.pos_json = '{"utm_origin":{"utm_zone":32,"z":0,"y":5700000,"x":300000},"time_stamp":456}';
  expect(frameSnapshotSignature(s)).toBe(frameSnapshotSignature(snapshot()));
  s.charging_station_yaml = 'charging_pose: [0,0,0]';
  expect(() => frameSnapshotSignature(s)).toThrow('not confirmed');
});

it('requires all four fresh viewpoints, translates the saved source dock rather than the marker, and does not mutate snapshots', async () => {
  const before = structuredClone(snapshots);
  const id = await complete();
  const result = validate(id);
  expect(result.dockAtB.x).toBeCloseTo(10.03); expect(result.dockAtB.y).toBeCloseTo(20.73);
  expect(result.captures.source).toHaveLength(2); expect(result.captures.target).toHaveLength(2);
  result.captures.source[0].marker.x = 999;
  expect(validate(id).dockAtB.x).toBeCloseTo(10.03);
  expect(snapshots).toEqual(before);
  expect(state.command).toHaveBeenCalledTimes(4);
  consumeCopyAlignment(id);
  expect(() => validate(id)).toThrow('unknown');
});

it('rejects unknown/expired sessions, different source/target/zone and reordered or incomplete captures', async () => {
  expect(() => getCopyAlignment('missing', targetSn, sourceSn, canonical)).toThrow('unknown');
  const s = await beginCopyAlignment(targetSn, sourceSn, canonical);
  expect(() => getCopyAlignment(s.alignmentId, sourceSn, targetSn, canonical)).toThrow('different');
  expect(() => getCopyAlignment(s.alignmentId, targetSn, sourceSn, 'map1')).toThrow('different');
  await expect(captureCopyAlignment(s.alignmentId, 'target')).rejects.toThrow('order');
  expect(() => validate(s.alignmentId)).toThrow('twice');
  vi.setSystemTime(Date.now() + 20 * 60_000);
  await expect(captureCopyAlignment(s.alignmentId, 'source')).rejects.toThrow('expired');
});

it('rejects invalid direct inputs and different UTM zones before marker measurements', async () => {
  await expect(beginCopyAlignment(targetSn, sourceSn, 0 as unknown as string)).rejects.toThrow('valid source zone');
  await expect(beginCopyAlignment(targetSn, {} as string, canonical)).rejects.toThrow('different source');
  snapshots[targetSn].pos_json = snapshots[targetSn].pos_json.replace('"utm_zone":32', '"utm_zone":31');
  await expect(beginCopyAlignment(targetSn, sourceSn, canonical)).rejects.toThrow('different UTM zones');
  expect(state.command).not.toHaveBeenCalled();
});

it('never lets concurrent captures advance the same wizard step twice', async () => {
  const s = await beginCopyAlignment(targetSn, sourceSn, canonical);
  const original = state.command.getMockImplementation()!;
  let release: () => void = () => {};
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  // The real operation lease rejects this race sooner; retain the final state check as well.
  state.command.mockImplementation(async (...args: unknown[]) => {
    const raw = await original(...args);
    if (++started === 2) release();
    await bothStarted;
    return raw;
  });
  const results = await Promise.allSettled([captureCopyAlignment(s.alignmentId, 'source'), captureCopyAlignment(s.alignmentId, 'source')]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: expect.objectContaining({ message: expect.stringContaining('Another capture') }) });
  expect(getCopyAlignment(s.alignmentId, targetSn, sourceSn, canonical).captures.source).toHaveLength(1);
});

it.each([
  ['missing protocol', (r: Record<string, unknown>) => ({ ...r, protocol: undefined }), 'verified'],
  ['old protocol', (r: Record<string, unknown>) => ({ ...r, protocol: 'legacy-pose' }), 'verified'],
  ['device error', (r: Record<string, unknown>) => ({ ...r, result: 1, error: 'fresh idle robot required' }), 'fresh idle robot required'],
  ['error result', (r: Record<string, unknown>) => ({ ...r, result: 1 }), 'verified'],
  ['wrong frame', (r: Record<string, unknown>) => ({ ...r, frame_fingerprint: 'other' }), 'different mower frame'],
  ['cached frames', (r: Record<string, unknown>) => ({ ...r, capture_started: Number(r.capture_started) - 30, capture_finished: Number(r.capture_finished) - 30 }), 'stale'],
  ['future frames', (r: Record<string, unknown>) => ({ ...r, capture_started: Number(r.capture_started) + 30, capture_finished: Number(r.capture_finished) + 30 }), 'stale'],
  ['repeated frames', (r: Record<string, unknown>) => ({ ...r, unique_stamps: 1 }), 'stable'],
  ['too brief', (r: Record<string, unknown>) => ({ ...r, capture_finished: Number(r.capture_started) + 1 }), 'stale'],
  ['position spread', (r: Record<string, unknown>) => ({ ...r, spread_m: .031 }), 'stable'],
  ['yaw spread', (r: Record<string, unknown>) => ({ ...r, yaw_spread_rad: .04 }), 'stable'],
  ['unsynchronized pose', (r: Record<string, unknown>) => ({ ...r, max_pair_dt_s: .13 }), 'synchronized'],
  ['missing marker', (r: Record<string, unknown>) => ({ ...r, marker: { x: 1 } }), 'incomplete'],
  ['too far away', (r: Record<string, unknown>) => ({ ...r, base: { x: 0, y: 0, z: 0, yaw: 0 } }), 'closer'],
])('rejects %s without advancing the wizard', async (_name, change, message) => {
  const s = await beginCopyAlignment(targetSn, sourceSn, canonical);
  override = change;
  await expect(captureCopyAlignment(s.alignmentId, 'source')).rejects.toThrow(message);
  expect(getCopyAlignment(s.alignmentId, targetSn, sourceSn, canonical).phase).toBe('source_first');
});

it('requires a distinct second viewpoint and checks independent marker position and circular heading agreement', async () => {
  const s = await beginCopyAlignment(targetSn, sourceSn, canonical);
  await captureCopyAlignment(s.alignmentId, 'source');
  counts[sourceSn] = 0;
  await expect(captureCopyAlignment(s.alignmentId, 'source')).rejects.toThrow('15 cm');
  counts[sourceSn] = 1;
  override = raw => ({ ...raw, marker: { ...(raw.marker as object), x: 2.04 } });
  await expect(captureCopyAlignment(s.alignmentId, 'source')).rejects.toThrow('disagree');
  override = raw => raw;
  await captureCopyAlignment(s.alignmentId, 'source');
  override = raw => ({ ...raw, marker: { ...(raw.marker as object), yaw: .73 } });
  await expect(captureCopyAlignment(s.alignmentId, 'target')).rejects.toThrow('headings');
});

it('binds final validation to both native frames and the complete source work/obstacle geometry', async () => {
  const id = await complete();
  const source = structuredClone(snapshots[sourceSn]), target = structuredClone(snapshots[targetSn]);
  snapshots[targetSn].pos_json = snapshots[targetSn].pos_json.replace('300000', '300001');
  expect(() => validate(id)).toThrow('changed');
  snapshots[targetSn] = target;
  snapshots[sourceSn].csv_files['map0_0_obstacle.csv'] += '1.1,1.1\n';
  expect(() => validate(id)).toThrow('changed');
  snapshots[sourceSn] = source;
  expect(validate(id).phase).toBe('ready');
  state.revisions.set(sourceSn, 1);
  expect(() => validate(id)).toThrow('frame changed');
});

it('rejects frame changes during capture, degraded localization and offline mowers', async () => {
  const s = await beginCopyAlignment(targetSn, sourceSn, canonical);
  let reads = 0;
  vi.mocked(readMowerMapSnapshot).mockImplementation(async sn => {
    const result = structuredClone(snapshots[sn]);
    if (++reads === 2) result.pos_json = result.pos_json.replace('300000', '300001');
    return result;
  });
  await expect(captureCopyAlignment(s.alignmentId, 'source')).rejects.toThrow('changed');
  state.stable = false;
  await expect(captureCopyAlignment(s.alignmentId, 'source')).rejects.toThrow('stable RTK');
  state.stable = true; state.unvalidated.add(sourceSn);
  expect(() => getCopyAlignment(s.alignmentId, targetSn, sourceSn, canonical)).toThrow('validated');
  state.unvalidated.clear(); state.online = false;
  await expect(beginCopyAlignment(targetSn, sourceSn, canonical)).rejects.toThrow('online');
});
