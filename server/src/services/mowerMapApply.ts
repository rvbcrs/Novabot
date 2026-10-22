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
import { geometryFromMowerFiles, sameMapFile } from './portableSnapshot.js';
import { synthesizeMowerFiles } from '../maps/synthMowerFiles.js';

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
// It backs up home0 before writing; the same budget as a verbatim restore.
const WRITE_MAP_FILES_TIMEOUT_MS = 120_000;

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

/**
 * regenerate_per_map_files masks the whole-garden raster (map.yaml + map.pgm)
 * into the per-zone grids and refuses without it. Only save_map type:1 writes
 * that raster on the mower, and sync_map cannot bring it: its ZIP may hold
 * CSVs only. A mower that lost it failed every install and every Retry
 * (GH #161). read_map_files lists the rasters; firmware that lists none is
 * left as it was.
 */
function lacksWholeMapRaster(snapshot: Record<string, unknown>): boolean {
  const text = snapshot.map_files_text, b64 = snapshot.map_files_b64;
  if (!text || typeof text !== 'object' || !b64 || typeof b64 !== 'object') return false;
  return typeof (text as Record<string, unknown>)['map.yaml'] !== 'string' || typeof (b64 as Record<string, unknown>)['map.pgm'] !== 'string';
}

/** The whole-garden raster for these CSVs, built as for a synthesized portable bundle. */
function wholeMapRaster(sn: string, csvFiles: Record<string, string>): { text: Record<string, string>; b64: Record<string, string> } | null {
  try {
    const { workMaps, obstacles, unicom, chargingPose } = geometryFromMowerFiles({ csvFiles, chargingStationYaml: null });
    const synth = synthesizeMowerFiles({
      workMaps, unicom, chargingPose,
      obstacles: obstacles.map(o => ({ canonical: o.canonical, parentMap: o.canonical.match(/^map\d+/)?.[0] ?? '', points: o.points })),
    });
    const b64: Record<string, string> = { 'map.pgm': synth.mapFilesB64['map.pgm'] };
    if (synth.mapFilesB64['map.png']) b64['map.png'] = synth.mapFilesB64['map.png'];
    return { text: { 'map.yaml': synth.mapFilesText['map.yaml'] }, b64 };
  } catch (err) {
    console.warn(`[AUTO-PUSH] ${sn}: kaartraster voor de hele tuin niet op te bouwen:`, err);
    return null;
  }
}

/**
 * Give a mower without the whole-garden raster one built from the CSVs that
 * sync_map just installed. write_map_files always rewrites both CSV trees, so
 * it gets exactly those again: no connector is pruned (sync_map left none
 * outside this set), no other raster is removed, pos.json and the dock file
 * stay untouched and the mapping node is not restarted a second time.
 */
async function writeWholeMapRaster(sn: string, csvFiles: Record<string, string>, operation: MowerMapOperation): Promise<'ok' | 'bundle_failed' | 'regenerate_timeout' | 'regenerate_failed'> {
  const raster = wholeMapRaster(sn, csvFiles);
  if (!raster) return 'bundle_failed';
  const written = await operation.command('write_map_files', {
    csv_files: csvFiles, x3_csv_files: csvFiles,
    map_files_text: raster.text, map_files_b64: raster.b64,
    restart_mapping: false,
  }, WRITE_MAP_FILES_TIMEOUT_MS);
  if (!written) {
    console.warn(`[AUTO-PUSH] ${sn}: geen antwoord op write_map_files (kaartraster hele tuin)`);
    return 'regenerate_timeout';
  }
  if (written.result !== 0) {
    console.warn(`[AUTO-PUSH] ${sn}: kaartraster hele tuin schrijven faalde: ${String(written.error ?? '')}`);
    return 'regenerate_failed';
  }
  console.log(`[AUTO-PUSH] ${sn}: map.yaml/map.pgm ontbraken; opgebouwd uit de CSV's en geschreven`);
  return 'ok';
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
    if (lacksWholeMapRaster(before)) {
      const raster = await writeWholeMapRaster(sn, Object.fromEntries(expectedCsv), operation);
      if (raster !== 'ok') { apply.fail(raster); return null; }
    }
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
