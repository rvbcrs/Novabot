/**
 * Notification dispatcher — fans events out to ntfy.sh, an optional HA
 * webhook, the local MQTT broker (`novabot/events/<SN>`), and an in-memory
 * ring buffer that the HTTP `GET /api/events/:sn` endpoint serves.
 *
 * Channels are independently configured via env vars and silently skipped
 * when not set, so a fresh install with only an MQTT broker still emits
 * events on the `novabot/events/<SN>` topic for HA's MQTT integration.
 */
import { publishToTopic } from '../mqtt/mapSync.js';
import { MowerEvent } from './types.js';

const TAG = '[NOTIFY]';

const NTFY_URL = process.env.NTFY_URL ?? 'https://ntfy.sh';
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? '';
const NTFY_PRIORITY = process.env.NTFY_PRIORITY ?? '';   // 1..5 or '' for default
const HA_WEBHOOK_URL = process.env.HA_WEBHOOK_URL ?? '';
const EVENTS_MQTT_PREFIX = process.env.EVENTS_MQTT_TOPIC_PREFIX ?? 'novabot/events';

const RING_SIZE = 200;
const ringPerSn = new Map<string, MowerEvent[]>();

function pushRing(ev: MowerEvent): void {
  let list = ringPerSn.get(ev.sn);
  if (!list) {
    list = [];
    ringPerSn.set(ev.sn, list);
  }
  list.push(ev);
  if (list.length > RING_SIZE) list.splice(0, list.length - RING_SIZE);
}

export function getRecentEvents(sn: string, limit = 50): MowerEvent[] {
  const list = ringPerSn.get(sn) ?? [];
  return list.slice(-limit).reverse();   // newest first
}

async function sendNtfy(ev: MowerEvent): Promise<void> {
  if (!NTFY_TOPIC) return;
  const url = `${NTFY_URL.replace(/\/$/, '')}/${NTFY_TOPIC}`;
  const headers: Record<string, string> = {
    'Title': `${ev.title} — ${ev.sn}`,
    'Tags': `mower,${ev.type}`,
  };
  if (NTFY_PRIORITY) headers['Priority'] = NTFY_PRIORITY;
  try {
    const r = await fetch(url, { method: 'POST', headers, body: ev.message });
    if (!r.ok) console.warn(`${TAG} ntfy ${url} HTTP ${r.status}`);
  } catch (err) {
    console.warn(`${TAG} ntfy ${url} failed:`, err);
  }
}

async function sendHaWebhook(ev: MowerEvent): Promise<void> {
  if (!HA_WEBHOOK_URL) return;
  try {
    const r = await fetch(HA_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
    });
    if (!r.ok) console.warn(`${TAG} HA webhook HTTP ${r.status}`);
  } catch (err) {
    console.warn(`${TAG} HA webhook failed:`, err);
  }
}

function publishMqttEvent(ev: MowerEvent): void {
  try {
    publishToTopic(`${EVENTS_MQTT_PREFIX}/${ev.sn}`, ev as unknown as Record<string, unknown>);
    publishToTopic(`${EVENTS_MQTT_PREFIX}/${ev.sn}/${ev.type}`, ev as unknown as Record<string, unknown>);
  } catch (err) {
    console.warn(`${TAG} MQTT publish failed:`, err);
  }
}

export function dispatchEvent(ev: MowerEvent): void {
  pushRing(ev);
  publishMqttEvent(ev);
  // ntfy + HA webhook are async fire-and-forget — don't block the
  // sensor pipeline on slow upstream HTTP services.
  void sendNtfy(ev);
  void sendHaWebhook(ev);
  console.log(`${TAG} ${ev.sn} ${ev.type}: ${ev.title}`);
}
