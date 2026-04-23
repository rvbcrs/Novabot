import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { equipmentRepo, userRepo, deviceRepo } from '../../db/repositories/index.js';
import { authMiddleware } from '../../middleware/auth.js';
import { AuthRequest, ok, fail, EquipmentRow } from '../../types/index.js';
import { lookupMac, isDeviceOnline, forceDisconnectDevice } from '../../mqtt/broker.js';
import { db } from '../../db/database.js';
import { getBleMacForType } from '../../ble/bleLogger.js';
import { deviceCache } from '../../mqtt/sensorData.js';
import { forwardToDashboard } from '../../dashboard/socketHandler.js';
// rowToCloudDto lives in the cloud-api serializer as of 2026-04-23 (Task 9).
// Behaviour is identical — same defaults, same conditionals, same sentinels.
// The function was previously defined locally in this file; the local copy has
// been removed in favour of the shared, frozen serializer implementation.
import { rowToCloudDto } from '../serializers/equipmentDto.js';

export const equipmentRouter = Router();

// MQTT credentials die de cloud teruggeeft — charger gebruikt deze om te
// verbinden met de broker. Nog steeds lokaal nodig voor de "unknown device"
// fallback-branch in getEquipmentBySN (zie onder). De serializer heeft z'n
// eigen private kopie voor row-to-DTO conversie.
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

// POST /api/nova-user/equipment/userEquipmentList
// App stuurt: { appUserId, pageSize, pageNo }
equipmentRouter.post('/userEquipmentList', authMiddleware, (req: AuthRequest, res: Response) => {
  let rows = equipmentRepo.findByUserId(req.userId!) as EquipmentRow[];

  // Multi-device filter: als er een is_active device is, toon alleen die.
  // Als er maar 1 mower is, toon altijd (geen filter nodig).
  const mowerRows = rows.filter(r => r.mower_sn?.startsWith('LFIN'));
  if (mowerRows.length > 1) {
    const activeRows = rows.filter(r => (r as any).is_active);
    if (activeRows.length > 0) {
      rows = activeRows;
    }
  }

  const email = req.email ?? '';
  // Tel het werkelijke aantal entries (1 per device, niet per equipment row)
  const deviceCount = rows.reduce((n, r) => {
    let c = 0;
    if (r.mower_sn?.startsWith('LFIN')) c++;
    if (r.charger_sn?.startsWith('LFIC')) c++;
    return n + (c || 1);
  }, 0);
  res.json(ok({
    pageNo: 1,
    pageSize: 10,
    totalSize: deviceCount,
    totalPage: Math.ceil(deviceCount / 10) || 1,
    pageList: rows.flatMap(r => {
      // Cloud retourneert aparte entries per device — als een row zowel mower als charger heeft, maak 2 entries
      const entries: EquipmentRow[] = [];

      // Mower entry (als mower_sn een echte mower is)
      if (r.mower_sn?.startsWith('LFIN')) {
        entries.push(r);
      }

      // Charger entry (als charger_sn een echte charger is)
      if (r.charger_sn?.startsWith('LFIC')) {
        // Maak een kopie met charger SN als primaire SN
        entries.push({ ...r, mower_sn: r.charger_sn } as EquipmentRow);
      }

      // Fallback: als geen van beide, gebruik de row as-is
      if (entries.length === 0) entries.push(r);

      let entryIndex = 0;
      return entries.map(entry => {
        const dto = rowToCloudDto(entry, email);
        const mac = lookupMac(dto.sn);
        const { userId: _userId, ...dtoWithoutUserId } = dto;
        const isCharger = dto.deviceType === 'charger';
        // Cloud retourneert unieke equipmentId per device — offset charger entry
        const uniqueId = dto.equipmentId + (entryIndex++);
        return {
          ...dtoWithoutUserId,
          equipmentId: uniqueId,
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
      });
    }),
  }));
});

// POST /api/nova-user/equipment/getEquipmentBySN
// App stuurt: { sn, deviceType }
equipmentRouter.post('/getEquipmentBySN', authMiddleware, (req: AuthRequest, res: Response) => {
  const sn = req.body.sn as string | undefined;
  if (!sn) { res.json(fail('sn required', 400)); return; }

  const row = equipmentRepo.findBySn(sn) as EquipmentRow | undefined;

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
    equipmentRepo.updateMacAddress(sn, mac);
  }

  // Haal numeriek user ID op (cloud retourneert dit als integer, bijv. 86).
  // Cloud gedrag: userId=0 als apparaat unbound, userId=<owner_id> als gebonden.
  // App checkt: als userId > 0 EN niet eigen ID → "already bound" toast.
  const userRow = userRepo.findById(req.userId!);
  const numericUserId = userRow?.id ?? 0;

  if (row) {
    // Als de gevraagde SN de charger is, gebruik charger_sn als primaire SN voor de DTO
    const isChargerQuery = sn === row.charger_sn && sn !== row.mower_sn;
    const effectiveRow = isChargerQuery ? { ...row, mower_sn: row.charger_sn! } as EquipmentRow : row;

    // KRITIEK (2026-04-22): voor charger-queries MOETEN charger-specifieke
    // velden (MAC, MQTT creds, LoRa) uit device_factory komen — NIET uit de
    // equipment pair-row. Pair row heeft pair-shared data (charger_address
    // = pair LoRa addr; mac_address = vaak mower's MAC) waardoor charger
    // queries anders verkeerde/oude/andere-device data retourneren (bewezen
    // bug LFIC1231000319 kreeg Ramon's LFIC1230700004 creds).
    if (isChargerQuery) {
      const chargerFactory = deviceRepo.getFactoryDevice(sn);
      if (chargerFactory) {
        effectiveRow.mac_address = chargerFactory.mac_address ?? effectiveRow.mac_address;
        effectiveRow.charger_address = chargerFactory.charger_address != null
          ? String(chargerFactory.charger_address) : effectiveRow.charger_address;
        effectiveRow.charger_channel = chargerFactory.charger_channel != null
          ? String(chargerFactory.charger_channel) : effectiveRow.charger_channel;
        // Also override mac used elsewhere in this function so the finalResponse
        // eerder in de flow overschrijft niet per ongeluk met een iPhone-MAC.
        mac = chargerFactory.mac_address ?? mac;
        console.log(`[equipment] getEquipmentBySN: charger ${sn} → using device_factory data (mac=${chargerFactory.mac_address}, addr=${chargerFactory.charger_address}, ch=${chargerFactory.charger_channel})`);
      }
    }

    // Cloud retourneert email="" in getEquipmentBySN (niet het echte email adres)
    const dto = rowToCloudDto(effectiveRow, '');

    // Voor chargers: override account/password met de charger-specifieke
    // credentials uit device_factory (niet de pair's gedeelde MQTT creds).
    if (isChargerQuery) {
      const chargerFactory = deviceRepo.getFactoryDevice(sn);
      if (chargerFactory) {
        if (chargerFactory.mqtt_account) dto.account = chargerFactory.mqtt_account;
        if (chargerFactory.mqtt_password) dto.password = chargerFactory.mqtt_password;
      }
    }

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

    // Always return MAC address — the official app needs it for BLE readiness checks
    // (build map pre-check, signal info). Without MAC, the app skips BLE scan → spinner hangs.
    const finalResponse = { ...dto, userId, macAddress: mac ?? dto.macAddress };
    console.log(`[equipment] getEquipmentBySN: sn=${sn} sysVersion=${finalResponse.sysVersion} userId=${userId}`);
    res.json(ok(finalResponse));
  } else {
    // Geen equipment record gevonden.
    // De echte cloud heeft ALTIJD een record (factory-geïmporteerd). Als wij equipmentId=0
    // retourneren, denkt de app dat het een nieuw apparaat is en triggert volledige BLE
    // provisioning — die de WiFi-configuratie van het apparaat overschrijft!
    //
    // Oplossing: als het apparaat bekend is (via MQTT of device_registry), maak automatisch
    // een equipment record aan zodat de app equipmentId>0 ziet en BLE overslaat.
    const knownDevice = deviceRepo.findBySn(sn);

    // Factory lookup — pre-loaded from LFI cloud scan (SN → MAC, LoRa, MQTT creds)
    const factoryDevice = deviceRepo.getFactoryDevice(sn);

    if (factoryDevice && !mac) {
      mac = factoryDevice.mac_address;
      console.log(`[equipment] getEquipmentBySN: MAC from factory lookup: ${sn} → ${mac}`);
    }

    const deviceIsKnown = knownDevice || isDeviceOnline(sn) || mac;

    if (deviceIsKnown) {
      // Auto-create equipment record — spiegelt cloud factory-import gedrag
      const equipmentId = uuidv4();
      const knownLora = equipmentRepo.getLoraCache(sn);

      // Als het apparaat online is (MQTT verbonden), bind het direct aan de gebruiker.
      // Zonder user_id verschijnt het niet in userEquipmentList en kan de app niet binden
      // omdat skipBle=true macAddress=null retourneert → BLE scan mislukt → bindingEquipment
      // wordt nooit aangeroepen → user_id blijft NULL.
      const autoBindUserId = skipBle ? req.userId : null;

      equipmentRepo.create({
        equipment_id: equipmentId,
        user_id: autoBindUserId,
        mower_sn: sn,
        charger_sn: undefined,
        nick_name: undefined,
        mac_address: mac ?? knownDevice?.mac_address ?? null,
        charger_address: knownLora?.charger_address ?? null,
        charger_channel: knownLora?.charger_channel ?? null,
      });

      console.log(`[equipment] getEquipmentBySN: auto-created record for known device sn=${sn} equipmentId=${equipmentId} autoBound=${!!autoBindUserId}`);

      // Haal het net aangemaakte record op (voor correcte id/created_at)
      const newRow = equipmentRepo.findByEquipmentId(equipmentId) as EquipmentRow;
      const dto = rowToCloudDto(newRow, req.email ?? '');
      // Als auto-bound: userId=numericUserId zodat app het apparaat herkent als eigen
      // Als niet auto-bound: userId=0 → app doet BLE provisioning
      const autoUserId = autoBindUserId ? numericUserId : 0;
      res.json(ok({ ...dto, userId: autoUserId, macAddress: skipBle ? null : (mac ?? dto.macAddress) }));
    } else {
      // Apparaat niet online/niet in registry — check factory lookup voor MAC
      console.log(`[equipment] getEquipmentBySN: unknown device sn=${sn} — checking factory lookup`);
      const knownLora = equipmentRepo.getLoraCache(sn);

      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const isCharger = snToDeviceType(sn) === 'charger';

      // Use factory data for MAC, LoRa, MQTT if available
      const fMac = factoryDevice?.mac_address ?? mac ?? null;
      const fAddr = knownLora?.charger_address ? Number(knownLora.charger_address)
        : factoryDevice?.charger_address ?? (isCharger ? 718 : null);
      const fChan = knownLora?.charger_channel ? Number(knownLora.charger_channel)
        : factoryDevice?.charger_channel ?? (isCharger ? 16 : null);
      const fAccount = factoryDevice?.mqtt_account ?? (isCharger ? MQTT_ACCOUNT : null);
      const fPassword = factoryDevice?.mqtt_password ?? (isCharger ? MQTT_PASSWORD : null);
      const fVersion = factoryDevice?.sys_version ?? (isCharger ? 'v0.3.6' : 'v5.7.1');

      if (fMac) {
        console.log(`[equipment] getEquipmentBySN: factory MAC found for ${sn} → ${fMac}`);
      } else {
        console.log(`[equipment] getEquipmentBySN: no MAC for ${sn} — app will show "Device is missing mac address"`);
      }

      res.json(ok({
        equipmentId:       0,
        email:             req.email ?? '',
        deviceType:        snToDeviceType(sn),
        sn:                sn,
        equipmentCode:     sn,
        equipmentName:     sn,
        equipmentType:     snToEquipmentType(sn),
        userId:            0,
        sysVersion:        fVersion,
        period:            isCharger ? '2029-02-22 00:00:00' : '2026-11-16 00:00:00',
        status:            1,
        activationTime:    now,
        importTime:        now,
        batteryState:      null,
        macAddress:        skipBle ? null : fMac,
        chargerAddress:    fAddr,
        chargerChannel:    fChan,
        account:           fAccount,
        password:          fPassword,
      }));
    }
  }
});

// POST /api/nova-user/equipment/bindingEquipment
equipmentRouter.post('/bindingEquipment', authMiddleware, (req: AuthRequest, res: Response) => {
  const body = req.body as Record<string, string | undefined>;
  const mowerSn        = body.mowerSn;
  const chargerSn      = body.chargerSn;
  const _equipmentTypeH = body.equipmentTypeH;
  // App stuurt 'userCustomDeviceName'; accepteer ook legacy 'equipmentNickName'
  const nickName       = body.userCustomDeviceName ?? body.equipmentNickName ?? null;
  // chargerChannel wordt gestuurd als het toegewezen LoRa kanaal (uit set_lora_info_respond.value)
  const chargerChannel = body.chargerChannel ?? null;

  // Accept mowerSn, legacy 'sn', or fall back to chargerSn (charger-station-first flow)
  const sn = mowerSn ?? body.sn ?? chargerSn;
  if (!sn) { res.json(fail('mowerSn or chargerSn required', 400)); return; }

  // Haal chargerAddress op uit lora_cache (pre-seeded of eerder gebind)
  const loraCache = equipmentRepo.getLoraCache(sn);
  const chargerAddress = loraCache?.charger_address ?? null;

  // Check if already bound — by mower_sn OR charger_sn
  const existing = equipmentRepo.findBySn(sn);

  if (existing) {
    // Lokale server: sta altijd rebinding toe (ongeacht vorige user_id).
    // Cloud blokkeert dit voor multi-user, maar wij zijn single-household.
    if (existing.user_id && existing.user_id !== req.userId) {
      console.log(`[equipment] bindingEquipment: overschrijf binding sn=${sn} user_id=${existing.user_id} → ${req.userId}`);
    } else {
      console.log(`[equipment] bindingEquipment: re-bind sn=${sn} user_id=${existing.user_id ?? 'NULL'} → ${req.userId}`);
    }
    equipmentRepo.rebind(existing.equipment_id, req.userId!, chargerChannel, chargerAddress, nickName);
    res.json(ok(1));  // Cloud retourneert value:1 bij success
    return;
  }

  const equipmentId = uuidv4();
  // If only chargerSn was supplied (charger-station-first flow), store it as mower_sn
  // so the rest of the codebase can look up equipment by any single SN.
  equipmentRepo.create({
    equipment_id: equipmentId,
    user_id: req.userId,
    mower_sn: sn,
    charger_sn: chargerSn !== sn ? (chargerSn ?? null) : null,
    nick_name: nickName,
    charger_channel: chargerChannel,
    charger_address: chargerAddress,
  });

  // Zorg dat de user altijd één active equipment row heeft. Eerste binding
  // van een user → deze wordt active. Bestaande users die al een active
  // hebben raken die niet kwijt.
  equipmentRepo.ensureOneActiveForUser(req.userId!);

  console.log(`[equipment] bindingEquipment: sn=${sn} chargerSn=${chargerSn ?? '-'} channel=${chargerChannel} addr=${chargerAddress} equipmentId=${equipmentId}`);
  res.json(ok(1));  // Cloud retourneert value:1 bij success
});

// POST /api/nova-user/equipment/unboundEquipment
// User-spec 2026-04-22: bij verwijderen via Novabot app MOET een cascade
// delete gebeuren voor ALLES wat met het device te maken heeft, BEHALVE
// maps (user-created tekeningen van werkgebieden). Zo hoeft de user niet
// handmatig DB te schoonmaken na een unbind.
//
// Tables purged:
//   equipment, equipment_lora_cache, device_registry, cut_grass_plans,
//   work_records, robot_messages, signal_history, dashboard_schedules,
//   rain_sessions, device_settings
//
// Tables PRESERVED (user data):
//   maps, map_uploads, map_calibration, virtual_walls
//
// Bonus: voegt SN toe aan ban-list voor 2u zodat auto-bind + broker re-connect
// niet direct de equipment row opnieuw aanmaakt na de cleanup (bewezen issue
// 2026-04-22 waarbij elke 30s auto-bind terug kwam).
equipmentRouter.post('/unboundEquipment', authMiddleware, (req: AuthRequest, res: Response) => {
  // App stuurt {sn, appUserId} — niet equipmentId zoals eerder aangenomen
  const { sn, equipmentId } = req.body as { sn?: string; equipmentId?: number };
  if (!sn && equipmentId == null) { res.json(fail('sn or equipmentId required', 400)); return; }

  // Zoek equipment op basis van SN (primair) of equipmentId (fallback)
  const equip = sn
    ? equipmentRepo.findBySnAndUser(sn, req.userId!)
    : equipmentId != null
      ? equipmentRepo.findByIdAndUser(equipmentId, req.userId!)
      : undefined;

  if (!equip) { res.json(ok()); return; }

  const mowerSn = equip.mower_sn;
  const chargerSn = equip.charger_sn;
  const equipmentIdStr = equip.equipment_id;
  const snsToClean: string[] = [];
  if (mowerSn) snsToClean.push(mowerSn);
  if (chargerSn && chargerSn !== mowerSn) snsToClean.push(chargerSn);

  try {
    const tx = db.transaction(() => {
      // 1. Equipment + pair-binding
      db.prepare('DELETE FROM equipment WHERE equipment_id = ?').run(equipmentIdStr);

      // 2. Per-SN tabellen — maps NIET! (mower_sn referenties blijven intact)
      for (const s of snsToClean) {
        db.prepare('DELETE FROM equipment_lora_cache WHERE sn = ?').run(s);
        db.prepare('DELETE FROM device_registry WHERE sn = ?').run(s);
        db.prepare('DELETE FROM signal_history WHERE sn = ?').run(s);
        // device_settings heeft sn kolom
        try { db.prepare('DELETE FROM device_settings WHERE sn = ?').run(s); } catch { /* ignore missing col */ }
        // rain_sessions heeft mower_sn kolom
        try { db.prepare('DELETE FROM rain_sessions WHERE mower_sn = ?').run(s); } catch { /* ignore */ }
      }

      // 3. Per-equipment_id tabellen (cut_grass_plans, work_records, robot_messages)
      db.prepare('DELETE FROM cut_grass_plans WHERE equipment_id = ?').run(equipmentIdStr);
      try { db.prepare('DELETE FROM work_records WHERE equipment_id = ?').run(equipmentIdStr); } catch { /* ignore */ }
      try { db.prepare('DELETE FROM robot_messages WHERE equipment_id = ?').run(equipmentIdStr); } catch { /* ignore */ }

      // 4. Dashboard schedules (zijn mower-gebonden)
      if (mowerSn) {
        try { db.prepare('DELETE FROM dashboard_schedules WHERE mower_sn = ?').run(mowerSn); } catch { /* ignore */ }
      }

      // 5. KEEP: maps, map_uploads, map_calibration, virtual_walls
      //    User's werkgebied-tekeningen. Worden hergebruikt bij re-binding
      //    van dezelfde mower_sn (de factory-level identifier).
    });
    tx();

    // 6. Force disconnect zodat device een clean reconnect doet. GEEN BAN —
    //    user wil na delete waarschijnlijk direct re-provisionen via de app.
    //    Ban komt alleen via de expliciete "Delete + Banish" dashboard knop.
    //    (Bug 2026-04-22: 2h ban brak de Novabot app re-provisioning flow
    //    omdat charger nooit meer online kon na BLE completion.)
    for (const s of snsToClean) {
      try { forceDisconnectDevice(s); } catch { /* ignore */ }
    }

    console.log(`[equipment] unboundEquipment: cascade delete voor sn=${sn ?? '?'} equipment_id=${equipmentIdStr} (SNs=[${snsToClean.join(',')}]) — maps preserved, no ban`);
    res.json(ok());
  } catch (err) {
    console.log(`[equipment] unboundEquipment cascade error: ${err}`);
    // Fallback: in elk geval user_id op null zetten zodat de unbind minimaal slaagt
    equipmentRepo.unbindById(equip.id);
    res.json(ok());
  }
});

// POST /api/nova-user/equipment/updateEquipmentNickName
//
// Novabot v2.4.0 sends `{ sn, appUserId, equipmentNickName }` — NOT
// `equipmentId` (the cloud's numeric pk). Bekend issue dat ook in de officiële
// app niet werkte zolang de cloud sn niet accepteerde. We accepteren beide
// zodat oude clients (die nog wel equipmentId sturen) ook blijven werken.
equipmentRouter.post('/updateEquipmentNickName', authMiddleware, (req: AuthRequest, res: Response) => {
  const { equipmentId, sn, equipmentNickName, userCustomDeviceName } = req.body as {
    equipmentId?: number; sn?: string;
    equipmentNickName?: string; userCustomDeviceName?: string;
  };
  const name = equipmentNickName ?? userCustomDeviceName ?? null;

  if (sn) {
    const changed = equipmentRepo.updateNickNameByMowerSnAndUser(sn, req.userId!, name);
    if (changed === 0) { res.json(fail('Equipment not found for user', 404)); return; }
    res.json(ok());
    return;
  }
  if (equipmentId != null) {
    equipmentRepo.updateNickNameByIdAndUser(equipmentId, req.userId!, name);
    res.json(ok());
    return;
  }
  res.json(fail('sn or equipmentId required', 400));
});

// POST /api/nova-user/equipment/updateEquipmentVersion
equipmentRouter.post('/updateEquipmentVersion', authMiddleware, (req: AuthRequest, res: Response) => {
  const { equipmentId, sn, chargerSn, mowerVersion, chargerVersion } = req.body as {
    equipmentId?: number; sn?: string; chargerSn?: string;
    mowerVersion?: string; chargerVersion?: string;
  };

  // App stuurt sn + chargerSn i.p.v. equipmentId — accepteer beide
  if (equipmentId != null) {
    equipmentRepo.updateVersionsByIdAndUser(equipmentId, req.userId!, mowerVersion, chargerVersion);
  } else if (sn) {
    equipmentRepo.updateVersionsByMowerSnAndUser(sn, req.userId!, mowerVersion, chargerVersion);
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
