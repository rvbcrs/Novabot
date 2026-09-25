/**
 * Per-mower "frame unvalidated" state. Set when a map bundle is restored
 * (the stored map frame is not yet anchored to the real charger), cleared
 * only by explicit, fresh frame verification. Docking does not rewrite pos.json. While set, go_to_charge
 * is hard-blocked in publishToDevice because navigating the bad frame can
 * drive the mower anywhere. Backed by device_settings so a server restart
 * does not silently unlock go_to_charge.
 */
import { deviceSettingsRepo } from '../db/repositories/deviceSettings.js';
import { dockSamplesRepo } from '../db/repositories/dockSamples.js';

const KEY = 'frame_unvalidated';
const AUTO_RECHARGE_KEY = 'frame_auto_recharge_seen';
const RELOCKED_KEY = 'frame_relocked';
const unvalidated = new Set<string>();
const revisions = new Map<string, number>();
export const getFrameRevision = (sn: string): number => revisions.get(sn) ?? 0;
// Re-anchor lifecycle latch: true once the mower has, since the current
// frame_unvalidated began, left the dock AND reached RUNNING + RTK Fixed against
// the freshly-written origin. Verify (docked map_position vs origin) is only
// meaningful after this - before the relock the docked frame is stale, so a
// verify would test the wrong thing. Reset whenever a new bundle restore marks
// the frame unvalidated (new origin pending) and when the frame is finally
// validated. Persisted so a server restart mid-re-anchor does not lose it.
const relocked = new Set<string>();
// Mowers for which an auto_recharge (pure ArUco dock) command has been issued
// since the flag was set. The flag clears only on a docked report AFTER such a
// command - i.e. the wizard's deliberate re-anchor dock. This prevents stray
// re-docks (e.g. the mower bouncing 1cm off the dock during the backward drive
// and rolling back) from falsely clearing the flag.
const autoRechargeSeen = new Set<string>();

export function loadFrameValidationFromDb(): void {
  unvalidated.clear();
  autoRechargeSeen.clear();
  relocked.clear();
  for (const row of deviceSettingsRepo.listAll()) {
    if (row.key === KEY && row.value === '1') unvalidated.add(row.sn);

    // A restart loses the live cycle and its captured anchor. Require a new cycle.
  }
}

export function markFrameUnvalidated(sn: string): void {
  unvalidated.add(sn);
  revisions.set(sn, getFrameRevision(sn) + 1);
  // A restored or re-anchored frame is a new origin: the dock position
  // before it says nothing about the one after.
  dockSamplesRepo.deleteBySn(sn);
  autoRechargeSeen.delete(sn);
  relocked.delete(sn); // new restore => new origin pending, prior relock void
  deviceSettingsRepo.upsert(sn, KEY, '1');
  deviceSettingsRepo.upsert(sn, AUTO_RECHARGE_KEY, '0');
  deviceSettingsRepo.upsert(sn, RELOCKED_KEY, '0');
}

export function clearFrameUnvalidated(sn: string): void {
  unvalidated.delete(sn);
  autoRechargeSeen.delete(sn);
  relocked.delete(sn); // frame validated => latch consumed
  deviceSettingsRepo.upsert(sn, KEY, '0');
  deviceSettingsRepo.upsert(sn, AUTO_RECHARGE_KEY, '0');
  deviceSettingsRepo.upsert(sn, RELOCKED_KEY, '0');
}

export function isFrameUnvalidated(sn: string): boolean {
  return unvalidated.has(sn);
}

/** Docked map_position must land this close to the dock anchor for the frame to count as right. */
export const FRAME_TOLERANCE_M = 0.4;

export interface DockedFrameCheck {
  ok: boolean;
  reason: 'ok' | 'not_docked' | 'no_rtk_fixed' | 'no_pose' | 'no_anchor' | 'off';
  /** Distance docked position → dock anchor, when both are known. */
  distM: number | null;
}

/**
 * Is the live frame consistent with a map's dock anchor? The same test the
 * re-anchor flow ends with (self-verify), usable BEFORE asking for a re-anchor:
 * a mower docked with RTK Fixed whose map_position lies on the anchor (first
 * point of map0tocharge_unicom) already lives in the map's frame. Pure, so the
 * restore routes and the re-anchor flow share one definition of "right".
 */
export function checkDockedFrame(i: {
  docked: boolean;
  rtkFixed: boolean;
  pose: { x: number; y: number } | null;
  anchor: { x: number; y: number } | null;
  toleranceM?: number;
}): DockedFrameCheck {
  if (!i.docked) return { ok: false, reason: 'not_docked', distM: null };
  if (!i.rtkFixed) return { ok: false, reason: 'no_rtk_fixed', distM: null };
  if (!i.pose || !Number.isFinite(i.pose.x) || !Number.isFinite(i.pose.y)) return { ok: false, reason: 'no_pose', distM: null };
  if (!i.anchor || !Number.isFinite(i.anchor.x) || !Number.isFinite(i.anchor.y)) return { ok: false, reason: 'no_anchor', distM: null };
  const distM = Math.hypot(i.pose.x - i.anchor.x, i.pose.y - i.anchor.y);
  const ok = distM <= (i.toleranceM ?? FRAME_TOLERANCE_M) + 1e-9;
  return { ok, reason: ok ? 'ok' : 'off', distM };
}

/**
 * Latch (or clear) the "has re-locked since the re-anchor began" lifecycle bit.
 * Set true when the auto re-anchor's relock step reaches RUNNING + RTK Fixed off
 * the dock; the verify step is only allowed once this is true and the mower is
 * back on the dock.
 */
export function setReanchorRelocked(sn: string, value: boolean): void {
  if (value) relocked.add(sn);
  else relocked.delete(sn);
  deviceSettingsRepo.upsert(sn, RELOCKED_KEY, value ? '1' : '0');
}

export function isReanchorRelocked(sn: string): boolean {
  return relocked.has(sn);
}

/**
 * Record that an auto_recharge (pure ArUco dock) command was issued for this
 * mower. Only meaningful while unvalidated; arms the clear-on-dock so the next
 * docked report counts as the deliberate re-anchor.
 */
export function noteAutoRecharge(_sn: string): void { /* Dock messages never validate a frame. */ }
export function noteDockState(_sn: string, _docked: boolean): void { /* Explicit fresh verification only. */ }

// Commands that navigate or drive the map frame, and so are dangerous while
// the frame is unvalidated (post bundle-restore, pre re-anchor): the mower
// would move relative to a wrong frame and can drive anywhere. go_to_charge =
// return-to-dock; start_navigation / start_run = start mowing. auto_recharge
// (pure ArUco, no map nav) and go_pile (blade prep) stay allowed.
//
// start_edge_cut hoort hier ook: het rijdt de opgeslagen grenspolygoon van een
// map af (NTCP-coverage met only_edge_mode), dus precies zo frame-afhankelijk
// als start_navigation. Extra reden sinds de rand-dag watcher: dat is de eerste
// volledig autonome aanroeper: die start een randmaai zonder dat er een mens
// kijkt, dus in een niet-gevalideerd frame zou de maaier zelfstandig een grens
// gaan rijden die kilometers naast de tuin kan liggen.
//
// mow_zone hoort er ook bij: dat commando (extended_commands.py) rijdt de
// opgenomen unicom-lijn in het map-frame af en start daarna een coverage-taak,
// dus net zo frame-afhankelijk als start_navigation. Het loopt uitsluitend
// over het extended-kanaal (publishExtendedCommand), waar dezelfde guard nu
// ook op zit.
const FRAME_BLOCKED_KEYS = ['go_to_charge', 'start_navigation', 'start_run', 'start_edge_cut', 'mow_zone'];

/**
 * True when an outbound command must be blocked because the frame is
 * unvalidated. Pure predicate so it is unit-testable without importing the
 * MQTT broker chain.
 */
export function isFrameNavBlocked(sn: string, command: Record<string, unknown>): boolean {
  if (!isFrameUnvalidated(sn)) return false;
  return FRAME_BLOCKED_KEYS.some((k) => k in command);
}
