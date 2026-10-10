import crypto from 'crypto';
import { readFileSync } from 'fs';
import unzipper from 'unzipper';
import { mapRepo } from '../db/repositories/index.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { isOpenNovaMower } from './mowerFileCapability.js';
import { beginMapApply, waitForPlannerBack, type MapApply, type MapApplyError } from './mapApplyStatus.js';
import { getPolygonAnchor, snapshotAnchorMatches } from './anchor.js';
import { freshPositionState } from './positionTelemetry.js';
import { isMapInstallPending, isFrameUnvalidated, markFrameUnvalidated, markMapInstallPending, clearMapInstallPending } from './frameValidation.js';
import { withMowerMapOperation, readMowerMapSnapshot, type MowerMapOperation } from './mowerMapOperation.js';
import { snapshotDockPose } from './dockPhotoReference.js';
import { sameMapFile } from './portableSnapshot.js';

// The mower unzips, restarts its mapping node and rasterises every slot; on a
// big garden that is tens of seconds.
const REGENERATE_TIMEOUT_MS = 120_000;

const syncSnapshots = new Map<string, { sn: string; bytes: Buffer }>();
export const getMapApplySnapshot = (id: string) => syncSnapshots.get(id);

export async function applyMapsToMower(sn: string, offset?: { x: number; y: number }): Promise<boolean> {
  let success = false;
  // Taking the lease is synchronous, before any awaited work or further edits.
  let apply: ReturnType<typeof beginMapApply> | undefined;
  try {
    await withMowerMapOperation(sn, async operation => {
      apply = beginMapApply(sn);
      apply.phase('syncing');
      const anchor = getPolygonAnchor(sn);
      // A pending install may be retried even if frame verification is also
      // required. A verified CSV install releases only the installation block.
      const refusal: MapApplyError | null = !isOpenNovaMower(sn) ? 'not_opennova'
        : !isDeviceOnline(sn) ? 'mower_offline'
        : !freshPositionState(sn).docked ? 'not_docked'
        : isFrameUnvalidated(sn) && !isMapInstallPending(sn) ? 'frame_unvalidated'
        : !anchor ? 'no_dock_anchor' : null;
      if (refusal || !anchor) { apply.fail(refusal ?? 'no_dock_anchor'); return; }
      const before = await readMowerMapSnapshot(sn, operation);
      const savedDock = snapshotDockPose(before);
      // After deleting all zones, the first new copy has no prior channel to
      // compare. The independent persisted dock still has to match its anchor.
      const noPriorChannel = before && !Object.keys((before.csv_files ?? {}) as object).some(n => /^map\d+tocharge_unicom\.csv$/.test(n));
      const matchesEmptyDock = noPriorChannel && savedDock && Math.hypot(savedDock.x - anchor.x, savedDock.y - anchor.y) <= 0.02;
      if (!before) { apply.fail('snapshot_failed'); return; }
      if (!isDeviceOnline(sn)) { apply.fail('mower_offline'); return; }
      if (!freshPositionState(sn).docked) { apply.fail('not_docked'); return; }
      if (!snapshotAnchorMatches(before, anchor) && !matchesEmptyDock) { apply.fail('dock_mismatch'); return; }
      if (offset) mapRepo.setPolygonOffset(sn, offset.x, offset.y);
      const { regenerateLatestZipFromBackup } = await import('../services/mapBackup.js');
      // novabot_mapping rewrites map_info.json's charging_pose from charging_station.yaml on restart.
      const dock = String(before.charging_station_yaml ?? '').match(/charging_pose:\s*\[([^\]]+)\]/)?.[1].split(',').map(Number) ?? [];
      const zipPath = regenerateLatestZipFromBackup(sn, { x: dock[0], y: dock[1], orientation: dock[2] });
      if (!zipPath) { apply.fail('bundle_failed'); return; }
      const bytes = readFileSync(zipPath);
      const zip = await unzipper.Open.buffer(bytes);
      const expectedCsv = new Map<string, string>();
      for (const file of zip.files) if (file.type === 'File' && /^csv_file\/[^/]+$/.test(file.path)) expectedCsv.set(file.path.slice(9), (await file.buffer()).toString('utf8'));
      if (!expectedCsv.size) { apply.fail('bundle_failed'); return; }
      if (!await installVerifiedMapZip(sn, { bytes, expectedCsv, before, anchor }, operation, apply)) return;
      clearMapInstallPending(sn);
      apply.done();
      success = true;
    });
  } catch (error) {
    console.warn(`[AUTO-PUSH] ${sn}:`, error);
    // A competing request must not replace the status of the operation owning the lease.
    if (apply) apply.fail('sync_failed');
  }
  return success;
}

// The mower downloads the ZIP, unpacks it and restarts its mapping node.
const SYNC_MAP_TIMEOUT_MS = 120_000;

/**
 * Ask the mower to rebuild its per-slot grids after a map push, and wait for
 * the answer so the log tells us whether the shared raster had to grow.
 */
async function regeneratePerMapFiles(sn: string, operation: MowerMapOperation): Promise<'ok' | 'regenerate_timeout' | 'regenerate_failed'> {
  try {
    const result = await operation.command('regenerate_per_map_files', {}, REGENERATE_TIMEOUT_MS);
    if (!result) {
      console.warn(`[AUTO-PUSH] ${sn}: geen antwoord op regenerate_per_map_files`);
      return 'regenerate_timeout';
    }
    if (result.result !== 0) {
      console.warn(`[AUTO-PUSH] ${sn}: regenerate_per_map_files faalde: ${String(result.error ?? '')}`);
      return 'regenerate_failed';
    }
    const grown = result.canvas_grown as { from?: string; to?: string } | null | undefined;
    console.log(`[AUTO-PUSH] ${sn}: per-slot grids herbouwd${grown ? ` (raster ${grown.from} → ${grown.to})` : ''}`);
    return 'ok';
  } catch (err) {
    console.warn(`[AUTO-PUSH] regenerate_per_map_files fout voor ${sn}:`, err);
    return 'regenerate_failed';
  }
}

/** CSV-only transfer/readback. The caller commits server state before clearing install pending. */
export async function installVerifiedMapZip(
  sn: string,
  input: { bytes: Buffer; expectedCsv: Map<string, string>; before: Record<string, unknown>; anchor: { x: number; y: number } },
  operation: MowerMapOperation,
  apply: MapApply,
): Promise<Record<string, unknown> | null> {
  const { bytes, expectedCsv, before, anchor } = input;
  if (!isDeviceOnline(sn)) { apply.fail('mower_offline'); return null; }
  if (!freshPositionState(sn).docked) { apply.fail('not_docked'); return null; }
  markMapInstallPending(sn);
  syncSnapshots.set(operation.id, { sn, bytes });
  try {
    const sync = await operation.command('sync_map', {
      zip_url: `/api/dashboard/maps/${encodeURIComponent(sn)}/sync-operation/${operation.id}`,
      expected_md5: crypto.createHash('md5').update(bytes).digest('hex'),
    }, SYNC_MAP_TIMEOUT_MS);
    if (!sync || sync.result !== 0 || sync.restart === false || sync.auto_recharge_restart === false) { apply.fail(sync ? 'sync_failed' : 'sync_timeout'); return null; }
    apply.phase('regenerating');
    const regen = await regeneratePerMapFiles(sn, operation);
    if (regen !== 'ok') { apply.fail(regen); return null; }
    apply.phase('settling');
    if (await waitForPlannerBack(sn) === 'timeout') { apply.fail('planner_timeout'); return null; }
    const after = await readMowerMapSnapshot(sn, operation);
    if (after && (after.pos_json !== before.pos_json || after.charging_station_yaml !== before.charging_station_yaml)) {
      markFrameUnvalidated(sn, { preservePhotoDock: true });
      apply.fail('frame_changed'); return null;
    }
    const actualCsv = after?.csv_files as Record<string, string> | undefined;
    const actualX3 = after?.x3_csv_files as Record<string, string> | undefined;
    // novabot_mapping rewrites map_info.json seconds after its restart (see sameMapInfo).
    const changed = [...expectedCsv].filter(([name, contents]) => !sameMapFile(name, contents, actualX3?.[name]) || !sameMapFile(name, contents, actualCsv?.[name])).map(([name]) => name);
    const extra = [...Object.keys(actualCsv ?? {}), ...Object.keys(actualX3 ?? {})].filter(name => !expectedCsv.has(name));
    if (!after || !actualCsv || !actualX3 || changed.length || extra.length || !snapshotAnchorMatches(after, anchor)) {
      console.warn(`[AUTO-PUSH] ${sn}: kaartbestanden na installatie wijken af (anders: ${changed.join(', ') || '-'}; extra: ${extra.join(', ') || '-'}; anker ${snapshotAnchorMatches(after ?? {}, anchor) ? 'ok' : 'fout'})`);
      apply.fail('install_mismatch'); return null;
    }
    return after;
  } finally { syncSnapshots.delete(operation.id); }
}
