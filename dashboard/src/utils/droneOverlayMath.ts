/**
 * The geometry of a drone photo laid flat on the map (#124).
 *
 * A placement is a centre (lat/lng), a width on the ground in metres and a
 * rotation in degrees. Rendering applies the rotation as CSS rotate() after
 * Leaflet's translate, which on screen (y down) is the clockwise matrix
 * [[cos, -sin], [sin, cos]]; measured live, a 120x60 px vector under 45°
 * comes out as 42x127, exactly that matrix. Everything here uses the same
 * convention, and the round-trip test pins it.
 *
 * Small area, so a local flat approximation is fine: metres per degree of
 * latitude constant, longitude scaled by cos(lat).
 */
import type { DroneOverlayPlacement } from '../api/client';

export const M_PER_DEG_LAT = 111_320;

export interface PhotoSize { width: number; height: number; }
export interface LatLng { lat: number; lng: number; }
export interface PhotoPixel { u: number; v: number; }

/** Axis-aligned bounds of the unrotated image: [[south, west], [north, east]]. */
export function overlayBounds(p: DroneOverlayPlacement, aspect: number): [[number, number], [number, number]] {
  const heightM = p.widthM / aspect;
  const dLat = heightM / 2 / M_PER_DEG_LAT;
  const dLng = p.widthM / 2 / (M_PER_DEG_LAT * Math.cos(p.lat * Math.PI / 180));
  return [[p.lat - dLat, p.lng - dLng], [p.lat + dLat, p.lng + dLng]];
}

const rad = (deg: number) => deg * Math.PI / 180;

/** Where photo pixel (u, v) lands on the map under this placement. */
export function latLngFromPhotoPixel(p: DroneOverlayPlacement, size: PhotoSize, px: PhotoPixel): LatLng {
  const s = p.widthM / size.width;                       // metres per photo pixel
  const dx = px.u - size.width / 2, dy = px.v - size.height / 2;
  const t = rad(p.rotationDeg), c = Math.cos(t), sn = Math.sin(t);
  const sx = dx * c - dy * sn, sy = dx * sn + dy * c;    // screen offset, y down
  const east = s * sx, north = -s * sy;
  return {
    lat: p.lat + north / M_PER_DEG_LAT,
    lng: p.lng + east / (M_PER_DEG_LAT * Math.cos(rad(p.lat))),
  };
}

/** Which photo pixel sits under this map point; may fall outside the photo. */
export function photoPixelFromLatLng(p: DroneOverlayPlacement, size: PhotoSize, ll: LatLng): PhotoPixel {
  const s = p.widthM / size.width;
  const north = (ll.lat - p.lat) * M_PER_DEG_LAT;
  const east = (ll.lng - p.lng) * M_PER_DEG_LAT * Math.cos(rad(p.lat));
  const sx = east / s, sy = -north / s;
  const t = rad(-p.rotationDeg), c = Math.cos(t), sn = Math.sin(t);
  const dx = sx * c - sy * sn, dy = sx * sn + sy * c;
  return { u: dx + size.width / 2, v: dy + size.height / 2 };
}

export function insidePhoto(px: PhotoPixel, size: PhotoSize): boolean {
  return px.u >= 0 && px.v >= 0 && px.u <= size.width && px.v <= size.height;
}

/**
 * The placement that puts photo pixel a on map point A and pixel b on B.
 *
 * Two correspondences fix all four degrees of freedom of a flat photo:
 * scale from the length ratio, rotation from the angle difference, and the
 * centre from where the photo's middle then has to be. Returns null when the
 * two pixels coincide, because then nothing about scale or rotation is known.
 */
export function solveTwoPoint(
  size: PhotoSize, a: PhotoPixel, A: LatLng, b: PhotoPixel, B: LatLng,
  opacity = 0.8,
): DroneOverlayPlacement | null {
  const cosA = Math.cos(rad(A.lat));
  const toM = (ll: LatLng) => ({
    east: (ll.lng - A.lng) * M_PER_DEG_LAT * cosA,
    north: (ll.lat - A.lat) * M_PER_DEG_LAT,
  });
  const gb = toM(B);
  const av = { x: b.u - a.u, y: b.v - a.v };            // photo pixels, y down
  const bv = { x: gb.east, y: -gb.north };              // metres in screen orientation
  const aLen = Math.hypot(av.x, av.y), bLen = Math.hypot(bv.x, bv.y);
  if (aLen < 1e-6 || bLen < 1e-6) return null;
  const s = bLen / aLen;                                // metres per pixel
  const theta = Math.atan2(bv.y, bv.x) - Math.atan2(av.y, av.x);
  const c = Math.cos(theta), sn = Math.sin(theta);
  // Pixel a maps to A; the centre is A minus the rotated, scaled offset of a
  // from the photo's middle.
  const dx = a.u - size.width / 2, dy = a.v - size.height / 2;
  const sx = dx * c - dy * sn, sy = dx * sn + dy * c;
  const centreEast = -s * sx, centreNorth = s * sy;     // relative to A
  const lat = A.lat + centreNorth / M_PER_DEG_LAT;
  const lng = A.lng + centreEast / (M_PER_DEG_LAT * cosA);
  let rotationDeg = theta * 180 / Math.PI;
  rotationDeg = ((rotationDeg + 180) % 360 + 360) % 360 - 180;
  return { lat, lng, widthM: s * size.width, rotationDeg, opacity };
}
