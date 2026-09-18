/**
 * Dock drift: does the mower stand in the same place on the charger every
 * time? The charging station does not move, so with RTK Fixed the docked
 * map position must repeat to a few centimetres. When it walks over days,
 * the station's antenna (the RTK base) moved, or the map frame did, and the
 * zones no longer lie where they were driven.
 */
import type { DockSampleRow } from '../db/repositories/dockSamples.js';

/** From here it is worth a warning; the mower's own repeatability is ~2-3 cm. */
export const DOCK_DRIFT_WARN_M = 0.05;
/** From here the edges visibly move; treat as a fault to fix. */
export const DOCK_DRIFT_FAIL_M = 0.15;
/** The reference is the median of this many first stints. */
const REFERENCE_STINTS = 3;

export interface DockDriftPoint {
  ts: string;
  /** Offset from the reference in the map frame, metres east / north. */
  dx: number;
  dy: number;
  dist: number;
  /** Offset of the RTK position itself, metres; null without GPS in the row. */
  gpsDist: number | null;
}

export interface DockDrift {
  /** Timestamp of the reference position; null with too few stints. */
  referenceAt: string | null;
  reference: { x: number; y: number } | null;
  latest: DockDriftPoint | null;
  /** One point per day: the median offset of that day's stints. */
  daily: DockDriftPoint[];
  status: 'ok' | 'warn' | 'fail' | 'unknown';
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function gpsMetres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dn = (bLat - aLat) * 111_320;
  const de = (bLng - aLng) * 111_320 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(de, dn);
}

export function computeDockDrift(samples: DockSampleRow[]): DockDrift {
  const none: DockDrift = { referenceAt: null, reference: null, latest: null, daily: [], status: 'unknown' };
  if (samples.length < 2) return none;
  const ref = samples.slice(0, REFERENCE_STINTS);
  const reference = { x: median(ref.map(s => s.map_x)), y: median(ref.map(s => s.map_y)) };
  const refGps = ref.every(s => s.lat != null && s.lng != null)
    ? { lat: median(ref.map(s => s.lat as number)), lng: median(ref.map(s => s.lng as number)) }
    : null;
  const point = (s: DockSampleRow): DockDriftPoint => {
    const dx = s.map_x - reference.x;
    const dy = s.map_y - reference.y;
    return {
      ts: s.ts, dx, dy, dist: Math.hypot(dx, dy),
      gpsDist: refGps && s.lat != null && s.lng != null ? gpsMetres(refGps.lat, refGps.lng, s.lat, s.lng) : null,
    };
  };
  const byDay = new Map<string, DockDriftPoint[]>();
  for (const s of samples) {
    const day = s.ts.slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(point(s));
    byDay.set(day, list);
  }
  const daily: DockDriftPoint[] = [...byDay.entries()].map(([day, pts]) => {
    const dx = median(pts.map(p => p.dx));
    const dy = median(pts.map(p => p.dy));
    const gps = pts.filter(p => p.gpsDist != null).map(p => p.gpsDist as number);
    return { ts: day, dx, dy, dist: Math.hypot(dx, dy), gpsDist: gps.length ? median(gps) : null };
  });
  // The latest reading is today's median, not one stint: a single bad park
  // (half on the dock, no fix) must not raise the alarm.
  const latest = daily[daily.length - 1] ?? null;
  const status = !latest ? 'unknown'
    : latest.dist >= DOCK_DRIFT_FAIL_M ? 'fail'
    : latest.dist >= DOCK_DRIFT_WARN_M ? 'warn'
    : 'ok';
  return { referenceAt: ref[0].ts, reference, latest, daily, status };
}
