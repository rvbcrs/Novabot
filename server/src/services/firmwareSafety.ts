/**
 * Firmware safety gate — guarantees a fresh map backup before a BETA
 * (custom/opennova) mower firmware flash. See
 * docs/superpowers/specs/2026-06-12-beta-firmware-install-gate-design.md
 */
import { listBackups, createBundleFromDb, createBackup, type BackupEntry } from './portableBackup.js';
import { mapRepo } from '../db/repositories/index.js';
import { translator, type Translate } from './serverText.js';

/** Reuse a backup younger than this; otherwise make a fresh one. */
export const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Canonical BETA warning copy. Clients mirror this text per-package. */
export const BETA_FIRMWARE_WARNING =
  "⚠️ BETA — Custom firmware. Dit is experimentele software. Het kan je maaier " +
  "onbruikbaar maken (bricken) en AL je kaarten wissen. Er wordt automatisch een " +
  "backup gemaakt, maar installeer alleen als je de risico's accepteert.";

/** True for custom/opennova builds (the BETA firmware we gate). */
export function isBetaFirmware(version: string | null | undefined): boolean {
  if (!version) return false;
  const v = version.toLowerCase();
  return v.includes('custom') || v.includes('opennova');
}

// ── ensureBetaFlashSafe ───────────────────────────────────────────────────────

export type BetaFlashGate =
  | { allowed: true; backup: BackupEntry | null; reason: 'not-beta' | 'recent-backup' | 'backup-created' | 'backup-created-live' | 'no-maps' | 'forced-no-backup' }
  | { allowed: false; error: 'BACKUP_FAILED'; detail: string };

/**
 * Best-effort pre-flash backup. Tries pure-DB synthesis first; if that fails
 * (most often because the DB has no resolvable charging pose yet — a mower that
 * still needs re-anchor), falls back to a LIVE backup read from the mower's own
 * files (which carry the real pose and do not depend on the DB). Returns the
 * created backup + which path produced it, or null if both fail.
 */
async function bestEffortPreFlashBackup(sn: string): Promise<{ entry: BackupEntry; live: boolean } | null> {
  try {
    const fromDb = await createBundleFromDb(sn, 'pre-beta-flash');
    if (fromDb) return { entry: fromDb, live: false };
  } catch (err) {
    console.error(`[firmware-safety] createBundleFromDb threw for ${sn}:`, err);
  }
  try {
    const live = await createBackup(sn, 'pre-beta-flash-live');
    if (live) return { entry: live, live: true };
  } catch (err) {
    console.error(`[firmware-safety] live createBackup threw for ${sn}:`, err);
  }
  return null;
}

/**
 * True when the mower has at least one work polygon worth protecting.
 * Fails CLOSED: if the DB can't be read we assume maps exist (return true) so
 * the gate blocks rather than risk silently allowing a destructive flash.
 */
export function hasMapsToProtect(sn: string): boolean {
  try {
    return mapRepo.findAllByMowerSnAndType(sn, 'work').some((w: any) => w.map_area);
  } catch (err) {
    console.error(`[firmware-safety] hasMapsToProtect DB error for ${sn}:`, err);
    return true;
  }
}

/** Newest backup for `sn` whose age is within BACKUP_MAX_AGE_MS, else null. */
function recentBackup(sn: string): BackupEntry | null {
  try {
    const newest = listBackups(sn).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!newest) return null;
    return (Date.now() - newest.createdAt) <= BACKUP_MAX_AGE_MS ? newest : null;
  } catch (err) {
    console.error(`[firmware-safety] listBackups error for ${sn}:`, err);
    return null;
  }
}

/** True when a backup ≤BACKUP_MAX_AGE_MS old already exists (filesystem-only, no MQTT). */
export function hasRecentBackup(sn: string): boolean {
  return recentBackup(sn) !== null;
}

/**
 * Synchronous gate for the MQTT broker path, which must NOT block the event
 * loop with an MQTT round-trip. Returns true if a BETA flash may proceed NOW
 * (not beta, or nothing to lose, or a recent backup already exists). When it
 * returns false it has kicked off a background backup (fire-and-forget) so the
 * stock app's next flash attempt will find a fresh backup and go through.
 * We cannot show the stock app a warning, so "deny once + snapshot, retry works"
 * is the safe behavior — maps are never lost.
 */
export function allowBetaFlashOrSnapshot(sn: string, version: string | null | undefined): boolean {
  if (!isBetaFirmware(version)) return true;
  if (!hasMapsToProtect(sn)) return true;   // nothing to lose
  if (hasRecentBackup(sn)) return true;     // already protected
  // Fire-and-forget: DB synth first, then a live backup fallback (so a mower
  // without a DB-resolvable pose still gets protected on the next retry rather
  // than being denied forever). bestEffortPreFlashBackup swallows its own errors.
  void bestEffortPreFlashBackup(sn);
  return false;
}

/**
 * Guarantee a fresh backup before a BETA mower flash. Stock firmware and
 * chargers should never reach here (callers gate on device type), but stock
 * versions are passed through defensively.
 */
export async function ensureBetaFlashSafe(
  sn: string,
  version: string | null | undefined,
  opts: { force?: boolean } = {},
  T: Translate = translator('en'),
): Promise<BetaFlashGate> {
  if (!isBetaFirmware(version)) return { allowed: true, backup: null, reason: 'not-beta' };

  const recent = recentBackup(sn);
  if (recent) return { allowed: true, backup: recent, reason: 'recent-backup' };

  const backup = await bestEffortPreFlashBackup(sn);
  if (backup) {
    return { allowed: true, backup: backup.entry, reason: backup.live ? 'backup-created-live' : 'backup-created' };
  }

  if (hasMapsToProtect(sn)) {
    // Neither DB synthesis nor a live backup could be produced — typically a
    // mower with no resolvable charging pose anywhere yet (mid-setup, still
    // needs re-anchor). Block by default, but let an explicit operator force
    // proceed: they accept that the maps are not backed up. The firmware OTA
    // swap only replaces /root/novabot and never touches /userdata maps, so a
    // deliberate repair-flash is safe even without a backup.
    if (opts.force) {
      console.warn(`[firmware-safety] ${sn}: no backup possible but force=true → allowing flash (maps NOT backed up).`);
      return { allowed: true, backup: null, reason: 'forced-no-backup' };
    }
    return {
      allowed: false,
      error: 'BACKUP_FAILED',
      detail: T`Kon geen backup maken voor ${sn} terwijl er kaarten zijn, dus het flashen is geblokkeerd. Forceer alleen als je accepteert dat de kaarten niet geback-upt zijn.`,
    };
  }
  return { allowed: true, backup: null, reason: 'no-maps' };
}
