/** Map metres follow the UTM grid; the dock can have a nonzero map coordinate.
 * Mirrors dashboard/utils/coords.ts and server/mqtt/mapConverter.ts without
 * coupling the native bundle to either application's build configuration. */
export type GpsPoint = { lat: number; lng: number };
export type MapPoint = { x: number; y: number };

function gridAt(ref: GpsPoint) {
  const phi = ref.lat * Math.PI / 180;
  const zone = Math.floor((ref.lng + 180) / 6) + 1;
  const dl = (ref.lng - (zone * 6 - 183)) * Math.PI / 180;
  const gamma = Math.atan(Math.tan(dl) * Math.sin(phi));
  return {
    c: Math.cos(gamma), s: Math.sin(gamma),
    k: 0.9996 * (1 + (dl * Math.cos(phi)) ** 2 / 2),
    mLat: 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi),
    mLng: 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi),
  };
}

export function validMapPoint(p: MapPoint | null | undefined): p is MapPoint {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

export function validGpsPoint(p: GpsPoint | null | undefined): p is GpsPoint {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng)
    && Math.abs(p.lat) < 84 && Math.abs(p.lng) <= 180
    && !(Math.abs(p.lat) < 1e-3 && Math.abs(p.lng) < 1e-3);
}

export function mapToGps(p: MapPoint, dockGps: GpsPoint, anchor: MapPoint): GpsPoint {
  const g = gridAt(dockGps);
  const x = p.x - anchor.x, y = p.y - anchor.y;
  const east = (x * g.c + y * g.s) / g.k;
  const north = (y * g.c - x * g.s) / g.k;
  return { lat: dockGps.lat + north / g.mLat, lng: dockGps.lng + east / g.mLng };
}

export function gpsToMap(p: GpsPoint, dockGps: GpsPoint, anchor: MapPoint): MapPoint {
  const g = gridAt(dockGps);
  const east = (p.lng - dockGps.lng) * g.mLng;
  const north = (p.lat - dockGps.lat) * g.mLat;
  return { x: anchor.x + g.k * (east * g.c - north * g.s), y: anchor.y + g.k * (east * g.s + north * g.c) };
}

/** Match ZIP generation: only geometry receives this translation, never a live pose or the dock anchor. */
export function effectiveMapPoints(points: MapPoint[], offset: MapPoint, canonicalName?: string | null): MapPoint[] {
  const dockChannel = /^map\d+tocharge_unicom(?:\.csv)?$/.test(canonicalName ?? '');
  return points.map((p, i) => dockChannel && i === 0 ? p : { x: p.x + offset.x, y: p.y + offset.y });
}
