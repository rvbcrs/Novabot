/**
 * Find LFI devices on the local network by their MAC prefix.
 *
 * A device that has never reached the broker has no known address, so every
 * other check is blind to it. But the hardware announces itself at layer 2: the
 * first three bytes of the MAC identify the vendor, and the factory table that
 * ships with every install has 5851 of them to derive that set from. So even a
 * device that has never spoken MQTT is findable, and we can say "your mower is
 * at 192.168.1.42, it is on the network, it just is not talking to us".
 *
 * The prefixes are derived from device_factory rather than hardcoded, so they
 * grow with the data instead of going stale.
 */
import { execFile } from 'child_process';
import dgram from 'dgram';
import net from 'net';
import http from 'http';
import { db } from '../db/database.js';
import { serverIpv4, lanIpv4 } from './reachability.js';
import { translator, type Translate } from './serverText.js';

const MAC_RE = /([0-9a-f]{1,2}:){5}[0-9a-f]{1,2}/i;
const NEIGH_LINE = /^\s*\(?([\d.]+)\)?\s.*?(([0-9a-f]{1,2}:){5}[0-9a-f]{1,2})/i;

/** How long to let the neighbour table fill after poking the subnet. */
const ARP_SETTLE_MS = 600;
const CMD_TIMEOUT_MS = 3000;

export interface FoundDevice {
  ip: string;
  mac: string;
  /** What the prefix says this is, when the factory table knows. */
  kind: 'mower' | 'charger' | 'unknown';
  /** Serial from the factory table when this exact MAC is in it. */
  sn: string | null;
}

export interface LanScanResult {
  /** False when we cannot see the home network at all, e.g. behind a bridge. */
  canSeeLan: boolean;
  /** Why not, when canSeeLan is false. */
  reason: string | null;
  subnet: string | null;
  found: FoundDevice[];
  /** Every neighbour we saw, LFI or not. Zero means we are blind, not empty. */
  neighbourCount: number;
  /** How many vendor prefixes we could identify devices by. Zero means we cannot. */
  knownOuis: number;
}

/** MAC prefix -> device type, straight out of the shipped factory table. */
export function factoryOuis(): Map<string, 'mower' | 'charger'> {
  const out = new Map<string, 'mower' | 'charger'>();
  try {
    const rows = db.prepare(`
      SELECT UPPER(SUBSTR(REPLACE(mac_address,'-',':'), 1, 8)) AS oui,
             device_type, COUNT(*) AS n
      FROM device_factory
      WHERE mac_address IS NOT NULL AND LENGTH(mac_address) >= 8
        AND device_type IN ('mower','charger')
      GROUP BY oui, device_type
      HAVING n >= 10
    `).all() as Array<{ oui: string; device_type: 'mower' | 'charger' }>;
    for (const r of rows) out.set(r.oui, r.device_type);
  } catch { /* no factory table: the scan simply finds nothing */ }
  return out;
}

function normalize(mac: string): string {
  return mac.split(':').map(p => p.padStart(2, '0')).join(':').toUpperCase();
}

/** Poke every host in the /24 so the kernel resolves their MACs. */
function warmArp(subnet: string): Promise<void> {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    sock.bind(() => {
      sock.setBroadcast(true);
      const buf = Buffer.from([0]);
      for (let i = 1; i < 255; i++) {
        // Port 9 is discard. Nothing has to answer; the ARP request that
        // precedes the datagram is the whole point.
        sock.send(buf, 9, `${subnet}.${i}`, () => {});
      }
      setTimeout(() => {
        sock.close();
        resolve();
      }, ARP_SETTLE_MS);
    });
  });
}

function readNeighbours(): Promise<Array<{ ip: string; mac: string }>> {
  const parse = (out: string) => {
    const rows: Array<{ ip: string; mac: string }> = [];
    for (const line of out.split('\n')) {
      const m = NEIGH_LINE.exec(line);
      if (m && MAC_RE.test(m[2])) rows.push({ ip: m[1], mac: normalize(m[2]) });
    }
    return rows;
  };
  return new Promise(resolve => {
    execFile('ip', ['neigh'], { timeout: CMD_TIMEOUT_MS }, (err, stdout) => {
      if (!err && stdout.trim()) return resolve(parse(stdout));
      execFile('arp', ['-a'], { timeout: CMD_TIMEOUT_MS }, (err2, out2) => {
        resolve(err2 || !out2 ? [] : parse(out2));
      });
    });
  });
}

/**
 * The real MAC behind one address, straight from the neighbour table.
 *
 * Looked up, never computed. The WiFi-to-BLE offset differs per hardware: an
 * ESP32 charger is +2, and LFIN2230700238 measures +1 (wifi 50:41:1C:39:BD:C0
 * against BLE ...C1). Deriving one from the other would print a plausible,
 * wrong address.
 */
export async function lookupMac(ip: string): Promise<string | null> {
  const clean = ip.replace(/^::ffff:/, '');
  const hit = (await readNeighbours()).find(n => n.ip === clean);
  return hit?.mac ?? null;
}

/**
 * Other hosts on the LAN that answer on the MQTT port.
 *
 * Two brokers on one network is a real failure and a confusing one: mowers
 * discover the wrong one over mDNS, flap between the two and look intermittently
 * offline. It happened on this very network on 2026-09-14, when a release left
 * a second container listening on 1883.
 *
 * Reads the neighbour table as it stands, without the sweep, so this is cheap.
 * Inside a bridged container that table holds only the docker gateway, so when
 * it yields nothing the subnet is walked directly: outbound TCP to the LAN
 * works fine through NAT, it is only the layer-2 view that is missing. Without
 * that fallback this check reported "no second broker" from a position where it
 * could not have seen one, which is worse than saying nothing. Measured on
 * 2026-09-15: a second broker on 192.168.0.233 was reachable from the mower and
 * invisible here.
 */
export interface RivalBrokers {
  /** False when we had nothing to probe, so "none found" would be a lie. */
  looked: boolean;
  /** Why we could not look. A code, not prose: the diagnosis writes the
   *  sentence, in the language the reader asked for. */
  reason: 'no_lan_address' | null;
  ips: string[];
}

let rivalCache: { at: number; result: RivalBrokers } | null = null;
/** Een tweede broker verschijnt niet van seconde tot seconde. */
const RIVAL_CACHE_MS = 60_000;

/**
 * Alles wat niet op het thuisnetwerk zit telt niet mee als tweede broker.
 *
 * De Docker-gateway (172.17.0.1) is de host zelf, gezien vanuit de container, en
 * die stuurt poort 1883 gewoon naar ons terug. Die als tweede broker melden
 * vertelt iemand zijn eigen server uit te zetten. Live gezien op 14-09-2026.
 */
function onHomeLan(ip: string, lanSubnet: string | null): boolean {
  if (looksLikeContainerBridge(ip)) return false;
  return lanSubnet ? ip.startsWith(lanSubnet + '.') : true;
}

export async function rivalBrokers(ourIps: string[], port = 1883, max = 254): Promise<RivalBrokers> {
  // Zonder cache peilt elke diagnose opnieuw het hele subnet. Dat is te zwaar
  // voor een endpoint dat herhaald wordt aangeroepen, en het liet de testsuite
  // van 70 naar 225 seconden lopen tot hij omviel.
  if (rivalCache && Date.now() - rivalCache.at < RIVAL_CACHE_MS) return rivalCache.result;

  // lanIpv4 valt binnen een container terug op het adres dat we adverteren, en
  // dat is precies het adres waar de maaiers op afgaan. serverIpv4 geeft daar
  // alleen 172.17.0.x, en daarmee viel er niets te vergelijken.
  const ours = [...new Set([...ourIps, ...lanIpv4()])];
  const lanIp = ours.find(ip => !looksLikeContainerBridge(ip)) ?? null;
  const lanSubnet = lanIp ? lanIp.split('.').slice(0, 3).join('.') : null;

  const neighbours = (await readNeighbours())
    .map(n => n.ip)
    .filter(ip => !ours.includes(ip) && onHomeLan(ip, lanSubnet));

  let candidates = neighbours;
  if (candidates.length === 0) {
    if (!lanSubnet) {
      const result: RivalBrokers = { looked: false, reason: 'no_lan_address', ips: [] };
      rivalCache = { at: Date.now(), result };
      return result;
    }
    // Buurtabel leeg: zelf het subnet aflopen in plaats van "niets gevonden"
    // melden vanaf een plek waar niets te zien valt.
    candidates = Array.from({ length: 254 }, (_, i) => `${lanSubnet}.${i + 1}`)
      .filter(ip => !ours.includes(ip));
  }

  const hits = await Promise.all(candidates.slice(0, max).map(async ip => {
    const open = await new Promise<boolean>(resolve => {
      const sock = new net.Socket();
      let done = false;
      const finish = (ok: boolean) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
      sock.setTimeout(600);
      sock.once('connect', () => finish(true));
      sock.once('timeout', () => finish(false));
      sock.once('error', () => finish(false));
      sock.connect(port, ip);
    });
    return open ? ip : null;
  }));

  const result = { looked: true, reason: null, ips: hits.filter((x): x is string => x !== null) };
  rivalCache = { at: Date.now(), result };
  return result;
}

/**
 * WiFi STA MAC uit de BLE MAC, per hardware.
 *
 * De afstand is niet overal gelijk, dus hij wordt per type gerekend en niet
 * geraden. Chargers zijn ESP32: WiFi STA + 2 = BLE (broker.ts wifiStaToBle).
 * Maaiers zitten op +1, gemeten op twee toestellen met verschillende
 * fabrikantprefixen: LFIN2230700238 wifi 50:41:1C:39:BD:C0 tegen BLE ...C1, en
 * LFIN1231000211 wifi 70:4A:0E:4A:99:CE tegen BLE ...CF.
 *
 * Een echte ARP-opzoeking gaat hier altijd voor; dit is de terugval wanneer de
 * container het thuisnetwerk niet op laag 2 kan zien.
 */
export function bleToWifiMac(bleMac: string, kind: 'mower' | 'charger'): string | null {
  const bytes = bleMac.split(':').map(b => parseInt(b, 16));
  if (bytes.length !== 6 || bytes.some(b => !Number.isFinite(b))) return null;
  bytes[5] -= kind === 'charger' ? 2 : 1;
  for (let i = 5; i > 0 && bytes[i] < 0; i--) {
    bytes[i] += 256;
    bytes[i - 1] -= 1;
  }
  if (bytes[0] < 0) return null;
  return bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
}

/** True for the ranges Docker hands out to bridged containers. */
function looksLikeContainerBridge(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 172 && b >= 16 && b <= 31;
}

/** `reason` is a phrase in the reader's language (T); the diagnosis embeds it. */
export async function scanLan(T: Translate = translator('en')): Promise<LanScanResult> {
  const ips = serverIpv4();
  const lan = ips.find(ip => !looksLikeContainerBridge(ip)) ?? ips[0] ?? null;
  if (!lan) {
    return {
      canSeeLan: false, reason: T`geen netwerkadres op deze server`,
      subnet: null, found: [], neighbourCount: 0, knownOuis: 0,
    };
  }

  // Zonder fabriekstabel kennen we geen enkel MAC-prefix, en dan vindt de scan
  // per definitie niets. Dat als "geen apparaten gevonden" melden zou iemand op
  // pad sturen om stroom en wifi te controleren die allebei in orde zijn.
  const ouis = factoryOuis();
  if (ouis.size === 0) {
    return {
      canSeeLan: false,
      reason: T`de fabriekstabel met MAC-prefixen is leeg, dus apparaten zijn niet te herkennen`,
      subnet: lan.split('.').slice(0, 3).join('.'),
      found: [], neighbourCount: 0, knownOuis: 0,
    };
  }
  const subnet = lan.split('.').slice(0, 3).join('.');

  await warmArp(subnet);
  const neighbours = (await readNeighbours()).filter(n => n.ip.startsWith(subnet + '.'));

  if (neighbours.length === 0) {
    return {
      canSeeLan: false,
      reason: looksLikeContainerBridge(lan)
        ? T`deze container zit achter een Docker-bridge en kan het thuisnetwerk niet inzien`
        : T`geen enkel apparaat zichtbaar op het lokale netwerk`,
      subnet,
      found: [],
      neighbourCount: 0,
      knownOuis: ouis.size,
    };
  }

  const byMac = db.prepare(
    "SELECT sn FROM device_factory WHERE UPPER(REPLACE(mac_address,'-',':')) = ? LIMIT 1",
  );
  const found: FoundDevice[] = [];
  for (const n of neighbours) {
    const kind = ouis.get(n.mac.slice(0, 8));
    if (!kind) continue;
    let sn: string | null = null;
    try {
      sn = (byMac.get(n.mac) as { sn?: string } | undefined)?.sn ?? null;
    } catch { /* ignore */ }
    found.push({ ip: n.ip, mac: n.mac, kind, sn });
  }
  return { canSeeLan: true, reason: null, subnet, found,
    neighbourCount: neighbours.length, knownOuis: ouis.size };
}

/**
 * Is this broker an OpenNova server, or just something that speaks MQTT?
 *
 * A Mosquitto for Home Assistant on the same LAN is not a rival: a mower only
 * ends up there if it is pointed there. A second OpenNova server is, because
 * it advertises opennova.local and answers as mqtt.lfibot.com. The two are told
 * apart the way a person would: ask it who it is. Every OpenNova server has
 * answered GET /api/dashboard/version on its HTTP port since 2026-06-15,
 * unauthenticated from the LAN, so this also recognises old servers, such as
 * the stray container that hijacked the mowers on 2026-09-14. Port 80 is the
 * compose default, 8080 the other mapping in use.
 */
export interface BrokerIdentity {
  ip: string;
  opennova: boolean;
  version: string | null;
}

export async function identifyBroker(ip: string, timeoutMs = 1500): Promise<BrokerIdentity> {
  const ask = (port: number) => new Promise<string | null>(resolve => {
    const req = http.get({ host: ip, port, path: '/api/dashboard/version', timeout: timeoutMs }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { if (body.length < 4096) body += c; });
      res.on('end', () => {
        try {
          const v = JSON.parse(body)?.version;
          resolve(typeof v === 'string' && v ? v : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
  const versions = await Promise.all([80, 8080].map(ask));
  const version = versions.find(v => v !== null) ?? null;
  return { ip, opennova: version !== null, version };
}
