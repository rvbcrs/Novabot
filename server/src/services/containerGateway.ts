// Its own module so the connection diagnosis can use it without importing
// mowerIpDiscovery, which many route tests mock.
import fs from 'node:fs';

/** The default gateway in a /proc/net/route table (hex, little-endian), null without one. */
export function containerGatewayFromRoutes(table: string): string | null {
  for (const line of table.split('\n').slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/);
    if (destination !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(gateway ?? '')) continue;
    const n = parseInt(gateway, 16);
    return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join('.');
  }
  return null;
}

/**
 * The container's default gateway: the address Docker Desktop's NAT gives
 * every incoming connection, never a mower's. On Linux and in host networking
 * it is the router, which no mower has either. Null outside Linux.
 */
export function containerGateway(): string | null {
  try {
    return containerGatewayFromRoutes(fs.readFileSync('/proc/net/route', 'utf8'));
  } catch {
    return null;
  }
}
