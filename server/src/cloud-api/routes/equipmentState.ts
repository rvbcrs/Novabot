import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { equipmentRepo, messageRepo } from '../../db/repositories/index.js';
import { ok } from '../../types/index.js';

export const equipmentStateRouter = Router();

// Mower POSTs work records as multipart/form-data — Express's bodyParser
// only handles JSON / urlencoded, so the request body lands empty without
// this middleware. multer.none() parses text fields without storing files
// (mower never attaches one).
const upload = multer();

// POST /api/nova-data/equipmentState/saveCutGrassRecord
//
// De maaier stuurt werkrecords na afloop van een maaisessie.
// Geen JWT auth — maaier identificeert zichzelf via sn in body.
// Velden (uit firmware strings): dateTime, workTime, workArea, cutGrassHeight,
// mapNames, startWay, workStatus, scheduleId, week, sn
// multipart fields arrive as strings — coerce to number where the schema
// expects one, leaving null when absent or unparseable.
function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// mapNames + week may arrive as JSON-encoded strings (multipart) or as
// arrays (JSON body). Always store the JSON representation.
function toJsonField(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return null; }
}

equipmentStateRouter.post('/saveCutGrassRecord', upload.none(), (req: Request, res: Response) => {
  const srcIp = req.ip || req.socket.remoteAddress || '?';
  const body = req.body as Record<string, unknown>;
  const sn = typeof body.sn === 'string' ? body.sn : undefined;

  if (!sn) {
    console.log(`[STATE] saveCutGrassRecord: lege body van ${srcIp} (keys=${Object.keys(body).join(',') || '∅'})`);
    res.json(ok(null));
    return;
  }

  const dateTime = typeof body.dateTime === 'string' ? body.dateTime : null;
  const workTime = toNum(body.workTime);
  const workArea = toNum(body.workArea);
  const cutGrassHeight = toNum(body.cutGrassHeight);
  const mapNames = toJsonField(body.mapNames);
  const startWay = typeof body.startWay === 'string' ? body.startWay : null;
  const workStatus = typeof body.workStatus === 'string' ? body.workStatus : null;
  const scheduleId = typeof body.scheduleId === 'string' ? body.scheduleId : null;
  const week = toJsonField(body.week);

  console.log(`[STATE] saveCutGrassRecord: sn=${sn} status=${workStatus ?? '-'} time=${workTime ?? '-'}min area=${workArea ?? '-'}m²`);

  // Zoek user_id + equipment_id via SN
  const equip = equipmentRepo.findByMowerSn(sn);

  const recordId = uuidv4();
  messageRepo.createWorkRecordFull(
    recordId,
    equip?.user_id ?? 'system',
    equip?.equipment_id ?? sn,
    dateTime,
    workTime,
    workArea,
    cutGrassHeight,
    mapNames,
    startWay,
    workStatus,
    scheduleId,
    week,
  );

  console.log(`[STATE] Werkrecord opgeslagen: ${recordId} voor ${sn}`);
  res.json(ok(null));
});
