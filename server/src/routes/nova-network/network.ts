import { Router, Request, Response } from 'express';
import { ok } from '../../types/index.js';

export const networkRouter = Router();

// POST /api/nova-network/network/connection
// Aangeroepen door de app elke ~5 seconden als connectivity check.
// Cloud response: {"success":true,"code":200,"message":"request success","value":1}
networkRouter.post('/connection', (req: Request, res: Response) => {
  res.json(ok(1));
});