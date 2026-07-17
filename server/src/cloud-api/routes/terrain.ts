/**
 * Terrain-grid uploads van de maaier (terrain_scan.py).
 * POST /api/nova-file-server/terrain/uploadTerrainGrid?sn=<SN>
 * Body: raw TGR1 (application/octet-stream, max 8 MB).
 * Merget direct in STORAGE_PATH/terrain/<sn>.tgm en werkt terrain_grids bij.
 */
import express, { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { ok, fail } from '../../types/index.js';
import { parseTgr1, mergeIntoTgm1, tgm1CellCount } from '../../services/terrainGrid.js';
import { terrainGridRepo } from '../../db/repositories/index.js';

const TERRAIN_DIR = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain');

export const terrainRouter = Router();

terrainRouter.post(
  '/uploadTerrainGrid',
  express.raw({ type: 'application/octet-stream', limit: '8mb' }),
  (req: Request, res: Response) => {
    const sn = String(req.query.sn ?? '');
    if (!/^LFI[A-Z]\d+$/.test(sn)) { res.status(400).json(fail('sn required', 400)); return; }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 16) { res.status(400).json(fail('empty body', 400)); return; }

    let session;
    try { session = parseTgr1(body); }
    catch { res.status(400).json(fail('invalid TGR1', 400)); return; }

    fs.mkdirSync(TERRAIN_DIR, { recursive: true });
    const tgmPath = path.join(TERRAIN_DIR, `${sn}.tgm`);
    const existing = fs.existsSync(tgmPath) ? fs.readFileSync(tgmPath) : null;
    const merged = mergeIntoTgm1(existing, body);
    fs.writeFileSync(tgmPath, merged);

    terrainGridRepo.upsertMeta({
      mower_sn: sn,
      cell_size: session.cellSize,
      cells: tgm1CellCount(merged),
      sessions_delta: 1,
    });
    console.log(`[TERRAIN] sessie gemerged voor ${sn}: ${session.cells.size} sessie-cellen → ${tgm1CellCount(merged)} totaal`);
    res.json(ok(null));
  },
);
