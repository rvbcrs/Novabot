import { isDeviceOnline } from '../mqtt/broker.js';
import { publishToExtended } from '../mqtt/mapSync.js';
import { getFrameRevision, isFrameUnvalidated } from './frameValidation.js';
import { freshPositionState } from './positionTelemetry.js';
import { snapshotDockPose } from './dockPhotoReference.js';
import { readMowerMapSnapshot, withMowerMapOperation } from './mowerMapOperation.js';
import { beginCopyAlignment, captureCopyAlignment, consumeCopyAlignment, frameSnapshotSignature, getCopyAlignment, type CopyAlignmentView } from './copyAlignment.js';
import { disarmEdgeWatch } from './scheduleRunner.js';
import { errorText } from './serverText.js';
import { guardedDockMove, rememberDockedPose, returnChargePose, settleDockMotion, DockMotionError, type DockPose } from './dockMotion.js';
import { measureReanchorDock } from './reanchorGps.js';

export type SourceDockPhase = 'starting' | 'checking' | 'reverse_first' | 'measure_first' | 'reverse_second' | 'measure_second' | 'docking' | 'verifying' | 'done' | 'error';
export interface SourceDockCycleView {
  cycleId: string; sourceSn: string; targetSn: string; canonical: string;
  phase: SourceDockPhase; error?: string; alignment?: CopyAlignmentView;
}
type Cycle = SourceDockCycleView & { operatorAt: number; createdAt: number; cancelled: boolean; motionId?: string; alignmentId?: string; finished: boolean };
const cycles = new Map<string, Cycle>();
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const view = (c: Cycle): SourceDockCycleView => ({ cycleId: c.cycleId, sourceSn: c.sourceSn, targetSn: c.targetSn, canonical: c.canonical,
  phase: c.phase, ...(c.error ? { error: c.error } : {}), ...(c.alignment ? { alignment: c.alignment } : {}) });

function control(c: Cycle, action: 'keepalive' | 'stop'): void {
  if (c.motionId) publishToExtended(c.sourceSn, { dock_measurement_control: { motion_id: c.motionId, action } });
}
function cancel(c: Cycle, reason: string): void {
  if (c.finished) return;
  c.cancelled = true;
  c.error ??= reason;
  control(c, 'stop');
}
function check(c: Cycle): void {
  if (c.cancelled) throw new Error(c.error ?? 'Measurement cycle stopped.');
  if (performance.now() - c.operatorAt > 5_000 || performance.now() - c.createdAt > 300_000 || !isDeviceOnline(c.sourceSn) || isFrameUnvalidated(c.sourceSn)) {
    cancel(c, 'Measurement cycle stopped: operator connection, mower connection or validated frame was lost.');
    throw new Error(c.error);
  }
}

/** Client chooses the id before starting so even a lost start response remains cancellable. */
export function startSourceDockCycle(cycleId: string, targetSn: string, sourceSn: string, canonical: string): SourceDockCycleView {
  if (!/^[0-9a-f-]{36}$/i.test(cycleId) || !/^map[0-4]$/.test(canonical) || !sourceSn || sourceSn === targetSn) throw new Error('Invalid source measurement request.');
  for (const [id, c] of cycles) if (c.finished && performance.now() - c.createdAt > 30 * 60_000) cycles.delete(id);
  const existing = cycles.get(cycleId);
  if (existing) {
    if (existing.targetSn !== targetSn || existing.sourceSn !== sourceSn || existing.canonical !== canonical) throw new Error('Cycle belongs to another copy.');
    return view(existing);
  }
  if ([...cycles.values()].some(c => !c.finished && c.sourceSn === sourceSn)) throw new Error('A source measurement is already running for this mower.');
  const c: Cycle = { cycleId, targetSn, sourceSn, canonical, phase: 'starting', operatorAt: -Infinity, createdAt: performance.now(), cancelled: false, finished: false };
  cycles.set(cycleId, c);
  void run(c);
  return view(c);
}

export function sourceDockCycle(cycleId: string, targetSn: string, sourceSn: string, action: 'pulse' | 'stop'): SourceDockCycleView {
  const c = cycles.get(cycleId);
  if (!c || c.targetSn !== targetSn || c.sourceSn !== sourceSn) throw new Error('Unknown source measurement cycle.');
  if (action === 'stop') cancel(c, 'Measurement cycle stopped by the operator.');
  else if (!c.finished && !c.cancelled) {
    if (!Number.isFinite(c.operatorAt) && performance.now() - c.createdAt >= 5_000) cancel(c, 'Start confirmation expired.');
    if (Number.isFinite(c.operatorAt)) check(c); // An expired browser lease cannot be revived.
    c.operatorAt = performance.now();
  }
  return view(c);
}

async function run(c: Cycle): Promise<void> {
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    // A lost HTTP start response must never cause an unattended departure.
    while (!Number.isFinite(c.operatorAt) && !c.cancelled && performance.now() - c.createdAt < 5_000) await sleep(100);
    check(c);
    c.phase = 'checking';
    const alignment = await beginCopyAlignment(c.targetSn, c.sourceSn, c.canonical);
    c.alignmentId = alignment.alignmentId;
    check(c);
    await withMowerMapOperation(c.sourceSn, async operation => {
      operation.onManualControl = () => cancel(c, 'Measurement cycle stopped by manual control.');
      timer = setInterval(() => {
        try { check(c); } catch { /* check latches cancellation; no later step may run */ }
      }, 500);
      const before = await readMowerMapSnapshot(c.sourceSn, operation);
      if (!before) throw new Error('Source mower files could not be read.');
      const signature = frameSnapshotSignature(before);
      const dock = snapshotDockPose(before)!;
      const start = freshPositionState(c.sourceSn);
      // Leaving the dock initializes heading. Contact and stable telemetry
      // qualify departure; saved-dock accuracy is checked after returning.
      if (!start.docked || !start.running || !start.pose) throw new Error('Start stationary on the source mower’s own dock with fresh charging contact and localization.');
      check(c);
      disarmEdgeWatch(c.sourceSn, 'automatic source dock measurement');
      const move = (action: 'reverse' | 'dock', distance: number, fromDock: boolean, chargePose?: DockPose) =>
        guardedDockMove(c.sourceSn, operation, { action, distance, fromDock, signature, ...(chargePose ? { chargePose } : {}) }, () => check(c), id => { c.motionId = id; });
      const settled = (docked = false) => settleDockMotion(c.sourceSn, docked, () => check(c));
      // 1 m (plus the 0.2 m step) keeps the return inside the window where the
      // native docker starts its visual approach directly: 0.87..1.47 m.
      c.phase = 'reverse_first'; const departure = await move('reverse', 1, true);
      const dockPose = returnChargePose(departure.startPose!, dock.orientation);
      rememberDockedPose(c.sourceSn, dockPose, getFrameRevision(c.sourceSn));
      c.phase = 'measure_first'; await settled(); check(c);
      await captureCopyAlignment(c.alignmentId!, 'source', operation); check(c);
      c.phase = 'reverse_second'; await move('reverse', .2, false);
      c.phase = 'measure_second'; await settled(); check(c);
      await captureCopyAlignment(c.alignmentId!, 'source', operation); check(c);
      c.phase = 'docking'; await move('dock', 0, false, dockPose);
      c.phase = 'verifying';
      const final = await settled(true);
      if (Math.hypot(final.x - dock.x, final.y - dock.y) > .05) throw new Error('Dock contact confirmed, but localization differs more than 5 cm from the saved dock.');
      const confirmed = await measureReanchorDock(c.sourceSn, operation, before);
      check(c);
      c.alignment = getCopyAlignment(c.alignmentId!, c.targetSn, c.sourceSn, c.canonical);
      if (confirmed.dist > .05 || confirmed.latestDist > .05 ||
          c.alignment.captures.source.some(m => confirmed.runtime.capture_started <= m.capture_finished ||
            Math.hypot(confirmed.runtime.x - m.runtime_frame.x, confirmed.runtime.y - m.runtime_frame.y) > .02)) {
        throw new Error('Source localization changed after returning to the dock. Start fresh measurements.');
      }
      c.phase = 'done';
    });
  } catch (error) {
    // This cycle speaks English; a TextError (dockMotion.ts) is rendered so.
    const text = errorText('en', error);
    if (error instanceof DockMotionError) c.error = text;
    cancel(c, text);
    c.phase = 'error';
    c.alignment = undefined;
    if (c.alignmentId) consumeCopyAlignment(c.alignmentId);
  } finally {
    clearInterval(timer);
    control(c, 'stop');
    c.finished = true;
  }
}
