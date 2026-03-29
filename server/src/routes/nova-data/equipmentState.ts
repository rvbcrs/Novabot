import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/database.js';
import { ok, fail } from '../../types/index.js';

export const equipmentStateRouter = Router();

// POST /api/nova-data/equipmentState/saveCutGrassRecord
//
// De maaier stuurt werkrecords na afloop van een maaisessie.
// Geen JWT auth — maaier identificeert zichzelf via sn in body.
// Velden (uit firmware strings): dateTime, workTime, workArea, cutGrassHeight,
// mapNames, startWay, workStatus, scheduleId, week, sn
equipmentStateRouter.post('/saveCutGrassRecord', (req: Request, res: Response) => {
  const srcIp = req.ip || req.socket.remoteAddress || '?';
  const { sn, dateTime, workTime, workArea, cutGrassHeight,
          mapNames, startWay, workStatus, scheduleId, week } = req.body as {
    sn?: string;
    dateTime?: string;
    workTime?: number;
    workArea?: number;
    cutGrassHeight?: number;
    mapNames?: string | string[];
    startWay?: string;
    workStatus?: string;
    scheduleId?: string;
    week?: string | number[];
  };

  // Maaier stuurt soms lege body (multipart/form-data die Express niet parseert).
  // Retourneer success om retry-loop te stoppen.
  if (!sn) {
    console.log(`[STATE] saveCutGrassRecord: lege body van ${srcIp} (geen sn)`);
    res.json(ok(null));
    return;
  }

  console.log(`[STATE] saveCutGrassRecord: sn=${sn} status=${workStatus ?? '-'} time=${workTime ?? '-'}min area=${workArea ?? '-'}m²`);

  // Zoek user_id + equipment_id via SN
  const equip = db.prepare(
    'SELECT equipment_id, user_id FROM equipment WHERE mower_sn = ?'
  ).get(sn) as { equipment_id: string; user_id: string } | undefined;

  const recordId = uuidv4();
  db.prepare(`
    INSERT INTO work_records
      (record_id, user_id, equipment_id, date_time, work_time, work_area_m2,
       cut_grass_height, map_names, start_way, work_status, schedule_id, week,
       work_record_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `).run(
    recordId,
    equip?.user_id ?? 'system',
    equip?.equipment_id ?? sn,
    dateTime ?? null,
    workTime ?? null,
    workArea ?? null,
    cutGrassHeight ?? null,
    typeof mapNames === 'object' ? JSON.stringify(mapNames) : (mapNames ?? null),
    startWay ?? null,
    workStatus ?? null,
    scheduleId ?? null,
    typeof week === 'object' ? JSON.stringify(week) : (week ?? null),
  );

  console.log(`[STATE] Werkrecord opgeslagen: ${recordId} voor ${sn}`);
  res.json(ok(null));
});
