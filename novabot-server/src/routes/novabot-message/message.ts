import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/database.js';
import { authMiddleware } from '../../middleware/auth.js';
import { AuthRequest, ok, fail } from '../../types/index.js';

export const messageRouter = Router();

// ── Robot messages ────────────────────────────────────────────────────────────

// GET /api/novabot-message/message/queryRobotMsgPageByUserId
messageRouter.get('/queryRobotMsgPageByUserId', authMiddleware, (req: AuthRequest, res: Response) => {
  const page  = parseInt(req.query.page  as string ?? '1', 10);
  const limit = parseInt(req.query.limit as string ?? '20', 10);
  const offset = (page - 1) * limit;

  const total = (db.prepare('SELECT COUNT(*) as c FROM robot_messages WHERE user_id = ?').get(req.userId) as { c: number }).c;
  const rows  = db.prepare('SELECT * FROM robot_messages WHERE user_id = ? ORDER BY robot_msg_date DESC LIMIT ? OFFSET ?')
    .all(req.userId, limit, offset);

  res.json(ok({ total, page, limit, list: rows }));
});

// POST /api/novabot-message/message/queryMsgMenuByUserId
// Cloud response format (ConsoleLogMower.txt):
// { workRecordMsg, workRecordUnread, workRecordDate, robotMsg, robotMsgUnread, robotMsgDate,
//   securityRecordMsg, securityRecordUnread, sharingMsg, sharingUnread, sharingDate,
//   promotionMsg, promotionUnread, promotionDate }
messageRouter.post('/queryMsgMenuByUserId', authMiddleware, (req: AuthRequest, res: Response) => {
  const unreadRobot = (db.prepare('SELECT COUNT(*) as c FROM robot_messages WHERE user_id = ? AND robot_msg_unread = 1').get(req.userId) as { c: number }).c;
  const unreadWork  = (db.prepare('SELECT COUNT(*) as c FROM work_records   WHERE user_id = ? AND work_record_unread = 1').get(req.userId) as { c: number }).c;
  const latestWork  = db.prepare('SELECT work_record_date FROM work_records WHERE user_id = ? ORDER BY work_record_date DESC LIMIT 1').get(req.userId) as { work_record_date: string } | undefined;
  const latestRobot = db.prepare('SELECT robot_msg_date FROM robot_messages WHERE user_id = ? ORDER BY robot_msg_date DESC LIMIT 1').get(req.userId) as { robot_msg_date: string } | undefined;

  res.json(ok({
    workRecordMsg: null,
    workRecordUnread: unreadWork,
    workRecordDate: latestWork?.work_record_date ?? null,
    securityRecordMsg: null,
    securityRecordUnread: null,
    robotMsg: null,
    robotMsgUnread: unreadRobot,
    robotMsgDate: latestRobot?.robot_msg_date ?? null,
    sharingMsg: null,
    sharingUnread: null,
    sharingDate: null,
    promotionMsg: null,
    promotionUnread: null,
    promotionDate: null,
  }));
});

// POST /api/novabot-message/message/updateMsgByUserId  (mark as read)
messageRouter.post('/updateMsgByUserId', authMiddleware, (req: AuthRequest, res: Response) => {
  const { messageIds } = req.body as { messageIds?: string[] };
  if (!messageIds?.length) {
    // Mark all read
    db.prepare('UPDATE robot_messages SET robot_msg_unread = 0 WHERE user_id = ?').run(req.userId);
  } else {
    const placeholders = messageIds.map(() => '?').join(',');
    db.prepare(`UPDATE robot_messages SET robot_msg_unread = 0 WHERE message_id IN (${placeholders}) AND user_id = ?`)
      .run(...messageIds, req.userId);
  }
  res.json(ok());
});

// POST /api/novabot-message/message/deleteMsgByUserId
messageRouter.post('/deleteMsgByUserId', authMiddleware, (req: AuthRequest, res: Response) => {
  const { messageIds } = req.body as { messageIds?: string[] };
  if (!messageIds?.length) {
    db.prepare('DELETE FROM robot_messages WHERE user_id = ?').run(req.userId);
  } else {
    const placeholders = messageIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM robot_messages WHERE message_id IN (${placeholders}) AND user_id = ?`)
      .run(...messageIds, req.userId);
  }
  res.json(ok());
});

// ── Work / mowing records ─────────────────────────────────────────────────────

// GET /api/novabot-message/message/queryCutGrassRecordPageByUserId
messageRouter.get('/queryCutGrassRecordPageByUserId', authMiddleware, (req: AuthRequest, res: Response) => {
  const page  = parseInt(req.query.page  as string ?? '1', 10);
  const limit = parseInt(req.query.limit as string ?? '20', 10);
  const offset = (page - 1) * limit;

  const total = (db.prepare('SELECT COUNT(*) as c FROM work_records WHERE user_id = ?').get(req.userId) as { c: number }).c;
  const rows  = db.prepare('SELECT * FROM work_records WHERE user_id = ? ORDER BY work_record_date DESC LIMIT ? OFFSET ?')
    .all(req.userId, limit, offset);

  res.json(ok({ total, page, limit, list: rows }));
});

// ── Internal helper: insert a robot message (called from MQTT bridge) ─────────

export function insertRobotMessage(userId: string, equipmentId: string, msg: string): void {
  db.prepare(`
    INSERT INTO robot_messages (message_id, user_id, equipment_id, robot_msg, robot_msg_date, robot_msg_unread)
    VALUES (?, ?, ?, ?, datetime('now'), 1)
  `).run(uuidv4(), userId, equipmentId, msg);
}

export function insertWorkRecord(userId: string, equipmentId: string, status: string, workTime: number): void {
  db.prepare(`
    INSERT INTO work_records (record_id, user_id, equipment_id, work_record_date, work_status, work_time, work_record_unread)
    VALUES (?, ?, ?, datetime('now'), ?, ?, 1)
  `).run(uuidv4(), userId, equipmentId, status, workTime);
}
