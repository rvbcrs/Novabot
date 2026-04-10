/**
 * Email Code Repository — email_codes database operations.
 * All queries use prepared statements (SQL injection safe).
 */
import { db } from '../database.js';

export interface EmailCodeRow {
  id: number;
  email: string;
  code: string;
  type: string;
  expires_at: string;
  used: number;
}

export class EmailCodeRepository {
  // ── Prepared statements ──

  private _create = db.prepare(`
    INSERT INTO email_codes (email, code, type, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  private _findValid = db.prepare(`
    SELECT * FROM email_codes
    WHERE email = ? AND code = ? AND type = ?
      AND used = 0 AND expires_at > datetime('now')
    ORDER BY id DESC LIMIT 1
  `);
  private _markUsed = db.prepare(
    'UPDATE email_codes SET used = 1 WHERE id = ?'
  );
  private _markUsedByEmailAndCode = db.prepare(
    'UPDATE email_codes SET used = 1 WHERE email = ? AND code = ?'
  );
  private _deleteExpired = db.prepare(
    "DELETE FROM email_codes WHERE expires_at <= datetime('now')"
  );

  // ── Methods ──

  create(email: string, code: string, type: string, expiresAt: string): void {
    this._create.run(email, code, type, expiresAt);
  }

  findValid(email: string, code: string, type: string): EmailCodeRow | undefined {
    return this._findValid.get(email, code, type) as EmailCodeRow | undefined;
  }

  markUsed(id: number): void {
    this._markUsed.run(id);
  }

  markUsedByEmailAndCode(email: string, code: string): void {
    this._markUsedByEmailAndCode.run(email, code);
  }

  deleteExpired(): void {
    this._deleteExpired.run();
  }
}

export const emailCodeRepo = new EmailCodeRepository();
