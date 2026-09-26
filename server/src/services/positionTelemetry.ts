/** Receipt time is recorded before value deduplication: reading a cache is not a measurement. */
type Reading<T> = { value: T; at: number };
export type PositionSample = { x: number; y: number; at: number; fixed: boolean; running: boolean; docked: boolean };
export type GpsSample = { lat: number; lng: number; at: number; fixed: boolean; docked: boolean };
type Telemetry = {
  quality?: Reading<boolean>; running?: Reading<boolean>; docked?: Reading<boolean>;
  error?: Reading<number>; gpsIds?: string[]; poses: PositionSample[]; gps: GpsSample[];
};
const telemetry = new Map<string, Telemetry>();
export const POSITION_MAX_AGE_MS = 10_000;
const fresh = <T>(reading: Reading<T> | undefined, now: number): reading is Reading<T> => !!reading && now >= reading.at && now - reading.at <= POSITION_MAX_AGE_MS;
const number = (v: unknown): number => v === null || v === undefined || v === '' ? NaN : Number(v);
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

export function clearPositionTelemetry(sn: string): void { telemetry.delete(sn); }
export function positionTelemetry(sn: string) { return telemetry.get(sn); }
export function freshPositionState(sn: string, now = Date.now()) {
  const t = telemetry.get(sn);
  const pose = t?.poses.at(-1);
  return {
    fixed: fresh(t?.quality, now) && t.quality.value,
    running: fresh(t?.running, now) && t.running.value,
    docked: fresh(t?.docked, now) && t.docked.value,
    dockKnown: fresh(t?.docked, now),
    pose: pose && now >= pose.at && now - pose.at <= POSITION_MAX_AGE_MS ? pose : null,
  };
}

export function ingestPositionTelemetry(sn: string, data: Record<string, unknown>, at = Date.now()): void {
  const t = telemetry.get(sn) ?? { poses: [], gps: [] };
  telemetry.set(sn, t);
  const loc = object(data.localization);
  if ('rtk_fix_quality' in data) t.quality = { at, value: data.rtk_fix_quality === 4 || data.rtk_fix_quality === '4' || data.rtk_fix_quality === 'RTK Fixed' };
  if ('localization_state' in data || 'localization_state' in loc) t.running = { at, value: (loc.localization_state ?? data.localization_state) === 'RUNNING' };
  if ('battery_state' in data || 'recharge_status' in data) {
    const recharge = String(data.recharge_status ?? '');
    t.docked = { at, value: String(data.battery_state ?? '').toUpperCase() === 'CHARGING' || recharge === '9' || recharge === '1' || recharge.startsWith('Charging') };
  }
  if ('error_status' in data) t.error = { at, value: number(data.error_status) };
  const state = freshPositionState(sn, at);
  // A degraded/new epoch cannot inherit earlier good samples.
  if (!state.fixed || !state.running) t.poses = [];
  if (!state.fixed || !state.docked) t.gps = [];
  const mp = object(loc.map_position);
  if ('x' in mp || 'y' in mp || 'map_position_x' in data || 'map_position_y' in data) {
    const x = number(mp.x ?? data.map_position_x), y = number(mp.y ?? data.map_position_y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      t.poses.push({ x, y, at, fixed: state.fixed, running: state.running, docked: state.docked });
      t.poses = t.poses.slice(-64);
    } else t.poses = [];
  }
  // Stock server reports may replay cached GPS. Only receiver-stamped relay
  // messages count towards the eight independent reanchor samples.
  if (typeof data.rtk_sample_id === 'string' && !t.gpsIds?.includes(data.rtk_sample_id)) {
    t.gpsIds = [...(t.gpsIds ?? []), data.rtk_sample_id].slice(-64);
    const lat = number(data.rtk_latitude), lng = number(data.rtk_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0)) {
      t.gps.push({ lat, lng, at, fixed: state.fixed, docked: state.docked });
      t.gps = t.gps.slice(-64);
    } else t.gps = [];
  }
}

export function stablePosition(sn: string, { after = 0, count = 8, maxSpread = 0.05, docked = false } = {}) {
  const state = freshPositionState(sn);
  if (!state.fixed || !state.running || !state.pose || (docked && !state.docked)) return null;
  const samples = (telemetry.get(sn)?.poses ?? []).filter(p => p.at > after).slice(-count);
  if (samples.length < count || samples.some(p => !p.fixed || !p.running || (docked && !p.docked))) return null;
  // Packet time must advance, and gaps larger than the freshness budget break a window.
  if (samples.some((p, i) => i > 0 && (p.at <= samples[i - 1].at || p.at - samples[i - 1].at > POSITION_MAX_AGE_MS))) return null;
  const x = samples.reduce((s, p) => s + p.x, 0) / count;
  const y = samples.reduce((s, p) => s + p.y, 0) / count;
  const spreadM = Math.max(...samples.map(p => Math.hypot(p.x - x, p.y - y)));
  return spreadM <= maxSpread ? { x, y, sampledAt: samples.at(-1)!.at, sampleCount: count, spreadM } : null;
}
