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

export interface UserWithEquipmentSummaryRow extends UserRow {
  mower_sns: string | null;
  charger_sns: string | null;
}

export interface BasicUserRow {
  app_user_id: string;
  email: string;
  username: string | null;
}

export class UserRepository {
  // ── Prepared statements (cached for performance) ──
  private _findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  private _findById = db.prepare('SELECT * FROM users WHERE app_user_id = ?');
  private _findFirst = db.prepare('SELECT * FROM users ORDER BY id LIMIT 1');
  private _findByEmailNormalized = db.prepare('SELECT * FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))');
  private _create = db.prepare(`
    INSERT INTO users (app_user_id, email, password, username, is_admin, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  private _createIfMissing = db.prepare(`
    INSERT OR IGNORE INTO users (app_user_id, email, password, username)
    VALUES (?, ?, ?, ?)
  `);
  private _updatePassword = db.prepare('UPDATE users SET password = ? WHERE app_user_id = ?');
  private _updateMachineToken = db.prepare('UPDATE users SET machine_token = ? WHERE app_user_id = ?');
  private _updateUsername = db.prepare('UPDATE users SET username = ? WHERE app_user_id = ?');
  private _deleteById = db.prepare('DELETE FROM users WHERE app_user_id = ?');
  private _setIsAdmin = db.prepare('UPDATE users SET is_admin = ? WHERE app_user_id = ?');
  private _setDashboardAccess = db.prepare('UPDATE users SET dashboard_access = ? WHERE app_user_id = ?');
  private _count = db.prepare('SELECT COUNT(*) as count FROM users');
  private _isAdmin = db.prepare('SELECT is_admin FROM users WHERE app_user_id = ?');
  private _hasDashboardAccess = db.prepare('SELECT is_admin, dashboard_access FROM users WHERE app_user_id = ?');
  private _updatePasswordByEmail = db.prepare('UPDATE users SET password = ? WHERE email = ?');
  private _listWithEquipmentSummary = db.prepare(`
    SELECT u.id, u.app_user_id, u.email, u.password, u.username, u.machine_token,
           u.is_admin, u.dashboard_access, u.created_at,
           GROUP_CONCAT(DISTINCT e.mower_sn) as mower_sns,
           GROUP_CONCAT(DISTINCT e.charger_sn) as charger_sns
    FROM users u
    LEFT JOIN equipment e ON e.user_id = u.app_user_id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `);
  private _listBasic = db.prepare('SELECT app_user_id, email, username FROM users ORDER BY created_at DESC');

  findByEmail(email: string): UserRow | undefined {
    return this._findByEmail.get(email) as UserRow | undefined;
  }

  findByEmailNormalized(email: string): UserRow | undefined {
    return this._findByEmailNormalized.get(email) as UserRow | undefined;
  }

  findById(appUserId: string): UserRow | undefined {
    return this._findById.get(appUserId) as UserRow | undefined;
  }

  findFirst(): UserRow | undefined {
    return this._findFirst.get() as UserRow | undefined;
  }

  create(appUserId: string, email: string, hashedPassword: string, username: string, isAdmin = false): void {
    this._create.run(appUserId, email, hashedPassword, username, isAdmin ? 1 : 0);
  }

  createIfMissing(appUserId: string, email: string, hashedPassword: string, username: string): void {
    this._createIfMissing.run(appUserId, email, hashedPassword, username);
  }

  updatePassword(appUserId: string, hashedPassword: string): void {
    this._updatePassword.run(hashedPassword, appUserId);
  }

  updateMachineToken(appUserId: string, token: string): void {
    this._updateMachineToken.run(token, appUserId);
  }

  updateUsername(appUserId: string, username: string | null): void {
    this._updateUsername.run(username, appUserId);
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

  updatePasswordByEmail(email: string, hashedPassword: string): void {
    this._updatePasswordByEmail.run(hashedPassword, email);
  }

  setRole(appUserId: string, role: 'is_admin' | 'dashboard_access', enabled: boolean): void {
    const value = enabled ? 1 : 0;
    if (role === 'is_admin') {
      this._setIsAdmin.run(value, appUserId);
      return;
    }
    this._setDashboardAccess.run(value, appUserId);
  }

  deleteById(appUserId: string): void {
    this._deleteById.run(appUserId);
  }

  listWithEquipmentSummary(): UserWithEquipmentSummaryRow[] {
    return this._listWithEquipmentSummary.all() as UserWithEquipmentSummaryRow[];
  }

  listBasic(): BasicUserRow[] {
    return this._listBasic.all() as BasicUserRow[];
  }
}

export const userRepo = new UserRepository();
