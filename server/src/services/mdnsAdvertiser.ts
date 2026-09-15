/**
 * Server-side mDNS advertiser.
 *
 * Custom-firmware mowers (≥ custom-16) query `opennovabot.local` at boot via
 * `set_server_urls.sh`. Newer firmware also queries `opennova.local`. This
 * service answers both with the host LAN IP so a mower can find the
 * OpenNova server without any DNS configuration. See
 * `docs/superpowers/specs/2026-04-28-zero-touch-mqtt-redirect-design.md`.
 *
 * Lifecycle bound to the Node process: started after `server.listen()`,
 * stopped on shutdown via `stopMdnsAdvertiser()`.
 *
 * Network requirements: the container must be able to send and receive
 * multicast UDP on 224.0.0.251:5353. Bridge networking blocks this by
 * default — the docker-compose.yml documents the prereq.
 */
import os from 'node:os';
import mdns from 'multicast-dns';
import type { Answer } from 'dns-packet';

const TAG = '[MDNS]';

interface AdvertiserOptions {
  ip: string;
  hostnames: string[];
  ttl: number;
  port: number;
  /** HTTP service port advertised via SRV record so the mower can pick the
   *  right port automatically (no more hardcoded :80 fallback). */
  httpPort: number;
  /** mDNS service-instance name for the SRV record. Mower queries this. */
  srvName: string;
}

let socket: ReturnType<typeof mdns> | null = null;
let active: AdvertiserOptions | null = null;
/** Why the advertiser is not running, when it is not. */
let notStartedReason: 'disabled' | 'no_ip' | null = null;
/** Last socket error, kept so the diagnosis can show it instead of only the log. */
let lastError: string | null = null;

// ── Competing-server detection ────────────────────────────────────────────
// A local dev server (`npm run dev`) or a second instance advertising the same
// `opennovabot.local` name silently steals mowers via mDNS, because
// set_server_urls.sh resolves mDNS BEFORE DNS (mqtt.lfibot.com). We do NOT
// change that behaviour, but we make it loud: detect any OTHER host answering
// our hostnames and surface it (server log + dashboard banner).
export interface CompetingServer {
  ip: string;
  hostnames: string[];
  lastSeen: number; // unix-ms
}
const competing = new Map<string, CompetingServer>();
let probeTimer: ReturnType<typeof setInterval> | null = null;

/** Competing servers seen within the last 3×TTL (stale entries pruned). */
export function getCompetingServers(): CompetingServer[] {
  const now = Date.now();
  const ttlMs = (active?.ttl ?? 120) * 1000 * 3;
  return [...competing.values()].filter((c) => now - c.lastSeen <= ttlMs);
}

/**
 * Pick the first non-loopback IPv4 address as a fallback when TARGET_IP is
 * unset. We deliberately do not advertise loopback or link-local addresses.
 */
function detectLanIp(): string | null {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address) {
        return iface.address;
      }
    }
  }
  return null;
}

export function startMdnsAdvertiser(opts?: Partial<AdvertiserOptions>): void {
  if (process.env.ENABLE_MDNS === 'false' || process.env.ENABLE_MDNS === '0') {
    console.log(`${TAG} disabled by ENABLE_MDNS env`);
    notStartedReason = 'disabled';
    return;
  }
  if (socket) {
    console.log(`${TAG} already running, ignoring start`);
    return;
  }

  const ip = opts?.ip ?? process.env.TARGET_IP ?? detectLanIp();
  if (!ip) {
    console.warn(`${TAG} no LAN IP detected and TARGET_IP unset — advertiser not started`);
    notStartedReason = 'no_ip';
    return;
  }
  notStartedReason = null;
  lastError = null;

  const hostnames =
    opts?.hostnames ??
    (process.env.MDNS_HOSTNAMES ?? 'opennova.local,opennovabot.local')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const ttl = opts?.ttl ?? parseInt(process.env.MDNS_TTL ?? '120', 10);
  const port = opts?.port ?? parseInt(process.env.MDNS_PORT ?? '5353', 10);
  const httpPort = opts?.httpPort ?? parseInt(process.env.HTTP_PORT ?? process.env.PORT ?? '8080', 10);
  // Conventional mDNS service-instance form: <instance>.<service>.<proto>.local
  // We pick `_opennova-http._tcp.local` so it cannot collide with anything
  // upstream. The mower queries this name for the SRV record.
  const srvName = opts?.srvName ?? process.env.MDNS_SRV_NAME ?? '_opennova-http._tcp.local';

  active = { ip, hostnames, ttl, port, httpPort, srvName };
  socket = mdns({ port });

  // A dgram 'error' (e.g. the competing-server probe failing to send multicast
  // in a container / restricted test env) must NOT go unhandled — Node would
  // throw and break the whole advertiser (so it stops answering queries). Log
  // and keep running.
  socket.on('error', (err: Error) => {
    lastError = err.message;
    console.warn(`${TAG} socket error: ${err.message}`);
  });

  socket.on('query', (query, rinfo) => {
    const answers: Answer[] = [];
    for (const q of query.questions ?? []) {
      // RFC 6762 §6: type 'ANY' (255) means "all records".
      // @types/multicast-dns narrows RecordType — cast for ANY/wildcard match
      const wantsAny = (q.type as string) === 'ANY';
      if ((q.type === 'A' || wantsAny) && active!.hostnames.includes(q.name)) {
        answers.push({ name: q.name, type: 'A', ttl: active!.ttl, data: active!.ip });
      }
      // SRV record carries the service port so the mower no longer has to
      // hardcode FALLBACK_HTTP_PORT="80" in set_server_urls.sh. The target
      // points at our primary hostname (first entry in `hostnames`).
      if ((q.type === 'SRV' || wantsAny) && q.name === active!.srvName) {
        const target = active!.hostnames[0] ?? 'opennova.local';
        answers.push({
          name: q.name,
          type: 'SRV',
          ttl: active!.ttl,
          data: { port: active!.httpPort, target, priority: 0, weight: 0 },
        });
        // Bundle the A record in the same response so the resolver doesn't
        // need a second round-trip.
        answers.push({ name: target, type: 'A', ttl: active!.ttl, data: active!.ip });
      }
    }
    if (answers.length > 0) {
      // RFC 6762 §6.7: legacy unicast queries (source port != 5353) get a
      // unicast reply to the source rinfo. This also handles tests where the
      // client uses an ephemeral port and is not joined to the multicast group.
      const isLegacyUnicast = rinfo && rinfo.port !== 5353;
      if (isLegacyUnicast) {
        socket!.respond({ answers }, { address: rinfo.address, port: rinfo.port });
      } else {
        socket!.respond({ answers });
      }
    }
  });

  // Watch for OTHER hosts answering our hostnames → competing server.
  socket.on('response', (response, rinfo) => {
    if (!active) return;
    for (const ans of response.answers ?? []) {
      if (ans.type !== 'A') continue;
      if (!active.hostnames.includes(ans.name)) continue;
      const ip = String(ans.data);
      if (!ip || ip === active.ip) continue; // ignore our own answers
      const now = Date.now();
      const existing = competing.get(ip);
      if (existing) {
        existing.lastSeen = now;
        if (!existing.hostnames.includes(ans.name)) existing.hostnames.push(ans.name);
      } else {
        competing.set(ip, { ip, hostnames: [ans.name], lastSeen: now });
        console.warn(
          `${TAG} ⚠️  Another OpenNova server is advertising ${ans.name} at ${ip}. ` +
          `Mowers on this LAN may connect there (or here: ${active.ip}) — whichever wins via mDNS. ` +
          `If ${ip} is a dev box, the mowers can silently switch servers. ` +
          `(set ENABLE_MDNS=false to stop advertising from this instance)`,
        );
      }
      void rinfo;
    }
  });

  // Actively probe our own hostnames so a competitor is noticed even AFTER a
  // hijack has already completed (a stolen mower stops querying once it has
  // connected to the rogue server, so passive listening alone could miss it).
  // A send failure in a restricted/container env surfaces on the socket
  // 'error' handler above rather than crashing the advertiser.
  const probe = () => {
    try {
      socket?.query({ questions: active!.hostnames.map((name) => ({ name, type: 'A' as const })) });
    } catch { /* socket closing */ }
  };
  probe();
  probeTimer = setInterval(probe, 45000);
  if (typeof probeTimer.unref === 'function') probeTimer.unref();

  console.log(`${TAG} advertising ${hostnames.join(', ')} → ${ip} (ttl=${ttl}s, mdns-port=${port}, http-port=${httpPort}, srv=${srvName})`);
}

export function stopMdnsAdvertiser(): void {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
  competing.clear();
  if (!socket) return;
  socket.destroy();
  socket = null;
  active = null;
  console.log(`${TAG} stopped`);
}

export function getActiveAdvertisement(): AdvertiserOptions | null {
  return active;
}

export interface MdnsStatus {
  running: boolean;
  notStartedReason: 'disabled' | 'no_ip' | null;
  lastError: string | null;
  ip: string | null;
  hostname: string | null;
  port: number | null;
}

export function mdnsStatus(): MdnsStatus {
  return {
    running: socket !== null,
    notStartedReason,
    lastError,
    ip: active?.ip ?? null,
    hostname: active?.hostnames[0] ?? null,
    port: active?.port ?? null,
  };
}

/**
 * Ask the network who answers for our own hostname, and wait for it.
 *
 * The advertiser probes itself every 45 s but throws its own answers away by
 * design, so nothing ever confirmed that the question and the answer make it
 * across 224.0.0.251:5353 at all. This is that confirmation, one shot: the
 * addresses that answered, ours among them if it works, someone else's if a
 * second server is on the network, nobody's if multicast is not going anywhere.
 *
 * It proves the path to ourselves, not to the mowers; that half is measured
 * on the mower over SSH. Together they separate "the server is silent" from
 * "the server speaks but the network does not carry it".
 */
export function selfQuery(timeoutMs = 1200): Promise<string[]> {
  return new Promise(resolve => {
    if (!socket || !active) return resolve([]);
    const name = active.hostnames[0];
    const seen = new Set<string>();
    const onResponse = (response: { answers?: Answer[] }) => {
      for (const ans of response.answers ?? []) {
        if (ans.type === 'A' && ans.name === name) seen.add(String(ans.data));
      }
    };
    socket.on('response', onResponse);
    const done = () => {
      socket?.removeListener('response', onResponse);
      resolve([...seen]);
    };
    const t = setTimeout(done, timeoutMs);
    if (typeof t.unref === 'function') t.unref();
    try {
      socket.query({ questions: [{ name, type: 'A' }] });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      clearTimeout(t);
      done();
    }
  });
}
