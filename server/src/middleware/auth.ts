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

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
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
    next();
  } catch {
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
