import { createHash, randomUUID } from 'node:crypto';
import { isDeviceOnline } from '../mqtt/broker.js';
import { isOpenNovaMower } from './mowerFileCapability.js';
import { getFrameRevision, isFrameUnvalidated } from './frameValidation.js';
import { stablePosition } from './positionTelemetry.js';
import { snapshotDockPose } from './dockPhotoReference.js';
import { assertMowerMapOperation, readMowerMapSnapshot, withMowerMapOperation, type MowerMapOperation } from './mowerMapOperation.js';

type Snapshot = Record<string, unknown> | null;
type Pose = { x: number; y: number; z: number; yaw: number };
export type CopyAlignmentSide = 'source' | 'target';
export type CopyAlignmentPhase = 'source_first' | 'source_second' | 'target_first' | 'target_second' | 'ready';
export interface RuntimeFrameObservation {
  x: number;
  y: number;
  spread_m: number;
  sample_count: number;
  unique_stamps: number;
  max_pair_dt_s: number;
  capture_started: number;
  capture_finished: number;
}
export interface MarkerObservation {
  marker: Pose;
  base: Pose;
  sample_count: number;
  unique_stamps: number;
  spread_m: number;
  yaw_spread_rad: number;
  max_pair_dt_s: number;
  capture_started: number;
  capture_finished: number;
  runtime_frame: RuntimeFrameObservation;
}
export interface CopyAlignmentView {
  alignmentId: string;
  sourceSn: string;
  targetSn: string;
  canonical: string;
  phase: CopyAlignmentPhase;
  expiresAt: number;
  captures: Record<CopyAlignmentSide, MarkerObservation[]>;
  dockAtB?: { x: number; y: number };
}
type Frame = { signature: string; revision: number; zone: number };
type Session = CopyAlignmentView & {
  frames: Record<CopyAlignmentSide, Frame>;
  sourceGeometry: string;
  sourceDock: { x: number; y: number };
  lastCaptureFinished: Partial<Record<CopyAlignmentSide, number>>;
};

const sessions = new Map<string, Session>();
const TTL_MS = 20 * 60_000;
const DEGREE = Math.PI / 180;
const RUNTIME_TOLERANCE_M = 0.02;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const angleDifference = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const fail = (message: string): never => { throw new Error(message); };

/** Same seven BE-double hex strings as the mower; JSON number formatting must not affect identity. */
export function frameSnapshotSignature(snapshot: Snapshot): string {
  const dock = snapshotDockPose(snapshot);
  let origin: Record<string, unknown>;
  try { origin = record(JSON.parse(String(snapshot?.pos_json)).utm_origin); }
  catch { return fail('The mower origin is missing or invalid.'); }
  const zone = origin.utm_zone;
  if (!dock || ![origin.x, origin.y, origin.z, zone].every(finite) || !Number.isInteger(zone) || Number(zone) < 1 || Number(zone) > 60) {
    return fail('The mower origin or saved dock is not confirmed.');
  }
  const hex = (value: unknown) => { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(Number(value)); return bytes.toString('hex'); };
  return digest({ origin: [origin.x, origin.y, origin.z, zone].map(hex), dock: [dock.x, dock.y, dock.orientation].map(hex) });
}

function sourceGeometry(snapshot: Snapshot, canonical: string): string {
  const csv = record(snapshot?.csv_files);
  const names = Object.keys(csv).filter(n => n === `${canonical}_work.csv` || new RegExp(`^${canonical}_\\d+_obstacle\\.csv$`).test(n)).sort();
  if (!names.includes(`${canonical}_work.csv`) || names.some(n => typeof csv[n] !== 'string')) return fail('The source zone is missing or invalid.');
  return digest(names.map(n => [n, csv[n]]));
}

function ready(sn: string): void {
  if (!isDeviceOnline(sn) || !isOpenNovaMower(sn) || isFrameUnvalidated(sn)) fail('Both mowers must be online with a validated OpenNova map frame.');
}

function phase(s: Session): CopyAlignmentPhase {
  return s.captures.source.length < 2 ? (s.captures.source.length ? 'source_second' : 'source_first')
    : s.captures.target.length < 2 ? (s.captures.target.length ? 'target_second' : 'target_first') : 'ready';
}

function view(s: Session): CopyAlignmentView {
  const { alignmentId, sourceSn, targetSn, canonical, expiresAt, captures } = s;
  const result: CopyAlignmentView = { alignmentId, sourceSn, targetSn, canonical, expiresAt, phase: phase(s), captures: structuredClone(captures) };
  if (result.phase === 'ready') {
    const mean = (side: CopyAlignmentSide, axis: 'x' | 'y') => s.captures[side].reduce((sum, c) => sum + c.marker[axis], 0) / 2;
    result.dockAtB = { x: s.sourceDock.x + mean('target', 'x') - mean('source', 'x'), y: s.sourceDock.y + mean('target', 'y') - mean('source', 'y') };
  }
  return result;
}

function session(id: string): Session {
  const s = sessions.get(id);
  if (!s || Date.now() >= s.expiresAt) { sessions.delete(id); return fail('The alignment has expired or is unknown. Start the dock measurements again.'); }
  for (const side of ['source', 'target'] as const) {
    const sn = side === 'source' ? s.sourceSn : s.targetSn;
    ready(sn);
    if (getFrameRevision(sn) !== s.frames[side].revision) return fail('A mower frame changed. Start the dock measurements again.');
  }
  return s;
}

function matches(s: Session, side: CopyAlignmentSide, snapshot: Snapshot): void {
  if (frameSnapshotSignature(snapshot) !== s.frames[side].signature ||
    (side === 'source' && sourceGeometry(snapshot, s.canonical) !== s.sourceGeometry)) fail('The source zone or mower frame changed. Start the dock measurements again.');
}

/** An active wizard only: expiry/server restart require a new physical visit. No map or DB writes. */
export async function beginCopyAlignment(targetSn: string, sourceSn: string, canonical: string): Promise<CopyAlignmentView> {
  if (typeof sourceSn !== 'string' || !sourceSn || typeof targetSn !== 'string' || !targetSn || sourceSn === targetSn ||
    typeof canonical !== 'string' || !/^map[0-4]$/.test(canonical)) return fail('Choose a different source mower and a valid source zone.');
  ready(sourceSn); ready(targetSn);
  for (const [id, s] of sessions) if (Date.now() >= s.expiresAt) sessions.delete(id);
  const captureFrame = (sn: string) => withMowerMapOperation(sn, async operation => {
    const revision = getFrameRevision(sn);
    const snapshot = await readMowerMapSnapshot(sn, operation);
    ready(sn);
    if (revision !== getFrameRevision(sn)) return fail('A mower frame changed while reading its files.');
    const signature = frameSnapshotSignature(snapshot);
    return { snapshot, frame: { signature, revision, zone: Number(JSON.parse(String(snapshot!.pos_json)).utm_origin.utm_zone) } };
  });
  const source = await captureFrame(sourceSn), target = await captureFrame(targetSn);
  if (source.frame.zone !== target.frame.zone) return fail('The mowers use different UTM zones. A translation-only alignment cannot be used.');
  const s: Session = {
    alignmentId: randomUUID(), sourceSn, targetSn, canonical, expiresAt: Date.now() + TTL_MS,
    phase: 'source_first', captures: { source: [], target: [] }, frames: { source: source.frame, target: target.frame },
    sourceGeometry: sourceGeometry(source.snapshot, canonical), sourceDock: snapshotDockPose(source.snapshot)!, lastCaptureFinished: {},
  };
  sessions.set(s.alignmentId, s);
  return getCopyAlignment(s.alignmentId, targetSn, sourceSn, canonical);
}

export function getCopyAlignment(alignmentId: string, targetSn: string, sourceSn: string, canonical: string): CopyAlignmentView {
  const s = session(alignmentId);
  if (s.targetSn !== targetSn || s.sourceSn !== sourceSn || s.canonical !== canonical) return fail('The alignment belongs to a different mower pair or zone.');
  return view(s);
}

/** Consume only after native install, runtime verification and the server commit succeed. */
export function consumeCopyAlignment(alignmentId: string): void { sessions.delete(alignmentId); }

export function freshCapture(frame: { capture_started: number; capture_finished: number }, startedAt: number, maximumSpan: number, label: string,
  maximumOutside = 10): void {
  const span = frame.capture_finished - frame.capture_started;
  const elapsed = (performance.now() - startedAt) / 1000;
  // The command UUID binds a newly collected window to this request. Mower and
  // server wall clocks need not agree. All time outside the observed window is
  // conservatively counted as age, including startup, transport and later awaits.
  if (span < 5 || span > maximumSpan || span > elapsed + .75 || elapsed - span > maximumOutside) {
    fail(`The ${label} measurement is stale.`);
  }
}

function newCapture(s: Session, side: CopyAlignmentSide, started: number): void {
  const previous = s.lastCaptureFinished[side];
  if (previous !== undefined && started <= previous) fail('The measurement is stale or repeats an earlier mower capture. Start the dock measurements again.');
}

/** `maximumOutside`: seconds of the request allowed outside the window (see freshCapture). */
export function runtimeObservation(value: unknown, startedAt: number, maximumOutside?: number): RuntimeFrameObservation {
  const raw = record(value);
  const fields = ['x', 'y', 'spread_m', 'sample_count', 'unique_stamps', 'max_pair_dt_s', 'capture_started', 'capture_finished'] as const;
  if (fields.some(k => !finite(raw[k]))) return fail('The runtime frame measurement is incomplete.');
  const frame = Object.fromEntries(fields.map(k => [k, raw[k]])) as unknown as RuntimeFrameObservation;
  if (!Number.isInteger(frame.sample_count) || !Number.isInteger(frame.unique_stamps) ||
      frame.unique_stamps < 20 || frame.sample_count < frame.unique_stamps || frame.max_pair_dt_s !== 0 ||
      frame.spread_m < 0 || frame.spread_m > RUNTIME_TOLERANCE_M) {
    return fail('The runtime frame measurement is not stable or exactly synchronized.');
  }
  freshCapture(frame, startedAt, 15, 'runtime frame', maximumOutside);
  return frame;
}

function matchesRuntime(s: Session, side: CopyAlignmentSide, frame: RuntimeFrameObservation): void {
  if (s.captures[side].some(c => Math.hypot(frame.x - c.runtime_frame.x, frame.y - c.runtime_frame.y) > RUNTIME_TOLERANCE_M)) {
    sessions.delete(s.alignmentId);
    fail('The effective runtime mower frame changed. Start the dock measurements again.');
  }
}

export function settledRuntime(frame: RuntimeFrameObservation): void {
  // In the verified native gps_link path the normal XY position is UTM minus
  // origin. A stable temporary compensation is not eligible for registration:
  // it can disappear on a later drive. Near zero does not prove ground accuracy.
  if (Math.hypot(frame.x, frame.y) > RUNTIME_TOLERANCE_M) {
    fail('Localization still differs from the native GPS frame. Let localization settle before starting new dock measurements.');
  }
}

function observation(raw: Record<string, unknown> | null, signature: string, startedAt: number): MarkerObservation {
  if (raw?.result !== 0 && typeof raw?.error === 'string') return fail(`Marker measurement failed: ${raw.error.slice(0, 300)}`);
  if (raw?.result !== 0 || raw.protocol !== 'aruco-map-marker-v1') return fail('This mower did not return a verified ArUco marker measurement.');
  if (raw.frame_fingerprint !== signature) return fail('The marker measurement used a different mower frame.');
  const marker = record(raw.marker), base = record(raw.base);
  const numbers = ['sample_count', 'unique_stamps', 'spread_m', 'yaw_spread_rad', 'max_pair_dt_s', 'capture_started', 'capture_finished'] as const;
  if (['x', 'y', 'z', 'yaw'].some(k => !finite(marker[k]) || !finite(base[k])) || numbers.some(k => !finite(raw[k]))) return fail('The marker measurement is incomplete.');
  const o = { marker: { ...marker }, base: { ...base }, ...Object.fromEntries(numbers.map(k => [k, raw[k]])) } as unknown as MarkerObservation;
  if (!Number.isInteger(o.sample_count) || !Number.isInteger(o.unique_stamps) || o.unique_stamps < 20 || o.sample_count < o.unique_stamps ||
    o.spread_m < 0 || o.spread_m > 0.03 || o.yaw_spread_rad < 0 || o.yaw_spread_rad > 2 * DEGREE || o.max_pair_dt_s < 0 || o.max_pair_dt_s > 0.12) {
    return fail('The marker measurement is not stable or synchronized enough.');
  }
  freshCapture(o, startedAt, 20, 'marker');
  if (Math.hypot(o.marker.x - o.base.x, o.marker.y - o.base.y) > 1.5) return fail('Move closer to the source dock marker before measuring.');
  o.runtime_frame = runtimeObservation(raw.runtime_frame, startedAt);
  if (o.runtime_frame.capture_started < o.capture_started || o.runtime_frame.capture_finished > o.capture_finished) {
    return fail('The runtime frame measurement is stale or outside the marker window.');
  }
  return o;
}

/** Observation only; callers may hold the lease across supervised source movements. */
export async function captureCopyAlignment(alignmentId: string, side: CopyAlignmentSide, owner?: MowerMapOperation): Promise<CopyAlignmentView> {
  const s = session(alignmentId);
  const expectedPhase = phase(s);
  if ((side !== 'source' && side !== 'target') || !expectedPhase.startsWith(side)) return fail('Complete the dock measurements in the shown order.');
  const sn = side === 'source' ? s.sourceSn : s.targetSn;
  const capture = async (operation: MowerMapOperation) => {
    assertMowerMapOperation(sn, operation);
    if (!stablePosition(sn)) return fail('Stop the mower and wait for stable RTK Fixed localization before measuring.');
    matches(s, side, await readMowerMapSnapshot(sn, operation));
    const startedAt = performance.now();
    const raw = await operation.command('measure_dock_marker', {}, 50_000);
    const measured = observation(raw, s.frames[side].signature, startedAt);
    // Freshness is about the measurement, before the multi-MB snapshot read.
    freshCapture(measured, startedAt, 20, 'marker');
    freshCapture(measured.runtime_frame, startedAt, 15, 'runtime frame');
    matches(s, side, await readMowerMapSnapshot(sn, operation));
    session(alignmentId);
    if (phase(s) !== expectedPhase) return fail('Another capture completed this step. Refresh the alignment wizard.');
    if (!stablePosition(sn)) return fail('Localization changed during the marker measurement.');
    newCapture(s, side, measured.capture_started);
    matchesRuntime(s, side, measured.runtime_frame);
    settledRuntime(measured.runtime_frame);
    const previous = s.captures[side][0];
    if (previous) {
      if (Math.hypot(measured.base.x - previous.base.x, measured.base.y - previous.base.y) < 0.15) return fail('Move at least 15 cm to a second viewpoint before measuring again.');
      if (Math.hypot(measured.marker.x - previous.marker.x, measured.marker.y - previous.marker.y, measured.marker.z - previous.marker.z) > 0.03 ||
        angleDifference(measured.marker.yaw, previous.marker.yaw) > DEGREE) return fail('The repeated marker measurements disagree. Start the dock measurements again.');
    }
    // This rejects gross inconsistency; noisy marker yaw cannot certify centimetre alignment across a garden.
    if (side === 'target' && s.captures.source.some(c => angleDifference(c.marker.yaw, measured.marker.yaw) > DEGREE)) {
      return fail('The marker headings disagree between mowers. Translation alone is not confirmed.');
    }
    s.captures[side].push(measured);
    s.lastCaptureFinished[side] = measured.capture_finished;
    return view(s);
  };
  return owner ? capture(owner) : withMowerMapOperation(sn, capture);
}

/** Both leases remain held through fresh observations, device install and the caller's commit. */
/** A pointed source dock has no marker session to re-verify; the installer still compares a fresh read of the target. */
export function pointedDockVerifier(targetSn: string, operation: MowerMapOperation) {
  return async () => ({ verifyRuntime: async (): Promise<Record<string, unknown>> => {
    const current = await readMowerMapSnapshot(targetSn, operation);
    if (!current || current.result !== 0) throw new Error('The final check could not read the mower map files.');
    return current;
  } });
}

export async function validateCopyAlignment(alignmentId: string, input: {
  targetSn: string; sourceSn: string; canonical: string; sourceSnapshot: Snapshot; targetSnapshot: Snapshot;
  sourceOperation: MowerMapOperation; targetOperation: MowerMapOperation;
}): Promise<CopyAlignmentView & { dockAtB: { x: number; y: number }; verifyRuntime: () => Promise<Record<string, unknown>> }> {
  getCopyAlignment(alignmentId, input.targetSn, input.sourceSn, input.canonical);
  const s = session(alignmentId);
  if (phase(s) !== 'ready') return fail('Measure the source dock twice with each mower before copying.');
  matches(s, 'source', input.sourceSnapshot); matches(s, 'target', input.targetSnapshot);
  const operations = { source: input.sourceOperation, target: input.targetOperation };
  // The copy ZIP was prepared from these exact bytes. Retain them independently
  // of the caller's objects while both runtime observations are in flight.
  const targetBefore = { pos_json: input.targetSnapshot?.pos_json, charging_station_yaml: input.targetSnapshot?.charging_station_yaml,
    csv_files: { ...record(input.targetSnapshot?.csv_files) }, x3_csv_files: { ...record(input.targetSnapshot?.x3_csv_files) } };

  function assertOwnedSession(): void {
    assertMowerMapOperation(s.sourceSn, operations.source);
    assertMowerMapOperation(s.targetSn, operations.target);
    if (sessions.get(alignmentId) !== s || Date.now() >= s.expiresAt) {
      sessions.delete(alignmentId);
      fail('The alignment has expired or is unknown. Start the dock measurements again.');
    }
  }

  async function verifyLive(assertCurrent: () => void): Promise<Record<string, unknown>> {
    assertCurrent();
    // Measure both mowers concurrently. Wait for both even on failure, so no
    // command can outlive its map-operation lease when the caller unwinds.
    const results = await Promise.allSettled((['source', 'target'] as const).map(async side => {
      const sn = side === 'source' ? s.sourceSn : s.targetSn;
      const startedAt = performance.now();
      const raw = await operations[side].command('measure_runtime_frame', {}, 25_000);
      assertCurrent();
      if (raw?.result !== 0 && typeof raw?.error === 'string') return fail(`Runtime frame measurement failed: ${raw.error.slice(0, 300)}`);
      if (raw?.result !== 0 || raw.protocol !== 'runtime-map-frame-v1') return fail('This mower did not return a verified runtime frame measurement.');
      if (raw.frame_fingerprint !== s.frames[side].signature) return fail('The runtime measurement used a different mower frame.');
      const frame = runtimeObservation(raw.runtime_frame, startedAt);
      return { side, frame, startedAt };
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    assertCurrent();
    // Native file writes are not all under our server lease. Read both again
    // after both measurements, including complete source work/obstacle identity.
    const snapshots = await Promise.allSettled(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []).map(async value => ({
      ...value,
      snapshot: await readMowerMapSnapshot(value.side === 'source' ? s.sourceSn : s.targetSn, operations[value.side]),
    })));
    for (const result of snapshots) if (result.status === 'rejected') throw result.reason;
    assertCurrent();
    let targetSnapshot: Snapshot = null;
    for (const result of snapshots) if (result.status === 'fulfilled') {
      const { side, frame, snapshot, startedAt } = result.value;
      runtimeObservation(frame, startedAt); // Both remain fresh after all awaits.
      newCapture(s, side, frame.capture_started);
      matches(s, side, snapshot);
      matchesRuntime(s, side, frame);
      settledRuntime(frame);
      if (side === 'target') targetSnapshot = snapshot;
    }
    if (!targetSnapshot) return fail('The verified target map snapshot is missing.');
    for (const result of snapshots) if (result.status === 'fulfilled') {
      s.lastCaptureFinished[result.value.side] = result.value.frame.capture_finished;
    }
    return targetSnapshot;
  }

  const targetCurrent = await verifyLive(() => { assertOwnedSession(); session(alignmentId); });
  if (targetCurrent.pos_json !== targetBefore.pos_json || targetCurrent.charging_station_yaml !== targetBefore.charging_station_yaml ||
      (['csv_files', 'x3_csv_files'] as const).some(key => {
        const expected = targetBefore[key], actual = record(targetCurrent[key]);
        const names = Object.keys(expected);
        return !names.length || names.length !== Object.keys(actual).length ||
          names.some(name => typeof expected[name] !== 'string' || actual[name] !== expected[name]);
      })) return fail('The target map files changed during preflight. Read the mower maps again before copying.');
  const verifyRuntime = async (): Promise<Record<string, unknown>> => {
    return verifyLive(() => {
      assertOwnedSession();
      ready(s.sourceSn);
      if (getFrameRevision(s.sourceSn) !== s.frames.source.revision ||
          !isDeviceOnline(s.targetSn) || !isOpenNovaMower(s.targetSn) || !isFrameUnvalidated(s.targetSn) ||
          getFrameRevision(s.targetSn) !== s.frames.target.revision + 1) {
        fail('The mower frame changed outside the expected map installation.');
      }
    });
  };
  return { ...(view(s) as CopyAlignmentView & { dockAtB: { x: number; y: number } }), verifyRuntime };
}
