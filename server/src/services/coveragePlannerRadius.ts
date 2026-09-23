import { translator, type Translate } from './serverText.js';

export const COVERAGE_PLANNER_RADIUS_KEY = 'coverage_planner_radius';
export const DEFAULT_COVERAGE_PLANNER_RADIUS = 0.61;
export const MIN_COVERAGE_PLANNER_RADIUS = 0.2;
export const MAX_COVERAGE_PLANNER_RADIUS = 1.2;

export interface CoveragePlannerRadiusSelection {
  radius: number;
  source: 'stored' | 'default';
}

export function parseCoveragePlannerRadius(value: unknown): number | null {
  const radius = Number(value);
  if (!Number.isFinite(radius)) return null;
  if (radius < MIN_COVERAGE_PLANNER_RADIUS || radius > MAX_COVERAGE_PLANNER_RADIUS) {
    return null;
  }
  return Number(radius.toFixed(3));
}

export function formatCoveragePlannerRadius(radius: number): string {
  return Number(radius.toFixed(3)).toString();
}

export function selectCoveragePlannerRadius(
  rows: { key: string; value: string }[],
): CoveragePlannerRadiusSelection {
  const row = rows.find((r) => r.key === COVERAGE_PLANNER_RADIUS_KEY);
  const parsed = row ? parseCoveragePlannerRadius(row.value) : null;
  if (parsed !== null) return { radius: parsed, source: 'stored' };
  return { radius: DEFAULT_COVERAGE_PLANNER_RADIUS, source: 'default' };
}

export function coveragePlannerRadiusError(T: Translate = translator('en')): string {
  return T`de straal moet een getal tussen ${MIN_COVERAGE_PLANNER_RADIUS} en ${MAX_COVERAGE_PLANNER_RADIUS} meter zijn`;
}
