import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/database.js';
import { authMiddleware } from '../../middleware/auth.js';
import { AuthRequest, ok, fail, PlanRow } from '../../types/index.js';
// TODO: no cut_grass_plans repo yet — all db.prepare calls remain direct

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
    ? db.prepare('SELECT * FROM cut_grass_plans WHERE user_id = ? AND equipment_id = ?').all(req.userId, equipmentId)
    : db.prepare('SELECT * FROM cut_grass_plans WHERE user_id = ?').all(req.userId);
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
    ? db.prepare(`SELECT p.* FROM cut_grass_plans p
        JOIN equipment e ON e.equipment_id = p.equipment_id
        WHERE p.user_id = ? AND (e.mower_sn = ? OR e.charger_sn = ?)
        ORDER BY p.updated_at DESC LIMIT 1`).get(req.userId, sn, sn)
    : db.prepare('SELECT * FROM cut_grass_plans WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(req.userId);
  res.json(ok(row ? rowToDto(row as PlanRow) : EMPTY_PLAN));
});

// GET variant (backwards compat)
cutGrassPlanRouter.get('/queryRecentCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const { equipmentId } = req.query as { equipmentId?: string };
  const row = equipmentId
    ? db.prepare('SELECT * FROM cut_grass_plans WHERE user_id = ? AND equipment_id = ? ORDER BY updated_at DESC LIMIT 1').get(req.userId, equipmentId)
    : db.prepare('SELECT * FROM cut_grass_plans WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(req.userId);
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
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO cut_grass_plans
      (plan_id, equipment_id, user_id, start_time, end_time, weekday, repeat,
       repeat_count, repeat_type, work_time, work_area, work_day, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    planId, body.equipmentId, req.userId,
    body.startTime ?? null, body.endTime ?? null,
    body.weekday ? JSON.stringify(body.weekday) : null,
    body.repeat ? 1 : 0,
    body.repeatCount ?? 0, body.repeatType ?? null,
    body.workTime ?? null,
    body.workArea ? JSON.stringify(body.workArea) : null,
    body.workDay ? JSON.stringify(body.workDay) : null,
    now, now,
  );

  res.json(ok({ planId }));
});

// POST /api/nova-data/appManage/updateCutGrassPlan
cutGrassPlanRouter.post('/updateCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const body = req.body as { planId?: string } & Record<string, unknown>;
  if (!body.planId) { res.json(fail('planId required', 400)); return; }

  db.prepare(`
    UPDATE cut_grass_plans SET
      start_time   = COALESCE(?, start_time),
      end_time     = COALESCE(?, end_time),
      weekday      = COALESCE(?, weekday),
      repeat       = COALESCE(?, repeat),
      repeat_count = COALESCE(?, repeat_count),
      repeat_type  = COALESCE(?, repeat_type),
      work_time    = COALESCE(?, work_time),
      work_area    = COALESCE(?, work_area),
      work_day     = COALESCE(?, work_day),
      updated_at   = ?
    WHERE plan_id = ? AND user_id = ?
  `).run(
    body.startTime ?? null, body.endTime ?? null,
    body.weekday ? JSON.stringify(body.weekday) : null,
    body.repeat !== undefined ? (body.repeat ? 1 : 0) : null,
    body.repeatCount ?? null, body.repeatType ?? null,
    body.workTime ?? null,
    body.workArea ? JSON.stringify(body.workArea) : null,
    body.workDay ? JSON.stringify(body.workDay) : null,
    new Date().toISOString(),
    body.planId, req.userId,
  );
  res.json(ok());
});

// POST /api/nova-data/appManage/deleteCutGrassPlan
cutGrassPlanRouter.post('/deleteCutGrassPlan', authMiddleware, (req: AuthRequest, res: Response) => {
  const { planId } = req.body as { planId?: string };
  if (!planId) { res.json(fail('planId required', 400)); return; }

  db.prepare('DELETE FROM cut_grass_plans WHERE plan_id = ? AND user_id = ?').run(planId, req.userId);
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

  const rows = db.prepare(`
    SELECT p.* FROM cut_grass_plans p
    JOIN equipment e ON e.equipment_id = p.equipment_id
    WHERE e.mower_sn = ? OR e.charger_sn = ?
    ORDER BY p.updated_at DESC
  `).all(sn, sn) as PlanRow[];

  res.json(ok(rows.map(rowToDto)));
});
