/**
 * Map Backup Service — auto-snapshot + retention for mower map state.
 *
 * After every map mutation a snapshot is scheduled (trailing-edge debounce:
 * 5 s). On fire a full ZIP is generated via generateMapZipFromDb() and stored
 * durably under:
 *
 *   <STORAGE_PATH>/maps/backups/<sn>/<ISO-timestamp>.zip
 *
 * Retention: at most 20 snapshots per mower are kept; older ones are deleted.
 */

import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { generateMapZipFromDb } from '../mqtt/mapConverter.js';
import { mapRepo } from '../db/repositories/index.js';
import { getPolygonAnchor } from './anchor.js';

const TAG = '[MAP-BACKUP]';

/** Maximum number of snapshots kept per mower (oldest are pruned). */
const RETENTION = 20;

/** Debounce window in ms — rapid back-to-back mutations coalesce into one snapshot. */
const DEBOUNCE_MS = 5000;

/** In-flight debounce timers keyed by mower SN. */
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── Paths ────────────────────────────────────────────────────────────────────

/**
 * Return (and create if necessary) the backup directory for a given SN.
 */
function backupDir(sn: string): string {
  const root = path.resolve(
    process.env.STORAGE_PATH ?? './storage',
    'maps',
    'backups',
    sn,
  );
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * List all backup snapshots for a mower, ordered newest first.
 *
 * If the backups directory is empty (e.g. fresh install before any map
 * mutation), attempts a one-shot bootstrap in this priority order:
 *   1. DB has map rows → generate a ZIP via generateMapZipFromDb and copy it.
 *   2. DB empty but `<STORAGE_PATH>/maps/<sn>_latest.zip` exists → copy that.
 *   3. Both empty → return [].
 *
 * Once at least one backup exists the bootstrap is skipped on all future calls.
 */
export function listBackups(sn: string): Array<{ filename: string; ts: number; sizeBytes: number }> {
  const dir = backupDir(sn);
  const initial = _readDirSorted(dir);
  if (initial.length === 0) {
    _bootstrapBackup(sn);
    return _readDirSorted(dir);
  }
  return initial;
}

/**
 * Resolve the absolute path for a backup file.
 * Throws if the filename does not match the expected pattern (path-traversal guard).
 */
export function backupPath(sn: string, filename: string): string {
  // Allow only safe filenames: ISO timestamps with colons replaced by dashes,
  // e.g. "2026-04-29T10-15-30.000Z.zip"
  if (!/^[\w.\-T:Z]+\.zip$/.test(filename)) {
    throw new Error('Invalid backup filename');
  }
  return path.join(backupDir(sn), filename);
}

/**
 * Schedule a snapshot for the given mower.
 *
 * Uses trailing-edge debounce: if called multiple times within DEBOUNCE_MS,
 * only the last call's snapshot fires. This ensures that a burst of related
 * mutations (e.g. delete-cascade removing work + obstacles + unicom) results
 * in a single snapshot rather than three consecutive ones.
 */
export function scheduleSnapshot(sn: string): void {
  const existing = pendingTimers.get(sn);
  if (existing) clearTimeout(existing);

  const t = setTimeout(() => {
    pendingTimers.delete(sn);
    _fireSnapshot(sn);
  }, DEBOUNCE_MS);

  pendingTimers.set(sn, t);
}

// ── Internal ─────────────────────────────────────────────────────────────────

/**
 * Read and return all .zip entries in `dir`, sorted newest first.
 * Returns [] if the directory does not exist or contains no ZIPs.
 */
function _readDirSorted(dir: string): Array<{ filename: string; ts: number; sizeBytes: number }> {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.zip'));
  return files
    .map(f => {
      try {
        const stat = fs.statSync(path.join(dir, f));
        return { filename: f, ts: stat.mtimeMs, sizeBytes: stat.size };
      } catch {
        return null;
      }
    })
    .filter((x): x is { filename: string; ts: number; sizeBytes: number } => x !== null)
    .sort((a, b) => b.ts - a.ts);
}

/**
 * One-shot bootstrap: create the first backup entry when no backups exist yet.
 *
 * Priority:
 *   1. DB has map rows for this SN → generate a fresh ZIP from DB data.
 *   2. DB empty but `<STORAGE_PATH>/maps/<sn>_latest.zip` exists → copy it.
 *   3. Both empty → no-op (listBackups will return []).
 *
 * The resulting file is named `bootstrap-<ISO>.zip` so it is clearly
 * distinguishable from regular mutation snapshots in the admin UI.
 */
function _bootstrapBackup(sn: string): void {
  const dir = backupDir(sn);
  const ts = new Date().toISOString().replace(/:/g, '-');
  const target = path.join(dir, `bootstrap-${ts}.zip`);

  // Path 1: DB has maps → generate fresh ZIP
  const dbCount = mapRepo.countByMowerSn(sn);
  if (dbCount > 0) {
    const zipPath = generateMapZipFromDb(sn, 0);
    if (zipPath && fs.existsSync(zipPath)) {
      try {
        fs.copyFileSync(zipPath, target);
        console.log(`${TAG} bootstrap snapshot from DB: ${target} (${dbCount} maps)`);
      } catch (err) {
        console.error(`${TAG} bootstrap from DB failed for ${sn}:`, err);
      }
    }
    return;
  }

  // Path 2: DB empty but _latest.zip exists → copy it
  const mapsRoot = path.resolve(process.env.STORAGE_PATH ?? './storage', 'maps');
  const latestZip = path.join(mapsRoot, `${sn}_latest.zip`);
  if (fs.existsSync(latestZip)) {
    try {
      fs.copyFileSync(latestZip, target);
      console.log(`${TAG} bootstrap snapshot from _latest.zip: ${target}`);
    } catch (err) {
      console.error(`${TAG} bootstrap from _latest.zip failed for ${sn}:`, err);
    }
  }
}

/**
 * Build and persist a snapshot immediately (no debounce).
 * Returns the absolute path of the saved ZIP, or null on failure.
 */
// Per-process monotonic counter so back-to-back snapshot calls within the
// same millisecond produce distinct filenames. Without this, fast CI runners
// observed three _snapshotNow() calls collapsing into a single zip on disk
// (the second + third overwrite the first). Counter resets are fine — the
// timestamp prefix already keeps things globally unique across runs.
let _snapshotCounter = 0;

function _fireSnapshot(sn: string): string | null {
  try {
    // ISO timestamp with colons replaced so the filename is FS-safe everywhere
    const stamp = new Date().toISOString().replace(/:/g, '-');
    const seq = (++_snapshotCounter).toString().padStart(4, '0');
    const filename = `${stamp}-${seq}.zip`;
    const target = path.join(backupDir(sn), filename);

    const tmp = generateMapZipFromDb(sn, 0);
    if (!tmp) {
      console.log(`${TAG} No maps for ${sn} — snapshot skipped`);
      return null;
    }

    fs.copyFileSync(tmp, target);
    console.log(`${TAG} snapshot saved → ${target}`);

    _enforceRetention(sn);
    return target;
  } catch (err) {
    console.error(`${TAG} snapshot failed for ${sn}:`, err);
    return null;
  }
}

/**
 * Prune oldest snapshots so at most RETENTION files remain per mower.
 */
function _enforceRetention(sn: string): void {
  const all = _readDirSorted(backupDir(sn)); // newest first — bypass bootstrap logic
  const toDelete = all.slice(RETENTION);
  for (const b of toDelete) {
    try {
      fs.unlinkSync(path.join(backupDir(sn), b.filename));
    } catch { /* ignore ENOENT races */ }
  }
}

// ── Restore + Realign helpers ────────────────────────────────────────────────


/**
 * Regenerate the canonical `<SN>_latest.zip` from the just-restored DB rows
 * AND embed correct charger pose metadata in the ZIP's csv_file/map_info.json.
 *
 * Used by /api/admin-status/map-backups/:sn/:filename/restore-and-realign
 * (Novabot-uvf) — one-click recovery endpoint. After this fires, the mower's
 * extended_commands.py handle_sync_map will pull the ZIP and write all five
 * mower-disk state files consistently.
 *
 * Returns the absolute path of the written ZIP, or null when:
 *   - DB has no maps for this SN.
 *   - Polygon has no `mapNtocharge_unicom` (cannot anchor charger pose).
 *   - ZIP build / edit fails.
 *
 * Does NOT change the polygon CSV bytes — only edits map_info.json metadata.
 */
export function regenerateLatestZipFromBackup(sn: string): string | null {
  const anchor = getPolygonAnchor(sn);
  if (!anchor) {
    console.warn(`${TAG} regenerate skipped — no polygon anchor for ${sn}`);
    return null;
  }

  // Build fresh ZIP from current DB state.
  const tmpZip = generateMapZipFromDb(sn, anchor.orientation);
  if (!tmpZip || !fs.existsSync(tmpZip)) {
    console.warn(`${TAG} regenerate skipped — generateMapZipFromDb returned no zip for ${sn}`);
    return null;
  }

  // Edit csv_file/map_info.json inside the ZIP. Use unzip+rezip via the
  // system tools because Node has no first-class ZIP edit primitive in stdlib
  // and adding a dep just for this is heavy. The container's base image
  // already has unzip + zip available (used by handle_sync_map on the mower
  // and by other server-side flows here).
  const stagingDir = path.join(path.dirname(tmpZip), `regen_${sn}_${Date.now()}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    execSync(`unzip -o -q "${tmpZip}" -d "${stagingDir}"`);

    const csvDir = path.join(stagingDir, 'csv_file');
    if (!fs.existsSync(csvDir)) {
      console.warn(`${TAG} regenerate aborted — generated ZIP has no csv_file/ for ${sn}`);
      return null;
    }
    const infoPath = path.join(csvDir, 'map_info.json');
    // Alleen charging_pose overschrijven; de map_size-entries per werkgebied
    // (map0_work.csv, map3_work.csv, ...) komen uit generateMapZipFromDb. Een
    // hardcoded map0-only map_info wiste de andere slots op de maaier.
    let generated: Record<string, unknown> = {};
    try { generated = JSON.parse(fs.readFileSync(infoPath, 'utf8')); } catch { /* geen map_info → alleen pose */ }
    const enriched = {
      ...generated,
      charging_pose: {
        x: anchor.x,
        y: anchor.y,
        orientation: anchor.orientation,
      },
    };
    fs.writeFileSync(infoPath, JSON.stringify(enriched, null, 3));

    // Rebuild ZIP atomically into the canonical _latest.zip slot.
    const mapsRoot = path.resolve(process.env.STORAGE_PATH ?? './storage', 'maps');
    fs.mkdirSync(mapsRoot, { recursive: true });
    const finalZip = path.join(mapsRoot, `${sn}_latest.zip`);
    const tmpFinal = `${finalZip}.tmp`;
    if (fs.existsSync(tmpFinal)) fs.unlinkSync(tmpFinal);
    // `zip -r` from inside stagingDir so paths are relative (csv_file/...).
    execSync(`cd "${stagingDir}" && zip -q -r "${tmpFinal}" csv_file/`);
    fs.renameSync(tmpFinal, finalZip);

    console.log(
      `${TAG} regenerated ${finalZip} — anchor (${anchor.x}, ${anchor.y}, ${anchor.orientation}) [${anchor.orientationSource}]`,
    );
    return finalZip;
  } catch (err) {
    console.error(`${TAG} regenerate failed for ${sn}:`, err);
    return null;
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Test helpers (exported for vitest only) ───────────────────────────────────

/**
 * Cancel all pending debounce timers. Call from vitest `beforeEach` cleanup.
 */
export function _drainScheduled(): void {
  for (const t of pendingTimers.values()) clearTimeout(t);
  pendingTimers.clear();
}

/**
 * Fire a snapshot immediately (bypassing the debounce timer).
 * Returns the absolute path of the written ZIP, or null on failure.
 */
export function _snapshotNow(sn: string): string | null {
  return _fireSnapshot(sn);
}
