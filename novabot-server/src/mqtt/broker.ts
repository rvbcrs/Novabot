import net from 'net';
import { Aedes, Client, AedesPublishPacket } from 'aedes';
import { db } from '../db/database.js';
import { DeviceRegistryRow } from '../types/index.js';
import { startMqttBridge } from '../proxy/mqttBridge.js';

const PROXY_MODE = process.env.PROXY_MODE ?? 'local';

// Matcht standaard MAC-notaties: AA:BB:CC:DD:EE:FF of AA-BB-CC-DD-EE-FF
const MAC_SEP_RE  = /([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}/;
// Matcht 12 aaneengesloten hex-tekens (geen separator), bijv. AABBCCDDEEFF
const MAC_FLAT_RE = /(?<![0-9A-Fa-f])([0-9A-Fa-f]{12})(?![0-9A-Fa-f])/;
// Serienummer patroon: bijv. LFIC1230700004 of LFIN...
const SN_RE       = /LFI[A-Z][0-9]+/;
// ESP32 default client ID: "ESP32_XXXXXX" waarbij XXXXXX de laatste 3 bytes van het WiFi-MAC zijn
const ESP32_RE    = /ESP32_([0-9A-Fa-f]{6})$/i;

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

    if (!mac && !isAppClient) {
      const esp32Match = ESP32_RE.exec(clientId);
      if (esp32Match) {
        const last3 = esp32Match[1].toUpperCase().match(/.{2}/g)!.join(':');
        const apByte = (parseInt(last3.slice(-2), 16) + 1).toString(16).padStart(2, '0').toUpperCase();
        console.log(`[MQTT] ESP32 AP-MAC hint: ??:??:??:${last3.slice(0, -2)}${apByte}  (verbind met AP en run: arp -a)`);
      }
    }

    upsertDevice(clientId, sn, mac, user || null);

    // Sla credentials op zodat de MQTT bridge ze kan doorsturen naar upstream
    (client as any)._proxyMeta = { username: user || undefined, password: pass || undefined };

    // Registreer als online op basis van het bekende SN
    if (sn) {
      if (!onlineBySn.has(sn)) onlineBySn.set(sn, new Set());
      onlineBySn.get(sn)!.add(clientId);
    }

    (callback as Function)(null, true);
  };

  broker.on('client', (client: Client) => {
    // Fires na succesvolle CONNACK — bevestigt dat verbinding compleet is
    console.log(`[MQTT] READY    clientId="${client.id}"`);
  });

  // Fires als een client een protocol-fout maakt (na TCP connect, voor of tijdens MQTT session)
  broker.on('clientError', (client: Client, err: Error) => {
    console.error(`[MQTT] ERROR    clientId="${client.id}" err=${err.message}`);
  });

  // Fires bij verbindingsfout vóór/tijdens MQTT session setup (bijv. bad packet, auth crash)
  (broker as any).on('connectionError', (client: Client, err: Error) => {
    console.error(`[MQTT] CONN-ERR clientId="${client?.id ?? '?'}" err=${err.message}`);
  });

  // Fires als een client de keepalive deadline overschrijdt
  broker.on('keepaliveTimeout', (client: Client) => {
    console.warn(`[MQTT] KEEPALIVE-TIMEOUT clientId="${client.id}"`);
  });

  broker.on('clientDisconnect', (client: Client) => {
    seenClients.delete(client.id); // zodat reconnect weer gelogd wordt

    // Verwijder uit online-set op basis van SN in device_registry
    const row = db.prepare('SELECT sn FROM device_registry WHERE mqtt_client_id = ?')
      .get(client.id) as { sn: string | null } | undefined;
    if (row?.sn) {
      onlineBySn.get(row.sn)?.delete(client.id);
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
    const payload = packet.payload.toString();
    // Markeer berichten die via MQTT van app naar apparaat gaan (Dart/Send_mqtt/*)
    const direction = packet.topic.startsWith('Dart/Send_mqtt/') ? '→DEV' :
                      packet.topic.startsWith('Dart/Receive_mqtt/') ? '←DEV' : '';
    console.log(`[MQTT] PUBLISH  ${client.id} ${direction} ${packet.topic}  ${payload}`);

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
  });

  // Start MQTT bridge naar upstream als we in cloud proxy mode zijn
  if (PROXY_MODE === 'cloud') {
    startMqttBridge(broker);
  }

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[TCP]  OPEN  ${addr}`);

    // Workaround: ESP32-charger stuurt TCP FIN direct na MQTT CONNECT (half-close).
    // aedes schrijft CONNACK via een microtask (.then in fetchSubs), maar die microtask
    // loopt pas NA de 'end' event. Tegen die tijd heeft close() socket.destroy() al
    // aangeroepen en is client.connecting = false → write() weigert CONNACK te sturen.
    //
    // Fix: schrijf CONNACK SYNCHROON in de 'data' handler (vóór de microtask-grens)
    // en onderschep socket.destroy() → socket.end() zodat de write-buffer geflushed wordt.
    let earlyConnackSent = false;
    const origDestroy = socket.destroy.bind(socket);
    (socket as any).destroy = (..._args: unknown[]) => {
      if (earlyConnackSent) {
        // socket.end() flusht de write-buffer (CONNACK) vóórdat FIN verstuurd wordt.
        // Zonder dit discardt socket.destroy() alle gebufferde data.
        // Zet earlyConnackSent = false zodat latere destroy()-aanroepen (bijv. na
        // MQTT DISCONNECT) gewoon origDestroy() gebruiken en niet 3x DESTROY→END loggen.
        earlyConnackSent = false;
        console.log(`[TCP]  DESTROY→END ${addr} (flushing CONNACK)`);
        socket.end();
      } else {
        origDestroy();
      }
      return socket;
    };

    socket.once('data', (chunk) => {
      const hex = chunk.subarray(0, 20).toString('hex');
      console.log(`[TCP]  DATA  ${addr} (${chunk.length}B) first20=${hex}`);
      // MQTT CONNECT packet type = 0x10
      if (chunk[0] === 0x10) {
        // Stap 1: schrijf CONNACK SYNCHROON (vóór microtask-grens / 'end' event)
        socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
        earlyConnackSent = true;
        console.log(`[TCP]  CONNACK→ ${addr} (vroeg, synchroon)`);

        // Stap 2: log alle writes van aedes op deze socket (diagnostisch)
        // en onderdruk eventuele tweede CONNACK (type=0x20).
        const origWrite = socket.write.bind(socket);
        let dupSuppressed = false;
        console.log(`[TCP]  WRITE-INTERCEPT geïnstalleerd ${addr}`);
        (socket as any).write = function (data: Buffer | string | Uint8Array, ...rest: unknown[]): boolean {
          const buf = Buffer.isBuffer(data) ? data :
                      data instanceof Uint8Array ? Buffer.from(data) :
                      Buffer.from(data as string);
          const t = buf[0]?.toString(16).padStart(2, '0') ?? '??';
          console.log(`[TCP]  WRITE ${addr} (${buf.length}B) type=0x${t}`);
          if (!dupSuppressed && buf.length >= 2 && buf[0] === 0x20) {
            dupSuppressed = true;
            console.log(`[TCP]  CONNACK-DUP onderdrukt ${addr}`);
            // Roep de callback aan zodat aedes's interne serie doorloopt (→ READY)
            const cb = rest.find((a): a is () => void => typeof a === 'function');
            if (cb) process.nextTick(cb);
            return true;
          }
          return (origWrite as Function)(data, ...rest);
        };
      }
    });

    // Log ALLE binnenkomende data (ook na het CONNECT pakket) — voor diagnostiek
    socket.on('data', (chunk) => {
      const t = chunk[0]?.toString(16).padStart(2, '0') ?? '??';
      console.log(`[TCP]  RECV  ${addr} (${chunk.length}B) type=0x${t}`);
    });

    socket.on('close', (hadError) => console.log(`[TCP]  CLOSE ${addr} hadError=${hadError}`));
    socket.on('error', (err) => console.error(`[TCP]  ERROR ${addr} ${err.message}`));
    socket.on('end',   () => console.log(`[TCP]  END   ${addr}`));
    (broker.handle as (socket: net.Socket) => void)(socket);
  });
  server.listen(1883, '0.0.0.0', () => {
    console.log('[MQTT] Broker luistert op port 1883');
  });

  // Probe-servers: detecteer welk protocol/poort de app gebruikt voor MQTT.
  // - 8883: TLS-MQTT (raw TCP over TLS)
  // - 9001: MQTT over WebSocket (veel Flutter mqtt_client implementaties gebruiken dit)
  function makeProbe(port: number, label: string) {
    const probe = net.createServer((s) => {
      const first = Buffer.alloc(16);
      let n = 0;
      s.on('data', (chunk) => {
        if (n < 16) {
          chunk.copy(first, n, 0, Math.min(chunk.length, 16 - n));
          n += chunk.length;
        }
        if (n >= 4) {
          const hex = first.subarray(0, Math.min(n, 16)).toString('hex');
          const txt = first.subarray(0, Math.min(n, 16)).toString('utf8').replace(/[^\x20-\x7e]/g, '.');
          console.log(`[TCP]  PROBE-${port} (${label}) van ${s.remoteAddress} bytes=${hex} ascii="${txt}"`);
          s.destroy();
        }
      });
      s.on('error', () => {}); // negeer fouten op probe-sockets
    });
    probe.listen(port, '0.0.0.0', () => console.log(`[MQTT] Probe luistert op port ${port} (${label})`));
  }

  makeProbe(8883, 'TLS-MQTT');
  makeProbe(9001, 'WebSocket-MQTT');
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
