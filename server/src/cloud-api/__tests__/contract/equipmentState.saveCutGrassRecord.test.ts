/**
 * Regression tests for `POST /api/nova-data/equipmentState/saveCutGrassRecord`.
 *
 * Locks three bug-fixes from issue #17 (reporter: waltervl, v5.7.1 stock firmware):
 *
 *   Bug 1 — cutGrassHeight stored as wire+2 (user picks 5 cm → stored 7 cm).
 *     Root cause: sensor-cache fallback did `target_height + 2` converting wire
 *     enum to user_cm. But the stored value MUST be the wire enum (same as what
 *     the mower POSTs directly and same as what LFI cloud stores). The app and
 *     dashboard both display `cutGrassHeight + 2` cm. Storing user_cm made the
 *     display show `(user_cm + 2)` cm — two too many.
 *
 *   Bug 2 — workTime always 0.
 *     Fix: try `valid_cov_work_time` first; fall back to `cov_work_time`.
 *     Both are MINUTES, like the work_record column: robot_decision divides
 *     the planner's navigation_time (seconds) by 60 and logs the result as
 *     "cov_work_time(min)", and CovTaskInfo.msg documents both as minutes.
 *     (An earlier round treated cov_work_time as seconds and divided by 60,
 *     which turned 170 minutes into 3.)
 *
 *   Bug 3 — dateTime formatted as ISO-8601 "2026-04-29T18:13:10.94Z".
 *     The app and dashboard expect SQL/display format "2026-04-29 18:13:10"
 *     (no T, no Z, no fractional seconds). Fix: normaliseDateTime() applies
 *     `new Date(raw).toISOString().replace('T', ' ').slice(0,19)` to any
 *     incoming string that contains 'T'.
 *
 * Each test POSTs as multipart/form-data (same as the real mower) via supertest.
 * Stored values are read back directly from the messageRepo to avoid coupling
 * these tests to the queryCutGrassRecordPageByUserId response shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, seedUser, seedEquipment } from '../testHarness.js';
import { messageRepo } from '../../../db/repositories/index.js';
import { deviceCache } from '../../../mqtt/sensorData.js';

const SN = 'LFIN_TEST0001';

/** Seed the deviceCache for SN with the given key/value pairs. */
function seedCache(kv: Record<string, string>): void {
  if (!deviceCache.has(SN)) deviceCache.set(SN, new Map());
  const m = deviceCache.get(SN)!;
  for (const [k, v] of Object.entries(kv)) m.set(k, v);
}

beforeEach(() => {
  // Clean up any stale cache entries that might bleed between tests.
  deviceCache.delete(SN);
});

afterEach(() => {
  deviceCache.delete(SN);
});

describe('POST /api/nova-data/equipmentState/saveCutGrassRecord — issue #17 regression', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Bug 1: cutGrassHeight stored as wire + 2 instead of wire enum
  // ──────────────────────────────────────────────────────────────────────────

  it('[Bug 1] stores raw wire enum when mower POSTs cutGrassHeight directly', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: SN });

    // Mower POSTs wire value 3 (= user set 5 cm; cutterhigh = user_cm - 2).
    // Server must store 3 — NOT 5 and NOT 7.
    const resp = await request(app)
      .post('/api/nova-data/equipmentState/saveCutGrassRecord')
      .field('sn', SN)
      .field('cutGrassHeight', '3')
      .field('workTime', '10')
      .field('dateTime', '2026-04-29 18:13:10');

    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);

    // Read back via repo — must be wire enum 3, not user_cm 5, not 7.
    const rows = messageRepo.findWorkRecordsByUserId(user.app_user_id, 10, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].cut_grass_height).toBe(3);
  });

  it('[Bug 1] sensor-cache fallback stores wire enum, NOT wire+2', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: SN });

    // No cutGrassHeight in POST → fallback to sensor cache.
    // target_height = 3 (wire enum; user set 5 cm).
    // Must store 3 — NOT 5 (= 3+2).
    seedCache({ target_height: '3' });

    const resp = await request(app)
      .post('/api/nova-data/equipmentState/saveCutGrassRecord')
      .field('sn', SN)
      .field('workTime', '10')
      .field('dateTime', '2026-04-29 18:13:10');

    expect(resp.status).toBe(200);

    const rows = messageRepo.findWorkRecordsByUserId(user.app_user_id, 10, 0);
    expect(rows).toHaveLength(1);
    // Wire enum 3, not 5.
    expect(rows[0].cut_grass_height).toBe(3);
  });

  it('[Bug 1] regression: previous code (wire+2) would have stored 5 for wire=3, not 3', async () => {
    // Confirm the fix: wire=3 → stored=3 (not 5 as the old code did).
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: SN });

    seedCache({ target_height: '5' }); // wire=5 → user_cm = 7 cm

    await request(app)
      .post('/api/nova-data/equipmentState/saveCutGrassRecord')
      .field('sn', SN)
      .field('workTime', '10')
      .field('dateTime', '2026-04-29 18:13:10');

    const rows = messageRepo.findWorkRecordsByUserId(user.app_user_id, 10, 0);
    // Must store 5 (the wire value), not 7 (= 5+2 as the buggy code did).
    expect(rows[0].cut_grass_height).toBe(5);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Bug 2: workTime always 0
  // ──────────────────────────────────────────────────────────────────────────

  it('[Bug 2] workTime from mower POST body is stored as-is (minutes)', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: SN });

    const resp = await request(app)
      .post('/api/nova-data/equipmentState/saveCutGrassRecord')
      .field('sn', SN)
      .field('workTime', '42')
      .field('dateTime', '2026-04-29 18:13:10');

    expect(resp.status).toBe(200);

    const rows = messageRepo.findWorkRecordsByUserId(user.app_user_id, 10, 0);
    expect(rows[0].work_time).toBe(42);
  });

  it('[Bug 2] sensor-cache fallback uses valid_cov_work_time (minutes) when present', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: SN });

    // valid_cov_work_time is in minutes — should be used directly.
    seedCache({ valid_cov_work_time: '170' });

    await request(app)
      .post('/api/nova-data/equipmentState/saveCutGrassRecord')
      .field('sn', SN)
      .field('dateTime', '2026-04-29 18:13:10');

    const rows = messageRepo.findWorkRecordsByUserId(user.app_user_id, 10, 0);
    // 170 minutes stored directly.
    expect(rows[0].work_time).toBe(170);
  });

  it('[Bug 2] sensor-cache fallback stores cov_work_time (minutes) as minutes', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: SN });

    // cov_work_time is in minutes (robot_decision: navigation_time / 60).
    seedCache({ cov_work_time: '170' });

    await request(app)
      .post('/api/nova-data/equipmentState/saveCutGrassRecord')
      .field('sn', SN)
      .field('dateTime', '2026-04-29 18:13:10');

    const rows = messageRepo.findWorkRecordsByUserId(user.app_user_id, 10, 0);
    expect(rows[0].work_time).toBe(170);
  });

  it('[Bug 2] regression: cov_work_time is not divided by 60 (42.4 min is stored as 42, not 1)', async () => {
    // The previous round treated cov_work_time as seconds; 42.4 would have
    // landed as Math.round(42.4 / 60) = 1 minute.
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: SN });

    seedCache({ cov_work_time: '42.4' });

    await request(app)
      .post('/api/nova-data/equipmentState/saveCutGrassRecord')
      .field('sn', SN)
      .field('dateTime', '2026-04-29 18:13:10');

    const rows = messageRepo.findWorkRecordsByUserId(user.app_user_id, 10, 0);
    expect(rows[0].work_time).toBe(42);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Bug 3: dateTime in server-local wall clock, SQL format
  //
  // Stock Novabot app renders dateTime verbatim (no Date parsing). Server
  // converts UTC input to the operator's TZ (process.env.TZ, default
  // Europe/Amsterdam) so the stock app shows correct local time and the
  // dashboard / OpenNova app (which DO parse) also render correctly.
  // ──────────────────────────────────────────────────────────────────────────

  it('[Bug 3] converts UTC input to server TZ wall clock (CEST = +2h)', async () => {
    process.env.TZ = 'Europe/Amsterdam';
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: SN });

    // 18:13 UTC on 2026-04-29 = 20:13 in Amsterdam (CEST = UTC+2)
    const resp = await request(app)
      .post('/api/nova-data/equipmentState/saveCutGrassRecord')
      .field('sn', SN)
      .field('dateTime', '2026-04-29T18:13:10.94Z')
      .field('workTime', '5');

    expect(resp.status).toBe(200);

    const rows = messageRepo.findWorkRecordsByUserId(user.app_user_id, 10, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].date_time).toBe('2026-04-29 20:13:10');
  });

  it('[Bug 3] strips fractional seconds', async () => {
    process.env.TZ = 'Europe/Amsterdam';
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: SN });

    await request(app)
      .post('/api/nova-data/equipmentState/saveCutGrassRecord')
      .field('sn', SN)
      .field('dateTime', '2026-04-29T18:13:10.94Z')
      .field('workTime', '3');

    const rows = messageRepo.findWorkRecordsByUserId(user.app_user_id, 10, 0);
    const dt = rows[0].date_time ?? '';
    expect(dt).not.toMatch(/\./);
    expect(dt).not.toMatch(/[TZ]/);
  });

  it('[Bug 3] SQL-format input is treated as UTC then converted', async () => {
    process.env.TZ = 'Europe/Amsterdam';
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: SN });

    await request(app)
      .post('/api/nova-data/equipmentState/saveCutGrassRecord')
      .field('sn', SN)
      .field('dateTime', '2026-04-29T18:13:10Z')
      .field('workTime', '5');

    const rows = messageRepo.findWorkRecordsByUserId(user.app_user_id, 10, 0);
    expect(rows[0].date_time).toMatch(/^2026-04-29 \d{2}:\d{2}:\d{2}$/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Smoke: empty body / no SN returns ok(null) without insert
  // ──────────────────────────────────────────────────────────────────────────

  it('returns ok(null) for empty body without inserting a record', async () => {
    const app = buildTestApp();
    const user = seedUser();
    seedEquipment({ user, snMower: SN });

    const resp = await request(app)
      .post('/api/nova-data/equipmentState/saveCutGrassRecord')
      .send('');

    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);
    expect(resp.body.value).toBeNull();

    // No record inserted.
    const rows = messageRepo.findWorkRecordsByUserId(user.app_user_id, 10, 0);
    expect(rows).toHaveLength(0);
  });
});
