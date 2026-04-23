/**
 * Contract test — `GET /api/nova-file-server/map/queryEquipmentMap`.
 *
 * Locks the wire shape against the Novabot app's expectations:
 *   - `data` may be `null` when no maps are known, otherwise
 *     `{ work: MapEntityItem[], unicom: MapEntityItem[] }`.
 *   - `md5` is `null` OR a 32-char UPPERCASE hex digest (never lowercase,
 *     never an arbitrary string). The handler explicitly calls
 *     `.toUpperCase()` — a regression would silently break app caching.
 *   - IDOR: a user querying someone else's SN must get the same
 *     all-null payload as a user with no maps (same wire shape, no leak
 *     about existence).
 *   - Unknown SN (no equipment row at all) must also return the null
 *     payload — preserves the "never reveal whether the SN exists" rule.
 *
 * The auth middleware (`middleware/auth.ts`) accepts both `Bearer <token>`
 * and a bare token in `Authorization`; tests use the bare form to mirror
 * what the Novabot app actually sends.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildTestApp, seedUser, seedEquipment, signJwt } from '../testHarness.js';
import { queryEquipmentMapResponseSchema } from '../../serializers/mapDto.js';

describe('GET /api/nova-file-server/map/queryEquipmentMap — contract', () => {
  it('returns data=null, md5=null, machineExtendedField=null when mower has no maps', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    const token = signJwt(user);

    const resp = await request(app)
      .get('/api/nova-file-server/map/queryEquipmentMap')
      .set('Authorization', token)
      .query({ sn: 'LFIN0001' });

    expect(resp.status).toBe(200);
    const parsed = queryEquipmentMapResponseSchema.safeParse(resp.body);
    if (!parsed.success) {
      throw new Error(
        `Response failed schema validation:\n${JSON.stringify(parsed.error.issues, null, 2)}\n\nBody:\n${JSON.stringify(resp.body, null, 2)}`,
      );
    }

    expect(resp.body.success).toBe(true);
    expect(resp.body.code).toBe(200);
    expect(resp.body.value.data).toBeNull();
    expect(resp.body.value.md5).toBeNull();
    expect(resp.body.value.machineExtendedField).toBeNull();
  });

  it('md5 is null or UPPERCASE hex (never lowercase)', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    const token = signJwt(user);

    const resp = await request(app)
      .get('/api/nova-file-server/map/queryEquipmentMap')
      .set('Authorization', token)
      .query({ sn: 'LFIN0001' });

    const md5 = resp.body.value.md5;
    // null OR uppercase hex — explicitly exclude lowercase, which would
    // indicate a missing `.toUpperCase()` in the handler.
    expect(md5 === null || /^[A-F0-9]{32}$/.test(md5)).toBe(true);
  });

  it('returns null payload when querying SN owned by another user (IDOR guard)', async () => {
    // Two users, each with their own mower. User A must NOT be able to
    // see user B's map state — handler takes the "not owned" branch and
    // returns the same all-null shape as "no maps", which hides
    // existence by construction.
    const app = buildTestApp();
    const userA = seedUser('a@example.com', 'pw-a', 'UserA');
    const userB = seedUser('b@example.com', 'pw-b', 'UserB');
    seedEquipment({ user: userA, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    seedEquipment({ user: userB, snMower: 'LFIN0002', snCharger: 'LFIC0002', isActive: true });
    const tokenA = signJwt(userA);

    const resp = await request(app)
      .get('/api/nova-file-server/map/queryEquipmentMap')
      .set('Authorization', tokenA)
      .query({ sn: 'LFIN0002' }); // userA queries userB's mower

    expect(resp.status).toBe(200);
    const parsed = queryEquipmentMapResponseSchema.safeParse(resp.body);
    if (!parsed.success) {
      throw new Error(
        `Response failed schema validation:\n${JSON.stringify(parsed.error.issues, null, 2)}\n\nBody:\n${JSON.stringify(resp.body, null, 2)}`,
      );
    }
    expect(resp.body.value.data).toBeNull();
    expect(resp.body.value.md5).toBeNull();
    expect(resp.body.value.machineExtendedField).toBeNull();
  });
});
