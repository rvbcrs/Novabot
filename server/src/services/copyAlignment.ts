import { createHash, randomUUID } from 'node:crypto';
import { isDeviceOnline } from '../mqtt/broker.js';
import { isOpenNovaMower } from './mowerFileCapability.js';
import { getFrameRevision, isFrameUnvalidated } from './frameValidation.js';
import { stablePosition } from './positionTelemetry.js';
import { snapshotDockPose } from './dockPhotoReference.js';
import { readMowerMapSnapshot, withMowerMapOperation } from './mowerMapOperation.js';

type Snapshot = Record<string, unknown> | null;
type Pose = { x: number; y: number; z: number; yaw: number };
export type CopyAlignmentSide = 'source' | 'target';
export type CopyAlignmentPhase = 'source_first' | 'source_second' | 'target_first' | 'target_second' | 'ready';
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
};

const sessions = new Map<string, Session>();
const TTL_MS = 20 * 60_000;
const DEGREE = Math.PI / 180;
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
    sourceGeometry: sourceGeometry(source.snapshot, canonical), sourceDock: snapshotDockPose(source.snapshot)!,
  };
  sessions.set(s.alignmentId, s);
  return getCopyAlignment(s.alignmentId, targetSn, sourceSn, canonical);
}

export function getCopyAlignment(alignmentId: string, targetSn: string, sourceSn: string, canonical: string): CopyAlignmentView {
  const s = session(alignmentId);
  if (s.targetSn !== targetSn || s.sourceSn !== sourceSn || s.canonical !== canonical) return fail('The alignment belongs to a different mower pair or zone.');
  return view(s);
}

/** A successful copy consumes its physical visit; retries use the existing map-apply route. */
export function consumeCopyAlignment(alignmentId: string): void { sessions.delete(alignmentId); }

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
  // Receiver stamps must cover this command, not a cached camera window.
  if (o.capture_started < startedAt / 1000 - 0.75 || o.capture_finished > Date.now() / 1000 + 1 ||
    o.capture_finished - o.capture_started < 5 || o.capture_finished - o.capture_started > 20 || Date.now() / 1000 - o.capture_finished > 10) {
    return fail('The marker measurement is stale or its receiver clock is not synchronized.');
  }
  if (Math.hypot(o.marker.x - o.base.x, o.marker.y - o.base.y) > 1.5) return fail('Move closer to the source dock marker before measuring.');
  return o;
}

/** Each command observes only; the user drives between the four captures. */
export async function captureCopyAlignment(alignmentId: string, side: CopyAlignmentSide): Promise<CopyAlignmentView> {
  const s = session(alignmentId);
  const expectedPhase = phase(s);
  if ((side !== 'source' && side !== 'target') || !expectedPhase.startsWith(side)) return fail('Complete the dock measurements in the shown order.');
  const sn = side === 'source' ? s.sourceSn : s.targetSn;
  return withMowerMapOperation(sn, async operation => {
    if (!stablePosition(sn)) return fail('Stop the mower and wait for stable RTK Fixed localization before measuring.');
    matches(s, side, await readMowerMapSnapshot(sn, operation));
    const startedAt = Date.now();
    const raw = await operation.command('measure_dock_marker', {}, 35_000);
    const measured = observation(raw, s.frames[side].signature, startedAt);
    matches(s, side, await readMowerMapSnapshot(sn, operation));
    session(alignmentId);
    if (phase(s) !== expectedPhase) return fail('Another capture completed this step. Refresh the alignment wizard.');
    if (!stablePosition(sn)) return fail('Localization changed during the marker measurement.');
    const previous = s.captures[side][0];
    if (previous) {
      if (measured.capture_started <= previous.capture_finished) return fail('A repeated capture must contain new camera frames.');
      if (Math.hypot(measured.base.x - previous.base.x, measured.base.y - previous.base.y) < 0.15) return fail('Move at least 15 cm to a second viewpoint before measuring again.');
      if (Math.hypot(measured.marker.x - previous.marker.x, measured.marker.y - previous.marker.y, measured.marker.z - previous.marker.z) > 0.03 ||
        angleDifference(measured.marker.yaw, previous.marker.yaw) > DEGREE) return fail('The repeated marker measurements disagree. Start the dock measurements again.');
    }
    // This rejects gross inconsistency; noisy marker yaw cannot certify centimetre alignment across a garden.
    if (side === 'target' && s.captures.source.some(c => angleDifference(c.marker.yaw, measured.marker.yaw) > DEGREE)) {
      return fail('The marker headings disagree between mowers. Translation alone is not confirmed.');
    }
    s.captures[side].push(measured);
    return view(s);
  });
}

/** Caller holds both leases. File identity cannot detect a later internal localization-compensation change. */
export function validateCopyAlignment(alignmentId: string, input: {
  targetSn: string; sourceSn: string; canonical: string; sourceSnapshot: Snapshot; targetSnapshot: Snapshot;
}): CopyAlignmentView & { dockAtB: { x: number; y: number } } {
  getCopyAlignment(alignmentId, input.targetSn, input.sourceSn, input.canonical);
  const s = session(alignmentId);
  if (phase(s) !== 'ready') return fail('Measure the source dock twice with each mower before copying.');
  matches(s, 'source', input.sourceSnapshot); matches(s, 'target', input.targetSnapshot);
  return view(s) as CopyAlignmentView & { dockAtB: { x: number; y: number } };
}
