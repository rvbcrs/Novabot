/**
 * Where the mower drove during a night patrol, as this page saw it: its map
 * position (the one the mower marker uses) while a patrol is out, one session per
 * patrol. Kept in memory only: a reload loses it, and nothing goes to the server.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */

export interface TrackPoint { x: number; y: number }

export interface TrackSession {
  id: number;
  /** The run it belongs to, once a live report names it; null before. */
  run: string | null;
  /** The run the page's live reports already named when the session began: an older patrol's, not this one's. */
  staleRun: string | null;
  points: TrackPoint[];
}

export interface TrackState {
  sn: string | null;
  phase: string | undefined;
  active: boolean;
  sessions: TrackSession[];
  nextId: number;
}

export const NO_TRACKS: TrackState = { sn: null, phase: undefined, active: false, sessions: [], nextId: 1 };

/** A point closer than this to the last one is not kept. */
export const MIN_STEP_M = 0.1;
/** A session keeps about this many points; past it every second one goes, so the whole round stays in shape. */
export const MAX_POINTS = 3000;
/** The last patrols kept in memory. */
const MAX_SESSIONS = 6;

export interface TrackInput {
  sn: string | null;
  /** The Experimental switch: off, nothing is recorded. */
  enabled: boolean;
  phase: string | undefined;
  /** A patrol is out: starting, localizing, patrolling or returning. */
  active: boolean;
  /** The mower's map position now, in its own frame (metres), or null. */
  point: TrackPoint | null;
  /** The run of the live reports (usePatrolReports), which can be an older patrol's. */
  reportsRun: string | null;
}

const thin = (points: TrackPoint[]): TrackPoint[] => points.filter((_, i) => i % 2 === 0 || i === points.length - 1);

/**
 * The next state: a new session when a patrol begins (the phase turns active, or
 * `starting` comes again), the position added while one is out, and the session
 * tied to its run once a report names it. Reports that already stood on the page
 * when the patrol began are an older run's (a reconnect can leave them): the first
 * other run that reports is this patrol's. Returns `prev` itself when nothing
 * changed, so it can be applied while rendering.
 */
export function advanceTrack(prev: TrackState, input: TrackInput): TrackState {
  const base = prev.sn === input.sn ? prev : { ...NO_TRACKS, sn: input.sn };
  const active = input.enabled && input.active;
  let sessions = base.sessions;
  let nextId = base.nextId;
  const open = (run: string | null, staleRun: string | null) => {
    sessions = [...sessions, { id: nextId++, run, staleRun, points: [] }].slice(-MAX_SESSIONS);
  };
  const replaceLast = (change: (s: TrackSession) => TrackSession) => {
    sessions = [...sessions.slice(0, -1), change(sessions[sessions.length - 1])];
  };

  if (active) {
    if (!base.active || !sessions.length || (input.phase === 'starting' && base.phase !== 'starting')) open(null, input.reportsRun);
    const reported = input.reportsRun;
    const cur = sessions[sessions.length - 1];
    if (reported !== null && reported !== cur.staleRun && reported !== cur.run) {
      // A run reporting while another is tied to the session: a new patrol began unseen.
      if (cur.run === null) replaceLast(s => ({ ...s, run: reported }));
      else open(reported, cur.run);
    }
    const p = input.point;
    // (0, 0) is what the mower reports before it knows where it is.
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.x !== 0 || p.y !== 0)) {
      const last = sessions[sessions.length - 1];
      const tail = last.points[last.points.length - 1];
      if (!tail || Math.hypot(p.x - tail.x, p.y - tail.y) >= MIN_STEP_M) {
        const points = [...last.points, { x: p.x, y: p.y }];
        replaceLast(s => ({ ...s, points: points.length > MAX_POINTS ? thin(points) : points }));
      }
    }
  }

  if (base === prev && sessions === base.sessions && active === base.active && input.phase === base.phase) return prev;
  return { sn: input.sn, phase: input.phase, active, sessions, nextId };
}

/** The track of the patrol that is out now. */
export function liveTrack(state: TrackState): TrackPoint[] | null {
  return state.active && state.sessions.length ? state.sessions[state.sessions.length - 1].points : null;
}

/** The track kept for a run this page saw drive. */
export function trackForRun(state: TrackState, run: string): TrackPoint[] | null {
  for (let i = state.sessions.length - 1; i >= 0; i--) if (state.sessions[i].run === run) return state.sessions[i].points;
  return null;
}

/**
 * A jump of more than this between two points is a dropout (a phone that slept,
 * a lost link), not a drive: the mower moves well under a metre between two
 * poses. The map's own trail splits at the same distance (TRAIL_GAP_M, issue #93).
 */
export const TRACK_GAP_M = 5;

/** The track in pieces: no line is drawn across a dropout, which would cut through obstacles the mower drove around. */
export function splitTrack(points: readonly TrackPoint[], gapM = TRACK_GAP_M): TrackPoint[][] {
  const pieces: TrackPoint[][] = [];
  let piece: TrackPoint[] = [];
  for (const p of points) {
    const prev = piece[piece.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > gapM) {
      pieces.push(piece);
      piece = [];
    }
    piece.push(p);
  }
  if (piece.length) pieces.push(piece);
  return pieces;
}

/** What the map draws as the driven track: the points, and whether the mower is still on its way (the line ends at where it is). */
export interface PatrolTrackView { points: TrackPoint[]; live: boolean }

/**
 * The track that goes with what the map shows of the patrol: the live one while a
 * patrol is out, the kept one of a run while its report is open, nothing else.
 */
export function trackForView(
  state: TrackState,
  view: { mode: 'plan' | 'live' | 'finished'; run: string | null } | null,
): PatrolTrackView | null {
  if (!view) return null;
  if (view.mode === 'live') {
    const points = liveTrack(state);
    return points && points.length ? { points, live: true } : null;
  }
  if (view.mode === 'finished' && view.run !== null) {
    const points = trackForRun(state, view.run);
    return points && points.length ? { points, live: false } : null;
  }
  return null;
}
