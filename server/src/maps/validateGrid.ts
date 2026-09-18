/**
 * Occupancy-grid validation — the safety gate that prevents shipping a broken
 * map to a mower (which would WIPE the user's working map; see
 * extended_commands.py handle_write_map_files, which clears csv_file/ before
 * writing). Runs on the raster set about to be applied (apply-verbatim) and
 * refuses the push when the map is structurally broken.
 *
 * The failure class this guards against (observed live on LFIN2231000633):
 *  - a per-zone occupancy grid whose free space is split into disconnected
 *    islands (a "wall" through a zone) — coverage plans it but Nav2 can't route
 *    it → "No valid path to goal" (Error 127);
 *  - a bundle whose whole-map and per-map rasters have INCONSISTENT dimensions
 *    (the corrupt bundle that broke David: map.pgm 808x1002 while mapN.pgm were
 *    798x992) — a sign the rasters came from different/mismatched sources.
 *
 * Pure: buffers in, verdict out. No I/O.
 */

export interface PgmGrid { W: number; H: number; data: Uint8Array; }

const FREE_THRESHOLD = 200; // pixel value > this = free (firmware FREE = 254)

/** Per-zone connectivity gate: a single zone's free area must be (nearly) one
 * connected component. Walls drop this to ~0.5-0.7; clean zones are ~0.99+. */
export const PER_MAP_MIN_FRACTION = 0.85;
/** Whole-map fragmentation warning threshold (not a hard block — legitimately
 * disconnected zones without a unicom can lower this). */
export const WHOLE_MAP_WARN_FRACTION = 0.90;
/** Cells in the free dock-approach circle, fillCircle(..., 16, FREE) in
 * occupancyGrid.ts, which the firmware stamps into EVERY per-zone grid. In a zone
 * away from the dock it is a separate island; that is not a wall through the zone. */
const DOCK_CIRCLE_CELLS = 845;

/** Parse a binary P5 (PGM) buffer. Tolerates a single `#` comment line in the
 * header (map_generator.cpp writes one). Returns null on malformed input. */
export function parsePgm(buf: Buffer): PgmGrid | null {
  if (buf.length < 10 || buf[0] !== 0x50 || buf[1] !== 0x35) return null; // "P5"
  let k = 2;
  const skipWs = (): void => {
    while (k < buf.length) {
      const c = buf[k];
      if (c === 0x23) { // '#': comment to end of line
        while (k < buf.length && buf[k] !== 0x0a) k++;
      } else if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        k++;
      } else break;
    }
  };
  const readInt = (): number | null => {
    skipWs();
    let s = k;
    while (k < buf.length && buf[k] >= 0x30 && buf[k] <= 0x39) k++;
    if (k === s) return null;
    return parseInt(buf.toString('ascii', s, k), 10);
  };
  const W = readInt();
  const H = readInt();
  const maxv = readInt();
  if (W === null || H === null || maxv === null || W <= 0 || H <= 0) return null;
  k++; // single whitespace after maxval, then raw bytes
  if (k + W * H > buf.length) return null;
  return { W, H, data: buf.subarray(k, k + W * H) };
}

/** Largest connected free component as a fraction of total free cells
 * (4-connectivity). frac = 1 means all free cells are one blob. With
 * `ignoreDockCircle`, an isolated dock-approach circle is left out. */
export function largestFreeFraction(g: PgmGrid, ignoreDockCircle = false): {
  frac: number; largest: number; total: number; components: number;
} {
  const { W, H, data } = g;
  const n = W * H;
  const free = new Uint8Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (data[i] > FREE_THRESHOLD) { free[i] = 1; total++; }
  }
  if (total === 0) return { frac: 0, largest: 0, total: 0, components: 0 };
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  let largest = 0, components = 0, ignored = 0;
  for (let start = 0; start < n; start++) {
    if (!free[start] || seen[start]) continue;
    components++;
    let size = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop() as number;
      size++;
      const x = p % W, y = (p - x) / W;
      if (x + 1 < W) { const q = p + 1; if (free[q] && !seen[q]) { seen[q] = 1; stack.push(q); } }
      if (x - 1 >= 0) { const q = p - 1; if (free[q] && !seen[q]) { seen[q] = 1; stack.push(q); } }
      if (y + 1 < H) { const q = p + W; if (free[q] && !seen[q]) { seen[q] = 1; stack.push(q); } }
      if (y - 1 >= 0) { const q = p - W; if (free[q] && !seen[q]) { seen[q] = 1; stack.push(q); } }
    }
    if (ignoreDockCircle && size === DOCK_CIRCLE_CELLS) { ignored += size; continue; }
    if (size > largest) largest = size;
  }
  return { frac: largest / Math.max(1, total - ignored), largest, total, components };
}

export interface BundleValidation {
  ok: boolean;
  hardFailures: string[];
  warnings: string[];
  stats: Record<string, { W: number; H: number; frac: number; total: number }>;
}

/** Validate the raster set (base64-encoded *.pgm keyed by filename) that is
 * about to be pushed to a mower. Hard-fails on dimension mismatch or a
 * fragmented per-zone grid; warns on whole-map fragmentation. */
export function validateMapRasters(
  mapFilesB64: Record<string, string> | undefined,
  opts: { perMapMin?: number; wholeWarn?: number } = {},
): BundleValidation {
  const perMapMin = opts.perMapMin ?? PER_MAP_MIN_FRACTION;
  const wholeWarn = opts.wholeWarn ?? WHOLE_MAP_WARN_FRACTION;
  const hardFailures: string[] = [];
  const warnings: string[] = [];
  const stats: BundleValidation['stats'] = {};

  const grids: { name: string; g: PgmGrid }[] = [];
  for (const [name, b64] of Object.entries(mapFilesB64 ?? {})) {
    if (!name.endsWith('.pgm')) continue;
    let g: PgmGrid | null = null;
    try { g = parsePgm(Buffer.from(b64, 'base64')); } catch { g = null; }
    if (!g) { hardFailures.push(`${name}: unparseable PGM`); continue; }
    grids.push({ name, g });
  }
  if (grids.length === 0) {
    // Either no rasters at all (mower regenerates on-device → allowed) OR every
    // raster failed to parse (hardFailures populated → blocked). Decide on
    // hardFailures, never an unconditional pass.
    return { ok: hardFailures.length === 0, hardFailures, warnings, stats };
  }

  // 1) Dimension consistency across all rasters.
  const dims = new Set(grids.map(({ g }) => `${g.W}x${g.H}`));
  if (dims.size > 1) {
    hardFailures.push(`raster dimension mismatch: ${grids.map(({ name, g }) => `${name}=${g.W}x${g.H}`).join(', ')}`);
  }

  // 2) Per-zone + whole-map connectivity.
  for (const { name, g } of grids) {
    const isZone = /^map\d+\.pgm$/.test(name);
    const { frac, total } = largestFreeFraction(g, isZone);
    stats[name] = { W: g.W, H: g.H, frac, total };
    if (isZone) {
      if (total > 0 && frac < perMapMin) {
        hardFailures.push(`${name}: zone free-space fragmented (largest component ${(frac * 100).toFixed(0)}% < ${(perMapMin * 100).toFixed(0)}%)`);
      }
    } else if (name === 'map.pgm') {
      if (total > 0 && frac < wholeWarn) {
        warnings.push(`map.pgm: whole-map free-space ${(frac * 100).toFixed(0)}% in largest component (< ${(wholeWarn * 100).toFixed(0)}%) — possible disconnected zones`);
      }
    }
  }

  return { ok: hardFailures.length === 0, hardFailures, warnings, stats };
}
