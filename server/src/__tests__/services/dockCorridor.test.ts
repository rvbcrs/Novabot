/**
 * Waarschuwing: obstakel in de uitrijbaan van het dock (Novabot-25m).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../mqtt/broker.js', () => ({ isDeviceOnline: vi.fn(() => true) }));

import { mapRepo, mapEditsRepo } from '../../db/repositories/index.js';
import { getEditGeometry, saveDraft } from '../../services/mapEdit.js';
import { dockCorridorWarnings, obstacleInDockCorridor } from '../../services/dockCorridor.js';
import { translator } from '../../services/serverText.js';

/** Vierkant obstakel, zijde s, middelpunt (cx, cy). */
const box = (cx: number, cy: number, s = 0.3) => [
  { x: cx - s / 2, y: cy - s / 2 }, { x: cx + s / 2, y: cy - s / 2 },
  { x: cx + s / 2, y: cy + s / 2 }, { x: cx - s / 2, y: cy + s / 2 },
];

describe('obstacleInDockCorridor (zuiver)', () => {
  // Dock op (0,0), maaier kijkt naar +x (orientation 0): hij rijdt achteruit naar -x.
  const dock = { x: 0, y: 0, orientation: 0 };

  it('obstakel recht achter het dock ligt in de uitrijbaan', () => {
    expect(obstacleInDockCorridor(box(-1, 0), { dock, channels: [] })).toBe(true);
    // Rand van de 1,4 m baan (+0,1 m marge): 0,75 m opzij raakt nog.
    expect(obstacleInDockCorridor(box(-1, 0.9), { dock, channels: [] })).toBe(true);
  });

  it('obstakel naast de baan of ver weg niet', () => {
    expect(obstacleInDockCorridor(box(-1, 1.5), { dock, channels: [] })).toBe(false);
    expect(obstacleInDockCorridor(box(-6, 0), { dock, channels: [] })).toBe(false);
  });

  it('zonder bevestigde dockrichting en zonder kanaal: geen waarschuwing', () => {
    expect(obstacleInDockCorridor(box(-1, 0), { dock: { x: 0, y: 0 }, channels: [] })).toBe(false);
  });

  it('volgt het opgeslagen dockkanaal, ook zonder dockrichting', () => {
    const channels = [[{ x: 0, y: 0 }, { x: 0, y: -1 }, { x: 0, y: -3 }]];
    expect(obstacleInDockCorridor(box(0.3, -2, 0.2), { dock: { x: 0, y: 0 }, channels })).toBe(true);
    expect(obstacleInDockCorridor(box(2, -2, 0.2), { dock: { x: 0, y: 0 }, channels })).toBe(false);
  });

  it('een kapot obstakel (minder dan 3 punten) telt niet', () => {
    expect(obstacleInDockCorridor([{ x: -1, y: 0 }, { x: -1.1, y: 0 }], { dock, channels: [] })).toBe(false);
  });
});

const sn = 'LFIN_CORRIDOR';
const work = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
// Dock op (0,0) binnen map0; de maaier kijkt naar +y en rijdt achteruit naar -y,
// net als het opgeslagen dockkanaal.
const dockChannel = [{ x: 0, y: 0 }, { x: 0, y: -1 }, { x: 0, y: -3 }];

function seed(opts: { channel?: boolean } = {}) {
  mapRepo.create({ map_id: 'w0', mower_sn: sn, map_type: 'work', file_name: 'map0_work.csv', map_area: JSON.stringify(work) });
  if (opts.channel !== false) {
    mapRepo.create({ map_id: 'u0', mower_sn: sn, map_type: 'unicom', file_name: 'map0tocharge_unicom.csv', map_area: JSON.stringify(dockChannel) });
  }
  mapRepo.setPolygonChargingOrientation(sn, Math.PI / 2);
}

describe('dock corridor warning bij tekenen/bewerken', () => {
  beforeEach(() => {
    for (const m of mapRepo.findByMowerSn(sn)) mapRepo.deleteWithCascade(m.map_id, sn);
    mapEditsRepo.clearDrafts(sn);
    mapRepo.setPolygonOffset(sn, 0, 0);
  });

  it('nieuw getekend obstakel in de uitrijbaan: waarschuwing in de edit-geometrie', () => {
    seed();
    const res = saveDraft(sn, { mapType: 'obstacle', parentMap: 'map0', points: box(0.2, -1.5) });
    expect(res.ok).toBe(true);
    const g = getEditGeometry(sn);
    expect(g.warnings).toEqual([
      { canonical: res.canonical, code: 'dock_corridor', message: expect.stringContaining('dock exit lane') },
    ]);
  });

  it('obstakel buiten de baan: geen waarschuwing', () => {
    seed();
    saveDraft(sn, { mapType: 'obstacle', parentMap: 'map0', points: box(5, 5) });
    expect(getEditGeometry(sn).warnings).toEqual([]);
  });

  it('bestaand obstakel in de baan bewerken waarschuwt; onaangeroerd of verwijderd niet', () => {
    seed();
    mapRepo.create({ map_id: 'o0', mower_sn: sn, map_type: 'obstacle', file_name: 'map0_0_obstacle.csv', map_area: JSON.stringify(box(0, -2)) });
    expect(getEditGeometry(sn).warnings).toEqual([]);           // niet bewerkt: geen melding
    saveDraft(sn, { canonical: 'map0_0_obstacle', points: box(0.1, -2) });
    expect(getEditGeometry(sn).warnings.map(w => w.canonical)).toEqual(['map0_0_obstacle']);
    saveDraft(sn, { canonical: 'map0_0_obstacle', deleted: true });
    expect(getEditGeometry(sn).warnings).toEqual([]);
  });

  it('zonder dockkanaal (geen dockanker) valt er niets te waarschuwen', () => {
    seed({ channel: false });
    saveDraft(sn, { mapType: 'obstacle', parentMap: 'map0', points: box(0.2, -1.5) });
    expect(getEditGeometry(sn).warnings).toEqual([]);
  });

  it('melding in de taal van de lezer', () => {
    seed();
    saveDraft(sn, { mapType: 'obstacle', parentMap: 'map0', points: box(0.2, -1.5) });
    expect(getEditGeometry(sn, translator('nl')).warnings[0].message).toMatch(/^Dit obstakel ligt in de uitrijbaan/);
  });

  it('rekent in het frame van de maaier: de polygoonverschuiving geldt voor het obstakel, niet voor het dock', () => {
    seed();
    // Opgeslagen 5 m links; met +5 m verschuiving staat het fysiek recht achter het dock.
    const obstacle = [{ canonical: 'map0_1_obstacle', points: box(-5, -1.2) }];
    expect(dockCorridorWarnings(sn, obstacle)).toEqual([]);
    mapRepo.setPolygonOffset(sn, 5, 0);
    expect(dockCorridorWarnings(sn, obstacle).map(w => w.canonical)).toEqual(['map0_1_obstacle']);
  });
});
