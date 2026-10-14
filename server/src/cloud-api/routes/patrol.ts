/**
 * Night patrol uploads from the mower (mow_zone_drive.py, patrol mode).
 * POST /api/nova-file-server/patrol/uploadFrame?sn&run&token&seq&x&y&frames&person&animal
 * Body: raw JPEG (max 3 MB) or empty when the camera gave nothing.
 * The token is the one startPatrol issued for this run (it rides in the patrol
 * command). A run the server did not start, or a wrong or expired token, is
 * refused with 403 before anything is written.
 * Design: docs/superpowers/specs/2026-10-14-night-patrol-design.md
 */
import express, { Router, Request, Response } from 'express';
import { ok, fail } from '../../types/index.js';
import { savePatrolFrame } from '../../services/patrolFrames.js';
import { isActivePatrolRun, onPatrolFrame } from '../../services/patrolService.js';

// What the mower writes for x and y ("%.3f") and for the counts (plain integers).
const SIGNED_DECIMAL = /^-?\d+(\.\d+)?$/;
const COUNT = /^\d+$/;

export const patrolRouter = Router();

patrolRouter.post(
  '/uploadFrame',
  express.raw({ type: 'application/octet-stream', limit: '3mb' }),
  (req: Request, res: Response) => {
    const sn = String(req.query.sn ?? '');
    const run = String(req.query.run ?? '');
    const token = String(req.query.token ?? '');
    const seqRaw = String(req.query.seq ?? '');
    const xRaw = String(req.query.x ?? ''), yRaw = String(req.query.y ?? '');
    const countRaw = ['person', 'animal', 'frames'].map(k => String(req.query[k] ?? ''));
    const x = Number(xRaw), y = Number(yRaw);
    const [person, animal, frames] = countRaw.map(Number);
    if (!/^LFI[A-Z]\d+$/.test(sn) || !/^\d{1,20}$/.test(run) || !/^[0-9a-f]{32}$/.test(token)
        || !/^[1-9]\d{0,2}$/.test(seqRaw) || Number(seqRaw) > 200
        || !SIGNED_DECIMAL.test(xRaw) || !SIGNED_DECIMAL.test(yRaw) || ![x, y].every(Number.isFinite)
        || !countRaw.every(v => COUNT.test(v))
        || ![person, animal, frames].every(v => Number.isInteger(v) && v < 1e7)) {
      res.status(400).json(fail('invalid patrol frame params', 400)); return;
    }
    if (!isActivePatrolRun(sn, run, token)) {
      res.status(403).json(fail('unknown or expired patrol run', 403)); return;
    }
    const body = req.body as unknown;
    const jpeg = Buffer.isBuffer(body) && body.length > 0 ? body : null;
    if (jpeg && !(jpeg[0] === 0xff && jpeg[1] === 0xd8)) {
      res.status(400).json(fail('not a jpeg', 400)); return;
    }
    const seq = Number(seqRaw);
    console.log(`[Patrol] ${sn} run=${run} seq=${seq} frames=${frames} person=${person} animal=${animal} photo=${!!jpeg}`);
    let saved = true;
    try {
      savePatrolFrame(sn, run, { seq, x, y, person, animal, frames, image: !!jpeg, ts: Date.now() }, jpeg);
    } catch (e) {
      saved = false;
      console.warn(`[Patrol] ${sn} run=${run} seq=${seq}: frame not stored:`, e);
    }
    onPatrolFrame(sn, { run, seq, person, animal, frames, image: !!jpeg && saved });
    if (!saved) { res.status(500).json(fail('patrol frame not stored', 500)); return; }
    res.json(ok(null));
  },
);
