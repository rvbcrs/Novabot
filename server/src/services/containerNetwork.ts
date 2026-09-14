/**
 * Is this server able to reach the LAN with multicast?
 *
 * Mowers find their server over mDNS: set_server_urls.sh resolves
 * opennova.local at boot, and opennova_discovery.py polls it every 60 s and
 * rewrites the mower's config when the address changes. All of that depends on
 * multicast reaching the home network, and Docker's default bridge blocks it.
 * mdnsAdvertiser.ts already names this as a prerequisite.
 *
 * The result is silent: the advertiser starts, reports no error, and no mower
 * ever hears it. On LFIN1231000009 that showed up only as a line deep in the
 * mower's own log, `SKIP json_config.json update — geen server IP beschikbaar`,
 * and everything then leaned on the DNS redirect instead.
 */
import fs from 'fs';
import { serverIpv4 } from './reachability.js';

export interface ContainerNetwork {
  inContainer: boolean;
  /** True when every address we have is a container bridge range. */
  bridged: boolean;
  addresses: string[];
}

/** Docker's default bridge pool. A LAN address never falls in it. */
function isBridgeRange(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 172 && b >= 16 && b <= 31;
}

export function inspectContainerNetwork(
  readFile: (p: string) => string | null = p => {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
  },
  ips: string[] = serverIpv4(),
): ContainerNetwork {
  const inContainer = readFile('/.dockerenv') !== null
    || /docker|containerd|kubepods/.test(readFile('/proc/1/cgroup') ?? '');
  return {
    inContainer,
    // Host networking gives the container the machine's own LAN address, so a
    // real address means multicast can get out even inside a container.
    bridged: inContainer && ips.length > 0 && ips.every(isBridgeRange),
    addresses: ips,
  };
}
