/**
 * User Repository — all user-related database operations.
 * All queries use prepared statements (SQL injection safe).
 */
import { db } from '../database.js';

export interface UserRow {
  id: number;
  app_user_id: string;
  email: string;
  password: string;
  username: string | null;
  machine_token: string | null;
  is_admin: number;
  dashboard_access: number;
  created_at: string;
}

export class UserRepository {
  // ── Prepared statements (cached for performance) ──
  private _findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  private _findById = db.prepare('SELECT * FROM users WHERE app_user_id = ?');
  private _findByEmailNormalized = db.prepare('SELECT * FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))');
  private _create = db.prepare(`
    INSERT INTO users (app_user_id, email, password, username, is_admin, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  private _updatePassword = db.prepare('UPDATE users SET password = ? WHERE app_user_id = ?');
  private _updateMachineToken = db.prepare('UPDATE users SET machine_token = ? WHERE app_user_id = ?');
  private _count = db.prepare('SELECT COUNT(*) as count FROM users');
  private _isAdmin = db.prepare('SELECT is_admin FROM users WHERE app_user_id = ?');
  private _hasDashboardAccess = db.prepare('SELECT is_admin, dashboard_access FROM users WHERE app_user_id = ?');

  findByEmail(email: string): UserRow | undefined {
    return this._findByEmail.get(email) as UserRow | undefined;
  }

  findByEmailNormalized(email: string): UserRow | undefined {
    return this._findByEmailNormalized.get(email) as UserRow | undefined;
  }

  findById(appUserId: string): UserRow | undefined {
    return this._findById.get(appUserId) as UserRow | undefined;
  }

  create(appUserId: string, email: string, hashedPassword: string, username: string, isAdmin = false): void {
    this._create.run(appUserId, email, hashedPassword, username, isAdmin ? 1 : 0);
  }

  updatePassword(appUserId: string, hashedPassword: string): void {
    this._updatePassword.run(hashedPassword, appUserId);
  }

  updateMachineToken(appUserId: string, token: string): void {
    this._updateMachineToken.run(token, appUserId);
  }

  count(): number {
    return (this._count.get() as { count: number }).count;
  }

  isAdmin(appUserId: string): boolean {
    const row = this._isAdmin.get(appUserId) as { is_admin: number } | undefined;
    return row?.is_admin === 1;
  }

  hasDashboardAccess(appUserId: string): boolean {
    const row = this._hasDashboardAccess.get(appUserId) as { is_admin: number; dashboard_access: number } | undefined;
    return row?.is_admin === 1 || row?.dashboard_access === 1;
  }
}

export const userRepo = new UserRepository();
