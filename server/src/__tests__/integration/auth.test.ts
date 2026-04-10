/**
 * Integration test — authentication flow.
 * Tests user creation, login lookup, and admin checks.
 */
import { describe, it, expect } from 'vitest';
import { userRepo } from '../../db/repositories/index.js';

describe('Auth flow', () => {
  it('first user becomes admin', () => {
    userRepo.create('user-1', 'admin@test.com', 'hash', 'admin', true);
    expect(userRepo.isAdmin('user-1')).toBe(true);
  });

  it('second user is not admin', () => {
    userRepo.create('user-1', 'admin@test.com', 'hash', 'admin', true);
    userRepo.create('user-2', 'user@test.com', 'hash', 'user', false);
    expect(userRepo.isAdmin('user-2')).toBe(false);
  });

  it('login finds user by normalized email', () => {
    userRepo.create('user-1', 'Test@Example.COM', 'hash', 'test');

    // App might send different casing
    const found = userRepo.findByEmailNormalized('test@example.com');
    expect(found).toBeDefined();
    expect(found!.app_user_id).toBe('user-1');
  });

  it('password update works', () => {
    userRepo.create('user-1', 'test@test.com', 'oldhash', 'test');
    userRepo.updatePassword('user-1', 'newhash');

    const user = userRepo.findById('user-1');
    expect(user!.password).toBe('newhash');
  });

  it('updatePasswordByEmail works', () => {
    userRepo.create('user-1', 'test@test.com', 'oldhash', 'test');
    userRepo.updatePasswordByEmail('test@test.com', 'newhash');

    const user = userRepo.findByEmail('test@test.com');
    expect(user!.password).toBe('newhash');
  });

  it('duplicate email throws', () => {
    userRepo.create('user-1', 'test@test.com', 'hash', 'test');
    expect(() => userRepo.create('user-2', 'test@test.com', 'hash', 'test2')).toThrow();
  });

  it('duplicate app_user_id throws', () => {
    userRepo.create('user-1', 'a@test.com', 'hash', 'a');
    expect(() => userRepo.create('user-1', 'b@test.com', 'hash', 'b')).toThrow();
  });
});
