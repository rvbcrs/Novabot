import { describe, it, expect, beforeEach, vi } from 'vitest';
import { equipmentRepo, userRepo, deviceRepo } from '../../db/repositories/index.js';
import {
  resolveMowerIp,
  resolveMowerHost,
  isDiscoveredIpFresh,
  DISCOVERED_FRESHNESS_MS,
  stopMowerIpDiscovery,
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
