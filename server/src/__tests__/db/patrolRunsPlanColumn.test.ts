import { describe, it, expect } from 'vitest';
import { db, initDb } from '../../db/database.js';

const columns = () => db.prepare(`PRAGMA table_info(patrol_runs)`).all() as Array<{ name: string; type: string; notnull: number }>;

// The dashboard's patrol report reads the plan a run started with and the error
// it ended with off the run row (services/patrolPlan.ts, GET /patrol/:sn/runs).
describe('patrol_runs.plan and patrol_runs.ended_error migration', () => {
  it('a fresh database has both columns: TEXT, nullable', () => {
    for (const name of ['plan', 'ended_error']) {
      const col = columns().find(c => c.name === name);
      expect(col, name).toBeDefined();
      expect(col!.type).toBe('TEXT');
      expect(col!.notnull).toBe(0);
    }
  });

  it('a table from before them gains both, and its run keeps every value', () => {
    // patrol_runs as the first release that had it made it: no dock_failed_at either.
    db.exec(`DROP TABLE patrol_runs`);
    db.exec(`
      CREATE TABLE patrol_runs (
        mower_sn    TEXT    PRIMARY KEY,
        run         TEXT    NOT NULL,
        token       TEXT    NOT NULL,
        started_at  INTEGER NOT NULL,
        schedule_id TEXT,
        ended_phase TEXT
      );
    `);
    db.prepare(`INSERT INTO patrol_runs (mower_sn, run, token, started_at, schedule_id, ended_phase) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('LFIN_MIGRATE', '1700000000000', 'a'.repeat(32), 1700000000000, 'sched-1', 'done');
    expect(columns().map(c => c.name)).not.toContain('plan');

    initDb();

    const names = columns().map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(['dock_failed_at', 'plan', 'ended_error']));
    expect(db.prepare(`SELECT * FROM patrol_runs WHERE mower_sn = 'LFIN_MIGRATE'`).get()).toEqual({
      mower_sn: 'LFIN_MIGRATE', run: '1700000000000', token: 'a'.repeat(32), started_at: 1700000000000,
      schedule_id: 'sched-1', ended_phase: 'done', dock_failed_at: null, plan: null, ended_error: null,
    });
  });

  it('running the migration again changes nothing', () => {
    const before = columns().map(c => c.name);
    expect(() => initDb()).not.toThrow();
    expect(columns().map(c => c.name)).toEqual(before);
  });
});
