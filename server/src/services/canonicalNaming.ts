// Canonieke firmware-namen voor kaarten die in het DASHBOARD getekend worden.
//
// De maaier kent alleen slot-namen: `mapN` (werkgebied), `mapN_M_obstacle`,
// `mapAtomapB_K_unicom`, `mapNtocharge_unicom`. Een in het dashboard getekende
// rij had alleen een gebruikersnaam ("Werkgebied 4", "Kanaal 1"), en daardoor:
//   - kreeg een werkgebied pas bij ZIP-generatie een willekeurig vrij slot;
//   - werd een kanaal STIL WEGGEGOOID (generateMapZipFromDb matcht op
//     /^map\d+to.+unicom/), dus het bereikte de maaier nooit.
//
// Namen hoeven niet geraden te worden: het slot is het eerste vrije nummer en
// een kanaal ligt per definitie tussen twee bekende gebieden. Daarom leiden we
// de canonieke naam hier af uit de GEOMETRIE en schrijven we hem meteen naar
// maps.canonical_name, zodat dashboard, ZIP en maaier dezelfde identiteit zien.
// Typt de gebruiker zelf een canonieke naam, dan wint die: expliciet is geen
// gok (issue #114: een kanaal naar het laadstation moet handmatig te maken zijn
// als de server het station nog niet kent).
//
// Foutteksten zijn Engels: het dashboard is Engelstalig en de melding komt
// letterlijk in beeld bij gebruikers buiten Nederland.
import { mapRepo } from '../db/repositories/index.js';
import type { MapRow } from '../db/repositories/maps.js';
import { pointInPolygon, type XY } from '../maps/editGeometry.js';
import { getPolygonAnchor } from './anchor.js';
import { getDockPose } from '../mqtt/sensorData.js';

/** Een eindpunt dat hier vlakbij ligt hoort bij het laadstation, niet bij een gebied. */
const DOCK_RADIUS_M = 2.5;
/** Een eindpunt dat net buiten een gebied ligt (tekenonnauwkeurigheid) hoort er nog bij. */
const SNAP_RADIUS_M = 5;

export type NamingResult =
  | {
      ok: true;
      canonical: string;
      /** Bestaande rij die deze nieuwe vervangt (canonieke naam is uniek). */
      replaces?: string;
      /** Punten in de volgorde/positie waarin ze OPGESLAGEN moeten worden, als die afwijkt van het getekende. */
      points?: XY[];
    }
  | { ok: false; error: string };

interface WorkSlot {
  slot: number;
  poly: XY[];
}

/** Slotnummer uit de canonieke naam van een werkgebied-rij ("map3" → 3). */
function slotOfWorkRow(r: MapRow): number | null {
  for (const n of [r.canonical_name, r.map_name, r.file_name]) {
    const m = n?.match(/^map(\d+)(_work)?(\.csv)?$/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function parsePoints(raw: string | null): XY[] {
  if (!raw) return [];
  try {
    const pts = JSON.parse(raw);
    return Array.isArray(pts) ? pts.filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y)) : [];
  } catch {
    return [];
  }
}

function workSlots(sn: string): WorkSlot[] {
  const out: WorkSlot[] = [];
  for (const row of mapRepo.findByMowerSnAndType(sn, 'work')) {
    const slot = slotOfWorkRow(row);
    if (slot === null) continue;
    out.push({ slot, poly: parsePoints(row.map_area) });
  }
  return out.sort((a, b) => a.slot - b.slot);
}

/** Het laagste nog niet gebruikte werkgebied-slot. */
export function nextFreeWorkSlot(sn: string): number {
  const taken = new Set(workSlots(sn).map(w => w.slot));
  let n = 0;
  while (taken.has(n)) n++;
  return n;
}

/** Laadstation in lokale meters: eerste punt van het to-charge kanaal, anders de live dock-pose. */
function dockPoint(sn: string): XY | null {
  try {
    const anchor = getPolygonAnchor(sn);
    if (anchor) return { x: anchor.x, y: anchor.y };
    const dock = getDockPose(sn);
    if (dock && (dock.x !== 0 || dock.y !== 0)) return { x: dock.x, y: dock.y };
  } catch {
    // Geen dock-pose bekend: het kanaal wordt dan als map↔map beoordeeld.
  }
  return null;
}

function dist(a: XY, b: XY): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Kortste afstand van p tot de rand van poly (0 als p erbinnen ligt). */
function distanceToPolygon(p: XY, poly: XY[]): number {
  if (poly.length < 3) return Infinity;
  if (pointInPolygon(p, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    best = Math.min(best, dist(p, { x: a.x + t * dx, y: a.y + t * dy }));
  }
  return best;
}

/** Het werkgebied waar dit punt in (of vlak bij) ligt. */
function slotAt(p: XY, slots: WorkSlot[]): number | null {
  let best: { slot: number; d: number } | null = null;
  for (const w of slots) {
    const d = distanceToPolygon(p, w.poly);
    if (d <= SNAP_RADIUS_M && (!best || d < best.d)) best = { slot: w.slot, d };
  }
  return best?.slot ?? null;
}

/**
 * Twee VERSCHILLENDE gebieden voor de uiteinden van een kanaal, met de kleinste
 * totale afstand. Een eindpunt in de strook tussen twee gebieden ligt vaak het
 * dichtst bij het gebied waar het kanaal begint; per eindpunt het dichtstbijzijnde
 * gebied kiezen leverde dan "begint en eindigt in map1" op voor een kanaal dat
 * overduidelijk map1 met map2 verbindt (issue #114).
 */
function assignChannelEnds(start: XY, end: XY, slots: WorkSlot[]): { from: number; to: number } | null {
  let best: { from: number; to: number; d: number } | null = null;
  for (const a of slots) {
    const da = distanceToPolygon(start, a.poly);
    if (da > SNAP_RADIUS_M) continue;
    for (const b of slots) {
      if (b.slot === a.slot) continue;
      const db = distanceToPolygon(end, b.poly);
      if (db > SNAP_RADIUS_M) continue;
      if (!best || da + db < best.d) best = { from: a.slot, to: b.slot, d: da + db };
    }
  }
  return best ? { from: best.from, to: best.to } : null;
}

/** Het dichtstbijzijnde werkgebied, ongeacht afstand. Null als er geen is. */
function nearestSlot(p: XY, slots: WorkSlot[]): number | null {
  let best: { slot: number; d: number } | null = null;
  for (const w of slots) {
    const d = distanceToPolygon(p, w.poly);
    if (!best || d < best.d) best = { slot: w.slot, d };
  }
  return best?.slot ?? null;
}

/** Volgende vrije index voor een kanaal tussen twee gebieden (mapAtomapB_K_unicom). */
function nextChannelIndex(sn: string, from: number, to: number): number {
  const re = new RegExp(`^map${from}tomap${to}_(\\d+)_unicom$`);
  let next = 0;
  for (const row of mapRepo.findAllByMowerSnAndType(sn, 'unicom')) {
    for (const n of [row.canonical_name, row.map_name, row.file_name]) {
      const m = n?.replace(/\.csv$/, '').match(re);
      if (m) next = Math.max(next, parseInt(m[1], 10) + 1);
    }
  }
  return next;
}

/** Volgende vrije obstakel-index binnen een werkgebied (mapN_M_obstacle). */
function nextObstacleIndex(sn: string, slot: number): number {
  const re = new RegExp(`^map${slot}_(\\d+)_obstacle$`);
  let next = 0;
  for (const row of mapRepo.findAllByMowerSnAndType(sn, 'obstacle')) {
    for (const n of [row.canonical_name, row.map_name, row.file_name]) {
      const m = n?.replace(/\.csv$/, '').match(re);
      if (m) next = Math.max(next, parseInt(m[1], 10) + 1);
    }
  }
  return next;
}

function hasSlot(slots: WorkSlot[], n: number): boolean {
  return slots.some(w => w.slot === n);
}

/**
 * Een to-charge kanaal: de firmware zet het LAADSTATION als EERSTE punt
 * (geverifieerd op LFIN2230700238: map0tocharge_unicom.csv begint op 0.03,0.73,
 * de dockpositie). getPolygonAnchor en de sync_map van de maaier lezen dat punt
 * als dock-anker, dus de getekende volgorde moet daarop genormaliseerd worden.
 * Anders verplaatst een getekend kanaal het anker en daarmee de hele kaart
 * (issue #114).
 *
 * `snapTo`: bij een AFGELEIDE naam wordt het eerste punt exact op het bekende
 * station gelegd zodat het anker niet met de tekenonnauwkeurigheid meeschuift.
 * Bij een GETYPTE naam blijft het punt waar de gebruiker het zette: dat is de
 * manier om het anker bewust te verplaatsen.
 */
function toChargeResult(
  sn: string,
  slot: number,
  points: XY[],
  dockIsLast: boolean,
  snapTo: XY | null,
): NamingResult {
  const canonical = `map${slot}tocharge_unicom`;
  const ordered = dockIsLast ? [...points].reverse() : points;
  const stored = snapTo ? [{ x: snapTo.x, y: snapTo.y }, ...ordered.slice(1)] : ordered;
  const existing = mapRepo.findBySnAndCanonical(sn, canonical);
  const changed = stored !== points;
  return {
    ok: true,
    canonical,
    ...(existing ? { replaces: existing.map_id } : {}),
    ...(changed ? { points: stored } : {}),
  };
}

/**
 * Een zelf getypte canonieke naam voor een kanaal of obstakel. Geeft null als
 * de tekst geen canonieke naam is (dan is het een gewone alias).
 */
function typedCanonical(
  sn: string,
  mapType: 'obstacle' | 'unicom',
  typed: string,
  points: XY[],
  slots: WorkSlot[],
  dock: XY | null,
): NamingResult | null {
  if (mapType === 'obstacle') {
    const m = typed.match(/^map(\d+)_(\d+)_obstacle$/);
    if (!m) return null;
    const slot = parseInt(m[1], 10);
    if (!hasSlot(slots, slot)) return { ok: false, error: `map${slot} does not exist.` };
    if (mapRepo.findBySnAndCanonical(sn, typed)) return { ok: false, error: `${typed} already exists.` };
    return { ok: true, canonical: typed };
  }

  const charge = typed.match(/^map(\d+)tocharge_unicom$/);
  if (charge) {
    const slot = parseInt(charge[1], 10);
    if (!hasSlot(slots, slot)) return { ok: false, error: `map${slot} does not exist.` };
    // Ligt een uiteinde aantoonbaar bij het station, dan gaat dat voorop; anders
    // geldt de getekende volgorde (eerste punt = station, zoals de firmware).
    const start = points[0];
    const end = points[points.length - 1];
    const endIsDock = dock !== null && dist(end, dock) <= DOCK_RADIUS_M && dist(start, dock) > DOCK_RADIUS_M;
    return toChargeResult(sn, slot, points, endIsDock, null);
  }

  const link = typed.match(/^map(\d+)tomap(\d+)_(\d+)_unicom$/);
  if (link) {
    const from = parseInt(link[1], 10);
    const to = parseInt(link[2], 10);
    if (from === to) return { ok: false, error: `A channel cannot connect map${from} to itself.` };
    for (const n of [from, to]) {
      if (!hasSlot(slots, n)) return { ok: false, error: `map${n} does not exist.` };
    }
    if (mapRepo.findBySnAndCanonical(sn, typed)) return { ok: false, error: `${typed} already exists.` };
    return { ok: true, canonical: typed };
  }
  return null;
}

/**
 * Canonieke naam voor een nieuw getekende kaart.
 *
 * work     — `mapN`: het slot dat de gebruiker zelf typte ("map5"), anders het
 *            eerste vrije slot.
 * unicom   — `mapAtomapB_K_unicom` of `mapAtocharge_unicom`, afgeleid uit de
 *            eindpunten van de getekende lijn. De richting volgt de lijn: het
 *            eerste punt is de "van"-kant, net als bij de maaier (die neemt zijn
 *            positie bij add_scan_map als van-kant). Een to-charge kanaal wordt
 *            opgeslagen met het station als eerste punt (zie toChargeResult).
 * obstacle — `mapN_M_obstacle`, met N het gebied waar het obstakel in ligt.
 *
 * Een zelf getypte canonieke naam (voor elk type) wint van de afleiding.
 *
 * Niet af te leiden (kanaal dat nergens begint/eindigt, obstakel buiten elk
 * gebied) geeft een fout: liever weigeren dan een rij wegschrijven die de
 * maaier nooit bereikt.
 */
export function canonicalForDrawnMap(
  sn: string,
  mapType: 'work' | 'obstacle' | 'unicom',
  points: XY[],
  requestedName?: string | null,
): NamingResult {
  const typed = requestedName?.trim() ?? '';

  if (mapType === 'work') {
    const m = typed.match(/^map(\d+)$/);
    if (m) {
      const slot = parseInt(m[1], 10);
      const existing = mapRepo.findBySnAndCanonical(sn, `map${slot}`);
      if (existing) return { ok: false, error: `map${slot} already exists.` };
      return { ok: true, canonical: `map${slot}` };
    }
    return { ok: true, canonical: `map${nextFreeWorkSlot(sn)}` };
  }

  const slots = workSlots(sn);
  if (slots.length === 0) {
    return { ok: false, error: 'There is no work area to attach this to yet. Draw a work area first.' };
  }
  const dock = mapType === 'unicom' ? dockPoint(sn) : null;

  if (typed) {
    const explicit = typedCanonical(sn, mapType, typed, points, slots, dock);
    if (explicit) return explicit;
  }

  if (mapType === 'obstacle') {
    const centre: XY = {
      x: points.reduce((s, p) => s + p.x, 0) / points.length,
      y: points.reduce((s, p) => s + p.y, 0) / points.length,
    };
    // Een obstakel hoort bij een slot omdat de firmware-naam dat eist, maar het
    // hoeft er niet IN te liggen. De grond tussen twee zones is juist waar je er
    // een wilt zetten: die strook staat in map.pgm als vrij zodra de maaier er
    // ooit doorheen is gereden, en dan plant nav2 daar zijn reis doorheen
    // (live LFIN2230700238, 2026-09-14: 46,6 m2 aangeleerde doorgang door de
    // struiken). Een getekend obstakel wordt bij elke regenerate hard op bezet
    // gezet, ook in de navigatiekaart, en dat is de enige manier om zo'n
    // aangeleerde doorgang weer dicht te krijgen. Ligt het obstakel nergens in,
    // dan hangen we het aan het dichtstbijzijnde gebied.
    const slot = slotAt(centre, slots) ?? nearestSlot(centre, slots);
    if (slot === null) {
      return { ok: false, error: 'There is no work area to attach this obstacle to.' };
    }
    return { ok: true, canonical: `map${slot}_${nextObstacleIndex(sn, slot)}_obstacle` };
  }

  // unicom: eindpunten bepalen de naam volledig
  const start = points[0];
  const end = points[points.length - 1];
  const isDock = (p: XY) => dock !== null && dist(p, dock) <= DOCK_RADIUS_M;

  const startDock = isDock(start);
  const endDock = isDock(end);

  if (startDock && endDock) {
    return { ok: false, error: 'Both ends lie on the charging station. Draw the channel to a work area.' };
  }
  if (startDock || endDock) {
    const slot = slotAt(startDock ? end : start, slots);
    if (slot === null) {
      return { ok: false, error: 'The other end does not lie in a work area. Let the channel end inside an area.' };
    }
    return toChargeResult(sn, slot, points, endDock, dock);
  }

  const ends = assignChannelEnds(start, end, slots);
  if (ends) {
    return { ok: true, canonical: `map${ends.from}tomap${ends.to}_${nextChannelIndex(sn, ends.from, ends.to)}_unicom` };
  }
  const startSlot = slotAt(start, slots);
  const endSlot = slotAt(end, slots);
  if (startSlot === null || endSlot === null) {
    return {
      ok: false,
      error: 'A channel must start in one work area and end in another; one end now lies outside every area.',
    };
  }
  return {
    ok: false,
    error: `Both ends lie in map${startSlot}; a channel connects two different areas. `
      + 'To connect the charging station, start the channel at the station or type the name (e.g. map0tocharge_unicom).',
  };
}
