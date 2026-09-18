/**
 * Shared types for the notifications subsystem.
 *
 * EventType values are stable identifiers — Home Assistant automations and
 * external scripts subscribe by event type, so renaming requires a deprecation
 * cycle.
 */

export type EventType =
  | 'error'                  // generic error_status 0 → non-zero (no specific mapping)
  | 'error_cleared'          // error_status non-zero → 0
  | 'mowing_started'         // task became COVERING / RUNNING / etc.
  | 'mowing_finished'        // task left COVERING and ended FINISHED (not error-aborted)
  | 'docked'                 // recharge_status reached 9 (FINISHED on dock)
  | 'low_battery'            // battery_power crossed below threshold OR firmware error 0x76
  | 'stuck'                  // collision / dock-fail / unable-to-leave (codes 117/124/126/153)
  | 'safety'                 // PIN-protected hardstop: lift, tilt, overcurrent, stall (0x98..0xA0)
  | 'pin_locked'             // 0x97 — mower asks for PIN at the device
  | 'connection_lost'        // 0x83/0x84 — LoRa data transmission loss
  | 'gps_weak'               // 0x65/0x69/0x6A/0xCA — GPS signal/quality issue
  | 'map_error'              // 0x70..0x72 charging signal, 0x7A..0x7D mapping/boundary
  | 'initialization_error'   // 0x85 — mower not initialised
  | 'hardware_fault'         // 0x86/0x88/0x89/0xAA/0xDD/0x1BC — camera, lora, chassis
  | 'dock_failed'            // msg includes 'Recharge: FAILED' — mower returned but couldn't dock (issue #30)
  | 'dock_drift'             // the docked position walked away from where it used to be: station antenna or map frame moved
  | 'firmware_required';     // the custom build the mower runs was withdrawn; update to the newest one

export interface MowerEvent {
  sn: string;
  type: EventType;
  ts: number;            // ms epoch
  title: string;         // short human-readable line
  message: string;       // longer detail (also the ntfy body)
  data: Record<string, unknown>;  // raw fields (error_status, msg, battery_power, …)
}
