/**
 * Hoe ver het toepassen van een kaart op de maaier is (server: map_apply_phase
 * en map_apply_error, zie server/src/services/mapApplyStatus.ts). Een getekende
 * of gekopieerde zone staat meteen op de kaart, maar de maaier is pas klaar na
 * versturen, grids maken en het terugkomen van de planner.
 */
export type MapApplyPhase = 'syncing' | 'regenerating' | 'settling';
export type MapApplyView =
  | { state: 'idle' }
  | { state: 'busy'; phase: MapApplyPhase; step: 1 | 2 | 3 }
  | { state: 'failed'; error: string };

const STEPS: Record<MapApplyPhase, 1 | 2 | 3> = { syncing: 1, regenerating: 2, settling: 3 };

export function mapApplyView(sensors: Record<string, string | undefined> | null | undefined): MapApplyView {
  const phase = sensors?.map_apply_phase ?? '';
  if (phase === 'failed') return { state: 'failed', error: sensors?.map_apply_error || 'unknown' };
  if (phase in STEPS) return { state: 'busy', phase: phase as MapApplyPhase, step: STEPS[phase as MapApplyPhase] };
  return { state: 'idle' };
}

/** Error 140: robot_decision mist de processen die sync_map herstart. Hoort bij de push. */
export const PROCESS_RESTART_ERROR = 140;
