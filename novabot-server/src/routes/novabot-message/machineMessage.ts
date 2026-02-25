import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/database.js';
import { ok, fail } from '../../types/index.js';

export const machineMessageRouter = Router();

// POST /api/novabot-message/machineMessage/saveCutGrassMessage
//
// De maaier stuurt notificatieberichten na een maaisessie.
// Geen JWT auth — maaier identificeert zichzelf via sn in body.
// Opgeslagen in de bestaande robot_messages tabel.
machineMessageRouter.post('/saveCutGrassMessage', (req: Request, res: Response) => {
  const { sn } = req.body as { sn?: string };
  if (!sn) { res.json(fail('sn required', 400)); return; }

  console.log(`[MSG] saveCutGrassMessage: sn=${sn}`);

  // Zoek user_id + equipment_id via SN
  const equip = db.prepare(
    'SELECT equipment_id, user_id FROM equipment WHERE mower_sn = ?'
  ).get(sn) as { equipment_id: string; user_id: string } | undefined;

  const msgId = uuidv4();
  db.prepare(`
    INSERT INTO robot_messages
      (message_id, user_id, equipment_id, robot_msg)
    VALUES (?,?,?,?)
  `).run(
    msgId,
    equip?.user_id ?? 'system',
    equip?.equipment_id ?? sn,
    JSON.stringify(req.body),
  );

  console.log(`[MSG] Bericht opgeslagen: ${msgId} voor ${sn}`);
  res.json(ok(null));
});
