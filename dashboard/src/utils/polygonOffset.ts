/**
 * Polygon offset (inset/outset) using miter join method.
 * Works on GPS coordinates by converting to local meters first.
 */

const DEG_TO_M = 111320; // meters per degree latitude

interface LatLng {
  lat: number;
  lng: number;
}

interface Point {
  x: number;
  y: number;
}

/** Convert GPS to local meters relative to a center point */
function gpsToLocal(p: LatLng, center: LatLng): Point {
  const cosLat = Math.cos(center.lat * Math.PI / 180);
  return {
    x: (p.lng - center.lng) * DEG_TO_M * cosLat,
    y: (p.lat - center.lat) * DEG_TO_M,
  };
}

/** Convert local meters back to GPS */
function localToGps(p: Point, center: LatLng): LatLng {
  const cosLat = Math.cos(center.lat * Math.PI / 180);
  return {
    lat: center.lat + p.y / DEG_TO_M,
    lng: center.lng + p.x / (DEG_TO_M * cosLat),
  };
}

/** Compute centroid of a polygon */
function centroid(points: LatLng[]): LatLng {
  let lat = 0, lng = 0;
  for (const p of points) { lat += p.lat; lng += p.lng; }
  return { lat: lat / points.length, lng: lng / points.length };
}

/** Normalize a 2D vector to unit length */
function normalize(v: Point): Point {
  const len = Math.sqrt(v.x * v.x + v.y * v.y);
  if (len < 1e-12) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

/**
 * Offset a polygon by a given distance in meters.
 *
 * @param points - GPS polygon vertices (closed or open)
 * @param offsetMeters - positive = expand outward, negative = shrink inward
 * @returns Offset polygon in GPS coordinates
 */
export function offsetPolygon(points: LatLng[], offsetMeters: number): LatLng[] {
  if (points.length < 3 || offsetMeters === 0) return points;

  const center = centroid(points);
  const local = points.map(p => gpsToLocal(p, center));
  const n = local.length;

  // Ensure polygon is counter-clockwise (positive area = CCW)
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += local[i].x * local[j].y - local[j].x * local[i].y;
  }
  // If clockwise, flip the offset direction
  const sign = area >= 0 ? 1 : -1;
  const offset = offsetMeters * sign;

  const result: Point[] = [];

  for (let i = 0; i < n; i++) {
    const prev = local[(i - 1 + n) % n];
    const curr = local[i];
    const next = local[(i + 1) % n];

    // Edge vectors
    const e1 = { x: curr.x - prev.x, y: curr.y - prev.y };
    const e2 = { x: next.x - curr.x, y: next.y - curr.y };

    // Inward normals (perpendicular, pointing left of edge direction)
    const n1 = normalize({ x: -e1.y, y: e1.x });
    const n2 = normalize({ x: -e2.y, y: e2.x });

    // Bisector direction
    const bisector = { x: n1.x + n2.x, y: n1.y + n2.y };
    const bisLen = Math.sqrt(bisector.x * bisector.x + bisector.y * bisector.y);

    if (bisLen < 1e-12) {
      // Degenerate: parallel edges, just use one normal
      result.push({
        x: curr.x + n1.x * offset,
        y: curr.y + n1.y * offset,
      });
    } else {
      // Dot product of bisector with one normal gives sin(half_angle)
      const normBis = { x: bisector.x / bisLen, y: bisector.y / bisLen };
      const dot = normBis.x * n1.x + normBis.y * n1.y;

      // Clamp to prevent explosion at very sharp angles (< ~15°)
      const sinHalf = Math.max(Math.abs(dot), 0.25);
      const dist = offset / sinHalf;

      result.push({
        x: curr.x + normBis.x * dist,
        y: curr.y + normBis.y * dist,
      });
    }
  }

  return result.map(p => localToGps(p, center));
}
