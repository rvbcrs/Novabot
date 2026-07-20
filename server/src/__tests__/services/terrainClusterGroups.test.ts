import { describe, it, expect } from 'vitest';
import { groupClusters, groupKeysFor, type GroupableRow } from '../../services/terrainClusterGroups.js';

/** Tegel van 2x2 m op tegelpositie (tx,ty), met klasse en optionele correctie. */
function tegel(key: string, tx: number, ty: number, klasse: string | null, override: string | null = null, cells = 100): GroupableRow {
  return {
    cluster_key: key,
    min_x: tx * 2, max_x: tx * 2 + 2,
    min_y: ty * 2, max_y: ty * 2 + 2,
    cx: tx * 2 + 1, cy: ty * 2 + 1,
    cells, max_h: 0.5,
    class_name: klasse, confidence: klasse ? 0.4 : null,
    crop_file: klasse ? `${key}.jpg` : null,
    user_override: override,
  };
}

describe('groupClusters', () => {
  it('voegt aangrenzende tegels met dezelfde klasse samen tot één object', () => {
    const groepen = groupClusters([
      tegel('a', 0, 0, 'swimming pool'),
      tegel('b', 1, 0, 'swimming pool'),
      tegel('c', 2, 0, 'swimming pool'),
    ]);
    expect(groepen).toHaveLength(1);
    expect(groepen[0].keys.sort()).toEqual(['a', 'b', 'c']);
    expect(groepen[0].cells).toBe(300);
    expect(groepen[0].minX).toBe(0);
    expect(groepen[0].maxX).toBe(6);
  });

  it('houdt verschillende klassen gescheiden, ook naast elkaar', () => {
    const groepen = groupClusters([
      tegel('a', 0, 0, 'swimming pool'),
      tegel('b', 1, 0, 'trampoline'),
    ]);
    expect(groepen).toHaveLength(2);
  });

  it('voegt niet-aangrenzende tegels van dezelfde klasse niet samen', () => {
    const groepen = groupClusters([
      tegel('a', 0, 0, 'bush'),
      tegel('ver', 9, 9, 'bush'),
    ]);
    expect(groepen).toHaveLength(2);
  });

  it('een correctie bepaalt de groep, niet de modelklasse', () => {
    // Buurtegels: één gecorrigeerd naar zwembad, één nog trampoline volgens
    // het model → verschillende groepen, want de effectieve klasse verschilt.
    const groepen = groupClusters([
      tegel('a', 0, 0, 'trampoline', 'swimming pool'),
      tegel('b', 1, 0, 'trampoline'),
    ]);
    expect(groepen).toHaveLength(2);
    // ...maar twee tegels die beide gecorrigeerd zijn horen weer bij elkaar
    const samen = groupClusters([
      tegel('a', 0, 0, 'trampoline', 'swimming pool'),
      tegel('b', 1, 0, 'trampoline', 'swimming pool'),
    ]);
    expect(samen).toHaveLength(1);
  });

  it('clusters zonder klasse blijven los (worden toch voxels)', () => {
    const groepen = groupClusters([
      tegel('a', 0, 0, null),
      tegel('b', 1, 0, null),
    ]);
    expect(groepen).toHaveLength(2);
  });

  it('lange keten valt niet uiteen (haag van vijf tegels)', () => {
    const rijen = [0, 1, 2, 3, 4].map((i) => tegel(`h${i}`, i, 0, 'bush'));
    const groepen = groupClusters(rijen);
    expect(groepen).toHaveLength(1);
    expect(groepen[0].keys).toHaveLength(5);
  });

  it('groupKeysFor geeft alle tegels van het object waar de sleutel in zit', () => {
    const rijen = [tegel('a', 0, 0, 'bush'), tegel('b', 1, 0, 'bush'), tegel('los', 9, 9, 'tree')];
    expect(groupKeysFor(rijen, 'a').sort()).toEqual(['a', 'b']);
    expect(groupKeysFor(rijen, 'los')).toEqual(['los']);
    expect(groupKeysFor(rijen, 'onbekend')).toEqual(['onbekend']);
  });
});
