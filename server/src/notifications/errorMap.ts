/**
 * error_status → user-facing event metadata.
 *
 * Source: research/blutter_output_v2.4.0/asm/flutter_novabot/common/mower_error_text.dart
 * (catalog compiled by subagent run 2026-04-28).
 *
 * Each entry tells the dispatcher (a) which EventType to emit so the
 * notification consumers can route by category and (b) the English body
 * text the stock app would show, so robot_messages writes match what
 * Novabot users are used to seeing in their Messages tab.
 *
 * Codes are firmware decimal values; comments show the original hex
 * the stock app source uses.
 */
import type { EventType } from './types.js';

export interface ErrorEntry {
  type: EventType;
  message: string;
}

export const ERROR_MAP: Record<number, ErrorEntry> = {
  // ── GPS / localization (0x65..0x6A range) ───────────────────────
  101: { type: 'gps_weak',  message: 'GPS signal is weak.' },                        // 0x65
  105: { type: 'gps_weak',  message: 'Poor location quality. Move the mower to an open area.' }, // 0x69
  106: { type: 'gps_weak',  message: 'Positioning JSON file failed to save.' },      // 0x6A

  // ── Charging-station signal errors (0x70..0x72) ─────────────────
  112: { type: 'map_error', message: 'Charging signal cannot be found.' },           // 0x70
  113: { type: 'map_error', message: 'Charging station QR code cannot be found.' }, // 0x71
  114: { type: 'map_error', message: 'Failed to obtain charging location.' },        // 0x72

  // ── Battery / start preconditions (0x76) ────────────────────────
  118: { type: 'low_battery', message: 'Battery too low to start mowing. Wait for charging to finish.' }, // 0x76

  // ── Recharge / dock failures (existing stuck class) ─────────────
  117: { type: 'stuck',     message: 'Cannot leave dock. Check for obstacles.' },    // 0x75
  124: { type: 'stuck',     message: 'Return-to-charge failed. Retry or manually move NOVABOT back.' }, // 0x7C
  126: { type: 'stuck',     message: 'Return-to-charge failed. Retry or manually move NOVABOT back.' }, // 0x7E

  // ── Mapping / navigation (0x7A..0x7D) ───────────────────────────
  122: { type: 'map_error', message: 'The mower is outside the map.' },              // 0x7A
  123: { type: 'map_error', message: 'Wheels are slipping. Please check the surface.' }, // 0x7B
  125: { type: 'map_error', message: 'No mowing paths could be planned.' },          // 0x7D

  // ── Connectivity ────────────────────────────────────────────────
  131: { type: 'connection_lost', message: 'Data transmission lost. The mower will resume automatically after recovery.' }, // 0x83
  132: { type: 'connection_lost', message: 'LoRa disconnect. Localization may be degraded.' }, // 0x84

  // ── Localization collapse (0x82) ────────────────────────────────
  // robot_decision aborts the running task ("Localization quality is very
  // bad!!!"). Seen live on a GNSS-jammed day (#118, 2026-09-19): DGPS fix,
  // loc_quality ~20 %. Stock behaviour, unchanged by the custom builds.
  130: { type: 'gps_weak', message: 'Localization quality collapsed and the task was stopped. Wait for RTK Fixed (open sky, no GNSS interference) and start again.' }, // 0x82

  // ── Initialization (0x85) ───────────────────────────────────────
  133: { type: 'initialization_error', message: 'Mower not yet initialized. Wait one minute and retry.' }, // 0x85

  // ── Camera / sensor faults (0x86..0x89) ─────────────────────────
  134: { type: 'hardware_fault', message: 'Failed to open TOF camera.' },            // 0x86
  136: { type: 'hardware_fault', message: 'Failed to open front camera.' },          // 0x88
  137: { type: 'hardware_fault', message: 'LoRa configuration error.' },             // 0x89
  139: { type: 'map_error', message: 'Charging station position error.' },           // 0x8B

  // ── PIN lockout (0x97) ──────────────────────────────────────────
  151: { type: 'pin_locked', message: 'Please enter the PIN code on the device.' }, // 0x97

  // ── Safety hardstops (0x98..0xA0) ───────────────────────────────
  152: { type: 'safety',    message: 'NOVABOT has been emergency stopped. Please enter the PIN code to unlock.' }, // 0x98
  153: { type: 'stuck',     message: 'NOVABOT collided. Please assist it in getting unstuck.' }, // 0x99
  154: { type: 'safety',    message: 'NOVABOT is lifted. Put it back on the ground and enter the PIN code to unlock.' }, // 0x9A
  155: { type: 'safety',    message: 'Wheel motor overcurrent. Check and enter the PIN code to unlock.' }, // 0x9B
  156: { type: 'safety',    message: 'Blade motor overcurrent. Check and enter the PIN code to unlock.' }, // 0x9C
  157: { type: 'safety',    message: 'NOVABOT turned over. Manually right it and enter the PIN code to unlock.' }, // 0x9D
  158: { type: 'safety',    message: 'NOVABOT is tilted. Move it to flat ground and enter the PIN code to unlock.' }, // 0x9E
  159: { type: 'safety',    message: 'Wheel motor is stalled. Check and enter the PIN code to unlock.' }, // 0x9F
  160: { type: 'safety',    message: 'Blade motor is stalled. Check and enter the PIN code to unlock.' }, // 0xA0

  // ── Hardware (0xAA, 0xCA, 0xDD, 0x1BC) ─────────────────────────
  170: { type: 'hardware_fault', message: 'Machine chassis error.' },                // 0xAA
  202: { type: 'gps_weak',     message: 'GPS signal lost.' },                        // 0xCA
  221: { type: 'hardware_fault', message: 'TOF sensor hardware malfunction.' },      // 0xDD
  444: { type: 'hardware_fault', message: 'Front camera sensor hardware malfunction.' }, // 0x1BC
};

/** Look up metadata for a numeric error_status. Returns the generic
 * `error` event with the firmware-supplied msg when unmapped — keeps
 * unknown codes from disappearing into the void. */
export function lookupError(code: number, fallbackMsg: string): ErrorEntry {
  return ERROR_MAP[code] ?? { type: 'error', message: fallbackMsg || `Error code ${code}` };
}
