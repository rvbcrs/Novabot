import { describe, it, expect } from 'vitest';
import { db } from '../../db/database.js';

describe('patrol_runs.dock_failed_at migration', () => {
  it('the column exists, holds epoch milliseconds and is nullable', () => {
    const cols = db.prepare(`PRAGMA table_info(patrol_runs)`).all() as Array<{ name: string; type: string; notnull: number }>;
    const col = cols.find(c => c.name === 'dock_failed_at');
    expect(col).toBeDefined();
    expect(col!.type).toBe('INTEGER');
    expect(col!.notnull).toBe(0);
  });

  it('keeps the columns the run filters key on', () => {
    const names = (db.prepare(`PRAGMA table_info(patrol_runs)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(['mower_sn', 'run', 'token', 'started_at', 'schedule_id', 'ended_phase']));
  });
});
