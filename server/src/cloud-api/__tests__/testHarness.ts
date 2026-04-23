/**
 * Contract-test helpers. Builds a bare express app with only the cloud-api
 * routes mounted (no MQTT, no socket.io), plus seeders for user + equipment.
 *
 * Each test gets a clean in-memory DB because `vitest.config.ts` forces
 * `DB_PATH=':memory:'` (read at static-import time by `db/database.ts`) and
 * `src/__tests__/setup.ts` truncates every table in `beforeEach`.
 *
 * JWT secret sourcing:
 *   `middleware/auth.ts` computes `JWT_SECRET` in a module-level closure the
 *   first time it's imported (env var → persistent file → generate + save).
 *   To guarantee the token we sign here is verifiable by `authMiddleware`,
 *   we re-use the middleware's own `signToken()` instead of recomputing the
 *   secret. Whatever the middleware resolved at import time, `signToken` will
 *   use the same closure value — by construction they can never diverge.
 */
import express, { type Express } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { mountCloudApi } from '../index.js';
import { signToken } from '../../middleware/auth.js';
import { userRepo, equipmentRepo } from '../../db/repositories/index.js';

/**
 * Build a bare express app with cloud-api routes mounted. No MQTT broker,
 * no socket.io, no dashboard routes, no admin routes — just the frozen HTTP
 * surface the Novabot app talks to.
 *
 * Body-parser limits mirror `src/index.ts` so request shapes behave the same
 * in tests as in production (map uploads, base64 blobs, etc.).
 */
export function buildTestApp(): Express {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  mountCloudApi(app);
  return app;
}

export interface SeededUser {
  app_user_id: string;
  email: string;
  passwordClear: string;
}

/**
 * Insert a user row directly via `userRepo.create`. Password is hashed with
 * bcrypt at cost=4 (fast enough for tests; do not reuse in production paths).
 * Returns the clear-text password so tests that hit `/login` can re-send it.
 */
export function seedUser(
  email = 'test@example.com',
  password = 'test-pw',
  username = 'Tester',
): SeededUser {
  const hash = bcrypt.hashSync(password, 4);
  const id = crypto.randomUUID();
  userRepo.create(id, email, hash, username);
  return { app_user_id: id, email, passwordClear: password };
}

export interface SeedEquipmentOptions {
  user: SeededUser;
  snMower: string;
  snCharger?: string | null;
  /** Mark the seeded row as the active pair (see `equipmentRepo.setActiveByMowerSn`). */
  isActive?: boolean;
}

/**
 * Insert an equipment row bound to the given user. Mirrors the minimal data
 * shape that `bindingEquipment` produces, so contract tests can exercise
 * `getEquipmentBySN` and friends without going through the binding flow.
 */
export function seedEquipment(opts: SeedEquipmentOptions): void {
  equipmentRepo.create({
    equipment_id: `eq-${opts.snMower}`,
    user_id: opts.user.app_user_id,
    mower_sn: opts.snMower,
    charger_sn: opts.snCharger ?? null,
  });
  if (opts.isActive) {
    equipmentRepo.setActiveByMowerSn(opts.snMower);
  }
}

/**
 * Sign a JWT for the given seeded user, using the exact same secret the
 * live `authMiddleware` will verify against. See the module-level comment
 * for why we delegate to `signToken` instead of computing a secret locally.
 */
export function signJwt(user: SeededUser): string {
  return signToken({ userId: user.app_user_id, email: user.email });
}
