/**
 * Shared types for the notifications subsystem.
 *
 * EventType values are stable identifiers — Home Assistant automations and
 * external scripts subscribe by event type, so renaming requires a deprecation
 * cycle.
 */

export type EventType =
  | 'error'              // error_status transitioned 0 → non-zero
  | 'error_cleared'      // error_status transitioned non-zero → 0
  | 'mowing_started'     // task became COVERING / RUNNING
  | 'mowing_finished'    // task left COVERING and ended FINISHED (not error-aborted)
  | 'docked'             // recharge_status reached 9 (FINISHED on dock)
  | 'low_battery'        // battery_power crossed below threshold (default 20)
  | 'stuck';             // mower reports an error class indicating it is stuck

export interface MowerEvent {
  sn: string;
  type: EventType;
  ts: number;            // ms epoch
  title: string;         // short human-readable line
  message: string;       // longer detail (also the ntfy body)
  data: Record<string, unknown>;  // raw fields (error_status, msg, battery_power, …)
}
