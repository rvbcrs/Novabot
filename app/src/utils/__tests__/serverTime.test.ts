import { describe, it, expect } from 'vitest';
import { parseServerUtc } from '../serverTime';

describe('parseServerUtc (#137)', () => {
  it('treats SQLite datetime strings as UTC', () => {
    expect(parseServerUtc('2026-09-19 12:39:42').toISOString()).toBe('2026-09-19T12:39:42.000Z');
  });
  it('leaves ISO strings and other formats alone', () => {
    expect(parseServerUtc('2026-09-19T12:39:42.000Z').toISOString()).toBe('2026-09-19T12:39:42.000Z');
    expect(parseServerUtc('09/19 14:39').getTime()).toBe(new Date('09/19 14:39').getTime());
  });
});
