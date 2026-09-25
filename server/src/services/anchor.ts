/**
 * Polygon anchor lookup — returns the canonical charger pose that the mower's
 * polygon was built around.
 *
 * Source-of-truth ordering:
 *   1. `map0tocharge_unicom.csv` first point — automatically written by the
 *      mower at mapping time (save_recharge_pos). Survives metadata corruption
 *      because it lives inside the polygon CSV itself, not in a sidecar file.
 *   2. Orientation is not in unicom CSV — the caller supplies it (typically
 *      from sensor cache `map_position_orientation` when localization is
 *      healthy, else 1.5 rad fallback). Splitting the orientation lookup out
 *      of this module keeps anchor.ts a pure DB read so it can be imported
 *      from server-init paths without pulling the broker → socketHandler
 *      circular chain via `mqtt/sensorData`.
 *
 * Used by:
 *   - regenerateLatestZipFromBackup (Novabot-kmn) — embed correct charger pose
 *     in the ZIP's map_info.json so dashboard renders + mower realign work.
 *   - /api/dashboard/maps/:sn/sync-info (Novabot-aev) — return canonical
 *     `charging_pose` for mower's extended sync_map handler to write into yaml.
 *   - /api/admin-status/map-backups/:sn/:filename/restore-and-realign
 *     (Novabot-uvf) — full one-click restore endpoint.
 *
 * Spec: docs/superpowers/specs/2026-05-03-restore-and-realign-mower-from-zip.md
 */

import { mapRepo } from '../db/repositories/maps.js';

export interface PolygonAnchor {
  /** Charger position in map-frame meters, x. */
  x: number;
  /** Charger position in map-frame meters, y. */
  y: number;
  /** Charger heading in radians. From caller-supplied source (sensor or
   *  default). Always set so downstream consumers can write the pose
   *  unconditionally. */
  orientation: number;
  /** Where the orientation came from — useful for callers to log/decide
   *  whether to retry once localization stabilises. */
  orientationSource: 'saved' | 'sensor' | 'default';
}

const DEFAULT_ORIENTATION = 1.5;

/**
 * Localization states we trust enough to read map_position_orientation from.
 * Stock firmware emits a mix of literal labels (NOT_INITIALIZED, INITIALIZING,
 * INITIALIZED, LOST) and free-form labels (RUNNING) depending on the source
 * node. We deny-list the explicitly-bad ones; everything else is acceptable.
 *
 * Exported so callers (which read sensor cache directly) reuse the same gate.
 */
export function isLocalizationHealthy(state: string | null | undefined): boolean {
  if (!state) return false;
  return !/^(not[ _]?initialized|initializing|lost|failed|error)$/i.test(state);
}

/**
 * Resolve an orientation value from a sensor map (the caller's deviceCache
 * entry). Returns the sensor reading when localization is healthy, else the
 * 1.5 rad default. Pure function — no module-level imports of sensorData.
 */
export function resolveOrientation(
  sensors: Map<string, string> | null | undefined,
): { orientation: number; source: 'sensor' | 'default' } {
  const locState = sensors?.get('localization_state');
  const orientationRaw = sensors?.get('map_position_orientation');
  const orientationNum = orientationRaw != null ? Number(orientationRaw) : NaN;
  if (isLocalizationHealthy(locState ?? null) && Number.isFinite(orientationNum)) {
    return { orientation: orientationNum, source: 'sensor' };
  }
  return { orientation: DEFAULT_ORIENTATION, source: 'default' };
}

/**
 * Resolve charging-pose orientation with the right source-priority for the
 * sync-info / regenerate code paths. Order:
 *   1. DB `polygon_charging_orientation` — written by recalibrate-charging-pose
 *      (operator-confirmed); persists across sync_map calls so the mower yaml
 *      stops flipping by ~30° every time the mower's IMU drifts.
 *   2. Live sensor IMU heading (when localization healthy) — first-time
 *      bootstrap before any explicit recalibrate has happened.
 *   3. 1.5 rad default — last-resort fallback.
 *
 * The pre-2026-05-05 behaviour was (2) → (3), which silently overwrote the
 * mower's saved dock orientation on every sync, sending the mower into the
 * wrong heading at recharge / coverage start. See bug analysis 2026-05-05.
 */
export function resolveSavedOrientation(
  sn: string,
  sensors: Map<string, string> | null | undefined,
): { orientation: number; source: 'saved' | 'sensor' | 'default' } {
  const saved = mapRepo.getPolygonChargingOrientation(sn);
  if (saved != null && Number.isFinite(saved)) {
    return { orientation: saved, source: 'saved' };
  }
  const live = resolveOrientation(sensors);
  return live;
}

/**
 * Pull the polygon's charger anchor from the unicom CSV stored in the maps
 * table. Returns null when the mower has no unicom map (in which case the
 * caller cannot anchor and must fail or fall back).
 *
 * The unicom CSV is stored in `maps.map_area` as a JSON-encoded array of
 * {x, y} points. By construction the first point is the mower's pose at
 * `save_recharge_pos` time — i.e. the charger position in map frame.
 *
 * Pass the mower's sensor map (from deviceCache) when available so the
 * orientation reflects the live heading; pass null/undefined to use the
 * default 1.5 rad. Decoupling sensorData lookup from this module avoids
 * pulling the broker init chain into pure-DB-read consumers.
 */
export function getPolygonAnchor(
  sn: string,
  sensors?: Map<string, string> | null,
): PolygonAnchor | null {
  const unicomMaps = mapRepo.findAllByMowerSnAndType(sn, 'unicom');
  if (unicomMaps.length === 0) return null;

  // ONLY the canonical `mapNtocharge_unicom` can anchor: its first point is
  // the dock. A map-to-map unicom starts at a zone border, and using that as
  // "the dock" is exactly what shifted a whole garden after a user deleted
  // map0tocharge_unicom (#119): the charging pose landed on a channel point,
  // the zip/pos.json/yaml followed, and the map moved metres. No anchor is
  // better than a wrong one; callers fall back to the live docked pose or skip.
  const channels = unicomMaps.filter(m => /^map\d+tocharge_unicom$/.test(m.canonical_name ?? m.map_name ?? ''));
  if (!channels.length) return null;
  const anchors: Array<{ x: number; y: number }> = [];
  for (const channel of channels) {
    try {
      const point = JSON.parse(channel.map_area ?? 'null')?.[0];
      if (typeof point?.x !== 'number' || typeof point?.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      anchors.push(point);
    } catch { return null; }
  }
  const { x, y } = anchors[0];
  if (anchors.some(p => Math.hypot(p.x - x, p.y - y) > 0.02)) return null;

  const { orientation, source } = resolveSavedOrientation(sn, sensors);
  return { x, y, orientation, orientationSource: source };
}

/** Every persisted representation must identify the same dock before a writer runs. */
export function snapshotAnchorMatches(snapshot: Record<string, unknown>, anchor: { x: number; y: number }): boolean {
  const matches = (x: unknown, y: unknown) => typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && Math.hypot(x - anchor.x, y - anchor.y) <= 0.02;
  const csv = snapshot.csv_files as Record<string, string> | undefined;
  if (!csv || snapshot.result !== 0 || snapshot.snapshot_consistent !== true) return false;
  const channels = Object.entries(csv).filter(([name]) => /^map\d+tocharge_unicom\.csv$/.test(name));
  if (!channels.length || channels.some(([, text]) => {
    const row = text.trim().split(/\r?\n/)[0]?.split(',').map(Number);
    return !row || !matches(row[0], row[1]);
  })) return false;
  try {
    const info = JSON.parse(csv['map_info.json']);
    const pose = info.charging_pose;
    if (!pose || !matches(Number(pose.x), Number(pose.y))) return false;
    const yaml = String(snapshot.charging_station_yaml ?? '').match(/charging_pose:\s*\[([^\]]+)\]/);
    const values = yaml?.[1].split(',').map(Number);
    return !!values && matches(values[0], values[1]) && Number.isFinite(values[2]);
  } catch { return false; }
}
