import type { TFunction } from 'i18next';

/**
 * What the night patrol is doing, read from the mower's sensors: patrol_phase and
 * patrol_error (the broker mirrors the mower's reports), plus the sensors that say
 * whether another drive holds the wheels or the mower stands on the dock.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */

/** Phases in which the patrol holds the wheels. `starting` is the mower accepting it, before it leaves the dock. */
const ACTIVE_PHASES = new Set(['starting', 'localizing', 'patrolling', 'returning']);
/** mow_zone_phase values in which a zone drive holds the wheels (server edgeCutGuard.ts). */
const ZONE_DRIVE_PHASES = new Set(['starting', 'localizing', 'following_unicom', 'entering_zone']);
/** battery_state of a mower on the dock: charging, or full and still on it. recharge_status is no use here: it reads "Charging" while the mower is still on its way home. */
const DOCKED_BATTERY_STATES = new Set(['CHARGING', 'FINISHED', 'FULL']);

export interface PatrolStatus {
  phase: string | undefined;
  error: string | undefined;
  /** The patrol holds the wheels: the button is Stop. */
  active: boolean;
  /** An edge cut or a zone drive holds the wheels: a patrol cannot start. */
  otherDrive: boolean;
  /** On the dock, charging or full. */
  docked: boolean;
  /** Ended with an error, or stopped with a flag (the STOP button, a lift or a tilt on the mower). */
  failed: boolean;
}

export function patrolStatus(sensors: Record<string, string> | undefined): PatrolStatus {
  const phase = sensors?.patrol_phase || undefined;   // '' means no patrol reported yet
  const error = sensors?.patrol_error || undefined;
  const active = ACTIVE_PHASES.has(phase ?? '');
  return {
    phase,
    error,
    active,
    otherDrive: !active && (sensors?.edge_active === '1' || ZONE_DRIVE_PHASES.has(sensors?.mow_zone_phase ?? '')),
    docked: DOCKED_BATTERY_STATES.has((sensors?.battery_state ?? '').toUpperCase()),
    failed: phase === 'error' || (phase === 'stopped' && !!error),
  };
}

/**
 * A patrol's start as the panel shows it, "Oct 14, 23:30". h23 and h12 rather than
 * hour12: false, which can print midnight as 24:10 (a patrol runs around then).
 */
export function patrolTime(ms: number, locale: string, tf: '12h' | '24h'): string {
  return new Date(ms).toLocaleString(locale, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    hourCycle: tf === '12h' ? 'h12' : 'h23',
  });
}

/** The time of day of a checkpoint, with seconds. */
export function patrolClock(ms: number, locale: string, tf: '12h' | '24h'): string {
  return new Date(ms).toLocaleTimeString(locale, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: tf === '12h' ? 'h12' : 'h23',
  });
}

/**
 * The codes for why a patrol ended that have words in drawer.patrol.reason: the
 * drive script's (mow_zone_drive.py, extended_commands.py) and the chassis
 * watcher's, as the server words them too (patrolStopReason).
 */
const REASONS = new Set([
  'checkpoints_unreachable', 'frame_not_settled', 'not_localized', 'no_dock_zone', 'no_route', 'no_route_home',
  'busy_mowing', 'push_button', 'no_pin_code', 'upraise', 'tile', 'turn_over',
  'mower_restarted', 'blade_guard_failed', 'drive_script_missing',
]);

/**
 * Why a patrol ended, in words. The chassis watcher's codes read
 * error_<cause>_stop. A code nobody has words for stays as it is: it is what a
 * bug report needs.
 */
export function patrolReasonText(t: TFunction, code: string): string {
  const cause = code.replace(/^(?:error|warning)_/, '').replace(/_stop$/, '');
  return REASONS.has(cause) ? t(`drawer.patrol.reason.${cause}`) : code;
}

/**
 * The phase line. patrol_phase never returns to idle by itself, so `done` reads
 * as ready once the mower is back on the dock. An error and a flagged stop keep
 * their reason, in words.
 */
export function patrolPhaseText(t: TFunction, s: PatrolStatus): string {
  const { phase } = s;
  if (!phase || phase === 'idle' || (phase === 'done' && s.docked)) return t('drawer.patrol.phase.idle');
  if (s.failed) return t('drawer.patrol.phase.error', { error: s.error ? patrolReasonText(t, s.error) : '?' });
  return t(`drawer.patrol.phase.${phase}`, phase);
}
