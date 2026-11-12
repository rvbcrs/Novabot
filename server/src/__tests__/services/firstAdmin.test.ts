/**
 * The first account on a fresh server is the owner's own and an admin (GH #164).
 * The admin page made admin@local with password "admin"; the dashboard's first
 * user was no admin, so nobody could manage users.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import bcrypt from 'bcrypt';
import { createFirstAdmin } from '../../services/firstAdmin.js';
import { userRepo } from '../../db/repositories/index.js';
import { db } from '../../db/database.js';
import { translator } from '../../services/serverText.js';

const T = translator('nl');

describe('createFirstAdmin', () => {
  beforeEach(() => { db.prepare('DELETE FROM users').run(); });

  it("makes the owner's own account, admin with dashboard access", () => {
    const r = createFirstAdmin(T, '  Ramon@Example.TEST ', 'geheim1');
    expect(r).toEqual({ ok: true, email: 'ramon@example.test' });
    const u = userRepo.findByEmail('ramon@example.test')!;
    expect(u.is_admin).toBe(1);
    expect(u.dashboard_access).toBe(1);
    expect(bcrypt.compareSync('geheim1', u.password)).toBe(true);
    expect(userRepo.findByEmail('admin@local')).toBeUndefined();
  });

  it('refuses a bad email or a short password', () => {
    expect(createFirstAdmin(T, 'admin', 'geheim1')).toMatchObject({ ok: false, status: 400 });
    expect(createFirstAdmin(T, 'a@b.c', '12345')).toMatchObject({ ok: false, status: 400 });
    expect(userRepo.count()).toBe(0);
  });

  it('only makes the first account; later ones are added by an admin', () => {
    createFirstAdmin(T, 'one@example.test', 'geheim1');
    expect(createFirstAdmin(T, 'two@example.test', 'geheim2')).toMatchObject({ ok: false, status: 409 });
    expect(userRepo.count()).toBe(1);
  });
});
