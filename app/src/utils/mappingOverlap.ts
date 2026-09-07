import type { LocalPoint } from '../services/api';
import type { CachedMap } from '../services/mapsCache';
import { pointInPolygon, polygonArea } from './mapEditGeometry';
import { isMapPoint } from './mapPoints';

const EPSILON = 1e-9; // Floating-point tolerance, not a mower clearance margin.
const cross = (a: LocalPoint, b: LocalPoint, p: LocalPoint) =>
  (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);

function onSegment(p: LocalPoint, a: LocalPoint, b: LocalPoint): boolean {
  return Math.abs(cross(a, b, p)) <= EPSILON
    && p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON
    && p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON;
}

function segmentsTouch(a: LocalPoint, b: LocalPoint, c: LocalPoint, d: LocalPoint): boolean {
  if (onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b)) return true;
  const abC = cross(a, b, c), abD = cross(a, b, d);
  const cdA = cross(c, d, a), cdB = cross(c, d, b);
  return ((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
    && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0));
}

/** Work maps touched by the recorded open trail, including between BLE samples. */
export function findMappingOverlapIds(points: LocalPoint[], maps: CachedMap[]): string[] {
  if (!Array.isArray(points) || !Array.isArray(maps)) return [];
  const overlapping = new Set<string>();
  for (const map of maps) {
    if (map?.mapType !== 'work' || typeof map.mapId !== 'string') continue;
    const polygon = map.points;
    // Do not invent polygon edges by removing malformed vertices.
    if (!Array.isArray(polygon) || polygon.length < 3 || !polygon.every(isMapPoint)) continue;
    const area = polygonArea(polygon);
    if (!Number.isFinite(area) || area === 0) continue;
    if (points.some((point, i) => {
      if (!isMapPoint(point)) return false;
      if (pointInPolygon(point, polygon)) return true;
      // An invalid/missing sample breaks the trail rather than bridging the gap.
      const previous = isMapPoint(points[i - 1]) ? points[i - 1] : point;
      return polygon.some((a, j) => segmentsTouch(previous, point, a, polygon[(j + 1) % polygon.length]));
    })) overlapping.add(map.mapId);
  }
  return [...overlapping];
}
