/** Pattern mowing utilities — parse mower pattern JSONs, transform to GPS polygons.
 *  Ported from dashboard/src/utils/patternUtils.ts */

const METERS_PER_DEGREE = 111_320;

export interface PatternJson {
  contours: Record<string, string>;
}

export type NormContour = Array<[number, number]>;

function parseContourString(raw: string): Array<[number, number]> {
  return raw.split(',').map(pair => {
    const [x, y] = pair.trim().split(/\s+/).map(Number);
    return [x, y] as [number, number];
  });
}

export function parsePattern(json: PatternJson): NormContour[] {
  const rawContours = Object.values(json.contours).map(parseContourString);
  if (rawContours.length === 0) return [];

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
    const mx = nx * sizeM;
    const my = ny * sizeM;
    const rx = mx * cosR - my * sinR;
    const ry = mx * sinR + my * cosR;
    return {
      lat: center.lat + ry / METERS_PER_DEGREE,
      lng: center.lng + rx / (cosLat * METERS_PER_DEGREE),
    };
  });
}

export function contourToSvgPath(contour: NormContour, size = 60, padding = 4): string {
  const range = size - padding * 2;
  return contour.map(([x, y], i) => {
    const sx = (x + 0.5) * range + padding;
    const sy = (y + 0.5) * range + padding;
    return `${i === 0 ? 'M' : 'L'}${sx.toFixed(1)} ${sy.toFixed(1)}`;
  }).join(' ') + ' Z';
}

// Bundled pattern loader (React Native can't fetch from filesystem)
const PATTERNS: Record<number, PatternJson> = {};

// Lazy-load pattern JSONs
export function loadPattern(id: number): NormContour[] {
  if (PATTERNS[id]) return parsePattern(PATTERNS[id]);
  try {
    // Use require() for bundled assets
    const json = patternRequires[id];
    if (json) {
      PATTERNS[id] = json;
      return parsePattern(json);
    }
  } catch { /* ignore */ }
  return [];
}

export function loadAllPatterns(): Map<number, NormContour[]> {
  const map = new Map<number, NormContour[]>();
  for (let i = 1; i <= 24; i++) {
    const contours = loadPattern(i);
    if (contours.length > 0) map.set(i, contours);
  }
  return map;
}

// Static requires (React Native bundler needs literal paths)
const patternRequires: Record<number, PatternJson> = {
  1: require('../../assets/patterns/pattern_1.json'),
  2: require('../../assets/patterns/pattern_2.json'),
  3: require('../../assets/patterns/pattern_3.json'),
  4: require('../../assets/patterns/pattern_4.json'),
  5: require('../../assets/patterns/pattern_5.json'),
  6: require('../../assets/patterns/pattern_6.json'),
  7: require('../../assets/patterns/pattern_7.json'),
  8: require('../../assets/patterns/pattern_8.json'),
  9: require('../../assets/patterns/pattern_9.json'),
  10: require('../../assets/patterns/pattern_10.json'),
  11: require('../../assets/patterns/pattern_11.json'),
  12: require('../../assets/patterns/pattern_12.json'),
  13: require('../../assets/patterns/pattern_13.json'),
  14: require('../../assets/patterns/pattern_14.json'),
  15: require('../../assets/patterns/pattern_15.json'),
  16: require('../../assets/patterns/pattern_16.json'),
  17: require('../../assets/patterns/pattern_17.json'),
  18: require('../../assets/patterns/pattern_18.json'),
  19: require('../../assets/patterns/pattern_19.json'),
  20: require('../../assets/patterns/pattern_20.json'),
  21: require('../../assets/patterns/pattern_21.json'),
  22: require('../../assets/patterns/pattern_22.json'),
  23: require('../../assets/patterns/pattern_23.json'),
  24: require('../../assets/patterns/pattern_24.json'),
};
