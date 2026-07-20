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

/**
 * Aaneengesloten begroeiing (border, haag, struiken die elkaar raken) vormt
 * één connected component van tientallen meters. Dat is geen "object":
 * classificatie kan er maar één label aan hangen en een GLB zou naar de hele
 * tuin geschaald worden (les 2026-07-20: 81k-cellen component van 27×22 m
 * werd één trampoline over het gazon). Componenten die breder of dieper zijn
 * dan MAX_SPAN_M worden daarom opgeknipt langs een absoluut tegelraster van
 * TILE_M; elke tegel wordt een eigen cluster met eigen foto en label.
 */
const MAX_SPAN_M = 2.5;
const TILE_M = 2.0;

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

    // Span bepalen; te groot → opknippen langs het absolute tegelraster.
    let spanMinIx = Infinity, spanMinIy = Infinity, spanMaxIx = -Infinity, spanMaxIy = -Infinity;
    for (const m of members) {
      spanMinIx = Math.min(spanMinIx, m.ix); spanMaxIx = Math.max(spanMaxIx, m.ix);
      spanMinIy = Math.min(spanMinIy, m.iy); spanMaxIy = Math.max(spanMaxIy, m.iy);
    }
    const spanX = (spanMaxIx - spanMinIx + 1) * cs;
    const spanY = (spanMaxIy - spanMinIy + 1) * cs;

    if (Math.max(spanX, spanY) <= MAX_SPAN_M) {
      out.push(buildCluster(members, cs, `${Math.floor(spanMinIx / 10)},${Math.floor(spanMinIy / 10)}`));
      continue;
    }

    const tileCells = Math.max(1, Math.round(TILE_M / cs));
    const tiles = new Map<string, typeof members>();
    for (const m of members) {
      const tk = `${Math.floor(m.ix / tileCells)},${Math.floor(m.iy / tileCells)}`;
      const bucket = tiles.get(tk);
      if (bucket) bucket.push(m); else tiles.set(tk, [m]);
    }
    for (const [tk, tileMembers] of tiles) {
      if (tileMembers.length < MIN_CELLS) continue;
      // Tegel-key is absoluut rastergebonden → stabiel over sessies heen,
      // ook als het cluster groeit (anders verschuift de key en raakt een
      // handmatige correctie zijn object kwijt).
      out.push(buildCluster(tileMembers, cs, `t${tk}`));
    }
  }
  return out.sort((a, b) => b.cells - a.cells);
}

type Member = { ix: number; iy: number; maxH: number; label: number; cnt: number };

function buildCluster(members: Member[], cs: number, key: string): Cluster {
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
  return {
    key,
    cells: members.length,
    minX: minIx * cs, minY: minIy * cs,
    maxX: (maxIx + 1) * cs, maxY: (maxIy + 1) * cs,
    cx: (sumX / members.length) * cs + cs / 2,
    cy: (sumY / members.length) * cs + cs / 2,
    maxH, dominantLabel, memberPoints,
  };
}
