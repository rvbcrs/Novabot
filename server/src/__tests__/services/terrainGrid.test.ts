import { describe, it, expect } from 'vitest';
import { parseTgr1, mergeIntoTgm1, tgm1ToDisplayTgr1, tgm1CellCount, parseTgo1, mergeIntoTgmo, tgmoToDisplayTgo1, tgmoCellCount } from '../../services/terrainGrid.js';

function tgr1(cells: Array<[number, number, number, number]>, cellSize = 0.05): Buffer {
  const buf = Buffer.alloc(16 + cells.length * 16);
  buf.write('TGR1', 0, 'ascii');
  buf.writeDoubleLE(cellSize, 4);
  buf.writeInt32LE(cells.length, 12);
  cells.forEach(([ix, iy, mean, cnt], i) => {
    const o = 16 + i * 16;
    buf.writeInt32LE(ix, o); buf.writeInt32LE(iy, o + 4);
    buf.writeFloatLE(mean, o + 8); buf.writeUInt32LE(cnt, o + 12);
  });
  return buf;
}

describe('terrainGrid', () => {
  it('parseTgr1 round-trip incl. negatieve indices', () => {
    const p = parseTgr1(tgr1([[2, 0, 0.3, 1], [-2, -3, 0.5, 4]]));
    expect(p.cellSize).toBe(0.05);
    expect(p.cells.get('2,0')).toEqual({ mean: expect.closeTo(0.3, 5), cnt: 1 });
    expect(p.cells.get('-2,-3')).toEqual({ mean: expect.closeTo(0.5, 5), cnt: 4 });
  });

  it('parseTgr1 weigert verkeerde magic', () => {
    expect(() => parseTgr1(Buffer.from('NOPE0000'))).toThrow(/bad magic/);
  });

  it('merge: nieuwe cel, tweede sessie, mediaan in display', () => {
    let tgm = mergeIntoTgm1(null, tgr1([[0, 0, 0.10, 2]]));
    tgm = mergeIntoTgm1(tgm, tgr1([[0, 0, 0.30, 2]]));
    tgm = mergeIntoTgm1(tgm, tgr1([[0, 0, 0.20, 2]]));
    expect(tgm1CellCount(tgm)).toBe(1);
    const disp = parseTgr1(tgm1ToDisplayTgr1(tgm));
    expect(disp.cells.get('0,0')!.mean).toBeCloseTo(0.20, 5); // mediaan van .1/.3/.2
    expect(disp.cells.get('0,0')!.cnt).toBe(6);
  });

  it('merge: >7 sessies laat de oudste vallen', () => {
    let tgm: Buffer | null = null;
    for (let i = 1; i <= 9; i++) tgm = mergeIntoTgm1(tgm, tgr1([[1, 1, i / 10, 1]]));
    const disp = parseTgr1(tgm1ToDisplayTgr1(tgm!));
    // slots = sessies 3..9 → mediaan 0.6
    expect(disp.cells.get('1,1')!.mean).toBeCloseTo(0.6, 5);
  });

  it('display-mediaan bij even aantal sessies middelt de twee middelste', () => {
    let tgm: Buffer | null = null;
    for (const v of [0.1, 0.4, 0.2, 0.3]) tgm = mergeIntoTgm1(tgm, tgr1([[0, 0, v, 1]]));
    const disp = parseTgr1(tgm1ToDisplayTgr1(tgm!));
    expect(disp.cells.get('0,0')!.mean).toBeCloseTo(0.25, 5); // (0.2+0.3)/2
  });

  it('parse van afgekapt TGM1 gooit nette Error', () => {
    const tgm = mergeIntoTgm1(null, tgr1([[0, 0, 0.1, 1]]));
    expect(() => tgm1ToDisplayTgr1(tgm.subarray(0, tgm.length - 5))).toThrow(/truncated/);
  });
});

function tgo1(cells: Array<[number, number, number, number, number]>, cellSize = 0.05): Buffer {
  const buf = Buffer.alloc(16 + cells.length * 17);
  buf.write('TGO1', 0, 'ascii');
  buf.writeDoubleLE(cellSize, 4);
  buf.writeInt32LE(cells.length, 12);
  cells.forEach(([ix, iy, label, maxH, cnt], i) => {
    const o = 16 + i * 17;
    buf.writeInt32LE(ix, o); buf.writeInt32LE(iy, o + 4);
    buf.writeUInt8(label, o + 8); buf.writeFloatLE(maxH, o + 9); buf.writeUInt32LE(cnt, o + 13);
  });
  return buf;
}

describe('terrainGrid objects (TGO1/TGMO)', () => {
  it('parseTgo1 round-trip + truncation', () => {
    const p = parseTgo1(tgo1([[2, -3, 1, 0.45, 9]]));
    expect(p.cells.get('2,-3,1')).toEqual({ maxH: expect.closeTo(0.45, 5), cnt: 9 });
    expect(() => parseTgo1(Buffer.from('NOPE'))).toThrow(/bad magic/);
    const t = tgo1([[0, 0, 1, 0.2, 1]]);
    expect(() => parseTgo1(t.subarray(0, t.length - 3))).toThrow(/truncated/);
  });

  it('mergeIntoTgmo + display-mediaan + 7-ring', () => {
    let tgmo: Buffer | null = null;
    for (const h of [0.10, 0.30, 0.20]) tgmo = mergeIntoTgmo(tgmo, tgo1([[0, 0, 1, h, 2]]));
    expect(tgmoCellCount(tgmo!)).toBe(1);
    const disp = parseTgo1(tgmoToDisplayTgo1(tgmo!));
    expect(disp.cells.get('0,0,1')!.maxH).toBeCloseTo(0.20, 5);
    expect(disp.cells.get('0,0,1')!.cnt).toBe(6);
    for (let i = 1; i <= 9; i++) tgmo = mergeIntoTgmo(tgmo, tgo1([[1, 1, 10, i / 10, 1]]));
    const d2 = parseTgo1(tgmoToDisplayTgo1(tgmo!));
    expect(d2.cells.get('1,1,10')!.maxH).toBeCloseTo(0.6, 5); // slots 3..9
  });
});
