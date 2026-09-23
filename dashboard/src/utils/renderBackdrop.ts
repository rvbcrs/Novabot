/**
 * Lift the angled render's plot off its backdrop.
 *
 * The image model paints the plot as an island on a plain backdrop: flat white
 * by day, a dark blue gradient at night. The panel is wider than the 3:2
 * picture, so that backdrop showed as a box around the island. Flooding in
 * from the edges finds it: a pixel joins when it is close to its neighbour
 * (follows the night gradient) and not far from the backdrop's colour (stops at
 * the island, whose dark hedges at night are the nearest call).
 *
 * Works on raw RGBA so it runs the same in a browser canvas and in a check.
 */

/** Largest step between neighbouring backdrop pixels (sum of |ΔR|+|ΔG|+|ΔB|). */
const STEP = 10;
/** Largest distance from the backdrop colour (Euclidean RGB). Tuned on real
 *  night renders: 60 ate dark hedge at the island's edge, 45 keeps it. */
const CAP = 45;

export interface Keyed {
  /** Alpha per pixel: 0 for backdrop, 255 for the island, feathered between. */
  alpha: Uint8ClampedArray;
  /** The island's bounding box in pixels, or null when nothing was left. */
  box: { x: number; y: number; w: number; h: number } | null;
}

export function keyBackdrop(rgba: Uint8ClampedArray, w: number, h: number): Keyed {
  const n = w * h;
  // Backdrop colour: median of the outer ring, per channel.
  const ring: number[][] = [[], [], []];
  const sample = (i: number) => { for (let c = 0; c < 3; c++) ring[c].push(rgba[i * 4 + c]); };
  for (let x = 0; x < w; x++) { sample(x); sample((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { sample(y * w); sample(y * w + w - 1); }
  const bg = ring.map(v => v.sort((a, b) => a - b)[v.length >> 1]);

  const nearBg = (i: number) => {
    const r = rgba[i * 4] - bg[0], g = rgba[i * 4 + 1] - bg[1], b = rgba[i * 4 + 2] - bg[2];
    return r * r + g * g + b * b < CAP * CAP;
  };
  const step = (i: number, j: number) =>
    Math.abs(rgba[i * 4] - rgba[j * 4]) + Math.abs(rgba[i * 4 + 1] - rgba[j * 4 + 1]) + Math.abs(rgba[i * 4 + 2] - rgba[j * 4 + 2]);

  const back = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const seed = (i: number) => { if (!back[i] && nearBg(i)) { back[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const next = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
    for (const j of next) {
      if (j < 0 || j >= n || back[j] || !nearBg(j) || step(i, j) >= STEP) continue;
      back[j] = 1;
      queue[tail++] = j;
    }
  }

  // Erode the island by a pixel (drops the backdrop-tinted fringe), then soften
  // the edge with one 3×3 box blur so it does not look cut out with scissors.
  const hard = new Uint8ClampedArray(n);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (back[i]) continue;
      const edge = (x > 0 && back[i - 1]) || (x < w - 1 && back[i + 1]) || (y > 0 && back[i - w]) || (y < h - 1 && back[i + w]);
      if (edge) continue;
      hard[i] = 255;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const alpha = new Uint8ClampedArray(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += hard[yy * w + xx]; cnt++;
        }
      }
      alpha[y * w + x] = sum / cnt;
    }
  }
  const box = maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  return { alpha, box };
}
