/**
 * Mower LAN-IP discovery via mDNS (`novabot.local`) + camera-port verify.
 *
 * Why this exists:
 *   The mower's MQTT connection often arrives via a public proxy (NPM /
 *   Cloudflare), so `device_registry.ip_address` is a CDN edge IP that is
 *   useless for direct HTTP reach (camera stream, push-to-mower SSH-style
 *   sync, etc.). The user can set `equipment.mower_ip` manually but that's
 *   brittle: it gets stale on DHCP renewals and is gone after a factory
 *   reset. This service keeps a fresh per-mower LAN IP in
 *   `equipment.discovered_ip` so the UI works without manual setup.
 *
 * Strategy:
 *   1. Try Node's built-in `dns.lookup('novabot.local')`. On Docker Desktop
 *      for Mac the resolver proxies through the host's mDNSResponder, so
 *      this is fast (<10ms) and free. On Linux containers without
 *      libnss-mdns it returns ENOTFOUND.
 *   2. Fall back to a `multicast-dns` PTR/A query (pure JS, works in bridge
 *      networking when multicast egress isn't blocked).
 *   3. Verify by HEAD-probing `http://<ip>:8000/snapshot` (2s timeout).
 *      If the camera service answers we adopt the IP; otherwise we ignore
 *      it (some other host might also expose `novabot.local`).
 *
 * Multi-mower note: today every mower advertises the same `novabot.local`,
 * so this only works for single-mower installs. When we ever need to
 * disambiguate we'll add per-SN hostname (`<sn>.local`) or expose the SN
 * on the camera service's `/info` endpoint.
 */
import dns from 'node:dns';
import http from 'node:http';
import mdns from 'multicast-dns';
import { equipmentRepo } from '../db/repositories/index.js';

const TAG = '[IP-DISCOVERY]';

/**
 * Legacy mDNS hostname every mower advertised before per-SN hostname support
 * shipped. Kept as a fallback so a single mower with old firmware still works.
 */
const LEGACY_HOST = 'novabot.local';

/**
 * Per-SN hostname pattern. New firmware (set_server_urls.sh post-2026-04-18)
 * sets `host-name=<lowercase-sn>` in `/etc/avahi/avahi-daemon.conf` so each
 * mower advertises a unique `<sn>.local` name. This is what makes the
 * discovery loop multi-mower-safe.
 */
function snHost(sn: string): string {
  return `${sn.toLowerCase()}.local`;
}

/** Camera-service port — used for verification only. */
const CAMERA_PORT = 8000;

/** Refresh cycle for the periodic discovery loop. */
const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;

/** A discovered IP older than this is considered stale and re-resolved. */
export const DISCOVERED_FRESHNESS_MS = 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
/** Per-mower mutex so on-demand triggers don't pile up. */
const inflight = new Map<string, Promise<string | null>>();
/** Throttle: at most 1 discover call per (mower, 60s) regardless of caller. */
const lastAttemptAt = new Map<string, number>();
const MIN_RETRY_MS = 60 * 1000;

function isPrivateIp(addr: string): boolean {
  return /^10\./.test(addr)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(addr)
    || /^192\.168\./.test(addr);
}

/** True iff `discovered_ip_at` is recent enough that we trust the cached IP. */
export function isDiscoveredIpFresh(at: string | null): boolean {
  if (!at) return false;
  const ts = Date.parse(at + 'Z');
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts < DISCOVERED_FRESHNESS_MS;
}

/** Promise wrapper around dns.lookup with a timeout. */
function dnsLookupTimeout(host: string, ms: number): Promise<string | null> {
  return new Promise(resolve => {
    let done = false;
    const timeout = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    dns.lookup(host, { family: 4 }, (err, address) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (err || !address) { resolve(null); return; }
      resolve(address);
    });
  });
}

/** mDNS A-record query via multicast-dns lib. Returns first IPv4 hit. */
function multicastDnsLookup(host: string, ms: number): Promise<string | null> {
  return new Promise(resolve => {
    let socket: ReturnType<typeof mdns> | null = null;
    let done = false;
    const finish = (ip: string | null) => {
      if (done) return;
      done = true;
      try { socket?.destroy(); } catch { /* swallow */ }
      resolve(ip);
    };
    const timeout = setTimeout(() => finish(null), ms);
    try {
      socket = mdns();
      socket.on('response', response => {
        for (const a of response.answers ?? []) {
          if (a.type === 'A' && (a.name === host || a.name === host + '.')) {
            clearTimeout(timeout);
            finish(typeof a.data === 'string' ? a.data : null);
            return;
          }
        }
      });
      socket.query([{ name: host, type: 'A' }]);
    } catch (err) {
      console.warn(`${TAG} multicast-dns init failed:`, err instanceof Error ? err.message : err);
      clearTimeout(timeout);
      finish(null);
    }
  });
}

/** Probe the camera service to confirm this IP belongs to a novabot.
 *
 * Uses HEAD with a best-effort fallback: the camera service at :8000 is a
 * minimal Python HTTP handler that returns 501 on HEAD (method not supported)
 * but serves 200 on GET. We treat ANY HTTP status as "service is alive" —
 * a 501 response proves the host exists and speaks HTTP, which is all we
 * need for IP verification. Connect errors / timeouts still fail the check.
 */
function verifyCameraReachable(ip: string, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.request({
      method: 'HEAD',
      host: ip,
      port: CAMERA_PORT,
      path: '/snapshot',
      timeout: ms,
    }, res => {
      res.resume();
      // Any HTTP response (incl. 501 "HEAD not implemented") means a live
      // service answered — the host exists and speaks HTTP on port 8000.
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Resolve a single mDNS hostname (with multicast-dns fallback) and verify
 * it points to a mower by probing `:8000/snapshot`. Returns null when the
 * name doesn't resolve, points to a public IP, or the camera service
 * doesn't answer.
 */
export async function resolveHost(host: string): Promise<string | null> {
  let ip = await dnsLookupTimeout(host, 1500);
  if (!ip) ip = await multicastDnsLookup(host, 2000);
  if (!ip) return null;
  if (!isPrivateIp(ip)) return null;  // never adopt a public IP
  const reachable = await verifyCameraReachable(ip, 2000);
  return reachable ? ip : null;
}

/**
 * Resolve a specific mower's LAN IP. Tries the per-SN hostname first
 * (`<sn>.local` — set by post-2026-04-18 firmware via avahi-daemon.conf)
 * and falls back to the legacy `novabot.local` for old firmware. The
 * fallback is single-mower safe by construction; in a multi-mower setup
 * it may pick the wrong mower if any of them is still on old firmware,
 * which is why we always verify by probing `:8000`.
 */
export async function resolveMowerHost(sn: string): Promise<string | null> {
  const perSn = await resolveHost(snHost(sn));
  if (perSn) return perSn;
  return resolveHost(LEGACY_HOST);
}

/**
 * Resolve + persist for one mower. Coalesces concurrent callers so a
 * thundering herd (e.g. multiple camera/info fetches) only hits the
 * network once.
 */
export function discoverIpForMower(mowerSn: string): Promise<string | null> {
  const last = lastAttemptAt.get(mowerSn) ?? 0;
  if (Date.now() - last < MIN_RETRY_MS) {
    return Promise.resolve(equipmentRepo.findResolvedMowerIp(mowerSn)?.discovered_ip ?? null);
  }
  const existing = inflight.get(mowerSn);
  if (existing) return existing;

  const promise = (async () => {
    lastAttemptAt.set(mowerSn, Date.now());
    const ip = await resolveMowerHost(mowerSn);
    if (ip) {
      equipmentRepo.setDiscoveredIp(mowerSn, ip);
      console.log(`${TAG} ${mowerSn} → ${ip}`);
    } else {
      console.log(`${TAG} ${mowerSn}: no LAN IP found (tried ${snHost(mowerSn)} + ${LEGACY_HOST})`);
    }
    return ip;
  })().finally(() => inflight.delete(mowerSn));

  inflight.set(mowerSn, promise);
  return promise;
}

/** One full pass over every bound mower. Errors are logged, not thrown. */
async function runDiscoveryCycle(): Promise<void> {
  const mowers = equipmentRepo.listDiscoverable();
  if (mowers.length === 0) return;
  for (const m of mowers) {
    if (m.mower_ip) continue;  // user pinned one; respect it
    if (isDiscoveredIpFresh(m.discovered_ip_at) && m.discovered_ip) continue;
    try {
      await discoverIpForMower(m.mower_sn);
    } catch (err) {
      console.warn(`${TAG} ${m.mower_sn}:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Boot the periodic discovery loop. Idempotent. */
export function startMowerIpDiscovery(): void {
  if (timer) return;
  // Kick off immediately so cold-boot users don't wait 5 minutes for the camera.
  void runDiscoveryCycle();
  timer = setInterval(() => { void runDiscoveryCycle(); }, DISCOVERY_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`${TAG} discovery loop started (${DISCOVERY_INTERVAL_MS / 1000}s)`);
}

/** Stop the loop — used in tests. */
export function stopMowerIpDiscovery(): void {
  if (timer) { clearInterval(timer); timer = null; }
  inflight.clear();
  lastAttemptAt.clear();
}

/**
 * Pick the best known IP for `sn` right now, optionally kicking off a
 * background discovery if nothing usable is on file. Priority:
 *
 *   1. `equipment.mower_ip` (user-pinned manual override — always wins)
 *   2. `equipment.discovered_ip` if its `discovered_ip_at` is fresh
 *   3. `device_registry.ip_address` if it's a private IP
 *
 * If nothing matches and `triggerIfMissing` is true (default), a
 * fire-and-forget `discoverIpForMower(sn)` is started — the next request
 * a few seconds later will see the freshly discovered IP. This keeps the
 * camera/info endpoint snappy: it still 404s on first call after a cold
 * boot, but subsequent calls succeed without manual intervention.
 *
 * If `awaitDiscovery` is true, we await the discovery result before
 * returning (used by clients that prefer a small extra latency over a
 * 404 — e.g. the camera/info endpoint when the user just opened the tab).
 */
export async function resolveMowerIp(
  sn: string,
  opts: { triggerIfMissing?: boolean; awaitDiscovery?: boolean } = {},
): Promise<string | null> {
  const row = equipmentRepo.findResolvedMowerIp(sn);
  if (row?.mower_ip) return row.mower_ip;
  if (row?.discovered_ip && isDiscoveredIpFresh(row.discovered_ip_at)) {
    return row.discovered_ip;
  }
  if (row?.detected_ip && isPrivateIp(row.detected_ip)) return row.detected_ip;

  if (opts.triggerIfMissing === false) return null;
  const discovery = discoverIpForMower(sn);
  if (opts.awaitDiscovery) {
    const ip = await discovery;
    return ip;
  }
  return null;
}
