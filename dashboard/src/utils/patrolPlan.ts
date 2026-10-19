import type { PatrolRunDto } from '../api/client';
import { offsetPolygon, simplifyPolygon } from './editGeometry';

/**
 * The night patrol's route, and how far a run got along it.
 *
 * The plan is the server's: the checkpoints in driving order, zone by zone, in
 * local map metres (the frame of the zone polygons). The mower numbers the
 * checkpoints it reports 1-based over that flattened order, so a checkpoint's
 * `seq` is its place in `planPoints`.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */

export type PatrolPlanZones = Array<{ zone: string; points: Array<[number, number]> }>;

/** pending: not yet. current: next to visit (a patrol is out). done: reached. skipped: passed or left out. */
export type MarkState = 'pending' | 'current' | 'done' | 'skipped';

export interface PlanPoint { seq: number; zone: string; x: number; y: number; valid: boolean }

/**
 * A plan from the server, tolerant of what is missing: anything that is not a
 * list of zones with points is no plan. Points keep their place (the numbering
 * counts every one), a broken point just cannot be drawn.
 */
export function normalizePlan(raw: unknown): PatrolPlanZones | null {
  if (!Array.isArray(raw)) return null;
  const zones: PatrolPlanZones = [];
  for (const z of raw) {
    if (!z || typeof z !== 'object') continue;
    const { zone, points } = z as { zone?: unknown; points?: unknown };
    if (typeof zone !== 'string' || !Array.isArray(points)) continue;
    zones.push({
      zone,
      points: points.map(p => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [NaN, NaN]) as [number, number]),
    });
  }
  return zones.some(z => z.points.length > 0) ? zones : null;
}

/** The checkpoints in driving order, numbered from 1. */
export function planPoints(plan: PatrolPlanZones | null | undefined): PlanPoint[] {
  const out: PlanPoint[] = [];
  let seq = 0;
  for (const z of plan ?? []) {
    for (const [x, y] of z.points) {
      seq += 1;
      out.push({ seq, zone: z.zone, x, y, valid: Number.isFinite(x) && Number.isFinite(y) });
    }
  }
  return out;
}

export interface MarkInput {
  /**
   * plan: nothing has happened yet (the plan as it stands).
   * live: a patrol is out; the first checkpoint not reached or skipped is the current one.
   * finished: a run from the list; nothing is current any more.
   */
  mode: 'plan' | 'live' | 'finished';
  /** Checkpoints the mower reached (a report, or a photo on the server). */
  reached?: Iterable<number>;
  /** Checkpoints the mower reported as skipped. */
  skippedSeqs?: Iterable<number>;
  /** Zones the mower left out whole: all their checkpoints are skipped. */
  skippedZones?: Iterable<string>;
  /** How a finished run ended, when the server says. */
  endedPhase?: string | null;
  /**
   * The mower's patrol_phase, for `live`. While it is `returning` the loop is
   * over, so no checkpoint is the one it is heading for.
   */
  phase?: string | null;
}

/**
 * The state of every checkpoint. Something reported wins over a guess, and the
 * guesses are the two the data supports: a checkpoint below one the mower did
 * reach was driven past, so it was skipped; and a run that ended `done` but never
 * reached a checkpoint left it out. A run that stopped or failed leaves the rest
 * pending: it never got there.
 */
export function markStates(points: PlanPoint[], input: MarkInput): Map<number, MarkState> {
  const states = new Map<number, MarkState>();
  if (input.mode === 'plan') {
    for (const p of points) states.set(p.seq, 'pending');
    return states;
  }
  const reached = new Set(input.reached ?? []);
  const skipped = new Set(input.skippedSeqs ?? []);
  const skippedZones = new Set(input.skippedZones ?? []);
  const highest = reached.size ? Math.max(...reached) : 0;
  for (const p of points) {
    if (reached.has(p.seq)) states.set(p.seq, 'done');
    else if (skipped.has(p.seq) || skippedZones.has(p.zone)) states.set(p.seq, 'skipped');
    else if (p.seq < highest) states.set(p.seq, 'skipped');
    else if (input.mode === 'finished' && input.endedPhase === 'done') states.set(p.seq, 'skipped');
    else states.set(p.seq, 'pending');
  }
  if (input.mode === 'live' && input.phase !== 'returning') {
    const next = points.find(p => states.get(p.seq) === 'pending');
    if (next) states.set(next.seq, 'current');
  }
  return states;
}

/**
 * The run that is out, and whether the live reports belong to it.
 *
 * The server's view comes first: the newest run, when it has not ended
 * (`endedPhase` null). Live reports name their run, and the ones of another run
 * (the last patrol's, kept across a reconnect or a snapshot that skipped the
 * `starting` phase) must not colour this one: they apply only when they name no
 * run yet or name this one. An older server does not say how runs ended
 * (`endedPhase` missing): the run the reports name is then the best there is.
 * When the server says the newest run has ended, none is out (the list has not
 * caught up with a start), and only reports that name no run apply.
 */
export function pickOutRun<R extends Pick<PatrolRunDto, 'run' | 'endedPhase'>>(
  runs: readonly R[],
  reportsRun: string | null,
): { run: R | undefined; reportsApply: boolean } {
  const newest = runs[0];
  let run: R | undefined;
  if (newest && newest.endedPhase === null) run = newest;
  else if (newest && newest.endedPhase === undefined && reportsRun !== null) run = runs.find(r => r.run === reportsRun);
  return { run, reportsApply: reportsRun === null || reportsRun === run?.run };
}

export interface OverlayPoint { seq: number; x: number; y: number; state: MarkState }
export interface PatrolOverlay { zones: Array<{ zone: string; points: OverlayPoint[] }> }

/**
 * What the map shows of the night patrol, from the patrol panel to the map.
 * `plan`: the panel is open and no patrol is out, the route a start would drive.
 * `live`: a patrol is out. `finished`: the report shows `run`. The route is null
 * without a plan (an older server), and the map can still draw the driven track.
 */
export interface PatrolMapView {
  mode: 'plan' | 'live' | 'finished';
  /** The run the report shows (`finished`); null otherwise. */
  run: string | null;
  overlay: PatrolOverlay | null;
}

/** What the map draws: the plan's points that can be drawn, each with its state, still in zone order. */
export function buildOverlay(plan: PatrolPlanZones | null | undefined, input: MarkInput): PatrolOverlay | null {
  const points = planPoints(plan);
  const states = markStates(points, input);
  const zones: PatrolOverlay['zones'] = [];
  for (const p of points) {
    if (!p.valid) continue;
    let zone = zones[zones.length - 1];
    if (!zone || zone.zone !== p.zone) {
      zone = { zone: p.zone, points: [] };
      zones.push(zone);
    }
    zone.points.push({ seq: p.seq, x: p.x, y: p.y, state: states.get(p.seq) ?? 'pending' });
  }
  return zones.length ? { zones } : null;
}

// ---------------------------------------------------------------------------
// The dashed line is the visiting order. It stays inside the zone and is drawn
// around the recorded obstacles, because nav2 plans in the zone (the map's free
// space) and around them; the exact path is nav2's own.
// ---------------------------------------------------------------------------

export type XY = { x: number; y: number };

const EPS = 1e-9;
/**
 * A recorded border, channel or obstacle has hundreds to thousands of points;
 * it is thinned this much (m) before routing. A drawn line can leave the
 * recorded border by up to that much (seen: 8 cm), about a pixel at garden scale.
 */
const THIN_M = 0.15;

interface Box { minX: number; minY: number; maxX: number; maxY: number }
function boxOf(pts: readonly XY[]): Box {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of pts) {
    if (p.x < box.minX) box.minX = p.x;
    if (p.x > box.maxX) box.maxX = p.x;
    if (p.y < box.minY) box.minY = p.y;
    if (p.y > box.maxY) box.maxY = p.y;
  }
  return box;
}
const inBox = (p: XY, b: Box) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;

function distToSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distToRing(p: XY, poly: readonly XY[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, distToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

function signedArea(poly: readonly XY[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Where a point lies: inside the polygon, on its edge, or outside. */
function sideOf(p: XY, poly: readonly XY[]): 'in' | 'on' | 'out' {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    // On an edge: only an edge whose box holds the point is worth the distance.
    if (p.x >= Math.min(a.x, b.x) - 1e-6 && p.x <= Math.max(a.x, b.x) + 1e-6 && p.y >= Math.min(a.y, b.y) - 1e-6 && p.y <= Math.max(a.y, b.y) + 1e-6
      && distToSegment(p, a, b) < 1e-6) return 'on';
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside ? 'in' : 'out';
}

/** Inside the polygon, its edge excluded: a path may follow an edge. */
const strictlyInside = (p: XY, poly: readonly XY[]) => sideOf(p, poly) === 'in';

/**
 * Where the segment u-v meets the polygon's edges, as fractions along it, with
 * 0 and 1, sorted: the middle of every piece between two cuts is on one side of
 * the polygon, which also settles a segment that only touches corners or runs
 * along an edge.
 */
function cutsAlong(u: XY, v: XY, poly: readonly XY[]): number[] {
  const dx = v.x - u.x, dy = v.y - u.y, len = Math.hypot(dx, dy);
  const minX = Math.min(u.x, v.x) - EPS, maxX = Math.max(u.x, v.x) + EPS, minY = Math.min(u.y, v.y) - EPS, maxY = Math.max(u.y, v.y) + EPS;
  const cuts = [0, 1];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    // An edge whose box misses the segment's box cannot cut it.
    if (Math.max(p.x, q.x) < minX || Math.min(p.x, q.x) > maxX || Math.max(p.y, q.y) < minY || Math.min(p.y, q.y) > maxY) continue;
    const ex = q.x - p.x, ey = q.y - p.y;
    const den = dx * ey - dy * ex;
    // Parallel (or on the same line): the neighbouring edges cut the segment where it meets or leaves this one.
    if (Math.abs(den) < 1e-12 * len * Math.hypot(ex, ey)) continue;
    const t = ((p.x - u.x) * ey - (p.y - u.y) * ex) / den;
    const s = ((p.x - u.x) * dy - (p.y - u.y) * dx) / den;
    if (t >= -EPS && t <= 1 + EPS && s >= -EPS && s <= 1 + EPS) cuts.push(Math.max(0, Math.min(1, t)));
  }
  return cuts.sort((m, n) => m - n);
}

/** Does the segment u-v run through the polygon's inside? */
function blocks(u: XY, v: XY, poly: readonly XY[]): boolean {
  const dx = v.x - u.x, dy = v.y - u.y;
  if (dx * dx + dy * dy < EPS) return strictlyInside(u, poly);
  const cuts = cutsAlong(u, v, poly);
  for (let k = 1; k < cuts.length; k++) {
    if (cuts[k] - cuts[k - 1] <= EPS) continue;
    const m = (cuts[k] + cuts[k - 1]) / 2;
    if (strictlyInside({ x: u.x + dx * m, y: u.y + dy * m }, poly)) return true;
  }
  return false;
}

/**
 * The length of the segment u-v outside every one of the polygons (their edges
 * count as inside), or any value above `limit` once that much is outside.
 */
function outsideLength(u: XY, v: XY, polys: readonly (readonly XY[])[], limit = Infinity): number {
  const dx = v.x - u.x, dy = v.y - u.y, len = Math.hypot(dx, dy);
  if (len * len < EPS) return 0;
  const cuts = polys.flatMap(poly => cutsAlong(u, v, poly)).sort((m, n) => m - n);
  let out = 0;
  for (let k = 1; k < cuts.length && out <= limit; k++) {
    if (cuts[k] - cuts[k - 1] <= EPS) continue;
    const m = (cuts[k] + cuts[k - 1]) / 2, mid = { x: u.x + dx * m, y: u.y + dy * m };
    if (polys.every(poly => sideOf(mid, poly) === 'out')) out += (cuts[k] - cuts[k - 1]) * len;
  }
  return out;
}

/** A ring that still has more bends than this after thinning is noise, not a border: routing it would stall the map. */
const RING_MAX = 1000;

/**
 * A ring thinned to THIN_M (Douglas-Peucker), or null for one that is not a
 * usable border: a regular zigzag of thousands of points keeps every tooth
 * (each is bigger than THIN_M) or overflows the recursion. The map draws no
 * line for such a zone rather than going blank or stalling on it.
 */
function thinRing(pts: XY[]): XY[] | null {
  try {
    const ring = simplifyPolygon(pts, THIN_M);
    return ring.length > RING_MAX ? null : ring;
  } catch {
    return null;
  }
}

/** The convex hull (monotone chain), counter-clockwise; repeated and collinear points drop out on their own. */
function convexHull(points: readonly XY[]): XY[] {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  if (pts.length < 3) return pts;
  const half = (list: readonly XY[]): XY[] => {
    const out: XY[] = [];
    for (const p of list) {
      while (out.length >= 2 && (out[out.length - 1].x - out[out.length - 2].x) * (p.y - out[out.length - 2].y) - (out[out.length - 1].y - out[out.length - 2].y) * (p.x - out[out.length - 2].x) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/**
 * A convex polygon moved outwards by d: every corner along the bisector of its
 * two edges (a mitre, at most 3 d long), so a square stays a square.
 */
function inflate(hull: readonly XY[], d: number): readonly XY[] {
  if (!(d > 0)) return hull;
  const n = hull.length;
  // The hull is counter-clockwise: an edge (dx, dy) has its outward normal at (dy, -dx).
  const normal = (p: XY, q: XY): XY => {
    const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy);
    return { x: dy / len, y: -dx / len };
  };
  return hull.map((p, i) => {
    const n1 = normal(hull[(i - 1 + n) % n], p);
    const n2 = normal(p, hull[(i + 1) % n]);
    const mx = n1.x + n2.x, my = n1.y + n2.y, ml = Math.hypot(mx, my);
    if (ml < 1e-6) return { x: p.x + n1.x * d, y: p.y + n1.y * d };   // a spike that turns back on itself
    const cos = Math.max((mx * n1.x + my * n1.y) / ml, 1 / 3);
    return { x: p.x + (mx / ml) * (d / cos), y: p.y + (my / ml) * (d / cos) };
  });
}

interface Obstacle {
  /** The convex hull of the recorded obstacle: the part nothing may enter. */
  raw: readonly XY[];
  /** The hull grown by the margin: the part a line keeps out of. */
  grown: readonly XY[];
  box: Box;
  /** The recorded shape itself, thinned, and grown by the margin: for an end that stands in a hollow of the hull (an L, a U). */
  ring: readonly XY[];
  ringGrown: readonly XY[];
  ringBox: Box;
}

/** Obstacles made ready for routeAround: see prepareObstacles. */
export interface PreparedObstacles { readonly hulls: readonly Obstacle[] }

/**
 * The obstacles of one set, ready to route around: each one's convex hull
 * (recorded obstacles are dense rings of dozens or hundreds of points; the
 * hull is the same footprint for a line that has to keep clear of it, and a
 * fraction of the work), grown by `clearM`, with its bounding box. Make this
 * once for a set and give it to every routeAround.
 */
export function prepareObstacles(obstacles: readonly (readonly XY[])[], clearM: number): PreparedObstacles {
  const hulls: Obstacle[] = [];
  for (const o of obstacles) {
    const pts = o.filter(p => Number.isFinite(p.x + p.y));
    const raw = convexHull(pts);
    if (raw.length < 3) continue;   // nothing with an inside
    const grown = inflate(raw, clearM);
    // A recorded shape that is no usable ring counts as its hull.
    const ring = thinRing(pts) ?? raw;
    const ringGrown = ring === raw ? grown : offsetPolygon(ring, clearM);
    hulls.push({ raw, grown, box: boxOf(grown), ring, ringGrown, ringBox: boxOf(ringGrown) });
  }
  return { hulls };
}

/**
 * What of an obstacle counts in one call: its hull with the margin, or, when
 * an end stands in a hollow of the hull (an L, a U), the recorded shape with
 * its margin, so the line leaves the hollow instead of cutting through.
 */
interface Active { inner: readonly XY[]; outer: readonly XY[]; box: Box; convex: boolean }

function activeFor(a: XY, b: XY, hulls: readonly Obstacle[]): Active[] {
  return hulls.map(h => {
    const hollow = [a, b].some(e => inBox(e, h.box) && strictlyInside(e, h.raw) && !strictlyInside(e, h.ring));
    return hollow
      ? { inner: h.ring, outer: h.ringGrown, box: h.ringBox, convex: false }
      : { inner: h.raw, outer: h.grown, box: h.box, convex: true };
  });
}

type BlockedBy = (k: number, u: XY, v: XY, usesA: boolean, usesB: boolean) => boolean;

/**
 * Whether obstacle k blocks the segment u-v. An end that stands in an obstacle's
 * margin leaves it past the obstacle itself; one that stands in the obstacle
 * leaves freely.
 */
function blockedByFor(a: XY, b: XY, active: readonly Active[]): BlockedBy {
  const rule = (e: XY) => active.map(o => (inBox(e, o.box) && strictlyInside(e, o.outer) ? (strictlyInside(e, o.inner) ? null : o.inner) : undefined));
  const aRule = rule(a), bRule = rule(b);
  return (k, u, v, usesA, usesB) => {
    const { box, outer } = active[k];
    if (Math.max(u.x, v.x) < box.minX || Math.min(u.x, v.x) > box.maxX || Math.max(u.y, v.y) < box.minY || Math.min(u.y, v.y) > box.maxY) return false;
    const ra = usesA ? aRule[k] : undefined;
    const rb = usesB ? bRule[k] : undefined;
    if (ra === null || rb === null) return false;
    return blocks(u, v, ra ?? rb ?? outer);
  };
}

/** The nodes of a visibility graph: the points, and for each the obstacle it is a corner of and its place on it (-1: none). */
interface Graph { nodes: XY[]; owner: number[]; slot: number[] }

/** The corners of the obstacles in `set` added to the graph; a corner inside another obstacle of the set is no place to turn. */
function addCorners(g: Graph, set: readonly number[], active: readonly Active[]): void {
  for (const k of set) {
    active[k].outer.forEach((v, i) => {
      if (set.some(j => j !== k && inBox(v, active[j].box) && strictlyInside(v, active[j].outer))) return;
      g.nodes.push(v); g.owner.push(k); g.slot.push(i);
    });
  }
}

/**
 * Do two corners of one obstacle see each other? On a convex one along an edge
 * only (any other pair is a line through it); on a hollow one when the line
 * between them stays out of it.
 */
function cornersSee(g: Graph, u: number, v: number, active: readonly Active[]): boolean {
  const { outer, convex } = active[g.owner[u]];
  if (!convex) return !blocks(g.nodes[u], g.nodes[v], outer);
  const gap = Math.abs(g.slot[u] - g.slot[v]);
  return gap === 1 || gap === outer.length - 1;
}

/** The shortest path from node 0 to node 1 over the visible pairs, as node indices; null when 1 is out of reach. */
function dijkstra(nodes: readonly XY[], visible: (u: number, v: number) => boolean): number[] | null {
  if (visible(0, 1)) return [0, 1];
  const dist = nodes.map(() => Infinity), from = nodes.map(() => -1), done = nodes.map(() => false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === 1) break;
    done[u] = true;
    for (let v = 0; v < nodes.length; v++) {
      if (done[v]) continue;
      const w = dist[u] + Math.hypot(nodes[v].x - nodes[u].x, nodes[v].y - nodes[u].y);
      if (w < dist[v] && visible(u, v)) { dist[v] = w; from[v] = u; }
    }
  }
  if (from[1] < 0) return null;
  const path: number[] = [];
  for (let i = 1; i !== -1; i = from[i]) path.unshift(i);
  return path;
}

/**
 * A polyline from a to b that keeps clear of the obstacles (all in one frame,
 * metres): [a, b] when the straight line is clear, else the shortest way round
 * their hulls' corners (a visibility graph, Dijkstra). Planned with the obstacles
 * that really are in the way; one the detour then runs into joins in, until none
 * does. An end that stands in an obstacle's margin still gets a path. `clearM`
 * only counts when `obstacles` is not already prepared.
 */
export function routeAround(a: XY, b: XY, obstacles: readonly (readonly XY[])[] | PreparedObstacles, clearM = 0.6): XY[] {
  if (!Number.isFinite(a.x + a.y + b.x + b.y)) return [a, b];
  const { hulls } = 'hulls' in obstacles ? obstacles : prepareObstacles(obstacles, clearM);
  if (!hulls.length) return [a, b];
  const active = activeFor(a, b, hulls);
  const blockedBy = blockedByFor(a, b, active);

  // The obstacles that really are in the way of the straight line.
  const used = new Set<number>();
  active.forEach((_, k) => { if (blockedBy(k, a, b, true, true)) used.add(k); });
  if (!used.size) return [a, b];

  for (;;) {
    const set = [...used];
    const g: Graph = { nodes: [a, b], owner: [-1, -1], slot: [-1, -1] };
    addCorners(g, set, active);
    const visible = (u: number, v: number): boolean => {
      for (const k of set) {
        if (g.owner[u] === k && g.owner[v] === k) {
          if (!cornersSee(g, u, v, active)) return false;
        } else if (blockedBy(k, g.nodes[u], g.nodes[v], u === 0 || v === 0, u === 1 || v === 1)) {
          return false;
        }
      }
      return true;
    };
    // Out of reach (an end shut in by obstacles that touch): the mower reports that checkpoint skipped.
    const path = (dijkstra(g.nodes, visible) ?? [0, 1]).map(i => g.nodes[i]);
    const hit = active.flatMap((_, k) => (!used.has(k) && path.some((p, i) => i > 0 && blockedBy(k, path[i - 1], p, i === 1, i === path.length - 1)) ? [k] : []));
    if (!hit.length) return path;
    hit.forEach(k => used.add(k));   // every round adds at least one, so this ends
  }
}

// ---- inside the zone ----

/** How far inside the zone's border the dashed line turns its corners. */
export const ZONE_INSET_M = 0.3;
/**
 * How far outside the zones the line to a channel's end may run, at least: a
 * recorded channel starts at the zone's border, or just past it. An end further
 * out gets its own distance to the nearest zone and half a metre more, up to
 * CHANNEL_REACH_MAX_M; beyond that the channel is not where the zones are.
 */
export const CHANNEL_REACH_M = 1.5;
export const CHANNEL_REACH_MAX_M = 5;

/** A zone made ready for routeWithin: see prepareZone. */
export interface PreparedZone {
  /** The thinned border: what the line stays inside of. */
  readonly ring: readonly XY[];
  /** The inward corners of the border, `ZONE_INSET_M` inside where there is room: where the line may turn. */
  readonly corners: readonly XY[];
  readonly box: Box;
}

/**
 * A zone's border, thinned, with its inward corners moved inside by `insetM`
 * (half that, or the corner itself, where the zone is too narrow for it). Only
 * inward corners count: a shortest way through a zone turns nowhere else.
 */
export function prepareZone(poly: readonly XY[], insetM = ZONE_INSET_M): PreparedZone | null {
  const pts = poly.filter(p => Number.isFinite(p.x + p.y));
  if (pts.length < 3) return null;
  const ring = thinRing(pts);
  if (!ring || ring.length < 3 || Math.abs(signedArea(ring)) < EPS) return null;
  const ccw = signedArea(ring) > 0;
  const inset = offsetPolygon(ring, -insetM), half = offsetPolygon(ring, -insetM / 2);
  const corners: XY[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[(i - 1 + n) % n], q = ring[i], r = ring[(i + 1) % n];
    const cross = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
    if (ccw ? cross >= -EPS : cross <= EPS) continue;   // an outward corner, or none
    corners.push([inset[i], half[i]].find(c => sideOf(c, ring) === 'in') ?? q);
  }
  return { ring, corners, box: boxOf(ring) };
}

/** A recorded channel thinned to a point every metre (its ends kept): the bends the line follows between two zones. */
export function prepareRail(points: readonly XY[], stepM = 1): XY[] {
  const pts = points.filter(p => Number.isFinite(p.x + p.y));
  if (pts.length < 2) return [];
  const out = [pts[0]];
  for (const p of pts.slice(1, -1)) {
    const last = out[out.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= stepM) out.push(p);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * A polyline from a to b that stays inside the zones and clear of the obstacles
 * (all in one frame, metres): one zone for a leg within it; two, with the
 * recorded channels between them, for the crossing from one zone to the next.
 * The shortest way through the zones' inward corners, the channels' bends and
 * the obstacles' corners. A channel is followed bend to bend whatever it
 * crosses, and the line to its end may run outside the zones as far as that
 * end stands from them (CHANNEL_REACH_M at least, CHANNEL_REACH_MAX_M at most).
 * null when an end lies outside every zone, or no such line exists (zones that
 * do not touch and no channel between them).
 */
export function routeWithin(
  a: XY, b: XY, zones: readonly PreparedZone[], obstacles: PreparedObstacles, rails: readonly (readonly XY[])[] = [],
): XY[] | null {
  if (!Number.isFinite(a.x + a.y + b.x + b.y) || !zones.length) return null;
  const rings = zones.map(z => z.ring);
  const fromZones = (p: XY) => Math.min(...zones.map(z => (inBox(p, z.box) && sideOf(p, z.ring) !== 'out' ? 0 : distToRing(p, z.ring))));
  if (fromZones(a) > 0 || fromZones(b) > 0) return null;
  const active = activeFor(a, b, obstacles.hulls);
  const blockedBy = blockedByFor(a, b, active);

  // The fixed nodes: the ends, the zones' corners, the channels' bends (each knowing its channel, its place on it and, for an end, its reach).
  const fixed: XY[] = [a, b, ...zones.flatMap(z => z.corners)];
  const railOf = fixed.map(() => -1), railAt = fixed.map(() => -1), railReach = fixed.map(() => 0);
  rails.forEach((r, k) => r.forEach((p, i) => {
    fixed.push(p); railOf.push(k); railAt.push(i);
    railReach.push(i === 0 || i === r.length - 1 ? Math.max(CHANNEL_REACH_M, Math.min(CHANNEL_REACH_MAX_M, fromZones(p) + 0.5)) : 0);
  }));
  const rail = (i: number) => railOf[i] ?? -1;
  const alongRail = (u: number, v: number) => rail(u) >= 0 && rail(u) === rail(v) && Math.abs(railAt[u] - railAt[v]) === 1;
  const reach = (u: number, v: number) => (rail(v) < 0 && railReach[u] ? railReach[u] : rail(u) < 0 && railReach[v] ? railReach[v] : 1e-6);

  const used = new Set<number>();
  active.forEach((_, k) => { if (blockedBy(k, a, b, true, true)) used.add(k); });
  for (;;) {
    const set = [...used];
    const g: Graph = { nodes: [...fixed], owner: fixed.map(() => -1), slot: fixed.map(() => -1) };
    addCorners(g, set, active);
    const visible = (u: number, v: number): boolean => {
      if (alongRail(u, v)) return true;
      for (const k of set) {
        if (g.owner[u] === k && g.owner[v] === k) {
          if (!cornersSee(g, u, v, active)) return false;
        } else if (blockedBy(k, g.nodes[u], g.nodes[v], u === 0 || v === 0, u === 1 || v === 1)) {
          return false;
        }
      }
      const allowed = reach(u, v);
      return outsideLength(g.nodes[u], g.nodes[v], rings, allowed) <= allowed;
    };
    const path = dijkstra(g.nodes, visible);
    if (!path) return null;
    const hit = active.flatMap((_, k) => (!used.has(k) && path.some((p, i) => i > 0 && !alongRail(path[i - 1], p)
      && blockedBy(k, g.nodes[path[i - 1]], g.nodes[p], i === 1, i === path.length - 1)) ? [k] : []));
    if (!hit.length) return path.map(i => g.nodes[i]);
    hit.forEach(k => used.add(k));   // every round adds at least one, so this ends
  }
}

/** The plan's checkpoints per zone, coordinates only: what the routes depend on. */
export type PlanGeometry = ReadonlyArray<readonly [string, ReadonlyArray<readonly [number, number]>]>;
/** A recorded channel, thinned (prepareRail), and the two zones it joins. */
export interface PlanRail { zones: readonly [string, string]; rail: readonly XY[] }
/**
 * What the map draws for one zone of the plan: the dashed line through its
 * checkpoints in pieces (a leg that has no line inside the zone breaks it),
 * and the crossing to the next zone, or null.
 */
export interface ZoneRoutes { zone: string; pieces: XY[][]; crossing: XY[] | null }

/**
 * The lines of the plan. Every line stays inside the zone (routeWithin): a
 * zone the map does not know (an older report of a zone since deleted), or a
 * leg routeWithin cannot place (a checkpoint outside the zone as it is now),
 * gets no line at all, never one around the obstacles only. The crossing
 * follows a channel between the two zones, or nothing.
 */
export function planRoutes(geometry: PlanGeometry, zones: ReadonlyMap<string, PreparedZone>, rails: readonly PlanRail[], obstacles: PreparedObstacles): ZoneRoutes[] {
  return geometry.map(([zone, coords], i) => {
    const points = coords.map(([x, y]): XY => ({ x, y }));
    const here = zones.get(zone);
    const pieces: XY[][] = [];
    if (here && points.length) {
      let piece: XY[] = [points[0]];
      for (let k = 1; k < points.length; k++) {
        const leg = routeWithin(points[k - 1], points[k], [here], obstacles);
        if (leg) {
          piece.push(...leg.slice(1));
        } else {
          if (piece.length > 1) pieces.push(piece);
          piece = [points[k]];
        }
      }
      if (piece.length > 1) pieces.push(piece);
    }
    const next = geometry[i + 1];
    let crossing: XY[] | null = null;
    if (here && next && next[1].length && points.length) {
      const there = zones.get(next[0]);
      const between = rails.filter(r => r.zones.includes(zone) && r.zones.includes(next[0])).map(r => r.rail);
      if (there) crossing = routeWithin(points[points.length - 1], { x: next[1][0][0], y: next[1][0][1] }, [here, there], obstacles, between);
    }
    return { zone, pieces, crossing };
  });
}

/**
 * How a run ended, as the UI says it. `out`: a patrol is out right now and this
 * is the newest run, so a run the server has not ended is the one driving.
 * null: the server does not say (an older one).
 */
export function runEnding(run: Pick<PatrolRunDto, 'endedPhase'>, out: boolean): 'done' | 'stopped' | 'error' | 'running' | 'unknown' | null {
  const p = run.endedPhase;
  if (p === 'done' || p === 'stopped' || p === 'error') return p;
  if (out) return 'running';
  return p === null ? 'unknown' : null;
}

export interface RunSummary {
  reached: number;
  /** Checkpoints in the run's plan; null when the server sent none. */
  total: number | null;
  /** Checkpoints left out; null without a plan (nothing to compare with). */
  skipped: number | null;
  /** Checkpoints where a person / an animal reached the alert level. */
  persons: number;
  animals: number;
}

export function summarizeRun(run: Pick<PatrolRunDto, 'frames' | 'plan' | 'endedPhase'>): RunSummary {
  const frames = run.frames ?? [];
  const reachedSeqs = new Set(frames.map(f => f.seq));
  const points = planPoints(normalizePlan(run.plan));
  let skipped: number | null = null;
  if (points.length) {
    const states = markStates(points, { mode: 'finished', reached: reachedSeqs, endedPhase: run.endedPhase });
    skipped = [...states.values()].filter(s => s === 'skipped').length;
  }
  return {
    reached: reachedSeqs.size,
    total: points.length || null,
    skipped,
    persons: frames.filter(f => f.seen?.includes('person')).length,
    animals: frames.filter(f => f.seen?.includes('animal')).length,
  };
}
