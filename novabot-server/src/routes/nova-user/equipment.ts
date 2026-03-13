import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/database.js';
import { authMiddleware } from '../../middleware/auth.js';
import { AuthRequest, ok, fail, EquipmentRow } from '../../types/index.js';
import { lookupMac, isDeviceOnline, forceDisconnectDevice } from '../../mqtt/broker.js';
import { getBleMacForType } from '../../ble/bleLogger.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { forwardToDashboard } from '../../dashboard/socketHandler.js';

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
  const deviceType = snToDeviceType(sn);
  const isCharger = deviceType === 'charger';
  // Cloud retourneert mower firmware voor mowers (v6.0.0/v5.7.1), charger firmware voor chargers (v0.3.6)
  const sysVersion = isCharger
    ? (r.charger_version ?? 'v0.3.6')
    : (r.mower_version ?? 'v5.7.1');
  return {
    equipmentId:       r.id ?? 1,
    email:             email,
    deviceType:        deviceType,
    sn:                sn,
    equipmentCode:     sn,
    equipmentName:     sn,
    equipmentNickName: r.equipment_nick_name ?? '',
    equipmentType:     snToEquipmentType(sn),
    userId:            0,
    sysVersion:        sysVersion,
    period:            isCharger ? '2029-02-22 00:00:00' : '2026-11-16 00:00:00',
    status:            1,
    activationTime:    r.created_at ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
    importTime:        r.created_at ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
    batteryState:      null,
    macAddress:        r.mac_address ?? null,
    chargerAddress:    isCharger ? (r.charger_address ? Number(r.charger_address) : 718) : null,
    chargerChannel:    isCharger ? (r.charger_channel ? Number(r.charger_channel) : 16) : null,
    account:           isCharger ? MQTT_ACCOUNT : null,
    password:          isCharger ? MQTT_PASSWORD : null,
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
      // Cloud userEquipmentList bevat GEEN userId per entry (anders dan getEquipmentBySN).
      // Verwijder userId uit de spread om exact te matchen.
      const { userId: _userId, ...dtoWithoutUserId } = dto;
      const isCharger = dto.deviceType === 'charger';
      return {
        ...dtoWithoutUserId,
        macAddress: mac ?? dto.macAddress,
        videoTutorial: null,
        wifiName: r.wifi_name ?? null,
        wifiPassword: r.wifi_password ?? null,
        model: isCharger ? 'N1000' : 'N2000',
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

  // MAC lookup volgorde: MQTT CONNECT → DB equipment tabel → BLE scanner
  let mac = lookupMac(sn);
  if (!mac) {
    // Probeer BLE scanner: als het apparaat in de buurt is en adverteert
    const bleType = snToDeviceType(sn) === 'charger' ? 'charger' as const : 'novabot' as const;
    const bleMac = getBleMacForType(bleType);
    if (bleMac) {
      mac = bleMac;
      console.log(`[equipment] getEquipmentBySN: sn=${sn} MAC gevonden via BLE scanner: ${bleMac}`);
    } else {
      console.log(`[equipment] getEquipmentBySN: MAC nog niet bekend voor sn=${sn} — wacht op MQTT CONNECT of BLE advertisement`);
    }
  }

  // Mower MAC strategie:
  // - Online + gebonden maaier: macAddress=null → skip BLE provisioning
  //   Voorkomt dat BLE provisioning de werkende WiFi-config overschrijft
  // - Online + unbound maaier: macAddress=echt MAC → BLE provisioning NODIG
  //   User wil re-provisioneren (bijv. na unbind of cloud→local switch)
  // - Offline maaier: macAddress=echt MAC → BLE provisioning
  // Chargers: altijd echt MAC retourneren (ESP32 BLE provisioning is stabiel)
  const isMower = snToDeviceType(sn) === 'mower';
  const isBound = row?.user_id != null;
  const skipBle = isMower && isDeviceOnline(sn) && isBound;
  if (skipBle) {
    console.log(`[equipment] getEquipmentBySN: mower ${sn} is ONLINE + BOUND → macAddress=null (skip BLE provisioning)`);
  } else if (isMower && isDeviceOnline(sn)) {
    // Maaier is online maar unbound → BLE re-provisioning gaat starten.
    // Force-disconnect de maaier zodat mqtt_node in een schone staat komt.
    // Zonder dit raakt mqtt_node "stuck" na de WiFi restart door BLE set_cfg_info
    // en reconnect hij nooit (bekende firmware bug).
    forceDisconnectDevice(sn);
    console.log(`[equipment] getEquipmentBySN: mower ${sn} is ONLINE but UNBOUND → force-disconnect + macAddress=${mac ?? 'from-db'} (allow BLE re-provisioning)`);
  } else if (isMower) {
    console.log(`[equipment] getEquipmentBySN: mower ${sn} is OFFLINE → macAddress=${mac ?? 'from-db'} (allow BLE provisioning)`);
  }

  // Sla gevonden MAC persistent op in equipment tabel (zodat het bewaard blijft bij DB wipe van device_registry)
  if (row && mac && !row.mac_address) {
    db.prepare('UPDATE equipment SET mac_address = ? WHERE mower_sn = ? OR charger_sn = ?')
      .run(mac, sn, sn);
  }

  // Haal numeriek user ID op (cloud retourneert dit als integer, bijv. 86).
  // Cloud gedrag: userId=0 als apparaat unbound, userId=<owner_id> als gebonden.
  // App checkt: als userId > 0 EN niet eigen ID → "already bound" toast.
  const numericUserId = (db.prepare('SELECT id FROM users WHERE app_user_id = ?')
    .get(req.userId) as { id: number } | undefined)?.id ?? 0;

  if (row) {
    // Cloud retourneert email="" in getEquipmentBySN (niet het echte email adres)
    const dto = rowToCloudDto(row, '');

    // IDOR bescherming: als het apparaat gebonden is aan een ANDERE user,
    // retourneer minimale info (geen MQTT credentials, MAC, WiFi data).
    // De cloud heeft deze IDOR check NIET — wij wel.
    const isOwnDevice = !row.user_id || row.user_id === req.userId;
    const isBoundToOther = row.user_id != null && row.user_id !== req.userId;

    // userId logica:
    // - unbound: userId=0 → app doet BLE provisioning
    // - eigen apparaat: userId=numericUserId → app herkent eigen apparaat
    // - ander's apparaat: userId=999 (niet 0, niet eigen ID) → app toont "already bound"
    const userId = !row.user_id ? 0 : isOwnDevice ? numericUserId : 999;

    if (isBoundToOther) {
      // Sanitized response: geen credentials, geen MAC, geen LoRa params
      console.log(`[equipment] getEquipmentBySN: sn=${sn} IDOR blocked — bound to other user`);
      res.json(ok({
        equipmentId: dto.equipmentId,
        deviceType:  dto.deviceType,
        sn:          dto.sn,
        equipmentCode: dto.equipmentCode,
        equipmentName: dto.equipmentName,
        equipmentType: dto.equipmentType,
        userId:      userId,
        sysVersion:  dto.sysVersion,
        status:      dto.status,
        // Geen gevoelige velden: account, password, macAddress, chargerAddress, chargerChannel
        macAddress:     null,
        account:        null,
        password:       null,
        chargerAddress: null,
        chargerChannel: null,
      }));
      return;
    }

    console.log(`[equipment] getEquipmentBySN: sn=${sn} row.user_id=${row.user_id ?? 'NULL'} req.userId=${req.userId} → userId=${userId}`);
    res.json(ok({ ...dto, userId, macAddress: skipBle ? null : (mac ?? dto.macAddress) }));
  } else {
    // Geen equipment record gevonden.
    // De echte cloud heeft ALTIJD een record (factory-geïmporteerd). Als wij equipmentId=0
    // retourneren, denkt de app dat het een nieuw apparaat is en triggert volledige BLE
    // provisioning — die de WiFi-configuratie van het apparaat overschrijft!
    //
    // Oplossing: als het apparaat bekend is (via MQTT of device_registry), maak automatisch
    // een equipment record aan zodat de app equipmentId>0 ziet en BLE overslaat.
    const knownDevice = db.prepare(
      'SELECT sn, mac_address FROM device_registry WHERE sn = ?'
    ).get(sn) as { sn: string; mac_address: string | null } | undefined;
    const deviceIsKnown = knownDevice || isDeviceOnline(sn) || mac;

    if (deviceIsKnown) {
      // Auto-create equipment record — spiegelt cloud factory-import gedrag
      const equipmentId = uuidv4();
      const knownLora = db.prepare(
        'SELECT charger_address, charger_channel FROM equipment_lora_cache WHERE sn = ?'
      ).get(sn) as { charger_address: string; charger_channel: string } | undefined;

      // Als het apparaat online is (MQTT verbonden), bind het direct aan de gebruiker.
      // Zonder user_id verschijnt het niet in userEquipmentList en kan de app niet binden
      // omdat skipBle=true macAddress=null retourneert → BLE scan mislukt → bindingEquipment
      // wordt nooit aangeroepen → user_id blijft NULL.
      const autoBindUserId = skipBle ? req.userId : null;

      db.prepare(`
        INSERT INTO equipment
          (equipment_id, user_id, mower_sn, charger_sn, equipment_type_h, mac_address,
           charger_address, charger_channel)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(
        equipmentId, autoBindUserId, sn, snToEquipmentType(sn),
        mac ?? knownDevice?.mac_address ?? null,
        knownLora?.charger_address ?? null,
        knownLora?.charger_channel ?? null
      );

      console.log(`[equipment] getEquipmentBySN: auto-created record for known device sn=${sn} equipmentId=${equipmentId} autoBound=${!!autoBindUserId}`);

      // Haal het net aangemaakte record op (voor correcte id/created_at)
      const newRow = db.prepare('SELECT * FROM equipment WHERE equipment_id = ?')
        .get(equipmentId) as EquipmentRow;
      const dto = rowToCloudDto(newRow, req.email ?? '');
      // Als auto-bound: userId=numericUserId zodat app het apparaat herkent als eigen
      // Als niet auto-bound: userId=0 → app doet BLE provisioning
      const autoUserId = autoBindUserId ? numericUserId : 0;
      res.json(ok({ ...dto, userId: autoUserId, macAddress: skipBle ? null : (mac ?? dto.macAddress) }));
    } else {
      // Volledig onbekend apparaat — geef equipmentId=0 zodat app BLE provisioning doet
      console.log(`[equipment] getEquipmentBySN: unknown device sn=${sn} — returning equipmentId=0 for BLE provisioning`);
      const knownLora = db.prepare(`
        SELECT charger_address, charger_channel FROM equipment_lora_cache WHERE sn = ?
      `).get(sn) as { charger_address: string; charger_channel: string } | undefined;

      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const isCharger = snToDeviceType(sn) === 'charger';
      res.json(ok({
        equipmentId:       0,
        email:             req.email ?? '',
        deviceType:        snToDeviceType(sn),
        sn:                sn,
        equipmentCode:     sn,
        equipmentName:     sn,
        equipmentType:     snToEquipmentType(sn),
        userId:            0,
        sysVersion:        isCharger ? 'v0.3.6' : 'v5.7.1',
        period:            isCharger ? '2029-02-22 00:00:00' : '2026-11-16 00:00:00',
        status:            1,
        activationTime:    now,
        importTime:        now,
        batteryState:      null,
        macAddress:        skipBle ? null : (mac ?? null),
        chargerAddress:    isCharger ? (knownLora?.charger_address ? Number(knownLora.charger_address) : 718) : null,
        chargerChannel:    isCharger ? (knownLora?.charger_channel ? Number(knownLora.charger_channel) : 16) : null,
        account:           isCharger ? MQTT_ACCOUNT : null,
        password:          isCharger ? MQTT_PASSWORD : null,
      }));
    }
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
    // Lokale server: sta altijd rebinding toe (ongeacht vorige user_id).
    // Cloud blokkeert dit voor multi-user, maar wij zijn single-household.
    if (existing.user_id && existing.user_id !== req.userId) {
      console.log(`[equipment] bindingEquipment: overschrijf binding sn=${sn} user_id=${existing.user_id} → ${req.userId}`);
    } else {
      console.log(`[equipment] bindingEquipment: re-bind sn=${sn} user_id=${existing.user_id ?? 'NULL'} → ${req.userId}`);
    }
    db.prepare(`
      UPDATE equipment
      SET user_id              = ?,
          charger_channel     = COALESCE(?, charger_channel),
          charger_address     = COALESCE(?, charger_address),
          equipment_nick_name = COALESCE(?, equipment_nick_name)
      WHERE equipment_id = ?
    `).run(req.userId, chargerChannel, chargerAddress, nickName, existing.equipment_id);
    res.json(ok(1));  // Cloud retourneert value:1 bij success
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
  res.json(ok(1));  // Cloud retourneert value:1 bij success
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

  // Niet verwijderen — alleen user_id op NULL zetten (zoals de cloud doet).
  // De cloud verwijdert apparaten nooit uit hun database (geïmporteerd bij fabriek).
  // Als we DELETE doen, retourneert getEquipmentBySN een "nieuw apparaat" met equipmentId=0,
  // waardoor de app volledige BLE provisioning triggert die de maaier's WiFi reset.
  db.prepare('UPDATE equipment SET user_id = NULL WHERE id = ?')
    .run(equip.id);
  console.log(`[equipment] unboundEquipment: sn=${sn ?? '?'} id=${equip.id} unbound (user_id=NULL)`);
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
  const { equipmentId, sn, chargerSn, mowerVersion, chargerVersion } = req.body as {
    equipmentId?: number; sn?: string; chargerSn?: string;
    mowerVersion?: string; chargerVersion?: string;
  };

  // App stuurt sn + chargerSn i.p.v. equipmentId — accepteer beide
  if (equipmentId != null) {
    db.prepare(`
      UPDATE equipment
      SET mower_version = COALESCE(?, mower_version),
          charger_version = COALESCE(?, charger_version)
      WHERE id = ? AND user_id = ?
    `).run(mowerVersion ?? null, chargerVersion ?? null, equipmentId, req.userId);
  } else if (sn) {
    // IDOR bescherming: voeg user_id check toe zodat je niet andermans apparaat kunt updaten
    db.prepare(`
      UPDATE equipment
      SET mower_version = COALESCE(?, mower_version),
          charger_version = COALESCE(?, charger_version)
      WHERE mower_sn = ? AND user_id = ?
    `).run(mowerVersion ?? null, chargerVersion ?? null, sn, req.userId);
  }

  // Inject versies in sensor cache + push naar dashboard via Socket.io
  if (sn && mowerVersion) {
    if (!deviceCache.has(sn)) deviceCache.set(sn, new Map());
    const cache = deviceCache.get(sn)!;
    if (cache.get('sw_version') !== mowerVersion) {
      cache.set('sw_version', mowerVersion);
      forwardToDashboard(sn, new Map([['sw_version', mowerVersion]]));
    }
  }
  if (chargerSn && chargerVersion) {
    if (!deviceCache.has(chargerSn)) deviceCache.set(chargerSn, new Map());
    const cache = deviceCache.get(chargerSn)!;
    if (cache.get('version') !== chargerVersion) {
      cache.set('version', chargerVersion);
      forwardToDashboard(chargerSn, new Map([['version', chargerVersion]]));
    }
  }

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
