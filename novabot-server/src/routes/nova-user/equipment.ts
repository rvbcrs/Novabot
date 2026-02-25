import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/database.js';
import { authMiddleware } from '../../middleware/auth.js';
import { AuthRequest, ok, fail, EquipmentRow } from '../../types/index.js';
import { lookupMac } from '../../mqtt/broker.js';

export const equipmentRouter = Router();

// MQTT credentials die de cloud teruggeeft — charger gebruikt deze om te verbinden met de broker
const MQTT_ACCOUNT  = 'li9hep19';
const MQTT_PASSWORD = 'jzd4wac6';

function snToEquipmentType(sn: string): string {
  // Eerste 5 tekens van SN = equipmentType (bijv. "LFIC1", "LFIN2")
  return sn.slice(0, 5);
}

function snToDeviceType(sn: string): string {
  // LFIC = charger, LFIN = mower
  return sn.startsWith('LFIC') ? 'charger' : 'mower';
}

// Bouw een response-object dat exact overeenkomt met de echte cloud
function rowToCloudDto(r: EquipmentRow, email: string) {
  // mower_sn is altijd de primaire key (ook bij charger-only binding waar charger SN in mower_sn staat)
  const sn = r.mower_sn;
  return {
    equipmentId:       r.id ?? 1,
    email:             email,
    deviceType:        snToDeviceType(sn),
    sn:                sn,
    equipmentCode:     sn,
    equipmentName:     sn,
    equipmentNickName: r.equipment_nick_name ?? '',
    equipmentType:     snToEquipmentType(sn),
    userId:            0,
    sysVersion:        r.charger_version ?? 'v0.3.6',
    period:            '2029-02-22 00:00:00',
    status:            1,
    activationTime:    r.created_at ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
    importTime:        r.created_at ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
    batteryState:      null,
    macAddress:        r.mac_address ?? null,
    chargerAddress:    r.charger_address ? Number(r.charger_address) : (snToDeviceType(sn) === 'charger' ? 718 : null),
    chargerChannel:    r.charger_channel ? Number(r.charger_channel) : (snToDeviceType(sn) === 'charger' ? 16 : null),
    account:           snToDeviceType(sn) === 'charger' ? MQTT_ACCOUNT : null,
    password:          snToDeviceType(sn) === 'charger' ? MQTT_PASSWORD : null,
  };
}

// POST /api/nova-user/equipment/userEquipmentList
// App stuurt: { appUserId, pageSize, pageNo }
equipmentRouter.post('/userEquipmentList', authMiddleware, (req: AuthRequest, res: Response) => {
  const rows = db.prepare('SELECT * FROM equipment WHERE user_id = ?')
    .all(req.userId) as EquipmentRow[];

  const email = req.email ?? '';
  res.json(ok({
    pageNo: 1,
    pageSize: 10,
    totalSize: rows.length,
    totalPage: Math.ceil(rows.length / 10) || 1,
    pageList: rows.map(r => {
      const dto = rowToCloudDto(r, email);
      const mac = lookupMac(dto.sn);
      return {
        ...dto,
        macAddress: mac ?? dto.macAddress,
        videoTutorial: null,
        wifiName: null,
        wifiPassword: null,
        model: 'N1000',
        photoId: null,
        photoType: null,
        photoDownload: null,
        photoTime: null,
      };
    }),
  }));
});

// POST /api/nova-user/equipment/getEquipmentBySN
// App stuurt: { sn, deviceType }
equipmentRouter.post('/getEquipmentBySN', authMiddleware, (req: AuthRequest, res: Response) => {
  const sn = req.body.sn as string | undefined;
  if (!sn) { res.json(fail('sn required', 400)); return; }

  const row = db.prepare('SELECT * FROM equipment WHERE mower_sn = ? OR charger_sn = ?')
    .get(sn, sn) as EquipmentRow | undefined;

  const mac = lookupMac(sn);
  if (!mac) {
    console.log(`[equipment] getEquipmentBySN: MAC nog niet bekend voor sn=${sn} — wacht op MQTT CONNECT van het apparaat`);
  }

  if (row) {
    const dto = rowToCloudDto(row, req.email ?? '');
    res.json(ok({ ...dto, macAddress: mac ?? dto.macAddress }));
  } else {
    // Nieuw apparaat — geef cloud-achtig response terug zodat de app door kan naar BLE provisioning
    const knownLora = db.prepare(`
      SELECT charger_address, charger_channel FROM equipment_lora_cache WHERE sn = ?
    `).get(sn) as { charger_address: string; charger_channel: string } | undefined;

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    res.json(ok({
      equipmentId:       0,
      email:             req.email ?? '',
      deviceType:        snToDeviceType(sn),
      sn:                sn,
      equipmentCode:     sn,
      equipmentName:     sn,
      equipmentType:     snToEquipmentType(sn),
      userId:            0,
      sysVersion:        'v0.3.6',
      period:            '2029-02-22 00:00:00',
      status:            1,
      activationTime:    now,
      importTime:        now,
      batteryState:      null,
      macAddress:        mac ?? null,
      chargerAddress:    knownLora?.charger_address ? Number(knownLora.charger_address) : 718,
      chargerChannel:    knownLora?.charger_channel ? Number(knownLora.charger_channel) : 16,
      account:           MQTT_ACCOUNT,
      password:          MQTT_PASSWORD,
    }));
  }
});

// POST /api/nova-user/equipment/bindingEquipment
equipmentRouter.post('/bindingEquipment', authMiddleware, (req: AuthRequest, res: Response) => {
  const body = req.body as Record<string, string | undefined>;
  const mowerSn        = body.mowerSn;
  const chargerSn      = body.chargerSn;
  const equipmentTypeH = body.equipmentTypeH;
  // App stuurt 'userCustomDeviceName'; accepteer ook legacy 'equipmentNickName'
  const nickName       = body.userCustomDeviceName ?? body.equipmentNickName ?? null;
  // chargerChannel wordt gestuurd als het toegewezen LoRa kanaal (uit set_lora_info_respond.value)
  const chargerChannel = body.chargerChannel ?? null;

  // Accept mowerSn, legacy 'sn', or fall back to chargerSn (charger-station-first flow)
  const sn = mowerSn ?? body.sn ?? chargerSn;
  if (!sn) { res.json(fail('mowerSn or chargerSn required', 400)); return; }

  // Haal chargerAddress op uit lora_cache (pre-seeded of eerder gebind)
  const loraCache = db.prepare(
    'SELECT charger_address FROM equipment_lora_cache WHERE sn = ?'
  ).get(sn) as { charger_address: string | null } | undefined;
  const chargerAddress = loraCache?.charger_address ?? null;

  // Check if already bound — by mower_sn OR charger_sn
  const existing = db.prepare(
    'SELECT equipment_id, user_id FROM equipment WHERE mower_sn = ? OR charger_sn = ?'
  ).get(sn, sn) as { equipment_id: string; user_id: string } | undefined;

  if (existing) {
    if (existing.user_id === req.userId) {
      // Same user re-binding — update channel/nickname en return bestaand id
      console.log(`[equipment] bindingEquipment: re-bind sn=${sn} by same user — updating`);
      db.prepare(`
        UPDATE equipment
        SET charger_channel     = COALESCE(?, charger_channel),
            charger_address     = COALESCE(?, charger_address),
            equipment_nick_name = COALESCE(?, equipment_nick_name)
        WHERE equipment_id = ?
      `).run(chargerChannel, chargerAddress, nickName, existing.equipment_id);
      res.json(ok());
    } else {
      res.json(fail('The device has already been bound.', 400));
    }
    return;
  }

  const equipmentId = uuidv4();
  // If only chargerSn was supplied (charger-station-first flow), store it as mower_sn
  // so the rest of the codebase can look up equipment by any single SN.
  db.prepare(`
    INSERT INTO equipment
      (equipment_id, user_id, mower_sn, charger_sn, equipment_type_h, equipment_nick_name,
       charger_channel, charger_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(equipmentId, req.userId, sn, chargerSn !== sn ? (chargerSn ?? null) : null,
         equipmentTypeH ?? null, nickName, chargerChannel, chargerAddress);

  console.log(`[equipment] bindingEquipment: sn=${sn} chargerSn=${chargerSn ?? '-'} channel=${chargerChannel} addr=${chargerAddress} equipmentId=${equipmentId}`);
  res.json(ok());
});

// POST /api/nova-user/equipment/unboundEquipment
equipmentRouter.post('/unboundEquipment', authMiddleware, (req: AuthRequest, res: Response) => {
  // App stuurt {sn, appUserId} — niet equipmentId zoals eerder aangenomen
  const { sn, equipmentId } = req.body as { sn?: string; equipmentId?: number };
  if (!sn && equipmentId == null) { res.json(fail('sn or equipmentId required', 400)); return; }

  // Zoek equipment op basis van SN (primair) of equipmentId (fallback)
  const equip = sn
    ? db.prepare('SELECT id, mower_sn, charger_sn, charger_address, charger_channel FROM equipment WHERE (mower_sn = ? OR charger_sn = ?) AND user_id = ?')
        .get(sn, sn, req.userId) as { id: number; mower_sn: string; charger_sn: string | null; charger_address: string | null; charger_channel: string | null } | undefined
    : db.prepare('SELECT id, mower_sn, charger_sn, charger_address, charger_channel FROM equipment WHERE id = ? AND user_id = ?')
        .get(equipmentId, req.userId) as { id: number; mower_sn: string; charger_sn: string | null; charger_address: string | null; charger_channel: string | null } | undefined;

  if (!equip) { res.json(ok()); return; }

  // Cache LoRa-parameters vóór DELETE zodat ze beschikbaar blijven bij opnieuw toevoegen
  if (equip.charger_address || equip.charger_channel) {
    const cacheSn = equip.charger_sn ?? equip.mower_sn;
    db.prepare(`
      INSERT INTO equipment_lora_cache (sn, charger_address, charger_channel)
      VALUES (?, ?, ?)
      ON CONFLICT(sn) DO UPDATE SET
        charger_address = COALESCE(excluded.charger_address, charger_address),
        charger_channel = COALESCE(excluded.charger_channel, charger_channel)
    `).run(cacheSn, equip.charger_address, equip.charger_channel);
  }

  db.prepare('DELETE FROM equipment WHERE id = ? AND user_id = ?')
    .run(equip.id, req.userId);
  console.log(`[equipment] unboundEquipment: sn=${sn ?? '?'} id=${equip.id} deleted`);
  res.json(ok());
});

// POST /api/nova-user/equipment/updateEquipmentNickName
equipmentRouter.post('/updateEquipmentNickName', authMiddleware, (req: AuthRequest, res: Response) => {
  const { equipmentId, equipmentNickName } = req.body as {
    equipmentId?: number; equipmentNickName?: string;
  };
  if (equipmentId == null) { res.json(fail('equipmentId required', 400)); return; }

  db.prepare('UPDATE equipment SET equipment_nick_name = ? WHERE id = ? AND user_id = ?')
    .run(equipmentNickName ?? null, equipmentId, req.userId);
  res.json(ok());
});

// POST /api/nova-user/equipment/updateEquipmentVersion
equipmentRouter.post('/updateEquipmentVersion', authMiddleware, (req: AuthRequest, res: Response) => {
  const { equipmentId, mowerVersion, chargerVersion } = req.body as {
    equipmentId?: number; mowerVersion?: string; chargerVersion?: string;
  };
  if (equipmentId == null) { res.json(fail('equipmentId required', 400)); return; }

  db.prepare(`
    UPDATE equipment
    SET mower_version = COALESCE(?, mower_version),
        charger_version = COALESCE(?, charger_version)
    WHERE id = ? AND user_id = ?
  `).run(mowerVersion ?? null, chargerVersion ?? null, equipmentId, req.userId);
  res.json(ok());
});

// ── Maaier firmware endpoint (geen JWT auth) ──────────────────────────────────

// POST /api/nova-user/equipment/machineReset
// De maaier bevestigt een factory reset. Simpel acknowledgment.
equipmentRouter.post('/machineReset', (req: Request, res: Response) => {
  const { sn } = req.body as { sn?: string };
  console.log(`[equipment] machineReset: sn=${sn ?? 'unknown'}`);
  res.json(ok(null));
});
