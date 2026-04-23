/**
 * Contract test — `GET /api/nova-user/otaUpgrade/checkOtaNewVersion`.
 *
 * Locks the wire shape the Novabot app depends on, plus the CLAUDE.md OTA
 * invariants that have bitten us repeatedly in production:
 *
 *   1. "No update" branch → `value: null` (NOT `{ upgradeFlag: 0, ... }`).
 *      The handler returns a bare `ok(null)` — the app parses `null` as
 *      "no upgrade". If anyone "helpfully" fills in a zeroed object the
 *      app's upgrade check logic quietly changes.
 *
 *   2. "Update available" branch → `upgradeFlag` is literal integer `1`.
 *      mqtt_node and the Novabot app only fire on this exact int; truthy
 *      strings or booleans silently skip the upgrade flow.
 *
 *   3. `downloadUrl` MUST be `http://…` — the local server has no TLS and
 *      the mower firmware refuses TLS downloads. The handler explicitly
 *      rewrites `https://` → `http://`. We assert both the positive prefix
 *      and the explicit non-match of `https://` so a future "let's keep
 *      https for mixed deployments" regression trips the test, not prod.
 *
 *   4. Device-type routing: `sn` starting with `LFIC` routes to the
 *      `device_type='charger'` row; anything else routes to `'mower'`.
 *      A charger-version row must not leak to a mower SN query.
 *
 * The schema lives in `serializers/otaDto.ts`; this test uses the same Zod
 * parse pattern as the other contract tests so a shape change fails loudly
 * with a full diff instead of a silent missing-field.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildTestApp, seedUser, seedEquipment, signJwt } from '../testHarness.js';
import { checkOtaNewVersionResponseSchema } from '../../serializers/otaDto.js';
import { db } from '../../../db/database.js';

describe('GET /api/nova-user/otaUpgrade/checkOtaNewVersion — contract', () => {
  it('returns value=null when no ota_versions row exists for the device type', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });
    const token = signJwt(user);

    const resp = await request(app)
      .get('/api/nova-user/otaUpgrade/checkOtaNewVersion')
      .set('Authorization', token)
      .query({ sn: 'LFIN0001', version: 'v6.0.2-custom-17' });

    expect(resp.status).toBe(200);
    const parsed = checkOtaNewVersionResponseSchema.safeParse(resp.body);
    if (!parsed.success) {
      throw new Error(
        `Response failed schema validation:\n${JSON.stringify(parsed.error.issues, null, 2)}\n\nBody:\n${JSON.stringify(resp.body, null, 2)}`,
      );
    }

    expect(resp.body.success).toBe(true);
    expect(resp.body.code).toBe(200);
    // "No update" branch is a bare null — NOT { upgradeFlag: 0, ... }.
    expect(resp.body.value).toBeNull();
  });

  it('returns value=null when the stored version matches the current version (no upgrade needed)', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });

    // Seed a row at the *same* version the device reports — handler must
    // return null, not echo the row as an "upgrade".
    db.prepare(`
      INSERT INTO ota_versions (version, device_type, release_notes, download_url, md5)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'v6.0.2-custom-17',
      'mower',
      'same version, should not trigger upgrade',
      'http://192.168.0.177:3000/firmware/mower-v6.0.2-custom-17.tar.gz',
      'deadbeefdeadbeefdeadbeefdeadbeef',
    );

    const token = signJwt(user);

    const resp = await request(app)
      .get('/api/nova-user/otaUpgrade/checkOtaNewVersion')
      .set('Authorization', token)
      .query({ sn: 'LFIN0001', version: 'v6.0.2-custom-17' });

    expect(resp.status).toBe(200);
    expect(resp.body.value).toBeNull();
  });

  it('returns upgradeFlag=1 and http:// downloadUrl when a newer version exists', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });

    db.prepare(`
      INSERT INTO ota_versions (version, device_type, release_notes, download_url, md5)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'v6.0.2-custom-18',
      'mower',
      'night-docking LED fix',
      'http://192.168.0.177:3000/firmware/mower-v6.0.2-custom-18.tar.gz',
      '0123456789abcdef0123456789abcdef',
    );

    const token = signJwt(user);

    const resp = await request(app)
      .get('/api/nova-user/otaUpgrade/checkOtaNewVersion')
      .set('Authorization', token)
      .query({ sn: 'LFIN0001', version: 'v6.0.2-custom-17' });

    expect(resp.status).toBe(200);
    const parsed = checkOtaNewVersionResponseSchema.safeParse(resp.body);
    if (!parsed.success) {
      throw new Error(
        `Response failed schema validation:\n${JSON.stringify(parsed.error.issues, null, 2)}\n\nBody:\n${JSON.stringify(resp.body, null, 2)}`,
      );
    }

    expect(resp.body.value).not.toBeNull();
    expect(resp.body.value.version).toBe('v6.0.2-custom-18');
    expect(resp.body.value.upgradeFlag).toBe(1);
    expect(resp.body.value.md5).toBe('0123456789abcdef0123456789abcdef');
    expect(resp.body.value.releaseNotes).toBe('night-docking LED fix');

    // CLAUDE.md OTA rule: URLs MUST be http:// — mower firmware refuses TLS.
    expect(resp.body.value.downloadUrl).toMatch(/^http:\/\//);
    expect(resp.body.value.downloadUrl).not.toMatch(/^https:\/\//);
  });

  it('rewrites https:// download_url to http:// before returning it', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });

    // Deliberately insert an https:// URL to prove the handler rewrites it.
    db.prepare(`
      INSERT INTO ota_versions (version, device_type, release_notes, download_url, md5)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'v6.0.2-custom-18',
      'mower',
      null,
      'https://192.168.0.177:3000/firmware/mower-v6.0.2-custom-18.tar.gz',
      null,
    );

    const token = signJwt(user);

    const resp = await request(app)
      .get('/api/nova-user/otaUpgrade/checkOtaNewVersion')
      .set('Authorization', token)
      .query({ sn: 'LFIN0001', version: 'v6.0.2-custom-17' });

    expect(resp.status).toBe(200);
    // Schema already enforces ^http:// via regex; add an explicit assertion
    // so a failure here points at "https rewrite" rather than "schema".
    expect(resp.body.value.downloadUrl).toBe(
      'http://192.168.0.177:3000/firmware/mower-v6.0.2-custom-18.tar.gz',
    );
    // md5 null in DB → handler emits '' (string), NOT null. Lock that.
    expect(resp.body.value.md5).toBe('');
    // release_notes null in DB → handler passes it through as null.
    expect(resp.body.value.releaseNotes).toBeNull();
  });

  it('routes charger SN (LFIC…) to the charger ota_versions row, not the mower row', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: 'LFIN0001', snCharger: 'LFIC0001', isActive: true });

    // Seed both a mower and a charger upgrade. A charger SN query must
    // select the charger row, never the mower one.
    db.prepare(`
      INSERT INTO ota_versions (version, device_type, release_notes, download_url, md5)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'mower-v2',
      'mower',
      'mower update',
      'http://example.invalid/mower.tar.gz',
      null,
    );
    db.prepare(`
      INSERT INTO ota_versions (version, device_type, release_notes, download_url, md5)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'charger-v2',
      'charger',
      'charger update',
      'http://example.invalid/charger.bin',
      null,
    );

    const token = signJwt(user);

    const resp = await request(app)
      .get('/api/nova-user/otaUpgrade/checkOtaNewVersion')
      .set('Authorization', token)
      .query({ sn: 'LFIC0001', version: 'charger-v1' });

    expect(resp.status).toBe(200);
    expect(resp.body.value).not.toBeNull();
    expect(resp.body.value.version).toBe('charger-v2');
    expect(resp.body.value.upgradeFlag).toBe(1);
  });
});
