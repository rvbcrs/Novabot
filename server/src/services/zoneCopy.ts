/**
 * Zone kopiëren van maaier A naar maaier B.
 * Spec: docs/superpowers/specs/2026-09-24-copy-zone-between-mowers-design.md
 *
 * Twee maaiers delen geen absoluut GPS-frame: elke charger zendt zijn eigen
 * zelf-ingemeten RTK-basispositie uit (live 23 m verschil tussen .244 en
 * .100). De enige betrouwbare koppeling is één fysieke correspondentie, waar
 * het laadstation van A staat in B's frame, met rotatie 0 (beide ENU).
 */
import { db } from '../db/database.js';
import { mapRepo } from '../db/repositories/index.js';
import { pointInPolygon, polygonArea, polygonContains, segIntersects, MIN_WORK_AREA_M2, type XY } from '../maps/editGeometry.js';
import { distanceToPolygon, dockPoint, nextFreeWorkSlot, workSlots } from './canonicalNaming.js';
import { translator, type Translate } from './serverText.js';

/** ponytail: knop. Max afstand dock→zone voor een gegenereerd dockkanaal. */
export const DOCK_MAX_M = 3;
/** Puntafstand in een gegenereerd kanaal. */
export const STEP_M = 0.25;
/** Firmware-cap: map0..map4 (memory multi-map-limit). */
export const MAX_SLOT = 4;

/** Zuivere translatie: p_B = p_A − dockA_in_A + dockA_in_B. */
export function transformPoints(pts: XY[], dockAInA: XY, dockAInB: XY): XY[] {
  const dx = dockAInB.x - dockAInA.x;
  const dy = dockAInB.y - dockAInA.y;
  return pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
}

/** Dichtstbijzijnde punt op de RAND van poly, gezien vanaf p (ook als p erbinnen ligt). */
export function nearestBoundaryPoint(p: XY, poly: XY[]): { point: XY; dist: number } {
  let best = { point: poly[0], dist: Infinity };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.dist) best = { point: q, dist: d };
  }
  return best;
}

/** Raken/overlappen: een hoekpunt in de ander, of snijdende randen. */
export function polygonsOverlap(a: XY[], b: XY[]): boolean {
  if (a.some(p => pointInPolygon(p, b)) || b.some(p => pointInPolygon(p, a))) return true;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segIntersects(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

/**
 * Kortste opening tussen twee polygonen: 0 bij overlap. Voor niet-overlappende
 * polygonen ligt het minimum altijd op een hoekpunt van de een en de rand van
 * de ander, dus hoekpunt→rand in beide richtingen volstaat.
 */
export function polygonGap(a: XY[], b: XY[]): { dist: number; onA: XY; onB: XY } {
  if (polygonsOverlap(a, b)) return { dist: 0, onA: a[0], onB: b[0] };
  let best = { dist: Infinity, onA: a[0], onB: b[0] };
  for (const p of a) {
    const n = nearestBoundaryPoint(p, b);
    if (n.dist < best.dist) best = { dist: n.dist, onA: p, onB: n.point };
  }
  for (const p of b) {
    const n = nearestBoundaryPoint(p, a);
    if (n.dist < best.dist) best = { dist: n.dist, onA: n.point, onB: p };
  }
  return best;
}

/** Lijnstuk p→q kruist de rand van poly, of ligt er helemaal in. */
export function segmentCrossesPolygon(p: XY, q: XY, poly: XY[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (segIntersects(p, q, poly[i], poly[(i + 1) % poly.length])) return true;
  }
  return pointInPolygon(p, poly) && pointInPolygon(q, poly);
}

/** Match the firmware's 1.4 m corridor, including its extended ends and obstacle margin. */
export function channelCorridorBlocked(from: XY, to: XY, obstacles: XY[][]): boolean {
  const halfWidth = 0.7;
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const ux = length ? (to.x - from.x) / length : 1;
  const uy = length ? (to.y - from.y) / length : 0;
  const a = { x: from.x - ux * halfWidth, y: from.y - uy * halfWidth };
  const b = { x: to.x + ux * halfWidth, y: to.y + uy * halfWidth };
  const corridor = [
    { x: a.x - uy * halfWidth, y: a.y + ux * halfWidth },
    { x: b.x - uy * halfWidth, y: b.y + ux * halfWidth },
    { x: b.x + uy * halfWidth, y: b.y - ux * halfWidth },
    { x: a.x + uy * halfWidth, y: a.y - ux * halfWidth },
  ];
  return obstacles.some(o => o.length >= 3 && polygonGap(corridor, o).dist <= 0.1);
}

/** Rechte lijn from→to, verdicht per step; `from` is altijd rij 1 (firmware: dock eerst). */
export function straightChannel(from: XY, to: XY, step: number = STEP_M): XY[] {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(1, Math.ceil(len / step));
  const out: XY[] = [];
  for (let i = 0; i <= n; i++) {
    out.push({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
  }
  return out;
}

/** Inside a work area, lead away from the dock into the lawn, not back to its nearest edge. */
export function dockChannelPoints(dock: XY & { orientation?: number }, work: XY[], obstacles: XY[][]): XY[] | null {
  const inside = pointInPolygon(dock, work);
  const to = inside && Number.isFinite(dock.orientation)
    ? { x: dock.x - 1.2 * Math.cos(dock.orientation!), y: dock.y - 1.2 * Math.sin(dock.orientation!) }
    : nearestBoundaryPoint(dock, work).point;
  const points = straightChannel(dock, to);
  if ((inside && Number.isFinite(dock.orientation) &&
    (points.some(p => !pointInPolygon(p, work)) || work.some((p, i) => segIntersects(dock, to, p, work[(i + 1) % work.length])))) ||
    channelCorridorBlocked(dock, to, obstacles)) return null;
  return points;
}


// ── Regels ────────────────────────────────────────────────────────────────

export interface ExistingZone { slot: number; canonical: string; points: XY[]; obstacles: XY[][] }
export type ChannelKind = 'dock' | 'link';
export interface ChannelPlan {
  canonical: string;
  kind: ChannelKind;
  points: XY[];
  /** Er bestaat al een rij met deze canonieke naam op B; die wordt vervangen. */
  replaces: boolean;
}
export type CopyRefusal = 'slot_limit' | 'target_no_dock' | 'too_far_from_dock' | 'dock_channel_blocked';
export type CopyWarning = 'full_overlap' | 'existing_zones_unlinked';

export interface PlanInput {
  slot: number;
  /** Getransformeerd naar B's frame. */
  work: XY[];
  obstacles: XY[][];
  /** B's bestaande werkgebieden met hun obstakels. */
  existing: ExistingZone[];
  /** Every target obstacle, including obstacles whose owning work row is absent. */
  targetObstacles?: XY[][];
  /** B's dock (anker of live pose). */
  dock: (XY & { orientation?: number }) | null;
  /** Bestaat er al een rij `map<slot>tocharge_unicom` op B (achtergebleven)? */
  dockChannelRowExists: boolean;
}

export interface CopyPlan {
  ok: boolean;
  refusal?: CopyRefusal;
  slot: number;
  canonical: string;
  work: XY[];
  obstacles: { canonical: string; points: XY[] }[];
  channels: ChannelPlan[];
  connectedVia: string | null;
  needsChannel: boolean;
  warnings: CopyWarning[];
  dockDistanceM: number | null;
}

/**
 * A geometric overlap/short gap does not prove a navigable route from the
 * dock. Only propose a checked dock corridor; other connections use the
 * existing explicit channel-drawing flow.
 */
export function planZoneCopy(i: PlanInput): CopyPlan {
  const canonical = `map${i.slot}`;
  const obstacles = i.obstacles.map((points, k) => ({ canonical: `map${i.slot}_${k}_obstacle`, points }));
  const base: CopyPlan = {
    ok: false, slot: i.slot, canonical, work: i.work, obstacles,
    channels: [], connectedVia: null, needsChannel: false, warnings: [], dockDistanceM: null,
  };
  if (i.slot > MAX_SLOT) return { ...base, refusal: 'slot_limit' };
  if (!i.dock) return { ...base, refusal: 'target_no_dock' };
  const dock = i.dock;
  const dockDistanceM = distanceToPolygon(dock, i.work);
  const warnings: CopyWarning[] = [];

  if (i.existing.some(z => polygonContains(i.work, z.points) || polygonContains(z.points, i.work))) warnings.push('full_overlap');
  const allObstacles = [...i.obstacles, ...i.existing.flatMap(z => z.obstacles), ...(i.targetObstacles ?? [])];

  // Stap 2: dockkanaal.
  let dockChannel: ChannelPlan | null = null;
  if (dockDistanceM <= DOCK_MAX_M) {
    const points = dockChannelPoints(dock, i.work, allObstacles);
    if (!points) {
      if (i.slot === 0) return { ...base, refusal: 'dock_channel_blocked', dockDistanceM };
    } else {
      dockChannel = {
        canonical: `map${i.slot}tocharge_unicom`,
        kind: 'dock',
        points,
        replaces: i.dockChannelRowExists,
      };
    }
  } else if (i.slot === 0) {
    return { ...base, refusal: 'too_far_from_dock', dockDistanceM };
  }

  const channels = dockChannel ? [dockChannel] : [];
  if (dockChannel && i.existing.length > 0) warnings.push('existing_zones_unlinked');
  return {
    ...base, ok: true, channels,
    needsChannel: channels.length === 0,
    warnings, dockDistanceM,
  };
}

// ── DB-orkestratie ────────────────────────────────────────────────────────

/** dockAtB verder dan dit van B's eigen dock is een typefout, geen tuin. */
export const MAX_DOCK_DISTANCE_M = 500;

export interface PreviewOk { ok: true; plan: CopyPlan; sourceAlias: string | null; areaM2: number }
export interface PreviewFail {
  ok: false;
  status: 400 | 404 | 409;
  reason: 'bad_canonical' | 'source_not_found' | 'source_no_anchor' | 'bad_dock' | 'dock_too_far' | 'target_no_dock' | 'too_small' | 'polygon_offset_active';
  error: string;
}
export type PreviewResult = PreviewOk | PreviewFail;

function parsePoints(raw: string | null): XY[] {
  if (!raw) return [];
  try {
    const pts = JSON.parse(raw);
    return Array.isArray(pts) ? pts.filter((p: XY) => Number.isFinite(p?.x) && Number.isFinite(p?.y)) : [];
  } catch {
    return [];
  }
}

/** Obstakels van slot N, op volgorde van index. */
function obstaclesOf(sn: string, slot: number): XY[][] {
  const re = new RegExp(`^map${slot}_\\d+_obstacle$`);
  return mapRepo.findAllByMowerSnAndType(sn, 'obstacle')
    .filter(r => re.test(r.canonical_name ?? ''))
    .sort((a, b) => (a.canonical_name ?? '').localeCompare(b.canonical_name ?? '', undefined, { numeric: true }))
    .map(r => parsePoints(r.map_area))
    .filter(p => p.length >= 3);
}


export function previewZoneCopy(
  targetSn: string,
  sourceSn: string,
  sourceCanonical: string,
  dockAtB: { x?: unknown; y?: unknown } | undefined,
  opts: { withObstacles?: boolean; docks?: { source: XY; target: XY & { orientation: number } } } = {},
  T: Translate = translator('en'),
): PreviewResult {
  // Offsets are applied only when exporting CSVs. Copying raw DB geometry
  // would lose A's offset and add B's a second time after a measured placement.
  if ([sourceSn, targetSn].some(sn => {
    const offset = mapRepo.getPolygonOffset(sn);
    return offset.x !== 0 || offset.y !== 0;
  })) {
    return { ok: false, status: 409, reason: 'polygon_offset_active', error: T`Zet de kaartverschuiving van beide maaiers op nul voordat je een zone kopieert.` };
  }
  const m = sourceCanonical.match(/^map(\d+)$/);
  if (!m) return { ok: false, status: 400, reason: 'bad_canonical', error: T`Kies een werkgebied (map0, map1, ...) om te kopiëren.` };
  const src = mapRepo.findBySnAndCanonical(sourceSn, sourceCanonical);
  const srcPts = src && src.map_type === 'work' ? parsePoints(src.map_area) : [];
  if (!src || srcPts.length < 3) {
    return { ok: false, status: 404, reason: 'source_not_found', error: T`Werkgebied ${sourceCanonical} van maaier ${sourceSn} niet gevonden.` };
  }
  const areaM2 = polygonArea(srcPts);
  if (areaM2 < MIN_WORK_AREA_M2) return { ok: false, status: 409, reason: 'too_small', error: T`Het werkgebied is kleiner dan ${MIN_WORK_AREA_M2} m².` };
  const dockAInA = opts.docks?.source ?? dockPoint(sourceSn);
  if (!dockAInA) {
    return { ok: false, status: 409, reason: 'source_no_anchor', error: T`De bronmaaier heeft geen dock-anker (geen map0tocharge_unicom en niet gedockt online); zonder anker is de zone niet te plaatsen.` };
  }
  const x = typeof dockAtB?.x === 'number' ? dockAtB.x : NaN;
  const y = typeof dockAtB?.y === 'number' ? dockAtB.y : NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, status: 400, reason: 'bad_dock', error: T`Geef de positie van het laadstation van de bronmaaier op deze kaart (dockAtB.x/y).` };
  }
  const dockB = opts.docks?.target ?? dockPoint(targetSn);
  if (!dockB) {
    return { ok: false, status: 409, reason: 'target_no_dock', error: T`Het dock van deze maaier is onbekend: zet de maaier op het dock of teken eerst een dockkanaal.` };
  }
  if (Math.hypot(x - dockB.x, y - dockB.y) > MAX_DOCK_DISTANCE_M) {
    return { ok: false, status: 400, reason: 'dock_too_far', error: T`De aangewezen plek ligt meer dan ${MAX_DOCK_DISTANCE_M} m van het dock van deze maaier.` };
  }

  const dockAInB = { x, y };
  const slot = nextFreeWorkSlot(targetSn);
  const work = transformPoints(srcPts, dockAInA, dockAInB);
  const obstacles = opts.withObstacles === false
    ? []
    : obstaclesOf(sourceSn, parseInt(m[1], 10)).map(o => transformPoints(o, dockAInA, dockAInB));
  const existing: ExistingZone[] = workSlots(targetSn)
    .filter(w => w.poly.length >= 3)
    .map(w => ({ slot: w.slot, canonical: `map${w.slot}`, points: w.poly, obstacles: obstaclesOf(targetSn, w.slot) }));
  const plan = planZoneCopy({
    slot, work, obstacles, existing, dock: dockB,
    targetObstacles: mapRepo.findAllByMowerSnAndType(targetSn, 'obstacle').map(o => parsePoints(o.map_area)),
    dockChannelRowExists: !!mapRepo.findBySnAndCanonical(targetSn, `map${slot}tocharge_unicom`),
  });
  const sourceAlias = src.map_name && src.map_name !== sourceCanonical ? src.map_name : null;
  return { ok: true, plan, sourceAlias, areaM2 };
}

export interface PersistResult {
  mapId: string;
  createdAt: string;
  mapMaxMin: { minX: number; maxX: number; minY: number; maxY: number };
  channels: string[];
  obstacles: string[];
}

function bounds(pts: XY[]): PersistResult['mapMaxMin'] {
  return {
    minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)),
    minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y)),
  };
}

/**
 * Schrijft de kopie als DB-rijen (work + obstakels + geaccepteerde kanalen) in
 * één transactie, precies zoals de tekenroute dat doet (source 'drawn', geen
 * file_name). Pushen naar de maaier doet de route (autoPushMapsInBackground).
 */
export function persistZoneCopy(
  targetSn: string,
  plan: CopyPlan,
  opts: { alias: string | null; acceptChannel: boolean; dockOrientation?: number },
): PersistResult {
  if (!plan.ok) throw new Error(`persistZoneCopy: plan is refused (${plan.refusal})`);
  const ts = Date.now();
  const mapId = `copy_${plan.canonical}_${ts}`;
  const create = (canonical: string, mapType: 'work' | 'obstacle' | 'unicom', points: XY[], alias: string | null) => {
    // (mower_sn, canonical_name) is UNIQUE: een achtergebleven rij met deze
    // naam (dockkanaal, of een obstakel van een eerder gewiste zone) wordt
    // vervangen, nooit gedupliceerd.
    const old = mapRepo.findBySnAndCanonical(targetSn, canonical);
    if (old) mapRepo.deleteByIdAndMower(old.map_id, targetSn);
    mapRepo.create({
      source: 'drawn',
      map_id: mapType === 'work' ? mapId : `copy_${canonical}_${ts}`,
      mower_sn: targetSn,
      map_name: alias,
      map_type: mapType,
      map_area: JSON.stringify(points),
      map_max_min: JSON.stringify(bounds(points)),
      canonical_name: canonical,
    });
  };
  const channels = opts.acceptChannel ? plan.channels : [];
  db.transaction(() => {
    if (opts.dockOrientation !== undefined) mapRepo.setPolygonChargingOrientation(targetSn, opts.dockOrientation);
    create(plan.canonical, 'work', plan.work, opts.alias);
    for (const o of plan.obstacles) create(o.canonical, 'obstacle', o.points, null);
    for (const c of channels) create(c.canonical, 'unicom', c.points, null);
  })();
  return {
    mapId,
    createdAt: new Date(ts).toISOString(),
    mapMaxMin: bounds(plan.work),
    channels: channels.map(c => c.canonical),
    obstacles: plan.obstacles.map(o => o.canonical),
  };
}
