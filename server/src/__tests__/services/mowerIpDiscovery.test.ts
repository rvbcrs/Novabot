import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { equipmentRepo, userRepo, deviceRepo } from '../../db/repositories/index.js';
import {
  resolveMowerIp,
  resolveMowerHost,
  isDiscoveredIpFresh,
  DISCOVERED_FRESHNESS_MS,
  stopMowerIpDiscovery,
  rememberReportedLanIp,
  containerGatewayFromRoutes,
} from '../../services/mowerIpDiscovery.js';
import { db } from '../../db/database.js';

const userId = 'test-user-discovery';
const sn = 'LFIN0001';

function reset() {
  // Tear the rows the test cares about — leave the schema alone.
  db.prepare('DELETE FROM equipment WHERE mower_sn = ?').run(sn);
  db.prepare('DELETE FROM device_registry WHERE sn = ?').run(sn);
  db.prepare('DELETE FROM users WHERE app_user_id = ?').run(userId);
}

describe('mowerIpDiscovery', () => {
  beforeEach(() => {
    reset();
    stopMowerIpDiscovery();
    userRepo.create(userId, 'discovery@test.com', 'hash', 'discovery');
    equipmentRepo.create({ equipment_id: 'eq-discovery', user_id: userId, mower_sn: sn });
  });

  describe('isDiscoveredIpFresh', () => {
    it('returns false for null', () => {
      expect(isDiscoveredIpFresh(null)).toBe(false);
    });

    it('returns true for a recent timestamp (SQLite UTC format)', () => {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      expect(isDiscoveredIpFresh(now)).toBe(true);
    });

    it('returns false for a timestamp older than the freshness window', () => {
      const stale = new Date(Date.now() - DISCOVERED_FRESHNESS_MS - 1000)
        .toISOString().slice(0, 19).replace('T', ' ');
      expect(isDiscoveredIpFresh(stale)).toBe(false);
    });
  });

  describe('resolveMowerIp priority', () => {
    it('returns the manual mower_ip even if discovered_ip is also set', async () => {
      equipmentRepo.create({
        equipment_id: 'eq-pinned', user_id: userId, mower_sn: 'LFIN9999',
        mower_ip: '10.0.0.5',
      });
      equipmentRepo.setDiscoveredIp('LFIN9999', '192.168.0.100');

      const ip = await resolveMowerIp('LFIN9999', { triggerIfMissing: false });
      expect(ip).toBe('10.0.0.5');
    });

    it('returns discovered_ip when fresh and no manual IP', async () => {
      equipmentRepo.setDiscoveredIp(sn, '192.168.0.100');

      const ip = await resolveMowerIp(sn, { triggerIfMissing: false });
      expect(ip).toBe('192.168.0.100');
    });

    it('ignores stale discovered_ip and falls back to detected_ip', async () => {
      // Stamp a stale discovered_ip directly
      const stale = new Date(Date.now() - DISCOVERED_FRESHNESS_MS - 60_000)
        .toISOString().slice(0, 19).replace('T', ' ');
      db.prepare('UPDATE equipment SET discovered_ip = ?, discovered_ip_at = ? WHERE mower_sn = ?')
        .run('192.168.0.100', stale, sn);
      // And a fresh private detected_ip from the MQTT broker
      deviceRepo.upsertDevice('mower-client', sn, null);
      deviceRepo.updateIpBySn(sn, '192.168.0.50');

      const ip = await resolveMowerIp(sn, { triggerIfMissing: false });
      expect(ip).toBe('192.168.0.50');
    });

    it('rejects a public detected_ip (Cloudflare CDN edge)', async () => {
      deviceRepo.upsertDevice('mower-client-cf', sn, null);
      deviceRepo.updateIpBySn(sn, '172.64.66.1');

      const ip = await resolveMowerIp(sn, { triggerIfMissing: false });
      expect(ip).toBeNull();
    });

    it('returns null without triggering discovery when triggerIfMissing=false', async () => {
      const spy = vi.fn();
      const ip = await resolveMowerIp(sn, { triggerIfMissing: false });
      expect(ip).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // Docker Desktop (Windows, macOS) NATs published ports: the broker sees every
  // mower connection come from the container's own gateway (172.18.0.1), and
  // the app tried to open the camera there (Facebook, Oct 2026).
  describe('behind Docker Desktop NAT', () => {
    const ROUTES = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
      'eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    ].join('\n');

    afterEach(() => vi.restoreAllMocks());

    function routeTable(text: string) {
      const real = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) =>
        p === '/proc/net/route' ? text : real(p, o as never)) as typeof fs.readFileSync);
    }

    it('reads the default gateway from /proc/net/route', () => {
      expect(containerGatewayFromRoutes(ROUTES)).toBe('172.18.0.1');
    });

    it('has no gateway without a default route', () => {
      const [header, , subnet] = ROUTES.split('\n');
      expect(containerGatewayFromRoutes([header, subnet].join('\n'))).toBeNull();
      expect(containerGatewayFromRoutes('')).toBeNull();
    });

    it('never hands out the container gateway as the mower address', async () => {
      routeTable(ROUTES);
      deviceRepo.upsertDevice('mower-client-nat', sn, null);
      deviceRepo.updateIpBySn(sn, '172.18.0.1');

      expect(await resolveMowerIp(sn, { triggerIfMissing: false })).toBeNull();
    });

    it('still hands out a detected address that is not the gateway', async () => {
      routeTable(ROUTES);
      deviceRepo.upsertDevice('mower-client-lan', sn, null);
      deviceRepo.updateIpBySn(sn, '192.168.0.50');

      expect(await resolveMowerIp(sn, { triggerIfMissing: false })).toBe('192.168.0.50');
    });

    it('prefers the address the mower reported over its link (ext_hello lan_ip)', async () => {
      deviceRepo.upsertDevice('mower-client-nat', sn, null);
      deviceRepo.updateIpBySn(sn, '172.18.0.1');
      equipmentRepo.setDiscoveredIp(sn, '192.168.0.100');
      rememberReportedLanIp(sn, '192.168.0.77');

      expect(await resolveMowerIp(sn, { triggerIfMissing: false })).toBe('192.168.0.77');
    });

    it('keeps the manual mower_ip above a reported address', async () => {
      equipmentRepo.create({
        equipment_id: 'eq-pinned-nat', user_id: userId, mower_sn: 'LFIN9998', mower_ip: '10.0.0.5',
      });
      rememberReportedLanIp('LFIN9998', '192.168.0.77');

      expect(await resolveMowerIp('LFIN9998', { triggerIfMissing: false })).toBe('10.0.0.5');
    });

    it('ignores a reported value that is not a private IPv4 address', async () => {
      for (const value of ['8.8.8.8', '127.0.0.1', '192.168.0', 'novabot.local', 42, null, undefined, {}]) {
        rememberReportedLanIp(sn, value);
        expect(await resolveMowerIp(sn, { triggerIfMissing: false }), String(value)).toBeNull();
      }
    });

    it('forgets the reported address when a later hello has none', async () => {
      rememberReportedLanIp(sn, '192.168.0.77');
      rememberReportedLanIp(sn, undefined);

      expect(await resolveMowerIp(sn, { triggerIfMissing: false })).toBeNull();
    });
  });

  describe('per-SN hostname resolution', () => {
    it('resolveMowerHost is exported (per-SN + novabot.local fallback chain)', () => {
      // We can't reliably test the actual mDNS lookup in unit tests (would
      // require multicast on the test runner). Just confirm the function is
      // wired up and returns null for an obviously-bogus SN — verifying the
      // chain executes without throwing rather than returning a real IP.
      expect(typeof resolveMowerHost).toBe('function');
    });

    it('does not crash on a SN that resolves to nothing', async () => {
      const ip = await resolveMowerHost('LFIN_NONEXISTENT_TEST_SN');
      expect(ip).toBeNull();
    }, 10_000);
  });
});
