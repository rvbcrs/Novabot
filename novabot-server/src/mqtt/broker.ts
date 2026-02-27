import net from 'net';
import { Aedes, Client, AedesPublishPacket } from 'aedes';
import { db } from '../db/database.js';
import { DeviceRegistryRow } from '../types/index.js';
import { startMqttBridge } from '../proxy/mqttBridge.js';
import { tryDecrypt } from './decrypt.js';
import { startHomeAssistantBridge, forwardToHomeAssistant, publishDeviceOnline, publishDeviceOffline } from './homeassistant.js';
import { updateDeviceData } from './sensorData.js';
import { forwardToDashboard, emitDeviceOnline, emitDeviceOffline, pushMqttLog } from '../dashboard/socketHandler.js';
import { initMapSync, onMowerConnected, handleMapMessage } from './mapSync.js';

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

function isAppClient(clientId: string): boolean {
  // App MQTT clients hebben een UUID@appUser_SN patroon of bevatten een JWT prefix
  return clientId.includes('@') || clientId.startsWith('eyJ');
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

/**
 * Schrijf een raw MQTT PUBLISH packet direct naar de TCP socket van een apparaat.
 * Omzeilt aedes volledig — voor debugging van delivery issues.
 */
export function writeRawPublish(sn: string, payload: Buffer, qos: 0 | 1 = 0): boolean {
  const socket = rawSocketBySn.get(sn);
  if (!socket || socket.destroyed) {
    console.error(`[RAW-TCP] Geen actieve socket voor ${sn}`);
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
  console.log(`[RAW-TCP] Schrijf ${packet.length}B MQTT PUBLISH (QoS ${qos}) naar ${sn} socket`);
  console.log(`[RAW-TCP]   Fixed: 0x${fixedHeader.toString(16)}, RemLen: ${remainingLen}, Topic: ${topic} (${topicBuf.length}B), Payload: ${payload.length}B`);
  console.log(`[RAW-TCP]   Hex (first 32): ${packet.subarray(0, 32).toString('hex')}`);

  try {
    socket.write(packet);
    return true;
  } catch (err) {
    console.error(`[RAW-TCP] Write failed:`, err);
    return false;
  }
}

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

  // Initialiseer mapSync met de broker zodat we MQTT commands kunnen publiceren
  initMapSync(broker);

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

    pushMqttLog({
      ts: now, type: 'connect', clientId, clientType, sn: sn ?? null,
      direction: '', topic: '', payload: `user="${user}" mac=${mac ?? '?'}`, encrypted: false,
    });

    upsertDevice(clientId, sn, mac, user || null);

    // Sla credentials op zodat de MQTT bridge ze kan doorsturen naar upstream
    (client as any)._proxyMeta = { username: user || undefined, password: pass || undefined };

    // Registreer als online op basis van het bekende SN
    if (sn) {
      if (!onlineBySn.has(sn)) onlineBySn.set(sn, new Set());
      onlineBySn.get(sn)!.add(clientId);
      publishDeviceOnline(sn);
      emitDeviceOnline(sn);
      // Automatisch kaarten opvragen bij maaier-connect
      onMowerConnected(sn);
    }

    (callback as Function)(null, true);
  };

  broker.on('clientError', (client: Client, err: Error) => {
    console.error(`[MQTT] ERROR    clientId="${client.id}" err=${err.message}`);
    pushMqttLog({
      ts: Date.now(), type: 'error', clientId: client.id, clientType: '?', sn: null,
      direction: '', topic: '', payload: err.message, encrypted: false,
    });
  });

  (broker as any).on('connectionError', (client: Client, err: Error) => {
    console.error(`[MQTT] CONN-ERR clientId="${client?.id ?? '?'}" err=${err.message}`);
  });

  broker.on('clientDisconnect', (client: Client) => {
    seenClients.delete(client.id); // zodat reconnect weer gelogd wordt

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
      console.log(`[MQTT] DISCONNECT clientId="${client.id}" sn=${disconnSn}`);
    } else {
      console.log(`[MQTT] DISCONNECT clientId="${client.id}"`);
    }
    pushMqttLog({
      ts: Date.now(), type: 'disconnect', clientId: client.id, clientType: '?', sn: disconnSn,
      direction: '', topic: '', payload: '', encrypted: false,
    });
  });

  broker.on('subscribe', (subscriptions, client: Client) => {
    const topics = subscriptions.map(s => s.topic).join(', ');
    console.log(`[MQTT] SUBSCRIBE ${client.id} -> [${topics}]`);
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
          else console.log(`[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  ${tag}[AES] ${decrypted}  (×30 suppressed)`);
        } else {
          console.log(`[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  ${tag}[AES] ${decrypted}`);
        }
      } else {
        // Niet ontsleutelbaar — toon als plain text als het al JSON is, anders als encrypted
        const plain = payloadBuf.toString();
        if (plain.startsWith('{') || plain.startsWith('[')) {
          const tag = tagForPayload(plain);
          logPayload = plain;
          console.log(`[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  ${tag}${logPayload}`);
        } else {
          console.log(`[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  [encrypted ${payloadBuf.length}B]`);
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
        else console.log(`[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  ${tag}${logPayload}  (×30 suppressed)`);
      } else {
        console.log(`[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  ${tag}${logPayload}`);
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
    if (encryptSn) {
      const decryptedJson = tryDecrypt(payloadBuf, encryptSn);
      if (decryptedJson) {
        const decryptedBuf = Buffer.from(decryptedJson, 'utf8');

        // Check of dit een kaart-gerelateerde response is
        try {
          const parsed = JSON.parse(decryptedJson);
          handleMapMessage(encryptSn, parsed);
        } catch { /* geen JSON of geen map-bericht */ }

        const changes = updateDeviceData(encryptSn, decryptedBuf);
        forwardToHomeAssistant(packet.topic, decryptedBuf, encryptSn, changes);
        forwardToDashboard(encryptSn, changes);
      }
    } else if (topicSn) {
      // Check ook niet-versleutelde berichten op kaart-responses
      try {
        const parsed = JSON.parse(payload);
        handleMapMessage(topicSn, parsed);
      } catch { /* geen JSON of geen map-bericht */ }

      const changes = updateDeviceData(topicSn, payloadBuf);
      forwardToHomeAssistant(packet.topic, payloadBuf, topicSn, changes);
      forwardToDashboard(topicSn, changes);
    }
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
        // Probeer SN uit CONNECT packet te extraheren en socket op te slaan
        try {
          const connectStr = chunk.toString('utf8');
          const snMatch = connectStr.match(/LFI[A-Z]\d{10,}/);
          if (snMatch) {
            rawSocketBySn.set(snMatch[0], socket);
            console.log(`[RAW-TCP] Socket opgeslagen voor ${snMatch[0]} (${socket.remoteAddress}:${socket.remotePort})`);

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
                console.log(`[RAW-IN] ${deviceSn} ← ${inBuf.length}B ${typeStr} hex=${inBuf.subarray(0, Math.min(32, inBuf.length)).toString('hex')}`);
              }
              return origEmit(event, ...args);
            };

            socket.once('close', () => {
              rawSocketBySn.delete(deviceSn);
              console.log(`[RAW-TCP] Socket verwijderd voor ${deviceSn}`);
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
          // Debug: log writes naar device socket
          const dbgBuf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
          console.log(`[MQTT-DBG] WRITE ${dbgBuf.length}B type=0x${dbgBuf[0].toString(16)} hex=${dbgBuf.subarray(0, Math.min(16, dbgBuf.length)).toString('hex')}`);
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

// Hulpfunctie voor equipment.ts: zoek het BLE MAC-adres op voor een gegeven SN.
// Zoekt eerst in device_registry (alleen echte apparaat-entries, geen app-clients),
// en valt daarna terug op de equipment tabel (handmatig of eerder geregistreerd).
export function lookupMac(sn: string): string | null {
  // 1. Zoek in device_registry (app-clients worden al gefilterd door extractMac)
  const regRow = db.prepare(`
    SELECT mac_address FROM device_registry
    WHERE sn = ? AND mac_address IS NOT NULL
    ORDER BY last_seen DESC LIMIT 1
  `).get(sn) as { mac_address: string } | undefined;
  if (regRow) return regRow.mac_address;

  // 2. Fallback: zoek in equipment tabel (gezet via admin API of eerdere binding)
  const eqRow = db.prepare(`
    SELECT mac_address FROM equipment
    WHERE (mower_sn = ? OR charger_sn = ?) AND mac_address IS NOT NULL
    LIMIT 1
  `).get(sn, sn) as { mac_address: string } | undefined;
  return eqRow?.mac_address ?? null;
}
