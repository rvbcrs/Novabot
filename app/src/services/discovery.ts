/**
 * Discover OpenNova servers on the local network.
 * Uses multiple strategies since getting the device's IP is unreliable on mobile.
 */

export interface DiscoveredServer {
  ip: string;
}

const PROBE_TIMEOUT = 2000;

// Common home network subnets + common host IPs
const SUBNETS = ['192.168.0', '192.168.1', '192.168.2', '192.168.178', '10.0.0', '10.0.1'];
const HOST_IPS = [1, 2, 3, 4, 5, 10, 50, 100, 150, 177, 200, 250, 254];

async function probeServer(ip: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
    const res = await fetch(`http://${ip}:3000/api/setup/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await res.json();
    return body?.server === 'running';
  } catch {
    return false;
  }
}

export async function discoverServers(
  onFound: (server: DiscoveredServer) => void,
): Promise<void> {
  // Build candidate list from common subnets
  const candidates = new Set<string>();
  for (const subnet of SUBNETS) {
    for (const host of HOST_IPS) {
      candidates.add(`${subnet}.${host}`);
    }
  }

  // Probe in batches of 20 to avoid overwhelming the network
  const all = Array.from(candidates);
  const batchSize = 20;

  for (let i = 0; i < all.length; i += batchSize) {
    const batch = all.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (ip) => {
        if (await probeServer(ip)) {
          onFound({ ip });
        }
      }),
    );
  }
}
