/**
 * Expo Push channel — fans MowerEvent notifications out to Apple/Google
 * via Expo's free push relay (https://exp.host/--/api/v2/push/send).
 *
 * Tokens are stored per (token, sn) so a single phone bound to two
 * mowers ends up registered twice with the same token — this lets the
 * dispatcher trivially look up "which devices want pushes for sn=X"
 * without joining through users.
 *
 * Failure handling: when Expo reports `DeviceNotRegistered` we wipe the
 * token from every (token, sn) row. Other errors are logged; they
 * don't stop the rest of the channels (ntfy, HA webhook).
 */
import { pushTokensRepo } from '../db/repositories/pushTokens.js';
import { MowerEvent, CATEGORY_BY_TYPE, type EventCategory } from './types.js';
import { getDeviceLabel } from './deviceLabel.js';

const TAG = '[NOTIFY:EXPO]';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default';
  priority?: 'default' | 'normal' | 'high';
  channelId?: string;       // Android notification channel
}

interface ExpoPushReceipt {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

interface ExpoPushResponse {
  data?: ExpoPushReceipt[] | ExpoPushReceipt;
  errors?: Array<{ code: string; message: string }>;
}

function toMessage(token: string, ev: MowerEvent): ExpoPushMessage {
  // Stuck / error events get high priority so iOS doesn't coalesce
  // them with the next mowing_started 5 minutes later.
  const isAlert = ev.type === 'stuck' || ev.type === 'error' || ev.type === 'low_battery';
  // Prefix the title with the friendly device label so households with
  // multiple mowers can tell at a glance which one fired the push.
  const label = getDeviceLabel(ev.sn);
  return {
    to: token,
    title: `${label} - ${ev.title}`,
    body: ev.message || ev.title,
    data: { type: ev.type, sn: ev.sn, ts: ev.ts, ...ev.data },
    sound: 'default',
    priority: isAlert ? 'high' : 'default',
    channelId: 'mower-events',
  };
}

export function isMuted(mutedJson: string | null, category: EventCategory): boolean {
  if (!mutedJson) return false;
  try { return (JSON.parse(mutedJson) as unknown[]).includes(category); } catch { return false; }
}

export async function sendExpoPush(ev: MowerEvent): Promise<void> {
  // Per-installatie gedempte categorieën (app: Settings → Notifications).
  const category = CATEGORY_BY_TYPE[ev.type];
  const tokens = pushTokensRepo.findBySn(ev.sn).filter(t => !isMuted(t.muted, category));
  if (tokens.length === 0) return;

  const messages: ExpoPushMessage[] = tokens.map(t => toMessage(t.token, ev));
  let resp: Response;
  try {
    resp = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    console.warn(`${TAG} fetch failed:`, err);
    return;
  }

  if (!resp.ok) {
    console.warn(`${TAG} HTTP ${resp.status} ${resp.statusText}`);
    return;
  }

  let body: ExpoPushResponse;
  try {
    body = await resp.json() as ExpoPushResponse;
  } catch (err) {
    console.warn(`${TAG} bad JSON response:`, err);
    return;
  }

  if (body.errors?.length) {
    console.warn(`${TAG} Expo errors:`, body.errors);
  }

  const receipts: ExpoPushReceipt[] = Array.isArray(body.data)
    ? body.data
    : body.data ? [body.data] : [];

  // GC stale tokens. Expo returns one receipt per inbound message in
  // the same order, so we can map back via the index.
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const token = messages[i]?.to;
    if (!token) continue;
    if (r.status === 'error') {
      const code = r.details?.error;
      if (code === 'DeviceNotRegistered') {
        console.log(`${TAG} GC stale token for ${ev.sn}: ${token.slice(0, 16)}…`);
        pushTokensRepo.removeToken(token);
      } else {
        console.warn(`${TAG} ${ev.sn} ${code ?? 'unknown'}: ${r.message ?? '(no msg)'}`);
      }
    }
  }
}
