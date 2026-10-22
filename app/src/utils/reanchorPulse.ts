// Supervision of a running re-anchor. The server stops the motion when no
// pulse arrives for 5 s; the wizard pulses every second. One lost request
// (a Wi-Fi hiccup, a slow proxy) dropped supervision for good, so the server
// stopped a healthy cycle (GH #158). Same rules as the dashboard's
// dashboard/src/utils/reanchorPulse.ts.

export const REANCHOR_PULSE_MS = 1000;
const SERVER_WINDOW_MS = 5000;
/** After this many unreachable pulses in a row the server window has certainly expired. */
export const REANCHOR_PULSE_MISS_LIMIT = Math.ceil(SERVER_WINDOW_MS / REANCHOR_PULSE_MS) + 1;

export type PulseOutcome = 'ok' | 'refused' | 'unreachable';

/** 'refused' is the server's own ok:false answer (HTTP 409); everything else that fails is transport. */
export async function pulseOutcome(pulse: () => Promise<{ ok?: boolean }>): Promise<PulseOutcome> {
  try {
    const answer = await pulse();
    return answer?.ok === true ? 'ok' : answer?.ok === false ? 'refused' : 'unreachable';
  } catch (error) {
    // ApiClient throws `HTTP 409: <body>` for the refusal, or an ApiError with status 409.
    const refused = (error as { status?: unknown } | null)?.status === 409 ||
      (error instanceof Error && /^HTTP 409\b/.test(error.message));
    return refused ? 'refused' : 'unreachable';
  }
}

/** Unreachable pulses in a row after this one, or null when the wizard no longer owns the cycle. */
export function afterPulse(misses: number, outcome: PulseOutcome): number | null {
  if (outcome === 'ok') return 0;
  if (outcome === 'refused' || misses + 1 >= REANCHOR_PULSE_MISS_LIMIT) return null;
  return misses + 1;
}
