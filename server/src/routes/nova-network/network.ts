import { Router, Request, Response } from 'express';
import { ok } from '../../types/index.js';

export const networkRouter = Router();

// GET+POST /api/nova-network/network/connection
// Aangeroepen door de app (POST) en maaier firmware (GET) als connectivity check.
// Cloud response: {"success":true,"code":200,"message":"request success","value":1}
// Maaier's net_check_fun stuurt GET. Als dit 3x faalt, reconnect maaier WiFi
// en stopt met HTTP uploads (map ZIP, tracks, etc.).
networkRouter.get('/connection', (_req: Request, res: Response) => {
  res.json(ok(1));
});
networkRouter.post('/connection', (req: Request, res: Response) => {
  res.json(ok(1));
});