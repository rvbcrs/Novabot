/**
 * Contract test — `POST /api/nova-user/equipment/userEquipmentList`.
 *
 * Locks the wire shape the Novabot app expects (see
 * `research/documents/cloud-api-freeze.md` + CLAUDE.md invariants). Any change
 * to the response must update `userEquipmentListResponseSchema` AND this test
 * in the same commit so drift surfaces loudly.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildTestApp, seedUser, seedEquipment, signJwt } from '../testHarness.js';
import { userEquipmentListResponseSchema } from '../../serializers/equipmentDto.js';

describe('POST /api/nova-user/equipment/userEquipmentList — contract', () => {
  it('shape matches Zod schema', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    const token = signJwt(user);

    const resp = await request(app)
      .post('/api/nova-user/equipment/userEquipmentList')
      .set('Authorization', token)
      .send({ appUserId: user.app_user_id, pageSize: 10, pageNo: 1 });

    expect(resp.status).toBe(200);
    const parsed = userEquipmentListResponseSchema.safeParse(resp.body);
    if (!parsed.success) {
      // Surface the diff so a regression is easy to pin down instead of the
      // default "Invalid input" one-liner from Zod.
      throw new Error(
        `Response failed schema validation:\n${JSON.stringify(parsed.error.issues, null, 2)}\n\nBody:\n${JSON.stringify(resp.body, null, 2)}`,
      );
    }
  });

  it('critical field values match LFI cloud baseline', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    const token = signJwt(user);

    const resp = await request(app)
      .post('/api/nova-user/equipment/userEquipmentList')
      .set('Authorization', token)
      .send({ appUserId: user.app_user_id, pageSize: 10, pageNo: 1 });

    expect(resp.body.success).toBe(true);
    expect(resp.body.code).toBe(200);

    const pageList = resp.body.value.pageList as Array<Record<string, unknown>>;
    expect(Array.isArray(pageList)).toBe(true);

    const charger = pageList.find((d) => d.sn === 'LFIC0001');
    expect(charger).toBeDefined();
    expect(charger!.chargerAddress).toBe(718);
    expect(charger!.chargerChannel).toBe(16);
    expect(charger!.account).toBe('li9hep19');
    expect(charger!.password).toBe('jzd4wac6');
    expect(charger!.model).toBe('N1000');
    expect(charger!.deviceType).toBe('charger');

    const mower = pageList.find((d) => d.sn === 'LFIN0001');
    expect(mower).toBeDefined();
    expect(mower!.chargerAddress).toBeNull();
    expect(mower!.chargerChannel).toBeNull();
    expect(mower!.account).toBeNull();
    expect(mower!.password).toBeNull();
    expect(mower!.model).toBe('N2000');
    expect(mower!.deviceType).toBe('mower');
  });

  it('filters out inactive equipment when user has multiple pairs', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    seedEquipment({ user, snMower: 'LFIN0002', snCharger: 'LFIC0002', isActive: false });
    const token = signJwt(user);

    const resp = await request(app)
      .post('/api/nova-user/equipment/userEquipmentList')
      .set('Authorization', token)
      .send({ appUserId: user.app_user_id, pageSize: 10, pageNo: 1 });

    const sns = (resp.body.value.pageList as Array<{ sn: string }>).map((d) => d.sn);
    expect(sns).toContain('LFIN0001');
    expect(sns).toContain('LFIC0001');
    expect(sns).not.toContain('LFIN0002');
    expect(sns).not.toContain('LFIC0002');
  });
});
