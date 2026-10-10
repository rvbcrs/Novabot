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
//
// Zones that TOUCH or overlap are already connected without a channel: the
// firmware keeps only channel points outside every work area in csv_file, so a
// channel between touching zones comes out empty, and recording one fails with
// a bare add_scan_map_respond result 1 (field report, Novabot-cn1). A channel
// between zones less than about 1 m apart can fail the same way; a 0.95 m gap
// recorded fine. findCloseZonePairs measures that from the zone outlines.

import { pointInPolygon } from './mapEditGeometry';

type XY = { x: number; y: number };

/** Below this gap a channel recording between two zones may fail. */
export const CHANNEL_MIN_GAP_M = 1;
/** Zones within one map.pgm cell (5 cm) of each other count as touching. */
export const ZONE_TOUCH_M = 0.05;

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
  /** Work-zone outline in local metres. Lets touching zones count as connected. */
  points?: XY[] | null;
}

/** Two work zones that touch, or lie closer than CHANNEL_MIN_GAP_M. */
export interface ZoneProximity {
  a: string;
  b: string;
  /** Shortest distance between the outlines in metres; 0 when they overlap. */
  gapM: number;
  /** gapM <= ZONE_TOUCH_M: already connected, no channel needed. */
  touching: boolean;
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

const isOutline = (pts: XY[] | null | undefined): pts is XY[] =>
  Array.isArray(pts) && pts.length >= 3 && pts.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.y));

type Box = { minX: number; minY: number; maxX: number; maxY: number };
const boxOf = (pts: XY[]): Box => ({
  minX: Math.min(...pts.map(p => p.x)), minY: Math.min(...pts.map(p => p.y)),
  maxX: Math.max(...pts.map(p => p.x)), maxY: Math.max(...pts.map(p => p.y)),
});
const boxGap = (a: Box, b: Box) =>
  Math.hypot(Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minY - b.maxY, b.minY - a.maxY));

function pointSegmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function segmentDistance(a: XY, b: XY, c: XY, d: XY): number {
  const cross = (o: XY, p: XY, q: XY) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

/**
 * Shortest distance between two zone outlines in metres: 0 when they overlap or
 * one lies inside the other. Exact below `limit`; at or above it only "far
 * enough" is known, so the result is then some value >= limit. null when an
 * outline is unusable (fewer than 3 points, or a non-finite vertex).
 */
export function zoneGapMeters(a: XY[], b: XY[], limit = Infinity): number | null {
  if (!isOutline(a) || !isOutline(b)) return null;
  const boxA = boxOf(a), boxB = boxOf(b);
  const far = boxGap(boxA, boxB);
  if (far >= limit) return far;
  if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) return 0;
  // Only edges that come within `limit` of the other outline's box can set the gap.
  const near = (pts: XY[], box: Box) => pts.map((p, i) => [p, pts[(i + 1) % pts.length]] as const)
    .filter(([p, q]) => boxGap(boxOf([p, q]), box) < limit);
  const edgesA = near(a, boxB), edgesB = near(b, boxA);
  let best = Infinity;
  for (const [p, q] of edgesA) {
    for (const [r, s] of edgesB) {
      best = Math.min(best, segmentDistance(p, q, r, s));
      if (best === 0) return 0;
    }
  }
  return Number.isFinite(best) ? best : Math.max(far, limit);
}

/**
 * Work-zone pairs that touch or lie closer than CHANNEL_MIN_GAP_M, measured
 * from their outlines (maps without usable `points` are skipped). Pairs are
 * ordered by slot, e.g. { a: 'map0', b: 'map1' }.
 */
export function findCloseZonePairs(maps: ChannelMapLike[]): ZoneProximity[] {
  const outlines = new Map<string, XY[][]>();
  for (const m of maps) {
    if (m.mapType !== 'work' || !isOutline(m.points)) continue;
    const name = getWorkMapName(m);
    if (name) outlines.set(name, [...(outlines.get(name) ?? []), m.points]);
  }
  const names = [...outlines.keys()].sort((x, y) => mapIndex(x) - mapIndex(y));
  const pairs: ZoneProximity[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      let gap = Infinity;
      for (const pa of outlines.get(names[i])!) {
        for (const pb of outlines.get(names[j])!) {
          gap = Math.min(gap, zoneGapMeters(pa, pb, CHANNEL_MIN_GAP_M) ?? Infinity);
        }
      }
      if (gap < CHANNEL_MIN_GAP_M) {
        pairs.push({ a: names[i], b: names[j], gapM: gap, touching: gap <= ZONE_TOUCH_M });
      }
    }
  }
  return pairs;
}

/** The close/touching entry for one zone pair, in either order. */
export function findZonePair(pairs: ZoneProximity[], x: string, y: string): ZoneProximity | undefined {
  return pairs.find(p => (p.a === x && p.b === y) || (p.a === y && p.b === x));
}

/**
 * Return the work maps that cannot be reached from the dock map (map0) through
 * the unicom channel graph. Each entry pairs the unreachable map with a
 * reachable connection target. Ordered newest-first so the primary gap surfaces
 * at index 0. Returns [] when every zone is reachable — including transitively
 * (e.g. map0<->map1 + map0<->map2 needs no map1<->map2 channel).
 *
 * Zones that touch or overlap (from `points`) count as connected: they need no
 * channel, and one cannot be recorded between them. Pass precomputed
 * `closePairs` to avoid measuring the outlines twice.
 */
export function findMissingChannels(
  maps: ChannelMapLike[],
  closePairs: ZoneProximity[] = findCloseZonePairs(maps),
): MissingChannel[] {
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
  for (const p of closePairs) {
    if (p.touching && workSet.has(p.a) && workSet.has(p.b)) {
      adj.get(p.a)!.add(p.b);
      adj.get(p.b)!.add(p.a);
    }
  }

  // Reachability from the dock map (lowest-index work map, conventionally map0).
  const anchor = workNames[0];
  const reachable = new Set<string>();
  const reach = (start: string) => {
    reachable.add(start);
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const next of adj.get(cur) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          stack.push(next);
        }
      }
    }
  };
  reach(anchor);

  // Suggest a connection for each unreachable zone, oldest -> newest, growing
  // the reachable set as we go: once a suggested channel is drawn that zone
  // joins the network, so the next zone can attach to it (a spanning chain
  // rather than every zone piling onto map0). The target is the nearest
  // already-reachable lower-index zone (map0 is always the fallback). Reported
  // newest-first so the primary gap surfaces at index 0. Everything the new
  // zone already connects to (a channel or a touching zone) joins with it.
  const missing: MissingChannel[] = [];
  for (let i = 1; i < workNames.length; i++) {
    const w = workNames[i];
    if (reachable.has(w)) continue;
    let target = anchor;
    for (const r of reachable) {
      if (mapIndex(r) < mapIndex(w) && mapIndex(r) > mapIndex(target)) target = r;
    }
    missing.push({ from: w, to: target });
    reach(w);
  }
  missing.reverse();
  return missing;
}
