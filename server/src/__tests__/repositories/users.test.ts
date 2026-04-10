import { describe, it, expect } from 'vitest';
import { userRepo } from '../../db/repositories/index.js';

describe('UserRepository', () => {
  const testUser = {
    appUserId: 'test-user-001',
    email: 'test@example.com',
    password: '$2b$10$hashedpassword',
    username: 'testuser',
  };

  describe('create + findByEmail', () => {
    it('creates a user and finds by email', () => {
      userRepo.create(testUser.appUserId, testUser.email, testUser.password, testUser.username);
      const found = userRepo.findByEmail(testUser.email);
      expect(found).toBeDefined();
      expect(found!.email).toBe(testUser.email);
      expect(found!.app_user_id).toBe(testUser.appUserId);
      expect(found!.username).toBe(testUser.username);
    });

    it('returns undefined for non-existent email', () => {
      expect(userRepo.findByEmail('nobody@example.com')).toBeUndefined();
    });
  });

  describe('findById', () => {
    it('finds user by app_user_id', () => {
      userRepo.create(testUser.appUserId, testUser.email, testUser.password, testUser.username);
      const found = userRepo.findById(testUser.appUserId);
      expect(found).toBeDefined();
      expect(found!.email).toBe(testUser.email);
    });
  });

  describe('findByEmailNormalized', () => {
    it('finds with different case and whitespace', () => {
      userRepo.create(testUser.appUserId, testUser.email, testUser.password, testUser.username);
      const found = userRepo.findByEmailNormalized('  TEST@EXAMPLE.COM  ');
      expect(found).toBeDefined();
      expect(found!.email).toBe(testUser.email);
    });
  });

  describe('count', () => {
    it('returns 0 for empty table', () => {
      expect(userRepo.count()).toBe(0);
    });

    it('returns correct count after inserts', () => {
      userRepo.create('u1', 'a@test.com', 'hash', 'a');
      userRepo.create('u2', 'b@test.com', 'hash', 'b');
      expect(userRepo.count()).toBe(2);
    });
  });

  describe('updatePassword', () => {
    it('updates the password', () => {
      userRepo.create(testUser.appUserId, testUser.email, testUser.password, testUser.username);
      userRepo.updatePassword(testUser.appUserId, 'newhash');
      const found = userRepo.findById(testUser.appUserId);
      expect(found!.password).toBe('newhash');
    });
  });

  describe('isAdmin', () => {
    it('returns true for admin user', () => {
      userRepo.create(testUser.appUserId, testUser.email, testUser.password, testUser.username, true);
      expect(userRepo.isAdmin(testUser.appUserId)).toBe(true);
    });

    it('returns false for non-admin user', () => {
      userRepo.create(testUser.appUserId, testUser.email, testUser.password, testUser.username, false);
      expect(userRepo.isAdmin(testUser.appUserId)).toBe(false);
    });
  });
});
