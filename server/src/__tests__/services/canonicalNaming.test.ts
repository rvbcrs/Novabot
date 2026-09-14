/**
 * Canonieke namen voor dashboard-getekende kaarten.
 *
 * Een getekend gebied heette alleen "Werkgebied 4" en een getekend kanaal
 * "Kanaal 1". Het kanaal viel daardoor stil uit de ZIP (generateMapZipFromDb
 * matcht op mapNto..._unicom) en het gebied kreeg pas bij ZIP-generatie een
 * slot. De naam volgt uit de geometrie: eerste vrije slot voor een gebied, de
 * twee eindpunten voor een kanaal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../mqtt/sensorData.js', () => ({
  getDockPose: vi.fn().mockReturnValue(null),
}));

import { canonicalForDrawnMap, nextFreeWorkSlot } from '../../services/canonicalNaming.js';
import { mapRepo } from '../../db/repositories/index.js';

const SN = 'LFIN_CANON_NAMING';

// Twee gescheiden vierkanten: map0 rond (0..10), map1 rond (20..30).
const square = (x0: number, y0: number, size = 10) => [
  { x: x0, y: y0 },
  { x: x0 + size, y: y0 },
  { x: x0 + size, y: y0 + size },
  { x: x0, y: y0 + size },
];

function addWork(canonical: string, poly: Array<{ x: number; y: number }>, alias?: string) {
  mapRepo.create({
    map_id: `row-${canonical}`,
    mower_sn: SN,
    map_name: alias ?? canonical,
    map_type: 'work',
    map_area: JSON.stringify(poly),
    canonical_name: canonical,
  });
}

describe('canonicalForDrawnMap', () => {
  beforeEach(() => {
    for (const m of mapRepo.findByMowerSn(SN)) mapRepo.deleteById(m.map_id);
  });

  it('geeft een nieuw gebied het eerste vrije slot, ook met een gebruikersnaam', () => {
    addWork('map0', square(0, 0), 'Voortuin');
    addWork('map2', square(40, 40), 'Zijkant');
    expect(nextFreeWorkSlot(SN)).toBe(1);
    expect(canonicalForDrawnMap(SN, 'work', square(20, 20), 'Werkgebied 4')).toEqual({
      ok: true,
      canonical: 'map1',
    });
  });

  it('respecteert een zelf getypte slotnaam en weigert een bestaand slot', () => {
    addWork('map0', square(0, 0));
    expect(canonicalForDrawnMap(SN, 'work', square(20, 20), 'map5')).toEqual({ ok: true, canonical: 'map5' });
    const dup = canonicalForDrawnMap(SN, 'work', square(20, 20), 'map0');
    expect(dup.ok).toBe(false);
  });

  it('noemt een kanaal naar de gebieden die het verbindt, in de getekende richting', () => {
    addWork('map0', square(0, 0), 'Voortuin');
    addWork('map1', square(20, 0), 'Achtertuin');
    // Getekend van map1 naar map0 → map1tomap0_0_unicom.
    expect(canonicalForDrawnMap(SN, 'unicom', [{ x: 22, y: 5 }, { x: 15, y: 5 }, { x: 5, y: 5 }], 'Kanaal 1')).toEqual({
      ok: true,
      canonical: 'map1tomap0_0_unicom',
    });
    // Andersom getekend → andere richting in de naam.
    expect(canonicalForDrawnMap(SN, 'unicom', [{ x: 5, y: 5 }, { x: 22, y: 5 }], null)).toEqual({
      ok: true,
      canonical: 'map0tomap1_0_unicom',
    });
  });

  it('telt door op de volgende kanaal-index van hetzelfde paar', () => {
    addWork('map0', square(0, 0));
    addWork('map1', square(20, 0));
    mapRepo.create({
      map_id: 'row-chan0',
      mower_sn: SN,
      map_name: 'map0tomap1_0_unicom',
      map_type: 'unicom',
      map_area: JSON.stringify([{ x: 5, y: 5 }, { x: 22, y: 5 }]),
      canonical_name: 'map0tomap1_0_unicom',
    });
    expect(canonicalForDrawnMap(SN, 'unicom', [{ x: 5, y: 8 }, { x: 22, y: 8 }], null)).toEqual({
      ok: true,
      canonical: 'map0tomap1_1_unicom',
    });
  });

  it('weigert een kanaal waarvan een uiteinde nergens ligt', () => {
    addWork('map0', square(0, 0));
    addWork('map1', square(20, 0));
    const res = canonicalForDrawnMap(SN, 'unicom', [{ x: 5, y: 5 }, { x: 200, y: 200 }], null);
    expect(res.ok).toBe(false);
  });

  it('weigert een kanaal dat in hetzelfde gebied begint en eindigt', () => {
    addWork('map0', square(0, 0));
    addWork('map1', square(20, 0));
    const res = canonicalForDrawnMap(SN, 'unicom', [{ x: 2, y: 2 }, { x: 8, y: 8 }], null);
    expect(res.ok).toBe(false);
  });

  it('noemt een kanaal naar het laadstation mapNtocharge_unicom', () => {
    addWork('map0', square(0, 0));
    // Ankerpunt = eerste punt van het bestaande to-charge kanaal, hier (50,50).
    mapRepo.create({
      map_id: 'row-charge',
      mower_sn: SN,
      map_name: 'map0tocharge_unicom',
      map_type: 'unicom',
      map_area: JSON.stringify([{ x: 50, y: 50 }, { x: 5, y: 5 }]),
      canonical_name: 'map0tocharge_unicom',
    });
    const res = canonicalForDrawnMap(SN, 'unicom', [{ x: 5, y: 5 }, { x: 50.5, y: 50 }], null);
    // Getekend van het gebied naar het station: opgeslagen met het station als
    // EERSTE punt (firmware-conventie), exact op het bekende anker gelegd.
    expect(res).toEqual({
      ok: true,
      canonical: 'map0tocharge_unicom',
      replaces: 'row-charge',
      points: [{ x: 50, y: 50 }, { x: 5, y: 5 }],
    });
  });

  it('laat een to-charge kanaal dat al bij het station begint ongemoeid in volgorde', () => {
    addWork('map0', square(0, 0));
    mapRepo.create({
      map_id: 'row-charge',
      mower_sn: SN,
      map_name: 'map0tocharge_unicom',
      map_type: 'unicom',
      map_area: JSON.stringify([{ x: 50, y: 50 }, { x: 5, y: 5 }]),
      canonical_name: 'map0tocharge_unicom',
    });
    const res = canonicalForDrawnMap(SN, 'unicom', [{ x: 51, y: 50 }, { x: 30, y: 30 }, { x: 5, y: 5 }], null);
    expect(res).toEqual({
      ok: true,
      canonical: 'map0tocharge_unicom',
      replaces: 'row-charge',
      points: [{ x: 50, y: 50 }, { x: 30, y: 30 }, { x: 5, y: 5 }],
    });
  });

  it('koppelt een kanaal over een strook aan twee VERSCHILLENDE gebieden', () => {
    // map0 = 0..10, map1 = 12..22: een strook van 2 m ertussen. Het eindpunt
    // ligt in de strook, dichter bij map0 dan bij map1 (issue #114).
    addWork('map0', square(0, 0));
    addWork('map1', square(12, 0));
    const res = canonicalForDrawnMap(SN, 'unicom', [{ x: 8, y: 5 }, { x: 10.5, y: 5 }], null);
    expect(res).toEqual({ ok: true, canonical: 'map0tomap1_0_unicom' });
  });

  it('honoreert een getypte kanaalnaam naar het laadstation zonder bekend station', () => {
    addWork('map0', square(0, 0));
    // Geen anker en geen dock-pose: de getekende volgorde blijft (eerste punt = station).
    const res = canonicalForDrawnMap(SN, 'unicom', [{ x: 40, y: 40 }, { x: 5, y: 5 }], 'map0tocharge_unicom');
    expect(res).toEqual({ ok: true, canonical: 'map0tocharge_unicom' });
    expect(canonicalForDrawnMap(SN, 'unicom', [{ x: 40, y: 40 }, { x: 5, y: 5 }], 'map3tocharge_unicom')).toEqual({
      ok: false,
      error: 'map3 does not exist.',
    });
  });

  it('honoreert een getypte naam tussen twee gebieden en weigert onzin', () => {
    addWork('map0', square(0, 0));
    addWork('map1', square(20, 0));
    expect(canonicalForDrawnMap(SN, 'unicom', [{ x: 5, y: 5 }, { x: 22, y: 5 }], 'map1tomap0_3_unicom')).toEqual({
      ok: true,
      canonical: 'map1tomap0_3_unicom',
    });
    expect(canonicalForDrawnMap(SN, 'unicom', [{ x: 5, y: 5 }, { x: 22, y: 5 }], 'map0tomap0_0_unicom').ok).toBe(false);
    expect(canonicalForDrawnMap(SN, 'unicom', [{ x: 5, y: 5 }, { x: 22, y: 5 }], 'map0tomap7_0_unicom').ok).toBe(false);
    // Een gewone alias blijft een alias: naam wordt afgeleid.
    expect(canonicalForDrawnMap(SN, 'unicom', [{ x: 5, y: 5 }, { x: 22, y: 5 }], 'Kanaal 1')).toEqual({
      ok: true,
      canonical: 'map0tomap1_0_unicom',
    });
  });

  it('honoreert een getypte obstakelnaam', () => {
    addWork('map0', square(0, 0));
    addWork('map1', square(20, 0));
    expect(canonicalForDrawnMap(SN, 'obstacle', square(21, 1, 2), 'map1_7_obstacle')).toEqual({
      ok: true,
      canonical: 'map1_7_obstacle',
    });
    expect(canonicalForDrawnMap(SN, 'obstacle', square(21, 1, 2), 'map4_0_obstacle').ok).toBe(false);
  });

  it('hangt een obstakel tussen twee gebieden aan het dichtstbijzijnde', () => {
    // De strook tussen twee zones is precies waar je een obstakel wilt kunnen
    // zetten: staat die in map.pgm als vrij (de maaier reed er ooit doorheen),
    // dan plant nav2 er zijn reis doorheen. Een getekend obstakel is het enige
    // dat die aangeleerde doorgang weer dichtzet.
    addWork('map0', square(0, 0));          // 0..10
    addWork('map1', square(40, 0));         // 40..50
    // Midden in het gat, ruim buiten SNAP_RADIUS van allebei, maar dichter bij map1.
    expect(canonicalForDrawnMap(SN, 'obstacle', square(29, 4, 2), null)).toEqual({
      ok: true,
      canonical: 'map1_0_obstacle',
    });
    // en andersom, dichter bij map0
    expect(canonicalForDrawnMap(SN, 'obstacle', square(19, 4, 2), null)).toEqual({
      ok: true,
      canonical: 'map0_0_obstacle',
    });
  });

  it('weigert een obstakel pas als er helemaal geen werkgebied is', () => {
    const res = canonicalForDrawnMap(SN, 'obstacle', square(0, 0, 2), null);
    expect(res.ok).toBe(false);
  });

  it('hangt een obstakel aan het gebied waar het in ligt', () => {
    addWork('map0', square(0, 0));
    addWork('map1', square(20, 0));
    expect(canonicalForDrawnMap(SN, 'obstacle', square(21, 1, 2), null)).toEqual({
      ok: true,
      canonical: 'map1_0_obstacle',
    });
  });
});
