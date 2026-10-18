import type { PatrolRunDto } from '../api/client';

/**
 * The night patrol's route, and how far a run got along it.
 *
 * The plan is the server's: the checkpoints in driving order, zone by zone, in
 * local map metres (the frame of the zone polygons). The mower numbers the
 * checkpoints it reports 1-based over that flattened order, so a checkpoint's
 * `seq` is its place in `planPoints`.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */

export type PatrolPlanZones = Array<{ zone: string; points: Array<[number, number]> }>;

/** pending: not yet. current: next to visit (a patrol is out). done: reached. skipped: passed or left out. */
export type MarkState = 'pending' | 'current' | 'done' | 'skipped';

export interface PlanPoint { seq: number; zone: string; x: number; y: number; valid: boolean }

/**
 * A plan from the server, tolerant of what is missing: anything that is not a
 * list of zones with points is no plan. Points keep their place (the numbering
 * counts every one), a broken point just cannot be drawn.
 */
export function normalizePlan(raw: unknown): PatrolPlanZones | null {
  if (!Array.isArray(raw)) return null;
  const zones: PatrolPlanZones = [];
  for (const z of raw) {
    if (!z || typeof z !== 'object') continue;
    const { zone, points } = z as { zone?: unknown; points?: unknown };
    if (typeof zone !== 'string' || !Array.isArray(points)) continue;
    zones.push({
      zone,
      points: points.map(p => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [NaN, NaN]) as [number, number]),
    });
  }
  return zones.some(z => z.points.length > 0) ? zones : null;
}

/** The checkpoints in driving order, numbered from 1. */
export function planPoints(plan: PatrolPlanZones | null | undefined): PlanPoint[] {
  const out: PlanPoint[] = [];
  let seq = 0;
  for (const z of plan ?? []) {
    for (const [x, y] of z.points) {
      seq += 1;
      out.push({ seq, zone: z.zone, x, y, valid: Number.isFinite(x) && Number.isFinite(y) });
    }
  }
  return out;
}

export interface MarkInput {
  /**
   * plan: nothing has happened yet (the plan as it stands).
   * live: a patrol is out; the first checkpoint not reached or skipped is the current one.
   * finished: a run from the list; nothing is current any more.
   */
  mode: 'plan' | 'live' | 'finished';
  /** Checkpoints the mower reached (a report, or a photo on the server). */
  reached?: Iterable<number>;
  /** Checkpoints the mower reported as skipped. */
  skippedSeqs?: Iterable<number>;
  /** Zones the mower left out whole: all their checkpoints are skipped. */
  skippedZones?: Iterable<string>;
  /** How a finished run ended, when the server says. */
  endedPhase?: string | null;
  /**
   * The mower's patrol_phase, for `live`. While it is `returning` the loop is
   * over, so no checkpoint is the one it is heading for.
   */
  phase?: string | null;
}

/**
 * The state of every checkpoint. Something reported wins over a guess, and the
 * guesses are the two the data supports: a checkpoint below one the mower did
 * reach was driven past, so it was skipped; and a run that ended `done` but never
 * reached a checkpoint left it out. A run that stopped or failed leaves the rest
 * pending: it never got there.
 */
export function markStates(points: PlanPoint[], input: MarkInput): Map<number, MarkState> {
  const states = new Map<number, MarkState>();
  if (input.mode === 'plan') {
    for (const p of points) states.set(p.seq, 'pending');
    return states;
  }
  const reached = new Set(input.reached ?? []);
  const skipped = new Set(input.skippedSeqs ?? []);
  const skippedZones = new Set(input.skippedZones ?? []);
  const highest = reached.size ? Math.max(...reached) : 0;
  for (const p of points) {
    if (reached.has(p.seq)) states.set(p.seq, 'done');
    else if (skipped.has(p.seq) || skippedZones.has(p.zone)) states.set(p.seq, 'skipped');
    else if (p.seq < highest) states.set(p.seq, 'skipped');
    else if (input.mode === 'finished' && input.endedPhase === 'done') states.set(p.seq, 'skipped');
    else states.set(p.seq, 'pending');
  }
  if (input.mode === 'live' && input.phase !== 'returning') {
    const next = points.find(p => states.get(p.seq) === 'pending');
    if (next) states.set(next.seq, 'current');
  }
  return states;
}

/**
 * The run that is out, and whether the live reports belong to it.
 *
 * The server's view comes first: the newest run, when it has not ended
 * (`endedPhase` null). Live reports name their run, and the ones of another run
 * (the last patrol's, kept across a reconnect or a snapshot that skipped the
 * `starting` phase) must not colour this one: they apply only when they name no
 * run yet or name this one. An older server does not say how runs ended
 * (`endedPhase` missing): the run the reports name is then the best there is.
 * When the server says the newest run has ended, none is out (the list has not
 * caught up with a start), and only reports that name no run apply.
 */
export function pickOutRun<R extends Pick<PatrolRunDto, 'run' | 'endedPhase'>>(
  runs: readonly R[],
  reportsRun: string | null,
): { run: R | undefined; reportsApply: boolean } {
  const newest = runs[0];
  let run: R | undefined;
  if (newest && newest.endedPhase === null) run = newest;
  else if (newest && newest.endedPhase === undefined && reportsRun !== null) run = runs.find(r => r.run === reportsRun);
  return { run, reportsApply: reportsRun === null || reportsRun === run?.run };
}

export interface OverlayPoint { seq: number; x: number; y: number; state: MarkState }
export interface PatrolOverlay { zones: Array<{ zone: string; points: OverlayPoint[] }> }

/** What the map draws: the plan's points that can be drawn, each with its state, still in zone order. */
export function buildOverlay(plan: PatrolPlanZones | null | undefined, input: MarkInput): PatrolOverlay | null {
  const points = planPoints(plan);
  const states = markStates(points, input);
  const zones: PatrolOverlay['zones'] = [];
  for (const p of points) {
    if (!p.valid) continue;
    let zone = zones[zones.length - 1];
    if (!zone || zone.zone !== p.zone) {
      zone = { zone: p.zone, points: [] };
      zones.push(zone);
    }
    zone.points.push({ seq: p.seq, x: p.x, y: p.y, state: states.get(p.seq) ?? 'pending' });
  }
  return zones.length ? { zones } : null;
}

/**
 * How a run ended, as the UI says it. `out`: a patrol is out right now and this
 * is the newest run, so a run the server has not ended is the one driving.
 * null: the server does not say (an older one).
 */
export function runEnding(run: Pick<PatrolRunDto, 'endedPhase'>, out: boolean): 'done' | 'stopped' | 'error' | 'running' | 'unknown' | null {
  const p = run.endedPhase;
  if (p === 'done' || p === 'stopped' || p === 'error') return p;
  if (out) return 'running';
  return p === null ? 'unknown' : null;
}

export interface RunSummary {
  reached: number;
  /** Checkpoints in the run's plan; null when the server sent none. */
  total: number | null;
  /** Checkpoints left out; null without a plan (nothing to compare with). */
  skipped: number | null;
  /** Checkpoints where a person / an animal reached the alert level. */
  persons: number;
  animals: number;
}

export function summarizeRun(run: Pick<PatrolRunDto, 'frames' | 'plan' | 'endedPhase'>): RunSummary {
  const frames = run.frames ?? [];
  const reachedSeqs = new Set(frames.map(f => f.seq));
  const points = planPoints(normalizePlan(run.plan));
  let skipped: number | null = null;
  if (points.length) {
    const states = markStates(points, { mode: 'finished', reached: reachedSeqs, endedPhase: run.endedPhase });
    skipped = [...states.values()].filter(s => s === 'skipped').length;
  }
  return {
    reached: reachedSeqs.size,
    total: points.length || null,
    skipped,
    persons: frames.filter(f => f.seen?.includes('person')).length,
    animals: frames.filter(f => f.seen?.includes('animal')).length,
  };
}
