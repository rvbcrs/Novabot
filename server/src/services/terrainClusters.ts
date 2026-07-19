import type { Tgo1 } from './terrainGrid.js';

export interface Cluster {
  key: string; cells: number;
  minX: number; minY: number; maxX: number; maxY: number;
  cx: number; cy: number; maxH: number; dominantLabel: number;
  /**
   * Wereld-coördinaten (celcentra, meters) van een deelverzameling van de
   * ledencellen, max ~MEMBER_SAMPLE_MAX punten (gedecimeerd bij grote
   * clusters). Voor frame-matching op de DICHTSTBIJZIJNDE rand van het
   * cluster: het centroid van een langgerekte border ligt midden in het
   * gazon en matcht nooit (les 2026-07-20, 81k-cellen hoefijzer-cluster).
   */
  memberPoints: Array<[number, number]>;
}

/** Max bemonsterde ledenpunten per cluster (geheugen/CPU-grens matching). */
const MEMBER_SAMPLE_MAX = 800;

const MIN_CELLS = 8;

export function clusterObjects(display: Tgo1): Cluster[] {
  const cs = display.cellSize;
  // cel → beste (hoogste) entry over alle labels heen
  const byCell = new Map<string, { ix: number; iy: number; maxH: number; label: number; cnt: number }>();
  for (const [key, v] of display.cells) {
    const [ix, iy, label] = key.split(',').map(Number);
    const ck = `${ix},${iy}`;
    const cur = byCell.get(ck);
    if (!cur || v.maxH > cur.maxH) byCell.set(ck, { ix, iy, maxH: v.maxH, label, cnt: v.cnt });
  }
  const seen = new Set<string>();
  const out: Cluster[] = [];
  for (const [start, first] of byCell) {
    if (seen.has(start)) continue;
    const queue = [first];
    seen.add(start);
    const members: typeof first[] = [];
    while (queue.length) {
      const c = queue.pop()!;
      members.push(c);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nk = `${c.ix + dx},${c.iy + dy}`;
        const n = byCell.get(nk);
        if (n && !seen.has(nk)) { seen.add(nk); queue.push(n); }
      }
    }
    if (members.length < MIN_CELLS) continue;
    let minIx = Infinity, minIy = Infinity, maxIx = -Infinity, maxIy = -Infinity;
    let sumX = 0, sumY = 0, maxH = 0;
    const hist = new Map<number, number>();
    for (const m of members) {
      minIx = Math.min(minIx, m.ix); maxIx = Math.max(maxIx, m.ix);
      minIy = Math.min(minIy, m.iy); maxIy = Math.max(maxIy, m.iy);
      sumX += m.ix; sumY += m.iy;
      maxH = Math.max(maxH, m.maxH);
      hist.set(m.label, (hist.get(m.label) ?? 0) + m.cnt);
    }
    const dominantLabel = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const stride = Math.max(1, Math.ceil(members.length / MEMBER_SAMPLE_MAX));
    const memberPoints: Array<[number, number]> = [];
    for (let i = 0; i < members.length; i += stride) {
      memberPoints.push([members[i].ix * cs + cs / 2, members[i].iy * cs + cs / 2]);
    }
    out.push({
      key: `${Math.floor(minIx / 10)},${Math.floor(minIy / 10)}`,
      cells: members.length,
      minX: minIx * cs, minY: minIy * cs,
      maxX: (maxIx + 1) * cs, maxY: (maxIy + 1) * cs,
      cx: (sumX / members.length) * cs + cs / 2,
      cy: (sumY / members.length) * cs + cs / 2,
      maxH, dominantLabel, memberPoints,
    });
  }
  return out.sort((a, b) => b.cells - a.cells);
}
