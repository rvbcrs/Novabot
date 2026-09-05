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
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
// aedes v1.0.0 has no main field — define compatible types locally
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Aedes = { publish: (packet: any, cb: (err?: Error | null) => void) => void; [key: string]: unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AedesPublishPacket = { topic: string; payload: Buffer | string; qos: 0 | 1 | 2; retain: boolean; [key: string]: any };
import { v4 as uuidv4 } from 'uuid';
import { mapRepo, equipmentRepo, userRepo, deviceRepo, deviceSettingsRepo } from '../db/repositories/index.js';
import { selectParaRepush } from './paraRepush.js';
import {
  COVERAGE_PLANNER_RADIUS_KEY,
  selectCoveragePlannerRadius,
} from '../services/coveragePlannerRadius.js';
import { emitDeviceBound, emitDevicePaired } from '../dashboard/socketHandler.js';
import { gpsToLocal, type GpsPoint, type LocalPoint } from './mapConverter.js';
import { tryDecrypt } from './decrypt.js';
import { isSnBanned, isDeviceOnline } from './broker.js';
import { isFrameNavBlocked, noteAutoRecharge } from '../services/frameValidation.js';
import { hasPendingMapSync, clearPendingMapSync } from '../services/pendingMapSync.js';
import { validateMapRasters, type BundleValidation } from '../maps/validateGrid.js';

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
type OutlineEmitter = (sn: string, points: Array<{ lat: number; lng: number }>, localPoints: Array<{ x: number; y: number }>) => void;
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
  } as AedesPublishPacket;
  aedesBroker.publish(packet, (err) => {
    if (err) console.error(`${TAG} Raw publish fout naar ${topic}: ${err.message}`);
    else console.log(`${TAG} Raw payload (${payload.length}B) gestuurd naar ${topic} QoS=${qos}`);
  });
}

/**
 * Determine whether the on-device firmware understands AES-128-CBC payloads
 * on `Dart/Send_mqtt/<SN>`. Issue #49: stock mower firmware ≤ v5.7.1 has no
 * AES path and silently drops encrypted commands; charger firmware ≤ v0.3.6
 * is the same. We only encrypt when the equipment table has a known version
 * that we know supports it. Unknown / missing version errs on the safe side
 * (plain JSON) so commands at least reach the device.
 */
function isAesCapable(sn: string): boolean {
  try {
    const eq = equipmentRepo.findBySn(sn);
    if (!eq) return false;
    if (sn.startsWith('LFIN')) {
      const v = eq.mower_version ?? '';
      const m = v.match(/v?(\d+)/i);
      if (!m) return false;
      return parseInt(m[1], 10) >= 6;     // v6.x and up understand AES
    }
    if (sn.startsWith('LFIC')) {
      const v = eq.charger_version ?? '';
      // charger v0.4.0+ supports AES; v0.3.x does not
      const m = v.match(/v?0\.(\d+)/i);
      if (!m) return false;
      return parseInt(m[1], 10) >= 4;
    }
  } catch { /* fall through */ }
  return false;
}

export function publishToDevice(
  sn: string,
  command: Record<string, unknown>,
  opts?: { bypassFrameGuard?: boolean; suppressReanchorArm?: boolean },
): void {
  // Safety: while the map frame is unvalidated (post bundle-restore, pre
  // successful re-dock), go_to_charge / start_navigation navigate the wrong
  // frame and can drive the mower anywhere. Block them at this single choke
  // point so the app, the rain monitor, and admin tools are all covered.
  // EXCEPTION: the re-anchor dock-cycle (refresh-dock-anchor / reanchor
  // endpoint) issues go_to_charge deliberately from the dock to trigger the
  // ArUco snap that realigns the frame — it passes bypassFrameGuard.
  if (!opts?.bypassFrameGuard && isFrameNavBlocked(sn, command)) {
    console.warn(`${TAG} BLOCKED ${Object.keys(command)[0]} for ${sn}: frame unvalidated (post-restore). Re-anchor via the dock-cycle first.`);
    return;
  }
  // Arm the re-anchor clear: a deliberate re-anchor dock (auto_recharge, or a
  // bypassed go_to_charge from the dock-cycle) is what re-validates the frame.
  // Only the docked report that follows clears frame_unvalidated.
  // EXCEPTION: the auto re-anchor flow passes suppressReanchorArm — it owns the
  // clear itself via a position self-verify (docked map_position must land on the
  // origin), so the passive docked-report clear must NOT race ahead of it and
  // clear the flag on a wrong-position dock. See runAutoReanchor in dashboard.ts.
  if (!opts?.suppressReanchorArm && ('auto_recharge' in command || (opts?.bypassFrameGuard && 'go_to_charge' in command))) {
    noteAutoRecharge(sn);
  }

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

  // Auto-encrypt only when the firmware version is known to support AES.
  // Stock v5.x mowers and charger v0.3.x silently drop encrypted commands —
  // see firmware-aes-versions.md / issue #49. For those we publish plain JSON
  // on the same topic; the firmware accepts that path unchanged.
  if (sn.startsWith('LFI') && isAesCapable(sn)) {
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
  } as AedesPublishPacket;

  aedesBroker.publish(packet, (err) => {
    if (err) {
      console.error(`${TAG} Publish fout naar ${topic}: ${err.message}`);
    } else {
      console.log(`${TAG} Gestuurd naar ${topic}: ${json}`);
    }
  });
}

// ── Pending-response resolvers ───────────────────────────────────────────────
// Koppelt MQTT *_respond berichten aan blocking-wait callers (awaitCommand).
// Key: `${sn}|${respondType}` waarbij respondType bijv. "get_signal_info_respond".
type PendingResolver = (data: unknown) => void;
const pendingResolvers = new Map<string, PendingResolver[]>();

/**
 * Wordt aangeroepen door broker.ts zodra een *_respond bericht van een device
 * binnenkomt. Alle wachtende `awaitCommand` callers voor dit (sn, respondType)
 * worden one-shot opgelost.
 */
export function notifyRespond(sn: string, respondType: string, data: unknown): void {
  const key = `${sn}|${respondType}`;
  const resolvers = pendingResolvers.get(key);
  if (!resolvers || resolvers.length === 0) return;
  pendingResolvers.delete(key);
  for (const resolver of resolvers) {
    try { resolver(data); } catch (err) { console.error(`${TAG} Pending resolver throw:`, err); }
  }
}

/**
 * Stuur een MQTT command naar een device en wacht op het bijbehorende _respond.
 * Voorbeeld:
 *   const { channel, addr } = await awaitCommand(sn, 'get_lora_info', null, 5000);
 *
 * @param sn        Doelapparaat SN (LFIN... of LFIC...)
 * @param command   Command naam zonder `_respond`, bijv. "get_signal_info"
 * @param payload   JSON payload (of null voor commands zonder args)
 * @param timeoutMs Max wachttijd (default 5000)
 * @returns         De inhoud van het `_respond` bericht (maaier-stijl: direct de waarde; charger-stijl: de `message` property)
 */
export function awaitCommand(
  sn: string,
  command: string,
  payload: unknown = null,
  timeoutMs = 5000,
): Promise<unknown> {
  const respondType = `${command}_respond`;
  const key = `${sn}|${respondType}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Probeer resolver te verwijderen
      const list = pendingResolvers.get(key);
      if (list) {
        const idx = list.indexOf(resolver);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) pendingResolvers.delete(key);
      }
      reject(new Error(`Timeout na ${timeoutMs}ms wachtend op ${respondType} van ${sn}`));
    }, timeoutMs);

    const resolver: PendingResolver = (data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(data);
    };

    const existing = pendingResolvers.get(key) ?? [];
    existing.push(resolver);
    pendingResolvers.set(key, existing);

    publishToDevice(sn, { [command]: payload });
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
  } as AedesPublishPacket;
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

  // Mirror publishToDevice's AES capability check — stock v5.x mowers and
  // charger v0.3.x publish plain JSON on Dart/Receive_mqtt/<SN>, so when
  // we simulate a device response we must match that wire format. Sending
  // AES at the app makes it decrypt junk on those firmwares.
  if (sn.startsWith('LFI') && isAesCapable(sn)) {
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
  } as AedesPublishPacket;

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
/**
 * Bij het mergen van twee equipment records: kopieer belangrijke velden
 * van het te-verwijderen record (source) naar het bewaard blijvende record (target),
 * maar alleen als het target die velden nog niet heeft.
 */
function preserveFieldsOnMerge(source: Record<string, unknown>, target: Record<string, unknown>): void {
  const targetSn = (target.mower_sn as string) ?? '';
  // mac_address: alleen overnemen als het een maaier BLE MAC is (niet charger 48:27:E2:)
  if (source.mac_address && !target.mac_address && !(source.mac_address as string).startsWith('48:27:E2:')) {
    equipmentRepo.updateMacAddress(targetSn, source.mac_address as string);
    console.log(`${TAG} Merge: preserved mac_address ${source.mac_address}`);
  }
  // mower_ip
  if (source.mower_ip && !target.mower_ip) {
    equipmentRepo.updateMowerIp(targetSn, source.mower_ip as string);
    console.log(`${TAG} Merge: preserved mower_ip ${source.mower_ip}`);
  }
  // firmware versions
  const mowerV = source.mower_version as string | undefined;
  const chargerV = source.charger_version as string | undefined;
  if (mowerV && !target.mower_version || chargerV && !target.charger_version) {
    equipmentRepo.updateVersions(targetSn, mowerV ?? undefined, chargerV ?? undefined);
    console.log(`${TAG} Merge: preserved versions mower=${mowerV} charger=${chargerV}`);
  }
}

function autoBindDevice(sn: string, attempt = 0): void {
  // Respect ban list — als user "Delete + Banish" heeft gedaan, mag de
  // auto-bind sweep dit device NIET opnieuw binden. Anders verlies je de
  // "banned" state binnen 30s en blijft de Novabot app "device is bound"
  // error geven bij re-provisioning (bewezen 2026-04-22).
  if (isSnBanned(sn)) {
    return;
  }

  const existing = equipmentRepo.findBySn(sn);
  if (existing?.user_id) {
    // Al gebonden — maar check of dit device gepaird kan worden met een ander device.
    // Scenario: cloud import maakt mower record (charger_sn=NULL), charger auto-bindt apart.
    // Als er een incompleet record is, merge ze.
    //
    // CRITICAL: nooit een record samenvoegen dat al zelf compleet is (échte pair),
    // want dan vernietigen we een werkende pairing. Observed 2026-04-21: Ramon
    // provisioned een tweede charger → elke 30s flipte de mower heen-en-weer
    // tussen pair A en de nieuwe eenzame charger omdat de merge-logica dacht
    // "er is een incompleet record, vul maar aan". Alleen mergen als het
    // bestaande record zelf ook incompleet is (placeholder of missing counterpart).
    try {
      const user = userRepo.findFirst();
      if (user) {
        const isCharger = sn.startsWith('LFIC');
        const existingIsComplete = isCharger
          ? (existing.mower_sn?.startsWith('LFIN') ?? false)
          : ((existing.charger_sn?.length ?? 0) > 0 && existing.mower_sn?.startsWith('LFIN'));
        if (existingIsComplete) {
          // Don't touch a working pair. Log once so we see it, but no-op.
          return;
        }
        const incomplete = equipmentRepo.findIncompleteByUserId(user.app_user_id);
        if (incomplete && isCharger && !incomplete.charger_sn && incomplete.equipment_id !== existing.equipment_id) {
          // Mower-only record gevonden + charger heeft apart record → merge
          // Bewaar belangrijke velden van het te-verwijderen record
          preserveFieldsOnMerge(existing as any, incomplete as any);
          equipmentRepo.deleteById(existing.equipment_id);
          equipmentRepo.updateChargerSn(incomplete.equipment_id, sn);
          console.log(`${TAG} Auto-pair (merge): charger ${sn} merged into mower record ${incomplete.mower_sn}`);
          emitDevicePaired(incomplete.mower_sn ?? '', sn);
        } else if (incomplete && !isCharger && !incomplete.mower_sn?.startsWith('LFIN') && incomplete.equipment_id !== existing.equipment_id) {
          // Charger-only record gevonden + mower heeft apart record → merge
          // Bewaar belangrijke velden van het te-verwijderen record
          preserveFieldsOnMerge(existing as any, incomplete as any);
          equipmentRepo.deleteById(existing.equipment_id);
          equipmentRepo.updateMowerSn(incomplete.equipment_id, sn);
          console.log(`${TAG} Auto-pair (merge): mower ${sn} merged into charger record ${incomplete.charger_sn}`);
          emitDevicePaired(sn, incomplete.charger_sn ?? '');
        }
      }
    } catch (err) {
      console.warn(`${TAG} Auto-pair merge failed for ${sn}:`, (err as Error).message);
    }
    return;
  }

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
/**
 * Her-push de opgeslagen `set_para_info`-instellingen naar de maaier — vooral
 * `obstacle_avoidance_sensitivity`. De firmware persisteert ze niet over een
 * reboot heen; de cloud is de bron van waarheid en her-stuurt ze bij connect.
 * Filter + numerieke conversie in `selectParaRepush` (paraRepush.ts).
 */
function republishParaSettings(sn: string): void {
  const para = selectParaRepush(deviceSettingsRepo.findBySn(sn));
  if (!para) return;
  console.log(`${TAG} Her-push opgeslagen para-settings naar ${sn}: ${JSON.stringify(para)}`);
  publishToDevice(sn, { set_para_info: para });
}

function republishCoveragePlannerRadius(sn: string): void {
  const rows = deviceSettingsRepo.findBySn(sn);
  if (!rows.some((r) => r.key === COVERAGE_PLANNER_RADIUS_KEY)) return;
  const selected = selectCoveragePlannerRadius(rows);
  console.log(`${TAG} Her-push coverage planner radius naar ${sn}: ${selected.radius}m`);
  publishToExtended(sn, {
    set_coverage_planner_radius: {
      radius: selected.radius,
      force: false,
    },
  });
}

/**
 * Object-detectie-cadans UITGESCHAKELD — OpenNova gebruikt weer de stock
 * obstacle avoidance: `obstacle_avoidance_sensitivity` (1/2/3) stuurt de mower's
 * STOCK perceptie (Low=collision / Medium=detectie / High=segmentatie) rechtstreeks
 * via `set_para_info`. We sturen de cadans daarom altijd `level 1` (uit) zodat de
 * mower het model niet meer time-multiplext en de stand 1-op-1 stock-gedrag geeft.
 * (Bewust geen `selectObstacleDetectionLevel` meer — de stand mag de cadans niet
 * heractiveren.)
 */
export function republishObstacleDetection(sn: string): void {
  console.log(`${TAG} Object-detectie-cadans uit (level 1) naar ${sn} — stock perceptie via set_para_info`);
  publishToExtended(sn, { set_obstacle_detection: { level: 1 } });
}

/**
 * Re-push the per-mower border seam-fix config so it survives a firmware upgrade
 * that wipes /userdata/lfi/seam_fix.json. Only pushes when the user actually
 * configured it (a DB row exists) — a never-configured mower keeps the opt-in
 * default (daemon idle), so we never touch mowers that didn't ask for it.
 */
export async function republishSeamFix(sn: string): Promise<void> {
  const { seamFixRepo } = await import('../db/repositories/index.js');
  if (!seamFixRepo.get(sn)) return;   // never configured -> leave at opt-in default
  const cfg = seamFixRepo.getEffective(sn);
  console.log(`${TAG} seam-fix -> ${sn}: enabled=${cfg.enabled} edge_margin_cm=${cfg.edgeMarginCm}`);
  publishToExtended(sn, { set_seam_fix: { enabled: cfg.enabled, edge_margin_cm: cfg.edgeMarginCm } });
}

/**
 * Push een bundel's mower-files VERBATIM naar de maaier via `write_map_files`
 * — exact de push-mechaniek van de admin "Import bundle" → apply-verbatim route
 * (de single restore path). csv_files + charging_station.yaml + rasters worden
 * ongewijzigd naar de maaier geschreven; pos.json wordt NIET aangeraakt (de
 * dock-cyclus her-ankert het frame — dus geen realign, cloud-GPS blijft
 * behouden). `restart_mapping:false` voorkomt de iceoryx-shm leak die
 * novabot_mapping-bounces veroorzaakt. Alleen als de bundel geen whole-area
 * raster bevat valt het terug op save_map type:1 + regenerate_per_map_files om
 * de raster on-device te genereren.
 *
 * Gedeeld door de apply-verbatim HTTP-handler (adminStatus.ts) en de
 * cloud-import push (pushMapToMowerVerbatim) zodat beide identiek pushen.
 */
export function applyVerbatimToMower(
  sn: string,
  mowerFiles: {
    csvFiles: Record<string, string>;
    chargingStationYaml?: string | null;
    mapFilesText?: Record<string, string>;
    mapFilesB64?: Record<string, string>;
  },
): { pushed: boolean; validation: BundleValidation } {
  // SAFETY GATE — never overwrite a mower's (possibly working) map with a
  // structurally broken raster. handle_write_map_files WIPES csv_file/ before
  // writing, so a bad push is destructive + irreversible on the user's side.
  // Validate the rasters first; refuse the push on a hard failure.
  const validation = validateMapRasters(mowerFiles.mapFilesB64);
  if (!validation.ok) {
    console.error(`${TAG} apply-verbatim ${sn}: GEBLOKKEERD — kaartvalidatie faalt, NIETS gepusht (maaier-bestanden blijven intact):`);
    for (const f of validation.hardFailures) console.error(`${TAG}   ✗ ${f}`);
    return { pushed: false, validation };
  }
  for (const w of validation.warnings) console.warn(`${TAG} apply-verbatim ${sn}: ⚠ ${w}`);

  const writePayload: Record<string, unknown> = {
    csv_files: mowerFiles.csvFiles,
    charging_station_yaml: mowerFiles.chargingStationYaml ?? null,
    restart_mapping: false,
  };
  if (mowerFiles.mapFilesText && Object.keys(mowerFiles.mapFilesText).length > 0) {
    writePayload.map_files_text = mowerFiles.mapFilesText;
  }
  if (mowerFiles.mapFilesB64 && Object.keys(mowerFiles.mapFilesB64).length > 0) {
    writePayload.map_files_b64 = mowerFiles.mapFilesB64;
  }
  publishToExtended(sn, { write_map_files: writePayload });

  const hasWholeRaster = !!(mowerFiles.mapFilesB64 && mowerFiles.mapFilesB64['map.pgm']);
  if (!hasWholeRaster) {
    publishToDevice(sn, { save_map: { type: 1, mapName: 'map', totalArea: 0 } });
    console.log(`${TAG} apply-verbatim ${sn}: geen raster in bundel — save_map type:1 (fallback)`);
    setTimeout(() => {
      publishToExtended(sn, { regenerate_per_map_files: {} });
      console.log(`${TAG} apply-verbatim ${sn}: regenerate_per_map_files (fallback)`);
    }, 3000);
  } else {
    console.log(`${TAG} apply-verbatim ${sn}: complete raster — on-device save_map/regen overgeslagen`);
  }
  return { pushed: true, validation };
}

/**
 * Push de geïmporteerde kaart naar de maaier via DEZELFDE route als de admin
 * "Import bundle" knop: lees de (server-side gegenereerde) bundel → parseBundle
 * → write_map_files (apply-verbatim, geen realign). Wordt fire-and-forget
 * aangeroepen; bij offline blijft de pending-vlag staan zodat
 * `onMowerConnected` het opnieuw probeert zodra de maaier verbindt.
 *
 * @param filename optionele bundel-naam; standaard de nieuwste backup van de SN.
 */
export async function pushMapToMowerVerbatim(
  sn: string,
  filename?: string,
): Promise<{ ok: boolean; offline?: boolean; noBundle?: boolean; noFiles?: boolean; invalidMap?: boolean }> {
  if (!sn.startsWith('LFIN')) return { ok: false };

  let buf: Buffer | null = null;
  try {
    const { listBackups, readBackup } = await import('../services/portableBackup.js');
    const fname = filename ?? listBackups(sn)[0]?.filename;
    if (!fname) return { ok: false, noBundle: true };
    buf = readBackup(sn, fname);
  } catch (err) {
    console.warn(`${TAG} pushMapToMowerVerbatim: backup lezen mislukt voor ${sn}:`, err);
    return { ok: false, noBundle: true };
  }
  if (!buf) return { ok: false, noBundle: true };

  let mowerFiles: {
    csvFiles: Record<string, string>;
    chargingStationYaml?: string | null;
    mapFilesText?: Record<string, string>;
    mapFilesB64?: Record<string, string>;
  } | undefined;
  try {
    const { parseBundle } = await import('../services/portableMap.js');
    const parsed = await parseBundle(buf);
    mowerFiles = parsed.mowerFiles;
  } catch (err) {
    console.warn(`${TAG} pushMapToMowerVerbatim: parseBundle mislukt voor ${sn}:`, err);
    return { ok: false, noFiles: true };
  }
  if (!mowerFiles?.csvFiles || Object.keys(mowerFiles.csvFiles).length === 0) {
    return { ok: false, noFiles: true };
  }

  if (!isDeviceOnline(sn)) return { ok: false, offline: true };

  const res = applyVerbatimToMower(sn, mowerFiles);
  if (!res.pushed) {
    console.error(`${TAG} pushMapToMowerVerbatim: ${sn} GEBLOKKEERD door kaartvalidatie — bundel NIET gepusht, maaier ongemoeid`);
    return { ok: false, invalidMap: true };
  }
  console.log(`${TAG} Kaart naar ${sn} gepusht via apply-verbatim (write_map_files)`);
  return { ok: true };
}

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
      // NB: deze functie wordt sinds de "cloud-identiek" beslissing in
      // broker.ts (geen proactieve commando's bij connect) nergens meer
      // aangeroepen. De hersync van een offline gekarteerde kaart loopt via de
      // app (pendingMapSync.ts), die get_map_outline "all" stuurt zodra ze weer
      // een server heeft — zoals de officiële app dat ook doet.

      // Eerste portable snapshot: heeft deze mower al maps maar bestaat er nog
      // geen backup van, maak er meteen één. Idempotent (skipt als er al een
      // backup is) en no-opt als de DB nog geen charger-anchor/work-polygon
      // heeft. Vertraagd zodat de maaier z'n kaarten eerst naar de DB uploadt.
      setTimeout(() => {
        void import('../services/portableBackup.js')
          .then(({ ensureInitialBackup }) => ensureInitialBackup(sn))
          .then((entry) => {
            if (entry) console.log(`${TAG} initial snapshot saved for ${sn}: ${entry.filename}`);
          })
          .catch((e) => console.warn(`${TAG} initial snapshot failed for ${sn}: ${(e as Error)?.message ?? e}`));
      }, 25000);

      // Door de gebruiker gekozen para-settings (o.a. obstacle_avoidance_sensitivity)
      // opnieuw toepassen — de firmware persisteert ze niet over een reboot heen.
      republishParaSettings(sn);
      republishCoveragePlannerRadius(sn);
      republishObstacleDetection(sn);
      void republishSeamFix(sn).catch((e) => console.warn(`${TAG} republishSeamFix failed for ${sn}: ${(e as Error)?.message ?? e}`));

      // BETA SAFETY (Option A): GEEN automatische map-push naar de maaier. Een
      // cloud-import/factory-reset herstelt alleen de server/app-kopie; de
      // maaier behoudt zijn eigen kaarten. Een legacy pending-vlag wordt gewist
      // en genegeerd — herstel naar de maaier is nu een bewuste /admin-actie
      // (de "ook naar de maaier schrijven" opt-in). Zo overschrijven we nooit
      // automatisch een werkende kaart op de maaier.
      if (hasPendingMapSync(sn)) {
        clearPendingMapSync(sn);
        console.log(`${TAG} ${sn}: pending map-push genegeerd (beta: auto-push uit) — herstel naar de maaier desgewenst via /admin "ook naar de maaier schrijven"`);
      }

      // OpenNova firmware detectie: alleen onze firmware heeft extended_commands.py
      publishToExtended(sn, { is_opennova: {} });
      const onON = (data: Record<string, unknown>) => {
        if (data.is_opennova_respond) {
          equipmentRepo.setOpenNova(sn);
          console.log(`${TAG} OpenNova firmware confirmed for ${sn}`);
          offExtendedResponse(sn, onON);
        }
      };
      onExtendedResponse(sn, onON);
      setTimeout(() => offExtendedResponse(sn, onON), 5000);
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

// ── Auto portable-snapshot on map change ─────────────────────────────────────
// Debounced per SN: when the mower commits a CHANGED map to the DB we wait for
// the burst (map0 + map1 + unicom all arrive within a few seconds) to settle,
// then create one portable backup. createBackup reads the DB + live mower files,
// so by firing after the commit (not on the MQTT respond) the data is present.
const _autoSnapTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleAutoSnapshot(sn: string): void {
  const existing = _autoSnapTimers.get(sn);
  if (existing) clearTimeout(existing);
  _autoSnapTimers.set(sn, setTimeout(() => {
    _autoSnapTimers.delete(sn);
    // Dynamic import: portableBackup imports from this module, so a static
    // import would be circular.
    void import('../services/portableBackup.js')
      .then(({ createBackup }) => createBackup(sn, 'auto-save_map'))
      .then((entry) => {
        if (entry) console.log(`${TAG} auto-snapshot saved for ${sn}: ${entry.filename}`);
        else console.warn(`${TAG} auto-snapshot skipped for ${sn} (no DB map/charger anchor yet)`);
      })
      .catch((e) => console.warn(`${TAG} auto-snapshot failed for ${sn}: ${(e as Error)?.message ?? e}`));
  }, 10000));
}

// ── Device responses (Dart/Receive_mqtt/<SN>) ────────────────────────────────

type DeviceResponseHandler = (data: Record<string, unknown>) => void;
const _devResponseHandlers = new Map<string, Set<DeviceResponseHandler>>();

export function onDeviceResponse(sn: string, handler: DeviceResponseHandler): void {
  if (!_devResponseHandlers.has(sn)) _devResponseHandlers.set(sn, new Set());
  _devResponseHandlers.get(sn)!.add(handler);
}

export function offDeviceResponse(sn: string, handler: DeviceResponseHandler): void {
  _devResponseHandlers.get(sn)?.delete(handler);
}

/** Call from broker.ts when a parsed message arrives on Dart/Receive_mqtt/<SN>. */
export function handleDeviceResponse(sn: string, parsed: Record<string, unknown>): void {
  const handlers = _devResponseHandlers.get(sn);
  if (!handlers || handlers.size === 0) return;
  for (const h of handlers) {
    try { h(parsed); } catch { /* ignore */ }
  }
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
      // Forward to dashboard planned path cache. Dynamic import (not require —
      // server is ESM): dashboard.js imports from mapSync.js, so a static
      // import would be circular.
      const respondData = parsed[command] as Record<string, unknown>;
      if (respondData && typeof respondData === 'object') {
        void import('../routes/dashboard.js')
          .then(({ handlePlannedPathRespond }) => handlePlannedPathRespond(sn, respondData))
          .catch(() => { /* cache best-effort */ });
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

  const _newArea = JSON.stringify(localPoints);
  const _prevRow = mapRepo.findByIdAndMower(mapId, sn);
  mapRepo.upsert({
    map_id: mapId,
    mower_sn: sn,
    map_name: displayName,
    map_area: _newArea,
    map_max_min: JSON.stringify(bounds),
  });

  console.log(`${TAG} Kaart "${displayName}" (${mapId}) opgeslagen: ${localPoints.length} punten (lokaal), bounds: ${JSON.stringify(bounds)}`);

  // Auto-snapshot a portable backup when the map content actually CHANGED (a
  // real save), not on every reconnect/resync. Debounced per SN so a multi-map
  // sync (map0 + map1 + unicom) coalesces into ONE snapshot, fired after the
  // last commit — by then the DB has the data createBackup needs. This replaces
  // the old broker.ts save_recharge_pos_respond trigger, which fired ~4s before
  // the map reached the DB and silently skipped ("no work polygon in DB").
  if (!_prevRow || _prevRow.map_area !== _newArea) {
    scheduleAutoSnapshot(sn);
  }

  // Stuur live outline naar dashboard via Socket.io (GPS + lokaal)
  outlineEmitter?.(sn, points, localPoints);
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

const MAPS_STORAGE = path.resolve(process.env.STORAGE_PATH ?? './storage', 'maps');

/**
 * Patch the charging_pose inside `<sn>_latest.zip`'s map_info.json so the app's
 * queryEquipmentMap (which sources the charger MARKER from this ZIP, not the DB
 * polygon) immediately reflects a re-anchored charger pose. The mower's own
 * map_info.json is rewritten by the `recalibrate_charging_pose` extended command;
 * this keeps the server-cached ZIP in sync without waiting for a full re-upload.
 * Updates both csv_file/ and x3_csv_file/ copies when present. Returns true if
 * the ZIP existed and at least one map_info.json entry was patched.
 */
export function patchLatestZipChargingPose(
  sn: string,
  pose: { x: number; y: number; orientation: number },
): boolean {
  // Path-traversal guard: `sn` becomes part of filesystem paths below. Restrict
  // it to safe serial-number characters (no `.` or `/`) so it cannot escape
  // MAPS_STORAGE. Real SNs are like "LFIN2230700238".
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sn)) {
    console.warn(`[reanchor] patchLatestZipChargingPose: rejecting unsafe sn '${sn}'`);
    return false;
  }
  const zipPath = path.join(MAPS_STORAGE, `${sn}_latest.zip`);
  if (!fs.existsSync(zipPath)) return false;
  const tmpDir = path.join(MAPS_STORAGE, `tmp_chgpose_${sn}_${process.pid}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    let patched = false;
    for (const entry of ['csv_file/map_info.json', 'x3_csv_file/map_info.json']) {
      try {
        // execFileSync (no shell) — zipPath/entry never reach a shell, so an SN
        // with shell metacharacters cannot inject commands.
        execFileSync('unzip', ['-o', '-q', zipPath, entry, '-d', tmpDir], { stdio: 'ignore' });
      } catch { continue; } // entry not in this ZIP
      const infoPath = path.join(tmpDir, entry);
      if (!fs.existsSync(infoPath)) continue;
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
      info.charging_pose = { x: pose.x, y: pose.y, orientation: pose.orientation };
      fs.writeFileSync(infoPath, JSON.stringify(info, null, 3) + '\n');
      // `zip <existing> <entry>` (cwd = tmpDir) replaces just that entry in place.
      execFileSync('zip', ['-q', zipPath, entry], { cwd: tmpDir, stdio: 'ignore' });
      patched = true;
    }
    return patched;
  } catch (err) {
    console.error(`[reanchor] ${sn}: latest-zip charging_pose patch failed`, err);
    return false;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
