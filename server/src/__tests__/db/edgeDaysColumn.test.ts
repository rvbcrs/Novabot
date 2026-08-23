import { describe, it, expect } from 'vitest';
import { db } from '../../db/database.js';

describe('dashboard_schedules.edge_days migratie', () => {
  it('de kolom bestaat en is nullable', () => {
    const cols = db.prepare(`PRAGMA table_info(dashboard_schedules)`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
    const col = cols.find(c => c.name === 'edge_days');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0); // nullable
  });
});
