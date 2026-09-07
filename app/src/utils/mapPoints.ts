import type { LocalPoint } from '../services/api';

export function isMapPoint(point: unknown): point is LocalPoint {
  return point != null && typeof point === 'object'
    && 'x' in point && Number.isFinite(point.x)
    && 'y' in point && Number.isFinite(point.y);
}

/** API/cache geometry can be absent before a saved map's outline arrives. */
export function normalizeMapPoints(points: unknown): LocalPoint[] {
  return Array.isArray(points) ? points.filter(isMapPoint) : [];
}

/** The mower reports the actual recording origin after localization finishes. */
export function scanStartPoint(data: unknown): LocalPoint | null {
  const point = (data as { value?: { map_position?: unknown } } | null)?.value?.map_position;
  return isMapPoint(point) ? point : null;
}

/** A return to the first recorded position, after actually leaving its vicinity. */
export function isMappingLoopClosed(points: LocalPoint[], tolerance = 1.5): boolean {
  if (points.length < 10) return false;
  const start = points[0];
  const distance = (point: LocalPoint) => Math.hypot(point.x - start.x, point.y - start.y);
  return points.some(point => distance(point) > tolerance)
    && distance(points[points.length - 1]) <= tolerance;
}
