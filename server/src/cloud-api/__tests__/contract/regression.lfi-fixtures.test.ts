/**
 * LFI-cloud regression tests.
 *
 * For every hot cloud-api endpoint, we keep a `.lfi.json` fixture captured
 * from the real LFI cloud via `server/scripts/capture-lfi-fixtures.mjs`.
 * These tests assert:
 *
 *   1. The fixture itself parses against our Zod schema. If LFI ever changes
 *      a response shape, the fixture starts failing the schema — regenerate
 *      fixture + update schema + CHANGELOG in one PR.
 *
 *   2. Our server's response also parses against the same schema. Catches
 *      drift in our implementation independently from LFI's.
 *
 *   3. The set of top-level keys (and, for envelope responses, the
 *      `value.*` keys) on our response is a SUPERSET of LFI's keys. We
 *      never silently DROP a key LFI returns — that would break the app.
 *      Adding extra keys is allowed so we can evolve without losing backwards
 *      compatibility.
 *
 * Tests are SKIPPED if the fixture is missing (so CI + `npm test` stay green
 * for contributors without LFI credentials). Run
 * `node scripts/capture-lfi-fixtures.mjs` first to generate them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTestApp, seedUser, seedEquipment, signJwt } from '../testHarness.js';
import {
  userEquipmentListResponseSchema,
  getEquipmentBySnResponseSchema,
} from '../../serializers/equipmentDto.js';
import { queryEquipmentMapResponseSchema } from '../../serializers/mapDto.js';
import { checkOtaNewVersionResponseSchema } from '../../serializers/otaDto.js';
import { loginResponseSchema } from '../../serializers/appUserDto.js';
import { db } from '../../../db/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures');

function loadFixture(name: string): unknown | null {
  const file = path.join(FIXTURE_DIR, `${name}.lfi.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function keysAtPath(obj: unknown, dotPath: string): string[] {
  const parts = dotPath === '' ? [] : dotPath.split('.');
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return [];
    if (Array.isArray(cur)) cur = cur[0];   // take first element for array paths
    cur = cur?.[p];
  }
  if (cur == null || typeof cur !== 'object') return [];
  if (Array.isArray(cur)) return keysAtPath({ arr: cur }, 'arr');
  return Object.keys(cur);
}

/**
 * Assert that `actual`'s keys at `dotPath` are a superset of `expected`'s.
 * Gives us "no dropped fields" without enforcing "no added fields".
 */
function assertKeysSuperset(
  actual: unknown, expected: unknown, dotPath: string, label: string,
): void {
  const a = new Set(keysAtPath(actual, dotPath));
  const e = keysAtPath(expected, dotPath);
  const missing = e.filter(k => !a.has(k));
  if (missing.length > 0) {
    throw new Error(
      `${label}: server response is missing keys that LFI returns at '${dotPath}': ${missing.join(', ')}`,
    );
  }
}

describe('cloud-api regression vs LFI fixtures', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM equipment; DELETE FROM users; DELETE FROM maps;`);
  });

  // ── login ───────────────────────────────────────────────────────────
  describe('appUser.login', () => {
    const fixture = loadFixture('appUser.login');
    const skip = !fixture;

    (skip ? it.skip : it)('fixture parses against loginResponseSchema', () => {
      expect(() => loginResponseSchema.parse(fixture)).not.toThrow();
    });

    (skip ? it.skip : it)('our server response shape matches LFI keys', async () => {
      const app = buildTestApp();
      const user = seedUser('login@example.com', 'test-pw');
      const resp = await request(app)
        .post('/api/nova-user/user/login')
        .send({ email: user.email, password: 'test-pw' });
      expect(resp.status).toBe(200);
      expect(() => loginResponseSchema.parse(resp.body)).not.toThrow();
      assertKeysSuperset(resp.body, fixture, '', 'login envelope');
      assertKeysSuperset(resp.body, fixture, 'value', 'login.value');
    });
  });

  // ── userEquipmentList ───────────────────────────────────────────────
  describe('equipment.userEquipmentList', () => {
    const fixture = loadFixture('equipment.userEquipmentList');
    const skip = !fixture;

    (skip ? it.skip : it)('fixture parses against schema', () => {
      expect(() => userEquipmentListResponseSchema.parse(fixture)).not.toThrow();
    });

    (skip ? it.skip : it)('server pageList entry keys are a superset of LFI', async () => {
      const app = buildTestApp();
      const user = seedUser();
      seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
      const token = signJwt(user);
      const resp = await request(app)
        .post('/api/nova-user/equipment/userEquipmentList')
        .set('Authorization', token)
        .send({ appUserId: user.app_user_id, pageSize: 10, pageNo: 1 });
      expect(resp.status).toBe(200);
      expect(() => userEquipmentListResponseSchema.parse(resp.body)).not.toThrow();
      assertKeysSuperset(resp.body, fixture, '', 'list envelope');
      assertKeysSuperset(resp.body, fixture, 'value', 'list.value');
      assertKeysSuperset(resp.body, fixture, 'value.pageList', 'list.pageList[]');
    });
  });

  // ── getEquipmentBySN (mower) ────────────────────────────────────────
  describe('equipment.getEquipmentBySN.mower', () => {
    const fixture = loadFixture('equipment.getEquipmentBySN.mower');
    const skip = !fixture;

    (skip ? it.skip : it)('fixture parses against schema', () => {
      expect(() => getEquipmentBySnResponseSchema.parse(fixture)).not.toThrow();
    });

    (skip ? it.skip : it)('server response keys superset LFI', async () => {
      const app = buildTestApp();
      const user = seedUser();
      seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
      const token = signJwt(user);
      const resp = await request(app)
        .post('/api/nova-user/equipment/getEquipmentBySN')
        .set('Authorization', token)
        .send({ sn: 'LFIN0001' });
      expect(resp.status).toBe(200);
      expect(() => getEquipmentBySnResponseSchema.parse(resp.body)).not.toThrow();
      assertKeysSuperset(resp.body, fixture, 'value', 'getEquipmentBySN.value (mower)');
    });
  });

  // ── getEquipmentBySN (charger) ──────────────────────────────────────
  describe('equipment.getEquipmentBySN.charger', () => {
    const fixture = loadFixture('equipment.getEquipmentBySN.charger');
    const skip = !fixture;

    (skip ? it.skip : it)('fixture parses against schema', () => {
      expect(() => getEquipmentBySnResponseSchema.parse(fixture)).not.toThrow();
    });

    (skip ? it.skip : it)('server charger response keys superset LFI', async () => {
      const app = buildTestApp();
      const user = seedUser();
      seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
      const token = signJwt(user);
      const resp = await request(app)
        .post('/api/nova-user/equipment/getEquipmentBySN')
        .set('Authorization', token)
        .send({ sn: 'LFIC0001' });
      expect(resp.status).toBe(200);
      expect(() => getEquipmentBySnResponseSchema.parse(resp.body)).not.toThrow();
      assertKeysSuperset(resp.body, fixture, 'value', 'getEquipmentBySN.value (charger)');
    });
  });

  // ── queryEquipmentMap ───────────────────────────────────────────────
  describe('map.queryEquipmentMap', () => {
    const fixture = loadFixture('map.queryEquipmentMap');
    const skip = !fixture;

    (skip ? it.skip : it)('fixture parses against schema', () => {
      expect(() => queryEquipmentMapResponseSchema.parse(fixture)).not.toThrow();
    });

    (skip ? it.skip : it)('server response keys superset LFI', async () => {
      const app = buildTestApp();
      const user = seedUser();
      seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
      const token = signJwt(user);
      const resp = await request(app)
        .get('/api/nova-file-server/map/queryEquipmentMap')
        .set('Authorization', token)
        .query({ sn: 'LFIN0001' });
      expect(resp.status).toBe(200);
      expect(() => queryEquipmentMapResponseSchema.parse(resp.body)).not.toThrow();
      assertKeysSuperset(resp.body, fixture, 'value', 'queryEquipmentMap.value');
    });
  });

  // ── checkOtaNewVersion ──────────────────────────────────────────────
  describe('ota.checkOtaNewVersion.mower', () => {
    const fixture = loadFixture('ota.checkOtaNewVersion.mower');
    const skip = !fixture;

    (skip ? it.skip : it)('fixture parses against schema', () => {
      expect(() => checkOtaNewVersionResponseSchema.parse(fixture)).not.toThrow();
    });

    (skip ? it.skip : it)('server response keys superset LFI', async () => {
      const app = buildTestApp();
      const user = seedUser();
      seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
      const token = signJwt(user);
      const resp = await request(app)
        .get('/api/nova-user/otaUpgrade/checkOtaNewVersion')
        .set('Authorization', token)
        .query({ sn: 'LFIN0001', version: 'v6.0.2', equipmentType: 'mower' });
      expect(resp.status).toBe(200);
      expect(() => checkOtaNewVersionResponseSchema.parse(resp.body)).not.toThrow();
      if (resp.body.value != null) {
        assertKeysSuperset(resp.body, fixture, 'value', 'checkOtaNewVersion.value');
      }
    });
  });
});
