import net from 'net';
import { Aedes, Client, AedesPublishPacket } from 'aedes';
import { db } from '../db/database.js';
import { DeviceRegistryRow } from '../types/index.js';
import { startMqttBridge } from '../proxy/mqttBridge.js';
import { tryDecrypt } from './decrypt.js';
import { startHomeAssistantBridge, forwardToHomeAssistant, publishDeviceOnline, publishDeviceOffline } from './homeassistant.js';

const PROXY_MODE = process.env.PROXY_MODE ?? 'local';

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

function extractMac(s: string): string | null {
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

// Bijhouden welke SN's momenteel verbonden zijn (SN -> Set van clientId's)
const onlineBySn = new Map<string, Set<string>>();

/** Geeft true als het apparaat met dit SN momenteel verbonden is met de MQTT broker */
export function isDeviceOnline(sn: string): boolean {
  const clients = onlineBySn.get(sn);
  return clients !== undefined && clients.size > 0;
}

export async function startMqttBroker(): Promise<void> {
  // Gebruik createBroker() zodat broker.listen() wordt aangeroepen:
  // dit zet broker.closed = false en initialiseert de persistence.
  // Zonder dit retourneert de 'authenticate' stap in connectActions vroegtijdig
  // (if (client.broker.closed) return) zonder done() aan te roepen,
  // waardoor doConnack nooit wordt uitgevoerd.
  const broker = await Aedes.createBroker();

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

    // Detecteer of dit de app is (UUID formaat) of een apparaat
    const isAppClient = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId);
    const clientType = isAppClient ? 'APP' : 'DEV';

    if (isReconnect) {
      console.log(`[MQTT] RECONNECT ${clientType} clientId="${clientId}" sn=${sn ?? '?'}`);
    } else {
      console.log(`[MQTT] CONNECT   ${clientType} clientId="${clientId}" sn=${sn ?? '?'} mac=${mac ?? '?'} user="${user}"`);
    }

    upsertDevice(clientId, sn, mac, user || null);

    // Sla credentials op zodat de MQTT bridge ze kan doorsturen naar upstream
    (client as any)._proxyMeta = { username: user || undefined, password: pass || undefined };

    // Registreer als online op basis van het bekende SN
    if (sn) {
      if (!onlineBySn.has(sn)) onlineBySn.set(sn, new Set());
      onlineBySn.get(sn)!.add(clientId);
      publishDeviceOnline(sn);
    }

    (callback as Function)(null, true);
  };

  broker.on('clientError', (client: Client, err: Error) => {
    console.error(`[MQTT] ERROR    clientId="${client.id}" err=${err.message}`);
  });

  (broker as any).on('connectionError', (client: Client, err: Error) => {
    console.error(`[MQTT] CONN-ERR clientId="${client?.id ?? '?'}" err=${err.message}`);
  });

  broker.on('clientDisconnect', (client: Client) => {
    seenClients.delete(client.id); // zodat reconnect weer gelogd wordt

    // Verwijder uit online-set op basis van SN in device_registry
    const row = db.prepare('SELECT sn FROM device_registry WHERE mqtt_client_id = ?')
      .get(client.id) as { sn: string | null } | undefined;
    if (row?.sn) {
      onlineBySn.get(row.sn)?.delete(client.id);
      if (!isDeviceOnline(row.sn)) publishDeviceOffline(row.sn);
      console.log(`[MQTT] DISCONNECT clientId="${client.id}" sn=${row.sn}`);
    } else {
      console.log(`[MQTT] DISCONNECT clientId="${client.id}"`);
    }
  });

  broker.on('subscribe', (subscriptions, client: Client) => {
    const topics = subscriptions.map(s => s.topic).join(', ');
    console.log(`[MQTT] SUBSCRIBE ${client.id} -> [${topics}]`);
  });

  broker.on('publish', (packet: AedesPublishPacket, client: Client | null) => {
    if (!client) return;
    const payloadBuf = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);
    const direction = packet.topic.startsWith('Dart/Send_mqtt/') ? '→DEV' :
                      packet.topic.startsWith('Dart/Receive_mqtt/') ? '←DEV' : '';

    // Probeer maaier-berichten (LFIN*) te decrypten
    const isMowerMsg = client.id.startsWith('LFIN') || (direction === '←DEV' && packet.topic.includes('/LFIN'));
    if (isMowerMsg) {
      const decrypted = tryDecrypt(payloadBuf);
      if (decrypted) {
        console.log(`[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  [AES] ${decrypted}`);
      } else {
        console.log(`[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  [encrypted ${payloadBuf.length}B]`);
      }
    } else {
      const payload = payloadBuf.toString();
      console.log(`[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  ${payload}`);
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

    // Forward naar Home Assistant bridge (no-op als niet geconfigureerd)
    forwardToHomeAssistant(packet.topic, payloadBuf, sn ?? extractSn(packet.topic));
  });

  // Start MQTT bridge naar upstream als we in cloud proxy mode zijn
  if (PROXY_MODE === 'cloud') {
    startMqttBridge(broker);
  }

  // Start Home Assistant MQTT bridge (optioneel, alleen als HA_MQTT_HOST is geconfigureerd)
  startHomeAssistantBridge();

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
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
        // Schrijf CONNACK synchroon (vóór microtask-grens / 'end' event)
        socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
        earlyConnackSent = true;

        // Onderdruk dubbele CONNACK van aedes
        const origWrite = socket.write.bind(socket);
        let dupSuppressed = false;
        (socket as any).write = function (data: Buffer | string | Uint8Array, ...rest: unknown[]): boolean {
          const buf = Buffer.isBuffer(data) ? data :
                      data instanceof Uint8Array ? Buffer.from(data) :
                      Buffer.from(data as string);
          if (!dupSuppressed && buf.length >= 2 && buf[0] === 0x20) {
            dupSuppressed = true;
            const cb = rest.find((a): a is () => void => typeof a === 'function');
            if (cb) process.nextTick(cb);
            return true;
          }
          return (origWrite as Function)(data, ...rest);
        };
      }
    });

    socket.on('error', () => {}); // voorkom unhandled error crashes
    (broker.handle as (socket: net.Socket) => void)(socket);
  });
  server.listen(1883, '0.0.0.0', () => {
    console.log('[MQTT] Broker luistert op port 1883');
  });
}

// Hulpfunctie voor equipment.ts: zoek het MAC-adres op voor een gegeven SN
export function lookupMac(sn: string): string | null {
  const row = db.prepare(`
    SELECT mac_address FROM device_registry
    WHERE sn = ? AND mac_address IS NOT NULL
    ORDER BY last_seen DESC LIMIT 1
  `).get(sn) as { mac_address: string } | undefined;
  return row?.mac_address ?? null;
}
