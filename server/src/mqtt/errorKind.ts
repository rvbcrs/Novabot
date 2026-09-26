/**
 * What it takes to clear a mower error, from how the stock robot_decision
 * handles its error_status (v6.0.2, RobotDecision::updateErrorStatus):
 *
 * - A new value of 0 overwrites any error up to 150. robot_decision does that
 *   itself at the start of a new action: a mow (coverStartDeal), a resume
 *   (coverContinueDeal) or a return to the dock (rechargeDeal), and whenever a
 *   monitored condition recovers. There is no service that only clears.
 *   `/robot_decision/reset_data` is NOT one: it deletes the map folder.
 * - Above 150 it refuses to overwrite unless forced, which only happens when
 *   the chassis reports healthy again and at start-up (initData). Starting a
 *   task then answers "please unlock to retry". So these need the PIN, or a
 *   restart of the mower software once the physical cause is gone.
 *
 * The PIN set is the one whose official Novabot message says "enter the PIN
 * code to unlock" (errorMap.ts).
 */
export const PIN_ERRORS: ReadonlySet<number> = new Set([151, 152, 154, 155, 156, 157, 158, 159, 160]);

export type ErrorKind = 'none' | 'task' | 'restart' | 'pin';

export function errorKind(code: number): ErrorKind {
  if (!Number.isFinite(code) || code <= 0) return 'none';
  if (PIN_ERRORS.has(code)) return 'pin';
  return code > 150 ? 'restart' : 'task';
}

/** The number in an error_status, raw ("130") or translated ("Error (130)"). */
export function errorCodeOf(value: string | undefined): number {
  return parseInt(value?.match(/\d+/)?.[0] ?? '0', 10);
}

/** Sensor key holding the error code the user cleared. It hides that error
 *  until the mower reports a different one (see sensorData). */
export const ERROR_ACK_KEY = 'error_ack';
