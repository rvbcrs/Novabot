/**
 * MQTT Bridge — connects to upstream mqtt.lfibot.com and forwards
 * all publish/subscribe traffic in both directions, logging everything.
 *
 * Activated when PROXY_MODE=cloud.
 */
import mqtt from 'mqtt';
import type { Aedes, Client, AedesPublishPacket } from 'aedes';

// Gebruik direct het IP-adres om DNS-rewrite loops te voorkomen
const UPSTREAM_MQTT = process.env.UPSTREAM_MQTT ?? 'mqtt://47.253.162.193:1883';
const TAG = '[PROXY-MQTT]';

// Per lokaal verbonden device een upstream MQTT client
const upstreamClients = new Map<string, mqtt.MqttClient>();
// Track subscriptions per client to mirror upstream
const clientSubs = new Map<string, Set<string>>();

export function startMqttBridge(broker: Aedes): void {
  console.log(`${TAG} Bridge modus actief — forwarding naar ${UPSTREAM_MQTT}`);

  // Wanneer een lokale client verbindt, maak een upstream connectie
  broker.on('client', (client: Client) => {
    const clientId = client.id;
    if (upstreamClients.has(clientId)) return; // al verbonden

    // Haal credentials op van de originele client (opgeslagen in authenticate)
    const meta = (client as any)._proxyMeta as { username?: string; password?: string } | undefined;
    const username = meta?.username;
    const password = meta?.password;

    console.log(`${TAG} ↑ Upstream verbinding openen voor clientId="${clientId}" user="${username ?? '?'}"`);

    const upstream = mqtt.connect(UPSTREAM_MQTT, {
      clientId,
      username: username ?? undefined,
      password: password ?? undefined,
      clean: true,
      connectTimeout: 10000,
      reconnectPeriod: 5000,
    });

    upstream.on('connect', () => {
      console.log(`${TAG} ↑ Upstream CONNECTED voor clientId="${clientId}"`);
    });

    upstream.on('error', (err) => {
      console.error(`${TAG} ↑ Upstream ERROR voor clientId="${clientId}": ${err.message}`);
    });

    upstream.on('close', () => {
      console.log(`${TAG} ↑ Upstream CLOSED voor clientId="${clientId}"`);
    });

    // Berichten van upstream → doorsturen naar lokale client
    upstream.on('message', (topic, payload) => {
      const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      const payloadStr = payloadBuf.toString();
      console.log(`${TAG} ↓ UPSTREAM→LOCAL clientId="${clientId}" topic="${topic}" (${payloadBuf.length}B)`);
      if (payloadStr.length < 4096) {
        try {
          const pretty = JSON.stringify(JSON.parse(payloadStr), null, 2);
          console.log(`${TAG} ↓ Payload:\n${pretty}`);
        } catch {
          // Niet-JSON payload (waarschijnlijk AES encrypted) — log als hex
          console.log(`${TAG} ↓ Payload (hex): ${payloadBuf.toString('hex').substring(0, 400)}`);
          console.log(`${TAG} ↓ Payload (raw): ${payloadStr.substring(0, 200)}`);
        }
      }

      // Publiceer op lokale broker zodat de lokale client het ontvangt
      broker.publish(
        { topic, payload, cmd: 'publish', qos: 0, dup: false, retain: false } as any,
        () => {}
      );
    });

    upstreamClients.set(clientId, upstream);
    clientSubs.set(clientId, new Set());
  });

  // Wanneer een lokale client disconnecteert, sluit upstream connectie
  broker.on('clientDisconnect', (client: Client) => {
    const upstream = upstreamClients.get(client.id);
    if (upstream) {
      console.log(`${TAG} ↑ Upstream sluiten voor clientId="${client.id}"`);
      upstream.end(true);
      upstreamClients.delete(client.id);
      clientSubs.delete(client.id);
    }
  });

  // Wanneer een lokale client subscribeert, ook upstream subscriben
  broker.on('subscribe', (subscriptions, client: Client) => {
    const upstream = upstreamClients.get(client.id);
    if (!upstream) return;

    const subs = clientSubs.get(client.id) ?? new Set();
    for (const sub of subscriptions) {
      if (subs.has(sub.topic)) continue;
      subs.add(sub.topic);
      console.log(`${TAG} ↑ SUBSCRIBE upstream clientId="${client.id}" topic="${sub.topic}"`);
      upstream.subscribe(sub.topic);
    }
  });

  // Wanneer een lokale client publiceert, ook upstream doorsturen
  broker.on('publish', (packet: AedesPublishPacket, client: Client | null) => {
    if (!client) return; // broker-interne berichten negeren
    if (packet.topic.startsWith('$')) return; // systeem-topics negeren

    const upstream = upstreamClients.get(client.id);
    if (!upstream) return;

    const payloadBuf = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);
    const payloadStr = payloadBuf.toString();
    console.log(`${TAG} ↑ LOCAL→UPSTREAM clientId="${client.id}" topic="${packet.topic}" (${payloadBuf.length}B)`);
    if (payloadStr.length < 4096) {
      try {
        const pretty = JSON.stringify(JSON.parse(payloadStr), null, 2);
        console.log(`${TAG} ↑ Payload:\n${pretty}`);
      } catch {
        // Niet-JSON payload (waarschijnlijk AES encrypted) — log als hex
        console.log(`${TAG} ↑ Payload (hex): ${payloadBuf.toString('hex').substring(0, 400)}`);
      }
    }

    upstream.publish(packet.topic, packet.payload, { qos: packet.qos, retain: packet.retain });
  });

  console.log(`${TAG} Bridge hooks geïnstalleerd — wacht op client verbindingen`);
}
