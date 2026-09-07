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
