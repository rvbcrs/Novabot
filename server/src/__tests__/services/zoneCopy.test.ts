/**
 * Zone kopiëren tussen maaiers: geometrie en regels.
 * Spec: docs/superpowers/specs/2026-09-24-copy-zone-between-mowers-design.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// canonicalNaming importeert mqtt/sensorData; zonder mock trekt dat de broker-initketen mee.
vi.mock('../../mqtt/sensorData.js', () => ({
  getDockPose: vi.fn().mockReturnValue(null),
}));
import {
  transformPoints, nearestBoundaryPoint, polygonsOverlap, polygonGap, segmentCrossesPolygon, straightChannel, STEP_M,
  planZoneCopy, DOCK_MAX_M, MAX_SLOT, type PlanInput,
  previewZoneCopy, persistZoneCopy, MAX_DOCK_DISTANCE_M,
} from '../../services/zoneCopy.js';
import { mapRepo } from '../../db/repositories/index.js';
import { getDockPose } from '../../mqtt/sensorData.js';

export const square = (x0: number, y0: number, size = 10) => [
  { x: x0, y: y0 }, { x: x0 + size, y: y0 }, { x: x0 + size, y: y0 + size }, { x: x0, y: y0 + size },
];
export const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

describe('zoneCopy geometrie', () => {
  it('transformPoints: gelijk dock = identiteit, anders zuivere verschuiving', () => {
    const pts = square(0, 0);
    expect(transformPoints(pts, { x: 1, y: 2 }, { x: 1, y: 2 })).toEqual(pts);
    const [p] = transformPoints([{ x: 0, y: 0 }], { x: 0.03, y: 0.73 }, { x: 11.2, y: 18.3 });
    expect(p.x).toBeCloseTo(11.17, 6);
    expect(p.y).toBeCloseTo(17.57, 6);
  });

  it('nearestBoundaryPoint: vanaf buiten en vanaf binnen naar de rand', () => {
    const sq = square(0, 0);
    const out = nearestBoundaryPoint({ x: 15, y: 5 }, sq);
    expect(out.dist).toBeCloseTo(5, 6);
    expect(out.point).toEqual({ x: 10, y: 5 });
    const inside = nearestBoundaryPoint({ x: 1, y: 5 }, sq);
    expect(inside.dist).toBeCloseTo(1, 6);
    expect(inside.point).toEqual({ x: 0, y: 5 });
  });

  it('nearestBoundaryPoint: dubbele opeenvolgende punten (lengte-0 rand) breken niets', () => {
    const poly = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const r = nearestBoundaryPoint({ x: -1, y: 0 }, poly);
    expect(r.dist).toBeCloseTo(1, 6);
    expect(Number.isFinite(r.point.x) && Number.isFinite(r.point.y)).toBe(true);
  });

  it('polygonsOverlap: los, hoekpunt binnen, en kruisend zonder hoekpunt binnen', () => {
    expect(polygonsOverlap(square(0, 0), square(20, 0))).toBe(false);
    expect(polygonsOverlap(square(0, 0), square(5, 5))).toBe(true);
    const horiz = rect(-10, 4, 10, 6);
    const vert = rect(4, -10, 6, 10);
    expect(polygonsOverlap(horiz, vert)).toBe(true);
  });

  it('polygonGap: 0 bij overlap, anders afstand met randpunten aan beide kanten', () => {
    expect(polygonGap(square(0, 0), square(5, 5)).dist).toBe(0);
    const g = polygonGap(square(0, 0), square(11, 0));
    expect(g.dist).toBeCloseTo(1, 6);
    expect(g.onA.x).toBeCloseTo(10, 6);
    expect(g.onB.x).toBeCloseTo(11, 6);
  });

  it('segmentCrossesPolygon: kruisend, erlangs, en volledig erbinnen', () => {
    const sq = square(0, 0);
    expect(segmentCrossesPolygon({ x: -5, y: 5 }, { x: 15, y: 5 }, sq)).toBe(true);
    expect(segmentCrossesPolygon({ x: -5, y: 15 }, { x: 15, y: 15 }, sq)).toBe(false);
    expect(segmentCrossesPolygon({ x: 2, y: 2 }, { x: 8, y: 8 }, sq)).toBe(true);
  });

  it('straightChannel: begint bij from, eindigt bij to, stappen van hoogstens STEP_M', () => {
    const pts = straightChannel({ x: 0, y: 0 }, { x: 0, y: 1 });
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 0, y: 1 });
    expect(pts).toHaveLength(5);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)).toBeLessThanOrEqual(STEP_M + 1e-9);
    }
    expect(straightChannel({ x: 3, y: 3 }, { x: 3, y: 3 })).toEqual([{ x: 3, y: 3 }, { x: 3, y: 3 }]);
  });
});

describe('planZoneCopy', () => {
  const zone = (slot: number, points: ReturnType<typeof square>, obstacles: ReturnType<typeof square>[] = []) =>
    ({ slot, canonical: `map${slot}`, points, obstacles });
  const input = (over: Partial<PlanInput>): PlanInput => ({
    slot: 0, work: square(0, 0), obstacles: [], existing: [], dock: { x: 5, y: 5 },
    dockChannelRowExists: false, linkIndex: () => 0, ...over,
  });

  it('slot 0, dock in de zone: kort dockkanaal met het dock als rij 1, geen kanaal nodig', () => {
    const p = planZoneCopy(input({ dock: { x: 1, y: 5 } }));
    expect(p.ok).toBe(true);
    expect(p.canonical).toBe('map0');
    expect(p.channels).toHaveLength(1);
    expect(p.channels[0]).toMatchObject({ canonical: 'map0tocharge_unicom', kind: 'dock', replaces: false });
    expect(p.channels[0].points[0]).toEqual({ x: 1, y: 5 });
    expect(p.channels[0].points.at(-1)).toEqual({ x: 0, y: 5 });
    expect(p.needsChannel).toBe(false);
    expect(p.dockDistanceM).toBe(0);
  });

  it('slot 0, dock exact op de rand: dockkanaal van twee gelijke punten', () => {
    const p = planZoneCopy(input({ dock: { x: 0, y: 5 } }));
    expect(p.ok).toBe(true);
    expect(p.channels[0].points).toEqual([{ x: 0, y: 5 }, { x: 0, y: 5 }]);
  });

  it('slot 0, dock 2 m buiten de zone: dockkanaal van 2 m', () => {
    const p = planZoneCopy(input({ dock: { x: 12, y: 5 } }));
    expect(p.ok).toBe(true);
    expect(p.dockDistanceM).toBeCloseTo(2, 6);
    expect(p.channels[0].points.at(-1)).toEqual({ x: 10, y: 5 });
  });

  it('slot 0, dock verder dan DOCK_MAX_M: weigering too_far_from_dock', () => {
    const p = planZoneCopy(input({ dock: { x: 10 + DOCK_MAX_M + 0.5, y: 5 } }));
    expect(p).toMatchObject({ ok: false, refusal: 'too_far_from_dock', channels: [] });
  });

  it('slot 0, dockkanaal door een gekopieerd obstakel: weigering dock_channel_blocked', () => {
    // Dock (5,3) → dichtstbijzijnde rand (5,0); obstakel x 4..6, y 1..2 ligt op die lijn.
    const p = planZoneCopy(input({ dock: { x: 5, y: 3 }, obstacles: [rect(4, 1, 6, 2)] }));
    expect(p).toMatchObject({ ok: false, refusal: 'dock_channel_blocked' });
  });

  it('slot 1, kopie overlapt map0: geen kanaal, verbonden via map0', () => {
    const p = planZoneCopy(input({ slot: 1, work: square(5, 0), existing: [zone(0, square(0, 0))], dock: { x: 1, y: 1 } }));
    expect(p).toMatchObject({ ok: true, canonical: 'map1', connectedVia: 'map0', channels: [], needsChannel: false, warnings: [] });
  });

  it('slot 1, kopie omsluit map0 volledig: verbonden, met waarschuwing full_overlap', () => {
    const p = planZoneCopy(input({ slot: 1, work: square(-10, -10, 30), existing: [zone(0, square(0, 0))], dock: { x: 1, y: 1 } }));
    expect(p).toMatchObject({ ok: true, connectedVia: 'map0', warnings: ['full_overlap'] });
  });

  it('slot 1, opening van 1 m naar map0: tussenkanaal met randpunten aan beide kanten', () => {
    const p = planZoneCopy(input({ slot: 1, work: square(11, 0), existing: [zone(0, square(0, 0))], dock: { x: 1, y: 1 }, linkIndex: () => 2 }));
    expect(p.ok).toBe(true);
    expect(p.connectedVia).toBeNull();
    expect(p.channels).toHaveLength(1);
    expect(p.channels[0]).toMatchObject({ canonical: 'map0tomap1_2_unicom', kind: 'link' });
    expect(p.channels[0].points[0].x).toBeCloseTo(10, 6);
    expect(p.channels[0].points.at(-1)!.x).toBeCloseTo(11, 6);
    expect(p.needsChannel).toBe(false);
  });

  it('slot 1, opening > LINK_MAX_M maar dock dichtbij: dockkanaal als terugval + waarschuwing', () => {
    const p = planZoneCopy(input({ slot: 1, work: square(20, 0), existing: [zone(0, square(0, 0))], dock: { x: 18, y: 5 } }));
    expect(p.ok).toBe(true);
    expect(p.channels.map(c => c.canonical)).toEqual(['map1tocharge_unicom']);
    expect(p.warnings).toEqual(['existing_zones_unlinked']);
    expect(p.needsChannel).toBe(false);
  });

  it('slot 1, opening > LINK_MAX_M en dock ver weg: geen kanaal, prompt nodig', () => {
    const p = planZoneCopy(input({ slot: 1, work: square(20, 0), existing: [zone(0, square(0, 0))], dock: { x: 1, y: 1 } }));
    expect(p).toMatchObject({ ok: true, channels: [], needsChannel: true });
  });

  it('slot 1, tussenkanaal door een obstakel in de opening: geen voorstel, doorvallen', () => {
    const p = planZoneCopy(input({ slot: 1, work: square(11, 0), existing: [zone(0, square(0, 0), [rect(10.2, -1, 10.8, 1)])], dock: { x: 1, y: 1 } }));
    expect(p).toMatchObject({ ok: true, channels: [], needsChannel: true });
  });

  it('slot 0 met een verweesde map3 (na cascade-delete): dockkanaal én tussenkanaal', () => {
    const p = planZoneCopy(input({ slot: 0, work: square(0, 0), existing: [zone(3, square(-11, 0))], dock: { x: 1, y: 5 } }));
    expect(p.ok).toBe(true);
    expect(p.channels.map(c => c.canonical)).toEqual(['map0tocharge_unicom', 'map3tomap0_0_unicom']);
    expect(p.warnings).toEqual([]);
  });

  it('obstakels worden hernummerd naar het nieuwe slot', () => {
    const p = planZoneCopy(input({ slot: 2, obstacles: [square(1, 1, 2), square(6, 6, 2)], dock: { x: 1, y: 5 } }));
    expect(p.obstacles.map(o => o.canonical)).toEqual(['map2_0_obstacle', 'map2_1_obstacle']);
  });

  it('slot boven de firmware-cap: weigering slot_limit', () => {
    expect(planZoneCopy(input({ slot: MAX_SLOT + 1 })).refusal).toBe('slot_limit');
  });

  it('zonder dock op B: weigering target_no_dock', () => {
    expect(planZoneCopy(input({ dock: null })).refusal).toBe('target_no_dock');
  });

  it('bestaande map0tocharge_unicom-rij wordt gemarkeerd als te vervangen', () => {
    const p = planZoneCopy(input({ dock: { x: 1, y: 5 }, dockChannelRowExists: true }));
    expect(p.channels[0].replaces).toBe(true);
  });
});

describe('previewZoneCopy / persistZoneCopy (in-memory DB)', () => {
  const A = 'LFIN_COPY_SRC';
  const B = 'LFIN_COPY_DST';
  const addRow = (sn: string, canonical: string, type: 'work' | 'obstacle' | 'unicom', pts: unknown[], alias: string | null = null) =>
    mapRepo.create({ map_id: `${sn}-${canonical}`, mower_sn: sn, map_name: alias, map_type: type, map_area: JSON.stringify(pts), canonical_name: canonical });
  const dockA = { x: 0.03, y: 0.73 };
  const dockB = { x: 0.1, y: -0.5 };

  beforeEach(() => {
    for (const sn of [A, B]) for (const m of mapRepo.findByMowerSn(sn)) mapRepo.deleteById(m.map_id);
    vi.mocked(getDockPose).mockReturnValue(null);
    // A: 10x10 zone met het dock erin, één obstakel, dockkanaal (rij 1 = dock).
    addRow(A, 'map0', 'work', square(0, 0), 'Grote tuin');
    addRow(A, 'map0_0_obstacle', 'obstacle', square(2, 2, 2));
    addRow(A, 'map0tocharge_unicom', 'unicom', [dockA, { x: -0.4, y: 0.94 }]);
    // B: alleen een (achtergebleven) dockkanaal; geen werkgebieden.
    addRow(B, 'map0tocharge_unicom', 'unicom', [dockB, { x: 0.3, y: -0.8 }]);
  });

  it('transformeert zone + obstakel naar B, slot 0, dockkanaal vervangt de oude rij, alias komt mee', () => {
    const r = previewZoneCopy(B, A, 'map0', dockB);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sourceAlias).toBe('Grote tuin');
    expect(r.areaM2).toBeCloseTo(100, 6);
    expect(r.plan.ok).toBe(true);
    expect(r.plan.canonical).toBe('map0');
    expect(r.plan.work[0].x).toBeCloseTo(dockB.x - dockA.x, 6);
    expect(r.plan.work[0].y).toBeCloseTo(dockB.y - dockA.y, 6);
    expect(r.plan.obstacles).toHaveLength(1);
    expect(r.plan.obstacles[0].canonical).toBe('map0_0_obstacle');
    expect(r.plan.obstacles[0].points[0].x).toBeCloseTo(2 + dockB.x - dockA.x, 6);
    expect(r.plan.channels[0]).toMatchObject({ canonical: 'map0tocharge_unicom', kind: 'dock', replaces: true });
    expect(r.plan.channels[0].points[0]).toEqual(dockB);
  });

  it('withObstacles=false laat de obstakels weg', () => {
    const r = previewZoneCopy(B, A, 'map0', dockB, { withObstacles: false });
    expect(r.ok && r.plan.obstacles).toEqual([]);
  });

  it('een null-coördinaat in de bron wordt weggelaten, de kopie slaagt', () => {
    for (const m of mapRepo.findByMowerSn(A)) if (m.canonical_name === 'map0') mapRepo.deleteById(m.map_id);
    addRow(A, 'map0', 'work', [...square(0, 0), { x: null, y: 3 }], 'Grote tuin');
    const r = previewZoneCopy(B, A, 'map0', dockB);
    expect(r.ok && r.plan.work).toHaveLength(4);
  });

  it('zonder alias (map_name == canonical) is sourceAlias null', () => {
    for (const m of mapRepo.findByMowerSn(A)) if (m.canonical_name === 'map0') mapRepo.deleteById(m.map_id);
    addRow(A, 'map0', 'work', square(0, 0), 'map0');
    const r = previewZoneCopy(B, A, 'map0', dockB);
    expect(r.ok && r.sourceAlias).toBeNull();
  });

  it('bron zonder anker en niet gedockt: 409 source_no_anchor; gedockt live: anker uit getDockPose', () => {
    for (const m of mapRepo.findByMowerSn(A)) if (m.map_type === 'unicom') mapRepo.deleteById(m.map_id);
    expect(previewZoneCopy(B, A, 'map0', dockB)).toMatchObject({ ok: false, status: 409, reason: 'source_no_anchor' });
    vi.mocked(getDockPose).mockImplementation(sn => (sn === A ? { x: 1, y: 2, orientation: 0, capturedAt: 0 } : null));
    const r = previewZoneCopy(B, A, 'map0', dockB);
    expect(r.ok && r.plan.work[0].x).toBeCloseTo(dockB.x - 1, 6);
  });

  it('invoerfouten: canonical, onbekende zone, dock, te ver, geen dock op B', () => {
    expect(previewZoneCopy(B, A, 'map0tocharge_unicom', dockB)).toMatchObject({ ok: false, status: 400, reason: 'bad_canonical' });
    expect(previewZoneCopy(B, A, 'map7', dockB)).toMatchObject({ ok: false, status: 404, reason: 'source_not_found' });
    expect(previewZoneCopy(B, A, 'map0', undefined)).toMatchObject({ ok: false, status: 400, reason: 'bad_dock' });
    expect(previewZoneCopy(B, A, 'map0', { x: 'a', y: 1 })).toMatchObject({ ok: false, status: 400, reason: 'bad_dock' });
    expect(previewZoneCopy(B, A, 'map0', { x: dockB.x + MAX_DOCK_DISTANCE_M + 1, y: dockB.y })).toMatchObject({ ok: false, status: 400, reason: 'dock_too_far' });
    for (const m of mapRepo.findByMowerSn(B)) mapRepo.deleteById(m.map_id);
    expect(previewZoneCopy(B, A, 'map0', dockB)).toMatchObject({ ok: false, status: 409, reason: 'target_no_dock' });
  });

  it('te kleine zone: 409 too_small', () => {
    for (const m of mapRepo.findByMowerSn(A)) if (m.canonical_name === 'map0') mapRepo.deleteById(m.map_id);
    addRow(A, 'map0', 'work', square(0, 0, 1));
    expect(previewZoneCopy(B, A, 'map0', dockB)).toMatchObject({ ok: false, status: 409, reason: 'too_small' });
  });

  it('B met bestaande map0: kopie wordt map1, obstakels hernummerd, bestaande obstakels tellen mee', () => {
    addRow(B, 'map0', 'work', square(-30, -30));
    addRow(B, 'map0_0_obstacle', 'obstacle', square(-28, -28, 2));
    const r = previewZoneCopy(B, A, 'map0', dockB);
    expect(r.ok && r.plan.canonical).toBe('map1');
    expect(r.ok && r.plan.obstacles[0].canonical).toBe('map1_0_obstacle');
  });

  it('persistZoneCopy schrijft work + obstakels + kanalen, vervangt het oude dockkanaal zonder dubbele rij', () => {
    const r = previewZoneCopy(B, A, 'map0', dockB);
    if (!r.ok) throw new Error('preview failed');
    const saved = persistZoneCopy(B, r.plan, { alias: 'Grote tuin (kopie)', acceptChannel: true });
    const rows = mapRepo.findByMowerSn(B);
    expect(rows.map(x => x.canonical_name).sort()).toEqual(['map0', 'map0_0_obstacle', 'map0tocharge_unicom']);
    const work = mapRepo.findBySnAndCanonical(B, 'map0')!;
    expect(work.map_id).toBe(saved.mapId);
    expect(work.map_name).toBe('Grote tuin (kopie)');
    expect(work.source).toBe('drawn');
    expect(JSON.parse(work.map_max_min!)).toEqual(saved.mapMaxMin);
    const dock = mapRepo.findBySnAndCanonical(B, 'map0tocharge_unicom')!;
    expect(JSON.parse(dock.map_area!)[0]).toEqual(dockB);
    expect(saved.channels).toEqual(['map0tocharge_unicom']);
    expect(saved.obstacles).toEqual(['map0_0_obstacle']);
  });

  it('persistZoneCopy met acceptChannel=false schrijft geen kanaal en laat het oude staan', () => {
    const r = previewZoneCopy(B, A, 'map0', dockB);
    if (!r.ok) throw new Error('preview failed');
    const saved = persistZoneCopy(B, r.plan, { alias: null, acceptChannel: false });
    expect(saved.channels).toEqual([]);
    const dock = mapRepo.findBySnAndCanonical(B, 'map0tocharge_unicom')!;
    expect(JSON.parse(dock.map_area!)[1]).toEqual({ x: 0.3, y: -0.8 });
  });
});
