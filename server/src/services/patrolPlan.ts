// server/src/services/patrolPlan.ts
/**
 * The checkpoints a night patrol would drive if it started now, for the
 * dashboard to draw on the map before anything moves.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import { mapRepo } from '../db/repositories/maps.js';
import { getPolygonAnchor } from './anchor.js';
import { buildPatrolZones, PATROL_INSET_M, type PatrolZone } from './patrolRoute.js';
import { readPatrolSettings } from './patrolService.js';

export interface PatrolPlan {
  /** In the order the mower drives them: the dock's zone first, then the rest by slot. */
  zones: PatrolZone[];
  spacingM: number;
  insetM: number;
}

/**
 * The zones startPatrol sends to the mower: the same settings, work-map rows,
 * obstacle rows and dock anchor, through the same buildPatrolZones. Nothing is
 * started or sent. Empty zones when nothing would be planned (startPatrol then
 * refuses).
 * Keep this call in step with the one in patrolService.startPatrol; the test
 * "keeps the checkpoints it sent on the run row" fails when they drift apart.
 */
export function planPatrol(sn: string): PatrolPlan {
  const s = readPatrolSettings(sn);
  const zones = buildPatrolZones(mapRepo.findWorkMaps(sn), s.zones, s.spacingM, getPolygonAnchor(sn), undefined,
    mapRepo.findAllByMowerSnAndType(sn, 'obstacle'));
  return { zones, spacingM: s.spacingM, insetM: PATROL_INSET_M };
}
