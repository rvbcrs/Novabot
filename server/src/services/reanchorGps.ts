import { isDeepStrictEqual } from 'node:util';
import { isDeviceOnline } from '../mqtt/broker.js';
import { frameSnapshotSignature, freshCapture, runtimeObservation, settledRuntime } from './copyAlignment.js';
import { snapshotDockPose } from './dockPhotoReference.js';
import { readMowerMapSnapshot, type MowerMapOperation } from './mowerMapOperation.js';
import { freshPositionState } from './positionTelemetry.js';
import { M, TextError } from './serverText.js';

export const REANCHOR_TOLERANCE_M = .05;
// Before its window the mower waits up to ~5 s for health and starts ROS; the
// zone copy's 10 s outside the window stopped healthy re-anchors as stale
// (GH #158). A docked, stationary measurement that replies within this command
// timeout is accepted; the checks after the reply confirm it still holds.
const MEASURE_TIMEOUT_MS = 30_000;
export type Origin = { x: number; y: number; z: number; utm_zone: number };
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** A reanchor may change pos.json only, never quietly change the ground map. */
export function assertReanchorFiles(before: Record<string, unknown>, after: Record<string, unknown> | null): asserts after is Record<string, unknown> {
  if (!after || after.result !== 0 || after.snapshot_consistent !== true ||
      ['charging_station_yaml', 'csv_files', 'x3_csv_files', 'map_files_b64', 'map_files_text'].some(k =>
        before[k] === undefined || !isDeepStrictEqual(before[k], after[k]))) {
    throw new TextError(M`Kaart- of dockbestanden zijn tijdens het herankeren gewijzigd of ontbreken.`);
  }
}

/** Camera-free, exact-stamp GNSS/odom observation with the full antenna transform. */
export async function measureReanchorDock(sn: string, operation: MowerMapOperation, snapshot: Record<string, unknown>) {
  const signature = frameSnapshotSignature(snapshot);
  const started = performance.now();
  const response = await operation.command('measure_runtime_frame', {}, MEASURE_TIMEOUT_MS);
  if (response?.result !== 0 || response.protocol !== 'runtime-map-frame-v1' || response.frame_fingerprint !== signature) {
    throw new TextError(M`Geen bevestigde voertuigmeting ontvangen. Controleer de versie van extended_commands.py en de meetkwaliteit.`);
  }
  const runtime = runtimeObservation(response.runtime_frame, started, MEASURE_TIMEOUT_MS / 1000);
  settledRuntime(runtime);
  const raw = response.runtime_frame as Record<string, unknown>;
  const base = raw.base as { x: number; y: number; z: number; yaw: number } | undefined;
  const dock = snapshotDockPose(snapshot)!;
  if (!base || ![base.x, base.y, base.z, base.yaw, raw.base_spread_m, raw.yaw_spread_rad].every(finite) ||
      raw.docked !== true || typeof raw.northern !== 'boolean' || Number(raw.base_spread_m) < 0 || Number(raw.base_spread_m) > .03 ||
      Number(raw.yaw_spread_rad) < 0 || Number(raw.yaw_spread_rad) > .03 ||
      Math.abs(Math.atan2(Math.sin(base.yaw - dock.orientation), Math.cos(base.yaw - dock.orientation))) > .05) {
    throw new TextError(M`Geen stabiele voertuigmeting met laadcontact en passende dockrichting.`);
  }
  const after = await readMowerMapSnapshot(sn, operation);
  assertReanchorFiles(snapshot, after);
  if (after.pos_json !== snapshot.pos_json) throw new TextError(M`Oorsprong gewijzigd tijdens de meting.`);
  // Freshness was checked by runtimeObservation right after the reply; the
  // multi-MB snapshot read above is not measurement age (review 2026-09-28).
  const state = freshPositionState(sn);
  if (!isDeviceOnline(sn) || !state.docked || !state.fixed || !state.running || !state.pose ||
      Math.hypot(state.pose.x - base.x, state.pose.y - base.y) > .05) {
    throw new TextError(M`Laadcontact, meetkwaliteit of voertuigpositie gewijzigd tijdens de meting.`);
  }
  const origin = JSON.parse(String(snapshot.pos_json)).utm_origin as Origin;
  // GNSS antenna -> UTM vehicle -> fixed dock. The observer already removed
  // the full rotated lever arm; a large temporary offset was rejected above.
  const expected: Origin = { x: origin.x + base.x - runtime.x - dock.x,
    y: origin.y + base.y - runtime.y - dock.y, z: 0, utm_zone: origin.utm_zone };
  return { expected, signature, runtime, base, dist: Math.hypot(base.x - dock.x, base.y - dock.y),
    latestDist: Math.hypot(state.pose.x - dock.x, state.pose.y - dock.y) };
}
