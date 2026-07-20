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

  it('voegt ver uit elkaar liggende tegels van dezelfde klasse niet samen', () => {
    const groepen = groupClusters([
      tegel('a', 0, 0, 'bush'),
      tegel('ver', 9, 9, 'bush'),
    ]);
    expect(groepen).toHaveLength(2);
  });

  it('merget losse detecties 2,5 m uit elkaar NIET (voorkomt uitgerekte blob)', () => {
    // 3 m bleek te ruim: de trampoline werd één blob doordat een losse
    // detectie 2,5 m verderop meegetrokken werd. Met 1 m blijven ze los.
    const a = tegel('a', 0, 0, 'trampoline');
    const b = { ...tegel('b', 0, 0, 'trampoline'), cluster_key: 'b',
                min_x: 4.5, max_x: 6.5, cx: 5.5 };
    expect(groupClusters([a, b])).toHaveLength(2);
  });

  it('overbrugt wel een klein gat (<1 m) in een doorlopend object', () => {
    const a = tegel('a', 0, 0, 'bush');
    const b = { ...tegel('b', 0, 0, 'bush'), cluster_key: 'b',
                min_x: 2.5, max_x: 4.5, cx: 3.5 };  // 0,5 m gat
    expect(groupClusters([a, b])).toHaveLength(1);
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

  it('overlappende clusters van verschillende klasse worden één object (dominante klasse wint)', () => {
    // Het zwembad: deels 'swimming pool' (veel cellen), deels 'trampoline'
    // (weinig cellen) op overlappende bboxen → één zwembad, geen dubbel model.
    const pool = { ...tegel('pool', 0, 0, 'swimming pool', null, 700),
                   min_x: 0, max_x: 2, min_y: 0, max_y: 2, cx: 1, cy: 1 };
    const tramp = { ...tegel('tramp', 0, 0, 'trampoline', null, 60),
                    min_x: 0.5, max_x: 2.5, min_y: 0.5, max_y: 2.5, cx: 1.5, cy: 1.5 };
    const groepen = groupClusters([pool, tramp]);
    expect(groepen).toHaveLength(1);
    expect(groepen[0].className).toBe('swimming pool');
    expect(groepen[0].keys.sort()).toEqual(['pool', 'tramp']);
  });

  it('rakende rastertegels van verschillende klasse blijven los (geen overlap)', () => {
    // Tegels delen een rand (overlap 0) → mogen NIET op de overlap-regel
    // samengaan, anders wordt de hele border weer één blob.
    const a = { ...tegel('a', 0, 0, 'bush'), min_x: 0, max_x: 2, cx: 1 };
    const b = { ...tegel('b', 0, 0, 'tree'), min_x: 2, max_x: 4, cx: 3 };
    expect(groupClusters([a, b])).toHaveLength(2);
  });

  it('override wint als dominante klasse bij een overlappende groep', () => {
    const pool = { ...tegel('pool', 0, 0, 'trampoline', 'swimming pool', 700),
                   min_x: 0, max_x: 2, min_y: 0, max_y: 2, cx: 1, cy: 1 };
    const tramp = { ...tegel('tramp', 0, 0, 'trampoline', null, 60),
                    min_x: 0.5, max_x: 2.5, min_y: 0.5, max_y: 2.5, cx: 1.5, cy: 1.5 };
    const g = groupClusters([pool, tramp])[0];
    expect(g.className).toBe('swimming pool');
    expect(g.userOverride).toBe('swimming pool');
  });


  it('klein brokje volledig in een groot object gaat op in dat object (dominant)', () => {
    // Live-geval 2026-07-20: een trampoline-brokje van 0,25 m lag volledig in
    // de zwembad-tegel maar overlapte maar 0,25 m — een absolute drempel van
    // 0,3 m miste dat. Fractie-regel vangt het wel.
    const pool = { ...tegel('pool', 0, 0, 'swimming pool', null, 800),
                   min_x: 0, max_x: 2, min_y: -14, max_y: -12, cx: 1, cy: -13 };
    const brok = { ...tegel('brok', 0, 0, 'trampoline', null, 12),
                   min_x: 0.30, max_x: 0.55, min_y: -13.10, max_y: -12.85, cx: 0.42, cy: -12.97 };
    const g = groupClusters([pool, brok]);
    expect(g).toHaveLength(1);
    expect(g[0].className).toBe('swimming pool');
  });

  it('object dat maar een klein randje raakt blijft los', () => {
    const pool = { ...tegel('pool', 0, 0, 'swimming pool', null, 800),
                   min_x: 0, max_x: 2, min_y: -14, max_y: -12, cx: 1, cy: -13 };
    // noordelijk buurobject dat maar 0,05 m in de pool dipt (fractie « 0,5)
    const tramp = { ...tegel('tramp', 0, 0, 'trampoline', null, 25),
                    min_x: 1.30, max_x: 1.60, min_y: -12.05, max_y: -11.75, cx: 1.45, cy: -11.9 };
    expect(groupClusters([pool, tramp])).toHaveLength(2);
  });

});
