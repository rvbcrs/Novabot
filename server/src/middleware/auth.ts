import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest, fail } from '../types/index.js';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// JWT secret priority: env var → persistent file → generate + save
const JWT_SECRET = (() => {
  // 1. Explicit env var
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  // 2. Persistent file in data volume (survives rebuilds + restarts)
  const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : '/data';
  const secretPath = path.join(dataDir, '.jwt_secret');
  try {
    const saved = fs.readFileSync(secretPath, 'utf8').trim();
    if (saved.length >= 32) {
      console.log('[AUTH] JWT_SECRET loaded from persistent file');
      return saved;
    }
  } catch { /* file doesn't exist yet */ }

  // 3. Generate and save for next time
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    console.log('[AUTH] JWT_SECRET generated and saved to persistent file');
  } catch (e) {
    console.warn('[AUTH] JWT_SECRET generated but could not save:', (e as Error).message);
  }
  return secret;
})();

export interface JwtPayload {
  userId: string;
  email: string;
}

type ExpiresIn = NonNullable<jwt.SignOptions['expiresIn']>;

/** Login lifetime from JWT_EXPIRES_IN. jsonwebtoken reads a bare number as
 *  seconds but a bare numeric STRING as milliseconds ("3600" = 3.6 s), so
 *  digits become a number. A value it cannot parse falls back to 30 days
 *  instead of making every login throw. */
export function resolveJwtExpiresIn(raw: string | undefined): ExpiresIn {
  const value = raw?.trim();
  if (!value) return '30d';
  if (/^\d+$/.test(value)) return Number(value) > 0 ? Number(value) : '30d';
  try {
    jwt.sign({}, 'probe', { expiresIn: value as ExpiresIn });
    return value as ExpiresIn;
  } catch {
    console.warn(`[AUTH] JWT_EXPIRES_IN="${value}" is not a valid lifetime (e.g. 30d, 12h, 3600); using 30d`);
    return '30d';
  }
}

const JWT_EXPIRES_IN = resolveJwtExpiresIn(process.env.JWT_EXPIRES_IN);

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Verify a JWT against the server secret and return the decoded payload.
 * Throws if the token is missing, malformed, expired, or signed with a
 * different secret. Use this from non-Express contexts (e.g. raw WebSocket
 * upgrade handlers) where `authMiddleware` cannot be applied.
 */
export function verifyAuthToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';

  // Accepteer zowel "Bearer <token>" als raw token
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;

  if (!token) {
    res.json(fail('Unauthorized', 401));
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.userId = decoded.userId;
    req.email = decoded.email;
    if (process.env.AUTH_DEBUG === '1') {
      console.log(`[AUTH] OK ${req.method} ${req.path} userId=${decoded.userId.slice(0,8)} (token...${token.slice(-12)})`);
    }
    next();
  } catch (err) {
    // Log enough context to triage the most common 401 causes — wrong secret
    // (after factory_reset / .jwt_secret regeneration), wrong algorithm, or
    // outright forged tokens. We never log the token itself.
    const decoded = (() => {
      try { return jwt.decode(token); } catch { return null; }
    })();
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[AUTH] reject ${req.method} ${req.path}: ${reason}`,
      decoded && typeof decoded === 'object'
        ? `(payload userId=${(decoded as any).userId}, exp=${(decoded as any).exp}, token...${token.slice(-12)})`
        : `(unparseable token, ...${token.slice(-12)})`,
    );
    res.json(fail('Token invalid or expired', 401));
  }
}

/**
 * Admin middleware — checks is_admin flag in DB after normal auth.
 * Use after authMiddleware: app.use('/api/admin', authMiddleware, adminMiddleware, adminRouter)
 */
import { userRepo } from '../db/repositories/index.js';

export function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.userId) { res.json(fail('Unauthorized', 401)); return; }

  if (!userRepo.isAdmin(req.userId)) {
    res.status(403).json(fail('Admin access required', 403));
    return;
  }
  next();
}

/**
 * Dashboard middleware — checks dashboard_access OR is_admin in DB.
 */
export function dashboardMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.userId) { res.json(fail('Unauthorized', 401)); return; }

  if (!userRepo.hasDashboardAccess(req.userId)) {
    res.status(403).json(fail('Dashboard access required', 403));
    return;
  }
  next();
}
