/**
 * The first account on a fresh server, made by the owner: their own email
 * and password, admin with dashboard access (GH #164).
 *
 * Both first-run screens use it: the admin page's "local account only" and
 * the dashboard onboarding. The admin page used to make admin@local with the
 * password "admin" instead, and the dashboard's first user was not an admin,
 * so nobody could manage users afterwards.
 */
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import { userRepo } from '../db/repositories/index.js';
import { invalidateSetupCache } from '../middleware/setupGuard.js';
import type { Translate } from './serverText.js';

export const MIN_PASSWORD_LENGTH = 6;

export type FirstAdminResult = { ok: true; email: string } | { ok: false; status: number; error: string };

export function createFirstAdmin(T: Translate, email: unknown, password: unknown, username = ''): FirstAdminResult {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) return { ok: false, status: 400, error: T`Ongeldig e-mailadres` };
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, status: 400, error: T`Het wachtwoord moet minstens 6 tekens hebben` };
  }
  // Only the first: everyone after that is added by an admin.
  if (userRepo.count() > 0) return { ok: false, status: 409, error: T`Er bestaat al een gebruiker. Gebruik de inlogpagina.` };

  const appUserId = uuidv4();
  userRepo.create(appUserId, normalized, bcrypt.hashSync(password, 10), username.trim(), true);
  userRepo.setRole(appUserId, 'dashboard_access', true);
  invalidateSetupCache();
  console.log(`[SETUP] First account created: ${normalized} (admin)`);
  return { ok: true, email: normalized };
}
