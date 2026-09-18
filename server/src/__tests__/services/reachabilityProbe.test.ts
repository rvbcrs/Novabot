/**
 * The device port probe behind the "Network" diagnosis row.
 *
 * Real sockets: a listener that accepts, a loopback port that refuses, and a
 * TEST-NET address that swallows SYNs, which is what a mower on Wi-Fi with a
 * cold ARP entry looks like from a freshly started container.
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { tcpProbe } from '../../services/reachability.js';

const servers: net.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

function listen(port = 0): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer(sock => sock.end());
    servers.push(s);
    s.listen(port, '127.0.0.1', () => resolve((s.address() as net.AddressInfo).port));
  });
}

/** A port nobody listens on right now. */
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

describe('device port probe', () => {
  it('is true for a port that accepts', async () => {
    const port = await listen();
    expect(await tcpProbe('127.0.0.1', port)).toBe(true);
  });

  it('is false, and quick, for a port that refuses: a refusal is an answer', async () => {
    const port = await freePort();
    const t0 = Date.now();
    expect(await tcpProbe('127.0.0.1', port)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(700);          // no second attempt after ECONNREFUSED
  });

  it('tries once more after a timeout, so a slow first handshake does not read as "does not answer"', async () => {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737): never routed, so SYNs go unanswered
    // and the first attempt times out. The second must actually run, and also
    // time out, so the whole thing takes about two timeouts.
    const t0 = Date.now();
    const ok = await tcpProbe('192.0.2.1', 9);
    const took = Date.now() - t0;
    expect(ok).toBe(false);
    expect(took).toBeGreaterThanOrEqual(1500);           // two attempts of 800 ms
    expect(took).toBeLessThan(3000);
  }, 10000);
});
