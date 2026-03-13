/**
 * MQTT client module for mower diagnostics.
 *
 * The mower doesn't support BLE get commands, so we use MQTT
 * (same as the app) to query LoRa info, device info, etc.
 *
 * AES-128-CBC encryption:
 *   key = "abcdabcd1234" + SN[-4:]
 *   IV  = "abcd1234abcd1234"
 */

import crypto from 'crypto';
import mqtt from 'mqtt';

const KEY_PREFIX = 'abcdabcd1234';
const IV = Buffer.from('abcd1234abcd1234', 'utf8');
const RESPONSE_TIMEOUT = 10_000;

let client: mqtt.MqttClient | null = null;
let brokerUrl = '';

// Pending command responses keyed by SN
const pendingResponses = new Map<string, {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// Listeners for live sensor updates
const sensorListeners: Array<(sn: string, data: Record<string, unknown>) => void> = [];

// ── AES Encrypt/Decrypt ─────────────────────────────────────────────────────

function buildKey(sn: string): Buffer {
  return Buffer.from(KEY_PREFIX + sn.slice(-4), 'utf8');
}

function encrypt(sn: string, json: string): Buffer {
  const key = buildKey(sn);
  const plaintext = Buffer.from(json, 'utf8');
  const padded = Buffer.alloc(Math.ceil(plaintext.length / 16) * 16, 0);
  plaintext.copy(padded);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function decrypt(sn: string, payload: Buffer): string | null {
  if (!sn || sn.length < 4) return null;
  if (payload.length < 16 || payload.length % 16 !== 0) return null;

  try {
    const key = buildKey(sn);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, IV);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);

    let end = decrypted.length;
    while (end > 0 && decrypted[end - 1] === 0) end--;
    if (end === 0) return null;

    const json = decrypted.subarray(0, end).toString('utf8');
    if (json[0] !== '{' && json[0] !== '[') return null;
    return json;
  } catch {
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface MqttStatusResult {
  connected: boolean;
  broker: string;
}

export interface MqttCommandResult {
  command: string;
  ok: boolean;
  response: unknown;
  error?: string;
}

/**
 * Connect to the MQTT broker.
 */
export function connectBroker(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (client) {
      try { client.end(true); } catch { /* ignore */ }
    }

    brokerUrl = `mqtt://${host}:${port}`;
    console.log(`[MQTT] Connecting to ${brokerUrl}...`);

    client = mqtt.connect(brokerUrl, {
      keepalive: 60,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    });

    const timeout = setTimeout(() => {
      reject(new Error(`MQTT connection timeout to ${brokerUrl}`));
    }, 10000);

    client.on('connect', () => {
      clearTimeout(timeout);
      console.log(`[MQTT] Connected to ${brokerUrl}`);
      resolve();
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[MQTT] Error: ${err.message}`);
      reject(err);
    });

    client.on('message', (_topic, payload) => {
      handleMessage(_topic, payload);
    });
  });
}

/**
 * Disconnect from the MQTT broker.
 */
export function disconnectBroker(): void {
  if (client) {
    try { client.end(true); } catch { /* ignore */ }
    client = null;
    console.log('[MQTT] Disconnected');
  }
}

/**
 * Get MQTT connection status.
 */
export function getMqttStatus(): MqttStatusResult {
  return {
    connected: client?.connected ?? false,
    broker: brokerUrl,
  };
}

/**
 * Subscribe to a device's response topic.
 */
export function subscribeDevice(sn: string): void {
  if (!client?.connected) return;

  const topic = `Dart/Receive_mqtt/${sn}`;
  client.subscribe(topic, (err) => {
    if (err) {
      console.error(`[MQTT] Subscribe error for ${topic}: ${err.message}`);
    } else {
      console.log(`[MQTT] Subscribed to ${topic}`);
    }
  });

  // Also subscribe to server topic
  const serverTopic = `Dart/Receive_server_mqtt/${sn}`;
  client.subscribe(serverTopic, (err) => {
    if (err) {
      console.error(`[MQTT] Subscribe error for ${serverTopic}: ${err.message}`);
    } else {
      console.log(`[MQTT] Subscribed to ${serverTopic}`);
    }
  });
}

/**
 * Send an encrypted command to a device via MQTT and wait for response.
 */
export async function sendMqttCommand(
  sn: string,
  command: Record<string, unknown>,
  timeoutMs = RESPONSE_TIMEOUT,
): Promise<MqttCommandResult> {
  if (!client?.connected) {
    return { command: Object.keys(command)[0], ok: false, response: null, error: 'MQTT not connected' };
  }

  const cmdName = Object.keys(command)[0];
  const topic = `Dart/Send_mqtt/${sn}`;
  const json = JSON.stringify(command);

  // Encrypt if it's a Novabot device
  let payload: Buffer;
  if (sn.startsWith('LFI')) {
    payload = encrypt(sn, json);
    console.log(`[MQTT] → ${topic}: ${json} (${payload.length}B encrypted)`);
  } else {
    payload = Buffer.from(json, 'utf8');
    console.log(`[MQTT] → ${topic}: ${json}`);
  }

  // Set up response listener
  const responsePromise = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(sn);
      reject(new Error(`MQTT response timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingResponses.set(sn, { resolve, reject, timer });
  });

  // Publish
  client.publish(topic, payload);

  try {
    const response = await responsePromise;
    return { command: cmdName, ok: true, response };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { command: cmdName, ok: false, response: null, error: msg };
  }
}

/**
 * Query mower LoRa info via MQTT.
 */
export async function queryMowerLoraInfo(sn: string): Promise<MqttCommandResult> {
  subscribeDevice(sn);
  await sleep(200);
  return sendMqttCommand(sn, { get_lora_info: null });
}

/**
 * Query mower device info via MQTT.
 */
export async function queryMowerDevInfo(sn: string): Promise<MqttCommandResult> {
  subscribeDevice(sn);
  await sleep(200);
  return sendMqttCommand(sn, { get_dev_info: null });
}

/**
 * Query mower para info (various parameters) via MQTT.
 */
export async function queryMowerParaInfo(sn: string): Promise<MqttCommandResult> {
  subscribeDevice(sn);
  await sleep(200);
  return sendMqttCommand(sn, { get_para_info: null });
}

/**
 * Add a listener for live sensor data updates.
 */
export function onSensorData(listener: (sn: string, data: Record<string, unknown>) => void): void {
  sensorListeners.push(listener);
}

/**
 * Remove a sensor data listener.
 */
export function offSensorData(listener: (sn: string, data: Record<string, unknown>) => void): void {
  const idx = sensorListeners.indexOf(listener);
  if (idx !== -1) sensorListeners.splice(idx, 1);
}

// ── Internal ────────────────────────────────────────────────────────────────

function handleMessage(topic: string, payload: Buffer): void {
  // Extract SN from topic: Dart/Receive_mqtt/<SN> or Dart/Receive_server_mqtt/<SN>
  const parts = topic.split('/');
  const sn = parts[parts.length - 1];

  // Try to decrypt
  let json: string | null = null;
  if (sn.startsWith('LFI')) {
    json = decrypt(sn, payload);
  }
  if (!json) {
    json = payload.toString('utf8');
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json);
  } catch {
    return;
  }

  console.log(`[MQTT] ← ${topic}: ${JSON.stringify(data).substring(0, 200)}`);

  // Emit to sensor listeners
  for (const listener of sensorListeners) {
    listener(sn, data);
  }

  // Resolve pending command response
  const pending = pendingResponses.get(sn);
  if (pending) {
    clearTimeout(pending.timer);
    pendingResponses.delete(sn);
    pending.resolve(data);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
