/**
 * TGR1 (sessie-grid van de maaier) en TGM1 (persistent merge-bestand).
 * Formaten: zie docs/superpowers/plans/2026-07-17-terrain-3d-map.md.
 * Pure Buffer-functies — geen fs/DB, volledig unit-testbaar.
 */

const TGR_HEADER = 16;
const TGR_CELL = 16;
const TGM_HEADER = 16;
const TGM_CELL = 41;
const SLOTS = 7;

export interface Tgr1 { cellSize: number; cells: Map<string, { mean: number; cnt: number }> }

export function parseTgr1(buf: Buffer): Tgr1 {
  if (buf.length < TGR_HEADER || buf.toString('ascii', 0, 4) !== 'TGR1') throw new Error('bad magic');
  const cellSize = buf.readDoubleLE(4);
  const n = buf.readInt32LE(12);
  if (buf.length < TGR_HEADER + n * TGR_CELL) throw new Error('truncated TGR1');
  const cells = new Map<string, { mean: number; cnt: number }>();
  for (let i = 0; i < n; i++) {
    const o = TGR_HEADER + i * TGR_CELL;
    cells.set(`${buf.readInt32LE(o)},${buf.readInt32LE(o + 4)}`,
      { mean: buf.readFloatLE(o + 8), cnt: buf.readUInt32LE(o + 12) });
  }
  return { cellSize, cells };
}

interface TgmCell { k: number; samples: number[]; cnt: number }

function parseTgm1(buf: Buffer): { cellSize: number; cells: Map<string, TgmCell> } {
  if (buf.toString('ascii', 0, 4) !== 'TGM1') throw new Error('bad magic');
  const cellSize = buf.readDoubleLE(4);
  const n = buf.readInt32LE(12);
  const cells = new Map<string, TgmCell>();
  for (let i = 0; i < n; i++) {
    const o = TGM_HEADER + i * TGM_CELL;
    const k = buf.readUInt8(o + 8);
    const samples: number[] = [];
    for (let s = 0; s < k; s++) samples.push(buf.readFloatLE(o + 9 + s * 4));
    cells.set(`${buf.readInt32LE(o)},${buf.readInt32LE(o + 4)}`,
      { k, samples, cnt: buf.readUInt32LE(o + 37) });
  }
  return { cellSize, cells };
}

function writeTgm1(cellSize: number, cells: Map<string, TgmCell>): Buffer {
  const buf = Buffer.alloc(TGM_HEADER + cells.size * TGM_CELL);
  buf.write('TGM1', 0, 'ascii');
  buf.writeDoubleLE(cellSize, 4);
  buf.writeInt32LE(cells.size, 12);
  let i = 0;
  for (const [key, c] of cells) {
    const o = TGM_HEADER + i++ * TGM_CELL;
    const [ix, iy] = key.split(',').map(Number);
    buf.writeInt32LE(ix, o); buf.writeInt32LE(iy, o + 4);
    buf.writeUInt8(c.samples.length, o + 8);
    c.samples.forEach((v, s) => buf.writeFloatLE(v, o + 9 + s * 4));
    buf.writeUInt32LE(c.cnt, o + 37);
  }
  return buf;
}

export function mergeIntoTgm1(existing: Buffer | null, session: Buffer): Buffer {
  const s = parseTgr1(session);
  const base = existing ? parseTgm1(existing) : { cellSize: s.cellSize, cells: new Map<string, TgmCell>() };
  for (const [key, cell] of s.cells) {
    const cur = base.cells.get(key) ?? { k: 0, samples: [], cnt: 0 };
    cur.samples.push(cell.mean);
    if (cur.samples.length > SLOTS) cur.samples.shift(); // oudste sessie eruit
    cur.cnt += cell.cnt;
    base.cells.set(key, cur);
  }
  return writeTgm1(base.cellSize, base.cells);
}

export function tgm1CellCount(tgm: Buffer): number {
  return tgm.readInt32LE(12);
}

export function tgm1ToDisplayTgr1(tgm: Buffer): Buffer {
  const { cellSize, cells } = parseTgm1(tgm);
  const out = Buffer.alloc(TGR_HEADER + cells.size * TGR_CELL);
  out.write('TGR1', 0, 'ascii');
  out.writeDoubleLE(cellSize, 4);
  out.writeInt32LE(cells.size, 12);
  let i = 0;
  for (const [key, c] of cells) {
    const o = TGR_HEADER + i++ * TGR_CELL;
    const [ix, iy] = key.split(',').map(Number);
    const sorted = [...c.samples].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    out.writeInt32LE(ix, o); out.writeInt32LE(iy, o + 4);
    out.writeFloatLE(median, o + 8);
    out.writeUInt32LE(c.cnt, o + 12);
  }
  return out;
}
