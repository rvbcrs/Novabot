/**
 * One scheduler, two tables.
 *
 * The Novabot app keeps its schedules in `cut_grass_plans` (save/update/
 * deleteCutGrassPlan); the dashboard and the OpenNova app keep theirs in
 * `dashboard_schedules`, and only that table is what scheduleRunner fires.
 * A schedule made in the Novabot app therefore never ran (#108): the LFI
 * cloud ran those server-side and sent start_time_navigation at the hour,
 * and nothing on the mower asks for plans on its own.
 *
 * `dashboard_schedules` is the source of truth. Every write on either side
 * mirrors to the other, keyed on the id:
 *   app plan  <plan_id>      ↔  dashboard schedule  app:<plan_id>
 *   dashboard <schedule_id>  ↔  app plan            <schedule_id>
 *
 * The Novabot app only knows weekdays, start/end, height and zones; interval
 * mode, rain pause and edge days stay dashboard-only and survive an app-side
 * edit of the fields the app does know.
 */
import { cutGrassPlanRepo, equipmentRepo, mapRepo, scheduleRepo } from '../db/repositories/index.js';
import type { ScheduleRow } from '../db/repositories/schedules.js';
import type { CutGrassPlanRow } from '../db/repositories/cutGrassPlans.js';

const APP_PREFIX = 'app:';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function scheduleIdForPlan(planId: string): string {
  return planId.startsWith(APP_PREFIX) ? planId : APP_PREFIX + planId;
}
export function planIdForSchedule(scheduleId: string): string {
  return scheduleId.startsWith(APP_PREFIX) ? scheduleId.slice(APP_PREFIX.length) : scheduleId;
}

/** ["Mon","Wed"] → [1,3]; numbers pass through. */
export function weeksToWeekdays(weeks: unknown): number[] {
  if (!Array.isArray(weeks)) return [];
  const out = new Set<number>();
  for (const w of weeks) {
    if (typeof w === 'number' && w >= 0 && w <= 6) out.add(w);
    else if (typeof w === 'string') {
      const i = DAYS.findIndex(d => d.toLowerCase() === w.slice(0, 3).toLowerCase());
      if (i >= 0) out.add(i);
    }
  }
  return [...out].sort();
}
export function weekdaysToWeeks(weekdays: unknown): string[] {
  return Array.isArray(weekdays) ? weekdays.filter((d): d is number => typeof d === 'number' && DAYS[d] !== undefined).map(d => DAYS[d]) : [];
}

/** cutting_height carries mm (dashboard, >= 20) or user-cm (app). */
function toCm(h: number | null | undefined): number | null {
  if (h == null || !Number.isFinite(h)) return null;
  return h >= 20 ? Math.round(h / 10) : Math.round(h);
}

function slotOf(canonical: string | null | undefined): number | null {
  const m = canonical?.match(/^map(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** First app work-area entry ("map1", "map1_work.csv", or an alias) → maps row. */
function mapForAppArea(sn: string, entry: unknown) {
  if (typeof entry !== 'string' || !entry) return null;
  const base = entry.replace(/\.csv$/, '').replace(/_work$/, '');
  const all = mapRepo.findWithAreaOrderByMapId(sn).filter(m => (m.map_type ?? 'work') === 'work');
  return all.find(m => m.canonical_name === base || m.map_name === entry || m.file_name === entry) ?? null;
}

// ── app plan → dashboard schedule ────────────────────────────────────────
export function mirrorPlanToSchedule(plan: CutGrassPlanRow): void {
  const eq = equipmentRepo.findByEquipmentId(plan.equipment_id);
  const sn = eq?.mower_sn;
  if (!sn || !plan.start_time) return;
  const weeks = plan.weekday ? (JSON.parse(plan.weekday) as unknown[]) : [];
  const areas = plan.work_area ? (JSON.parse(plan.work_area) as unknown[]) : [];
  const map = mapForAppArea(sn, areas[0]);
  const data: Partial<ScheduleRow> = {
    start_time: plan.start_time,
    end_time: plan.end_time ?? null,
    weekdays: JSON.stringify(weeksToWeekdays(weeks)),
    map_id: map?.map_id ?? null,
    map_name: map?.map_name ?? null,
    cutting_height: toCm(plan.cut_grass_height) ?? undefined,
    timezone: plan.timezone ?? null,
    enabled: 1,
  };
  const scheduleId = scheduleIdForPlan(plan.plan_id);
  if (scheduleRepo.findByIdAndMower(scheduleId, sn)) {
    scheduleRepo.updateByIdAndMower(scheduleId, sn, data);
  } else {
    scheduleRepo.create({ ...data, schedule_id: scheduleId, mower_sn: sn, start_time: plan.start_time, schedule_name: 'Novabot app' });
  }
}

export function removeScheduleForPlan(plan: CutGrassPlanRow): void {
  const sn = equipmentRepo.findByEquipmentId(plan.equipment_id)?.mower_sn;
  if (sn) scheduleRepo.deleteByIdAndMower(scheduleIdForPlan(plan.plan_id), sn);
}

// ── dashboard schedule → app plan ────────────────────────────────────────
export function mirrorScheduleToPlan(scheduleId: string): void {
  const row = scheduleRepo.findById(scheduleId);
  if (!row) return;
  const eq = equipmentRepo.findBySn(row.mower_sn);
  if (!eq?.equipment_id) return;
  const planId = planIdForSchedule(row.schedule_id);
  const weekdays = row.weekdays ? (JSON.parse(row.weekdays) as unknown[]) : [];
  const map = row.map_id ? mapRepo.findWithAreaOrderByMapId(row.mower_sn).find(m => m.map_id === row.map_id) : null;
  const slot = slotOf(map?.canonical_name);
  const data = {
    startTime: row.start_time,
    endTime: row.end_time ?? null,
    weekday: JSON.stringify(weekdaysToWeeks(weekdays)),
    repeat: true,
    repeatCount: 1,
    repeatType: '1',
    workTime: null,
    workArea: map?.canonical_name ? JSON.stringify([map.canonical_name]) : null,
    workDay: null,
    cutGrassHeight: toCm(row.cutting_height),
    area: slot != null ? Math.pow(10, slot) : 1,
    timezone: row.timezone ?? null,
  };
  const existing = cutGrassPlanRepo.findById(planId);
  if (existing) {
    cutGrassPlanRepo.update(planId, existing.user_id, data);
  } else {
    // The app lists plans per user; without an owner there is nobody to show it to.
    if (!eq.user_id) return;
    cutGrassPlanRepo.create({ planId, equipmentId: eq.equipment_id, userId: eq.user_id, ...data });
  }
}

export function removePlanForSchedule(scheduleId: string): void {
  const planId = planIdForSchedule(scheduleId);
  const existing = cutGrassPlanRepo.findById(planId);
  if (existing) cutGrassPlanRepo.delete(planId, existing.user_id);
}
