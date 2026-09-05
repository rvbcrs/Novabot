/**
 * Deferred map sync after BLE mapping.
 *
 * After a mapping session the mower uploads its map ZIP to the server by
 * itself, triggered by `get_map_outline {map_name:"all"}` — but only once, and
 * only if it has WiFi at that moment. When you map far from the house it
 * usually doesn't, and the server deliberately sends no proactive commands on
 * reconnect (broker.ts: cloud-identical, crash loops on some mowers), so the
 * upload never happens and the new map stays invisible to the dashboard/app.
 *
 * Mirrors the official app: the PHONE remembers "map <sn> still needs syncing"
 * and re-sends `get_map_outline all` through the server the next time it can
 * reach it (HomeScreen focus). The flag is cleared only when the server
 * accepted the command (mower online); otherwise it stays and we retry later.
 *
 * Dependencies are injected so the core is unit-testable without Expo.
 */

export interface PendingStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

/** Sends `get_map_outline all` to the mower via the server; true when accepted. */
export type OutlineSender = (sn: string) => Promise<boolean>;

const keyFor = (sn: string) => `pendingMapSync.${sn}`;

export async function markPendingMapSync(sn: string, store: PendingStore = secureStore()): Promise<void> {
  try { await store.set(keyFor(sn), String(Date.now())); } catch { /* best effort */ }
}

export async function hasPendingMapSync(sn: string, store: PendingStore = secureStore()): Promise<boolean> {
  try { return (await store.get(keyFor(sn))) != null; } catch { return false; }
}

/**
 * Try to complete a pending sync. Returns:
 *  - 'nothing'  no sync pending
 *  - 'synced'   command accepted by the server, flag cleared
 *  - 'failed'   server/mower not reachable — flag kept for a later retry
 */
export async function flushPendingMapSync(
  sn: string,
  send: OutlineSender = serverOutlineSender,
  store: PendingStore = secureStore(),
): Promise<'nothing' | 'synced' | 'failed'> {
  if (!(await hasPendingMapSync(sn, store))) return 'nothing';
  let ok = false;
  try { ok = await send(sn); } catch { ok = false; }
  if (!ok) return 'failed';
  try { await store.del(keyFor(sn)); } catch { /* ignore */ }
  return 'synced';
}

// ── Default wiring (lazy imports so tests never touch Expo) ──────────────────

function secureStore(): PendingStore {
  return {
    async get(k) { const S = await import('expo-secure-store'); return S.getItemAsync(k); },
    async set(k, v) { const S = await import('expo-secure-store'); await S.setItemAsync(k, v); },
    async del(k) { const S = await import('expo-secure-store'); await S.deleteItemAsync(k); },
  };
}

async function serverOutlineSender(sn: string): Promise<boolean> {
  const { getServerUrl } = await import('./auth');
  const { ApiClient } = await import('./api');
  const url = await getServerUrl();
  if (!url) return false;
  const api = new ApiClient(url);
  // The command route answers 404 "Device is offline" when the mower isn't
  // connected; treat anything but an explicit ok as "try again later".
  const res = await api.sendCommand(sn, { get_map_outline: { map_name: 'all', cmd_num: Date.now() % 100000 } });
  return (res as { ok?: boolean } | null)?.ok === true;
}
