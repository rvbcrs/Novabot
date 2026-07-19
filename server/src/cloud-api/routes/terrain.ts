/**
 * Terrain-grid uploads van de maaier (terrain_scan.py).
 * POST /api/nova-file-server/terrain/uploadTerrainGrid?sn=<SN>  (TGR1 → TGM1)
 * POST /api/nova-file-server/terrain/uploadObjectGrid?sn=<SN>   (TGO1 → TGMO)
 * Body: raw octet-stream, max 16 MB (OBJ_MAX_ENTRIES 500k × 17 B ≈ 8,5 MB
 * cap-vol object-grid moet nog binnen de limit passen).
 *
 * Live-sessie semantiek (`?session=<id>&final=0|1`):
 * - final=0 met session → schrijf een actieve-sessie-laag naar
 *   `<sn>.active.tgr`/`.tgo` + `<sn>.active.json` ({"session"}). Dezelfde
 *   sessie-id vervangt gewoon dat bestand; de persistente TGM/TGMO-merge en
 *   metadata blijven ongemoeid.
 * - final=1, geen session-param, of een ándere session-id dan de actieve →
 *   eerst een eventuele ANDERE actieve sessie definitief invouwen
 *   (`foldActive`, crash-herstel/sessie-wissel), dan de actieve laag van
 *   déze sessie weggooien en de binnenkomende body definitief mergen in
 *   TGM1/TGMO + metadata bijwerken (sessions_delta 1).
 *   `<sn>.active.json` is GEDEELD tussen terrain en objects (één sessie-id
 *   voor beide lagen) — bij final wordt alleen het eigen actieve bestand
 *   (.tgr of .tgo) verwijderd; de meta zelf pas als het andere type óók al
 *   weg is. Anders verliest een terrain-final=1 het spoor van een nog
 *   actieve .active.tgo (of vice versa): een latere sessie-wissel zou de
 *   orphan dan niet meer detecteren (`activeSession()` vindt geen meta-
 *   bestand meer) en `foldActive` zou hem nooit invouwen — de volgende
 *   non-final upload van dat type overschrijft de orphan dan stilletjes.
 */
import express, { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { ok, fail } from '../../types/index.js';
import {
  parseTgr1, mergeIntoTgm1, tgm1CellCount,
  parseTgo1, mergeIntoTgmo, tgmoCellCount,
} from '../../services/terrainGrid.js';
import { terrainGridRepo } from '../../db/repositories/index.js';
import { runRecognition } from '../../services/terrainRecognition.js';

/** Fire-and-forget triggerpunt voor de objectherkenning-batch (Task 7) —
 *  nooit awaiten, nooit een fout laten doorschieten naar de upload-response. */
function triggerRecognition(sn: string): void {
  void runRecognition(sn).catch((err) => {
    console.warn(`[terrainRecognition] batch faalde voor ${sn}:`, err instanceof Error ? err.message : err);
  });
}

const TERRAIN_DIR = path.resolve(process.env.STORAGE_PATH ?? './storage', 'terrain');

export const terrainRouter = Router();

const activePaths = (sn: string) => ({
  tgr: path.join(TERRAIN_DIR, `${sn}.active.tgr`),
  tgo: path.join(TERRAIN_DIR, `${sn}.active.tgo`),
  meta: path.join(TERRAIN_DIR, `${sn}.active.json`),
});

function activeSession(sn: string): string | null {
  const p = activePaths(sn).meta;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).session ?? null; }
  catch { return null; }
}

/** Vouw een achtergebleven actieve sessie definitief in (crash-herstel of
 *  sessie-wissel zonder final). */
function foldActive(sn: string): void {
  const a = activePaths(sn);
  if (fs.existsSync(a.tgr)) {
    const tgmPath = path.join(TERRAIN_DIR, `${sn}.tgm`);
    const existing = fs.existsSync(tgmPath) ? fs.readFileSync(tgmPath) : null;
    const merged = mergeIntoTgm1(existing, fs.readFileSync(a.tgr));
    fs.writeFileSync(tgmPath, merged);
    terrainGridRepo.upsertMeta({ mower_sn: sn, cell_size: 0.05, cells: tgm1CellCount(merged), sessions_delta: 1 });
  }
  if (fs.existsSync(a.tgo)) {
    const tgmoPath = path.join(TERRAIN_DIR, `${sn}.tgmo`);
    const existing = fs.existsSync(tgmoPath) ? fs.readFileSync(tgmoPath) : null;
    const merged = mergeIntoTgmo(existing, fs.readFileSync(a.tgo));
    fs.writeFileSync(tgmoPath, merged);
    terrainGridRepo.upsertObjMeta({ mower_sn: sn, cells: tgmoCellCount(merged), sessions_delta: 1 });
    triggerRecognition(sn);
  }
  for (const p of Object.values(a)) { try { fs.unlinkSync(p); } catch { /* al weg */ } }
}

interface UploadFormat {
  /** Welk .active.* bestand deze upload gebruikt. */
  activeFile: 'tgr' | 'tgo';
  /** Bestandsextensie van het persistente merge-bestand (.tgm / .tgmo). */
  mergedExt: 'tgm' | 'tgmo';
  parse: (buf: Buffer) => { cellSize: number };
  badMagicMsg: string;
  merge: (existing: Buffer | null, session: Buffer) => Buffer;
  /** Schrijf de merge-metadata (terrain_grids) weg voor de definitieve body. */
  persistFinal: (sn: string, cellSize: number, merged: Buffer) => void;
  logLabel: string;
}

function handleUpload(req: Request, res: Response, fmt: UploadFormat): void {
  const sn = String(req.query.sn ?? '');
  if (!/^LFI[A-Z]\d+$/.test(sn)) { res.status(400).json(fail('sn required', 400)); return; }
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length < 16) { res.status(400).json(fail('empty body', 400)); return; }

  let parsed: { cellSize: number };
  try { parsed = fmt.parse(body); }
  catch { res.status(400).json(fail(fmt.badMagicMsg, 400)); return; }

  fs.mkdirSync(TERRAIN_DIR, { recursive: true });

  const session = req.query.session ? String(req.query.session) : null;
  const isFinal = String(req.query.final ?? '1') === '1';
  const cur = activeSession(sn);
  if (cur && session !== cur) foldActive(sn); // sessie-wissel: oude eerst invouwen

  const paths = activePaths(sn);
  const activeBodyPath = fmt.activeFile === 'tgr' ? paths.tgr : paths.tgo;

  if (session && !isFinal) {
    fs.writeFileSync(activeBodyPath, body);
    fs.writeFileSync(paths.meta, JSON.stringify({ session }));
    res.json(ok(null));
    return;
  }

  // final (of legacy zonder session): de actieve laag van deze sessie is
  // vervangen door de definitieve body — eigen actieve bestand weg, body
  // mergen. `.active.json` is gedeeld met het andere type (terrain/object):
  // pas verwijderen als dat andere type's actieve bestand er ook niet meer
  // is, anders raakt een nog-actieve andere-type-laag zijn sessie-koppeling
  // kwijt en wordt hij bij de volgende non-final upload stilletjes overschreven
  // in plaats van via foldActive ingevouwen.
  try { fs.unlinkSync(activeBodyPath); } catch { /* al weg */ }
  const otherActivePath = fmt.activeFile === 'tgr' ? paths.tgo : paths.tgr;
  if (!fs.existsSync(otherActivePath)) {
    try { fs.unlinkSync(paths.meta); } catch { /* al weg */ }
  }

  const mergedPath = path.join(TERRAIN_DIR, `${sn}.${fmt.mergedExt}`);
  const existing = fs.existsSync(mergedPath) ? fs.readFileSync(mergedPath) : null;
  const merged = fmt.merge(existing, body);
  fs.writeFileSync(mergedPath, merged);
  fmt.persistFinal(sn, parsed.cellSize, merged);
  if (fmt.mergedExt === 'tgmo') triggerRecognition(sn);

  console.log(`[TERRAIN] ${fmt.logLabel} sessie gemerged voor ${sn}`);
  res.json(ok(null));
}

const rawBody = express.raw({ type: 'application/octet-stream', limit: '16mb' });

terrainRouter.post('/uploadTerrainGrid', rawBody, (req: Request, res: Response) => {
  handleUpload(req, res, {
    activeFile: 'tgr',
    mergedExt: 'tgm',
    parse: parseTgr1,
    badMagicMsg: 'invalid TGR1',
    merge: mergeIntoTgm1,
    persistFinal: (sn, cellSize, merged) => {
      terrainGridRepo.upsertMeta({ mower_sn: sn, cell_size: cellSize, cells: tgm1CellCount(merged), sessions_delta: 1 });
    },
    logLabel: 'terrein',
  });
});

terrainRouter.post('/uploadObjectGrid', rawBody, (req: Request, res: Response) => {
  handleUpload(req, res, {
    activeFile: 'tgo',
    mergedExt: 'tgmo',
    parse: parseTgo1,
    badMagicMsg: 'invalid TGO1',
    merge: mergeIntoTgmo,
    persistFinal: (sn, _cellSize, merged) => {
      terrainGridRepo.upsertObjMeta({ mower_sn: sn, cells: tgmoCellCount(merged), sessions_delta: 1 });
    },
    logLabel: 'object',
  });
});

/**
 * Pose-gestempelde RGB-frames voor objectherkenning (spec 2026-07-18).
 * POST /api/nova-file-server/terrain/uploadSessionFrame?sn&session&seq&x&y&yaw
 * Body: raw JPEG, max 2 MB. Opgeslagen als
 * STORAGE_PATH/terrain/frames/<sn>/<session>_<seq>.jpg + sidecar
 * <...>.json ({x,y,yaw}). Rotatie: max 200 frames per (sn,session), max 5
 * sessies aan frames per sn (oudste sessie-map weg).
 */
terrainRouter.post(
  '/uploadSessionFrame',
  express.raw({ type: 'application/octet-stream', limit: '2mb' }),
  (req: Request, res: Response) => {
    const sn = String(req.query.sn ?? '');
    const session = String(req.query.session ?? '');
    const seqRaw = String(req.query.seq ?? '');
    const x = Number(req.query.x), y = Number(req.query.y), yaw = Number(req.query.yaw);
    if (!/^LFI[A-Z]\d+$/.test(sn) || !/^\d+$/.test(session)
        || !/^([1-9]\d{0,2})$/.test(seqRaw) || Number(seqRaw) > 200
        || ![x, y, yaw].every(Number.isFinite)) {
      res.status(400).json(fail('invalid frame params', 400)); return;
    }
    const seq = Number(seqRaw);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) {
      res.status(400).json(fail('not a jpeg', 400)); return;
    }
    const dir = path.join(TERRAIN_DIR, 'frames', sn);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${session}_${seq}.jpg`), body);
    fs.writeFileSync(path.join(dir, `${session}_${seq}.json`), JSON.stringify({ x, y, yaw }));
    // rotatie: max 5 sessies aan frames per maaier (oudste sessie weg).
    // Numeriek sorteren: sessie-id's zijn niet gelijke lengte (bv. "9" vs "10"),
    // lexicografische sort zou "10" vóór "9" evicten (stille data-loss).
    const sessions = [...new Set(fs.readdirSync(dir).map(f => f.split('_')[0]))]
      .sort((a, b) => Number(a) - Number(b));
    for (const old of sessions.slice(0, -5)) {
      for (const f of fs.readdirSync(dir).filter(f => f.startsWith(`${old}_`))) fs.unlinkSync(path.join(dir, f));
    }
    res.json(ok(null));
  },
);
