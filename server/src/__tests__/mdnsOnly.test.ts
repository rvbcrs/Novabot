/**
 * The mDNS sidecar must be nothing but the advertiser.
 *
 * It runs with network_mode: host, next to the real server, from the same
 * image. If it ever pulled in index.ts it would open the database and bind
 * 80, 443 and 1883 on the host: exactly what the sidecar exists to avoid.
 * Running it in the suite would advertise a name on the developer's network,
 * so the property is checked on the source instead, where it is just as
 * definite.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const src = readFileSync(path.resolve(__dirname, '../mdnsOnly.ts'), 'utf8');
const imports = [...src.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map(m => m[1]);

describe('mdnsOnly entry', () => {
  it('imports the advertiser and nothing else', () => {
    expect(imports).toEqual(['./services/mdnsAdvertiser.js']);
  });

  it('never touches the server, the database or the broker', () => {
    for (const forbidden of ['./index', './db/', './mqtt/', 'express', 'aedes', 'better-sqlite3']) {
      expect(src).not.toContain(`from '${forbidden}`);
      expect(src).not.toContain(`import('${forbidden}`);
    }
  });

  it('is the target of the MDNS_ONLY branch in the entrypoint, before anything else starts', () => {
    const entry = readFileSync(path.resolve(__dirname, '../../../docker-entrypoint.sh'), 'utf8');
    const branch = entry.indexOf('MDNS_ONLY');
    expect(branch).toBeGreaterThan(-1);
    expect(entry.slice(branch)).toMatch(/exec node dist\/mdnsOnly\.js/);
    // nginx and dnsmasq are started further down; the sidecar must exec before them
    expect(branch).toBeLessThan(entry.indexOf('nginx'));
    expect(branch).toBeLessThan(entry.indexOf('dnsmasq'));
  });

  it('is wired up in compose as a host-network service from the same image', () => {
    const compose = readFileSync(path.resolve(__dirname, '../../../docker-compose.yml'), 'utf8');
    const i = compose.indexOf('opennova-mdns:');
    expect(i).toBeGreaterThan(-1);
    const svc = compose.slice(i, i + 800);
    expect(svc).toContain('network_mode: host');
    expect(svc).toContain('MDNS_ONLY: "true"');
    expect(svc).toContain('image: rvbcrs/opennova:latest');
    // and the main container hands mDNS over to it
    expect(compose).toMatch(/ENABLE_MDNS: "false"/);
    expect(compose).toMatch(/MDNS_SIDECAR: "true"/);
  });
});
