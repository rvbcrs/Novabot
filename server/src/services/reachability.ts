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
  /** True when at least one answer is an address of this server. */
  pointsHere: boolean;
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
    return { host, addresses, error: null, pointsHere: addresses.some(a => ours.includes(a)) };
  } catch (err) {
    return {
      host,
      addresses: [],
      error: err instanceof Error ? err.message : String(err),
      pointsHere: false,
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
  const [dnsResults, answered] = await Promise.all([
    Promise.all(DEVICE_HOSTNAMES.map(h => resolve(h, serverIps))),
    deviceIp
      ? Promise.all(DEVICE_PROBE_PORTS.map(p => tcpProbe(deviceIp, p))).then(r => r.some(Boolean))
      : Promise.resolve(false),
  ]);
  return {
    serverIps,
    dns: dnsResults,
    deviceIp,
    deviceAnswered: answered,
    sameSubnet: deviceIp && serverIps.length
      ? serverIps.some(ip => sameSlash24(ip, deviceIp))
      : null,
  };
}
