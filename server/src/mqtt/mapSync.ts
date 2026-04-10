/**
 * Map Sync — haalt kaarten op van de maaier via MQTT en slaat ze op in de database.
 *
 * Wanneer een maaier (LFIN*) verbindt met de MQTT broker, stuurt deze module
 * automatisch `get_map_list` om de kaarten op te vragen. Vervolgens wordt per
 * kaart `get_map_outline` gestuurd om de polygoon-data op te halen.
 *
 * Responses worden geparsed en opgeslagen in de `maps` tabel.
 */
import crypto from 'crypto';
// aedes v1.0.0 has no main field — define compatible types locally
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Aedes = { publish: (packet: any, cb: (err?: Error | null) => void) => void; [key: string]: unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AedesPublishPacket = { topic: string; payload: Buffer | string; qos: 0 | 1 | 2; retain: boolean; [key: string]: any };
import { v4 as uuidv4 } from 'uuid';
import { mapRepo, equipmentRepo, userRepo, deviceRepo } from '../db/repositories/index.js';
import { emitDeviceBound, emitDevicePaired } from '../dashboard/socketHandler.js';
import { gpsToLocal, type GpsPoint, type LocalPoint } from './mapConverter.js';
import { tryDecrypt } from './decrypt.js';

const TAG = '[MAP-SYNC]';

let aedesBroker: Aedes | null = null;

// ── Per-device cmd_num counter (matches Flutter app behavior) ────────────────
// The Flutter app uses an auto-incrementing cmd_num per command.
// We track per-SN to avoid collisions between devices.
const cmdNumCounters = new Map<string, number>();

/** Get the next cmd_num for a device (auto-incrementing, starts at 1). */
export function getNextCmdNum(sn: string): number {
  const current = cmdNumCounters.get(sn) ?? 0;
  const next = current + 1;
  cmdNumCounters.set(sn, next);
  return next;
}

/**
 * Build the correct go_to_charge payload as used by the Flutter app.
 * Assembly analysis shows: { cmd_num: N, chargerpile: { latitude: 200, longitude: 200 } }
 * The lat/lng 200 values are sentinel/placeholder — the mower navigates via RTK/LoRa.
 */
export function goToChargePayload(sn: string): Record<string, unknown> {
  return {
    go_to_charge: {
      cmd_num: getNextCmdNum(sn),
      chargerpile: { latitude: 200, longitude: 200 },
    },
  };
}

// Bijhouden voor welke SNs we al een map-request hebben gestuurd (voorkom spam)
const pendingRequests = new Set<string>();

// Callback voor live outline updates → dashboard via Socket.io
type OutlineEmitter = (sn: string, points: Array<{ lat: number; lng: number }>) => void;
let outlineEmitter: OutlineEmitter | null = null;

export function setOutlineEmitter(fn: OutlineEmitter): void {
  outlineEmitter = fn;
}

// Demo interceptor: geeft true als het command is onderschept (skip MQTT publish)
type DemoInterceptor = (sn: string, command: Record<string, unknown>) => boolean;
let demoInterceptor: DemoInterceptor | null = null;

export function setDemoInterceptor(fn: DemoInterceptor): void {
  demoInterceptor = fn;
}

/**
 * Initialiseer mapSync met een referentie naar de Aedes broker.
 */
export function initMapSync(broker: Aedes): void {
  aedesBroker = broker;

  // Periodieke auto-bind: check elke 30s of er ongebonden devices zijn
  // Pakt alle situaties op: server startup, login, DB wipe, reconnect
  function runAutoBindSweep() {
    try {
      const allDevices = deviceRepo.listLatestBySn();
      for (const d of allDevices) {
        if (d.sn?.startsWith('LFI')) {
          autoBindDevice(d.sn);
        }
      }
    } catch (err) {
      console.error(`${TAG} Auto-bind sweep failed:`, err);
    }
  }
  setTimeout(runAutoBindSweep, 10_000);
  setInterval(runAutoBindSweep, 30_000);
}

/**
 * Publiceer een MQTT commando naar een apparaat.
 */
/**
 * Publiceer een raw Buffer naar een apparaat (bijv. AES-versleutelde payload).
 */
export function publishRawToDevice(sn: string, payload: Buffer, qos: 0 | 1 = 1): void {
  if (!aedesBroker) {
    console.error(`${TAG} Broker niet geinitialiseerd`);
    return;
  }

  // Demo interceptor: decrypt encrypted payload, laat simulator verwerken
  if (demoInterceptor && sn.startsWith('LFI')) {
    const decrypted = tryDecrypt(payload, sn);
    if (decrypted) {
      try {
        const command = JSON.parse(decrypted) as Record<string, unknown>;
        if (demoInterceptor(sn, command)) {
          console.log(`${TAG} [DEMO] Intercepted raw command for ${sn}: ${Object.keys(command)[0]}`);
          return;
        }
      } catch { /* niet-JSON payload, laat door */ }
    }
  }

  const topic = `Dart/Send_mqtt/${sn}`;
  const packet = {
    cmd: 'publish' as const,
    qos: qos as 0 | 1,
    dup: false,
    retain: false,
    topic,
    payload,
    brokerId: 'mapSync',
    brokerCounter: 0,
  } satisfies AedesPublishPacket;
  aedesBroker.publish(packet, (err) => {
    if (err) console.error(`${TAG} Raw publish fout naar ${topic}: ${err.message}`);
    else console.log(`${TAG} Raw payload (${payload.length}B) gestuurd naar ${topic} QoS=${qos}`);
  });
}

export function publishToDevice(sn: string, command: Record<string, unknown>): void {
  if (!aedesBroker) {
    console.error(`${TAG} Broker niet geinitialiseerd`);
    return;
  }

  // Demo interceptor: block MQTT publish, laat simulator verwerken
  if (demoInterceptor?.(sn, command)) {
    console.log(`${TAG} [DEMO] Intercepted command for ${sn}: ${Object.keys(command)[0]}`);
    return;
  }

  const json = JSON.stringify(command);

  // Auto-encrypt voor alle LFI-apparaten (maaier v6+ en charger v0.4.0+ verwachten AES)
  if (sn.startsWith('LFI')) {
    const KEY_PREFIX = 'abcdabcd1234';
    const IV = Buffer.from('abcd1234abcd1234', 'utf8');
    const key = Buffer.from(KEY_PREFIX + sn.slice(-4), 'utf8');
    const plaintext = Buffer.from(json, 'utf8');
    const padded = Buffer.alloc(Math.ceil(plaintext.length / 16) * 16, 0);
    plaintext.copy(padded);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    console.log(`${TAG} [AES] Gestuurd naar Dart/Send_mqtt/${sn}: ${json} (${encrypted.length}B encrypted)`);
    publishRawToDevice(sn, encrypted, 0);
    return;
  }

  const topic = `Dart/Send_mqtt/${sn}`;
  const packet = {
    cmd: 'publish' as const,
    qos: 0 as const,
    dup: false,
    retain: false,
    topic,
    payload: Buffer.from(json),
    brokerId: 'mapSync',
    brokerCounter: 0,
  } satisfies AedesPublishPacket;

  aedesBroker.publish(packet, (err) => {
    if (err) {
      console.error(`${TAG} Publish fout naar ${topic}: ${err.message}`);
    } else {
      console.log(`${TAG} Gestuurd naar ${topic}: ${json}`);
    }
  });
}

/**
 * Publiceer een onversleuteld JSON bericht naar een willekeurig MQTT topic.
 * Gebruikt voor custom bridge-scripts op de maaier (bijv. led_bridge.py).
 */
export function publishToTopic(topic: string, message: Record<string, unknown>): void {
  if (!aedesBroker) {
    console.error(`${TAG} Broker niet geinitialiseerd`);
    return;
  }
  const json = JSON.stringify(message);
  const packet = {
    cmd: 'publish' as const,
    qos: 0 as const,
    dup: false,
    retain: false,
    topic,
    payload: Buffer.from(json),
    brokerId: 'mapSync',
    brokerCounter: 0,
  } satisfies AedesPublishPacket;
  aedesBroker.publish(packet, (err) => {
    if (err) console.error(`${TAG} Publish fout naar ${topic}: ${err.message}`);
    else console.log(`${TAG} Gestuurd naar ${topic}: ${json}`);
  });
}

/**
 * Publiceer een AES-encrypted bericht op een willekeurig MQTT topic.
 * Gebruikt om device-responses te simuleren (bijv. op Dart/Receive_mqtt/<SN>).
 */
export function publishEncryptedOnTopic(topic: string, sn: string, message: Record<string, unknown>): void {
  if (!aedesBroker) {
    console.error(`${TAG} Broker niet geinitialiseerd`);
    return;
  }
  const json = JSON.stringify(message);
  let payload: Buffer;

  if (sn.startsWith('LFI')) {
    const KEY_PREFIX = 'abcdabcd1234';
    const IV = Buffer.from('abcd1234abcd1234', 'utf8');
    const key = Buffer.from(KEY_PREFIX + sn.slice(-4), 'utf8');
    const plaintext = Buffer.from(json, 'utf8');
    const padded = Buffer.alloc(Math.ceil(plaintext.length / 16) * 16, 0);
    plaintext.copy(padded);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
    cipher.setAutoPadding(false);
    payload = Buffer.concat([cipher.update(padded), cipher.final()]);
    console.log(`${TAG} [AES] Inject op ${topic}: ${json} (${payload.length}B encrypted)`);
  } else {
    payload = Buffer.from(json, 'utf8');
    console.log(`${TAG} Inject op ${topic}: ${json}`);
  }

  const packet = {
    cmd: 'publish' as const,
    qos: 0 as const,
    dup: false,
    retain: false,
    topic,
    payload,
    brokerId: 'mapSync',
    brokerCounter: 0,
  } satisfies AedesPublishPacket;

  aedesBroker.publish(packet, (err) => {
    if (err) console.error(`${TAG} Inject fout op ${topic}: ${err.message}`);
    else console.log(`${TAG} Inject succesvol op ${topic}`);
  });
}

/**
 * Vraag de kaartlijst op van een maaier.
 */
export function requestMapList(sn: string): void {
  console.log(`${TAG} Opvragen kaartlijst van ${sn}...`);
  publishToDevice(sn, { get_map_list: {} });
}

/**
 * Vraag de outline/polygoon op van een specifieke kaart.
 */
export function requestMapOutline(sn: string, mapId: string): void {
  console.log(`${TAG} Opvragen outline voor kaart ${mapId} van ${sn}...`);
  publishToDevice(sn, { get_map_outline: { map_id: mapId } });
}

/**
 * Auto-bind: als er een user account bestaat en dit device nog niet gebonden is,
 * maak automatisch een equipment record aan. Als er al een incompleet record is
 * (charger zonder mower of vice versa), vul het aan → auto-pair.
 */
function autoBindDevice(sn: string, attempt = 0): void {
  const existing = equipmentRepo.findBySn(sn);
  if (existing?.user_id) return; // al gebonden

  const user = userRepo.findFirst();
  if (!user) {
    // Bij server restart kan de user DB nog niet geladen zijn — retry na 5s (max 3x)
    if (attempt < 3) {
      setTimeout(() => autoBindDevice(sn, attempt + 1), 5000);
    }
    return;
  }

  const isCharger = sn.startsWith('LFIC');

  if (existing && !existing.user_id) {
    equipmentRepo.claimOwnership(existing.equipment_id, user.app_user_id);
    console.log(`${TAG} Auto-bind: ${sn} claimed by ${user.email}`);
    emitDeviceBound(sn);
    return;
  }

  // Zoek een incompleet record om aan te vullen (auto-pair)
  // Incompleet = mower_sn niet LFIN (charger placeholder) of charger_sn NULL
  const incomplete = equipmentRepo.findIncompleteByUserId(user.app_user_id);
  if (incomplete && isCharger && !incomplete.charger_sn) {
    // Mower-only record → voeg charger toe
    equipmentRepo.updateChargerSn(incomplete.equipment_id, sn);
    console.log(`${TAG} Auto-bind+pair: charger ${sn} paired with ${incomplete.mower_sn}`);
    emitDeviceBound(sn);
    emitDevicePaired(incomplete.mower_sn ?? '', sn);
    return;
  }
  if (incomplete && !isCharger && !incomplete.mower_sn?.startsWith('LFIN')) {
    // Charger-only record (mower_sn is charger SN placeholder) → voeg mower toe
    equipmentRepo.updateMowerSn(incomplete.equipment_id, sn);
    console.log(`${TAG} Auto-bind+pair: mower ${sn} paired with ${incomplete.charger_sn}`);
    emitDeviceBound(sn);
    emitDevicePaired(sn, incomplete.charger_sn ?? '');
    return;
  }

  // Nieuw record — mower_sn heeft NOT NULL constraint, gebruik SN als placeholder voor chargers
  const equipmentId = uuidv4();
  equipmentRepo.create({
    equipment_id: equipmentId,
    user_id: user.app_user_id,
    mower_sn: sn,
    charger_sn: isCharger ? sn : null,
  });
  console.log(`${TAG} Auto-bind: ${sn} bound to ${user.email}`);
  emitDeviceBound(sn);
}

/**
 * Automatisch gegevens opvragen wanneer een apparaat verbindt.
 * Wordt aangeroepen vanuit broker.ts authenticate handler.
 * Wacht 3 seconden zodat het apparaat tijd heeft om te settlen.
 */
export function onMowerConnected(sn: string): void {
  if (pendingRequests.has(sn)) return;

  pendingRequests.add(sn);

  setTimeout(() => {
    // Auto-bind: als er een user is en dit device nog niet gebonden, bind automatisch
    autoBindDevice(sn);

    // Firmware versie opvragen (charger + mower)
    // v0.4.0 charger vereist null (cJSON_IsNull check), v0.3.6 accepteert elke waarde
    console.log(`\x1b[38;5;208m${TAG} Firmware versie opvragen van ${sn}...\x1b[0m`);
    publishToDevice(sn, { ota_version_info: null });

    // Charger: LoRa config opvragen (echte addr/channel)
    if (sn.startsWith('LFIC')) {
      console.log(`${TAG} Charger ${sn} verbonden — LoRa config opvragen...`);
      publishToDevice(sn, { get_lora_info: null });
    }

    // Maaier: kaartlijst opvragen
    if (sn.startsWith('LFIN')) {
      // LET OP: set_cfg_info (timezone) wordt NIET meer gestuurd bij connect.
      // Reden: mqtt_node slaat timezone op in geheugen en verandert daardoor
      // ota_upgrade_cmd type van "full" naar "increment", waardoor OTA nooit
      // een volledige firmware download start. De app stuurt timezone zelf mee
      // in het ota_upgrade_cmd commando.
      console.log(`${TAG} Maaier ${sn} verbonden — kaarten opvragen...`);
      requestMapList(sn);
      // NB: get_para_info wordt NIET gestuurd — maaier reageert er niet op.
      // Settings state wordt lokaal bijgehouden wanneer set_para_info wordt gestuurd.
    }

    // Na 30 seconden de pending flag resetten zodat bij reconnect opnieuw gevraagd kan worden
    setTimeout(() => pendingRequests.delete(sn), 30_000);
  }, 3000);
}

// ── Extended commands (novabot/extended/<SN>) ────────────────────────────────

export function publishToExtended(sn: string, command: Record<string, unknown>): void {
  publishToTopic(`novabot/extended/${sn}`, command);
}

type ExtendedResponseHandler = (data: Record<string, unknown>) => void;
const _extResponseHandlers = new Map<string, Set<ExtendedResponseHandler>>();

export function onExtendedResponse(sn: string, handler: ExtendedResponseHandler): void {
  if (!_extResponseHandlers.has(sn)) _extResponseHandlers.set(sn, new Set());
  _extResponseHandlers.get(sn)!.add(handler);
}

export function offExtendedResponse(sn: string, handler: ExtendedResponseHandler): void {
  _extResponseHandlers.get(sn)?.delete(handler);
}

/** Call from broker.ts when a message arrives on novabot/extended_response/<SN> */
export function handleExtendedResponse(sn: string, payload: string): void {
  try {
    const data = JSON.parse(payload) as Record<string, unknown>;
    const handlers = _extResponseHandlers.get(sn);
    if (handlers) {
      for (const h of handlers) h(data);
    }
  } catch { /* ignore */ }
}

/**
 * Verwerk een inkomend MQTT bericht dat kaart-gerelateerd kan zijn.
 * Retourneert true als het bericht afgehandeld is.
 */
export function handleMapMessage(sn: string, parsed: Record<string, unknown>): boolean {
  const command = Object.keys(parsed)[0];
  if (!command) return false;

  switch (command) {
    case 'get_map_list_respond':
      handleMapListResponse(sn, parsed[command]);
      return true;

    case 'report_state_map_outline':
      handleMapOutlineResponse(sn, parsed[command]);
      return true;

    case 'get_map_plan_path_respond': {
      // Forward to dashboard planned path cache
      const { handlePlannedPathRespond } = require('../routes/dashboard.js');
      const respondData = parsed[command] as Record<string, unknown>;
      if (respondData && typeof respondData === 'object') {
        handlePlannedPathRespond(sn, respondData);
      }
      return true;
    }

    default:
      return false;
  }
}

/**
 * Verwerk get_map_list_respond — bevat lijst van alle kaarten op de maaier.
 *
 * Verwachte formaten (op basis van APK analyse):
 * - { map_ids: ["id1", "id2", ...] }
 * - { maps: [{ map_id, map_name, map_type }, ...] }
 * - { result: 0, value: { ... } }
 */
function handleMapListResponse(sn: string, data: unknown): void {
  console.log(`${TAG} Ontvangen kaartlijst van ${sn}:`, JSON.stringify(data));

  if (!data || typeof data !== 'object') {
    console.log(`${TAG} Lege of ongeldige kaartlijst response`);
    return;
  }

  const d = data as Record<string, unknown>;

  // Probeer map_ids array te vinden
  let mapIds: string[] = [];

  if (Array.isArray(d.map_ids)) {
    mapIds = d.map_ids.filter((id): id is string => typeof id === 'string');
  } else if (Array.isArray(d.maps)) {
    // Volledige map objecten
    for (const map of d.maps) {
      if (typeof map === 'object' && map !== null) {
        const m = map as Record<string, unknown>;
        const mapId = String(m.map_id ?? m.mapId ?? '');
        if (mapId) {
          mapIds.push(mapId);
          // Sla eventuele metadata alvast op
          upsertMapMetadata(sn, mapId, m);
        }
      }
    }
  } else if (d.result !== undefined && d.value && typeof d.value === 'object') {
    // Wrapped in result/value
    return handleMapListResponse(sn, d.value);
  }

  if (mapIds.length === 0) {
    console.log(`${TAG} Geen kaarten gevonden op maaier ${sn}`);
    return;
  }

  console.log(`${TAG} ${mapIds.length} kaart(en) gevonden op ${sn}: ${mapIds.join(', ')}`);

  // Vraag de outline op voor elke kaart
  for (const mapId of mapIds) {
    setTimeout(() => {
      requestMapOutline(sn, mapId);
    }, 500);
  }
}

/**
 * Verwerk report_state_map_outline — bevat polygoon data voor een kaart.
 *
 * Verwacht formaat (op basis van APK MapEntity):
 * - { map_id, map_name, map_type, map_position: [{lat, lng}, ...] }
 * - Of: { map_id, map_name, map_type, outline: [[lat,lng], ...] }
 */
function handleMapOutlineResponse(sn: string, data: unknown): void {
  console.log(`${TAG} Ontvangen kaart-outline van ${sn}:`, JSON.stringify(data)?.slice(0, 500));

  if (!data || typeof data !== 'object') return;

  const d = data as Record<string, unknown>;
  const mapId = String(d.map_id ?? d.mapId ?? '');
  if (!mapId) {
    console.log(`${TAG} Outline response zonder map_id`);
    return;
  }

  const mapName = String(d.map_name ?? d.mapName ?? d.map_type ?? '');
  const mapType = String(d.map_type ?? d.mapType ?? '');

  // Probeer polygoon punten te vinden
  let points: { lat: number; lng: number }[] = [];

  // Formaat 1: map_position als array van {lat, lng}
  if (Array.isArray(d.map_position)) {
    points = parsePositionArray(d.map_position);
  }
  // Formaat 2: outline als array van [lat, lng]
  else if (Array.isArray(d.outline)) {
    points = parsePositionArray(d.outline);
  }
  // Formaat 3: points als array
  else if (Array.isArray(d.points)) {
    points = parsePositionArray(d.points);
  }

  if (points.length === 0) {
    console.log(`${TAG} Geen polygoon punten in outline voor ${mapId}`);
    // Sla metadata op zonder polygoon
    upsertMapMetadata(sn, mapId, d);
    return;
  }

  // Converteer GPS→lokaal vóór opslag (maaier stuurt GPS coords)
  const chargerGps = mapRepo.getChargerGps(sn);

  let localPoints: LocalPoint[];
  if (chargerGps) {
    const origin: GpsPoint = { lat: chargerGps.lat, lng: chargerGps.lng };
    localPoints = points.map(p => gpsToLocal(p, origin));
  } else {
    // Geen charger positie — gebruik eerste punt als origin (tijdelijk)
    const origin: GpsPoint = { lat: points[0].lat, lng: points[0].lng };
    localPoints = points.map(p => gpsToLocal(p, origin));
    console.log(`${TAG} Geen charger GPS voor ${sn} — eerste punt als origin gebruikt`);
  }

  const bounds = {
    minX: Math.min(...localPoints.map(p => p.x)),
    maxX: Math.max(...localPoints.map(p => p.x)),
    minY: Math.min(...localPoints.map(p => p.y)),
    maxY: Math.max(...localPoints.map(p => p.y)),
  };

  // Sla op in database (lokale coördinaten)
  const displayName = mapName || mapType || `Map ${mapId.slice(0, 8)}`;

  mapRepo.upsert({
    map_id: mapId,
    mower_sn: sn,
    map_name: displayName,
    map_area: JSON.stringify(localPoints),
    map_max_min: JSON.stringify(bounds),
  });

  console.log(`${TAG} Kaart "${displayName}" (${mapId}) opgeslagen: ${localPoints.length} punten (lokaal), bounds: ${JSON.stringify(bounds)}`);

  // Stuur live outline naar dashboard via Socket.io (GPS voor Leaflet)
  outlineEmitter?.(sn, points);
}

/**
 * Parse een array van positie-objecten naar {lat, lng}[].
 * Ondersteunt: [{lat,lng}], [[lat,lng]], [{x,y}], [{latitude,longitude}]
 */
function parsePositionArray(arr: unknown[]): { lat: number; lng: number }[] {
  const points: { lat: number; lng: number }[] = [];

  for (const item of arr) {
    if (Array.isArray(item) && item.length >= 2) {
      const lat = Number(item[0]);
      const lng = Number(item[1]);
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        points.push({ lat, lng });
      }
    } else if (typeof item === 'object' && item !== null) {
      const o = item as Record<string, unknown>;
      const lat = Number(o.lat ?? o.latitude ?? o.y ?? 0);
      const lng = Number(o.lng ?? o.longitude ?? o.x ?? 0);
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        points.push({ lat, lng });
      }
    }
  }

  return points;
}

/**
 * Sla kaart metadata op (naam, type) zonder polygoon data.
 */
function upsertMapMetadata(sn: string, mapId: string, meta: Record<string, unknown>): void {
  const mapName = String(meta.map_name ?? meta.mapName ?? meta.map_type ?? '');

  // Alleen inserteren als de kaart nog niet bestaat (create uses INSERT, not INSERT OR REPLACE)
  const existing = mapRepo.findById(mapId);
  if (!existing) {
    mapRepo.create({ map_id: mapId, mower_sn: sn, map_name: mapName || null });
  }
}
