import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ online: true, docked: true, running: true, fixed: true, poseX: 0, publish: vi.fn(), command: vi.fn(), capture: vi.fn(), consume: vi.fn(), measureDock: vi.fn(), manual: undefined as (() => void) | undefined }));
vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: () => h.online }));
vi.mock('../../mqtt/mapSync.js', () => ({ publishToExtended: h.publish }));
vi.mock('../../services/frameValidation.js', () => ({ isFrameUnvalidated: () => false, getFrameRevision: () => 0 }));
vi.mock('../../services/positionTelemetry.js', () => ({ freshPositionState: () => ({ docked: h.docked, running: h.running, fixed: h.fixed, pose: { x: h.poseX, y: 0 } }), stablePosition: (_sn: string, options?: { docked?: boolean }) => !h.fixed || options?.docked && !h.docked ? null : ({ x: h.poseX, y: 0 }) }));
vi.mock('../../services/dockPhotoReference.js', () => ({ snapshotDockPose: () => ({ x: 0, y: 0, orientation: 0 }) }));
vi.mock('../../services/reanchorGps.js', () => ({ measureReanchorDock: h.measureDock }));
vi.mock('../../services/scheduleRunner.js', () => ({ disarmEdgeWatch: vi.fn() }));
vi.mock('../../services/mowerMapOperation.js', () => ({
  readMowerMapSnapshot: async () => ({ snapshot_manifest: { file: 'hash' } }),
  withMowerMapOperation: async (sn: string, run: (op: unknown) => unknown) => run({ sn, id: 'lease', command: h.command,
    set onManualControl(value: () => void) { h.manual = value; } }),
}));
vi.mock('../../services/copyAlignment.js', () => ({
  beginCopyAlignment: async () => ({ alignmentId: 'alignment' }), frameSnapshotSignature: () => 'fingerprint',
  captureCopyAlignment: h.capture, consumeCopyAlignment: h.consume,
  getCopyAlignment: () => ({ alignmentId: 'alignment', phase: 'target_first', captures: { source: [] } }),
}));
import { startSourceDockCycle, sourceDockCycle } from '../../services/sourceDockCycle.js';
import { guardedDockMove, recallDockedPose } from '../../services/dockMotion.js';
const LEFT_FROM = { x: 1, y: 2, yaw: 3 };
const native = (params: Record<string, unknown>, docked: boolean) => ({ result: 0, protocol: 'dock-measurement-motion-v4', docked, frame_fingerprint: 'fingerprint',
  ...(params.action === 'reverse' && params.from_dock ? { start_pose: LEFT_FROM } : {}) });
let id: string, elapsed: number;
const tick = (action: 'pulse' | 'stop' = 'pulse') => sourceDockCycle(id, 'target', 'source', action);
beforeEach(() => {
  vi.useFakeTimers(); elapsed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  id = crypto.randomUUID(); h.online = true; h.docked = true; h.running = true; h.fixed = true; h.poseX = 0;
  h.publish.mockReset(); h.command.mockReset(); h.capture.mockReset(); h.consume.mockReset();
  h.measureDock.mockReset().mockImplementation(async () => ({ dist: 0, latestDist: 0, runtime: { x: 0, y: 0, capture_started: Date.now(), capture_finished: Date.now() - 1 } }));
  h.command.mockImplementation(async (cmd, params) => {
    if (cmd === 'dock_measurement_move') { h.docked = params.action === 'dock'; h.poseX = 0; }
    return native(params, h.docked);
  });
});
afterEach(async () => {
  try { tick('stop'); } catch { /* start was rejected */ }
  elapsed += 310_000;
  await vi.advanceTimersByTimeAsync(6000);
  vi.useRealTimers(); vi.restoreAllMocks();
});
const start = () => startSourceDockCycle(id, 'target', 'source', 'map0');
const advance = async (ms = 100) => { elapsed += ms; await vi.advanceTimersByTimeAsync(ms); };

it.each(['dock-measurement-motion-v3', 'dock-measurement-motion-v4'])('docking requires native v4 before any movement (%s)', async protocol => {
  h.command.mockResolvedValue({ result: 0, protocol, docked: true, frame_fingerprint: 'fingerprint' });
  const beforeMove = vi.fn(() => expect(h.command.mock.calls.map(c => c[0])).toEqual(['dock_measurement_control']));
  const move = guardedDockMove('source', { sn: 'source', id: 'lease', reanchor: true, command: h.command },
    { action: 'dock', distance: 0, fromDock: false, signature: 'fingerprint', chargePose: LEFT_FROM }, () => {}, undefined, beforeMove);
  if (protocol.endsWith('v3')) {
    await expect(move).rejects.toThrow('nieuwere maaierfirmware');
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(beforeMove).not.toHaveBeenCalled();
  } else {
    await move;
    // The visual approach took 35s live; the native lease allows 120s.
    expect(h.command).toHaveBeenLastCalledWith('dock_measurement_move', expect.objectContaining({ recovery: true, charge_pose: LEFT_FROM }), 100_000);
    expect(beforeMove).toHaveBeenCalledOnce();
  }
  expect(h.publish).toHaveBeenLastCalledWith('source', { dock_measurement_control: { action: 'stop', motion_id: expect.any(String) } });
});

it('never asks the mower to dock without the pose it measured on departure', async () => {
  await expect(guardedDockMove('source', { sn: 'source', id: 'lease', reanchor: true, command: h.command },
    { action: 'dock', distance: 0, fromDock: false, signature: 'fingerprint' }, () => {})).rejects.toThrow('measured dock pose');
  expect(h.command).not.toHaveBeenCalled();
});

it('performs a 1 m departure, a second step, validated captures and a visual dock back to the departure pose', async () => {
  const events: string[] = [];
  h.command.mockImplementation(async (cmd, params) => {
    events.push(`${cmd}:${params.action}`);
    if (cmd === 'dock_measurement_move') h.docked = params.action === 'dock';
    return native(params, h.docked);
  });
  h.capture.mockImplementation(async (_id, side, owner) => { expect(side).toBe('source'); expect(owner.sn).toBe('source'); events.push('capture'); });
  start(); tick(); await advance();
  expect(tick()).toMatchObject({ phase: 'done', alignment: { phase: 'target_first' } });
  expect(events).toEqual(['dock_measurement_control:arm', 'dock_measurement_move:reverse', 'capture', 'dock_measurement_control:arm', 'dock_measurement_move:reverse', 'capture', 'dock_measurement_control:arm', 'dock_measurement_move:dock']);
  const moves = h.command.mock.calls.filter(([cmd]) => cmd === 'dock_measurement_move').map(([, p]) => p);
  // auto_recharge_server starts its visual approach without nav2 or a step-back
  // only 0.87..1.47 m in front of the charge pose it is given.
  expect(moves.map(p => [p.distance_m, p.from_dock])).toEqual([[1, true], [.2, false], [0, false]]);
  expect(moves[0]).not.toHaveProperty('charge_pose');
  // x/y from where it left, heading from the saved dock: the docked yaw is from
  // before the departure initialized the heading (GH #158).
  expect(moves[2].charge_pose).toEqual({ x: LEFT_FROM.x, y: LEFT_FROM.y, yaw: 0 });
  expect(recallDockedPose('source', 0)).toEqual({ x: LEFT_FROM.x, y: LEFT_FROM.y, yaw: 0 });
});

it('stops after a departure whose response lacks the pose it left from', async () => {
  h.command.mockImplementation(async (cmd, params) => {
    if (cmd === 'dock_measurement_move') h.docked = params.action === 'dock';
    return { ...native(params, h.docked), start_pose: undefined };
  });
  start(); tick(); await advance();
  expect(tick('stop')).toMatchObject({ phase: 'error', error: expect.stringContaining('newer mower firmware') });
  expect(h.command.mock.calls.filter(([cmd]) => cmd === 'dock_measurement_move')).toHaveLength(1);
  expect(h.capture).not.toHaveBeenCalled();
});

it('never moves when the start HTTP response was lost and no browser pulse arrives', async () => {
  start(); await advance(5100);
  expect(tick('stop').phase).toBe('error'); expect(h.command).not.toHaveBeenCalled();
});

it.each(['stop', 'manual', 'disconnect', 'expired-browser', 'measurement-failure'])('does not start the next movement or docking after %s during capture', async kind => {
  h.capture.mockImplementation(async () => {
    if (kind === 'stop') tick('stop');
    if (kind === 'manual') h.manual!();
    if (kind === 'disconnect') h.online = false;
    if (kind === 'expired-browser') elapsed += 5100;
    if (kind === 'measurement-failure') throw new Error('inconsistent marker');
  });
  start(); tick(); await advance();
  expect(tick('stop').phase).toBe('error');
  expect(h.command.mock.calls.filter(([cmd]) => cmd === 'dock_measurement_move')).toHaveLength(1);
  expect(h.consume).toHaveBeenCalledWith('alignment');
});

it('sends a stop for an in-flight movement and retains the cycle until its response', async () => {
  let release!: (value: unknown) => void;
  h.command.mockImplementation(async cmd => cmd === 'dock_measurement_control' ? { result: 0, protocol: 'dock-measurement-motion-v4' } : new Promise(resolve => { release = resolve; }));
  start(); tick(); await advance();
  expect(tick('stop').phase).toBe('reverse_first');
  expect(h.publish).toHaveBeenLastCalledWith('source', { dock_measurement_control: { action: 'stop', motion_id: expect.any(String) } });
  release({ result: 0, protocol: 'dock-measurement-motion-v4', start_pose: LEFT_FROM }); await advance();
  expect(tick('stop').phase).toBe('error'); expect(h.capture).not.toHaveBeenCalled();
});

it.each(['legacy', 'timeout', 'no-contact'])('does not report success for %s firmware output', async mode => {
  const good = h.command.getMockImplementation()!;
  h.command.mockImplementation(async (cmd, params) => {
    const result = await good(cmd, params);
    if (mode === 'legacy') return { result: 0 };
    if (cmd === 'dock_measurement_move' && params.action === 'dock') return mode === 'timeout' ? null : { ...result, docked: false };
    return result;
  });
  start(); tick(); await advance(); expect(tick('stop').phase).toBe('error');
});

it('does not duplicate an active start or accept controls from a different mower pair', async () => {
  start(); expect(start().cycleId).toBe(id);
  expect(() => startSourceDockCycle(crypto.randomUUID(), 'target2', 'source', 'map0')).toThrow('already running');
  expect(() => sourceDockCycle(id, 'target2', 'source', 'pulse')).toThrow('Unknown');
  tick('stop'); await advance(); expect(h.command).not.toHaveBeenCalled();
});


it('refuses departure without charging contact', async () => {
  h.docked = false;
  start(); tick(); await advance();
  expect(tick('stop').phase).toBe('error'); expect(h.command).not.toHaveBeenCalled();
});

it('allows a docked departure before RTK Fixed, but still requires running localization', async () => {
  h.fixed = false;
  start(); tick(); await advance();
  expect(h.command.mock.calls.some(([cmd, params]) => cmd === 'dock_measurement_move' && params.action === 'reverse')).toBe(true);
  tick('stop'); await advance(300);
  h.running = false;
  const next = crypto.randomUUID();
  id = next; start(); tick(); await advance();
  expect(tick('stop').phase).toBe('error');
});

it('checks saved dock accuracy only after departure has initialized heading and the mower returned', async () => {
  h.poseX = .15;
  h.measureDock.mockImplementation(async () => {
    expect(h.command.mock.calls.filter(([cmd]) => cmd === 'dock_measurement_move')).toHaveLength(3);
    expect(h.docked).toBe(true);
    return { dist: 0, latestDist: 0, runtime: { x: 0, y: 0, capture_started: Date.now() } };
  });
  start(); tick(); await advance();
  expect(tick().phase).toBe('done');
  expect(h.measureDock).toHaveBeenCalledTimes(1);
});

it('discards both captures if the final file or dock check fails', async () => {
  h.measureDock.mockRejectedValueOnce(new Error('map files changed'));
  start(); tick(); await advance();
  expect(tick('stop')).toMatchObject({ phase: 'error', error: 'map files changed' });
  expect(tick('stop').alignment).toBeUndefined();
  expect(h.consume).toHaveBeenCalledWith('alignment');
});

it('surfaces a failed native cancellation instead of hiding it behind the operator Stop label', async () => {
  let release!: (value: unknown) => void;
  h.command.mockImplementation(async cmd => cmd === 'dock_measurement_control' ? { result: 0, protocol: 'dock-measurement-motion-v4' } : new Promise(resolve => { release = resolve; }));
  start(); tick(); await advance(); tick('stop');
  release({ result: 1, error: 'visual docking cancellation not confirmed; use the mower STOP button' });
  await advance();
  expect(tick('stop')).toMatchObject({ phase: 'error', error: "The mower did not confirm that it stopped. Press the mower's STOP button to be safe." });
});
