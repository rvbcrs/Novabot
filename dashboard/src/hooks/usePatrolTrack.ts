import { useState } from 'react';
import { advanceTrack, NO_TRACKS, type TrackState } from '../utils/patrolTrack';
import { patrolStatus } from '../utils/patrolStatus';

/**
 * Where the active mower drove during a night patrol, from its live map position
 * (the one the mower marker uses). It lives in the shell, not in the patrol panel,
 * so it keeps recording with the panel closed or another tab open. The state is a
 * function of the inputs and the state before, applied while rendering (as React
 * documents for state that follows props); use `trackForView` to pick what to draw.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
export function usePatrolTrack(
  sn: string | null,
  sensors: Record<string, string> | undefined,
  enabled: boolean,
  reportsRun: string | null,
): TrackState {
  const { phase, active } = patrolStatus(sensors);
  const x = parseFloat(sensors?.map_position_x ?? '');
  const y = parseFloat(sensors?.map_position_y ?? '');
  const [state, setState] = useState<TrackState>(NO_TRACKS);
  const next = advanceTrack(state, {
    sn, enabled, phase, active, reportsRun,
    point: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null,
  });
  if (next !== state) setState(next);
  return next;
}
