/**
 * Same classification as the server's mqtt/errorKind.ts, from how the stock
 * robot_decision handles error_status: it resets errors up to 150 itself at
 * the next start, resume or return to the dock; above 150 only after the PIN
 * or a restart of the mower software. The PIN set is the one whose official
 * Novabot message asks for the PIN code.
 */
const PIN_ERRORS = new Set([151, 152, 154, 155, 156, 157, 158, 159, 160]);

export type ErrorKind = 'none' | 'task' | 'restart' | 'pin';

export function errorKind(code: number): ErrorKind {
  if (!Number.isFinite(code) || code <= 0) return 'none';
  if (PIN_ERRORS.has(code)) return 'pin';
  return code > 150 ? 'restart' : 'task';
}
