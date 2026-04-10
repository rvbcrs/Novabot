import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { equipmentRepo, messageRepo } from '../../db/repositories/index.js';
import { ok, fail } from '../../types/index.js';

export const machineMessageRouter = Router();

// POST /api/novabot-message/machineMessage/saveCutGrassMessage
//
// De maaier stuurt notificatieberichten na een maaisessie.
// Geen JWT auth — maaier identificeert zichzelf via sn in body.
// Opgeslagen in de bestaande robot_messages tabel.
machineMessageRouter.post('/saveCutGrassMessage', (req: Request, res: Response) => {
  const { sn } = req.body as { sn?: string };
  // Maaier stuurt soms multipart/form-data die Express niet parseert → lege body.
  // Retourneer success om retry-loop te stoppen.
  if (!sn) { res.json(ok(null)); return; }

  console.log(`[MSG] saveCutGrassMessage: sn=${sn}`);

  // Zoek user_id + equipment_id via SN
  const equip = equipmentRepo.findByMowerSn(sn);

  const msgId = uuidv4();
  messageRepo.createMessageRaw(
    msgId,
    equip?.user_id ?? 'system',
    equip?.equipment_id ?? sn,
    JSON.stringify(req.body),
  );

  console.log(`[MSG] Bericht opgeslagen: ${msgId} voor ${sn}`);
  res.json(ok(null));
});
