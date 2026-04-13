/**
 * Coordinate conversion utilities.
 *
 * The database stores map data in local meters with charger at origin (0,0).
 * Leaflet needs GPS (lat/lng). These functions convert between the two systems
 * using the charger's GPS position as the reference point.
 */

export type GpsPoint = { lat: number; lng: number };
export type LocalPoint = { x: number; y: number };

const DEG_TO_M = 111320; // meters per degree latitude

/** Convert local meters (charger=0,0) to GPS coordinates */
export function localToGps(p: LocalPoint, chargerGps: GpsPoint): GpsPoint {
  const cosLat = Math.cos(chargerGps.lat * Math.PI / 180);
  return {
    lat: chargerGps.lat + p.y / DEG_TO_M,
    lng: chargerGps.lng + p.x / (DEG_TO_M * cosLat),
  };
}

/** Convert GPS coordinates to local meters (charger=0,0) */
export function gpsToLocal(p: GpsPoint, chargerGps: GpsPoint): LocalPoint {
  const cosLat = Math.cos(chargerGps.lat * Math.PI / 180);
  return {
    x: (p.lng - chargerGps.lng) * DEG_TO_M * cosLat,
    y: (p.lat - chargerGps.lat) * DEG_TO_M,
  };
}

/** Convert a full polygon from local meters to Leaflet [lat, lng] tuples */
export function polygonToLatLng(
  points: LocalPoint[],
  chargerGps: GpsPoint,
): [number, number][] {
  return points.map(p => {
    const gps = localToGps(p, chargerGps);
    return [gps.lat, gps.lng];
  });
}

/** Polygon area in m² (Shoelace formula on local meter points) */
export function polygonAreaM2(points: LocalPoint[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  return Math.abs(area / 2);
}
