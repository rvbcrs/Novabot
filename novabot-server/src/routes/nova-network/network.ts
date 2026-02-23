import { Router, Request, Response } from 'express';
import { ok } from '../../types/index.js';

export const networkRouter = Router();

// POST /api/nova-network/network/connection
// Aangeroepen door charger firmware (HTTP, geen HTTPS) elke ~5 seconden.
// Dient als heartbeat / netwerk-statusrapport van het apparaat naar de server.
networkRouter.post('/connection', (req: Request, res: Response) => {
  console.log(`[nova-network] connection payload: ${JSON.stringify(req.body)}`);
  res.json(ok({ connected: true }));
});