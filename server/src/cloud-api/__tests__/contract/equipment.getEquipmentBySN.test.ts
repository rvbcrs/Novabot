/**
 * Contract test — `POST /api/nova-user/equipment/getEquipmentBySN`.
 *
 * Locks the wire shape and the CLAUDE.md invariants:
 *   - charger SN → chargerAddress=718, chargerChannel=16, account+password
 *     hard-coded to the LFI MQTT creds
 *   - mower SN   → chargerAddress/chargerChannel/account/password all null
 *
 * The handler's "row found" branch returns `{ ...rowToCloudDto(...), userId,
 * macAddress }`, which mirrors the full `cloudEquipmentDtoSchema` shape. Any
 * drift — adding a new field, changing a null to a default, flipping userId
 * semantics — must update `getEquipmentBySnResponseSchema` and this test in
 * the same commit so regressions surface loudly.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildTestApp, seedUser, seedEquipment, signJwt } from '../testHarness.js';
import { getEquipmentBySnResponseSchema } from '../../serializers/equipmentDto.js';

describe('POST /api/nova-user/equipment/getEquipmentBySN — contract', () => {
  it('returns charger DTO with hard-coded LoRa defaults', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    const token = signJwt(user);

    const resp = await request(app)
      .post('/api/nova-user/equipment/getEquipmentBySN')
      .set('Authorization', token)
      .send({ sn: 'LFIC0001' });

    expect(resp.status).toBe(200);
    const parsed = getEquipmentBySnResponseSchema.safeParse(resp.body);
    if (!parsed.success) {
      throw new Error(
        `Response failed schema validation:\n${JSON.stringify(parsed.error.issues, null, 2)}\n\nBody:\n${JSON.stringify(resp.body, null, 2)}`,
      );
    }

    expect(resp.body.success).toBe(true);
    expect(resp.body.code).toBe(200);
    expect(resp.body.value?.sn).toBe('LFIC0001');
    expect(resp.body.value?.deviceType).toBe('charger');
    expect(resp.body.value?.chargerAddress).toBe(718);
    expect(resp.body.value?.chargerChannel).toBe(16);
    expect(resp.body.value?.account).toBe('li9hep19');
    expect(resp.body.value?.password).toBe('jzd4wac6');
  });

  it('returns mower DTO with nullable charger fields', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    const token = signJwt(user);

    const resp = await request(app)
      .post('/api/nova-user/equipment/getEquipmentBySN')
      .set('Authorization', token)
      .send({ sn: 'LFIN0001' });

    expect(resp.status).toBe(200);
    const parsed = getEquipmentBySnResponseSchema.safeParse(resp.body);
    if (!parsed.success) {
      throw new Error(
        `Response failed schema validation:\n${JSON.stringify(parsed.error.issues, null, 2)}\n\nBody:\n${JSON.stringify(resp.body, null, 2)}`,
      );
    }

    expect(resp.body.value?.sn).toBe('LFIN0001');
    expect(resp.body.value?.deviceType).toBe('mower');
    expect(resp.body.value?.chargerAddress).toBeNull();
    expect(resp.body.value?.chargerChannel).toBeNull();
    expect(resp.body.value?.account).toBeNull();
    expect(resp.body.value?.password).toBeNull();
  });
});
