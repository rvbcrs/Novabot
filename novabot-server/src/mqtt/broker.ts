import net from 'net';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { Aedes, Client, AedesPublishPacket } from 'aedes';
import { db } from '../db/database.js';
import { DeviceRegistryRow } from '../types/index.js';
import { startMqttBridge } from '../proxy/mqttBridge.js';
import { tryDecrypt } from './decrypt.js';
import { startHomeAssistantBridge, forwardToHomeAssistant, publishDeviceOnline, publishDeviceOffline } from './homeassistant.js';
import { updateDeviceData } from './sensorData.js';
import { forwardToDashboard, emitDeviceOnline, emitDeviceOffline, pushMqttLog, emitOtaEvent } from '../dashboard/socketHandler.js';
import { initMapSync, onMowerConnected, handleMapMessage } from './mapSync.js';

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
  const existing = db.prepare(`
    SELECT mac_address FROM device_registry
    WHERE sn = ? AND mac_address IS NOT NULL
    LIMIT 1
  `).get(sn) as { mac_address: string } | undefined;
  if (existing) return; // Al bekend

  const wifiMac = await lookupArpMac(cleanIp);
  if (!wifiMac) {
    console.log(`${C.dim}[ARP] Kon WiFi MAC niet vinden voor ${sn} (IP: ${cleanIp})${C.reset}`);
    return;
  }

  const bleMac = wifiStaToBle(wifiMac);
  console.log(`${C.cyan}[ARP] Auto-detected MAC voor ${sn}: WiFi STA=${wifiMac} → BLE=${bleMac}${C.reset}`);

  // Sla BLE MAC op in device_registry (update bestaand record)
  db.prepare(`
    UPDATE device_registry SET mac_address = ?
    WHERE sn = ? AND mac_address IS NULL
  `).run(bleMac, sn);

  // Sla ook op in equipment tabel
  db.prepare(`
    UPDATE equipment SET mac_address = ?
    WHERE (mower_sn = ? OR charger_sn = ?) AND mac_address IS NULL
  `).run(bleMac, sn, sn);
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
  db.prepare(`
    INSERT INTO device_registry (mqtt_client_id, sn, mac_address, mqtt_username, last_seen)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mqtt_client_id) DO UPDATE SET
      sn           = COALESCE(excluded.sn, sn),
      mac_address  = COALESCE(excluded.mac_address, mac_address),
      mqtt_username= excluded.mqtt_username,
      last_seen    = excluded.last_seen
  `).run(clientId, sn ?? null, mac ?? null, username ?? null);

  // Koppel mac_address ook terug aan de equipment rij als die al bestaat
  if (sn && mac) {
    db.prepare(`
      UPDATE equipment
      SET mac_address = ?
      WHERE (mower_sn = ? OR charger_sn = ?) AND mac_address IS NULL
    `).run(mac, sn, sn);
  }
}

// Bijhouden welke clients al gelogd zijn (clientId -> timestamp eerste connect)
const seenClients = new Map<string, number>();

// Onderdruk herhaalde up_status_info logs (toon alleen elke 30e keer)
let statusLogCounter = 0;

// Bijhouden welke SN's momenteel verbonden zijn (SN -> Set van clientId's)
const onlineBySn = new Map<string, Set<string>>();

// Raw TCP sockets per SN opslaan voor directe PUBLISH bypass
const rawSocketBySn = new Map<string, net.Socket>();

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

/** Geeft true als het apparaat met dit SN momenteel verbonden is met de MQTT broker */
export function isDeviceOnline(sn: string): boolean {
  const clients = onlineBySn.get(sn);
  return clients !== undefined && clients.size > 0;
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
  const broker = await Aedes.createBroker();

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
    if (client && packet.topic.startsWith('Dart/Send_mqtt/LFIN') && isAppClient(client.id)) {
      const payloadBuf = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);
      const sn = packet.topic.split('/').pop() ?? '';
      console.log(`\x1b[38;5;208m[OTA-FIX] authorizePublish: app→mower ${sn}, ${payloadBuf.length}B\x1b[0m`);
      if (sn) {
        const decrypted = tryDecrypt(payloadBuf, sn);
        if (decrypted) {
          console.log(`\x1b[38;5;208m[OTA-FIX] Decrypted: ${decrypted.slice(0, 300)}\x1b[0m`);
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

  broker.authenticate = (client: Client, username: Readonly<string | undefined>, password: Readonly<Buffer | undefined>, callback) => {
    const clientId  = client.id ?? '';
    const user      = username ?? '';
    const pass      = password?.toString() ?? '';

    const sn  = extractSn(clientId) ?? extractSn(user);
    const mac = extractMac(clientId) ?? extractMac(user) ?? extractMac(pass);

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
      // Automatisch firmware versie + kaarten opvragen bij connect
      onMowerConnected(sn);
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
    const row = db.prepare('SELECT sn FROM device_registry WHERE mqtt_client_id = ?')
      .get(client.id) as { sn: string | null } | undefined;
    const disconnSn = row?.sn ?? null;
    if (disconnSn) {
      onlineBySn.get(disconnSn)?.delete(client.id);
      if (!isDeviceOnline(disconnSn)) {
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

  broker.on('subscribe', (subscriptions, client: Client) => {
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
      const existing = db.prepare(
        'SELECT * FROM device_registry WHERE mqtt_client_id = ?'
      ).get(client.id) as DeviceRegistryRow | undefined;

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
              db.prepare('UPDATE equipment SET charger_version = ? WHERE charger_sn = ?')
                .run(String(versionStr), forwardSn);
            } else if (isMower) {
              db.prepare('UPDATE equipment SET mower_version = ? WHERE mower_sn = ?')
                .run(String(versionStr), forwardSn);
            }
            console.log(`${C.cyan}[OTA] Stored firmware version ${versionStr} for ${forwardSn}${C.reset}`);
          }
        }
      } catch { /* geen JSON of geen map-bericht */ }

      const changes = updateDeviceData(forwardSn, effectiveBuf);
      forwardToHomeAssistant(packet.topic, effectiveBuf, forwardSn, changes);
      forwardToDashboard(forwardSn, changes);
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
  server.listen(1883, '0.0.0.0', () => {
    console.log(`${C.cyan}[MQTT] Broker luistert op port 1883${C.reset}`);
  });
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
// Zoekt eerst in device_registry (alleen echte apparaat-entries, geen app-clients),
// en valt daarna terug op de equipment tabel (handmatig of eerder geregistreerd).
export function lookupMac(sn: string): string | null {
  // 1. Zoek in device_registry — prefer echte device entries (mqtt_username = SN)
  //    boven app-client entries (mqtt_username = 'app:SN') die een ander MAC hebben
  const devRow = db.prepare(`
    SELECT mac_address FROM device_registry
    WHERE sn = ? AND mac_address IS NOT NULL AND mqtt_username = ?
    ORDER BY last_seen DESC LIMIT 1
  `).get(sn, sn) as { mac_address: string } | undefined;
  if (devRow) return devRow.mac_address;

  // 2. Fallback: elke device_registry entry BEHALVE app-clients
  //    App-clients (mqtt_username = 'app:SN') hadden eerder een verkeerd MAC
  //    van ARP auto-detectie (iPhone MAC i.p.v. maaier MAC).
  const regRow = db.prepare(`
    SELECT mac_address FROM device_registry
    WHERE sn = ? AND mac_address IS NOT NULL AND mqtt_username NOT LIKE 'app:%'
    ORDER BY last_seen DESC LIMIT 1
  `).get(sn) as { mac_address: string } | undefined;
  if (regRow) return regRow.mac_address;

  // 3. Fallback: zoek in equipment tabel (gezet via admin API of eerdere binding)
  const eqRow = db.prepare(`
    SELECT mac_address FROM equipment
    WHERE (mower_sn = ? OR charger_sn = ?) AND mac_address IS NOT NULL
    LIMIT 1
  `).get(sn, sn) as { mac_address: string } | undefined;
  return eqRow?.mac_address ?? null;
}
