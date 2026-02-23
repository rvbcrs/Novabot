/**
 * Home Assistant MQTT Bridge — stuurt Novabot MQTT data door naar HA's Mosquitto
 * met auto-discovery zodat sensoren automatisch verschijnen.
 *
 * Alleen actief als HA_MQTT_HOST env var is geconfigureerd.
 */
import mqtt, { MqttClient } from 'mqtt';

const TAG = '[HA-MQTT]';

// Configuratie uit environment
const HA_MQTT_HOST       = process.env.HA_MQTT_HOST;
const HA_MQTT_PORT       = parseInt(process.env.HA_MQTT_PORT ?? '1883', 10);
const HA_MQTT_USER       = process.env.HA_MQTT_USER ?? '';
const HA_MQTT_PASS       = process.env.HA_MQTT_PASS ?? '';
const HA_DISCOVERY_PREFIX = process.env.HA_DISCOVERY_PREFIX ?? 'homeassistant';
const THROTTLE_MS        = parseInt(process.env.HA_THROTTLE_MS ?? '2000', 10);

let haClient: MqttClient | null = null;
let connected = false;

// ── Sensor definities ────────────────────────────────────────────

interface SensorDef {
  field: string;
  name: string;
  component: 'sensor' | 'binary_sensor';
  device_class?: string;
  state_class?: string;
  unit?: string;
  icon?: string;
  entity_category?: string;
}

const SENSORS: SensorDef[] = [
  // Charger velden
  { field: 'charger_status',   name: 'Charger Status',    component: 'sensor', icon: 'mdi:ev-station',           entity_category: 'diagnostic' },

  // Mower velden (uit charger's up_status_info)
  { field: 'mower_status',     name: 'Mower Status',      component: 'sensor', icon: 'mdi:robot-mower' },
  { field: 'mower_x',          name: 'Mower Position X',  component: 'sensor', icon: 'mdi:map-marker',           entity_category: 'diagnostic' },
  { field: 'mower_y',          name: 'Mower Position Y',  component: 'sensor', icon: 'mdi:map-marker',           entity_category: 'diagnostic' },
  { field: 'mower_z',          name: 'Mower Position Z',  component: 'sensor', icon: 'mdi:map-marker',           entity_category: 'diagnostic' },
  { field: 'mower_info',       name: 'Mower Info',        component: 'sensor', icon: 'mdi:information-outline',  entity_category: 'diagnostic' },
  { field: 'mower_info1',      name: 'Mower Info 1',      component: 'sensor', icon: 'mdi:information-outline',  entity_category: 'diagnostic' },
  { field: 'mower_error',      name: 'Mower Error',       component: 'sensor', icon: 'mdi:alert-circle',         entity_category: 'diagnostic' },

  // Batterij
  { field: 'battery_capacity', name: 'Battery',           component: 'sensor', icon: 'mdi:battery', device_class: 'battery', state_class: 'measurement', unit: '%' },

  // Werk status
  { field: 'work_mode',        name: 'Work Mode',         component: 'sensor', icon: 'mdi:cog' },
  { field: 'work_state',       name: 'Work State',        component: 'sensor', icon: 'mdi:state-machine' },
  { field: 'work_status',      name: 'Work Status',       component: 'sensor', icon: 'mdi:progress-wrench' },
  { field: 'task_mode',        name: 'Task Mode',         component: 'sensor', icon: 'mdi:clipboard-list' },
  { field: 'recharge_status',  name: 'Recharge Status',   component: 'sensor', icon: 'mdi:battery-charging' },
  { field: 'mowing_progress',  name: 'Mowing Progress',   component: 'sensor', icon: 'mdi:percent', state_class: 'measurement', unit: '%' },

  // Fout info
  { field: 'error_code',       name: 'Error Code',        component: 'sensor', icon: 'mdi:alert',                entity_category: 'diagnostic' },
  { field: 'error_msg',        name: 'Error Message',     component: 'sensor', icon: 'mdi:alert-circle-outline', entity_category: 'diagnostic' },
  { field: 'error_status',     name: 'Error Status',      component: 'sensor', icon: 'mdi:alert-outline',        entity_category: 'diagnostic' },

  // GPS
  { field: 'latitude',         name: 'Latitude',          component: 'sensor', icon: 'mdi:crosshairs-gps',       entity_category: 'diagnostic' },
  { field: 'longitude',        name: 'Longitude',         component: 'sensor', icon: 'mdi:crosshairs-gps',       entity_category: 'diagnostic' },
];

// ── Waarde vertalingen ────────────────────────────────────────────
// Vertaal ruwe numerieke/string waarden naar leesbare tekst voor HA

const MOWER_STATUS_MAP: Record<string, string> = {
  'backingCharger':    'Returning to charger',
  'backedCharger':     'At charger',
  'pauseAndCharging':  'Paused & charging',
  'gotoCharging':      'Going to charger',
  'startMowing':       'Mowing',
  'startMapping':      'Mapping',
  'noMowingUncharged': 'Low battery',
};

function translateChargerStatus(raw: number): string {
  if (raw === 0) return 'Idle';
  // Bits 0x01 en 0x100 zijn altijd aan in operationele toestand
  if ((raw & 0x0101) === 0x0101) return 'Operational';
  return String(raw);
}

function translateMowerError(raw: number): string {
  if (raw === 0) return 'OK';
  if (raw >= 1 && raw <= 9) return `Searching mower (${raw}/9)`;
  return String(raw);
}

function translateValue(field: string, rawValue: string): string {
  switch (field) {
    case 'charger_status': {
      const n = parseInt(rawValue, 10);
      return isNaN(n) ? rawValue : translateChargerStatus(n);
    }
    case 'mower_status':
      return MOWER_STATUS_MAP[rawValue] ?? rawValue;
    case 'mower_error': {
      const n = parseInt(rawValue, 10);
      return isNaN(n) ? rawValue : translateMowerError(n);
    }
    case 'error_code': {
      const n = parseInt(rawValue, 10);
      return (isNaN(n) || n === 0) ? 'None' : rawValue;
    }
    case 'error_status': {
      const n = parseInt(rawValue, 10);
      return (isNaN(n) || n === 0) ? 'OK' : `Error (${rawValue})`;
    }
    case 'recharge_status': {
      const n = parseInt(rawValue, 10);
      if (isNaN(n)) return rawValue;
      if (n === 0) return 'Not charging';
      if (n === 1) return 'Charging';
      return `Charging (${n})`;
    }
    default:
      return rawValue;
  }
}

// ── HA Device object ─────────────────────────────────────────────

function makeDevice(sn: string) {
  const isCharger = sn.startsWith('LFIC');
  return {
    identifiers: [`novabot_${sn}`],
    name: `Novabot ${isCharger ? 'Charger' : 'Mower'} ${sn}`,
    manufacturer: 'Novabot',
    model: 'N1000',
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
  for (const [sn, fields] of lastValues.entries()) {
    publishOnlineDiscoveryConfig(sn);
    for (const field of fields.keys()) {
      const sensor = SENSORS.find(s => s.field === field);
      if (sensor) publishDiscoveryConfig(sn, sensor);
    }
  }
}

// ── State publishing ─────────────────────────────────────────────

// Laatste gepubliceerde waarden per SN per veld — alleen publiceren bij wijziging
const lastValues = new Map<string, Map<string, string>>();
const lastPublishTime = new Map<string, number>();

/**
 * Ontvang een MQTT bericht van de Aedes broker en stuur het door naar HA.
 * Wordt aangeroepen vanuit broker.ts publish handler.
 */
export function forwardToHomeAssistant(topic: string, payload: Buffer, sn: string | null): void {
  if (!haClient || !connected || !sn) return;

  // Throttle: skip als laatste publish minder dan THROTTLE_MS geleden was
  const now = Date.now();
  const lastTime = lastPublishTime.get(sn) ?? 0;
  if (now - lastTime < THROTTLE_MS) return;
  lastPublishTime.set(sn, now);

  // Probeer als JSON te parsen (mower encrypted data faalt hier en wordt geskipt)
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload.toString());
  } catch {
    return;
  }

  // Eerste key = commando naam (bijv. "up_status_info")
  const commandName = Object.keys(parsed)[0];
  if (!commandName) return;

  // Publiceer ruwe JSON op raw topic
  haClient.publish(`novabot/${sn}/raw/${commandName}`, payload.toString(), { retain: true });

  // Als het up_status_info is: extraheer individuele velden
  if (commandName === 'up_status_info' && typeof parsed[commandName] === 'object' && parsed[commandName] !== null) {
    const data = parsed[commandName] as Record<string, unknown>;

    if (!lastValues.has(sn)) lastValues.set(sn, new Map());
    const snValues = lastValues.get(sn)!;

    for (const [field, value] of Object.entries(data)) {
      if (value === undefined || value === null) continue;
      const strValue = String(value);

      // Alleen publiceren als waarde veranderd is (vergelijk op ruwe waarde)
      if (snValues.get(field) === strValue) continue;
      snValues.set(field, strValue);

      // Zorg dat discovery config gepubliceerd is voor bekende velden
      const sensor = SENSORS.find(s => s.field === field);
      if (sensor) {
        publishDiscoveryConfig(sn, sensor);
      }

      // Vertaal naar leesbare tekst en publiceer
      const displayValue = translateValue(field, strValue);
      haClient.publish(`novabot/${sn}/${field}`, displayValue, { retain: true });
    }
  }
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
