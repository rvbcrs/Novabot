import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { cutGrassPlanRepo, equipmentRepo } from '../../db/repositories/index.js';
import { authMiddleware } from '../../middleware/auth.js';
import { AuthRequest, ok, fail, PlanRow } from '../../types/index.js';

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

function rowToDto(r: PlanRow) {
  const weekday = r.weekday ? JSON.parse(r.weekday) : [];
  const workArea = r.work_area ? JSON.parse(r.work_area) : [];
  // Resolve SN from equipment
  const eq = r.equipment_id ? equipmentRepo.findByEquipmentId(r.equipment_id) : null;
  const sn = eq?.mower_sn ?? null;

  return {
    // Novabot app velden (WorkPlanEntityItem.fromJson parses these exact field names)
    // Cloud retourneert integer id — app parst het mogelijk als int
    id: r.id ?? Math.abs(hashCode(r.plan_id)),
    sn,
    timezone: null,
    week: weekday.length > 0 ? weekday[0] : null,  // enkelvoud "week", niet "weeks"
    weeks: weekday,
    weekArray: weekday,
    startTime: r.start_time,
    endTime: r.end_time,
    workTime: r.work_time ?? null,
    area: workArea.length > 0 ? 1 : null,
    cutGrassHeight: null,  // TODO: opslaan in DB
    repeatType: r.repeat_type != null ? Number(r.repeat_type) : 1,
    associationId: null,
    times: r.repeat_count ?? 1,
    workDay: r.work_day != null ? (typeof r.work_day === 'string' ? JSON.parse(r.work_day) : r.work_day) : 0,
    areaFileAlias: workArea.length > 0 ? workArea[0] : null,
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
  res.json(ok((rows as PlanRow[]).map(rowToDto)));
});
cutGrassPlanRouter.post('/queryCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const { equipmentId, sn } = req.body as { equipmentId?: string; sn?: string };
  const rows = equipmentId
    ? cutGrassPlanRepo.findByEquipmentAndUser(equipmentId, req.userId!)
    : cutGrassPlanRepo.findByUser(req.userId!);
  const items = (rows as PlanRow[]).map(rowToDto);

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
  });

  res.json(ok({ planId }));
});

// POST /api/nova-data/appManage/updateCutGrassPlan
cutGrassPlanRouter.post('/updateCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const body = req.body as { planId?: string } & Record<string, unknown>;
  if (!body.planId) { res.json(fail('planId required', 400)); return; }

  cutGrassPlanRepo.update(body.planId, req.userId!, {
    startTime: (body.startTime as string) ?? null,
    endTime: (body.endTime as string) ?? null,
    weekday: body.weekday ? JSON.stringify(body.weekday) : null,
    repeat: body.repeat !== undefined ? (body.repeat as boolean) : null,
    repeatCount: (body.repeatCount as number) ?? null,
    repeatType: (body.repeatType as string) ?? null,
    workTime: (body.workTime as number) ?? null,
    workArea: body.workArea ? JSON.stringify(body.workArea) : null,
    workDay: body.workDay ? JSON.stringify(body.workDay) : null,
  });
  res.json(ok());
});

// POST /api/nova-data/appManage/deleteCutGrassPlan
cutGrassPlanRouter.post('/deleteCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const { planId } = req.body as { planId?: string };
  if (!planId) { res.json(fail('planId required', 400)); return; }

  cutGrassPlanRepo.delete(planId, req.userId!);
  res.json(ok());
});

// POST /api/nova-data/appManage/queryNewVersion
cutGrassPlanRouter.post('/queryNewVersion', (_req, res: Response) => {
  res.json(ok({ version: '2.3.9', hasNewVersion: false }));
});

// ── Maaier firmware endpoint (geen JWT auth) ──────────────────────────────────

// POST /api/nova-data/cutGrassPlan/queryPlanFromMachine
// De maaier vraagt maaischema's op via SN (geen JWT).
cutGrassPlanRouter.post('/queryPlanFromMachine', (req: Request, res: Response) => {
  const { sn } = req.body as { sn?: string };
  if (!sn) { res.json(fail('sn required', 400)); return; }

  console.log(`[PLAN] queryPlanFromMachine: sn=${sn}`);

  const rows = cutGrassPlanRepo.findBySnForMachine(sn);

  res.json(ok((rows as PlanRow[]).map(rowToDto)));
});
