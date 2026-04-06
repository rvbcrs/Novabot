/** Pattern mowing utilities — parse mower pattern JSONs, transform to GPS polygons */

const METERS_PER_DEGREE = 111_320;

export interface PatternJson {
  contours: Record<string, string>;
}

/** Parsed + normalised contour: each point in range [-0.5, 0.5] centered at origin */
export type NormContour = Array<[number, number]>;

// ── Parsing ──────────────────────────────────────────────────────────────────

/** Parse raw contour string "x y,x y,..." into [[x,y], ...] */
function parseContourString(raw: string): Array<[number, number]> {
  return raw.split(',').map(pair => {
    const [x, y] = pair.trim().split(/\s+/).map(Number);
    return [x, y] as [number, number];
  });
}

/** Parse pattern JSON and normalise all contours to [-0.5 … 0.5] centered at origin.
 *  The longest axis of the overall bounding box becomes 1.0. */
export function parsePattern(json: PatternJson): NormContour[] {
  const rawContours = Object.values(json.contours).map(parseContourString);
  if (rawContours.length === 0) return [];

  // Global bounding box across all contours
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of rawContours) {
    for (const [x, y] of c) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const scale = Math.max(w, h);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  return rawContours.map(contour =>
    contour.map(([x, y]) => [(x - cx) / scale, (y - cy) / scale] as [number, number]),
  );
}

// ── GPS transformation ───────────────────────────────────────────────────────

/** Transform a normalised contour to GPS coordinates.
 *  @param contour  Normalised points in [-0.5, 0.5]
 *  @param center   GPS center where the pattern is placed
 *  @param sizeM    Width/height of the pattern in meters (longest axis)
 *  @param rotDeg   Rotation in degrees (clockwise)
 */
export function transformToGps(
  contour: NormContour,
  center: { lat: number; lng: number },
  sizeM: number,
  rotDeg: number,
): Array<{ lat: number; lng: number }> {
  const rad = (rotDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const cosLat = Math.cos((center.lat * Math.PI) / 180);

  return contour.map(([nx, ny]) => {
    // Scale to meters
    const mx = nx * sizeM;
    const my = ny * sizeM;
    // Rotate (clockwise)
    const rx = mx * cosR - my * sinR;
    const ry = mx * sinR + my * cosR;
    // Meters → GPS offset (y=lat, x=lng)
    return {
      lat: center.lat + ry / METERS_PER_DEGREE,
      lng: center.lng + rx / (cosLat * METERS_PER_DEGREE),
    };
  });
}

// ── SVG thumbnail ────────────────────────────────────────────────────────────

/** Generate an SVG path `d` attribute from a normalised contour.
 *  Maps [-0.5, 0.5] → [padding, size-padding] inside an `size×size` viewBox. */
export function contourToSvgPath(contour: NormContour, size = 60, padding = 4): string {
  const range = size - padding * 2;
  const parts = contour.map(([x, y], i) => {
    const sx = (x + 0.5) * range + padding;
    const sy = (y + 0.5) * range + padding;
    return `${i === 0 ? 'M' : 'L'}${sx.toFixed(1)} ${sy.toFixed(1)}`;
  });
  return parts.join(' ') + ' Z';
}

// ── Loader ───────────────────────────────────────────────────────────────────

const patternCache = new Map<number, NormContour[]>();

/** Load and parse a pattern by ID (1-24). Caches the result. */
export async function loadPattern(id: number): Promise<NormContour[]> {
  const cached = patternCache.get(id);
  if (cached) return cached;

  const res = await fetch(`/patterns/pattern_${id}.json`);
  if (!res.ok) throw new Error(`Pattern ${id} not found`);
  const json: PatternJson = await res.json();
  const contours = parsePattern(json);
  patternCache.set(id, contours);
  return contours;
}

/** Preload all 24 patterns (call once on mount). */
export async function preloadPatterns(): Promise<Map<number, NormContour[]>> {
  const results = await Promise.all(
    Array.from({ length: 24 }, (_, i) => loadPattern(i + 1)),
  );
  const map = new Map<number, NormContour[]>();
  results.forEach((contours, i) => map.set(i + 1, contours));
  return map;
}
