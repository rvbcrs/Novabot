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
    expect(res).toMatchObject({ ok: true, canonical: 'map0tocharge_unicom', replaces: 'row-charge' });
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
