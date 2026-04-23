/**
 * Contract test — `POST /api/nova-user/user/login` (and the `/appUser/login`
 * alias — both mounted on the same router in `cloud-api/index.ts`).
 *
 * Locks the wire shape the Novabot app depends on plus the handler quirks:
 *
 *   1. Envelope is always `{ success, code, value, message, dateline }` from
 *      `ok(...)` / `fail(...)` — `dateline` is a timestamp, not optional in
 *      practice, but schema keeps it optional to mirror the helper.
 *
 *   2. Success branch emits `value` as the full `loginValueSchema` object.
 *      `appUserId` is the integer row PK (not the UUID), and `accessToken`
 *      is a JWT that must be verifiable by the live `authMiddleware`.
 *
 *   3. Failure branch ("Invalid email or password") returns HTTP 200 with
 *      `success: false`, `code: 400`, `value: null`. The handler does NOT
 *      emit an HTTP 4xx status — the app relies on `success`/`code` inside
 *      the body to decide failure, so the status-code assertion and the
 *      body-level assertion both matter.
 *
 *   4. Password handling: the Novabot app encrypts the password with
 *      AES-128-CBC (key=IV="1234123412ABCDEF", base64 output) before POST.
 *      The handler's `tryDecryptAppPassword` falls back to the raw value
 *      when the payload doesn't match the AES shape — so sending plaintext
 *      also works, which is what we do here. The stored hash is bcrypt
 *      (created by `seedUser`), and `bcrypt.compareSync` runs against the
 *      decrypted/raw password.
 *
 *   5. `seedUser` creates the user locally, so the "user not found → cloud
 *      fallback" branch (which would hit the real LFI cloud via HTTPS) is
 *      never entered. This keeps the contract test offline and fast.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildTestApp, seedUser } from '../testHarness.js';
import { loginResponseSchema } from '../../serializers/appUserDto.js';

describe('POST /api/nova-user/user/login — contract', () => {
  it('returns JWT access token and user profile on valid credentials', async () => {
    const app = buildTestApp();
    const user = seedUser('login@example.com', 'mypw', 'Ramon');

    const resp = await request(app)
      .post('/api/nova-user/user/login')
      .send({ email: user.email, password: user.passwordClear });

    expect(resp.status).toBe(200);
    const parsed = loginResponseSchema.safeParse(resp.body);
    if (!parsed.success) {
      throw new Error(
        `Response failed schema validation:\n${JSON.stringify(parsed.error.issues, null, 2)}\n\nBody:\n${JSON.stringify(resp.body, null, 2)}`,
      );
    }

    expect(resp.body.success).toBe(true);
    expect(resp.body.code).toBe(200);
    expect(resp.body.value).not.toBeNull();

    // JWT access token — shape: header.payload.signature, non-trivial length.
    expect(typeof resp.body.value.accessToken).toBe('string');
    expect(resp.body.value.accessToken.length).toBeGreaterThan(20);
    expect(resp.body.value.accessToken.split('.').length).toBe(3);

    // Profile mirrors the seeded user. `appUserId` is the SQLite row PK
    // (integer), NOT the UUID — the app's Dart code types this as int and
    // CastErrors otherwise. See cloud-api/routes/appUser.ts comment block.
    expect(typeof resp.body.value.appUserId).toBe('number');
    expect(resp.body.value.email).toBe('login@example.com');
    expect(resp.body.value.firstName).toBe('Ramon');
    expect(resp.body.value.newUserFlag).toBe(0);

    // Fields the local server doesn't collect are always emitted as empty
    // strings (NOT nulls) — the app expects the keys to be present.
    expect(resp.body.value.lastName).toBe('');
    expect(resp.body.value.phone).toBe('');
    expect(resp.body.value.country).toBe('');
    expect(resp.body.value.city).toBe('');
    expect(resp.body.value.address).toBe('');
    expect(resp.body.value.coordinates).toBe('');
  });

  it('also works via the /appUser/login alias', async () => {
    const app = buildTestApp();
    const user = seedUser('login@example.com', 'mypw');

    const resp = await request(app)
      .post('/api/nova-user/appUser/login')
      .send({ email: user.email, password: user.passwordClear });

    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);
    expect(resp.body.value?.email).toBe('login@example.com');
    expect(loginResponseSchema.safeParse(resp.body).success).toBe(true);
  });

  it('rejects wrong password with success=false and value=null', async () => {
    const app = buildTestApp();
    seedUser('login@example.com', 'mypw');

    const resp = await request(app)
      .post('/api/nova-user/user/login')
      .send({ email: 'login@example.com', password: 'wrong' });

    // HTTP 200 — the handler uses res.json(fail(...)) without status(4xx).
    expect(resp.status).toBe(200);
    const parsed = loginResponseSchema.safeParse(resp.body);
    if (!parsed.success) {
      throw new Error(
        `Response failed schema validation:\n${JSON.stringify(parsed.error.issues, null, 2)}\n\nBody:\n${JSON.stringify(resp.body, null, 2)}`,
      );
    }

    expect(resp.body.success).toBe(false);
    expect(resp.body.code).toBe(400);
    expect(resp.body.value).toBeNull();
    expect(resp.body.message).toBe('Invalid email or password');
  });

  it('rejects missing email/password with code=400', async () => {
    const app = buildTestApp();
    seedUser('login@example.com', 'mypw');

    const resp = await request(app)
      .post('/api/nova-user/user/login')
      .send({ email: 'login@example.com' });

    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(false);
    expect(resp.body.code).toBe(400);
    expect(resp.body.value).toBeNull();
    expect(resp.body.message).toBe('Email and password required');
  });
});
