/**
 * Can the device reach this server at all?
 *
 * The rest of the diagnosis starts at "did it ever get here", which is blind to
 * the most basic failure: it never arrives, so we see nothing and have nothing
 * to report. These are the facts we can establish from our own side without
 * guessing.
 *
 * Everything here is a measurement. Nothing concludes that DNS "is probably
 * wrong": either the name resolves to one of our addresses or it does not, and
 * the answer is printed either way.
 */
import dns from 'dns';
import net from 'net';
import os from 'os';
import { getActiveAdvertisement } from './mdnsAdvertiser.js';

/** Hard cap per probe. The diagnosis must answer quickly or nobody uses it. */
const PROBE_TIMEOUT_MS = 800;

/** Hosts the devices are pointed at. The firmware resolves these, not us. */
export const DEVICE_HOSTNAMES = ['mqtt.lfibot.com', 'app.lfibot.com'];

/** Ports our own custom firmware opens, used to prove a device is on the network. */
export const DEVICE_PROBE_PORTS = [22, 8000];

export interface DnsResult {
  host: string;
  addresses: string[];
  error: string | null;
  /**
   * True when an answer is an address of this server, false when it is not,
   * null when we cannot tell: inside a bridged container our only address is a
   * docker-internal one, and comparing a LAN answer against that says nothing.
   */
  pointsHere: boolean | null;
}

export interface Reachability {
  /** Our own IPv4 addresses, excluding loopback and docker bridges. */
  serverIps: string[];
  dns: DnsResult[];
  /** Null when no address is known for the device. */
  deviceIp: string | null;
  /** True only when a probe actually answered. Not answering proves nothing. */
  deviceAnswered: boolean;
  /** Whether the device's last known address shares a /24 with one of ours. */
  sameSubnet: boolean | null;
}

/** Docker's bridge pool. An address in it tells us nothing about the LAN. */
function isContainerBridge(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 172 && b >= 16 && b <= 31;
}

/**
 * Our addresses on the home network, which is the only set worth comparing
 * against. Inside a bridged container this is empty: we simply do not know
 * what the LAN sees us as, and guessing from 172.17.0.9 turned a mower on the
 * same network into "zit in een ander subnet dan deze server".
 */
export function lanIpv4(): string[] {
  const fromIfaces = serverIpv4().filter(ip => !isContainerBridge(ip));
  if (fromIfaces.length) return fromIfaces;
  // Inside a bridged container the interfaces say nothing, but the advertiser
  // was told (TARGET_IP) or worked out which address the LAN knows us by. That
  // is the address the mowers are actually pointed at, so it is the right one
  // to compare against.
  const advertised = getActiveAdvertisement()?.ip;
  return advertised && !isContainerBridge(advertised) ? [advertised] : [];
}

export function serverIpv4(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    // Docker's own bridges answer on every container and say nothing about how
    // a mower on the LAN reaches us.
    if (/^(lo|docker|br-|veth)/.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

async function resolve(host: string, ours: string[]): Promise<DnsResult> {
  try {
    const addresses = await new Promise<string[]>((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), PROBE_TIMEOUT_MS);
      dns.resolve4(host, (err, a) => {
        clearTimeout(t);
        err ? rej(err) : res(a);
      });
    });
    return {
      host, addresses, error: null,
      pointsHere: ours.length === 0 ? null : addresses.some(a => ours.includes(a)),
    };
  } catch (err) {
    return {
      host,
      addresses: [],
      error: err instanceof Error ? err.message : String(err),
      pointsHere: null,
    };
  }
}

function tcpProbe(ip: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(PROBE_TIMEOUT_MS);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, ip);
  });
}

function sameSlash24(a: string, b: string): boolean {
  return a.split('.').slice(0, 3).join('.') === b.split('.').slice(0, 3).join('.');
}

export async function checkReachability(deviceIp: string | null): Promise<Reachability> {
  const serverIps = serverIpv4();
  // Alleen adressen op het thuisnetwerk zijn een zinnige vergelijkingsbasis.
  const lanIps = lanIpv4();
  const [dnsResults, answered] = await Promise.all([
    Promise.all(DEVICE_HOSTNAMES.map(h => resolve(h, lanIps))),
    deviceIp
      ? Promise.all(DEVICE_PROBE_PORTS.map(p => tcpProbe(deviceIp, p))).then(r => r.some(Boolean))
      : Promise.resolve(false),
  ]);
  return {
    serverIps,
    dns: dnsResults,
    deviceIp,
    deviceAnswered: answered,
    sameSubnet: deviceIp && lanIps.length
      ? lanIps.some(ip => sameSlash24(ip, deviceIp))
      : null,
  };
}
