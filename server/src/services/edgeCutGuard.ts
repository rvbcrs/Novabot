/**
 * #147: een randmaaibeurt is een NTCP-doel buiten robot_decision om. Een stop of
 * "naar huis" accepteert robot_decision wel, maar het randdoel rijdt door: de
 * maaier gaf dockfouten terwijl hij ver van het dock verder randmaaide. Zulke
 * commando's stoppen daarom eerst het randdoel (stop_boundary_follow) en gaan
 * pas naar de maaier als cover_task_stop daar landde (die service-aanroep duurt
 * 3 tot 6 s op de maaier). Alle beëindigende commando's wachten tot hetzelfde
 * moment, zodat de go_to_charge die de app 500 ms na stop_navigation stuurt die
 * niet inhaalt.
 */

/** Native commands that end or replace what the mower is doing. */
export const ENDS_EDGE_CUT = new Set([
  'go_to_charge', 'go_pile', 'stop_to_charge',
  'stop_navigation', 'stop_run', 'stop_task',
  'pause_navigation', 'pause_run',
  'start_run', 'start_navigation',
]);

/** mow_zone_drive phases in which the drive itself holds the wheels (nav2
 *  FollowPath / NavigateToPose, outside robot_decision). stop_navigation does
 *  not reach those; only stop_mow_zone ends them. "covering" and later are the
 *  firmware's task again. */
const ZONE_DRIVE_PHASES = new Set(['starting', 'localizing', 'following_unicom', 'entering_zone']);

/** Night patrol phases in which the patrol drive holds the wheels (the
 *  firmware's own departure task while localizing, then nav2 goals), or is
 *  about to: `starting` is the mower's acknowledgement of the start. The drive
 *  process needs 11-15 s to come up and until it reports a phase the cache
 *  still holds the previous run's end, so a stop in that window must already
 *  find a patrol running. The terminal phases done, error and stopped hold
 *  nothing, so the server's own go_to_charge after a finished patrol passes
 *  untouched. */
export const PATROL_DRIVE_PHASES = new Set(['starting', 'localizing', 'patrolling', 'returning']);

/** An ending command while mow_zone_drive or a night patrol drives: kill that
 *  drive too (stop_mow_zone), or the mower keeps going to the zone or the next
 *  checkpoint and starts there (#147 after #148). */
export function endsZoneDrive(command: Record<string, unknown>, mowZonePhase: string | undefined, patrolPhase?: string): boolean {
  const name = Object.keys(command)[0];
  return !!name && ENDS_EDGE_CUT.has(name)
    && (ZONE_DRIVE_PHASES.has(mowZonePhase ?? '') || PATROL_DRIVE_PHASES.has(patrolPhase ?? ''));
}

/** How long ending commands wait after stop_boundary_follow. */
export const EDGE_STOP_SETTLE_MS = 6_000;
/** After a stop, no new round for this long, so the re-sent commands go through. */
const REARM_MS = 30_000;

const settleUntil = new Map<string, number>();
const stoppedAt = new Map<string, number>();

export interface EdgeCutGate {
  /** Send stop_boundary_follow now. */
  stopNow: boolean;
  /** Hold the command this long before it goes to the mower. */
  delayMs: number;
}

export function edgeCutGate(sn: string, command: Record<string, unknown>, edgeActive: boolean, now = Date.now()): EdgeCutGate {
  const name = Object.keys(command)[0];
  if (!name || !ENDS_EDGE_CUT.has(name)) return { stopNow: false, delayMs: 0 };
  const until = settleUntil.get(sn) ?? 0;
  if (now < until) return { stopNow: false, delayMs: until - now };
  if (!edgeActive || now - (stoppedAt.get(sn) ?? -Infinity) < REARM_MS) return { stopNow: false, delayMs: 0 };
  stoppedAt.set(sn, now);
  settleUntil.set(sn, now + EDGE_STOP_SETTLE_MS);
  return { stopNow: true, delayMs: EDGE_STOP_SETTLE_MS };
}

/** Tests only. */
export function _resetEdgeCutGate(): void {
  settleUntil.clear();
  stoppedAt.clear();
}
