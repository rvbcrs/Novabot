import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { resolveJwtExpiresIn } from '../middleware/auth.js';

describe('resolveJwtExpiresIn (JWT_EXPIRES_IN)', () => {
  it('defaults to 30 days', () => {
    expect(resolveJwtExpiresIn(undefined)).toBe('30d');
    expect(resolveJwtExpiresIn('  ')).toBe('30d');
  });

  it('passes a timespan through', () => {
    expect(resolveJwtExpiresIn('365d')).toBe('365d');
    expect(resolveJwtExpiresIn('12h')).toBe('12h');
  });

  // jsonwebtoken reads the STRING "3600" as 3600 ms; a user means seconds.
  it('reads bare digits as seconds', () => {
    const value = resolveJwtExpiresIn('3600');
    expect(value).toBe(3600);
    const { exp, iat } = jwt.decode(jwt.sign({}, 'k', { expiresIn: value as number })) as { exp: number; iat: number };
    expect(exp - iat).toBe(3600);
  });

  it('falls back instead of breaking every login', () => {
    expect(resolveJwtExpiresIn('forever')).toBe('30d');
    expect(resolveJwtExpiresIn('0')).toBe('30d');
  });
});
