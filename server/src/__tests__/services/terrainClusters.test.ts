import { describe, it, expect } from 'vitest';
import { clusterObjects } from '../../services/terrainClusters.js';
import { parseTgo1 } from '../../services/terrainGrid.js';

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

describe('clusterObjects', () => {
  it('groepeert 8-connected cellen, negeert mini-clusters', () => {
    // 3x3-blok (9 cellen, cluster) + losse cel (ruis)
    const cells: Array<[number, number, number, number, number]> = [];
    for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) cells.push([x, y, 1, 0.5, 3]);
    cells.push([50, 50, 1, 0.4, 1]);
    const cl = clusterObjects(parseTgo1(tgo1(cells)));
    expect(cl.length).toBe(1);
    expect(cl[0].cells).toBe(9);
    expect(cl[0].cx).toBeCloseTo(0.075, 3);   // (0+1+2)/3 * 0.05 + 0.025
    expect(cl[0].maxH).toBeCloseTo(0.5, 5);
    expect(cl[0].dominantLabel).toBe(1);
  });

  it('diagonale verbinding telt (8-connectivity)', () => {
    const cells: Array<[number, number, number, number, number]> = [];
    for (let i = 0; i < 8; i++) cells.push([i, i, 8, 0.3, 1]);   // diagonale sliert van 8
    expect(clusterObjects(parseTgo1(tgo1(cells))).length).toBe(1);
  });

  it('stabiele key op 10-cellen-raster', () => {
    const cells: Array<[number, number, number, number, number]> = [];
    for (let x = 12; x < 15; x++) for (let y = 23; y < 26; y++) cells.push([x, y, 1, 0.5, 1]);
    expect(clusterObjects(parseTgo1(tgo1(cells)))[0].key).toBe('1,2');
  });
});

describe('grote componenten opknippen', () => {
  it('splitst een aaneengesloten strook van >2.5m in tegels van max 2m', () => {
    // 100 cellen breed (5m bij 5cm) x 10 diep: één component, te breed.
    const cells = new Map<string, { maxH: number; cnt: number }>();
    for (let ix = 0; ix < 100; ix++) {
      for (let iy = 0; iy < 10; iy++) cells.set(`${ix},${iy},1`, { maxH: 0.5, cnt: 3 });
    }
    const out = clusterObjects({ cellSize: 0.05, cells } as never);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.maxX - c.minX).toBeLessThanOrEqual(2.0 + 1e-9);
      expect(c.key.startsWith('t')).toBe(true);
    }
    expect(out.reduce((n, c) => n + c.cells, 0)).toBe(1000);
  });

  it('laat een klein object ongemoeid (één cluster, oude key-vorm)', () => {
    const cells = new Map<string, { maxH: number; cnt: number }>();
    for (let ix = 0; ix < 8; ix++) for (let iy = 0; iy < 4; iy++) cells.set(`${ix},${iy},1`, { maxH: 0.4, cnt: 2 });
    const out = clusterObjects({ cellSize: 0.05, cells } as never);
    expect(out).toHaveLength(1);
    expect(out[0].key.startsWith('t')).toBe(false);
  });
});
