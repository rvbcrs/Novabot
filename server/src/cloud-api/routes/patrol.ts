/**
 * Night patrol uploads from the mower (mow_zone_drive.py, patrol mode).
 * POST /api/nova-file-server/patrol/uploadFrame?sn&run&seq&x&y&frames&person&animal
 * Body: raw JPEG (max 3 MB) or empty when the camera gave nothing.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import express, { Router, Request, Response } from 'express';
import { ok, fail } from '../../types/index.js';
import { savePatrolFrame } from '../../services/patrolFrames.js';
import { onPatrolFrame } from '../../services/patrolService.js';

export const patrolRouter = Router();

patrolRouter.post(
  '/uploadFrame',
  express.raw({ type: 'application/octet-stream', limit: '3mb' }),
  (req: Request, res: Response) => {
    const sn = String(req.query.sn ?? '');
    const run = String(req.query.run ?? '');
    const seqRaw = String(req.query.seq ?? '');
    const x = Number(req.query.x), y = Number(req.query.y);
    const [person, animal, frames] = ['person', 'animal', 'frames'].map(k => Number(req.query[k]));
    if (!/^LFI[A-Z]\d+$/.test(sn) || !/^\d{1,20}$/.test(run)
        || !/^[1-9]\d{0,2}$/.test(seqRaw) || Number(seqRaw) > 200
        || ![x, y].every(Number.isFinite)
        || ![person, animal, frames].every(v => Number.isInteger(v) && v >= 0 && v < 1e7)) {
      res.status(400).json(fail('invalid patrol frame params', 400)); return;
    }
    const body = req.body as unknown;
    const jpeg = Buffer.isBuffer(body) && body.length > 0 ? body : null;
    if (jpeg && !(jpeg[0] === 0xff && jpeg[1] === 0xd8)) {
      res.status(400).json(fail('not a jpeg', 400)); return;
    }
    const seq = Number(seqRaw);
    savePatrolFrame(sn, run, { seq, x, y, person, animal, frames, image: !!jpeg, ts: Date.now() }, jpeg);
    onPatrolFrame(sn, { run, seq, person, animal, frames, image: !!jpeg });
    res.json(ok(null));
  },
);
