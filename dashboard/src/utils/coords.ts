/**
 * Coordinate conversion utilities.
 *
 * The database stores map data in local meters with charger at origin (0,0).
 * Leaflet needs GPS (lat/lng). These functions convert between the two systems
 * using the charger's GPS position as the reference point.
 */

export type GpsPoint = { lat: number; lng: number };
export type LocalPoint = { x: number; y: number };
export interface MapDisplayCalibration { offsetLat: number; offsetLng: number; rotation: number; scale: number }

/** Existing display transform, with a physical geometry offset applied BEFORE rotation/scale. */
export function calibrateGps(p: GpsPoint, cal: MapDisplayCalibration, center: GpsPoint, geometryOffset: GpsPoint = { lat: 0, lng: 0 }): GpsPoint {
  const angle = cal.rotation * Math.PI / 180;
  const a = (p.lat + geometryOffset.lat - center.lat) * cal.scale;
  const b = (p.lng + geometryOffset.lng - center.lng) * cal.scale;
  return {
    lat: center.lat + a * Math.cos(angle) - b * Math.sin(angle) + cal.offsetLat,
    lng: center.lng + a * Math.sin(angle) + b * Math.cos(angle) + cal.offsetLng,
  };
}

/** Exact inverse used by drawing, editing and navigation. Invalid calibration yields no usable point. */
export function uncalibrateGps(p: GpsPoint, cal: MapDisplayCalibration, center: GpsPoint, geometryOffset: GpsPoint = { lat: 0, lng: 0 }): GpsPoint {
  if (!Number.isFinite(cal.scale) || cal.scale <= 0) return { lat: NaN, lng: NaN };
  const angle = cal.rotation * Math.PI / 180;
  const a = p.lat - center.lat - cal.offsetLat;
  const b = p.lng - center.lng - cal.offsetLng;
  return {
    lat: center.lat + (a * Math.cos(angle) + b * Math.sin(angle)) / cal.scale - geometryOffset.lat,
    lng: center.lng + (b * Math.cos(angle) - a * Math.sin(angle)) / cal.scale - geometryOffset.lng,
  };
}

/** Separate the ZIP's physical translation from the legacy display offset. Telemetry already includes the former. */
export function splitMapCalibration(active: MapDisplayCalibration, saved: MapDisplayCalibration, physicalOffset: LocalPoint, ref: GpsPoint): { display: MapDisplayCalibration; geometryOffset: GpsPoint } {
  const shifted = localToGps(physicalOffset, ref);
  const display = {
    ...active,
    offsetLat: saved.offsetLat - (shifted.lat - ref.lat),
    offsetLng: saved.offsetLng - (shifted.lng - ref.lng),
  };
  return { display, geometryOffset: { lat: active.offsetLat - display.offsetLat, lng: active.offsetLng - display.offsetLng } };
}

/**
 * The mower's map frame is UTM minus an origin (robot_combination_localization
 * projects with +proj=utm), so a map metre runs along the UTM grid, and grid
 * north differs from true north by the meridian convergence: about 2.2° in
 * the Netherlands, a metre at 25 m from the dock. Around the reference point
 * the projection is that rotation plus the grid scale factor, exact to well
 * under a centimetre across a garden (checked against PROJ in coords.check.ts).
 */
function gridAt(ref: GpsPoint) {
  const phi = ref.lat * Math.PI / 180;
  const zone = Math.floor((ref.lng + 180) / 6) + 1;
  const dl = (ref.lng - (zone * 6 - 183)) * Math.PI / 180;
  const gamma = Math.atan(Math.tan(dl) * Math.sin(phi));
  return {
    c: Math.cos(gamma),
    s: Math.sin(gamma),
    k: 0.9996 * (1 + (dl * Math.cos(phi)) ** 2 / 2),
    mLat: 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi),
    mLng: 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi),
  };
}

/** Convert map metres relative to the reference point (the dock pin) to GPS. */
export function localToGps(p: LocalPoint, chargerGps: GpsPoint): GpsPoint {
  const g = gridAt(chargerGps);
  const e = (p.x * g.c + p.y * g.s) / g.k;
  const n = (p.y * g.c - p.x * g.s) / g.k;
  return { lat: chargerGps.lat + n / g.mLat, lng: chargerGps.lng + e / g.mLng };
}

/** Convert GPS to map metres relative to the reference point (the dock pin). */
export function gpsToLocal(p: GpsPoint, chargerGps: GpsPoint): LocalPoint {
  const g = gridAt(chargerGps);
  const e = (p.lng - chargerGps.lng) * g.mLng;
  const n = (p.lat - chargerGps.lat) * g.mLat;
  return { x: g.k * (e * g.c - n * g.s), y: g.k * (e * g.s + n * g.c) };
}

/**
 * True when `chargerGps` has finite numeric `lat` + `lng`. Use this to
 * guard local↔GPS conversions before they propagate NaN into Leaflet
 * — Leaflet rejects NaN with "Invalid LatLng object" and white-screens
 * the page (issue #15).
 */
export function isUsableChargerGps(g: GpsPoint | null | undefined): g is GpsPoint {
  return !!g && Number.isFinite(g.lat) && Number.isFinite(g.lng)
    // Reject (0,0) "null island": never a real charger position, and plotting
    // the whole map relative to it dumps the mower into the Atlantic.
    && !(Math.abs(g.lat) < 1e-3 && Math.abs(g.lng) < 1e-3);
}

/**
 * Convert a full polygon from local meters to Leaflet `[lat, lng]` tuples.
 * Skips any vertex that produces a non-finite GPS pair so a single bad
 * point never crashes the whole polygon render.
 */
export function polygonToLatLng(
  points: LocalPoint[],
  chargerGps: GpsPoint,
): [number, number][] {
  if (!isUsableChargerGps(chargerGps)) return [];
  const out: [number, number][] = [];
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const gps = localToGps(p, chargerGps);
    if (Number.isFinite(gps.lat) && Number.isFinite(gps.lng)) {
      out.push([gps.lat, gps.lng]);
    }
  }
  return out;
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
