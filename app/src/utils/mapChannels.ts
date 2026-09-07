// Detect work maps the mower cannot REACH from the dock map (map0) through the
// unicom "channel" graph. The mower drives between zones over explicit
// mapXtomapY_N_unicom corridors (the firmware records each from a driven
// trajectory and rasterises it into a ~1 m corridor via unicom_area_radius).
//
// Connectivity is TRANSITIVE. With channels map0<->map1 and map0<->map2 the
// mower can still drive map1 -> map0 -> map2, so a direct map1<->map2 channel is
// NOT required. We therefore flag a zone only when it is genuinely unreachable
// from map0 through the channel graph — NOT merely because an adjacent-index
// pair (map1, map2) lacks a direct channel. The latter was a false positive:
// the stock app and the mower handle hub-and-spoke layouts fine (see issue #97).
// A truly disconnected zone surfaces as nav2 "no valid path to goal" (Error 127)
// when a coverage task targets it.

export interface ChannelMapLike {
  mapType: string;
  /** Firmware slot identifier (e.g. "map0", "map0tomap1_0_unicom"). The
   *  authoritative, typed source. Falls back to fileName / mapName. */
  canonicalName?: string | null;
  mapName?: string | null;
  fileName?: string | null;
  /** Confirmed offline channel endpoints, before its firmware filename arrives. */
  connectedMaps?: [string, string];
  /** Number of geometry points. A unicom row with fewer than 2 points (a
   *  0-byte / metadata-only connector, e.g. after a polygon-only restore) is
   *  NOT a navigable channel, so it does not connect its two maps. When
   *  undefined the geometry is assumed present (caller pre-filtered). */
  pointCount?: number;
}

export interface MissingChannel {
  /** The unreachable work map — the scan starts here (the firmware uses the
   *  position at add_scan_map time as the "from" side). */
  from: string;
  /** A reachable map to connect it to (nearest lower-index reachable map, or
   *  the dock map map0). Drive into this one to close the gap. */
  to: string;
}

export function getWorkMapName(m: ChannelMapLike): string | null {
  return (
    m.canonicalName?.match(/^(map\d+)/)?.[1] ??
    m.fileName?.match(/^(map\d+)/)?.[1] ??
    m.mapName?.match(/^(map\d+)/)?.[1] ??
    null
  );
}

/** The two work maps a unicom connector joins, e.g.
 *  "map0tomap1_0_unicom" -> ["map0","map1"]. Charge connectors
 *  ("map0tocharge_unicom") return null — they join the charger, not a work map. */
export function getUnicomPair(m: ChannelMapLike): [string, string] | null {
  const pair = m.connectedMaps;
  if (Array.isArray(pair) && pair.length === 2 && pair[0] !== pair[1]
      && pair.every(name => typeof name === 'string' && /^map\d+$/.test(name))) {
    return [pair[0], pair[1]];
  }
  const name = m.canonicalName ?? m.fileName ?? m.mapName ?? '';
  const match = name.match(/(map\d+)to(map\d+)/);
  return match ? [match[1], match[2]] : null;
}

const mapIndex = (name: string): number => parseInt(name.slice(3), 10);

/**
 * Return the work maps that cannot be reached from the dock map (map0) through
 * the unicom channel graph. Each entry pairs the unreachable map with a
 * reachable connection target. Ordered newest-first so the primary gap surfaces
 * at index 0. Returns [] when every zone is reachable — including transitively
 * (e.g. map0<->map1 + map0<->map2 needs no map1<->map2 channel).
 */
export function findMissingChannels(maps: ChannelMapLike[]): MissingChannel[] {
  const workNames = Array.from(
    new Set(
      maps
        .filter((m) => m.mapType === 'work')
        .map(getWorkMapName)
        .filter((v): v is string => !!v),
    ),
  ).sort((a, b) => mapIndex(a) - mapIndex(b));

  if (workNames.length <= 1) return [];

  // Undirected channel graph among work maps.
  const workSet = new Set(workNames);
  const adj = new Map<string, Set<string>>();
  for (const w of workNames) adj.set(w, new Set());
  for (const m of maps) {
    if (m.mapType !== 'unicom') continue;
    if ((m.pointCount ?? Infinity) < 2) continue; // metadata-only connector is not navigable
    const pair = getUnicomPair(m);
    if (!pair) continue;
    const [a, b] = pair;
    if (workSet.has(a) && workSet.has(b)) {
      adj.get(a)!.add(b);
      adj.get(b)!.add(a);
    }
  }

  // Reachability from the dock map (lowest-index work map, conventionally map0).
  const anchor = workNames[0];
  const reachable = new Set<string>([anchor]);
  const stack = [anchor];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of adj.get(cur) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        stack.push(next);
      }
    }
  }

  // Suggest a connection for each unreachable zone, oldest -> newest, growing
  // the reachable set as we go: once a suggested channel is drawn that zone
  // joins the network, so the next zone can attach to it (a spanning chain
  // rather than every zone piling onto map0). The target is the nearest
  // already-reachable lower-index zone (map0 is always the fallback). Reported
  // newest-first so the primary gap surfaces at index 0.
  const missing: MissingChannel[] = [];
  for (let i = 1; i < workNames.length; i++) {
    const w = workNames[i];
    if (reachable.has(w)) continue;
    let target = anchor;
    for (const r of reachable) {
      if (mapIndex(r) < mapIndex(w) && mapIndex(r) > mapIndex(target)) target = r;
    }
    missing.push({ from: w, to: target });
    reachable.add(w);
  }
  missing.reverse();
  return missing;
}
