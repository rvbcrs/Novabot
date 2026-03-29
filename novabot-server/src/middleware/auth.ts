import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest, fail } from '../types/index.js';

import crypto from 'crypto';

// Generate random secret if not set — tokens won't survive restart but it's secure
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const secret = crypto.randomBytes(32).toString('hex');
  console.warn('[AUTH] JWT_SECRET not set — using random secret (tokens expire on restart)');
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
export function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.userId) { res.json(fail('Unauthorized', 401)); return; }

  const { db } = require('../db/database.js');
  const row = db.prepare('SELECT is_admin FROM users WHERE app_user_id = ?').get(req.userId) as { is_admin: number } | undefined;
  if (!row || row.is_admin !== 1) {
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

  const { db } = require('../db/database.js');
  const row = db.prepare('SELECT is_admin, dashboard_access FROM users WHERE app_user_id = ?').get(req.userId) as { is_admin: number; dashboard_access: number } | undefined;
  if (!row || (row.is_admin !== 1 && row.dashboard_access !== 1)) {
    res.status(403).json(fail('Dashboard access required', 403));
    return;
  }
  next();
}
