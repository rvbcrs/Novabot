/**
 * HTTP route exposing the recent-events ring for HA / cURL polling.
 *
 *   GET /api/events/:sn?limit=50   →  { events: [MowerEvent, ...] }
 */
import { Router, Request, Response } from 'express';
import { getRecentEvents } from './dispatcher.js';

export const eventsRouter = Router();

eventsRouter.get('/:sn', (req: Request, res: Response) => {
  const { sn } = req.params;
  const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? '50'), 10) || 50));
  res.json({ events: getRecentEvents(sn, limit) });
});
