import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { cutGrassPlanRepo, equipmentRepo, mapRepo } from '../../db/repositories/index.js';
import { authMiddleware } from '../../middleware/auth.js';
import { AuthRequest, ok, fail, PlanRow } from '../../types/index.js';
import { mirrorPlanToSchedule, removeScheduleForPlan } from '../../services/scheduleMirror.js';
import type { CutGrassPlanRow } from '../../db/repositories/cutGrassPlans.js';

export const cutGrassPlanRouter = Router();

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

function calcMinutes(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

/**
 * Resolve a stored work-area entry to the current map alias for display.
 * The app's saveCutGrassPlan stores whatever the user picked at save
 * time — usually a canonical filename like `map1_work.csv` or the
 * canonical name `map1`. After the user later renames the map via
 * updateEquipmentMapAlias the stored value goes stale. This helper
 * looks the entry up against the maps table and returns the current
 * `map_name` (alias). Falls back to the stored value when no row
 * matches so legacy data still displays something sensible.
 */
function resolveAreaAlias(stored: unknown, mowerSn: string | null): string | null {
  if (typeof stored !== 'string' || !stored || !mowerSn) {
    return typeof stored === 'string' ? stored : null;
  }
  const baseName = stored.replace(/\.csv$/, '');
  const workMatch = stored.match(/^map(\d+)(?:_work)?(?:\.csv)?$/);
  const all = mapRepo.findWithAreaOrderByMapId(mowerSn);

  // First try literal canonical match (mowers that store "map1" or
  // "map1_work.csv" directly).
  let row = all.find(m =>
    m.canonical_name === baseName ||
    m.canonical_name === stored ||
    m.file_name === stored ||
    (m.file_name && m.file_name.replace(/\.csv$/, '') === baseName)
  );

  // Then fall through on the work-N match.
  if (!row && workMatch) {
    const idx = workMatch[1];
    row = all.find(m => m.canonical_name === `map${idx}` && m.map_type === 'work');
  }

  return row?.map_name ?? stored;
}

/**
 * Compute the next-occurring weekday from `today` that is in `weeks`.
 * Used for the `week` field shown by the app on the home-screen
 * "Next task : ..." line. Returning weeks[0] (alphabetical first) made
 * the app always show "Mon" even when today was Wed and the schedule
 * was Mon/Wed/Fri — the user's reported "first day in series" bug.
 */
function nextOccurringDay(weeks: string[], today: Date): string | null {
  if (!weeks.length) return null;
  const order = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const todayIdx = today.getDay();
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = order[(todayIdx + offset) % 7];
    if (weeks.includes(candidate)) return candidate;
  }
  return weeks[0];
}

function rowToDto(r: PlanRow, today: Date = new Date()) {
  const weekday = r.weekday ? JSON.parse(r.weekday) : [];
  const workArea = r.work_area ? JSON.parse(r.work_area) : [];
  // Resolve SN from equipment
  const eq = r.equipment_id ? equipmentRepo.findByEquipmentId(r.equipment_id) : null;
  const sn = eq?.mower_sn ?? null;
  const aliasResolved = workArea.length > 0 ? resolveAreaAlias(workArea[0], sn) : null;

  return {
    // Novabot app velden (WorkPlanEntityItem.fromJson parses these exact field names)
    // Cloud retourneert integer id — app parst het mogelijk als int
    id: r.id ?? Math.abs(hashCode(r.plan_id)),
    sn,
    timezone: r.timezone ?? null,
    week: nextOccurringDay(weekday, today),  // next-occurring weekday from today
    weeks: weekday,
    weekArray: weekday,
    startTime: r.start_time,
    endTime: r.end_time,
    workTime: r.work_time ?? null,
    area: r.area ?? (workArea.length > 0 ? 1 : null),
    cutGrassHeight: r.cut_grass_height ?? null,
    repeatType: r.repeat_type != null ? Number(r.repeat_type) : 1,
    associationId: null,
    times: r.repeat_count ?? 1,
    workDay: r.work_day != null ? (typeof r.work_day === 'string' ? JSON.parse(r.work_day) : r.work_day) : 0,
    areaFileAlias: aliasResolved,
    // Dashboard velden (backwards compat)
    planId: r.plan_id,
    equipmentId: r.equipment_id,
    weekday,
    repeat: r.repeat === 1,
    repeatCount: r.repeat_count,
    workArea,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// GET+POST /api/nova-data/appManage/queryCutGrassPlan
// Flutter app stuurt POST met params, dashboard stuurt GET met query
cutGrassPlanRouter.get('/queryCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const { equipmentId } = req.query as { equipmentId?: string };
  const rows = equipmentId
    ? cutGrassPlanRepo.findByEquipmentAndUser(equipmentId, req.userId!)
    : cutGrassPlanRepo.findByUser(req.userId!);
  res.json(ok((rows as PlanRow[]).map((row) => rowToDto(row))));
});
cutGrassPlanRouter.post('/queryCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const { equipmentId, sn: _sn } = req.body as { equipmentId?: string; sn?: string };
  const rows = equipmentId
    ? cutGrassPlanRepo.findByEquipmentAndUser(equipmentId, req.userId!)
    : cutGrassPlanRepo.findByUser(req.userId!);
  const items = (rows as PlanRow[]).map((row) => rowToDto(row));

  // Novabot app verwacht Map<dag, List<item>> formaat:
  // WorkPlanEntity.fromJson parst json["Mon"], json["Tue"], etc.
  // KRITIEK: elke dag krijgt een apart item met `week` gezet op die specifieke dag.
  // Cloud geeft ook per dag een uniek `id` — wij hashen planId+dag.
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const grouped: Record<string, unknown[]> = {};
  for (const day of DAYS) grouped[day] = [];
  for (const item of items) {
    const weeks = item.weeks as string[] ?? [];
    for (const day of weeks) {
      if (grouped[day]) {
        grouped[day].push({
          ...item,
          week: day,  // specifieke dag voor dit item
          workTime: item.startTime && item.endTime
            ? String(calcMinutes(item.startTime as string, item.endTime as string))
            : null,
        });
      }
    }
  }
  res.json(ok(grouped));
});

// POST /api/nova-data/cutGrassPlan/queryRecentCutGrassPlan
// App stuurt: { sn, currentTime, week }
// Cloud retourneert ALTIJD een object met null-velden als er geen plan is (nooit null zelf).
const EMPTY_PLAN = {
  id: null, sn: null, timezone: null, week: null,
  startTime: null, endTime: null, workTime: null, workDay: null,
  area: null, areaFileAlias: null, cutGrassHeight: null,
  repeatType: null, associationId: null, weekArray: null, times: null,
};
cutGrassPlanRouter.post('/queryRecentCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const { sn } = req.body as { sn?: string };
  const row = sn
    ? cutGrassPlanRepo.findRecentByUserAndSn(req.userId!, sn)
    : cutGrassPlanRepo.findRecentByUser(req.userId!);
  res.json(ok(row ? rowToDto(row as PlanRow) : EMPTY_PLAN));
});

// GET variant (backwards compat)
cutGrassPlanRouter.get('/queryRecentCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const { equipmentId } = req.query as { equipmentId?: string };
  const row = equipmentId
    ? cutGrassPlanRepo.findRecentByUserAndEquipment(req.userId!, equipmentId)
    : cutGrassPlanRepo.findRecentByUser(req.userId!);
  res.json(ok(row ? rowToDto(row as PlanRow) : EMPTY_PLAN));
});

// POST /api/nova-data/appManage/saveCutGrassPlan
// Novabot app stuurt: { sn, timezone, weeks, startTime, endTime, cutGrassHeight, area, repeatType, areaMapFileNames, times, workDay }
// Dashboard stuurt: { equipmentId, startTime, endTime, weekday, ... }
cutGrassPlanRouter.post('/saveCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const body = req.body as {
    equipmentId?: string;
    sn?: string;
    startTime?: string;
    endTime?: string;
    weekday?: number[];
    weeks?: string[];
    repeat?: boolean;
    repeatCount?: number;
    repeatType?: string | number;
    workTime?: number;
    workArea?: unknown[];
    workDay?: unknown[] | number;
    timezone?: string;
    cutGrassHeight?: number;
    area?: number;
    areaMapFileNames?: string[];
    times?: number;
  };

  // Resolve equipmentId from SN if not provided directly
  let equipmentId = body.equipmentId;
  if (!equipmentId && body.sn) {
    const eq = equipmentRepo.findBySn(body.sn);
    equipmentId = eq?.equipment_id ?? undefined;
  }
  if (!equipmentId) { res.json(fail('equipmentId or sn required', 400)); return; }

  // Novabot app stuurt weeks als ["Mon","Tue",...], converteer naar weekday array
  const weekday = body.weekday ?? body.weeks ?? null;

  const planId = uuidv4();
  cutGrassPlanRepo.create({
    planId,
    equipmentId,
    userId: req.userId!,
    startTime: body.startTime,
    endTime: body.endTime,
    weekday: weekday ? JSON.stringify(weekday) : null,
    repeat: body.repeat ?? (body.repeatType != null),
    repeatCount: body.repeatCount ?? body.times,
    repeatType: body.repeatType != null ? String(body.repeatType) : null,
    workTime: body.workTime,
    workArea: body.workArea ?? body.areaMapFileNames ? JSON.stringify(body.workArea ?? body.areaMapFileNames) : null,
    workDay: body.workDay != null ? JSON.stringify(body.workDay) : null,
    cutGrassHeight: body.cutGrassHeight ?? null,
    area: body.area ?? null,
    timezone: body.timezone ?? null,
  });
  // Mirror into dashboard_schedules: that is the table scheduleRunner fires (#108).
  const created = cutGrassPlanRepo.findById(planId);
  if (created) mirrorPlanToSchedule(created);

  res.json(ok({ planId }));
});

// POST /api/nova-data/appManage/updateCutGrassPlan
cutGrassPlanRouter.post('/updateCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const body = req.body as { planId?: string } & Record<string, unknown>;
  if (!body.planId) { res.json(fail('planId required', 400)); return; }

  const workAreaInput = body.workArea ?? body.areaMapFileNames;
  const repeatTypeStr =
    body.repeatType != null ? String(body.repeatType) : null;

  cutGrassPlanRepo.update(body.planId, req.userId!, {
    startTime: (body.startTime as string) ?? null,
    endTime: (body.endTime as string) ?? null,
    weekday: body.weekday ?? body.weeks
      ? JSON.stringify(body.weekday ?? body.weeks)
      : null,
    repeat: body.repeat !== undefined ? (body.repeat as boolean) : null,
    repeatCount:
      (body.repeatCount as number) ?? (body.times as number) ?? null,
    repeatType: repeatTypeStr,
    workTime: (body.workTime as number) ?? null,
    workArea: workAreaInput ? JSON.stringify(workAreaInput) : null,
    workDay: body.workDay != null ? JSON.stringify(body.workDay) : null,
    cutGrassHeight: (body.cutGrassHeight as number) ?? null,
    area: (body.area as number) ?? null,
    timezone: (body.timezone as string) ?? null,
  });
  const updated = cutGrassPlanRepo.findById(body.planId);
  if (updated) mirrorPlanToSchedule(updated);
  res.json(ok());
});

// POST /api/nova-data/appManage/deleteCutGrassPlan
// Novabot app stuurt: { id: <number>, deleteType: "all" }
cutGrassPlanRouter.post('/deleteCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const { planId, id, deleteType } = req.body as { planId?: string; id?: number | string; deleteType?: string };
  const resolvedPlanId = planId ?? (id != null ? String(id) : undefined);

  if (!resolvedPlanId) { res.json(fail('planId or id required', 400)); return; }

  // id kan een hashcode integer zijn — zoek het echte plan
  if (deleteType === 'all') {
    // Verwijder alle plans voor deze user
    const allPlans = cutGrassPlanRepo.findByUser(req.userId!);
    for (const p of allPlans) {
      removeScheduleForPlan(p as CutGrassPlanRow);
      cutGrassPlanRepo.delete((p as any).plan_id, req.userId!);
    }
    res.json(ok());
  } else {
    const existing = cutGrassPlanRepo.findById(resolvedPlanId);
    if (existing) removeScheduleForPlan(existing);
    cutGrassPlanRepo.delete(resolvedPlanId, req.userId!);
    res.json(ok());
  }
});

// POST /api/nova-data/appManage/queryNewVersion
cutGrassPlanRouter.post('/queryNewVersion', (_req, res: Response) => {
  res.json(ok({ version: '2.3.9', hasNewVersion: false }));
});

// ── Maaier firmware endpoint (geen JWT auth) ──────────────────────────────────

// POST /api/nova-data/cutGrassPlan/queryPlanFromMachine
// De maaier vraagt maaischema's op via SN (geen JWT). Hij POST als
// multipart/form-data (mqtt_node http_post_upload mode 5: curl_formadd
// `sn` + `week`), net als saveCutGrassRecord. Zonder multer bleef req.body
// leeg, kreeg de maaier "sn required" en liep geen enkel schema uit de
// Novabot-app ooit (#108). De STM32 vraagt dit op via CMD_SCHEDULE_GET.
const formFields = multer();
cutGrassPlanRouter.post('/queryPlanFromMachine', formFields.none(), (req: Request, res: Response) => {
  const { sn, week } = (req.body ?? {}) as { sn?: string; week?: string };
  if (!sn) { res.json(fail('sn required', 400)); return; }

  // `week` is what the STM32 asked for (CMD_SCHEDULE_GET). Logged as hex as
  // well: chassis_control builds it from a raw byte, and until a stock mower
  // has shown us the value we only filter on a plain day name.
  const weekHex = week ? Buffer.from(week).toString('hex') : '';
  console.log(`[PLAN] queryPlanFromMachine: sn=${sn} week=${JSON.stringify(week ?? null)} (hex ${weekHex || '-'})`);

  const dayName = typeof week === 'string' && /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/i.test(week.trim())
    ? week.trim().slice(0, 1).toUpperCase() + week.trim().slice(1, 3).toLowerCase()
    : null;
  const rows = cutGrassPlanRepo.findBySnForMachine(sn).filter((row) => {
    if (!dayName) return true;
    const days = row.weekday ? (JSON.parse(row.weekday) as unknown[]) : [];
    return days.length === 0 || days.some((d) => String(d).slice(0, 3).toLowerCase() === dayName.toLowerCase());
  });

  // chassis_control (5.7.1 and 6.0.2 alike, chassis_publisher.cpp:3385-3404)
  // reads per plan: startTime.asString(), endTime.asString() and
  // areaFileAlias.size(), the number of zones handed to the STM32. On a
  // string Json::Value::size() is 0, so the app-facing alias string meant
  // "zero zones". The mower gets one alias per work area, as an array.
  res.json(ok((rows as PlanRow[]).map((row) => {
    const dto = rowToDto(row);
    const areas = Array.isArray(dto.workArea) ? dto.workArea : [];
    return { ...dto, areaFileAlias: areas.map((a) => resolveAreaAlias(a, dto.sn) ?? String(a)) };
  })));
});
