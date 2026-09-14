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
import { db } from '../db/database.js';
import { serverIpv4 } from './reachability.js';

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

/** True for the ranges Docker hands out to bridged containers. */
function looksLikeContainerBridge(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 172 && b >= 16 && b <= 31;
}

export async function scanLan(): Promise<LanScanResult> {
  const ips = serverIpv4();
  const lan = ips.find(ip => !looksLikeContainerBridge(ip)) ?? ips[0] ?? null;
  if (!lan) {
    return {
      canSeeLan: false, reason: 'geen netwerkadres op deze server',
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
      reason: 'de fabriekstabel met MAC-prefixen is leeg, dus apparaten zijn niet te herkennen',
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
        ? 'deze container zit achter een Docker-bridge en kan het thuisnetwerk niet inzien'
        : 'geen enkel apparaat zichtbaar op het lokale netwerk',
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
