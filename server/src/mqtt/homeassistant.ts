/**
 * Home Assistant MQTT Bridge — stuurt Novabot MQTT data door naar HA's Mosquitto
 * met auto-discovery zodat sensoren automatisch verschijnen.
 *
 * Alleen actief als HA_MQTT_HOST env var is geconfigureerd.
 */
import mqtt, { MqttClient } from 'mqtt';
import { SENSORS, SensorDef, deviceCache, parseCommand } from './sensorData.js';

const TAG = '[HA-MQTT]';

// Configuratie uit environment
const HA_MQTT_HOST       = process.env.HA_MQTT_HOST;
const HA_MQTT_PORT       = parseInt(process.env.HA_MQTT_PORT ?? '1883', 10);
const HA_MQTT_USER       = process.env.HA_MQTT_USER ?? '';
const HA_MQTT_PASS       = process.env.HA_MQTT_PASS ?? '';
const HA_DISCOVERY_PREFIX = process.env.HA_DISCOVERY_PREFIX ?? 'homeassistant';
const THROTTLE_MS        = parseInt(process.env.HA_THROTTLE_MS ?? '2000', 10);

// Public URL the HA image entity hits to fetch the rendered map. HA's
// MQTT image platform follows the URL we publish to `url_topic` and
// caches it until the next publish — we re-publish on every throttled
// sensor tick (with a ?ts=… cache-buster) so the image refreshes ~every
// HA_THROTTLE_MS milliseconds.
const RENDER_BASE_URL = process.env.RENDER_BASE_URL ?? '';
// Throttle map-image refreshes separately — repainting the SVG is cheap
// but spamming HA's image fetch every 2 s is overkill.
const MAP_IMAGE_THROTTLE_MS = parseInt(process.env.HA_MAP_THROTTLE_MS ?? '15000', 10);

let haClient: MqttClient | null = null;
let connected = false;

// ── HA Device object ─────────────────────────────────────────────

function makeDevice(sn: string) {
  const isCharger = sn.startsWith('LFIC');
  return {
    identifiers: [`novabot_${sn}`],
    name: `Novabot ${isCharger ? 'Charger' : 'Mower'} ${sn}`,
    manufacturer: 'Novabot',
    model: 'N2000',
    sw_version: 'local-bridge',
  };
}

// ── Discovery config publishing ──────────────────────────────────

const publishedConfigs = new Set<string>();

function publishDiscoveryConfig(sn: string, sensor: SensorDef): void {
  if (!haClient || !connected) return;

  const configKey = `${sn}:${sensor.field}`;
  if (publishedConfigs.has(configKey)) return;

  const objectId = `novabot_${sn}_${sensor.field}`;
  const stateTopic = `novabot/${sn}/${sensor.field}`;
  const configTopic = `${HA_DISCOVERY_PREFIX}/${sensor.component}/${objectId}/config`;

  const config: Record<string, unknown> = {
    name: sensor.name,
    unique_id: objectId,
    object_id: objectId,
    state_topic: stateTopic,
    device: makeDevice(sn),
    availability: [
      { topic: `novabot/${sn}/availability`, payload_available: 'online', payload_not_available: 'offline' },
      { topic: 'novabot/bridge/status', payload_available: 'online', payload_not_available: 'offline' },
    ],
    availability_mode: 'all',
  };

  if (sensor.device_class)    config.device_class = sensor.device_class;
  if (sensor.state_class)     config.state_class = sensor.state_class;
  if (sensor.unit)            config.unit_of_measurement = sensor.unit;
  if (sensor.icon)            config.icon = sensor.icon;
  if (sensor.entity_category) config.entity_category = sensor.entity_category;

  haClient.publish(configTopic, JSON.stringify(config), { retain: true, qos: 1 }, (err) => {
    if (err) {
      console.error(`${TAG} Discovery fout voor ${objectId}: ${err.message}`);
    } else {
      publishedConfigs.add(configKey);
    }
  });
}

function publishOnlineDiscoveryConfig(sn: string): void {
  if (!haClient || !connected) return;

  const configKey = `${sn}:online`;
  if (publishedConfigs.has(configKey)) return;

  const objectId = `novabot_${sn}_online`;
  const configTopic = `${HA_DISCOVERY_PREFIX}/binary_sensor/${objectId}/config`;

  const config = {
    name: 'Online',
    unique_id: objectId,
    object_id: objectId,
    state_topic: `novabot/${sn}/availability`,
    device: makeDevice(sn),
    device_class: 'connectivity',
    payload_on: 'online',
    payload_off: 'offline',
    entity_category: 'diagnostic',
    availability: {
      topic: 'novabot/bridge/status',
      payload_available: 'online',
      payload_not_available: 'offline',
    },
  };

  haClient.publish(configTopic, JSON.stringify(config), { retain: true, qos: 1 }, (err) => {
    if (!err) publishedConfigs.add(configKey);
  });
}

// Herpubliceer alle discovery configs (na reconnect met HA)
function publishAllDiscoveryConfigs(): void {
  publishedConfigs.clear();
  for (const [sn, fields] of deviceCache.entries()) {
    publishOnlineDiscoveryConfig(sn);
    publishMapImageDiscoveryConfig(sn);
    for (const field of fields.keys()) {
      const sensor = SENSORS.find(s => s.field === field);
      if (sensor) publishDiscoveryConfig(sn, sensor);
    }
  }
}

// ── Map image entity ─────────────────────────────────────────────
//
// HA's MQTT image platform fetches the URL we publish on `url_topic`
// whenever a fresh value lands on the topic. This gives the user a
// live mower-map dashboard tile out of the box — no custom Lovelace
// card, no YAML.
//
// Mowers only (chargers don't have a map). Skips silently if
// RENDER_BASE_URL is unset.

function publishMapImageDiscoveryConfig(sn: string): void {
  if (!haClient || !connected) return;
  if (!RENDER_BASE_URL) return;
  if (!sn.startsWith('LFIN')) return;

  const configKey = `${sn}:map_image`;
  if (publishedConfigs.has(configKey)) return;

  const objectId = `novabot_${sn}_map`;
  const configTopic = `${HA_DISCOVERY_PREFIX}/image/${objectId}/config`;

  const config = {
    name: 'Map',
    unique_id: objectId,
    object_id: objectId,
    url_topic: `novabot/${sn}/map_url`,
    content_type: 'image/svg+xml',
    icon: 'mdi:map',
    device: makeDevice(sn),
    availability: [
      { topic: `novabot/${sn}/availability`, payload_available: 'online', payload_not_available: 'offline' },
      { topic: 'novabot/bridge/status', payload_available: 'online', payload_not_available: 'offline' },
    ],
    availability_mode: 'all',
  };

  haClient.publish(configTopic, JSON.stringify(config), { retain: true, qos: 1 }, (err) => {
    if (!err) publishedConfigs.add(configKey);
  });
}

const lastMapPublish = new Map<string, number>();

function publishMapImageUrl(sn: string): void {
  if (!haClient || !connected) return;
  if (!RENDER_BASE_URL) return;
  if (!sn.startsWith('LFIN')) return;

  const now = Date.now();
  const last = lastMapPublish.get(sn) ?? 0;
  if (now - last < MAP_IMAGE_THROTTLE_MS) return;
  lastMapPublish.set(sn, now);

  // ?ts=… busts both the HA fetch cache AND any HTTP intermediary cache.
  const url = `${RENDER_BASE_URL.replace(/\/$/, '')}/api/render/map/${sn}.svg?ts=${now}`;
  haClient.publish(`novabot/${sn}/map_url`, url, { retain: true });
}

// ── State publishing ─────────────────────────────────────────────

const lastPublishTime = new Map<string, number>();

/**
 * Ontvang een MQTT bericht van de Aedes broker en stuur het door naar HA.
 * Wordt aangeroepen vanuit broker.ts publish handler.
 *
 * @param topic    MQTT topic
 * @param payload  Payload buffer (plain of ontsleuteld)
 * @param sn       Serienummer van het apparaat
 * @param changes  Pre-computed gewijzigde velden (uit updateDeviceData), of null om zelf te parsen
 */
export function forwardToHomeAssistant(
  topic: string,
  payload: Buffer,
  sn: string | null,
  changes: Map<string, string> | null,
): void {
  if (!haClient || !connected || !sn) return;

  // Throttle: skip als laatste publish minder dan THROTTLE_MS geleden was
  const now = Date.now();
  const lastTime = lastPublishTime.get(sn) ?? 0;
  if (now - lastTime < THROTTLE_MS) return;
  lastPublishTime.set(sn, now);

  // Publiceer ruwe JSON op raw topic
  const cmd = parseCommand(payload);
  if (cmd) {
    haClient.publish(`novabot/${sn}/raw/${cmd.command}`, payload.toString(), { retain: true });
  }

  // Publiceer individuele gewijzigde velden
  if (changes) {
    for (const [field, displayValue] of changes) {
      const sensor = SENSORS.find(s => s.field === field);
      if (sensor) publishDiscoveryConfig(sn, sensor);
      haClient.publish(`novabot/${sn}/${field}`, displayValue, { retain: true });
    }
  }

  // Publiceer ook de map-image URL (eigen throttle, zie publishMapImageUrl)
  publishMapImageDiscoveryConfig(sn);
  publishMapImageUrl(sn);
}

// ── Online/offline status ────────────────────────────────────────

export function publishDeviceOnline(sn: string): void {
  if (!haClient || !connected) return;
  publishOnlineDiscoveryConfig(sn);
  haClient.publish(`novabot/${sn}/availability`, 'online', { retain: true });
  console.log(`${TAG} ${sn} → online`);
}

export function publishDeviceOffline(sn: string): void {
  if (!haClient || !connected) return;
  publishOnlineDiscoveryConfig(sn);
  haClient.publish(`novabot/${sn}/availability`, 'offline', { retain: true });
  console.log(`${TAG} ${sn} → offline`);
}

// ── Verbinding starten ───────────────────────────────────────────

export function startHomeAssistantBridge(): void {
  if (!HA_MQTT_HOST) {
    console.log(`${TAG} HA_MQTT_HOST niet geconfigureerd — Home Assistant bridge uitgeschakeld`);
    return;
  }

  const brokerUrl = `mqtt://${HA_MQTT_HOST}:${HA_MQTT_PORT}`;
  console.log(`${TAG} Verbinden met Home Assistant Mosquitto op ${brokerUrl}`);

  haClient = mqtt.connect(brokerUrl, {
    clientId: 'novabot-bridge',
    username: HA_MQTT_USER || undefined,
    password: HA_MQTT_PASS || undefined,
    clean: true,
    connectTimeout: 10_000,
    reconnectPeriod: 30_000,
    will: {
      topic: 'novabot/bridge/status',
      payload: Buffer.from('offline'),
      qos: 1,
      retain: true,
    },
  });

  haClient.on('connect', () => {
    connected = true;
    console.log(`${TAG} Verbonden met HA Mosquitto op ${brokerUrl}`);
    haClient!.publish('novabot/bridge/status', 'online', { retain: true });
    publishAllDiscoveryConfigs();
  });

  haClient.on('close', () => {
    connected = false;
  });

  haClient.on('error', (err) => {
    console.error(`${TAG} Fout: ${err.message}`);
  });

  haClient.on('offline', () => {
    connected = false;
    console.log(`${TAG} Verbinding met HA Mosquitto verloren, herverbinden...`);
  });
}
