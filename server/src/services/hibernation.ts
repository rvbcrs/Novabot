/**
 * Winter sleep: no schedule of a mower starts while it is on (mowing, night
 * patrol, edge cut). The schedules themselves keep their own on/off state, so
 * switching it off brings the summer back exactly as it was. Manual mowing
 * stays possible. Optionally it ends by itself on a wake date.
 *
 * Only the server starts scheduled tasks: mqtt_node has no handler for an
 * incoming timer_task (it only reports task_time_exe_flag), so there is no
 * timer on the mower to clear.
 *
 * Stored per mower in device_settings: hibernate = '1', hibernate_until =
 * 'YYYY-MM-DD' (local date, the day it wakes up) or absent.
 */
import { deviceSettingsRepo } from '../db/repositories/deviceSettings.js';

const KEY = 'hibernate';
const UNTIL_KEY = 'hibernate_until';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Hibernation { enabled: boolean; until: string | null }

type Listener = (sn: string, state: Hibernation) => void;
const listeners: Listener[] = [];
/** Called on every change (dashboard, app, Home Assistant, the wake date). */
export function onHibernationChange(listener: Listener): void { listeners.push(listener); }

/** The local calendar date of `now` as YYYY-MM-DD. */
export function localDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function read(sn: string): Hibernation {
  const rows = deviceSettingsRepo.findBySn(sn);
  const until = rows.find(r => r.key === UNTIL_KEY)?.value ?? null;
  return { enabled: rows.some(r => r.key === KEY && r.value === '1'), until: until && DATE_RE.test(until) ? until : null };
}

/** The current state; a wake date that has come ends it here. */
export function getHibernation(sn: string, now = new Date()): Hibernation {
  const state = read(sn);
  if (state.enabled && state.until && localDate(now) >= state.until) {
    console.log(`[Hibernation] ${sn}: wake date ${state.until} reached, winter sleep ends`);
    return setHibernation(sn, false, null);
  }
  return state;
}

export function isHibernating(sn: string, now = new Date()): boolean {
  return getHibernation(sn, now).enabled;
}

/** Switch winter sleep on or off. A wake date only applies while it is on. */
export function setHibernation(sn: string, enabled: boolean, until: string | null): Hibernation {
  if (until != null && !DATE_RE.test(until)) throw new Error(`invalid wake date: ${until}`);
  if (enabled) deviceSettingsRepo.upsert(sn, KEY, '1'); else deviceSettingsRepo.remove(sn, KEY);
  if (enabled && until) deviceSettingsRepo.upsert(sn, UNTIL_KEY, until); else deviceSettingsRepo.remove(sn, UNTIL_KEY);
  const state = read(sn);
  console.log(`[Hibernation] ${sn}: ${state.enabled ? `on${state.until ? ` until ${state.until}` : ''}` : 'off'}`);
  for (const l of listeners) {
    try { l(sn, state); } catch (err) { console.warn('[Hibernation] listener failed:', err); }
  }
  return state;
}

/** Every mower that sleeps, after waking the ones whose date has come. */
export function hibernatingMowers(now = new Date()): string[] {
  return deviceSettingsRepo.listAll()
    .filter(r => r.key === KEY && r.value === '1')
    .map(r => r.sn)
    .filter(sn => isHibernating(sn, now));
}
