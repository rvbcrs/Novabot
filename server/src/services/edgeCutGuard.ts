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
