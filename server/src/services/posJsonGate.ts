/**
 * Whether the next map push may rewrite the mower's pos.json (the UTM origin
 * of its map frame). sync-info builds that pos.json from the dock pin, and the
 * pin is where the dock sits on the aerial photo: on a mower whose RTK base
 * surveyed itself a metre off, writing it on every push would shift the whole
 * map frame by that metre at the next reboot. So only a flow that set the pin
 * from the docked mower's own GPS on purpose (restore-and-realign) asks for
 * it, for the one sync_map it sends right after.
 */
const TTL_MS = 2 * 60_000;
const until = new Map<string, number>();

export function requestPosJsonWrite(sn: string): void {
  until.set(sn, Date.now() + TTL_MS);
}

export function posJsonRequested(sn: string): boolean {
  return (until.get(sn) ?? 0) > Date.now();
}
