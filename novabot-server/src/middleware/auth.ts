import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest, fail } from '../types/index.js';

const JWT_SECRET = process.env.JWT_SECRET ?? 'change_me';

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
