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
  | { ok: true; canonical: string; replaces?: string }
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

/**
 * Canonieke naam voor een nieuw getekende kaart.
 *
 * work     — `mapN`: het slot dat de gebruiker zelf typte ("map5"), anders het
 *            eerste vrije slot.
 * unicom   — `mapAtomapB_K_unicom` of `mapAtocharge_unicom`, afgeleid uit de
 *            eindpunten van de getekende lijn. De richting volgt de lijn: het
 *            eerste punt is de "van"-kant, net als bij de maaier (die neemt zijn
 *            positie bij add_scan_map als van-kant).
 * obstacle — `mapN_M_obstacle`, met N het gebied waar het obstakel in ligt.
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
  if (mapType === 'work') {
    const typed = requestedName?.trim().match(/^map(\d+)$/);
    if (typed) {
      const slot = parseInt(typed[1], 10);
      const existing = mapRepo.findBySnAndCanonical(sn, `map${slot}`);
      if (existing) return { ok: false, error: `map${slot} bestaat al.` };
      return { ok: true, canonical: `map${slot}` };
    }
    return { ok: true, canonical: `map${nextFreeWorkSlot(sn)}` };
  }

  const slots = workSlots(sn);
  if (slots.length === 0) {
    return { ok: false, error: 'Er is nog geen werkgebied om dit aan te koppelen. Teken eerst een werkgebied.' };
  }

  if (mapType === 'obstacle') {
    const centre: XY = {
      x: points.reduce((s, p) => s + p.x, 0) / points.length,
      y: points.reduce((s, p) => s + p.y, 0) / points.length,
    };
    const slot = slotAt(centre, slots);
    if (slot === null) {
      return { ok: false, error: 'Dit obstakel ligt niet in een werkgebied. Teken het binnen een gebied.' };
    }
    return { ok: true, canonical: `map${slot}_${nextObstacleIndex(sn, slot)}_obstacle` };
  }

  // unicom: eindpunten bepalen de naam volledig
  const start = points[0];
  const end = points[points.length - 1];
  const dock = dockPoint(sn);
  const isDock = (p: XY) => dock !== null && dist(p, dock) <= DOCK_RADIUS_M;

  const startDock = isDock(start);
  const endDock = isDock(end);
  const startSlot = startDock ? null : slotAt(start, slots);
  const endSlot = endDock ? null : slotAt(end, slots);

  if (startDock && endDock) {
    return { ok: false, error: 'Beide uiteinden liggen op het laadstation. Teken het kanaal naar een werkgebied.' };
  }
  if (endDock || startDock) {
    const slot = startDock ? endSlot : startSlot;
    if (slot === null) {
      return { ok: false, error: 'Het andere uiteinde ligt niet in een werkgebied. Laat het kanaal in een gebied eindigen.' };
    }
    const canonical = `map${slot}tocharge_unicom`;
    const existing = mapRepo.findBySnAndCanonical(sn, canonical);
    return existing
      ? { ok: true, canonical, replaces: existing.map_id }
      : { ok: true, canonical };
  }
  if (startSlot === null || endSlot === null) {
    return {
      ok: false,
      error: 'Een kanaal moet in het ene werkgebied beginnen en in het andere eindigen; een uiteinde ligt nu buiten elk gebied.',
    };
  }
  if (startSlot === endSlot) {
    return { ok: false, error: `Begin en eind liggen allebei in map${startSlot}; een kanaal verbindt twee verschillende gebieden.` };
  }
  return { ok: true, canonical: `map${startSlot}tomap${endSlot}_${nextChannelIndex(sn, startSlot, endSlot)}_unicom` };
}
