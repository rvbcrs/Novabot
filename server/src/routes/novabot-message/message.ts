import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { messageRepo } from '../../db/repositories/index.js';
import { authMiddleware } from '../../middleware/auth.js';
import { AuthRequest, ok, fail } from '../../types/index.js';

export const messageRouter = Router();

// ── Robot messages ────────────────────────────────────────────────────────────

// GET /api/novabot-message/message/queryRobotMsgPageByUserId
messageRouter.get('/queryRobotMsgPageByUserId', authMiddleware, (req: AuthRequest, res: Response) => {
  const page  = parseInt(req.query.page  as string ?? '1', 10);
  const limit = parseInt(req.query.limit as string ?? '20', 10);
  const offset = (page - 1) * limit;

  const total = messageRepo.countMessages(req.userId!);
  const rows  = messageRepo.findMessagesByUserId(req.userId!, limit, offset);

  res.json(ok({ total, page, limit, list: rows }));
});

// POST /api/novabot-message/message/queryMsgMenuByUserId
// Cloud response format (ConsoleLogMower.txt):
// { workRecordMsg, workRecordUnread, workRecordDate, robotMsg, robotMsgUnread, robotMsgDate,
//   securityRecordMsg, securityRecordUnread, sharingMsg, sharingUnread, sharingDate,
//   promotionMsg, promotionUnread, promotionDate }
messageRouter.post('/queryMsgMenuByUserId', authMiddleware, (req: AuthRequest, res: Response) => {
  const unreadRobot = messageRepo.countUnreadMessages(req.userId!);
  const unreadWork  = messageRepo.countUnreadWorkRecords(req.userId!);
  const latestWork  = messageRepo.getLatestWorkRecordDate(req.userId!);
  const latestRobot = messageRepo.getLatestMessageDate(req.userId!);

  res.json(ok({
    workRecordMsg: null,
    workRecordUnread: unreadWork,
    workRecordDate: latestWork,
    securityRecordMsg: null,
    securityRecordUnread: null,
    robotMsg: null,
    robotMsgUnread: unreadRobot,
    robotMsgDate: latestRobot,
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
    messageRepo.markMessagesRead(req.userId!);
  } else {
    messageRepo.markMessagesReadByIds(messageIds, req.userId!);
  }
  res.json(ok());
});

// POST /api/novabot-message/message/deleteMsgByUserId
messageRouter.post('/deleteMsgByUserId', authMiddleware, (req: AuthRequest, res: Response) => {
  const { messageIds } = req.body as { messageIds?: string[] };
  if (!messageIds?.length) {
    messageRepo.deleteMessagesByUserId(req.userId!);
  } else {
    messageRepo.deleteMessagesByIds(messageIds, req.userId!);
  }
  res.json(ok());
});

// ── Work / mowing records ─────────────────────────────────────────────────────

// GET /api/novabot-message/message/queryCutGrassRecordPageByUserId
messageRouter.get('/queryCutGrassRecordPageByUserId', authMiddleware, (req: AuthRequest, res: Response) => {
  const page  = parseInt(req.query.page  as string ?? '1', 10);
  const limit = parseInt(req.query.limit as string ?? '20', 10);
  const offset = (page - 1) * limit;

  const total = messageRepo.countWorkRecords(req.userId!);
  const rows  = messageRepo.findWorkRecordsByUserId(req.userId!, limit, offset);

  res.json(ok({ total, page, limit, list: rows }));
});

// ── Internal helper: insert a robot message (called from MQTT bridge) ─────────

export function insertRobotMessage(userId: string, equipmentId: string, msg: string): void {
  messageRepo.createMessage(uuidv4(), userId, equipmentId, msg);
}

export function insertWorkRecord(userId: string, equipmentId: string, status: string, workTime: number): void {
  messageRepo.createWorkRecord(uuidv4(), userId, equipmentId, status, workTime);
}
