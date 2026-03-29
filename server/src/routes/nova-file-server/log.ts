import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authMiddleware } from '../../middleware/auth.js';
import { AuthRequest, ok } from '../../types/index.js';

export const logRouter = Router();

const LOG_PATH = path.resolve(process.env.STORAGE_PATH ?? './storage', 'logs');
fs.mkdirSync(LOG_PATH, { recursive: true });

const upload = multer({ dest: LOG_PATH });

// POST /api/nova-file-server/log/uploadAppOperateLog
logRouter.post('/uploadAppOperateLog', authMiddleware, upload.single('file'), (req: AuthRequest, res: Response) => {
  // Log body data for inspection, useful during reverse engineering
  const { userId } = req;
  const fileName = req.file?.originalname ?? `log_${Date.now()}.txt`;
  console.log(`[LOG] Received app log from user ${userId}: ${fileName}`);
  res.json(ok());
});
