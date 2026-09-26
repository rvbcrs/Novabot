import crypto from 'crypto';
import { readFileSync } from 'fs';
import unzipper from 'unzipper';
import { mapRepo } from '../db/repositories/index.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { isOpenNovaMower } from './mowerFileCapability.js';
import { beginMapApply, waitForPlannerBack } from './mapApplyStatus.js';
import { getPolygonAnchor, snapshotAnchorMatches } from './anchor.js';
import { freshPositionState } from './positionTelemetry.js';
import { isFrameUnvalidated, markFrameUnvalidated, clearFrameUnvalidated } from './frameValidation.js';
import { withMowerMapOperation, readMowerMapSnapshot, type MowerMapOperation } from './mowerMapOperation.js';

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
      if (!isOpenNovaMower(sn) || !isDeviceOnline(sn) || !freshPositionState(sn).docked || isFrameUnvalidated(sn) || !anchor) { apply.fail('sync_failed'); return; }
      const before = await readMowerMapSnapshot(sn, operation);
      if (!before || !freshPositionState(sn).docked || !isDeviceOnline(sn) || !snapshotAnchorMatches(before, anchor)) { apply.fail('sync_failed'); return; }
      if (offset) mapRepo.setPolygonOffset(sn, offset.x, offset.y);
      const { regenerateLatestZipFromBackup } = await import('../services/mapBackup.js');
      const dockHeading = Number(JSON.parse((before.csv_files as Record<string, string>)['map_info.json']).charging_pose.orientation);
      const zipPath = regenerateLatestZipFromBackup(sn, dockHeading);
      if (!zipPath) { apply.fail('sync_failed'); return; }
      const bytes = readFileSync(zipPath);
      const zip = await unzipper.Open.buffer(bytes);
      const expectedCsv = new Map<string, string>();
      for (const file of zip.files) if (file.type === 'File' && /^csv_file\/[^/]+$/.test(file.path)) expectedCsv.set(file.path.slice(9), (await file.buffer()).toString('utf8'));
      if (!expectedCsv.size) { apply.fail('sync_failed'); return; }
      if (!freshPositionState(sn).docked || !isDeviceOnline(sn)) { apply.fail('sync_failed'); return; }
      markFrameUnvalidated(sn); // survives server failure while the device is replacing files
      syncSnapshots.set(operation.id, { sn, bytes });
      try {
        const sync = await operation.command('sync_map', {
          zip_url: `/api/dashboard/maps/${encodeURIComponent(sn)}/sync-operation/${operation.id}`,
          expected_md5: crypto.createHash('md5').update(bytes).digest('hex'),
        }, SYNC_MAP_TIMEOUT_MS);
        if (!sync || sync.result !== 0) { markFrameUnvalidated(sn); apply.fail(sync ? 'sync_failed' : 'sync_timeout'); return; }
        apply.phase('regenerating');
        const regen = await regeneratePerMapFiles(sn, operation);
        if (regen !== 'ok') { markFrameUnvalidated(sn); apply.fail(regen); return; }
        apply.phase('settling');
        if (await waitForPlannerBack(sn) === 'timeout') { apply.fail('planner_timeout'); return; }
        const after = await readMowerMapSnapshot(sn, operation);
        const actualCsv = after?.csv_files as Record<string, string> | undefined;
        const actualX3 = after?.x3_csv_files as Record<string, string> | undefined;
        if (!after || !actualCsv || !actualX3 || Object.keys(actualX3).length !== expectedCsv.size || [...expectedCsv].some(([name, contents]) => actualX3[name] !== contents) || !snapshotAnchorMatches(after, anchor) || after.pos_json !== before.pos_json || after.charging_station_yaml !== before.charging_station_yaml || Object.keys(actualCsv).length !== expectedCsv.size || [...expectedCsv].some(([name, contents]) => actualCsv[name] !== contents)) { apply.fail('sync_failed'); return; }
        // This operation did not change the origin or dock pose. A verified
        // readback permits restoring its pre-operation validated frame state.
        clearFrameUnvalidated(sn);
        apply.done();
        success = true;
      } finally { syncSnapshots.delete(operation.id); }
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

