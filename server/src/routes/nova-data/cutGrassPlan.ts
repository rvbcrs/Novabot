import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { cutGrassPlanRepo } from '../../db/repositories/index.js';
import { authMiddleware } from '../../middleware/auth.js';
import { AuthRequest, ok, fail, PlanRow } from '../../types/index.js';

export const cutGrassPlanRouter = Router();

function rowToDto(r: PlanRow) {
  return {
    planId: r.plan_id,
    equipmentId: r.equipment_id,
    startTime: r.start_time,
    endTime: r.end_time,
    weekday: r.weekday ? JSON.parse(r.weekday) : [],
    repeat: r.repeat === 1,
    repeatCount: r.repeat_count,
    repeatType: r.repeat_type,
    workTime: r.work_time,
    workArea: r.work_area ? JSON.parse(r.work_area) : [],
    workDay: r.work_day ? JSON.parse(r.work_day) : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// GET /api/nova-data/appManage/queryCutGrassPlan
cutGrassPlanRouter.get('/queryCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const { equipmentId } = req.query as { equipmentId?: string };
  const rows = equipmentId
    ? cutGrassPlanRepo.findByEquipmentAndUser(equipmentId, req.userId!)
    : cutGrassPlanRepo.findByUser(req.userId!);
  res.json(ok((rows as PlanRow[]).map(rowToDto)));
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
cutGrassPlanRouter.post('/saveCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const body = req.body as {
    equipmentId?: string;
    startTime?: string;
    endTime?: string;
    weekday?: number[];
    repeat?: boolean;
    repeatCount?: number;
    repeatType?: string;
    workTime?: number;
    workArea?: unknown[];
    workDay?: unknown[];
  };

  if (!body.equipmentId) { res.json(fail('equipmentId required', 400)); return; }

  const planId = uuidv4();
  cutGrassPlanRepo.create({
    planId,
    equipmentId: body.equipmentId,
    userId: req.userId!,
    startTime: body.startTime,
    endTime: body.endTime,
    weekday: body.weekday ? JSON.stringify(body.weekday) : null,
    repeat: body.repeat,
    repeatCount: body.repeatCount,
    repeatType: body.repeatType,
    workTime: body.workTime,
    workArea: body.workArea ? JSON.stringify(body.workArea) : null,
    workDay: body.workDay ? JSON.stringify(body.workDay) : null,
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
