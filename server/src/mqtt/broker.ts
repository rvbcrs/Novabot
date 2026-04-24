import net from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
// aedes v1.0.0 is ESM-only — loaded lazily inside startMqttBroker() via dynamic import
type AedesBroker = { publish: (packet: AedesPublishPacket, cb: (err?: Error | null) => void) => void; handle: unknown; on: (event: string, listener: (...args: any[]) => void) => void; close: (cb?: () => void) => void; connectedClients: number };
type Client = { id: string; conn?: { remoteAddress?: string }; [key: string]: unknown };
type AedesPublishPacket = { topic: string; payload: Buffer | string; qos: 0 | 1 | 2; retain: boolean; cmd?: string; dup?: boolean };
import { db } from '../db/database.js';
import { deviceRepo, equipmentRepo, mapRepo } from '../db/repositories/index.js';
import { DeviceRegistryRow } from '../types/index.js';
import { startMqttBridge } from '../proxy/mqttBridge.js';
import { tryDecrypt } from './decrypt.js';
import { startHomeAssistantBridge, forwardToHomeAssistant, publishDeviceOnline, publishDeviceOffline } from './homeassistant.js';
import { updateDeviceData, clearDeviceData, deviceCache } from './sensorData.js';
import { isDemoMode } from '../services/demoSimulator.js';
import { forwardToDashboard, emitDeviceOnline, emitDeviceOffline, pushMqttLog, emitOtaEvent, emitPinEvent, emitExtendedEvent, emitCommandRespond } from '../dashboard/socketHandler.js';
import { initMapSync, handleMapMessage, handleExtendedResponse, handleDeviceResponse, publishToExtended, onExtendedResponse, offExtendedResponse, publishEncryptedOnTopic, notifyRespond } from './mapSync.js';

const PROXY_MODE = process.env.PROXY_MODE ?? 'local';

// ANSI kleuren voor terminal logging
const C = {
  reset:   '\x1b[0m',
  green:   '\x1b[32m',   // maaier (LFIN)
  yellow:  '\x1b[33m',   // charger (LFIC / ESP32_)
  blue:    '\x1b[34m',   // app
  dim:     '\x1b[2m',    // gedimde tekst
  red:     '\x1b[31m',   // errors
  cyan:    '\x1b[36m',   // system events
};

/** Bepaal kleur op basis van clientId / SN */
function clientColor(clientId: string): string {
  if (/^[0-9a-f]{8}-/i.test(clientId) || clientId.includes('@') || clientId.startsWith('eyJ')) return C.blue;
  if (clientId.startsWith('LFIN') || clientId.includes('LFIN')) return C.green;
  if (clientId.startsWith('LFIC') || clientId.startsWith('ESP32_') || clientId.includes('LFIC')) return C.yellow;
  return C.reset;
}

/** Kleur op basis van topic SN */
function topicColor(topic: string): string {
  if (topic.includes('LFIN')) return C.green;
  if (topic.includes('LFIC')) return C.yellow;
  return C.reset;
}

// Matcht standaard MAC-notaties: AA:BB:CC:DD:EE:FF of AA-BB-CC-DD-EE-FF
const MAC_SEP_RE  = /([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}/;
// Matcht 12 aaneengesloten hex-tekens (geen separator), bijv. AABBCCDDEEFF
const MAC_FLAT_RE = /(?<![0-9A-Fa-f])([0-9A-Fa-f]{12})(?![0-9A-Fa-f])/;
// Serienummer patroon: bijv. LFIC1230700004 of LFIN...
const SN_RE       = /LFI[A-Z][0-9]+/;

/**
 * Sanitize MQTT CONNECT packet Connect Flags byte.
 *
 * The Novabot app sends Will QoS = 1 with Will Flag = 0, which violates MQTT spec
 * [MQTT-3.1.2-11]. mqtt-packet (used by aedes) strictly validates this and rejects
 * the connection with: "Will QoS must be set to zero when Will Flag is set to 0"
 *
 * This function fixes the raw CONNECT packet bytes before aedes parses them:
 * if Will Flag (bit 2) is 0, clear Will QoS (bits 3-4) and Will Retain (bit 5).
 *
 * MQTT CONNECT packet layout:
 *   Byte 0:    Fixed header (0x10)
 *   Byte 1-N:  Remaining Length (variable-length encoding, 1-4 bytes)
 *   After RL:  Protocol Name (length-prefixed: 00 04 "MQTT" = 6 bytes)
 *              Protocol Level (1 byte: 0x04 for 3.1.1, 0x05 for 5.0)
 *              Connect Flags (1 byte) <-- this is what we patch
 */
function sanitizeConnectFlags(buf: Buffer): void {
  if (buf.length < 2 || buf[0] !== 0x10) return; // not a CONNECT packet

  // Decode variable-length Remaining Length to find where the payload starts
  let offset = 1;
  let multiplier = 1;
  let remainingLength = 0;
  for (let i = 0; i < 4; i++) {
    if (offset >= buf.length) return;
    const byte = buf[offset++];
    remainingLength += (byte & 0x7F) * multiplier;
    multiplier *= 128;
    if ((byte & 0x80) === 0) break;
  }
  // offset now points to the start of the Variable Header
  // Verify the packet is large enough to contain the declared payload
  if (offset + remainingLength > buf.length) return;

  // Variable Header: Protocol Name (2 bytes length + N bytes string) + Protocol Level (1 byte)
  if (offset + 2 >= buf.length) return;
  const protoNameLen = (buf[offset] << 8) | buf[offset + 1];
  const connectFlagsOffset = offset + 2 + protoNameLen + 1; // +2 length prefix, +N name, +1 protocol level

  if (connectFlagsOffset >= buf.length) return;

  const flags = buf[connectFlagsOffset];
  const willFlag   = (flags & 0x04) !== 0; // bit 2
  const willQos    = (flags & 0x18);       // bits 3-4 (mask 0x18)
  const willRetain = (flags & 0x20);       // bit 5

  if (!willFlag && (willQos || willRetain)) {
    // Clear Will QoS (bits 3-4) and Will Retain (bit 5) — mask = ~(0x18 | 0x20) = ~0x38 = 0xC7
    buf[connectFlagsOffset] = flags & 0xC7;
  }
}


function normalizeMac(raw: string): string {
  const clean = raw.replace(/[:\-]/g, '').toUpperCase();
  return clean.match(/.{2}/g)!.join(':');
}

function isAppClient(clientId: string): boolean {
  // App MQTT clients hebben een UUID@appUser_SN patroon of bevatten een JWT prefix
  return clientId.includes('@') || clientId.startsWith('eyJ');
}

/**
 * Bereken BLE MAC-adres vanuit WiFi STA MAC.
 * ESP32 wijst MACs opeenvolgend toe: STA = base, AP = base+1, BLE = base+2.
 * Dit geldt ALLEEN voor ESP32 devices (chargers).
 * De maaier (Horizon X3 + Broadcom BCM43438/AP6212) volgt dit patroon NIET.
 */
function wifiStaToBle(staMac: string): string {
  const bytes = staMac.split(':').map(b => parseInt(b, 16));
  // +2 op het laatste byte, carry propageren
  bytes[5] += 2;
  for (let i = 5; i > 0 && bytes[i] > 255; i--) {
    bytes[i] -= 256;
    bytes[i - 1] += 1;
  }
  return bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
}

// Flexibele MAC regex voor ARP output — matcht zowel gepadde (0E:E4:05) als ongepadde (e:e4:5) notatie
const ARP_MAC_RE = /([0-9A-Fa-f]{1,2}[:\-]){5}[0-9A-Fa-f]{1,2}/;

/**
 * Normaliseer een MAC-adres uit ARP output (kan ongepadde octetten bevatten).
 * Bijv. "e:e4:5:92:2b:e3" → "0E:E4:05:92:2B:E3"
 */
function normalizeArpMac(raw: string): string {
  return raw.split(/[:\-]/).map(b => b.toUpperCase().padStart(2, '0')).join(':');
}

/**
 * Zoek het WiFi MAC-adres op via de ARP-tabel voor een gegeven IP-adres.
 * Werkt op macOS (`arp -n`) en Linux (`ip neigh show` of `arp -n`).
 * Retourneert het genormaliseerde MAC of null.
 */
function lookupArpMac(ip: string): Promise<string | null> {
  return new Promise(resolve => {
    // Probeer eerst `ip neigh` (Linux), daarna `arp -n` (macOS/Linux)
    const tryArp = () => {
      execFile('arp', ['-n', ip], { timeout: 2000 }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const m = ARP_MAC_RE.exec(stdout);
        if (m) return resolve(normalizeArpMac(m[0]));
        resolve(null);
      });
    };

    execFile('ip', ['neigh', 'show', ip], { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) return tryArp();
      const m = ARP_MAC_RE.exec(stdout);
      if (m) return resolve(normalizeArpMac(m[0]));
      tryArp();
    });
  });
}

/**
 * Auto-detect BLE MAC via ARP lookup op het remote IP van een MQTT-verbinding.
 * Slaat WiFi STA MAC + berekend BLE MAC op in device_registry.
 *
 * De ESP32 BLE=STA+2 formule werkt ALLEEN voor chargers (LFIC*).
 * Maaiers (LFIN*) gebruiken een Broadcom BCM43438 (AP6212) WiFi-chip die
 * een ander MAC-patroon heeft. Bovendien kan de maaier een gerandomiseerd
 * WiFi STA MAC gebruiken (locally-administered bit set). ARP-detectie wordt
 * daarom overgeslagen voor maaiers — hun BLE MAC moet via BLE provisioning
 * of handmatig (admin API) worden geregistreerd, net als in de cloud (factory import).
 */
async function autoDetectBleMac(sn: string, remoteIp: string): Promise<void> {
  // Skip loopback / IPv6 / al bekende MACs
  if (!remoteIp || remoteIp === '127.0.0.1' || remoteIp === '::1') return;

  // Alleen ESP32 devices (chargers) ondersteunen de STA+2 formule.
  // Maaiers (LFIN*) hebben een ander WiFi-chipset — ARP → BLE werkt daar niet.
  if (!sn.startsWith('LFIC')) return;

  const cleanIp = remoteIp.replace(/^::ffff:/, ''); // IPv4-mapped IPv6 → IPv4

  // Check of we al een BLE MAC hebben voor dit SN
  const existing = deviceRepo.findBySn(sn);
  if (existing?.mac_address) return; // Al bekend

  const wifiMac = await lookupArpMac(cleanIp);
  if (!wifiMac) {
    console.log(`${C.dim}[ARP] Kon WiFi MAC niet vinden voor ${sn} (IP: ${cleanIp})${C.reset}`);
    return;
  }

  const bleMac = wifiStaToBle(wifiMac);
  console.log(`${C.cyan}[ARP] Auto-detected MAC voor ${sn}: WiFi STA=${wifiMac} → BLE=${bleMac}${C.reset}`);

  // Sla BLE MAC op in device_registry (update bestaand record)
  deviceRepo.updateMacIfMissingBySn(sn, bleMac);

  // Sla ook op in equipment tabel
  equipmentRepo.updateMacAddress(sn, bleMac, true);
}

function extractMac(s: string): string | null {
  // Geen MAC extraheren uit app-client clientIds — hun UUIDs bevatten hex-reeksen
  // die als MAC geïnterpreteerd worden maar dat niet zijn (bijv. c4303f5a907a)
  if (isAppClient(s)) return null;
  const m = MAC_SEP_RE.exec(s);
  if (m) return normalizeMac(m[0]);
  const m2 = MAC_FLAT_RE.exec(s);
  if (m2) return normalizeMac(m2[0]);
  return null;
}

function extractSn(s: string): string | null {
  const m = SN_RE.exec(s);
  return m ? m[0] : null;
}

function upsertDevice(clientId: string, sn: string | null, mac: string | null, username: string | null) {
  deviceRepo.upsertDevicePreserving(clientId, sn, mac, username);

  // Koppel mac_address ook terug aan de equipment rij als die al bestaat
  // ALLEEN voor mowers — charger MAC mag NOOIT in equipment.mac_address terechtkomen.
  // De Novabot app gebruikt equipment.macAddress voor BLE scan matching bij mapping.
  // Als daar de charger MAC staat, vindt de app de maaier niet via BLE.
  if (sn && mac && sn.startsWith('LFIN')) {
    equipmentRepo.updateMacAddress(sn, mac, true);
  }

  // Equipment wordt automatisch aangemaakt door autoBindDevice() in onMowerConnected()
  // (met user_id + auto-pair). Hier NIET meer aanmaken — dat gaf lege user_id records.
}

// Bijhouden welke clients al gelogd zijn (clientId -> timestamp eerste connect)
const seenClients = new Map<string, number>();

// Track wanneer de app een commando stuurt per SN (voor respond delay matching)
const pendingAppCommands = new Map<string, number>();

// Onderdruk herhaalde up_status_info logs (toon alleen elke 30e keer)
let statusLogCounter = 0;

// Bijhouden welke SN's momenteel verbonden zijn (SN -> Set van clientId's)
const onlineBySn = new Map<string, Set<string>>();

// Laatste PUBLISH tijdstip per SN, voor stale-detection. Zonder deze check
// toont de app een mower als online (charging, 100%, etc.) tot aedes's
// heartbeat-timeout (120s) de client opruimt. Als de mower abrupt uitgaat
// (power off, battery pull) sturen we niks meer maar onlineBySn blijft
// gepopuleerd tot de keepalive expireert — user ziet stale UI.
//
// De sweeper hieronder markeert een SN offline als er >45s geen PUBLISH
// is gezien. De mower reports state elke ~2s, dus 45s stilte = echt dood.
const lastPublishBySn = new Map<string, number>();
const STALE_SN_MS = 45_000;

// Raw TCP sockets per SN opslaan voor directe PUBLISH bypass
const rawSocketBySn = new Map<string, net.Socket>();

// Tijdelijk blokkeerde SNs — gebruikt door "Delete + Banish" flow wanneer
// user een device via Novabot-app wil re-provisionen. Device blijft op onze
// server binnenkomen tot z'n MQTT addr verandert. Ban voorkomt dat
// auto-accept de DB weer vult na delete. Map: sn → expiry timestamp.
const bannedSns = new Map<string, number>();

export function banishSn(sn: string, durationMs: number = 30 * 60 * 1000): void {
  const expiry = Date.now() + durationMs;
  bannedSns.set(sn, expiry);
  console.log(`[BAN] ${sn} banned for ${Math.round(durationMs / 60000)}min (until ${new Date(expiry).toISOString()})`);
  // Force-disconnect eventuele lopende sessie
  try { forceDisconnectDevice(sn); } catch { /* ignore */ }
}

export function unbanSn(sn: string): void {
  bannedSns.delete(sn);
  console.log(`[BAN] ${sn} unbanned`);
}

export function isSnBanned(sn: string): boolean {
  const expiry = bannedSns.get(sn);
  if (expiry == null) return false;
  if (Date.now() >= expiry) {
    bannedSns.delete(sn);
    return false;
  }
  return true;
}

export function listBannedSns(): Array<{ sn: string; expiresAt: string; msRemaining: number }> {
  const now = Date.now();
  const result: Array<{ sn: string; expiresAt: string; msRemaining: number }> = [];
  for (const [sn, expiry] of bannedSns) {
    if (expiry > now) {
      result.push({ sn, expiresAt: new Date(expiry).toISOString(), msRemaining: expiry - now });
    }
  }
  return result;
}

// Track subscriptions per clientId → Set<topic>
const clientSubscriptions = new Map<string, Set<string>>();

/**
 * Schrijf een raw MQTT PUBLISH packet direct naar de TCP socket van een apparaat.
 * Omzeilt aedes volledig — voor debugging van delivery issues.
 */
export function writeRawPublish(sn: string, payload: Buffer, qos: 0 | 1 = 0): boolean {
  const socket = rawSocketBySn.get(sn);
  if (!socket || socket.destroyed) {
    console.error(`${C.red}[MQTT] Geen actieve socket voor ${sn}${C.reset}`);
    return false;
  }
  const topic = `Dart/Send_mqtt/${sn}`;
  const topicBuf = Buffer.from(topic, 'utf8');

  // Bouw MQTT PUBLISH packet handmatig
  const packetIdLen = qos > 0 ? 2 : 0;
  const remainingLen = 2 + topicBuf.length + packetIdLen + payload.length;

  // Remaining length encoding (variable byte integer)
  const rlBytes: number[] = [];
  let rl = remainingLen;
  do {
    let encodedByte = rl % 128;
    rl = Math.floor(rl / 128);
    if (rl > 0) encodedByte |= 0x80;
    rlBytes.push(encodedByte);
  } while (rl > 0);

  // Fixed header
  const fixedHeader = qos === 0 ? 0x30 : 0x32;

  // Assembleer het volledige packet
  const parts: Buffer[] = [
    Buffer.from([fixedHeader, ...rlBytes]),
    Buffer.from([topicBuf.length >> 8, topicBuf.length & 0xFF]),
    topicBuf,
  ];
  if (qos > 0) {
    // Packet ID (simpele counter)
    parts.push(Buffer.from([0x00, 0x01]));
  }
  parts.push(payload);

  const packet = Buffer.concat(parts);
  const sc = sn.startsWith('LFIN') ? C.green : C.yellow;
  console.log(`${sc}[MQTT] RAW PUBLISH ${payload.length}B → ${sn} (QoS ${qos})${C.reset}`);

  try {
    socket.write(packet);
    return true;
  } catch (err) {
    console.error(`${C.red}[MQTT] RAW PUBLISH failed: ${(err as Error).message}${C.reset}`);
    return false;
  }
}

/** Geeft true als het apparaat met dit SN momenteel verbonden is met de MQTT broker
 *  én niet meer dan STALE_SN_MS geleden een PUBLISH stuurde. Zonder die laatste
 *  check blijft de app "Charging 100%" tonen na een power-off totdat aedes
 *  z'n keepalive expireert (kan tot 2 min duren). */
export function isDeviceOnline(sn: string): boolean {
  const clients = onlineBySn.get(sn);
  if (clients === undefined || clients.size === 0) return false;
  const lastPub = lastPublishBySn.get(sn);
  if (lastPub != null && Date.now() - lastPub > STALE_SN_MS) return false;
  return true;
}

/**
 * Forceer disconnect van een apparaat — sluit de TCP socket.
 * Nodig wanneer de maaier een stale MQTT connectie heeft en een frisse
 * reconnect nodig heeft (bijv. vóór BLE re-provisioning).
 */
export function forceDisconnectDevice(sn: string): boolean {
  const socket = rawSocketBySn.get(sn);
  if (!socket || socket.destroyed) return false;
  console.log(`[MQTT] Force-disconnect ${sn} — socket sluiten voor schone reconnect`);
  socket.destroy();
  return true;
}

export async function startMqttBroker(): Promise<void> {
  // Gebruik createBroker() zodat broker.listen() wordt aangeroepen:
  // dit zet broker.closed = false en initialiseert de persistence.
  // Zonder dit retourneert de 'authenticate' stap in connectActions vroegtijdig
  // (if (client.broker.closed) return) zonder done() aan te roepen,
  // waardoor doConnack nooit wordt uitgevoerd.
  // aedes v1.0.0: `Aedes` is een named export, `createBroker` is een static method
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Aedes: AedesClass } = await import('aedes') as any;
  // heartbeatInterval verhoogd van default 60s naar 120s zodat de app tijdens
  // langere TCP reads van grote payloads (bijv. get_preview_cover_path_respond
  // ~26KB) niet per abuis door keepalive timeout wordt gedisconnect.
  const broker = await AedesClass.createBroker({
    heartbeatInterval: 120000,
  });

  // Initialiseer mapSync met de broker zodat we MQTT commands kunnen publiceren
  initMapSync(broker);

  // Diagnostiek: log elke message delivery naar subscribers
  // authorizeForward wordt aangeroepen VOORDAT een bericht naar een subscriber wordt geschreven.
  // Return packet om door te sturen, null om te blokkeren.
  broker.authorizeForward = (client: Client, packet: AedesPublishPacket) => {
    const topic = packet.topic;
    // Alleen Dart/Receive_mqtt deliveries naar de app verwerken
    if (isAppClient(client.id) && topic.startsWith('Dart/Receive_mqtt/')) {
      const payloadBuf = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);
      const sn = topic.split('/').pop() ?? '';
      const decrypted = sn ? tryDecrypt(payloadBuf, sn) : null;

      // Geen transformatie — maaier stuurt {"type":"xxx","message":{...}} formaat
      // en de app v2.4.0 mower handler verwacht EXACT dat formaat.
      // Gewoon doorsturen met logging.
      const preview = decrypted
        ? (decrypted.includes('ota_version_info') ? `[OTA] ${decrypted.slice(0, 200)}` : `[${payloadBuf.length}B]`)
        : `[encrypted ${payloadBuf.length}B]`;
      console.log(`${C.cyan}[FWD] → APP ${client.id.slice(0, 30)}... | ${topic} | ${preview}${C.reset}`);
      pushMqttLog({
        ts: Date.now(), type: 'forward', clientId: client.id, clientType: 'APP',
        sn: sn || null, direction: '→APP', topic,
        payload: preview, encrypted: !!decrypted,
      });
    }
    return packet;
  };

  // ── OTA Fix: intercepteer ota_upgrade_cmd van app → maaier ──
  // mqtt_node op de maaier zet type:"increment" als er een tz veld in het commando zit.
  // De app stuurt altijd tz mee. Door tz te verwijderen en type:"full" te forceren
  // voordat het bericht de maaier bereikt, werkt OTA weer correct.
  (broker as any).authorizePublish = (client: Client | null, packet: AedesPublishPacket, callback: (error?: Error | null) => void) => {
    // Race condition fix: de app stuurt een commando (bijv. get_map_list) en start
    // daarna pas de timeout listener. Op een lokaal netwerk antwoordt de maaier zo snel
    // dat het antwoord arriveert VOORDAT de listener actief is → timeout → "Get map failed".
    // Oplossing: vertraag ALLEEN de specifieke respond-berichten die een race condition
    // hebben (get_map_list_respond, start_navigation_respond, etc.) — niet ALLE berichten.
    // Reguliere status updates (report_state_*) worden onvertraagd doorgestuurd.
    if (client && packet.topic.startsWith('Dart/Receive_mqtt/LFIN') && !isAppClient(client.id)) {
      // Cloud-identiek: GEEN interceptie van get_map_list_respond of andere maaier→app berichten.
      // De echte Novabot cloud modificeert MQTT berichten niet — het is puur maaier↔app.
      // Map data komt via HTTP queryEquipmentMap, niet via MQTT manipulatie.
      const sn = packet.topic.split('/').pop() ?? '';
      let isRespondType = false;
      if (sn) {
        try {
          const payloadBuf = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);
          const decrypted = tryDecrypt(payloadBuf, sn);
          const json = decrypted ?? payloadBuf.toString('utf8');
          // Detect respond-type berichten voor selective delay
          isRespondType = json.includes('_respond');
        } catch { /* parse error, doorsturen ongewijzigd */ }
      }
      // Respond-berichten: alleen vertragen als de app RECENT (< 2s geleden)
      // een bijbehorend commando stuurde. Dit voorkomt onnodige delay op
      // unsolicited responds (bijv. report_state_map_outline na boot).
      if (isRespondType && sn) {
        const pendingTs = pendingAppCommands.get(sn);
        const age = pendingTs ? Date.now() - pendingTs : Infinity;
        if (age < 2000) {
          // App stuurde recent een commando — vertraag response zodat listener klaar is
          setTimeout(() => callback(null), 500);
          pendingAppCommands.delete(sn);
        } else {
          callback(null);
        }
      } else {
        callback(null);
      }
      return;
    }

    if (client && packet.topic.startsWith('Dart/Send_mqtt/LFIN') && isAppClient(client.id)) {
      const payloadBuf = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);
      const sn = packet.topic.split('/').pop() ?? '';
      console.log(`${C.blue}[MQTT] PUBLISH  ${client.id.slice(0, 30)} →DEV ${packet.topic}  [app→mower ${payloadBuf.length}B]${C.reset}`);
      if (sn) {
        // Registreer dat de app een commando stuurt — voor respond delay matching
        pendingAppCommands.set(sn, Date.now());
        const decrypted = tryDecrypt(payloadBuf, sn);
        if (decrypted) {
          console.log(`${C.blue}[MQTT] APP→DEV  ${sn}: ${decrypted.slice(0, 300)}${C.reset}`);
          // Log naar admin console
          pushMqttLog({
            ts: Date.now(), type: 'publish', clientId: client.id,
            clientType: 'APP', sn, direction: '→DEV', topic: packet.topic,
            payload: decrypted, encrypted: true,
          });
          try {
            const parsed = JSON.parse(decrypted);
            if (parsed.ota_upgrade_cmd) {
              const originalTz = parsed.ota_upgrade_cmd.tz;
              const originalType = parsed.ota_upgrade_cmd.type;
              // Verwijder tz en forceer type:"full"
              delete parsed.ota_upgrade_cmd.tz;
              parsed.ota_upgrade_cmd.type = 'full';
              const modified = JSON.stringify(parsed);
              console.log(`\x1b[38;5;208m[OTA-FIX] INTERCEPTED! tz="${originalTz}"→removed, type="${originalType}"→"full"\x1b[0m`);
              console.log(`\x1b[38;5;208m[OTA-FIX] Modified payload: ${modified}\x1b[0m`);

              // Herversleutel met dezelfde AES key
              const KEY_PREFIX = 'abcdabcd1234';
              const IV = Buffer.from('abcd1234abcd1234', 'utf8');
              const key = Buffer.from(KEY_PREFIX + sn.slice(-4), 'utf8');
              const plaintext = Buffer.from(modified, 'utf8');
              const padded = Buffer.alloc(Math.ceil(plaintext.length / 16) * 16, 0);
              plaintext.copy(padded);
              const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
              cipher.setAutoPadding(false);
              const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
              packet.payload = encrypted;
              console.log(`\x1b[38;5;208m[OTA-FIX] Re-encrypted: ${encrypted.length}B → maaier\x1b[0m`);
            } else if ('delete_map' in parsed) {
              // ── delete_map: app verwijdert kaart op maaier ──
              // Verwijder ook uit onze DB, anders stuurt get_map_list_respond
              // de kaart steeds opnieuw naar de app.
              const delReq = parsed.delete_map as { map_name?: string; map_type?: string } | undefined;
              const delName = delReq?.map_name;
              if (delName && sn) {
                // Leid prefix af (bv. "map1_work.csv" → "map1", "map1" → "map1")
                // en verwijder alles wat deze prefix refereert: work map, obstakels
                // EN unicoms die map1 als endpoint hebben (*map1to* of *tomap1_*).
                const prefixMatch = delName.match(/^(map\d+)/);
                const prefix = prefixMatch ? prefixMatch[1] : null;
                if (prefix) {
                  const deleted = mapRepo.deleteByPrefix(sn, prefix);
                  for (const d of deleted) {
                    console.log(`${C.cyan}[MAP-PROXY] delete_map: verwijderd uit DB: map_id=${d.map_id} map_name=${d.map_name}${C.reset}`);
                  }
                }
              } else if (!delName && sn) {
                // Geen specifieke map_name → verwijder alle maps voor deze maaier
                mapRepo.deleteByMowerSn(sn);
                console.log(`${C.cyan}[MAP-PROXY] delete_map: alle maps verwijderd uit DB voor ${sn}${C.reset}`);
              }
              console.log(`${C.cyan}[MAP-PROXY] delete_map voor ${sn} map=${delName ?? 'ALL'} — doorsturen naar maaier${C.reset}`);
            } else if ('get_preview_cover_path' in parsed || 'get_map_plan_path' in parsed) {
              // ── Stock mqtt_node buffer overflow workaround ──
              // Stock mqtt_node crasht met `*** buffer overflow detected ***` (glibc
              // __fortify_fail) bij get_preview_cover_path / get_map_plan_path wanneer
              // de JSON file groter is dan ~8 KB. De firmware serialiseert het
              // bestand byte-voor-byte als JSON int array (file_len bytes → ~4× JSON).
              // Workaround: blokkeer het commando naar de mower en haal de data op
              // via onze extended_commands.py backchannel die geen last heeft van
              // deze bug. Herpak als wrapped respond voor de app.
              const cmd = 'get_preview_cover_path' in parsed ? 'get_preview_cover_path' : 'get_map_plan_path';
              const respondCmd = `${cmd}_respond` as const;
              console.log(`${C.cyan}[PATH-INTERCEPT] ${cmd} geblokkeerd (stock mqtt_node overflow) — ophalen via extended channel${C.reset}`);

              // Register handler BEFORE sending request (race-free)
              const timeout = setTimeout(() => {
                offExtendedResponse(sn, handler);
                console.warn(`${C.red}[PATH-INTERCEPT] Geen antwoord van extended_commands voor ${cmd} binnen 10s${C.reset}`);
                // Fallback: stuur result=0 zodat app niet blijft hangen
                publishEncryptedOnTopic(`Dart/Receive_mqtt/${sn}`, sn, {
                  message: { result: 0, value: null },
                  type: respondCmd,
                });
              }, 10_000);

              const handler = (data: Record<string, unknown>) => {
                const respondData = data[respondCmd] as { result?: number; value?: unknown; error?: string } | undefined;
                if (!respondData) return;
                clearTimeout(timeout);
                offExtendedResponse(sn, handler);
                console.log(`${C.cyan}[PATH-INTERCEPT] ${respondCmd} ontvangen van extended, doorsturen naar app${C.reset}`);

                // Vul de dashboard cache zodat de OpenNova app (en Novabot app)
                // deze data ook via GET /api/dashboard/planned-path/:sn of
                // /preview-path/:sn kan ophalen. Anders valt de app terug op
                // rechte direction stripes tijdens mowing.
                if (respondData.value && typeof respondData.value === 'object') {
                  try {
                    const { handlePlannedPathRespond, handlePreviewPathRespond } = require('../routes/dashboard.js');
                    if (cmd === 'get_map_plan_path') {
                      handlePlannedPathRespond(sn, respondData.value as Record<string, unknown>);
                    } else {
                      handlePreviewPathRespond(sn, respondData.value as Record<string, unknown>);
                    }
                  } catch (e) {
                    console.warn(`${C.red}[PATH-INTERCEPT] Cache update faalde: ${(e as Error).message}${C.reset}`);
                  }
                }

                // App-native format (bevestigd via blutter analyse):
                //   {type, message:{result, value:{data: [byte1,byte2,...]}}}
                // De Novabot Flutter app leest `message.value.data` als List<int>,
                // decodeert UTF-8 → JSON en dat is de echte path data.
                // Stock mqtt_node doet hetzelfde — wij moeten dat matchen.
                let valueField: Record<string, unknown> = {};
                if (respondData.value != null && typeof respondData.value === 'object') {
                  const contentBytes = Buffer.from(JSON.stringify(respondData.value), 'utf-8');
                  valueField = { data: Array.from(contentBytes) };
                }
                publishEncryptedOnTopic(`Dart/Receive_mqtt/${sn}`, sn, {
                  message: { result: respondData.result ?? 0, value: valueField },
                  type: respondCmd,
                });
              };
              onExtendedResponse(sn, handler);

              // Request data via extended channel (no AES, separate topic)
              publishToExtended(sn, { [cmd]: parsed[cmd] ?? {} });

              // BLOKKEER het originele commando richting mower — maar NIET via callback(Error)
              // want dat disconnect de app-client. In plaats daarvan routeren we naar een
              // dummy topic waar de mower niet op subscribed.
              packet.topic = `BLOCKED/${packet.topic}`;
              callback(null);
              return;
            } else if ('get_map_list' in parsed) {
              // ── get_map_list: doorsturen naar maaier ──
              // Maaier antwoordt met get_map_list_respond direct naar de app (ongewijzigd).
              // Map data voor de app komt via HTTP queryEquipmentMap, niet via MQTT.
              console.log(`${C.cyan}[MAP-PROXY] get_map_list voor ${sn} — doorsturen naar maaier${C.reset}`);
            } else if ('get_map_outline' in parsed) {
              // get_map_outline: doorsturen naar maaier, NIET intercepteren.
              // De maaier antwoordt zelf met report_state_map_outline.
              // Eerder intercepteerden we dit, maar dat interfereert met de
              // Novabot app's uploadMapToServce flow na save_map.
              const outlineReq = parsed.get_map_outline as { map_id?: string; map_name?: string } | undefined;
              const mapId = outlineReq?.map_id ?? outlineReq?.map_name;
              console.log(`${C.cyan}[MAP-PROXY] get_map_outline voor ${sn} map=${mapId} — doorsturen naar maaier${C.reset}`);

              // Commando wordt doorgestuurd naar maaier (geen interceptie meer)
            } else {
              console.log(`\x1b[38;5;208m[OTA-FIX] Geen ota_upgrade_cmd, doorsturen ongewijzigd\x1b[0m`);
            }
          } catch (e) {
            console.log(`\x1b[38;5;208m[OTA-FIX] Parse error: ${(e as Error).message}, doorsturen ongewijzigd\x1b[0m`);
          }
        } else {
          console.log(`\x1b[38;5;208m[OTA-FIX] Decrypt mislukt, doorsturen ongewijzigd\x1b[0m`);
        }
      }
    }
    callback(null);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  broker.authenticate = (client: Client, username: Readonly<string | undefined>, password: Readonly<Buffer | undefined>, callback: any) => {
    const clientId  = client.id ?? '';
    const user      = username ?? '';
    const pass      = password?.toString() ?? '';

    const sn  = extractSn(clientId) ?? extractSn(user);
    const mac = extractMac(clientId) ?? extractMac(user) ?? extractMac(pass);

    // Ban check — weiger verbinding als SN tijdelijk geblokkeerd is door
    // "Delete + Banish" flow. Zo blijft device weg uit de DB tot user hem
    // via Novabot app re-provisioned naar een andere MQTT broker.
    if (sn && isSnBanned(sn)) {
      const err = new Error('banned');
      (err as any).returnCode = 4; // MQTT 3.1.1: bad username/password
      console.log(`[BAN] Rejected connect from banned ${sn} (clientId=${clientId})`);
      callback(err, false);
      return;
    }

    const now = Date.now();
    const lastSeen = seenClients.get(clientId) ?? 0;
    const isReconnect = lastSeen > 0 && (now - lastSeen) < 5 * 60 * 1000;
    seenClients.set(clientId, now);

    // Detecteer of dit de app is of een fysiek apparaat
    // App clientIds: pure UUID, email+UUID, of JWT token
    // App usernames: "app:LFIN..." of "app:LFIC..."
    const isAppClient = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(clientId)
      || clientId.includes('@')
      || clientId.startsWith('eyJ')
      || user.startsWith('app:');
    const clientType = isAppClient ? 'APP' : 'DEV';

    // Vangnet tegen dubbele clientId verbindingen (bijv. twee mqtt_node processen
    // op de maaier na een crash). Als een device clientId al verbonden is EN
    // actief data stuurt (< 30s), weiger de nieuwe verbinding.
    // TODO: permanente fix in firmware — mqtt_node_monitor.sh die dubbele processen killt.
    if (!isAppClient && clientId.startsWith('LFI')) {
      const existingClient = (broker as any).clients?.[clientId];
      if (existingClient?.connected) {
        // Check of de bestaande verbinding recent actief was (< 30s)
        const lastActivity = seenClients.get(clientId) ?? 0;
        const age = now - lastActivity;
        if (age < 30_000) {
          const existingAddr = existingClient.conn?.remoteAddress ?? '?';
          const remoteAddr = (client as any).conn?.remoteAddress ?? '?';
          console.log(`${C.red}[MQTT] BLOCKED duplicate connect: ${clientId} from ${remoteAddr} — already active via ${existingAddr} (${Math.round(age / 1000)}s ago)${C.reset}`);
          callback(new Error('Device already connected'), false);
          return;
        }
      }
    }

    const cc = isAppClient ? C.blue : (clientId.startsWith('LFIN') || clientId.includes('LFIN') ? C.green : C.yellow);
    if (isReconnect) {
      console.log(`${cc}[MQTT] RECONNECT ${clientType} clientId="${clientId}" sn=${sn ?? '?'}${C.reset}`);
    } else {
      console.log(`${cc}[MQTT] CONNECT   ${clientType} clientId="${clientId}" sn=${sn ?? '?'} mac=${mac ?? '?'} user="${user}"${C.reset}`);
    }

    pushMqttLog({
      ts: now, type: 'connect', clientId, clientType, sn: sn ?? null,
      direction: '', topic: '', payload: `user="${user}" mac=${mac ?? '?'}`, encrypted: false,
    });

    upsertDevice(clientId, sn, mac, user || null);

    // Auto-detect BLE MAC via ARP als we geen MAC uit het clientId konden halen
    // (bijv. maaier clientId = LFIN2230700238_6688, bevat geen MAC)
    if (sn && !mac && !isAppClient && (client as any).conn?.remoteAddress) {
      autoDetectBleMac(sn, (client as any).conn.remoteAddress).catch(() => {});
    }

    // Sla credentials op zodat de MQTT bridge ze kan doorsturen naar upstream
    (client as any)._proxyMeta = { username: user || undefined, password: pass || undefined };

    // Registreer als online op basis van het bekende SN — alleen voor fysieke apparaten, niet de app
    if (sn && !isAppClient) {
      if (!onlineBySn.has(sn)) onlineBySn.set(sn, new Set());
      onlineBySn.get(sn)!.add(clientId);
      publishDeviceOnline(sn);
      emitDeviceOnline(sn);

      // Pending-provisioning claim: als er een PENDING_* entry in de LoRa
      // cache staat voor dit device-type, vervang die entry door de echte
      // SN. Dit sluit de loop van de provisioning flow: `/lora/resolve`
      // reserveerde de addr/channel onder een placeholder SN omdat we
      // tijdens BLE-scan geen echte SN hebben (iOS anon-UUID probleem);
      // wanneer het device nu voor het eerst online komt met z'n echte
      // LFIN*/LFIC* SN, promotie we de row. Daarna ziet HomeScreen meteen
      // het nieuwe device paaren met z'n charger.
      try {
        const wantType = sn.startsWith('LFIC') ? 'CHARGER' : sn.startsWith('LFIN') ? 'MOWER' : null;
        if (wantType) {
          const cache = equipmentRepo.listLoraCache();
          const pending = cache
            .filter((r: { sn: string }) => r.sn.startsWith(`PENDING_${wantType}_`))
            .sort((a: { sn: string }, b: { sn: string }) => a.sn.localeCompare(b.sn)); // oudste eerst (ts in sn)
          if (pending.length > 0) {
            const oldest = pending[0];
            // Alleen de oudste pending binnen 10 min consumeren — verouderde
            // placeholders ruimen we op via de sweeper. sn formaat:
            // `PENDING_<TYPE>_<ts>_<addr>`.
            const parts = oldest.sn.split('_');
            const tsMs = parts.length >= 3 ? parseInt(parts[2], 10) : 0;
            const ageOk = Number.isFinite(tsMs) && (Date.now() - tsMs) < 10 * 60 * 1000;
            if (ageOk) {
              console.log(`${C.cyan}[LORA] Claiming pending ${oldest.sn} → ${sn} (addr=${oldest.charger_address} ch=${oldest.charger_channel})${C.reset}`);
              equipmentRepo.deleteLoraCache(oldest.sn);
              equipmentRepo.setLoraCache(
                sn,
                String(oldest.charger_address ?? ''),
                String(oldest.charger_channel ?? ''),
              );
            }
          }
        }
      } catch (e) {
        console.log(`${C.red}[LORA] Pending claim error for ${sn}: ${e}${C.reset}`);
      }
      // Cloud-identiek: GEEN proactieve commando's sturen bij connect.
      // onMowerConnected() stuurde ota_version_info, get_map_list, etc.
      // Dit veroorzaakte crash loops bij David's maaier (mqtt_node crasht
      // als commando's te snel na connect binnenkomen).
      // De cloud stuurt nooit proactief commando's naar apparaten.
    }

    (callback as Function)(null, true);
  };

  broker.on('clientError', (client: Client, err: Error) => {
    console.error(`${C.red}[MQTT] ERROR    clientId="${client.id}" err=${err.message}${C.reset}`);
    pushMqttLog({
      ts: Date.now(), type: 'error', clientId: client.id, clientType: '?', sn: null,
      direction: '', topic: '', payload: err.message, encrypted: false,
    });
  });

  (broker as any).on('connectionError', (client: Client, err: Error) => {
    console.error(`${C.red}[MQTT] CONN-ERR clientId="${client?.id ?? '?'}" err=${err.message}${C.reset}`);
  });

  broker.on('clientDisconnect', (client: Client) => {
    seenClients.delete(client.id); // zodat reconnect weer gelogd wordt
    clientSubscriptions.delete(client.id);

    // Verwijder uit online-set op basis van SN in device_registry
    const devRow = deviceRepo.findByClientId(client.id);
    const disconnSn = devRow?.sn ?? null;
    if (disconnSn) {
      onlineBySn.get(disconnSn)?.delete(client.id);
      if (!isDeviceOnline(disconnSn)) {
        clearDeviceData(disconnSn);
        publishDeviceOffline(disconnSn);
        emitDeviceOffline(disconnSn);
      }
      console.log(`${clientColor(client.id)}[MQTT] DISCONNECT clientId="${client.id}" sn=${disconnSn}${C.reset}`);
    } else {
      console.log(`${C.dim}[MQTT] DISCONNECT clientId="${client.id}"${C.reset}`);
    }
    pushMqttLog({
      ts: Date.now(), type: 'disconnect', clientId: client.id, clientType: '?', sn: disconnSn,
      direction: '', topic: '', payload: '', encrypted: false,
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  broker.on('subscribe', (subscriptions: any[], client: Client) => {
    const topics = subscriptions.map(s => s.topic).join(', ');
    console.log(`${clientColor(client.id)}[MQTT] SUBSCRIBE ${client.id} -> [${topics}]${C.reset}`);
    // Track subscriptions
    if (!clientSubscriptions.has(client.id)) clientSubscriptions.set(client.id, new Set());
    for (const sub of subscriptions) clientSubscriptions.get(client.id)!.add(sub.topic);
    const subSn = extractSn(client.id) ?? extractSn(topics);
    pushMqttLog({
      ts: Date.now(), type: 'subscribe', clientId: client.id, clientType: '?', sn: subSn,
      direction: '', topic: topics, payload: '', encrypted: false,
    });
  });

  broker.on('publish', (packet: AedesPublishPacket, client: Client | null) => {
    if (!client) return;
    const payloadBuf = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);
    const direction = packet.topic.startsWith('Dart/Send_mqtt/') ? '→DEV' :
                      packet.topic.startsWith('Dart/Receive_mqtt/') ? '←DEV' : '';

    // Track lastPublish voor stale-detection (zie isDeviceOnline). Alleen
    // PUBLISH vanuit een LFI-client telt (PINGREQ is transport-level en
    // kan doorgaan zonder app-level activiteit).
    if (client.id.startsWith('LFI')) {
      const snFromClient = client.id.replace(/_.*$/, '');
      lastPublishBySn.set(snFromClient, Date.now());
    } else if (direction === '←DEV') {
      const snFromTopic = packet.topic.split('/').pop() ?? '';
      if (snFromTopic.startsWith('LFI')) {
        lastPublishBySn.set(snFromTopic, Date.now());
      }
    }

    // Ontsleutel versleutelde berichten (LFIN maaier + LFIC charger v0.4.0+)
    const deviceSn = client.id.startsWith('LFIN') ? client.id.replace(/_.*$/, '') :
                     client.id.startsWith('LFIC') ? client.id.replace(/_.*$/, '') :
                     (direction === '←DEV' && packet.topic.includes('/LFI')) ? packet.topic.split('/').pop() ?? '' : '';
    // Voor ESP32_* clientIds: zoek SN uit topic
    const encryptSn = deviceSn || (direction === '←DEV' && client.id.startsWith('ESP32_') ? packet.topic.split('/').pop() ?? '' : '');
    let logPayload: string;
    let isEncrypted = false;

    // Detecteer OTA-gerelateerde berichten voor extra tag in logs
    const otaKeywords = ['ota_upgrade_cmd', 'ota_version_info', 'ota_upgrade_state'];
    const tagForPayload = (p: string) => otaKeywords.some(k => p.includes(k)) ? '[OTA] ' : '';

    // Vlag om herhaalde up_status_info te onderdrukken in console (niet in pushMqttLog)
    let suppressLog = false;

    // Bepaal kleur: app (blauw) of apparaat (groen/geel op basis van topic/clientId)
    const pubColor = /^[0-9a-f]{8}-/i.test(client.id) ? C.blue : topicColor(packet.topic) || clientColor(client.id);

    if (encryptSn) {
      const decrypted = tryDecrypt(payloadBuf, encryptSn);
      if (decrypted) {
        const tag = tagForPayload(decrypted);
        logPayload = decrypted;
        isEncrypted = true;
        // Onderdruk herhaalde up_status_info (toon elke 30e keer)
        if (decrypted.includes('"up_status_info"')) {
          statusLogCounter++;
          if (statusLogCounter % 30 !== 1) suppressLog = true;
          else console.log(`${pubColor}[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  ${tag}[AES] ${decrypted}  (×30 suppressed)${C.reset}`);
        } else {
          console.log(`${pubColor}[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  ${tag}[AES] ${decrypted}${C.reset}`);
        }
      } else {
        // Niet ontsleutelbaar — toon als plain text als het al JSON is, anders als encrypted
        const plain = payloadBuf.toString();
        if (plain.startsWith('{') || plain.startsWith('[')) {
          const tag = tagForPayload(plain);
          logPayload = plain;
          console.log(`${pubColor}[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  ${tag}${logPayload}${C.reset}`);
        } else {
          console.log(`${pubColor}[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  [encrypted ${payloadBuf.length}B]${C.reset}`);
          logPayload = `[encrypted ${payloadBuf.length}B]`;
          isEncrypted = true;
        }
      }
    } else {
      logPayload = payloadBuf.toString();
      const tag = tagForPayload(logPayload);
      // Onderdruk ook plain up_status_info
      if (logPayload.includes('"up_status_info"')) {
        statusLogCounter++;
        if (statusLogCounter % 30 !== 1) suppressLog = true;
        else console.log(`${pubColor}[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  ${tag}${logPayload}  (×30 suppressed)${C.reset}`);
      } else {
        console.log(`${pubColor}[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  ${tag}${logPayload}${C.reset}`);
      }
    }

    {
      const pubSn = extractSn(client.id) ?? extractSn(packet.topic);
      const isApp = /^[0-9a-f]{8}-/i.test(client.id);
      pushMqttLog({
        ts: Date.now(), type: 'publish', clientId: client.id,
        clientType: isApp ? 'APP' : 'DEV', sn: pubSn,
        direction: direction as '→DEV' | '←DEV' | '',
        topic: packet.topic,
        payload: logPayload.length > 2000 ? logPayload.slice(0, 2000) + '...' : logPayload,
        encrypted: isEncrypted,
      });
    }

    const payload = payloadBuf.toString();

    // Probeer alsnog MAC uit payload te leren
    const mac = extractMac(payload);
    const sn  = extractSn(payload) ?? extractSn(packet.topic);
    if (mac || sn) {
      const existing = deviceRepo.findByClientId(client.id);

      const resolvedSn  = sn  ?? existing?.sn  ?? null;
      const resolvedMac = mac ?? existing?.mac_address ?? null;
      if (resolvedSn || resolvedMac) {
        upsertDevice(client.id, resolvedSn, resolvedMac, existing?.mqtt_username ?? null);
      }
    }

    // Forward naar Home Assistant bridge + dashboard
    // Voor versleutelde berichten: stuur ontsleutelde payload door i.p.v. ruwe ciphertext
    const topicSn = sn ?? extractSn(packet.topic);
    const forwardSn = encryptSn || topicSn;
    if (forwardSn) {
      // Probeer te decrypten; val terug op plain payload als decrypt faalt (bijv. charger v0.3.6 plain JSON)
      const decryptedJson = encryptSn ? tryDecrypt(payloadBuf, encryptSn) : null;
      const effectiveBuf = decryptedJson ? Buffer.from(decryptedJson, 'utf8') : payloadBuf;
      const effectiveJson = decryptedJson ?? payload;

      // Check of dit een kaart-gerelateerde of OTA response is
      try {
        const parsed = JSON.parse(effectiveJson);
        handleMapMessage(forwardSn, parsed);
        handleDeviceResponse(forwardSn, parsed);
        // OTA voortgang → push naar dashboard via socket
        // Charger formaat: {"type":"ota_upgrade_state","message":{...}}
        // Maaier formaat:  {"ota_upgrade_state":{...}}
        const otaState = parsed.ota_upgrade_state
          ?? (parsed.type === 'ota_upgrade_state' ? parsed.message : null);
        if (otaState) {
          console.log(`\x1b[38;5;208m[OTA] ⚡ ota_upgrade_state van ${forwardSn}: ${JSON.stringify(otaState)}\x1b[0m`);
          emitOtaEvent(forwardSn, 'state', otaState);
        }

        // Firmware versie response
        // Charger: {"type":"ota_version_info_respond","message":{"result":0,"value":{"system":"v0.0.1","version":"v0.4.0"}}}
        // Maaier:  {"ota_version_info_respond":{"version":"v6.0.0",...}}
        const otaVersionData = parsed.ota_version_info_respond
          ?? (parsed.type === 'ota_version_info_respond' ? parsed.message : null);
        if (otaVersionData) {
          emitOtaEvent(forwardSn, 'version', otaVersionData);
          // Extraheer versie string — charger heeft value.version, maaier heeft direct version
          const val = otaVersionData?.value ?? otaVersionData;
          const versionStr = val?.version ?? val?.sw_version ?? val?.mqtt_version;
          if (versionStr && forwardSn) {
            const isCharger = forwardSn.startsWith('LFIC');
            const isMower = forwardSn.startsWith('LFIN');
            if (isCharger) {
              equipmentRepo.updateChargerVersionByChargerSn(forwardSn, String(versionStr));
            } else if (isMower) {
              equipmentRepo.updateVersions(forwardSn, String(versionStr));
            }
            console.log(`${C.cyan}[OTA] Stored firmware version ${versionStr} for ${forwardSn}${C.reset}`);
          }
        }
        // PIN code response
        // Maaier formaat: {"dev_pin_info_respond":{"result":0,"value":{"cfg_value":0,"code":"3053"}}}
        const pinData = parsed.dev_pin_info_respond
          ?? (parsed.type === 'dev_pin_info_respond' ? parsed.message : null);
        if (pinData && forwardSn) {
          console.log(`${C.cyan}[PIN] dev_pin_info_respond van ${forwardSn}: ${JSON.stringify(pinData)}${C.reset}`);
          emitPinEvent(forwardSn, pinData);

          // PIN verify response — v3.6.4 firmware patch cleart de error_byte
          // aan STM32 kant. Cache clearing gebeurt in dashboard.ts verify endpoint.
        }
        // Forward all _respond messages to app via Socket.io
        // Flutter app listens for: stop_scan_map_respond, save_map_respond,
        // auto_recharge_respond, save_recharge_pos_respond, etc.
        for (const key of Object.keys(parsed)) {
          if (key.endsWith('_respond') && forwardSn) {
            console.log(`${C.cyan}[RESPOND] ${key} from ${forwardSn}${C.reset}`);
            emitCommandRespond(forwardSn, key, parsed[key]);
            // Wek eventuele awaitCommand() callers in mapSync
            notifyRespond(forwardSn, key, parsed[key]);
          }
        }
        // Also handle charger-style responds: {"type":"xxx_respond","message":{...}}
        if (typeof parsed.type === 'string' && parsed.type.endsWith('_respond') && forwardSn) {
          console.log(`${C.cyan}[RESPOND] ${parsed.type} from ${forwardSn}${C.reset}`);
          emitCommandRespond(forwardSn, parsed.type, parsed.message);
          notifyRespond(forwardSn, parsed.type, parsed.message);

          // Charger LoRa config: sla echte addr/channel op (overschrijft cloud-imported waarden).
          // De mower wordt NIET meer afgeleid — die wordt los gequeried via extended topic
          // (get_lora_info via novabot/extended/<SN>, handled by extended_commands.py).
          if (parsed.type === 'get_lora_info_respond' && parsed.message?.value) {
            const val = parsed.message.value as { addr?: number; channel?: number };
            if (val.addr != null && val.channel != null) {
              equipmentRepo.setLoraCache(forwardSn, String(val.addr), String(val.channel));
              console.log(`${C.cyan}[LORA] Real LoRa config from ${forwardSn}: addr=${val.addr} ch=${val.channel}${C.reset}`);
            }
          }
        }
      } catch { /* geen JSON of geen map-bericht */ }

      // In demo mode: skip echte maaier status updates (simulator stuurt eigen data)
      if (!isDemoMode(forwardSn)) {
        const changes = updateDeviceData(forwardSn, effectiveBuf);
        forwardToHomeAssistant(packet.topic, effectiveBuf, forwardSn, changes);
        forwardToDashboard(forwardSn, changes);
      }
    }

    // Forward extended_commands.py responses naar dashboard via Socket.io
    if (packet.topic.startsWith('novabot/extended_response/')) {
      const extSn = packet.topic.split('/').pop() ?? '';
      try {
        const parsed = JSON.parse(payloadBuf.toString());
        const cmdName = Object.keys(parsed)[0];
        if (cmdName) {
          console.log(`${C.cyan}[EXT] Response van ${extSn}: ${cmdName}${C.reset}`);
          emitExtendedEvent(extSn, cmdName, parsed[cmdName]);
        }
        // Forward to mapSync response handlers (used by dashboard API endpoints)
        handleExtendedResponse(extSn, payloadBuf.toString());

        // Edge-cut state — mirror the firmware's edge_cut_status events
        // into the sensor cache so the app can derive activity='edge_cutting'
        // directly from deviceState.sensors. The firmware emits this periodically
        // while NTCP only_edge_mode runs and once more (active:false) on finish.
        if (extSn && cmdName === 'edge_cut_status') {
          const body = parsed[cmdName] as {
            active?: boolean;
            work_status?: number;
            covered_ratio?: number;
            task_covered_area?: number;
            task_planned_area?: number;
            result_status?: number | null;
          };
          if (body) {
            if (!deviceCache.has(extSn)) deviceCache.set(extSn, new Map());
            const cache = deviceCache.get(extSn)!;
            const changes = new Map<string, string>();
            const set = (k: string, v: string | number | null | undefined) => {
              if (v == null) return;
              const sv = String(v);
              cache.set(k, sv);
              changes.set(k, sv);
            };
            set('edge_active', body.active ? '1' : '0');
            set('edge_work_status', body.work_status);
            set('edge_covered_ratio', body.covered_ratio);
            set('edge_task_covered_area', body.task_covered_area);
            set('edge_task_planned_area', body.task_planned_area);
            if (body.result_status != null) set('edge_result_status', body.result_status);
            forwardToDashboard(extSn, changes);
          }
        }

        // Authoritative LoRa sync — als de mower zelf zijn LoRa-config
        // rapporteert (via get_lora_info_respond of set_lora_info_respond),
        // is dát de echte waarheid. Cache bijwerken zodat DB nooit meer
        // achter kan lopen op de mower (bewezen scenario 2026-04-21: user
        // provisioned ch18 via BLE, oude DB entry bleef op ch19 omdat
        // de BLE-flow geen real SN had om registerLora te callen).
        //
        // Formaten die we accepteren:
        //   { get_lora_info_respond: { result:0, addr, channel, hc, lc } }
        //   { set_lora_info_respond: { result:0, addr, channel } }
        //
        // Alleen bij result=0 — een fout-response moet de cache NIET overschrijven.
        if (extSn && (cmdName === 'get_lora_info_respond' || cmdName === 'set_lora_info_respond')) {
          const body = parsed[cmdName] as { result?: number; addr?: number; channel?: number };
          if (body?.result === 0 && body.addr != null && body.channel != null) {
            try {
              equipmentRepo.setLoraCache(extSn, String(body.addr), String(body.channel));
              console.log(`${C.cyan}[LORA] Authoritative sync from ${extSn} (${cmdName}): addr=${body.addr} ch=${body.channel}${C.reset}`);
            } catch (e) {
              console.log(`${C.red}[LORA] Failed to sync cache for ${extSn}: ${e}${C.reset}`);
            }
          }
        }
      } catch { /* geen JSON */ }
    }
  });

  // Start MQTT bridge naar upstream als we in cloud proxy mode zijn
  if (PROXY_MODE === 'cloud') {
    startMqttBridge(broker);
  }

  // Start Home Assistant MQTT bridge (optioneel, alleen als HA_MQTT_HOST is geconfigureerd)
  startHomeAssistantBridge();

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    console.log(`${C.dim}[TCP] Nieuwe verbinding van ${socket.remoteAddress}:${socket.remotePort}${C.reset}`);
    // Workaround: ESP32-charger stuurt TCP FIN direct na MQTT CONNECT (half-close).
    // Fix: schrijf CONNACK synchroon en onderschep destroy() → end() zodat
    // de write-buffer geflushed wordt vóórdat de socket gesloten wordt.
    let earlyConnackSent = false;
    const origDestroy = socket.destroy.bind(socket);
    (socket as any).destroy = (..._args: unknown[]) => {
      if (earlyConnackSent) {
        earlyConnackSent = false;
        socket.end();
      } else {
        origDestroy();
      }
      return socket;
    };

    socket.once('data', (chunk) => {
      // Fix: Novabot app stuurt Will QoS=1 met Will Flag=0 → patch Connect Flags in-place
      sanitizeConnectFlags(chunk);

      // MQTT CONNECT packet type = 0x10
      if (chunk[0] === 0x10) {
        // Probeer SN uit CONNECT packet te extraheren en socket op te slaan
        try {
          const connectStr = chunk.toString('utf8');
          const snMatch = connectStr.match(/LFI[A-Z]\d{10,}/);
          if (snMatch) {
            // Check of dit een app-client is (username bevat "app:" prefix vóór het SN).
            // App-clients moeten NIET in rawSocketBySn (die is voor directe device sockets)
            // en ARP op een app-client IP (bijv. iPhone) geeft een verkeerd MAC.
            const isApp = connectStr.includes(`app:${snMatch[0]}`);

            if (!isApp) {
              rawSocketBySn.set(snMatch[0], socket);
            }
            const sc = snMatch[0].startsWith('LFIN') ? C.green : C.yellow;
            const label = isApp ? 'APP' : '';
            console.log(`${sc}[MQTT] TCP socket ${snMatch[0]}${label ? ` (${label})` : ''} (${socket.remoteAddress})${C.reset}`);

            // Sla IP-adres op in device_registry (voor SSH map-upload)
            if (!isApp && socket.remoteAddress) {
              const cleanIp = socket.remoteAddress.replace(/^::ffff:/, '');
              try {
                deviceRepo.updateIpBySn(snMatch[0], cleanIp);
              } catch { /* tabel nog niet gemigrated */ }
            }

            // Auto-detect BLE MAC via ARP — alleen voor DEVICE connecties (niet app-clients)
            if (!isApp && socket.remoteAddress) {
              autoDetectBleMac(snMatch[0], socket.remoteAddress).catch(() => {});
            }

            // Tap ALL incoming data van dit apparaat (vóór aedes verwerking)
            const deviceSn = snMatch[0];
            const origEmit = socket.emit.bind(socket);
            (socket as any).emit = function(event: string, ...args: unknown[]) {
              if (event === 'data' && args[0]) {
                const inBuf = Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(args[0] as any);
                const type = inBuf[0];
                const typeStr = type === 0x30 || type === 0x32 ? 'PUBLISH' :
                                type === 0x40 ? 'PUBACK' :
                                type === 0x82 ? 'SUBSCRIBE' :
                                type === 0x90 ? 'SUBACK' :
                                type === 0xC0 ? 'PINGREQ' :
                                type === 0xD0 ? 'PINGRESP' :
                                type === 0xE0 ? 'DISCONNECT' :
                                `0x${type.toString(16)}`;
                const rc = deviceSn.startsWith('LFIN') ? C.green : C.yellow;
                console.log(`${rc}[RAW-IN] ${deviceSn} ← ${inBuf.length}B ${typeStr} (from ${socket.remoteAddress}:${socket.remotePort})${C.reset}`);

                // Safety net: als we data ontvangen maar device niet als online gemarkeerd is,
                // herstel de online status (kan out-of-sync raken na server restart).
                // Alleen voor echte device-connecties — app-clients mogen de online status NIET beïnvloeden,
                // anders denkt getEquipmentBySN dat de maaier online is terwijl alleen de app verbonden is.
                if (!isApp && !isDeviceOnline(deviceSn)) {
                  if (!onlineBySn.has(deviceSn)) onlineBySn.set(deviceSn, new Set());
                  onlineBySn.get(deviceSn)!.add(deviceSn);
                  publishDeviceOnline(deviceSn);
                  emitDeviceOnline(deviceSn);
                  console.log(`${rc}[MQTT] Online status hersteld voor ${deviceSn} (via RAW-IN)${C.reset}`);
                }
              }
              return origEmit(event, ...args);
            };

            socket.once('close', () => {
              rawSocketBySn.delete(deviceSn);
              // Verwijder online status bij socket close — alleen voor echte device-connecties
              if (!isApp) {
                onlineBySn.get(deviceSn)?.delete(deviceSn);
                if (!isDeviceOnline(deviceSn)) {
                  clearDeviceData(deviceSn);
                  publishDeviceOffline(deviceSn);
                  emitDeviceOffline(deviceSn);
                }
              }
            });
          }
        } catch { /* SN extractie mislukt, niet erg */ }

        // Schrijf CONNACK synchroon (vóór microtask-grens / 'end' event)
        socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
        earlyConnackSent = true;

        // Onderdruk dubbele CONNACK van aedes
        // Aedes schrijft soms 1-byte-per-keer, dus we tellen bytes i.p.v. te checken op buf.length>=2
        const origWrite = socket.write.bind(socket);
        let connackBytesToSwallow = 4; // CONNACK = 0x20 0x02 0x00 0x00 = 4 bytes
        (socket as any).write = function (data: Buffer | string | Uint8Array, ...rest: unknown[]): boolean {
          const buf = Buffer.isBuffer(data) ? data :
                      data instanceof Uint8Array ? Buffer.from(data) :
                      Buffer.from(data as string);
          // Swallow aedes' duplicate CONNACK (komt in 1-byte chunks)
          if (connackBytesToSwallow > 0) {
            const toSwallow = Math.min(buf.length, connackBytesToSwallow);
            connackBytesToSwallow -= toSwallow;
            if (toSwallow === buf.length) {
              // Hele buffer opgeslokt
              const cb = rest.find((a): a is () => void => typeof a === 'function');
              if (cb) process.nextTick(cb);
              return true;
            }
            // Deels opgeslokt — rest doorgeven
            data = buf.subarray(toSwallow);
          }
          return (origWrite as Function)(data, ...rest);
        };
      }
    });

    socket.on('error', () => {}); // voorkom unhandled error crashes
    (broker.handle as (socket: net.Socket) => void)(socket);
  });
  const mqttPort = parseInt(process.env.MQTT_PORT || '1883', 10);
  server.listen(mqttPort, '0.0.0.0', () => {
    console.log(`${C.cyan}[MQTT] Broker luistert op port ${mqttPort}${C.reset}`);
  });

  // ── Stale device sweeper ──────────────────────────────────────
  // Aedes' eigen keepalive check is traag (heartbeatInterval 120s + 1.5×
  // client-keepalive). Dat is te traag voor een fijne UX: na power-off van
  // de maaier blijft de app tot 2 min "Charging 100%" tonen. Deze sweeper
  // kijkt elke 15s of een online-markeerde SN >STALE_SN_MS (45s) stil is;
  // zo ja, forceer disconnect en wis sensor cache — app toont onmiddellijk
  // offline state.
  setInterval(() => {
    const now = Date.now();
    for (const [sn, clientSet] of onlineBySn) {
      if (clientSet.size === 0) continue;
      const lastPub = lastPublishBySn.get(sn);
      if (lastPub == null) continue; // nooit PUBLISH gezien → laat aedes dit afhandelen
      if (now - lastPub < STALE_SN_MS) continue; // vers

      console.log(`${C.yellow}[MQTT] Stale sweeper: ${sn} stil sinds ${Math.round((now - lastPub) / 1000)}s → forceer offline${C.reset}`);
      // Forceer TCP close zodat eventuele halfdode verbinding opgeruimd wordt.
      // rawSocketBySn wordt in onPublish/connect bijgehouden.
      try { forceDisconnectDevice(sn); } catch { /* ignore */ }
      // Wis state en stuur offline event naar dashboard/app zodat de UI
      // meteen updatet zonder op refresh te wachten.
      clientSet.clear();
      onlineBySn.delete(sn);
      lastPublishBySn.delete(sn);
      try {
        clearDeviceData(sn);
        publishDeviceOffline(sn);
        emitDeviceOffline(sn);
      } catch (e) {
        console.log(`${C.red}[MQTT] Stale sweeper cleanup error voor ${sn}: ${e}${C.reset}`);
      }
    }
  }, 15_000);
}

/**
 * Diagnostiek: geeft overzicht van verbonden clients en hun subscriptions.
 */
export function getBrokerDiagnostics(): {
  clients: Array<{ clientId: string; sn: string | null; subscriptions: string[]; isApp: boolean }>;
  onlineDevices: Array<{ sn: string; clientCount: number }>;
} {
  const clients: Array<{ clientId: string; sn: string | null; subscriptions: string[]; isApp: boolean }> = [];
  for (const [clientId, topics] of clientSubscriptions) {
    const sn = extractSn(clientId);
    clients.push({
      clientId: clientId.length > 60 ? clientId.slice(0, 40) + '...' : clientId,
      sn,
      subscriptions: [...topics],
      isApp: isAppClient(clientId),
    });
  }
  const onlineDevices: Array<{ sn: string; clientCount: number }> = [];
  for (const [sn, cids] of onlineBySn) {
    if (cids.size > 0) onlineDevices.push({ sn, clientCount: cids.size });
  }
  return { clients, onlineDevices };
}

// Hulpfunctie voor equipment.ts: zoek het BLE MAC-adres op voor een gegeven SN.
//
// Priority — gewijzigd 22 apr 2026 (bug #mower-mac-swap):
// 1. `device_factory` — AUTHORITATIEF per-SN (READ-ONLY tabel, één SN = één MAC).
//    Altijd veilig: kan structureel geen andere SN-MAC combinaties lekken.
// 2. device_registry preferred (mqtt_username = SN) — live, real device entry.
// 3. device_registry excluding 'app:SN' — andere non-app entry, fallback.
// 4. equipment.mac_address — ALLEEN als `mower_sn === sn`. Dit veld is gedeeld
//    tussen mower+charger in dezelfde row, dus voor charger-SN nooit teruggeven.
//    Conventie (zie memory ble-mac-address-critical.md): equipment.mac_address
//    is altijd de MOWER BLE MAC.
export function lookupMac(sn: string): string | null {
  // 1. Factory-tabel — kan niet verkeerd zijn, één SN = één MAC (read-only bron).
  const factoryMac = deviceRepo.getFactoryMac(sn);
  if (factoryMac) return factoryMac;

  // 2. device_registry preferred: echte device entries (mqtt_username = SN)
  //    boven app-client entries (mqtt_username = 'app:SN') die een ander MAC hebben.
  const preferredMac = deviceRepo.findPreferredMacBySnAndUsername(sn, sn);
  if (preferredMac) return preferredMac;

  // 3. device_registry fallback: elke entry BEHALVE app-clients.
  //    App-clients hadden eerder een verkeerd MAC van ARP auto-detectie.
  const fallbackMac = deviceRepo.findMacBySnExcludingApp(sn);
  if (fallbackMac) return fallbackMac;

  // 4. equipment.mac_address — alleen als het SN de MOWER van die row is.
  //    Voor charger SN-lookups nooit teruggeven: equipment row bevat één gedeeld
  //    mac_address veld voor (mower_sn, charger_sn) pair en de conventie is dat
  //    dit altijd de mower MAC is. Zie memory ble-mac-address-critical.md.
  const eqRow = equipmentRepo.findBySn(sn);
  if (eqRow?.mac_address && eqRow.mower_sn === sn) return eqRow.mac_address;

  return null;
}
