/**
 * Notification dispatcher — fans events out to ntfy.sh, an optional HA
 * webhook, the local MQTT broker (`novabot/events/<SN>`), the connected
 * dashboards over socket.io, and an in-memory ring buffer that the HTTP
 * `GET /api/events/:sn` endpoint serves.
 *
 * Channels are independently configured via env vars and silently skipped
 * when not set, so a fresh install with only an MQTT broker still emits
 * events on the `novabot/events/<SN>` topic for HA's MQTT integration.
 */
import { publishToTopic } from '../mqtt/mapSync.js';
import { sendExpoPush } from './expoPush.js';
import { writeRobotMessage } from './robotMessageWriter.js';
import { MowerEvent } from './types.js';
import { getDeviceLabel } from './deviceLabel.js';

const TAG = '[NOTIFY]';

const NTFY_URL = process.env.NTFY_URL ?? 'https://ntfy.sh';
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? '';
const NTFY_PRIORITY = process.env.NTFY_PRIORITY ?? '';   // 1..5 or '' for default
const HA_WEBHOOK_URL = process.env.HA_WEBHOOK_URL ?? '';
const EVENTS_MQTT_PREFIX = process.env.EVENTS_MQTT_TOPIC_PREFIX ?? 'novabot/events';

/**
 * Socket.io fan-out, injected by initDashboardSocket.
 *
 * Injected rather than imported: dispatcher -> socketHandler -> broker ->
 * demoSimulator -> socketHandler is a cycle, and ESM resolves it as a
 * "Cannot access 'demoModeChecker' before initialization" TDZ error at import
 * time. mapSync/setOutlineEmitter solves the same problem the same way.
 */
type EventEmitterFn = (ev: MowerEvent) => void;
let dashboardEmitter: EventEmitterFn | null = null;

export function setDashboardEventEmitter(fn: EventEmitterFn | null): void {
  dashboardEmitter = fn;
}

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

// HTTP headers are ByteString-only — any UTF-8 codepoint > 255 (em-dashes,
// curly quotes, accented chars in mower SNs) crashes fetch with
// "Cannot convert argument to a ByteString". Strip non-ASCII before
// putting strings into headers; the body stays UTF-8.
function asciiHeader(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, ch => {
    // Common typographic punctuation → safe ASCII counterparts.
    if (ch === '—' || ch === '–') return '-';
    if (ch === '‘' || ch === '’') return "'";
    if (ch === '“' || ch === '”') return '"';
    if (ch === '•') return '*';
    if (ch === ' ') return ' ';
    return '?';
  });
}

async function sendNtfy(ev: MowerEvent): Promise<void> {
  if (!NTFY_TOPIC) return;
  const url = `${NTFY_URL.replace(/\/$/, '')}/${NTFY_TOPIC}`;
  const headers: Record<string, string> = {
    'Title': asciiHeader(`${getDeviceLabel(ev.sn)} - ${ev.title}`),
    'Tags': asciiHeader(`mower,${ev.type}`),
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
  // Dashboards get the same event, live. Without this the only real-time
  // delivery was the Expo push to the mobile app, so a dashboard user never
  // saw "docked" or "mowing finished" at all.
  try {
    dashboardEmitter?.(ev);
  } catch (err) {
    console.warn(`${TAG} dashboard emit failed:`, err);
  }
  // robot_messages write is synchronous (single SQLite insert) —
  // matters because stock-app polls the table immediately on open and
  // we want events visible without waiting for the async HTTP fan-out.
  writeRobotMessage(ev);
  // All HTTP channels run async fire-and-forget — none blocks the
  // sensor pipeline. Expo push is the in-app delivery path for the
  // OpenNova mobile app; ntfy + HA webhook are external relays.
  void sendNtfy(ev);
  void sendHaWebhook(ev);
  void sendExpoPush(ev);
  console.log(`${TAG} ${ev.sn} ${ev.type}: ${ev.title}`);
}
