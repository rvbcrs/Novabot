import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { db } from '../db/database.js';
import { mapRepo, deviceSettingsRepo } from '../db/repositories/index.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { isFrameUnvalidated } from './frameValidation.js';
import { stablePosition } from './positionTelemetry.js';
import { withMowerMapOperation, readMowerMapSnapshot } from './mowerMapOperation.js';

export const PHOTO_DOCK_KEY = 'photo_dock_pose';
type Pose = { x: number; y: number; orientation: number };
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A photo reference is a display transform, never a replacement navigation anchor. */
export function getPhotoDockPose(sn: string): Pose | null {
  try {
    const p = JSON.parse(deviceSettingsRepo.findBySn(sn).find(r => r.key === PHOTO_DOCK_KEY)?.value ?? 'null');
    return p && finite(p.x) && finite(p.y) && finite(p.orientation) ? p : null;
  } catch { return null; }
}

/** Read the independently stored dock, not the potentially copied channel endpoint. */
export function snapshotDockPose(snapshot: Record<string, unknown> | null): Pose | null {
  if (snapshot?.result !== 0 || snapshot.snapshot_consistent !== true) return null;
  try {
    const csv = snapshot.csv_files as Record<string, string>;
    const p = JSON.parse(csv['map_info.json']).charging_pose;
    const yaml = String(snapshot.charging_station_yaml ?? '').match(/charging_pose:\s*\[([^\]]+)\]/);
    const cells = yaml?.[1].split(',');
    if (!cells || cells.length !== 3 || cells.some(v => !v.trim())) return null;
    const y = cells.map(Number);
    if (!p || ![p.x, p.y, p.orientation, ...y].every(finite)) return null;
    if (Math.hypot(p.x - y[0], p.y - y[1]) > 0.02
      || Math.abs(Math.atan2(Math.sin(p.orientation - y[2]), Math.cos(p.orientation - y[2]))) > 0.02) return null;
    return { x: p.x, y: p.y, orientation: p.orientation };
  } catch { return null; }
}

export async function alignDockPhoto(sn: string, lat: unknown, lng: unknown) {
  if (!finite(lat) || !finite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
    throw new Error('Kies een geldig punt op de foto.');
  }
  return withMowerMapOperation(sn, async operation => {
    const cal = mapRepo.getCalibration(sn);
    const offset = mapRepo.getPolygonOffset(sn);
    // ponytail: support the unshifted frame first; combining an existing
    // rotation/scale/physical shift needs an explicit calibration workflow.
    if ((cal?.offset_lat ?? 0) !== 0 || (cal?.offset_lng ?? 0) !== 0
      || (cal?.rotation ?? 0) !== 0 || (cal?.scale ?? 1) !== 1 || offset.x !== 0 || offset.y !== 0) {
      throw new Error('Deze kaart heeft al een verschuiving, rotatie of schaalcorrectie. Controleer die eerst.');
    }
    const ready = () => isDeviceOnline(sn) && !isFrameUnvalidated(sn) && stablePosition(sn, { docked: true });
    if (!ready()) throw new Error('Zet de maaier op het dock en wacht op verse, stabiele RTK Fixed-posities.');
    const snapshot = await readMowerMapSnapshot(sn, operation);
    const pose = snapshotDockPose(snapshot);
    const live = ready();
    if (!pose || !live || Math.hypot(live.x - pose.x, live.y - pose.y) > 0.05) {
      throw new Error('Dockmeting en opgeslagen dockpositie zijn niet bevestigd. Er is niets gewijzigd.');
    }
    // Preserve the prior display reference before changing it. No map files,
    // polygons, origin or firmware settings are written to the mower.
    const backup = {
      sn, calibration: mapRepo.getCalibration(sn) ?? null, photoDockPose: getPhotoDockPose(sn),
      measured: live, dock: pose, origin: snapshot!.pos_json, manifest: snapshot!.snapshot_manifest,
    };
    const dir = path.resolve(process.env.STORAGE_PATH ?? './storage', 'photo-calibration');
    mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(backup, null, 2), { flag: 'wx' });
    db.transaction(() => {
      mapRepo.setCalibration(sn, { charger_lat: lat, charger_lng: lng });
      deviceSettingsRepo.upsert(sn, PHOTO_DOCK_KEY, JSON.stringify(pose));
    })();
    return { chargingPose: pose, chargerGps: { lat, lng }, backupId: id };
  });
}
